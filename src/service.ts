import { execFile } from "node:child_process";
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { tryAcquireDaemonOwnership } from "./control.js";
import { prepareDaemonLogFiles, probe, readDaemonRecord, type DaemonInfo, type DaemonRecord } from "./daemon.js";

const LAUNCHCTL = "/bin/launchctl";
const PLUTIL = "/usr/bin/plutil";
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 100;
const DEFAULT_PORT = 4310;

export type LaunchAgentEnvironment = { PATH: string; HOME: string; LANG: string };
export type LaunchAgentPlistOptions = {
  label: string;
  executable: string;
  cliPath: string;
  home: string;
  port: number;
  environment: LaunchAgentEnvironment;
};

export type ServiceStatus = {
  home: string;
  label: string;
  loaded: boolean;
  record: DaemonRecord;
  healthy: boolean;
  // A confirmed health identity or a held ownership lock, including an offline backup.
  live: boolean;
};

export type ServiceStartResult = {
  home: string;
  label: string;
  pid: number;
  alreadyRunning: boolean;
};

type ExecResult = { code: number; stdout: string; stderr: string };

function xmlEscape(value: string): string {
  return value.replace(/[<>&"']/g, (character) => {
    switch (character) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "\"": return "&quot;";
      default: return "&apos;";
    }
  });
}

function xmlString(value: string): string {
  return `<string>${xmlEscape(value)}</string>`;
}

export function generateLaunchAgentPlist(options: LaunchAgentPlistOptions): string {
  const strings = [
    options.executable,
    options.cliPath,
    "serve",
    "--home",
    options.home,
    "--port",
    String(options.port)
  ].map(xmlString).join("\n      ");
  const environment = (["PATH", "HOME", "LANG"] as const)
    .map((key) => `      <key>${key}</key>\n      ${xmlString(options.environment[key])}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${xmlString(options.label)}
  <key>ProgramArguments</key>
  <array>
      ${strings}
  </array>
  <key>WorkingDirectory</key>
  ${xmlString(options.home)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  ${xmlString(join(options.home, "daemon.out.log"))}
  <key>StandardErrorPath</key>
  ${xmlString(join(options.home, "daemon.err.log"))}
  <key>Umask</key>
  <integer>63</integer>
  <key>ExitTimeOut</key>
  <integer>30</integer>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
</dict>
</plist>
`;
}

function assertDarwin(): void {
  if (process.platform !== "darwin") throw new Error("macOS per-user service commands are only supported on macOS (darwin)");
}

function realHome(home: string): string {
  const canonical = realpathSync(resolve(home));
  if (!lstatSync(canonical).isDirectory()) throw new Error(`Mission Control home must be a directory: ${canonical}`);
  return canonical;
}

export function serviceLabel(home: string): string {
  return `ai.mission-control.${createHash("sha256").update(realHome(home)).digest("hex").slice(0, 12)}`;
}

function launchAgentsDirectory(create: boolean): string {
  const directory = resolve(process.env.MISSION_CONTROL_LAUNCH_AGENTS_DIR ?? join(homedir(), "Library", "LaunchAgents"));
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`LaunchAgents location must be a real directory: ${directory}`);
    return realpathSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return directory;
    throw error;
  }
}

function plistPath(directory: string, label: string): string {
  return join(directory, `${label}.plist`);
}

function launchDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine the current user id for the macOS LaunchAgent domain");
  return `gui/${uid}`;
}

function runFile(file: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolveResult) => {
    execFile(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolveResult({ code, stdout, stderr });
    });
  });
}

