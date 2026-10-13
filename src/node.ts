import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { NodeCommand, NodeCapabilities } from "./machines.js";
import { NODE_PROTOCOL_VERSION } from "./machines.js";
import { DurableWorkerMailbox, parseWorkerReceipt, type WorkerBinding } from "./worker-mailbox.js";

const require = createRequire(import.meta.url);
const durableVersion = String((require("@earendil-works/pi-durable/package.json") as { version: string }).version);
const productVersion = String((require("../package.json") as { version: string }).version);
const BODY_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 7000;
const POLL_INTERVAL_MS = 3000;
const TOKEN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NodeOptions {
  coordinator: string;
  machineId: string;
  tokenEnv: string;
  home: string;
  roots: string[];
  credentialRefs: string[];
}

type JournalOperation = {
  commandId: string;
  requestedPath: string;
  status: "admitted" | "completed" | "uncertain" | "sent";
  sessionId: string | null;
  sessionEpoch: number | null;
  outcome?: { ok: true; result: unknown } | { ok: false; error: string };
};

type NodeSession = { sessionId: string; sessionEpoch: number; leaseMs: number };
type NodeProbeCommand = NodeCommand & { sessionEpoch: number; requestId: string };

function genericError(): Error {
  return new Error("Node connection failed; inspect the local node journal and coordinator status");
}

class CoordinatorConflict extends Error {
  constructor() {
    super(genericError().message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !value.includes("\0");
}

function parseNodeSession(value: unknown, machineId: string): NodeSession {
  if (!object(value) || !exactKeys(value, ["machine", "sessionId", "sessionEpoch", "leaseMs"])) throw genericError();
  const input = value;
  const machineValue = input.machine;
  if (!object(machineValue)) throw genericError();
  const machine = machineValue;
  const sessionEpoch = input.sessionEpoch;
  if (!machine || machine.id !== machineId || machine.kind !== "remote" || machine.status !== "online" ||
      machine.sessionId !== input.sessionId || machine.sessionEpoch !== sessionEpoch ||
      typeof input.sessionId !== "string" || !UUID.test(input.sessionId) ||
      typeof sessionEpoch !== "number" || !Number.isSafeInteger(sessionEpoch) || sessionEpoch < 1 ||
      input.leaseMs !== 20_000) {
    throw genericError();
  }
  return { sessionId: input.sessionId, sessionEpoch, leaseMs: input.leaseMs };
}

function parseNodeCommand(value: unknown, machineId: string, session: NodeSession): NodeProbeCommand {
  const commandKeys = ["id", "machineId", "requestId", "kind", "payload", "status", "sessionEpoch", "createdAt", "updatedAt"];
  if (!object(value) || !exactKeys(value, commandKeys)) throw genericError();
  const input = value;
  if (!object(input.payload)) throw genericError();
  const payload = input.payload;
  const createdAt = input.createdAt;
  const updatedAt = input.updatedAt;
  if (!exactKeys(payload, ["path"]) || !validAbsolutePath(payload.path) ||
      typeof input.id !== "string" || !UUID.test(input.id) ||
      typeof input.requestId !== "string" || !UUID.test(input.requestId) ||
      input.machineId !== machineId || input.kind !== "inspect_workspace" ||
      input.status !== "dispatched" || input.sessionEpoch !== session.sessionEpoch ||
      typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) ||
      typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt)) {
    throw genericError();
  }
  return {
    id: input.id,
    machineId,
    requestId: input.requestId,
    kind: "inspect_workspace",
    payload: { path: payload.path },
    status: "dispatched",
    sessionEpoch: session.sessionEpoch,
    createdAt,
    updatedAt
  };
}

