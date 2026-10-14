import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, readSync, fstatSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { NodeEffectSpec, NodeEffectReceipt } from "./node-effects.js";
import { REMOTE_ARTIFACT_CHUNK_BYTES, REMOTE_ARTIFACT_MAX_BYTES, type RemoteArtifactManifest } from "./remote-artifacts.js";

const MAX_READ = 300_000;
const MAX_OUTPUT = 64 * 1024;
const TIMEOUT = 120_000;
const jobs = new Map<string, Map<number, { abort: () => void }>>();

export interface NodeArtifactSnapshot {
  manifest: RemoteArtifactManifest;
  path: string;
  fingerprint: string;
}

function fingerprint(stat: ReturnType<typeof fstatSync>): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(":");
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!written) throw new Error("Artifact snapshot write made no progress");
    offset += written;
  }
}

function stableSpec(spec: NodeEffectSpec): string {
  return JSON.stringify({
    binding: spec.binding, descriptorHash: spec.descriptorHash, taskId: spec.taskId, method: spec.method,
    args: Object.fromEntries(Object.entries(spec.args).sort(([a], [b]) => a.localeCompare(b))),
    taskAttempt: spec.taskAttempt
  });
}

export function snapshotNodeArtifact(
  spec: NodeEffectSpec,
  workspace: string,
  snapshotDirectory: string,
  knownSecrets: readonly string[]
): NodeArtifactSnapshot {
  if (spec.method !== "PublishArtifact") throw new Error("Artifact snapshot requires PublishArtifact");
  const requested = String(spec.args.path);
  const root = realpathSync(workspace);
  const source = target(root, requested, false);
  const relativePath = relative(root, source).split(sep).join("/");
    if (relativePath !== requested || !relativePath || relativePath.startsWith("/") || relativePath.includes("\\") ||
      relativePath.split("/").some((part) => !part || part === "." || part === ".." || /\p{Cc}/u.test(part))) {
    throw new Error("Artifact path is not a safe normalized workspace-relative path");
  }
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: number | undefined;
  let tempPath = "";
  try {
    const before = fstatSync(input);
    const sourceFingerprint = fingerprint(before);
    if (!before.isFile() || before.size > REMOTE_ARTIFACT_MAX_BYTES) throw new Error("Artifact must be a regular file no larger than 64 MiB");
    const secrets = [...new Set(knownSecrets.filter(Boolean))].map((value) => Buffer.from(value, "utf8"))
      .filter((value) => value.length > 0 && value.length <= before.size);
    const maxSecret = secrets.reduce((max, value) => Math.max(max, value.length), 0);
    mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
    chmodSync(snapshotDirectory, 0o700);
    const key = createHash("sha256").update(stableSpec(spec)).digest("hex");
    tempPath = join(snapshotDirectory, `${key}.${process.pid}.tmp`);
    const finalPath = join(snapshotDirectory, `${key}.snapshot`);
    if (existsSync(finalPath)) throw new Error("An immutable snapshot already exists for this effect");
    output = openSync(tempPath, "wx", 0o600);
    const hash = createHash("sha256");
    const inputBuffer = Buffer.alloc(REMOTE_ARTIFACT_CHUNK_BYTES);
    let tail = Buffer.alloc(0);
    let sourceBytesRead = 0;
    let size = 0;
    const writeSafe = (chunk: Buffer, final: boolean): void => {
      const combined = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      if (secrets.some((secret) => combined.includes(secret))) throw new Error("Artifact contains a known credential and cannot be published");
      const flush = final ? combined.length : Math.max(0, combined.length - Math.max(0, maxSecret - 1));
      if (flush) {
        const safe = combined.subarray(0, flush);
        writeAll(output!, safe);
        hash.update(safe);
        size += safe.length;
      }
      tail = Buffer.from(combined.subarray(flush));
    };
    let count = 0;
    while ((count = readSync(input, inputBuffer, 0, inputBuffer.length, null)) > 0) {
      sourceBytesRead += count;
      if (sourceBytesRead > before.size || sourceBytesRead > REMOTE_ARTIFACT_MAX_BYTES) {
        throw new Error("Artifact source grew beyond its captured size while being snapshotted");
      }
      writeSafe(inputBuffer.subarray(0, count), false);
    }
    writeSafe(Buffer.alloc(0), true);
    const after = fstatSync(input);
    if (fingerprint(after) !== sourceFingerprint || size !== before.size) throw new Error("Artifact source changed while it was being snapshotted");
    chmodSync(tempPath, 0o400);
    fsyncSync(output);
    closeSync(output);
    output = undefined;
    renameSync(tempPath, finalPath);
    tempPath = "";
    const directoryFd = openSync(snapshotDirectory, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    const finalFd = openSync(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let finalFingerprint: string;
    try { finalFingerprint = fingerprint(fstatSync(finalFd)); } finally { closeSync(finalFd); }
    return {
      path: finalPath, fingerprint: finalFingerprint,
      manifest: {
        sourcePath: source, relativePath, size,
        sha256: hash.digest("hex")
      }
    };
  } catch (error) {
    if (output !== undefined) closeSync(output);
    if (tempPath) try { unlinkSync(tempPath); } catch {}
    throw error;
  } finally {
    closeSync(input);
  }
}

export function readNodeArtifactChunk(snapshot: NodeArtifactSnapshot, offset: number, length: number): Buffer {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
      length < 1 || length > REMOTE_ARTIFACT_CHUNK_BYTES || offset + length > snapshot.manifest.size) {
    throw new Error("Invalid artifact snapshot chunk range");
  }
  const fd = openSync(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== snapshot.manifest.size || fingerprint(stat) !== snapshot.fingerprint) throw new Error("Artifact snapshot changed before upload");
    const bytes = Buffer.alloc(length);
    const count = readSync(fd, bytes, 0, length, offset);
    if (count !== length) throw new Error("Artifact snapshot chunk is incomplete");
    return bytes;
  } finally { closeSync(fd); }
}

