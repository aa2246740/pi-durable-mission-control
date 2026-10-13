#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backupHome, restoreHome } from "./backup.js";
import { processExists } from "./control.js";
import { openLogFile, probe, readDaemonRecord, type DaemonInfo } from "./daemon.js";
import { startServer } from "./server.js";
import { installService, serviceStart, serviceStatus, uninstallService } from "./service.js";
import { runNode } from "./node.js";

const VERSION = "0.1.0";
const DEFAULT_PORT = 4310;
const DEFAULT_LOG_LINES = 50;
const MAX_LOG_LINES = 10000;
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 30000;
const CHILD_CLEANUP_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;
const LOG_TAIL_BYTE_LIMIT = 256 * 1024;
const STARTUP_ERROR_TYPE = "mission-control-startup-error";
const STARTUP_ERROR_FALLBACK_MS = 5000;

const HELP = `Usage: mission-control <command> [options]

Commands:
  serve                 Run the daemon in the foreground (default)
  start                 Start a detached daemon and wait until it reports healthy
  status                Report the recorded daemon identity and its health
  stop                  Ask the recorded daemon to exit and confirm that it stopped
  logs                  Show the end of the daemon log files
  doctor                Print read-only local diagnostics
  service               Manage the macOS per-user login service
  export <mission-id>   Write a mission export to stdout
  backup                Create a verified offline home backup
  restore               Restore a verified backup into a new home
  node                  Connect a node to a coordinator (readonly by default)

Options:
  --home <path>   Daemon home directory (default ~/.mission-control)
  --node-port <port>  Optional separate node-only listener for serve/start (0 selects a free port)
  --out <path>    New backup directory for backup
  --from <path>   Backup directory for restore
  node --coordinator <url> --machine-id <id> --token-env <NAME> --home <path> --root <abs> [--root <abs>] [--credential-ref <NAME>] [--execution-mode metadata-only|workspace-effects]
  --execution-mode metadata-only enables metadata RPC only; workspace-effects additionally enables node-local read_file, write_file, and bash
  Approval-mode remote effects remain explicitly unavailable in phase 1 and are pending phase 2.
  service install --home <path> [--port <port>]
  service start --home <path>
  service status --home <path>
  service uninstall --home <path>
  --port <port>   Listening port for serve and start; 0 selects a free port
  --lines <n>     Log lines for logs (default ${DEFAULT_LOG_LINES}, maximum ${MAX_LOG_LINES})
  --help, -h      Show this help and exit
  --version, -v   Show the version and exit
`;

type Invocation =
  | { command: "help" | "version" }
  | { command: "serve" | "start"; home: string; port: number; nodePort?: number }
  | { command: "status" | "stop" | "doctor"; home: string }
  | { command: "logs"; home: string; lines: number }
  | { command: "export"; home: string; missionId: string }
  | { command: "backup"; home: string; out: string }
  | { command: "restore"; home: string; from: string }
  | { command: "service-install"; home: string; port: number }
  | { command: "service-start" | "service-status" | "service-uninstall"; home: string }
  | { command: "node"; coordinator: string; machineId: string; tokenEnv: string; home: string; roots: string[]; credentialRefs: string[]; executionMode?: "metadata-only" | "workspace-effects" };