function parseNodePoll(value: unknown, machineId: string, session: NodeSession): { commands: NodeProbeCommand[] } {
  if (!object(value) || !exactKeys(value, ["machine", "commands", "leaseMs"]) || value.leaseMs !== session.leaseMs) {
    throw genericError();
  }
  const input = value;
  const machineValue = input.machine;
  const commands = input.commands;
  if (!object(machineValue)) throw genericError();
  const machine = machineValue;
  if (machine.id !== machineId || machine.kind !== "remote" || machine.status !== "online" ||
      machine.sessionId !== session.sessionId || machine.sessionEpoch !== session.sessionEpoch ||
      !Array.isArray(commands) || commands.length > 50) {
    throw genericError();
  }
  return { commands: commands.map((command) => parseNodeCommand(command, machineId, session)) };
}

function safeCoordinatorUrl(raw: string): URL {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 2048) throw new Error("coordinator URL is invalid");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("coordinator URL is invalid"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("coordinator URL must be HTTP(S) without credentials, query, or fragment");
  }
  if (url.protocol === "http:") {
    const authority = raw.slice("http://".length).split(/[/?#]/, 1)[0] ?? "";
    if (!/^(127\.0\.0\.1|\[::1\])(?::(?:0|[1-9][0-9]{0,4}))?$/.test(authority)) {
      throw new Error("plaintext coordinator URL must use literal loopback 127.0.0.1 or [::1]");
    }
  }
  return url;
}

function safeEndpoint(base: URL, path: string): URL {
  const endpoint = new URL(path, base);
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function validateRoots(input: string[]): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) throw new Error("at least one workspace root is required");
  const roots = input.map((root) => {
    if (!root.startsWith("/") || root.length > 4096) throw new Error("workspace roots must be absolute paths");
    let canonical: string;
    try { canonical = realpathSync(root); } catch { throw new Error("workspace root does not exist"); }
    if (!statSync(canonical).isDirectory()) throw new Error("workspace roots must be directories");
    return canonical;
  });
  if (new Set(roots).size !== roots.length) throw new Error("workspace roots must be unique");
  return roots;
}

function validateCredentialRefs(refs: string[]): string[] {
  if (!Array.isArray(refs) || refs.length > 64 || refs.some((ref) => typeof ref !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ref))) {
    throw new Error("credential references must be explicit environment names");
  }
  if (new Set(refs).size !== refs.length) throw new Error("credential references must be unique");
  return refs;
}

function within(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (
    suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix) && !suffix.includes("\0")
  );
}

export function inspectWorkspace(requestedPath: string, roots: string[]): { requestedPath: string; path: string; isDirectory: true } {
  if (typeof requestedPath !== "string" || !requestedPath.startsWith("/") || requestedPath.length > 4096) {
    throw new Error("probe path must be an absolute path");
  }
  let canonical: string;
  try { canonical = realpathSync(requestedPath); } catch { throw new Error("probe path does not exist"); }
  try {
    if (!statSync(canonical).isDirectory()) throw new Error("probe path is not a directory");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("probe path")) throw error;
    throw new Error("probe path is unavailable");
  }
  if (!roots.some((root) => within(root, canonical))) throw new Error("probe path is outside a declared root");
  return { requestedPath, path: canonical, isDirectory: true };
}

class NodeJournal {
  readonly db: DatabaseSync;
  private readonly ownerId = randomUUID();

