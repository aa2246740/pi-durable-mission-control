import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { NodeCommand, NodeCapabilities } from "./machines.js";
import { NODE_EXECUTION_PROTOCOL_VERSION, NODE_PROTOCOL_VERSION, NODE_WORKSPACE_EFFECTS_PROTOCOL_VERSION } from "./machines.js";
import { DurableWorkerMailbox, parseWorkerBinding, parseWorkerReceipt, type JsonValue, type WorkerBinding } from "./worker-mailbox.js";
import { NodeWorkerSupervisor } from "./node-workers.js";
import { parseWorkerStartSpec, workerStartSpecHash } from "./node-worker-spec.js";
import { REMOTE_ARTIFACT_CHUNK_BYTES, remoteArtifactTransferId, type RemoteArtifactManifest } from "./remote-artifacts.js";
import type { NodeEffectSpec } from "./node-effects.js";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const durableVersion = String((require("@earendil-works/pi-durable/package.json") as { version: string }).version);
const productVersion = String((require("../package.json") as { version: string }).version);
const BODY_LIMIT = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 7000;
const POLL_INTERVAL_MS = 3000;
const MAILBOX_IDLE_INTERVAL_MS = 150;
const MAX_ACTIVE_DRAIN_ROUNDS = 4;
const TOKEN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NodeOptions {
  coordinator: string;
  machineId: string;
  tokenEnv: string;
  home: string;
  roots: string[];
  credentialRefs: string[];
  executionMode?: "metadata-only" | "workspace-effects";
  testOnlyScripted?: boolean;
  testOnlyToolLoop?: boolean;
  testOnlyWorkspaceEffectLoop?: boolean;
  testOnlyArtifactTransferLoop?: boolean;
  testOnlyArtifactTaskId?: string;
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
        CREATE TABLE IF NOT EXISTS node_runtime_reports (
          report_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, binding_json TEXT NOT NULL,
          descriptor_hash TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('stopped','uncertain','rejected')),
          state TEXT NOT NULL CHECK(state IN ('pending','sent')), created_at INTEGER NOT NULL
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

  recordRuntimeReport(binding: WorkerBinding, descriptorHash: string, outcome: "stopped" | "uncertain" | "rejected"): { reportId: string; binding: WorkerBinding; descriptorHash: string; outcome: "stopped" | "uncertain" | "rejected" } {
    const prior = this.db.prepare("SELECT report_id,binding_json FROM node_runtime_reports WHERE runtime_id=? AND descriptor_hash=? AND outcome=? ORDER BY created_at LIMIT 1")
      .get(binding.runtimeId, descriptorHash, outcome) as { report_id: string; binding_json: string } | undefined;
    if (prior) {
      const priorBinding = JSON.parse(prior.binding_json) as WorkerBinding;
      if (!sameBinding(priorBinding, binding)) throw new Error("Runtime report binding conflicts with its durable history");
      return { reportId: prior.report_id, binding: priorBinding, descriptorHash, outcome };
    }
    const reportId = randomUUID();
    this.db.prepare("INSERT INTO node_runtime_reports(report_id,runtime_id,binding_json,descriptor_hash,outcome,state,created_at) VALUES(?,?,?,?,?,'pending',?)")
      .run(reportId, binding.runtimeId, JSON.stringify(binding), descriptorHash, outcome, Date.now());
    return { reportId, binding, descriptorHash, outcome };
  }

  pendingRuntimeReports(): Array<{ reportId: string; binding: WorkerBinding; descriptorHash: string; outcome: "stopped" | "uncertain" | "rejected" }> {
    return (this.db.prepare("SELECT report_id,binding_json,descriptor_hash,outcome FROM node_runtime_reports WHERE state='pending' ORDER BY created_at,report_id").all() as Array<{ report_id: string; binding_json: string; descriptor_hash: string; outcome: "stopped" | "uncertain" | "rejected" }>)
      .map((row) => ({ reportId: row.report_id, binding: JSON.parse(row.binding_json) as WorkerBinding, descriptorHash: row.descriptor_hash, outcome: row.outcome }));
  }

  sentRuntimeReport(reportId: string): void {
    this.db.prepare("UPDATE node_runtime_reports SET state='sent' WHERE report_id=? AND state='pending'").run(reportId);
  }

  hasRuntimeReport(runtimeId: string, descriptorHash: string, outcome?: "stopped" | "uncertain" | "rejected"): boolean {
    return Boolean(outcome
      ? this.db.prepare("SELECT 1 FROM node_runtime_reports WHERE runtime_id=? AND descriptor_hash=? AND outcome=? LIMIT 1")
        .get(runtimeId, descriptorHash, outcome)
      : this.db.prepare("SELECT 1 FROM node_runtime_reports WHERE runtime_id=? AND descriptor_hash=? LIMIT 1")
        .get(runtimeId, descriptorHash));
  }

  runtimeReportIdentity(runtimeId: string): { binding: WorkerBinding; descriptorHash: string } | undefined {
    const row = this.db.prepare("SELECT binding_json,descriptor_hash FROM node_runtime_reports WHERE runtime_id=? ORDER BY created_at LIMIT 1")
      .get(runtimeId) as { binding_json: string; descriptor_hash: string } | undefined;
    return row ? { binding: JSON.parse(row.binding_json) as WorkerBinding, descriptorHash: row.descriptor_hash } : undefined;
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

function capabilities(roots: string[], credentialRefs: string[], executionMode?: "metadata-only" | "workspace-effects"): NodeCapabilities {
  return {
    protocol: executionMode === "workspace-effects" ? NODE_WORKSPACE_EFFECTS_PROTOCOL_VERSION : executionMode ? NODE_EXECUTION_PROTOCOL_VERSION : NODE_PROTOCOL_VERSION,
    version: productVersion,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    piDurable: durableVersion,
    roots,
    credentialRefs,
    executionEnabled: executionMode !== undefined,
    ...(executionMode ? { executionMode } : {}),
    ...(executionMode === "workspace-effects" ? { effectApprovals: true as const, artifactTransfers: true as const } : {})
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
): Promise<boolean> {
  if (mailbox.side !== "node") throw new Error("Node mailbox required");
  const base = safeCoordinatorUrl(coordinator);
  const identity = { machineId: binding.machineId, sessionId: binding.sessionId, sessionEpoch: binding.sessionEpoch, binding };
  let progressed = false;
  for (const envelope of mailbox.pending(binding, 1)) {
    const receipt = parseWorkerReceipt(await fetchJson(base, "/api/nodes/mailbox/upload", token, { ...identity, envelope }, signal));
    if (!receipt) throw genericError();
    mailbox.acknowledge(binding, receipt);
    progressed = true;
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
    progressed = true;
  }
  return progressed;
}

function sameBinding(left: WorkerBinding, right: WorkerBinding): boolean {
  return left.runtimeId === right.runtimeId && left.machineId === right.machineId &&
    left.sessionId === right.sessionId && left.sessionEpoch === right.sessionEpoch &&
    left.agentId === right.agentId && left.epoch === right.epoch;
}

export function validRuntimeReportAck(value: unknown): boolean {
  return object(value) && value.recorded === true &&
    (exactKeys(value, ["recorded"]) || exactKeys(value, ["recorded", "duplicate"])) &&
    (!("duplicate" in value) || typeof value.duplicate === "boolean");
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
  let leaseDeadline = 0;
  let mailboxActivityGeneration = 0;
  let wakeMailboxWait: (() => void) | undefined;
  const notifyMailboxActivity = (): void => {
    mailboxActivityGeneration++;
    wakeMailboxWait?.();
  };
  const waitForMailboxActivity = (generation: number, timeoutMs: number): Promise<void> =>
    new Promise<void>((resolveWait) => {
      if (stopping || abort.signal.aborted || mailboxActivityGeneration !== generation) {
        resolveWait();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", finish);
        if (wakeMailboxWait === finish) wakeMailboxWait = undefined;
        resolveWait();
      };
      wakeMailboxWait = finish;
      const timer = setTimeout(finish, timeoutMs);
      abort.signal.addEventListener("abort", finish, { once: true });
      if (stopping || mailboxActivityGeneration !== generation) finish();
    });
  let supervisor: NodeWorkerSupervisor | undefined;
  let runtimeTask: Promise<void> | undefined;
  let runtimeFailure: unknown;
  const runtimeStartFlights = new Map<string, { descriptorHash: string; promise: Promise<void> }>();
  const sessionBody = {
    machineId: options.machineId,
    capabilities: capabilities(roots, credentialRefs, options.executionMode),
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
    if (options.executionMode) {
      const runtimeSession = session;
      supervisor = new NodeWorkerSupervisor({
        home: resolve(options.home, "worker-runtime"),
        machineId: options.machineId,
        sessionId: session.sessionId,
        sessionEpoch: session.sessionEpoch,
        roots,
        credentialRefs,
        forbiddenCredentialRefs: [options.tokenEnv],
        executionEnabled: true,
        executionMode: options.executionMode,
        effectApprovals: options.executionMode === "workspace-effects",
        artifactTransfers: options.executionMode === "workspace-effects",
        uploadArtifact: async ({ spec, manifest, readChunk, verifySnapshot }: {
          spec: NodeEffectSpec; manifest: RemoteArtifactManifest; readChunk: (offset: number, length: number) => Buffer;
          verifySnapshot: () => void;
        }): Promise<JsonValue> => {
          const current = (): void => {
            if (stopping || performance.now() >= leaseDeadline ||
                session?.sessionId !== runtimeSession.sessionId || session?.sessionEpoch !== runtimeSession.sessionEpoch) throw genericError();
          };
          const post = async (path: string, body: unknown): Promise<unknown> => {
            current();
            try {
              return await fetchJson(coordinator, path, token, body, abort.signal);
            } catch (error) {
              if (error instanceof CoordinatorConflict) throw error;
              current();
              return fetchJson(coordinator, path, token, body, abort.signal);
            }
          };
          const base = { machineId: options.machineId, sessionId: session!.sessionId, sessionEpoch: session!.sessionEpoch, spec, manifest };
          const transferId = remoteArtifactTransferId(spec, manifest);
          for (let offset = 0; offset < manifest.size; offset += REMOTE_ARTIFACT_CHUNK_BYTES) {
            const length = Math.min(REMOTE_ARTIFACT_CHUNK_BYTES, manifest.size - offset);
            const bytes = readChunk(offset, length);
            const reply = await post("/api/nodes/artifacts/chunk", { ...base, offset, chunkBase64: bytes.toString("base64") });
            if (!reply || typeof reply !== "object" || (reply as Record<string, unknown>).transferId !== transferId ||
                (reply as Record<string, unknown>).offset !== offset || (reply as Record<string, unknown>).acceptedBytes !== length ||
                typeof (reply as Record<string, unknown>).duplicate !== "boolean") {
              throw genericError();
            }
          }
          verifySnapshot();
          const completed = await post("/api/nodes/artifacts/complete", base);
          if (!completed || typeof completed !== "object" || !(completed as Record<string, unknown>).artifact ||
              typeof (completed as Record<string, unknown>).artifact !== "object") throw genericError();
          return (completed as { artifact: JsonValue }).artifact;
        },
        onMailboxActivity: notifyMailboxActivity,
        ...(options.testOnlyScripted ? { testOnlyScripted: true } : {}),
        ...(options.testOnlyToolLoop ? { testOnlyToolLoop: true } : {}),
        ...(options.testOnlyWorkspaceEffectLoop ? { testOnlyWorkspaceEffectLoop: true } : {}),
        ...(options.testOnlyArtifactTransferLoop ? { testOnlyArtifactTransferLoop: true } : {}),
        ...(options.testOnlyArtifactTaskId ? { testOnlyArtifactTaskId: options.testOnlyArtifactTaskId } : {}),
        isLeaseCurrent: (binding) => !stopping && performance.now() < leaseDeadline &&
          binding.machineId === options.machineId && binding.sessionId === session.sessionId &&
          binding.sessionEpoch === session.sessionEpoch
      });
    }
    const runRuntimeLoop = async (): Promise<void> => {
      if (!supervisor) return;
      const postRuntimeReport = async (report: ReturnType<NodeJournal["pendingRuntimeReports"]>[number]): Promise<void> => {
        const ack = await fetchJson(coordinator, "/api/nodes/runtimes/events", token, {
          machineId: options.machineId, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch, ...report
        }, abort.signal);
        if (!validRuntimeReportAck(ack)) throw genericError();
        journal.sentRuntimeReport(report.reportId);
      };
      let nextAssignmentPoll = 0;
      let activeRounds = 0;
      const mailboxFencedBindings = new Set<string>();
      while (!stopping) {
        const roundGeneration = mailboxActivityGeneration;
        for (const upload of supervisor.pendingEffectReceipts()) {
          const ack = await fetchJson(coordinator, "/api/nodes/effects/receipts", token, {
            machineId: options.machineId,
            sessionId: session.sessionId,
            sessionEpoch: session.sessionEpoch,
            upload
          }, abort.signal);
          supervisor.acknowledgeEffectReceipt(upload, ack);
        }
        for (const report of journal.pendingRuntimeReports()) {
          await postRuntimeReport(report);
        }
        if (Date.now() >= nextAssignmentPoll) {
          const runtimeResponse = await fetchJson(coordinator, "/api/nodes/runtimes/poll", token, {
            machineId: options.machineId, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch
          }, abort.signal);
          if (!object(runtimeResponse) || !exactKeys(runtimeResponse, ["directives"]) ||
              !Array.isArray(runtimeResponse.directives) || runtimeResponse.directives.length > 1) throw genericError();
          nextAssignmentPoll = Date.now() + POLL_INTERVAL_MS;
          for (const rawDirective of runtimeResponse.directives) {
          if (!object(rawDirective) || typeof rawDirective.action !== "string") throw genericError();
          if (rawDirective.action === "start" && exactKeys(rawDirective, ["action", "descriptor", "descriptorHash"])) {
            const descriptor = parseWorkerStartSpec(rawDirective.descriptor);
            const binding = descriptor.binding;
            if (typeof rawDirective.descriptorHash !== "string" || workerStartSpecHash(descriptor) !== rawDirective.descriptorHash ||
                binding.machineId !== options.machineId || binding.sessionId !== session.sessionId ||
                binding.sessionEpoch !== session.sessionEpoch) throw genericError();
            const priorReport = journal.runtimeReportIdentity(binding.runtimeId);
            if (priorReport) {
              if (priorReport.descriptorHash !== rawDirective.descriptorHash || !sameBinding(priorReport.binding, binding)) throw genericError();
              continue;
            }
            const existingFlight = runtimeStartFlights.get(binding.runtimeId);
            if (existingFlight) {
              if (existingFlight.descriptorHash !== rawDirective.descriptorHash) throw genericError();
              continue;
            }
            const descriptorHash = rawDirective.descriptorHash;
            const flight = supervisor.start(descriptor).then(() => undefined, () => {
              try {
                const admitted = supervisor?.inspectBindings().some((item) => sameBinding(item.binding, binding));
                journal.recordRuntimeReport(binding, descriptorHash, admitted ? "uncertain" : "rejected");
              } catch {
                runtimeFailure = genericError();
                abort.abort();
              }
              notifyMailboxActivity();
            }).finally(() => {
              if (runtimeStartFlights.get(binding.runtimeId)?.promise === flight) runtimeStartFlights.delete(binding.runtimeId);
            });
            runtimeStartFlights.set(binding.runtimeId, { descriptorHash, promise: flight });
          } else if (rawDirective.action === "stop" && exactKeys(rawDirective, ["action", "binding", "descriptorHash"])) {
            const binding = parseWorkerBinding(rawDirective.binding);
            if (!binding || typeof rawDirective.descriptorHash !== "string" || !/^[0-9a-f]{64}$/.test(rawDirective.descriptorHash) ||
                binding.machineId !== options.machineId) continue;
            const priorReport = journal.runtimeReportIdentity(binding.runtimeId);
            if (priorReport && (priorReport.descriptorHash !== rawDirective.descriptorHash || !sameBinding(priorReport.binding, binding))) continue;
            if (priorReport) continue;
            const localRuntime = supervisor.inspectBindings().find((item) => item.binding.runtimeId === binding.runtimeId);
            if (localRuntime && (!sameBinding(localRuntime.binding, binding) || localRuntime.descriptorHash !== rawDirective.descriptorHash)) {
              continue;
            }
            if (!localRuntime) {
              journal.recordRuntimeReport(binding, rawDirective.descriptorHash, "uncertain");
            } else {
              try {
                const evidence = await supervisor.stop(binding);
                journal.recordRuntimeReport(binding, rawDirective.descriptorHash, evidence.confirmedStopped ? "stopped" : "uncertain");
              } catch {
                journal.recordRuntimeReport(binding, rawDirective.descriptorHash, "uncertain");
              }
            }
            notifyMailboxActivity();
          } else throw genericError();
        }
        }
        let progress = false;
        for (const runtime of supervisor.inspectBindings()) {
          const { binding } = runtime;
          if (["closed", "uncertain"].includes(runtime.state)) {
            const outcome = runtime.confirmedStopped ? "stopped" : "uncertain";
            const priorReport = journal.runtimeReportIdentity(binding.runtimeId);
            if (priorReport && (!sameBinding(priorReport.binding, binding) || priorReport.descriptorHash !== runtime.descriptorHash)) throw genericError();
            if (!journal.hasRuntimeReport(binding.runtimeId, runtime.descriptorHash, outcome)) {
              journal.recordRuntimeReport(binding, runtime.descriptorHash, outcome);
            }
            continue;
          }
          if (mailboxFencedBindings.has(binding.runtimeId)) continue;
          try {
            progress = await exchangeWorkerMailbox(options.coordinator, token, supervisor.mailbox, binding, abort.signal) || progress;
          } catch (error) {
            if (!(error instanceof CoordinatorConflict)) throw error;
            mailboxFencedBindings.add(binding.runtimeId);
            try {
              const evidence = await supervisor.stop(binding);
              journal.recordRuntimeReport(binding, runtime.descriptorHash, evidence.confirmedStopped ? "stopped" : "uncertain");
            } catch {
              journal.recordRuntimeReport(binding, runtime.descriptorHash, "uncertain");
            }
            notifyMailboxActivity();
            continue;
          }
          await supervisor.pump(binding);
        }
        if (progress || mailboxActivityGeneration !== roundGeneration) {
          activeRounds++;
          if (activeRounds >= MAX_ACTIVE_DRAIN_ROUNDS) {
            activeRounds = 0;
            await new Promise<void>((done) => setImmediate(done));
          }
          continue;
        }
        activeRounds = 0;
        await waitForMailboxActivity(roundGeneration, MAILBOX_IDLE_INTERVAL_MS);
      }
    };
    const handleRuntimeFailure = async (error: unknown): Promise<void> => {
      if (stopping) return;
      runtimeFailure = error;
      stopping = true;
      leaseDeadline = 0;
      abort.abort();
      if (supervisor) {
        for (const runtime of supervisor.inspectBindings()) {
          if (["closed", "uncertain"].includes(runtime.state)) continue;
          try {
            const evidence = await supervisor.stop(runtime.binding);
            journal.recordRuntimeReport(runtime.binding, runtime.descriptorHash, evidence.confirmedStopped ? "stopped" : "uncertain");
          } catch {
            journal.recordRuntimeReport(runtime.binding, runtime.descriptorHash, "uncertain");
          }
        }
      }
    };
    while (true) {
      if (runtimeFailure) throw runtimeFailure;
      if (stopping) break;
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
      const ordinaryPollStarted = performance.now();
      const ordinaryPollResponse = await fetchJson(coordinator, "/api/nodes/poll", token, {
        machineId: options.machineId, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch
      }, abort.signal);
      leaseDeadline = ordinaryPollStarted + session.leaseMs;
      const polled = parseNodePoll(ordinaryPollResponse, options.machineId, session);
      if (supervisor && !runtimeTask) {
        runtimeTask = runRuntimeLoop().catch(handleRuntimeFailure);
      }
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
    if (runtimeFailure) throw genericError();
    if (!stopping) throw genericError();
  } finally {
    stopping = true;
    leaseDeadline = 0;
    abort.abort();
    await runtimeTask?.catch(() => undefined);
    await Promise.allSettled([...runtimeStartFlights.values()].map((flight) => flight.promise));
    if (supervisor) await supervisor.close();
    journal.markAdmittedUncertain();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    journal.close();
  }
}
