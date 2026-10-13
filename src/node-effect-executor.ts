import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { existsSync, lstatSync, mkdirSync, openSync, realpathSync, readSync, fstatSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { NodeEffectSpec, NodeEffectReceipt } from "./node-effects.js";

const MAX_READ = 300_000;
const MAX_OUTPUT = 64 * 1024;
const TIMEOUT = 120_000;
const jobs = new Map<string, Map<number, { abort: () => void }>>();

function inside(root: string, value: string): boolean {
  return value === root || value.startsWith(root + sep);
}

function target(workspace: string, requested: string, write: boolean): string {
  const root = realpathSync(workspace);
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!inside(root, candidate)) throw new Error("Workspace path escaped the assigned directory");
  if (existsSync(candidate)) {
    if (write && lstatSync(candidate).isSymbolicLink()) throw new Error("Workspace symlink targets are not writable");
    const real = realpathSync(candidate);
    if (!inside(root, real)) throw new Error("Workspace path escaped the assigned directory");
    return real;
  }
  if (!write) throw new Error("Workspace file does not exist");
  let parent = dirname(candidate);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new Error("Workspace parent directory is unavailable");
    parent = next;
  }
  const realParent = realpathSync(parent);
  if (!inside(root, realParent)) throw new Error("Workspace path escaped the assigned directory");
  return candidate;
}

function boundedText(value: string, limit: number): string {
  if (Buffer.byteLength(JSON.stringify(value)) <= limit + 2) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(value.slice(0, middle))) <= limit + 2) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low--;
  return value.slice(0, low);
}

function capture(value: string, chunk: Buffer): { value: string; exceeded: boolean } {
  const combined = value + chunk.toString("utf8");
  const bounded = boundedText(combined, MAX_OUTPUT);
  return { value: bounded, exceeded: bounded.length < combined.length };
}

async function bash(workspace: string, command: string, runtimeId: string, timeoutMs: number): Promise<NodeEffectReceipt> {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: workspace, LANG: "C" };
  const child = spawn("/bin/sh", ["-c", command], { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  let stdout = "", stderr = "", timedOut = false, exceeded = false;
  let exitCode: number | null | undefined;
  let spawnError: Error | undefined;
  const killGroup = (signal: NodeJS.Signals): void => {
    if (pid === undefined) return;
    try { process.kill(-pid, signal); } catch {}
  };
  let aborted = false;
  const abort = () => { aborted = true; killGroup("SIGKILL"); };
  const output = new Promise<{ code: number | null; error?: Error }>((resolveOutput) => {
    child.stdout?.on("data", (chunk: Buffer) => { const next = capture(stdout, chunk); stdout = next.value; exceeded ||= next.exceeded; if (next.exceeded) killGroup("SIGKILL"); });
    child.stderr?.on("data", (chunk: Buffer) => { const next = capture(stderr, chunk); stderr = next.value; exceeded ||= next.exceeded; if (next.exceeded) killGroup("SIGKILL"); });
    child.once("error", (error) => { spawnError = error; killGroup("SIGKILL"); });
    child.once("exit", (code) => { exitCode = code; killGroup("SIGKILL"); });
    child.once("close", (code) => resolveOutput({ code: exitCode ?? code, ...(spawnError ? { error: spawnError } : {}) }));
  });
  if (pid === undefined) {
    const result = await output;
    const error = result.error ?? new Error("Shell process did not start");
    return { status: "failed", result: { command, stdout, stderr: `${stderr}${error.message}`, exitCode: null } };
  }
  const runtimeJobs = jobs.get(runtimeId) ?? new Map<number, { abort: () => void }>();
  runtimeJobs.set(pid, { abort });
  jobs.set(runtimeId, runtimeJobs);
  const timer = setTimeout(() => { timedOut = true; killGroup("SIGKILL"); }, timeoutMs);
  const result = await output;
  clearTimeout(timer);
  const deadline = Date.now() + 2000;
  let extinct = false;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { extinct = true; break; } }
    await new Promise((done) => setTimeout(done, 20));
  }
  if (extinct) {
    runtimeJobs.delete(pid);
    if (runtimeJobs.size === 0) jobs.delete(runtimeId);
  }
  if (!extinct) return { status: "uncertain", error: "Shell process group extinction was not confirmed" };
  const suffix = aborted ? "\nCommand aborted because the runtime lease or stop state changed." : timedOut ? `\nCommand timed out after ${timeoutMs / 1000} seconds.` : exceeded ? "\nCommand output exceeded 64 KiB per stream." : result.error ? `\n${result.error.message}` : "";
  if (aborted) return { status: "uncertain", error: "Shell effect was aborted during runtime shutdown" };
  if (timedOut || exceeded || result.code === null) return { status: "uncertain", error: `Shell effect ended without a normal exit status.${suffix}` };
  return { status: result.code === 0 && !timedOut && !exceeded ? "succeeded" : "failed", result: { command, stdout, stderr: `${stderr}${suffix}`, exitCode: timedOut || exceeded || result.code === null ? null : result.code } };
}

export function abortNodeEffect(runtimeId: string): void {
  for (const job of jobs.get(runtimeId)?.values() ?? []) job.abort();
}

export function nodeEffectExtinct(runtimeId: string): boolean {
  const runtimeJobs = jobs.get(runtimeId);
  if (!runtimeJobs) return true;
  for (const [pid] of runtimeJobs) {
    try { process.kill(-pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") runtimeJobs.delete(pid);
    }
  }
  if (runtimeJobs.size === 0) jobs.delete(runtimeId);
  return runtimeJobs.size === 0;
}

export async function executeNodeEffect(spec: NodeEffectSpec, workspace: string, options: { timeoutMs?: number } = {}): Promise<NodeEffectReceipt> {
  if (spec.method === "read_file") {
    const file = target(workspace, String(spec.args.path), false);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const data = Buffer.alloc(MAX_READ + 1);
    let size = 0;
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Path is not a file");
      while (size < data.length) {
        const count = readSync(fd, data, size, data.length - size, null);
        if (!count) break;
        size += count;
      }
    } finally { closeSync(fd); }
    const decoder = new StringDecoder("utf8");
    const text = decoder.write(data.subarray(0, Math.min(size, MAX_READ))) + (size <= MAX_READ ? decoder.end() : "");
    const content = boundedText(text, MAX_READ);
    return { status: "succeeded", result: { path: file, content, truncated: size > MAX_READ || content.length < text.length } };
  }
  if (spec.method === "write_file") {
    const file = target(workspace, String(spec.args.path), true);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Path is not a file");
      const data = Buffer.from(String(spec.args.content));
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(fd, data, offset, data.length - offset);
        if (!written) throw new Error("File write made no progress");
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return { status: "succeeded", result: { path: file, bytes: Buffer.byteLength(String(spec.args.content)) } };
  }
  return bash(workspace, String(spec.args.command), spec.binding.runtimeId, options.timeoutMs ?? TIMEOUT);
}