function commandError(file: string, args: string[], result: ExecResult): Error {
  const detail = (result.stderr || result.stdout).trim();
  return new Error(`${basename(file)} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
}

async function requireSuccess(file: string, args: string[]): Promise<ExecResult> {
  const result = await runFile(file, args);
  if (result.code !== 0) throw commandError(file, args, result);
  return result;
}

async function loaded(label: string): Promise<boolean> {
  return (await runFile(LAUNCHCTL, ["print", `${launchDomain()}/${label}`])).code === 0;
}

async function kickstart(label: string): Promise<void> {
  await requireSuccess(LAUNCHCTL, ["kickstart", `${launchDomain()}/${label}`]);
}

async function bootout(label: string): Promise<void> {
  const result = await runFile(LAUNCHCTL, ["bootout", `${launchDomain()}/${label}`]);
  if (result.code !== 0 && await loaded(label)) throw commandError(LAUNCHCTL, ["bootout", `${launchDomain()}/${label}`], result);
}

async function bootoutFailedInstall(label: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await bootout(label); } catch (error) { lastError = error; }
    if (!await loaded(label)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
  throw new Error(`LaunchAgent ${label} remained loaded after failed installation${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

function acquireServiceLease(home: string): () => void {
  const path = join(home, "service.ownership.sqlite");
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`Service ownership path must be a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  const ownership = new DatabaseSync(path, { timeout: 0 });
  try {
    ownership.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch (error) {
    ownership.close();
    throw new Error(`Another service lifecycle operation is already in progress for ${home}`, { cause: error });
  }
  return () => {
    try {
      ownership.exec("ROLLBACK");
    } finally {
      ownership.close();
    }
  };
}

async function withServiceLease<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const release = acquireServiceLease(home);
  try {
    return await operation();
  } finally {
    release();
  }
}

function environmentForLaunchAgent(): LaunchAgentEnvironment {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME ?? homedir(),
    LANG: process.env.LANG ?? "en_US.UTF-8"
  };
}

function desiredPlist(home: string, label: string, port: number): string {
  const cliPath = realpathSync(fileURLToPath(new URL("./cli.js", import.meta.url)));
  return generateLaunchAgentPlist({
    label,
    executable: process.execPath,
    cliPath,
    home,
    port,
    environment: environmentForLaunchAgent()
  });
}

function writeTemporaryPlist(path: string, contents: string): void {
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    created = true;
    writeFileSync(descriptor, contents);
    chmodSync(path, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (created) {
      try { unlinkSync(path); } catch {}
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readExistingPlist(path: string): string | undefined {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Existing LaunchAgent plist is not a regular file: ${path}`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function waitForHealthy(home: string, timeoutMs = START_TIMEOUT_MS): Promise<DaemonInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readDaemonRecord(home);
    if (record.state === "present" && await probe(record.info)) return record.info;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
  throw new Error(`Mission Control did not become healthy within ${timeoutMs} ms in ${home}`);
}

function daemonOwnershipHeld(home: string): boolean {
  const ownership = tryAcquireDaemonOwnership(home);
  if (!ownership) return true;
  ownership.close();
  return false;
}

async function daemonIsLive(home: string): Promise<boolean> {
  const record = readDaemonRecord(home);
  return (record.state === "present" && await probe(record.info)) || daemonOwnershipHeld(home);
}

async function waitForExit(home: string, timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await daemonIsLive(home)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
  throw new Error(`Mission Control in ${home} did not release ownership within ${timeoutMs} ms after LaunchAgent bootout`);
}

async function refuseLiveUnmanagedDaemon(home: string, label: string, existingPlist: boolean): Promise<void> {
  const record = readDaemonRecord(home);
  if (record.state === "malformed") throw new Error(`The daemon record in ${home} is malformed; reconcile it before installing the login service`);
  if (record.state === "present" && await probe(record.info)) {
    if (existingPlist && await loaded(label)) return;
    throw new Error(`A live daemon already exists in ${home} and is not managed by this LaunchAgent; stop it first`);
  }
  if (daemonOwnershipHeld(home)) {
    throw new Error(`The daemon ownership lock in ${home} is held but its identity is unconfirmed; wait for any backup to finish or reconcile the daemon before starting or installing the login service`);
  }
}

async function cleanupBootstrappedJob(home: string, label: string, removePlist: boolean, plistPathValue: string): Promise<void> {
  let cleanupError: unknown;
  try {
    await bootoutFailedInstall(label);
  } catch (error) {
    cleanupError = error;
  }
  if (!cleanupError) {
    try {
      await waitForExit(home);
    } catch (error) {
      cleanupError = error;
    }
  }
  const stillLoaded = await loaded(label);
  const stillRecordedLive = await daemonIsLive(home);
  if (stillLoaded || stillRecordedLive) {
    cleanupError ??= new Error(`LaunchAgent cleanup remains uncertain for ${label}`);
  }
  if (cleanupError) throw cleanupError;
  if (removePlist) unlinkSync(plistPathValue);
}

async function installServiceLocked(home: string, port: number): Promise<{ home: string; label: string; plistPath: string; alreadyInstalled: boolean }> {
  const label = serviceLabel(home);
  const agentsDirectory = launchAgentsDirectory(true);
  const path = plistPath(agentsDirectory, label);
  const expected = desiredPlist(home, label, port);
  const existing = readExistingPlist(path);
  if (existing !== undefined && existing !== expected) {
    throw new Error(`LaunchAgent plist already exists with different content: ${path}; run service uninstall before changing its configuration`);
  }
  const alreadyInstalled = existing !== undefined;
  const loadedBefore = await loaded(label);
  if (loadedBefore && !alreadyInstalled) {
    throw new Error(`LaunchAgent label ${label} is already loaded without a matching plist in ${agentsDirectory}; refusing to alter it`);
  }
  await refuseLiveUnmanagedDaemon(home, label, alreadyInstalled);

  let wrotePlist = false;
  let bootstrappedByInvocation = false;
  try {
    const record = readDaemonRecord(home);
    const healthy = record.state === "present" && await probe(record.info);
    const needsStart = !loadedBefore || !healthy;
    if (needsStart) prepareDaemonLogFiles(home);
    if (!alreadyInstalled) {
      const temporary = join(agentsDirectory, `.${label}.${randomUUID()}.tmp`);
      let createdTemporary = false;
      try {
        writeTemporaryPlist(temporary, expected);
        createdTemporary = true;
        await requireSuccess(PLUTIL, ["-lint", temporary]);
        linkSync(temporary, path);
        wrotePlist = true;
      } finally {
        if (createdTemporary) {
          try { unlinkSync(temporary); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
    }

    if (!loadedBefore) {
      await requireSuccess(LAUNCHCTL, ["bootstrap", launchDomain(), path]);
      bootstrappedByInvocation = true;
    } else if (!healthy) {
      await kickstart(label);
    }
    await waitForHealthy(home);
    return { home, label, plistPath: path, alreadyInstalled };
  } catch (error) {
    if (bootstrappedByInvocation) {
      try {
        await cleanupBootstrappedJob(home, label, wrotePlist, path);
      } catch (cleanupError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; LaunchAgent cleanup failed: ${String(cleanupError)}`);
      }
    } else if (wrotePlist && !(await loaded(label))) {
      unlinkSync(path);
    } else if (wrotePlist) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; bootstrap state is uncertain, retaining ${path}`);
    }
    throw error;
  }
}

export async function installService(homeInput: string, port = DEFAULT_PORT): Promise<{ home: string; label: string; plistPath: string; alreadyInstalled: boolean }> {
  assertDarwin();
  const home = realHome(homeInput);
  return withServiceLease(home, () => installServiceLocked(home, port));
}

export async function serviceStart(homeInput: string): Promise<ServiceStartResult> {
  assertDarwin();
  const home = realHome(homeInput);
  return withServiceLease(home, async () => {
    const label = serviceLabel(home);
    const agentsDirectory = launchAgentsDirectory(false);
    const path = plistPath(agentsDirectory, label);
    const existing = readExistingPlist(path);
    if (existing === undefined) throw new Error(`LaunchAgent plist does not exist for ${home}; install the login service first`);
    await readPlistIdentity(path, label, home);
    const loadedBefore = await loaded(label);
    await refuseLiveUnmanagedDaemon(home, label, true);
    const record = readDaemonRecord(home);
    const healthy = record.state === "present" && await probe(record.info);
    if (loadedBefore && healthy && record.state === "present") {
      return { home, label, pid: record.info.pid, alreadyRunning: true };
    }
    prepareDaemonLogFiles(home);
    let bootstrappedByInvocation = false;
    try {
      if (!loadedBefore) {
        await requireSuccess(LAUNCHCTL, ["bootstrap", launchDomain(), path]);
        bootstrappedByInvocation = true;
      } else {
        await kickstart(label);
      }
      const info = await waitForHealthy(home);
      return { home, label, pid: info.pid, alreadyRunning: false };
    } catch (error) {
      if (bootstrappedByInvocation) {
        try {
          await cleanupBootstrappedJob(home, label, false, path);
        } catch (cleanupError) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}; LaunchAgent cleanup failed: ${String(cleanupError)}`);
        }
      }
      throw error;
    }
  });
}

export async function serviceStatus(homeInput: string): Promise<ServiceStatus> {
  assertDarwin();
  const home = realHome(homeInput);
  const label = serviceLabel(home);
  const isLoaded = await loaded(label);
  const record = readDaemonRecord(home);
  const healthy = record.state === "present" && await probe(record.info);
  const live = healthy || daemonOwnershipHeld(home);
  return { home, label, loaded: isLoaded, record, healthy, live };
}

async function readPlistIdentity(path: string, label: string, home: string): Promise<void> {
  const result = await requireSuccess(PLUTIL, ["-convert", "json", "-o", "-", path]);
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch {
    throw new Error(`Cannot verify LaunchAgent plist identity: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Cannot verify LaunchAgent plist identity: ${path}`);
  const plist = value as Record<string, unknown>;
  const args = plist.ProgramArguments;
  const homeIndex = Array.isArray(args) ? args.indexOf("--home") : -1;
  if (
    plist.Label !== label ||
    plist.WorkingDirectory !== home ||
    !Array.isArray(args) ||
    !args.includes("serve") ||
    homeIndex < 0 ||
    args[homeIndex + 1] !== home
  ) {
    throw new Error(`LaunchAgent plist label or home does not match ${home}; refusing to uninstall it`);
  }
}

async function uninstallServiceLocked(home: string): Promise<{ home: string; label: string; plistPath: string; removed: boolean }> {
  const label = serviceLabel(home);
  const agentsDirectory = launchAgentsDirectory(false);
  const path = plistPath(agentsDirectory, label);
  const existing = readExistingPlist(path);
  if (existing === undefined) return { home, label, plistPath: path, removed: false };
  await readPlistIdentity(path, label, home);

  await bootout(label);
  await waitForExit(home);
  unlinkSync(path);
  return { home, label, plistPath: path, removed: true };
}

export async function uninstallService(homeInput: string): Promise<{ home: string; label: string; plistPath: string; removed: boolean }> {
  assertDarwin();
  const home = realHome(homeInput);
  return withServiceLease(home, () => uninstallServiceLocked(home));
}
