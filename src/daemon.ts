import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type DaemonInfo = { pid: number; port: number; nodePort?: number; daemonId: string; startedAt: string; log: string };
export type DaemonRecord = { state: "absent" } | { state: "malformed" } | { state: "present"; info: DaemonInfo };

const HEALTH_TIMEOUT_MS = 2000;
const DAEMON_LOG_NAMES = ["daemon.out.log", "daemon.err.log"] as const;

export function openLogFile(path: string): number {
  try {
    const existing = lstatSync(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`Daemon log path must be a regular file: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const descriptor = openSync(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`Daemon log path must be a regular file: ${path}`);
    fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function prepareDaemonLogFiles(home: string): void {
  const descriptors: number[] = [];
  try {
    for (const name of DAEMON_LOG_NAMES) descriptors.push(openLogFile(join(home, name)));
  } finally {
    for (const descriptor of descriptors.reverse()) closeSync(descriptor);
  }
}

export function readDaemonRecord(home: string): DaemonRecord {
  const path = join(home, "daemon.json");
  if (!existsSync(path)) return { state: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { state: "malformed" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "malformed" };
  const row = value as Record<string, unknown>;
  const pid = row.pid;
  const port = row.port;
  const nodePort = row.nodePort;
  const daemonId = row.daemonId;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return { state: "malformed" };
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port <= 0 || port > 65535) return { state: "malformed" };
  if (nodePort !== undefined && (typeof nodePort !== "number" || !Number.isSafeInteger(nodePort) || nodePort <= 0 || nodePort > 65535)) return { state: "malformed" };
  if (typeof daemonId !== "string" || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(daemonId)) return { state: "malformed" };
  return {
    state: "present",
    info: {
      pid,
      port,
      ...(nodePort === undefined ? {} : { nodePort }),
      daemonId,
      startedAt: typeof row.startedAt === "string" ? row.startedAt : "",
      log: join(home, "daemon.log")
    }
  };
}

export async function probe(info: DaemonInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!response.ok) return false;
    const current = (await response.json()) as { pid?: number; daemonId?: string };
    return current.pid === info.pid && current.daemonId === info.daemonId;
  } catch {
    return false;
  }
}