export function verifyNodeArtifactSnapshot(snapshot: NodeArtifactSnapshot): void {
  const expectedSize = snapshot.manifest.size;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > REMOTE_ARTIFACT_MAX_BYTES) {
    throw new Error("Artifact snapshot has an invalid expected size");
  }
  const fd = openSync(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(REMOTE_ARTIFACT_CHUNK_BYTES);
  let size = 0;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== expectedSize || fingerprint(stat) !== snapshot.fingerprint) {
      throw new Error("Artifact snapshot changed before completion");
    }
    let count = 0;
    while ((count = readSync(fd, buffer, 0, Math.min(buffer.length, expectedSize - size + 1), null)) > 0) {
      size += count;
      if (size > expectedSize) throw new Error("Artifact snapshot grew beyond its expected size");
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (after.size !== expectedSize || fingerprint(after) !== snapshot.fingerprint) {
      throw new Error("Artifact snapshot changed during completion verification");
    }
  } finally { closeSync(fd); }
  if (size !== expectedSize || hash.digest("hex") !== snapshot.manifest.sha256) {
    throw new Error("Artifact snapshot digest changed before completion");
  }
}

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

function nodeEffectPath(nodeDirectory: string): string {
  const ordered = [nodeDirectory, "/usr/local/bin", "/usr/bin", "/bin"];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of ordered) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    unique.push(entry);
  }
  return unique.join(":");
}

async function bash(workspace: string, command: string, runtimeId: string, timeoutMs: number, nodeDirectory: string): Promise<NodeEffectReceipt> {
  const env: NodeJS.ProcessEnv = { PATH: nodeEffectPath(nodeDirectory), HOME: workspace, LANG: "C" };
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

export async function executeNodeEffect(spec: NodeEffectSpec, workspace: string, options: { timeoutMs?: number; nodeDirectory?: string } = {}): Promise<NodeEffectReceipt> {
  if (spec.method === "PublishArtifact") throw new Error("PublishArtifact requires the durable node upload path");
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
  return bash(workspace, String(spec.args.command), spec.binding.runtimeId, options.timeoutMs ?? TIMEOUT, options.nodeDirectory || dirname(process.execPath));
}