  constructor(readonly home: string, coordinatorId: string, machineId: string) {
    if (existsSync(home) && !statSync(home).isDirectory()) throw new Error("node home must be a directory");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const databasePath = resolve(home, "node.sqlite");
    this.db = new DatabaseSync(databasePath, { timeout: 5000 });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS node_owner (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL, pid INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS node_operations (
          command_id TEXT PRIMARY KEY, requested_path TEXT NOT NULL, status TEXT NOT NULL,
          outcome TEXT, updated_at INTEGER NOT NULL
        );
      `);
      const existing = this.db.prepare("SELECT owner_id,pid FROM node_owner WHERE singleton=1").get() as { owner_id: string; pid: number } | undefined;
      if (existing) {
        if (!Number.isSafeInteger(existing.pid) || existing.pid < 1 || existing.pid === process.pid) {
          throw new Error("another node owner is already running");
        }
        try {
          process.kill(existing.pid, 0);
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) {
            throw new Error("another node owner is already running");
          }
          this.db.prepare("DELETE FROM node_owner WHERE singleton=1 AND owner_id=? AND pid=?")
            .run(existing.owner_id, existing.pid);
        }
        if (this.db.prepare("SELECT 1 FROM node_owner WHERE singleton=1").get()) {
          throw new Error("another node owner is already running");
        }
      }
      this.db.prepare("INSERT INTO node_owner(singleton,owner_id,pid) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,pid=excluded.pid")
        .run(this.ownerId, process.pid);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS node_identity (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1),
          coordinator_id TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          registration_id TEXT
        );
      `);
      const operationColumns = this.db.prepare("PRAGMA table_info(node_operations)").all() as Array<{ name: string }>;
      if (!operationColumns.some((column) => column.name === "session_id")) this.db.exec("ALTER TABLE node_operations ADD COLUMN session_id TEXT");
      if (!operationColumns.some((column) => column.name === "session_epoch")) this.db.exec("ALTER TABLE node_operations ADD COLUMN session_epoch INTEGER");
      const identity = this.db.prepare("SELECT coordinator_id,machine_id FROM node_identity WHERE singleton=1").get() as {
        coordinator_id: string; machine_id: string;
      } | undefined;
      if (identity && (identity.coordinator_id !== coordinatorId || identity.machine_id !== machineId)) {
        throw new Error("node home is bound to a different coordinator or machine");
      }
      if (!identity) {
        this.db.prepare("INSERT INTO node_identity(singleton,coordinator_id,machine_id,registration_id) VALUES(1,?,?,NULL)")
          .run(coordinatorId, machineId);
      }
      this.db.prepare("UPDATE node_operations SET status='uncertain',updated_at=? WHERE status='admitted'").run(Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.db.close();
      throw error;
    }
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      chmodSync(home, 0o700);
      chmodSync(databasePath, 0o600);
    } catch (error) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        this.db.prepare("DELETE FROM node_owner WHERE singleton=1 AND owner_id=? AND pid=?").run(this.ownerId, process.pid);
        this.db.exec("COMMIT");
      } catch {
        try { this.db.exec("ROLLBACK"); } catch {}
      }
      this.db.close();
      throw error;
    }
  }

  registrationId(): string {
    const existing = this.db.prepare("SELECT registration_id FROM node_identity WHERE singleton=1").get() as { registration_id: string | null };
    if (existing.registration_id) return existing.registration_id;
    const registrationId = randomUUID();
    this.db.prepare("UPDATE node_identity SET registration_id=? WHERE singleton=1 AND registration_id IS NULL").run(registrationId);
    return registrationId;
  }

  rotateRegistrationId(previous: string): void {
    this.db.prepare("UPDATE node_identity SET registration_id=? WHERE singleton=1 AND registration_id=?")
      .run(randomUUID(), previous);
  }

  sessionStarted(session: NodeSession): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE node_operations SET status='uncertain',updated_at=?
        WHERE status='completed' AND outcome IS NOT NULL
          AND (session_id IS NULL OR session_id<>? OR session_epoch IS NULL OR session_epoch<>?)
      `).run(Date.now(), session.sessionId, session.sessionEpoch);
      this.db.prepare("UPDATE node_identity SET registration_id=NULL WHERE singleton=1").run();
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  operation(command: NodeProbeCommand, session: NodeSession): JournalOperation {
    const row = this.db.prepare("SELECT command_id,requested_path,status,outcome,session_id,session_epoch FROM node_operations WHERE command_id=?").get(command.id) as {
      command_id: string; requested_path: string; status: JournalOperation["status"]; outcome: string | null;
      session_id: string | null; session_epoch: number | null;
    } | undefined;
    if (row) {
      if (row.requested_path !== command.payload.path) throw new Error("node command payload changed");
      return {
        commandId: row.command_id, requestedPath: row.requested_path, status: row.status,
        sessionId: row.session_id, sessionEpoch: row.session_epoch,
        ...(row.outcome ? { outcome: JSON.parse(row.outcome) } : {})
      };
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO node_operations(command_id,requested_path,status,updated_at,session_id,session_epoch) VALUES(?,?,?,?,?,?)")
        .run(command.id, command.payload.path, "admitted", Date.now(), session.sessionId, session.sessionEpoch);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return {
      commandId: command.id, requestedPath: command.payload.path, status: "admitted",
      sessionId: session.sessionId, sessionEpoch: session.sessionEpoch
    };
  }

  complete(commandId: string, session: NodeSession, outcome: JournalOperation["outcome"]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare(`
        UPDATE node_operations SET status='completed',outcome=?,updated_at=?
        WHERE command_id=? AND status='admitted' AND session_id=? AND session_epoch=?
      `).run(JSON.stringify(outcome), Date.now(), commandId, session.sessionId, session.sessionEpoch);
      if (changed.changes !== 1) throw new Error("node operation ownership changed");
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  pendingReceipts(session: NodeSession): Array<{ commandId: string; outcome: NonNullable<JournalOperation["outcome"]> }> {
    return (this.db.prepare(`
      SELECT command_id,outcome FROM node_operations
      WHERE status='completed' AND outcome IS NOT NULL AND session_id=? AND session_epoch=?
      ORDER BY updated_at,command_id
    `).all(session.sessionId, session.sessionEpoch) as Array<{ command_id: string; outcome: string }>).map((row) => ({
      commandId: row.command_id, outcome: JSON.parse(row.outcome) as NonNullable<JournalOperation["outcome"]>
    }));
  }

  sent(commandId: string, session: NodeSession): void {
    this.db.prepare(`
      UPDATE node_operations SET status='sent',updated_at=?
      WHERE command_id=? AND status='completed' AND session_id=? AND session_epoch=?
    `).run(Date.now(), commandId, session.sessionId, session.sessionEpoch);
  }

  markAdmittedUncertain(): void {
    this.db.prepare("UPDATE node_operations SET status='uncertain',updated_at=? WHERE status='admitted'").run(Date.now());
  }

  close(): void {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare("DELETE FROM node_owner WHERE singleton=1 AND owner_id=? AND pid=?").run(this.ownerId, process.pid);
      this.db.exec("COMMIT");
    } finally {
      this.db.close();
    }
  }
}

export async function fetchJson(base: URL, path: string, token: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bodyComplete = false;
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (controller.signal.aborted) throw genericError();
    const response = await fetch(safeEndpoint(base, path), {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body)
    });
    const length = Number(response.headers.get("content-length") ?? "0");
    if (!response.ok || (Number.isFinite(length) && length > BODY_LIMIT)) {
      controller.abort();
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 409) throw new CoordinatorConflict();
      throw genericError();
    }
    reader = response.body?.getReader();
    if (!reader) throw genericError();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > BODY_LIMIT) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw genericError();
      }
      chunks.push(next.value);
    }
    bodyComplete = true;
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")); } catch { throw genericError(); }
    return parsed;
  } catch (error) {
    if (error instanceof CoordinatorConflict) throw error;
    controller.abort();
    if (reader && !bodyComplete) await reader.cancel().catch(() => undefined);
    throw genericError();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    try { reader?.releaseLock(); } catch {}
  }
}

function capabilities(roots: string[], credentialRefs: string[]): NodeCapabilities {
  return {
    protocol: NODE_PROTOCOL_VERSION,
    version: productVersion,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    piDurable: durableVersion,
    roots,
    credentialRefs,
    executionEnabled: false
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveDelay) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timer = setTimeout(finish, ms);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

export async function exchangeWorkerMailbox(
  coordinator: string,
  token: string,
  mailbox: DurableWorkerMailbox,
  binding: WorkerBinding,
  signal?: AbortSignal
): Promise<void> {
  if (mailbox.side !== "node") throw new Error("Node mailbox required");
  const base = safeCoordinatorUrl(coordinator);
  const identity = { machineId: binding.machineId, sessionId: binding.sessionId, sessionEpoch: binding.sessionEpoch, binding };
  for (const envelope of mailbox.pending(binding, 1)) {
    const receipt = parseWorkerReceipt(await fetchJson(base, "/api/nodes/mailbox/upload", token, { ...identity, envelope }, signal));
    if (!receipt) throw genericError();
    mailbox.acknowledge(binding, receipt);
  }
  const response = await fetchJson(base, "/api/nodes/mailbox/poll", token, identity, signal);
  if (!response || typeof response !== "object" || Array.isArray(response) ||
      Object.keys(response).some((key) => key !== "envelopes") ||
      !("envelopes" in response) || !Array.isArray(response.envelopes) || response.envelopes.length > 1) {
    throw genericError();
  }
  for (const envelope of response.envelopes) {
    const receipt = mailbox.receive(binding, envelope);
    const result = await fetchJson(base, "/api/nodes/mailbox/ack", token, { ...identity, receipt }, signal);
    if (!result || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).length !== 1 || !("acknowledged" in result) || result.acknowledged !== true) {
      throw genericError();
    }
  }
}

export async function runNode(options: NodeOptions): Promise<void> {
  if (!TOKEN_NAME.test(options.tokenEnv)) throw new Error("token-env must be an environment variable name");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.machineId) || options.machineId === "local") {
    throw new Error("machine-id is invalid");
  }
  const token = process.env[options.tokenEnv];
  if (!token) throw new Error("token environment variable is missing");
  const coordinator = safeCoordinatorUrl(options.coordinator);
  const roots = validateRoots(options.roots);
  const credentialRefs = validateCredentialRefs(options.credentialRefs);
  const journal = new NodeJournal(resolve(options.home), coordinator.origin, options.machineId);
  const abort = new AbortController();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    abort.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const registrationId = journal.registrationId();
  const sessionBody = {
    machineId: options.machineId,
    capabilities: capabilities(roots, credentialRefs),
    registrationId
  };
  try {
    let session: NodeSession;
    try {
      session = parseNodeSession(await fetchJson(coordinator, "/api/nodes/session", token, sessionBody, abort.signal), options.machineId);
    } catch (error) {
      if (error instanceof CoordinatorConflict) journal.rotateRegistrationId(registrationId);
      throw error;
    }
    journal.sessionStarted(session);
    while (!stopping) {
      for (const receipt of journal.pendingReceipts(session)) {
        try {
          await fetchJson(coordinator, "/api/nodes/events", token, {
            machineId: options.machineId, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch,
            commandId: receipt.commandId, outcome: receipt.outcome
          }, abort.signal);
          journal.sent(receipt.commandId, session);
        } catch {
          if (stopping) break;
          throw genericError();
        }
      }
      if (stopping) break;
      const polled = parseNodePoll(await fetchJson(coordinator, "/api/nodes/poll", token, {
        machineId: options.machineId, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch
      }, abort.signal), options.machineId, session);
      for (const command of polled.commands) {
        const operation = journal.operation(command, session);
        if (operation.status !== "admitted") continue;
        let outcome: NonNullable<JournalOperation["outcome"]>;
        try {
          outcome = { ok: true, result: inspectWorkspace(command.payload.path, roots) };
        } catch (error) {
          outcome = { ok: false, error: error instanceof Error ? error.message : "workspace probe failed" };
        }
        journal.complete(command.id, session, outcome);
      }
      await delay(POLL_INTERVAL_MS, abort.signal);
    }
  } catch {
    if (!stopping) throw genericError();
  } finally {
    journal.markAdmittedUncertain();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    journal.close();
  }
}