const VALUE_FLAGS = ["--home", "--port", "--node-port", "--lines", "--out", "--from", "--coordinator", "--machine-id", "--token-env", "--root", "--credential-ref", "--execution-mode"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
type CommandName = "serve" | "start" | "status" | "stop" | "logs" | "doctor" | "export" | "backup" | "restore" | "service" | "node";
const REPEATED_FLAGS: ValueFlag[] = ["--root", "--credential-ref"];

const SPEC: Record<CommandName, { flags: ValueFlag[]; positionals: number; usage: string }> = {
  serve: { flags: ["--home", "--port", "--node-port"], positionals: 0, usage: "mission-control serve [--home <path>] [--port <port>] [--node-port <port>]" },
  start: { flags: ["--home", "--port", "--node-port"], positionals: 0, usage: "mission-control start [--home <path>] [--port <port>] [--node-port <port>]" },
  status: { flags: ["--home"], positionals: 0, usage: "mission-control status [--home <path>]" },
  stop: { flags: ["--home"], positionals: 0, usage: "mission-control stop [--home <path>]" },
  logs: { flags: ["--home", "--lines"], positionals: 0, usage: "mission-control logs [--home <path>] [--lines <n>]" },
  doctor: { flags: ["--home"], positionals: 0, usage: "mission-control doctor [--home <path>]" },
  export: { flags: ["--home"], positionals: 1, usage: "mission-control export <mission-id> [--home <path>]" },
  backup: { flags: ["--home", "--out"], positionals: 0, usage: "mission-control backup --home <path> --out <directory>" },
  restore: { flags: ["--from", "--home"], positionals: 0, usage: "mission-control restore --from <directory> --home <new-path>" },
  service: { flags: ["--home", "--port"], positionals: 1, usage: "mission-control service <install|start|status|uninstall> --home <path> [--port <port>]" },
  node: { flags: ["--coordinator", "--machine-id", "--token-env", "--home", "--root", "--credential-ref", "--execution-mode"], positionals: 0, usage: "mission-control node --coordinator <url> --machine-id <id> --token-env <NAME> --home <path> --root <abs> [--root <abs>] [--credential-ref <NAME>] [--execution-mode metadata-only|workspace-effects]" }
};

class UsageError extends Error {}

function isValueFlag(token: string): token is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(token);
}

function integerOption(value: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} must be a whole number from ${min} to ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new UsageError(`${flag} must be a whole number from ${min} to ${max}`);
  return parsed;
}

function parse(argv: string[]): Invocation {
  const first = argv[0];
  if (first === undefined) return { command: "serve", home: defaultHome(), port: DEFAULT_PORT };
  if (["help", "--help", "-h"].includes(first)) return { command: "help" };
  if (["version", "--version", "-v"].includes(first)) return { command: "version" };
  let command: CommandName;
  let args: string[];
  if (first.startsWith("-")) {
    command = "serve";
    args = argv;
  } else if (Object.hasOwn(SPEC, first)) {
    command = first as CommandName;
    args = argv.slice(1);
  } else {
    throw new UsageError("Unknown command");
  }
  if (args.some((arg) => ["--help", "-h"].includes(arg))) return { command: "help" };
  if (args.some((arg) => ["--version", "-v"].includes(arg))) return { command: "version" };
  const spec = SPEC[command];
  const values = new Map<ValueFlag, string>();
  const repeated = new Map<ValueFlag, string[]>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (!isValueFlag(token)) throw new UsageError("Unknown flag");
    if (!spec.flags.includes(token)) throw new UsageError(`${command} does not accept ${token}`);
    const value = args[index + 1];
    if (value === undefined || value === "" || value.startsWith("-")) throw new UsageError(`${token} requires a non-empty value`);
    if (REPEATED_FLAGS.includes(token)) {
      const entries = repeated.get(token) ?? [];
      entries.push(value);
      repeated.set(token, entries);
    } else {
      if (values.has(token)) throw new UsageError(`${token} was given more than once`);
      values.set(token, value);
    }
    index += 1;
  }
  if (positionals.length > spec.positionals) throw new UsageError("Unexpected positional argument");
  if (positionals.length < spec.positionals) throw new UsageError(`Usage: ${spec.usage}`);
  const homeValue = values.get("--home");
  if (command === "service") {
    const action = positionals[0];
    if (!["install", "start", "status", "uninstall"].includes(action!)) throw new UsageError("Unknown service action");
    if (homeValue === undefined) throw new UsageError(`service ${action} requires --home <path>`);
    if (action !== "install" && values.has("--port")) throw new UsageError(`service ${action} does not accept --port`);
    if (action === "install") {
      const portValue = values.get("--port");
      return { command: "service-install", home: resolve(homeValue), port: portValue === undefined ? DEFAULT_PORT : integerOption(portValue, "--port", 0, 65535) };
    }
    return {
      command: action === "start" ? "service-start" : action === "status" ? "service-status" : "service-uninstall",
      home: resolve(homeValue)
    };
  }
  if (command === "backup") {
    const outValue = values.get("--out");
    if (homeValue === undefined) throw new UsageError("backup requires --home <path>");
    if (outValue === undefined) throw new UsageError("backup requires --out <directory>");
    return { command, home: resolve(homeValue), out: resolve(outValue) };
  }
  if (command === "restore") {
    const fromValue = values.get("--from");
    if (homeValue === undefined) throw new UsageError("restore requires --home <new-path>");
    if (fromValue === undefined) throw new UsageError("restore requires --from <directory>");
    return { command, home: resolve(homeValue), from: resolve(fromValue) };
  }
  if (command === "node") {
    const coordinator = values.get("--coordinator");
    const machineId = values.get("--machine-id");
    const tokenEnv = values.get("--token-env");
    const executionMode = values.get("--execution-mode");
    const roots = repeated.get("--root") ?? [];
    if (!coordinator || !machineId || !tokenEnv || !homeValue || roots.length === 0) throw new UsageError(`Usage: ${spec.usage}`);
    if (executionMode !== undefined && executionMode !== "metadata-only" && executionMode !== "workspace-effects") throw new UsageError("--execution-mode must be metadata-only or workspace-effects");
    return {
      command,
      coordinator,
      machineId,
      tokenEnv,
      home: resolve(homeValue),
      roots,
      credentialRefs: repeated.get("--credential-ref") ?? [],
      ...(executionMode === undefined ? {} : { executionMode: executionMode as "metadata-only" | "workspace-effects" })
    };
  }
  const home = homeValue === undefined ? defaultHome() : resolve(homeValue);
  if (command === "serve" || command === "start") {
    const portValue = values.get("--port");
    const nodePortValue = values.get("--node-port");
    return {
      command, home, port: portValue === undefined ? DEFAULT_PORT : integerOption(portValue, "--port", 0, 65535),
      ...(nodePortValue === undefined ? {} : { nodePort: integerOption(nodePortValue, "--node-port", 0, 65535) })
    };
  }
  if (command === "logs") {
    const linesValue = values.get("--lines");
    return { command, home, lines: linesValue === undefined ? DEFAULT_LOG_LINES : integerOption(linesValue, "--lines", 1, MAX_LOG_LINES) };
  }
  if (command === "export") return { command, home, missionId: positionals[0]! };
  return { command, home };
}

function defaultHome(): string {
  return resolve(join(homedir(), ".mission-control"));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function assertBackupDaemonOffline(home: string): Promise<void> {
  const record = readDaemonRecord(home);
  if (record.state === "malformed") {
    throw new Error(`Cannot back up ${home}: daemon.json is malformed; reconcile the daemon record before backing up`);
  }
  if (record.state === "present" && await probe(record.info)) {
    throw new Error(`Cannot back up ${home} while the recorded Mission Control daemon is running; stop it first`);
  }
}

function redact(text: string): string {
  const sensitiveName = /(?:admin\.token|[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*|authorization)/i;
  const assignment = /((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z0-9_.-]+)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/g;
  let redacted = text
    .replace(/(bearer\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, "$1[redacted]")
    .replace(assignment, (whole: string, prefix: string, value: string) => sensitiveName.test(prefix) ? `${prefix}${value.startsWith("\"") ? "\"[redacted]\"" : value.startsWith("'") ? "'[redacted]'" : "[redacted]"}` : whole);
  const environmentSecrets = Object.entries(process.env)
    .filter(([name, value]) => sensitiveName.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
  for (const secret of environmentSecrets) redacted = redacted.split(secret).join("[redacted]");
  return redacted.replace(/[A-Fa-f0-9]{32,}/g, "[redacted]");
}

function logPaths(home: string): string[] {
  return [join(home, "daemon.log"), join(home, "daemon.out.log"), join(home, "daemon.err.log")];
}

function tail(path: string, lines: number): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return "";
    throw error;
  }
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, LOG_TAIL_BYTE_LIMIT);
    if (length === 0) return "";
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    const parts = buffer.toString("utf8").split("\n");
    if (length < size) parts.shift();
    while (parts.length && parts[parts.length - 1] === "") parts.pop();
    return redact(parts.slice(-lines).join("\n"));
  } finally {
    closeSync(descriptor);
  }
}

function serve(home: string, port: number, nodePort?: number): Promise<void> {
  const runFile = join(home, "daemon.json");
  return startServer({ home, port, ...(nodePort === undefined ? {} : { nodePort }) }).then((service) => {
    const info: DaemonInfo = {
      pid: process.pid,
      port: service.port,
      ...(service.nodePort === undefined ? {} : { nodePort: service.nodePort }),
      daemonId: service.control.daemonId,
      startedAt: new Date().toISOString(),
      log: join(home, "daemon.log")
    };
    writeFileSync(runFile, JSON.stringify(info), { mode: 0o600 });
    appendFileSync(info.log, `[${info.startedAt}] Mission Control listening on 127.0.0.1:${info.port} pid=${info.pid}\n`, { mode: 0o600 });
    process.stdout.write(`Mission Control listening on 127.0.0.1:${info.port} (pid ${info.pid})\n`);
    if (info.nodePort !== undefined) process.stdout.write(`Node-only listener on 127.0.0.1:${info.nodePort}; tunnel only this port, never the administrator port.\n`);
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      void service.close().then(() => {
        const current = readDaemonRecord(home);
        if (current.state === "present" && current.info.pid === process.pid && current.info.daemonId === info.daemonId) unlinkSync(runFile);
        appendFileSync(info.log, `[${new Date().toISOString()}] Mission Control stopped\n`);
        process.exit(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`;
}

function startFailure(reason: string, errPath: string, lines: number): Error {
  const recent = existsSync(errPath) ? tail(errPath, lines) : "";
  return new Error(recent ? `${reason}. Last daemon error output:\n${recent}` : `${reason}. See ${errPath}`);
}

function startupErrorFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const row = message as Record<string, unknown>;
  return row.type === STARTUP_ERROR_TYPE && typeof row.message === "string" && row.message ? row.message : undefined;
}

function disconnectChild(child: ChildProcess): void {
  if (child.connected) child.disconnect();
}

async function terminateOwnChild(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !processExists(pid);
  }
  const deadline = Date.now() + CHILD_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

async function start(home: string, port: number, nodePort?: number): Promise<void> {
  const existing = readDaemonRecord(home);
  if (existing.state === "present" && (await probe(existing.info))) {
    if (nodePort !== undefined && (existing.info.nodePort === undefined || (nodePort !== 0 && existing.info.nodePort !== nodePort))) {
      throw new Error("Daemon is already running with a different node listener configuration; stop it explicitly before changing --node-port");
    }
    process.stdout.write(`already running pid=${existing.info.pid} port=${existing.info.port} daemonId=${existing.info.daemonId} home=${home}\n`);
    return;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const outPath = join(home, "daemon.out.log");
  const errPath = join(home, "daemon.err.log");
  const out = openLogFile(outPath);
  const err = openLogFile(errPath);
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  let startupError: string | undefined;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--home", home, "--port", String(port),
    ...(nodePort === undefined ? [] : ["--node-port", String(nodePort)])], {
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", out, err, "ipc"]
  });
  closeSync(out);
  closeSync(err);
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  child.once("error", (error: unknown) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
  });
  child.on("message", (message: unknown) => {
    startupError = startupErrorFromMessage(message);
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Could not spawn the daemon: ${spawnError.message}`);
    if (startupError) {
      disconnectChild(child);
      const stopped = child.pid === undefined ? true : await terminateOwnChild(child.pid);
      const reason = `The daemon reported a startup error: ${startupError}`;
      throw startFailure(stopped ? reason : `${reason} and its process ${child.pid} is still running`, errPath, 20);
    }
    if (exited) throw startFailure(`The daemon exited before it became healthy (${describeExit(exited)})`, errPath, 20);
    const current = readDaemonRecord(home);
    if (current.state === "present" && current.info.pid === child.pid && (await probe(current.info))) {
      disconnectChild(child);
      process.stdout.write(`started pid=${current.info.pid} port=${current.info.port} daemonId=${current.info.daemonId} home=${home} log=${outPath}\n`);
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  disconnectChild(child);
  const stopped = child.pid === undefined ? true : await terminateOwnChild(child.pid);
  const reason = `The daemon did not report a healthy identity within ${START_TIMEOUT_MS} ms`;
  throw startFailure(stopped ? reason : `${reason} and its process ${child.pid} is still running`, errPath, 20);
}

async function status(home: string): Promise<void> {
  const record = readDaemonRecord(home);
  if (record.state === "absent") {
    process.stdout.write(`stopped (no daemon record in ${home})\n`);
    process.exitCode = 1;
    return;
  }
  if (record.state === "malformed") {
    process.stdout.write(`stopped (unreadable daemon record in ${home})\n`);
    process.exitCode = 1;
    return;
  }
  if (await probe(record.info)) {
    process.stdout.write(`running pid=${record.info.pid} port=${record.info.port} log=${record.info.log}\n`);
    return;
  }
  process.stdout.write(`stopped (stale pid=${record.info.pid}) log=${record.info.log}\n`);
  process.exitCode = 1;
}

async function stop(home: string): Promise<void> {
  const record = readDaemonRecord(home);
  if (record.state === "absent") throw new Error(`No daemon record in ${home}`);
  if (record.state === "malformed") throw new Error(`The daemon record in ${home} is unreadable; refusing to signal any process`);
  const info = record.info;
  if (!(await probe(info))) {
    throw new Error(`Daemon identity at port ${info.port} could not be confirmed; refusing to signal pid ${info.pid}`);
  }
  try {
    process.kill(info.pid, "SIGTERM");
    process.stdout.write(`sent SIGTERM to pid=${info.pid}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    process.stdout.write(`daemon pid=${info.pid} exited before SIGTERM\n`);
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = readDaemonRecord(home);
    const recordCleared = current.state === "absent" || (current.state === "present" && (current.info.pid !== info.pid || current.info.daemonId !== info.daemonId));
    if (!processExists(info.pid) && recordCleared) {
      process.stdout.write(`stopped pid=${info.pid}\n`);
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Daemon pid ${info.pid} did not finish its own shutdown within ${STOP_TIMEOUT_MS} ms; it was not forced. Check ${join(home, "daemon.log")}`);
}

function logs(home: string, lines: number): void {
  const available = logPaths(home).filter((path) => {
    try {
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  });
  if (!available.length) {
    process.stdout.write(`No daemon log files in ${home}\n`);
    process.exitCode = 1;
    return;
  }
  for (const path of available) {
    const content = tail(path, lines);
    process.stdout.write(`==> ${path} <==\n${content ? `${content}\n` : ""}`);
  }
}

async function doctor(home: string): Promise<void> {
  const record = readDaemonRecord(home);
  const lines = [
    `mission-control ${VERSION}`,
    `node ${process.version} (${process.platform} ${process.arch})`,
    `executable ${process.execPath}`,
    `cli ${fileURLToPath(import.meta.url)}`,
    `home ${home} (${existsSync(home) ? "present" : "missing"})`,
    `control database ${existsSync(join(home, "control.sqlite")) ? "present" : "missing"}`,
    `admin token ${existsSync(join(home, "admin.token")) ? "present" : "missing"}`,
    `agent store directory ${existsSync(join(home, "agents")) ? "present" : "missing"}`,
    `artifact directory ${existsSync(join(home, "artifacts")) ? "present" : "missing"}`
  ];
  if (record.state === "absent") lines.push("daemon record absent", "daemon stopped");
  else if (record.state === "malformed") lines.push("daemon record unreadable", "daemon stopped");
  else {
    lines.push(`daemon record pid=${record.info.pid} port=${record.info.port} daemonId=${record.info.daemonId}`);
    lines.push((await probe(record.info)) ? "daemon running (identity confirmed)" : "daemon stale (recorded identity did not answer)");
  }
  for (const path of logPaths(home)) lines.push(`log ${path} ${existsSync(path) ? "present" : "missing"}`);
  lines.push("diagnostics are read-only: no database is opened, no file is repaired, and no credential or environment value is shown");
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function exportMission(home: string, missionId: string): Promise<void> {
  const record = readDaemonRecord(home);
  if (record.state === "absent") throw new Error(`Daemon is not running from ${home}`);
  if (record.state === "malformed") throw new Error(`The daemon record in ${home} is unreadable`);
  const info = record.info;
  if (!(await probe(info))) throw new Error(`Daemon identity at port ${info.port} could not be confirmed`);
  const token = readFileSync(join(home, "admin.token"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${info.port}/api/missions/${encodeURIComponent(missionId)}/export`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`Export failed: HTTP ${response.status} ${await response.text()}`);
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
}

async function createBackup(home: string, output: string): Promise<void> {
  const summary = await backupHome(home, output, VERSION, assertBackupDaemonOffline);
  process.stdout.write(`Backup created at ${summary.path}\n`);
  process.stdout.write(`Included ${summary.files} verified files (control schema ${summary.controlSchemaVersion}).\n`);
  process.stdout.write("Warning: Git repositories and worktree directories are not included; back them up separately.\n");
  for (const warning of summary.durabilityWarnings) process.stderr.write(`Durability warning: ${warning}\n`);
}

function restoreBackup(from: string, home: string): void {
  const summary = restoreHome(from, home);
  process.stdout.write(`Backup restored to ${summary.path} (${summary.files} verified files; source app version ${summary.appVersion}).\n`);
  process.stdout.write("Warning: Git repositories and worktrees are NOT included. Nonterminal Missions are blocked for reconciliation; resolve blockers before resuming.\n");
  for (const warning of summary.durabilityWarnings) process.stderr.write(`Durability warning: ${warning}\n`);
}

async function main(): Promise<void> {
  const invocation = parse(process.argv.slice(2));
  switch (invocation.command) {
    case "help":
      process.stdout.write(HELP);
      return;
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "serve":
      return serve(invocation.home, invocation.port, invocation.nodePort);
    case "start":
      return start(invocation.home, invocation.port, invocation.nodePort);
    case "status":
      return status(invocation.home);
    case "stop":
      return stop(invocation.home);
    case "logs":
      return logs(invocation.home, invocation.lines);
    case "doctor":
      return doctor(invocation.home);
    case "export":
      return exportMission(invocation.home, invocation.missionId);
    case "backup":
      return createBackup(invocation.home, invocation.out);
    case "restore":
      return restoreBackup(invocation.from, invocation.home);
    case "node":
      return runNode(invocation);
    case "service-install": {
      const result = await installService(invocation.home, invocation.port);
      process.stdout.write(`LaunchAgent configuration loaded for the current GUI session: ${result.label}${result.alreadyInstalled ? " (already installed)" : ""}.\n`);
      process.stdout.write("Login/logout and system-restart behavior has not been verified.\n");
      return;
    }
    case "service-start": {
      const result = await serviceStart(invocation.home);
      process.stdout.write(result.alreadyRunning
        ? `LaunchAgent ${result.label} is already healthy at pid=${result.pid}.\n`
        : `LaunchAgent ${result.label} started daemon pid=${result.pid}.\n`);
      return;
    }
    case "service-status": {
      const result = await serviceStatus(invocation.home);
      process.stdout.write(`LaunchAgent ${result.label}: ${result.loaded ? "loaded" : "not loaded"} (per-user login configuration; login/logout behavior not verified).\n`);
      if (result.healthy && result.record.state === "present") {
        process.stdout.write(`Daemon: running pid=${result.record.info.pid} port=${result.record.info.port}.\n`);
      } else if (result.record.state === "malformed") {
        process.stdout.write("Daemon: stopped or unavailable (daemon.json is malformed).\n");
      } else if (result.live && result.record.state === "present") {
        process.stdout.write(`Daemon: unavailable/unconfirmed (recorded pid=${result.record.info.pid} is still alive; refusing to signal or replace it).\n`);
      } else {
        process.stdout.write(`Daemon: stopped (${result.record.state === "absent" ? "no daemon record" : `stale pid=${result.record.info.pid}`} in ${result.home}).\n`);
      }
      if (!result.loaded || !result.healthy) process.exitCode = 1;
      return;
    }
    case "service-uninstall": {
      const result = await uninstallService(invocation.home);
      process.stdout.write(result.removed ? `LaunchAgent ${result.label} unloaded and plist removed.\n` : `No LaunchAgent plist exists for ${result.home}.\n`);
      return;
    }
  }
}

function reportStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (error instanceof UsageError || typeof process.send !== "function" || !process.connected) {
    if (error instanceof UsageError) process.stderr.write(HELP);
    process.exitCode = 1;
    return;
  }
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (process.connected) process.disconnect();
    process.exitCode = 1;
  };
  const fallback = setTimeout(finish, STARTUP_ERROR_FALLBACK_MS);
  fallback.unref();
  try {
    process.send({ type: STARTUP_ERROR_TYPE, message }, undefined, undefined, (sendError) => {
      clearTimeout(fallback);
      if (sendError) process.stderr.write(`${sendError.message}\n`);
      finish();
    });
  } catch {
    clearTimeout(fallback);
    finish();
  }
}

void main().catch(reportStartupError);
