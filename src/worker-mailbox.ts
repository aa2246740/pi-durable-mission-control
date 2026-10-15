import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { REMOTE_NONAUTHORIZING_RPC_METHODS } from "./remote-rpc-methods.js";
import { parseWorkerNotice, type WorkerNotice } from "./worker-events.js";

const MAX_ENVELOPE_BYTES = 512 * 1024;
const MAX_ID_LENGTH = 240;
const MAX_METHOD_LENGTH = 120;
const MAX_ARRAY_LENGTH = MAX_ENVELOPE_BYTES;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface WorkerBinding {
  runtimeId: string;
  machineId: string;
  sessionId: string;
  sessionEpoch: number;
  agentId: string;
  epoch: number;
}

export type WorkerRpcPayload = {
  kind: "rpc";
  rpcId: string;
  taskId: string;
  method: string;
  args: { [key: string]: JsonValue };
};

export type WorkerUplinkPayload =
  | { kind: "notice"; notice: WorkerNotice }
  | WorkerRpcPayload;

export type WorkerDownlinkPayload =
  | { kind: "deliver"; messageId: string; requestId: string; attempt: number; content: string; mode: "steer" | "followUp" }
  | {
      kind: "approved-effect";
      approvalId: string;
      permit: {
        binding: WorkerBinding;
        descriptorHash: string;
        taskId: string;
        method: "read_file" | "write_file" | "bash";
        args: { [key: string]: JsonValue };
        expiresAt: number;
      };
    }
  | { kind: "reply"; rpcId: string; ok: true; result: JsonValue }
  | { kind: "reply"; rpcId: string; ok: false; error: string }
  | { kind: "abort" }
  | { kind: "shutdown" };

export type WorkerPayload = WorkerUplinkPayload | WorkerDownlinkPayload;

export interface WorkerEnvelope {
  binding: WorkerBinding;
  messageId: string;
  sequence: number;
  payload: WorkerPayload;
}

export interface WorkerReceipt {
  messageId: string;
  sequence: number;
  sha256: string;
}

/** Identity of one upload a node asks the coordinator about. Read-only. */
export interface MailboxSettlementQuery {
  messageId: string;
  sequence: number;
  sha256: string;
}

export interface MailboxSettlementAnswer extends MailboxSettlementQuery {
  applied: boolean;
}

export interface WorkerBindingStatus extends WorkerBinding {
  status: "open" | "closed" | "uncertain";
  nextSendSequence: number | null;
  nextReceiveSequence: number | null;
}

export interface WorkerMailboxOutboxStatus {
  envelope: WorkerEnvelope;
  sha256: string;
  status: "queued" | "offered" | "acknowledged" | "cancelled" | "uncertain";
}

export interface WorkerMailboxInboxStatus {
  envelope: WorkerEnvelope;
  sha256: string;
  status: "received" | "processing" | "applied" | "cancelled" | "uncertain";
}

type MailboxSide = "node" | "coordinator";
type JsonObject = { [key: string]: JsonValue };
type BindingRow = WorkerBinding & {
  status: WorkerBindingStatus["status"];
  send_sequence: number | null;
  receive_sequence: number | null;
};
type OutboxRow = {
  message_id: string;
  runtime_id: string;
  sequence: number;
  sha256: string;
  envelope_json: string;
  status: WorkerMailboxOutboxStatus["status"];
  source_inbox_id: string | null;
};
type InboxRow = {
  message_id: string;
  runtime_id: string;
  sequence: number;
  sha256: string;
  envelope_json: string;
  status: WorkerMailboxInboxStatus["status"];
};

function own(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function hasControl(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !hasControl(value);
}

function validMethod(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_METHOD_LENGTH && !hasControl(value);
}

function validEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
  } catch {
    return false;
  }
}

type JsonBudget = { remaining: number };

function chargeBudget(budget: JsonBudget, bytes: number): void {
  if (bytes > budget.remaining) throw new Error("JSON value exceeds the 512 KiB envelope budget");
  budget.remaining -= bytes;
}

function quotedStringBytes(value: string, maximum: number): number {
  const rawBytes = Buffer.byteLength(value, "utf8");
  if (rawBytes + 2 > maximum) throw new Error("JSON string exceeds the 512 KiB envelope budget");
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > maximum) throw new Error("JSON string exceeds the 512 KiB envelope budget");
  }
  return bytes;
}

function normalizeJson(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
  budget: JsonBudget = { remaining: MAX_ENVELOPE_BYTES }
): JsonValue {
  if (depth > 256) throw new Error("JSON value is too deeply nested");
  if (value === null) {
    chargeBudget(budget, 4);
    return null;
  }
  if (typeof value === "string") {
    chargeBudget(budget, quotedStringBytes(value, budget.remaining));
    return value;
  }
  if (typeof value === "boolean") {
    chargeBudget(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON value contains a non-finite number");
    chargeBudget(budget, Buffer.byteLength(JSON.stringify(value), "utf8"));
    return value;
  }
  if (typeof value !== "object") throw new Error("JSON value contains an unsupported value");
  if (seen.has(value)) throw new Error("JSON value contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ARRAY_LENGTH) {
        throw new Error("JSON value contains an invalid array");
      }
      chargeBudget(budget, 2);
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) {
        throw new Error("JSON value contains extra array properties");
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!own(value, String(index))) throw new Error("JSON value contains an array hole");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("JSON value contains an accessor");
        }
        if (index > 0) chargeBudget(budget, 1);
        result.push(normalizeJson(descriptor.value, seen, depth + 1, budget));
      }
      return result;
    }
    if (!plainObject(value)) throw new Error("JSON value contains a non-plain object");
    const result: JsonObject = Object.create(null) as JsonObject;
    chargeBudget(budget, 2);
    let first = true;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new Error("JSON value contains a symbol key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("JSON value contains an accessor");
      }
      if (!first) chargeBudget(budget, 1);
      chargeBudget(budget, quotedStringBytes(key, budget.remaining));
      chargeBudget(budget, 1);
      result[key] = normalizeJson(descriptor.value, seen, depth + 1, budget);
      first = false;
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalBytes(value: JsonValue): string {
  const encoded = canonical(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_ENVELOPE_BYTES) {
    throw new Error("Worker envelope exceeds the 512 KiB limit");
  }
  return encoded;
}

function sha256(encoded: string): string {
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function bindingFrom(value: unknown): WorkerBinding | undefined {
  if (!plainObject(value) || !exactKeys(value, ["runtimeId", "machineId", "sessionId", "sessionEpoch", "agentId", "epoch"])) {
    return undefined;
  }
  if (
    !validId(value.runtimeId) || !validId(value.machineId) || !validId(value.sessionId)
    || !validEpoch(value.sessionEpoch) || !validId(value.agentId) || !validEpoch(value.epoch)
  ) return undefined;
  return {
    runtimeId: value.runtimeId,
    machineId: value.machineId,
    sessionId: value.sessionId,
    sessionEpoch: value.sessionEpoch,
    agentId: value.agentId,
    epoch: value.epoch
  };
}

function sameBinding(left: WorkerBinding, right: WorkerBinding): boolean {
  return left.runtimeId === right.runtimeId
    && left.machineId === right.machineId
    && left.sessionId === right.sessionId
    && left.sessionEpoch === right.sessionEpoch
    && left.agentId === right.agentId
    && left.epoch === right.epoch;
}

function payloadFrom(value: unknown, binding: WorkerBinding): WorkerPayload | undefined {
  if (!plainObject(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "notice") {
    if (!exactKeys(value, ["kind", "notice"])) return undefined;
    const notice = parseWorkerNotice(value.notice);
    return notice && notice.agentId === binding.agentId && notice.epoch === binding.epoch
      ? { kind: "notice", notice }
      : undefined;
  }
  if (value.kind === "rpc") {
    if (
      !exactKeys(value, ["kind", "rpcId", "taskId", "method", "args"])
      || !validId(value.rpcId) || !validId(value.taskId) || !validMethod(value.method)
      || !plainObject(value.args)
    ) return undefined;
    const args: JsonObject = Object.create(null) as JsonObject;
    for (const [key, item] of Object.entries(value.args)) args[key] = item as JsonValue;
    return { kind: "rpc", rpcId: value.rpcId, taskId: value.taskId, method: value.method, args };
  }
  if (value.kind === "deliver") {
    if (
      !exactKeys(value, ["kind", "messageId", "requestId", "attempt", "content", "mode"])
      || !validId(value.messageId) || !validId(value.requestId) || !validEpoch(value.attempt)
      || typeof value.content !== "string" || (value.mode !== "steer" && value.mode !== "followUp")
    ) return undefined;
    return {
      kind: "deliver", messageId: value.messageId, requestId: value.requestId,
      attempt: value.attempt, content: value.content, mode: value.mode
    };
  }
  if (value.kind === "approved-effect") {
    if (!exactKeys(value, ["kind", "approvalId", "permit"]) || !validId(value.approvalId) ||
        !plainObject(value.permit) ||
        !exactKeys(value.permit, ["binding", "descriptorHash", "taskId", "method", "args", "expiresAt"])) return undefined;
    const permit = value.permit;
    const permitBinding = parseWorkerBinding(permit.binding);
    if (!permitBinding || typeof permit.descriptorHash !== "string" || !/^[a-f0-9]{64}$/.test(permit.descriptorHash) ||
        !validId(permit.taskId) || !permit.taskId.startsWith(`${binding.agentId}:`) ||
        ["runtimeId", "machineId", "sessionId", "sessionEpoch", "agentId", "epoch"].some((key) =>
          permitBinding[key as keyof WorkerBinding] !== binding[key as keyof WorkerBinding]) ||
        (permit.method !== "read_file" && permit.method !== "write_file" && permit.method !== "bash") ||
        !plainObject(permit.args) || typeof permit.expiresAt !== "number" ||
        !Number.isSafeInteger(permit.expiresAt) || permit.expiresAt <= 0) return undefined;
    const spec = parseWorkerEnvelope({
      binding: permitBinding, messageId: "approved-effect-preflight", sequence: 1,
      payload: { kind: "rpc", rpcId: "approved-effect-preflight", taskId: permit.taskId, method: permit.method, args: permit.args }
    });
    if (!spec || spec.payload.kind !== "rpc") return undefined;
    return {
      kind: "approved-effect", approvalId: value.approvalId,
      permit: {
        binding: permitBinding, descriptorHash: permit.descriptorHash, taskId: spec.payload.taskId,
        method: spec.payload.method as "read_file" | "write_file" | "bash",
        args: spec.payload.args, expiresAt: permit.expiresAt
      }
    };
  }
  if (value.kind === "reply") {
    if (!plainObject(value) || !validId(value.rpcId) || !own(value, "ok") || typeof value.ok !== "boolean") return undefined;
    if (value.ok) {
      return exactKeys(value, ["kind", "rpcId", "ok", "result"]) && own(value, "result")
        ? { kind: "reply", rpcId: value.rpcId, ok: true, result: value.result as JsonValue }
        : undefined;
    }
    return exactKeys(value, ["kind", "rpcId", "ok", "error"]) && typeof value.error === "string"
      ? { kind: "reply", rpcId: value.rpcId, ok: false, error: value.error }
      : undefined;
  }
  if (value.kind === "abort" || value.kind === "shutdown") {
    return exactKeys(value, ["kind"]) ? { kind: value.kind } : undefined;
  }
  return undefined;
}

function outgoing(side: MailboxSide, payload: WorkerPayload): boolean {
  return side === "node"
    ? payload.kind === "notice" || payload.kind === "rpc"
    : payload.kind === "deliver" || payload.kind === "approved-effect" || payload.kind === "reply" || payload.kind === "abort" || payload.kind === "shutdown";
}

function incoming(side: MailboxSide, payload: WorkerPayload): boolean {
  return !outgoing(side, payload);
}

function replyCarriesEffectPermit(payload: WorkerPayload): boolean {
  if (payload.kind !== "reply" || payload.ok !== true) return false;
  const result = payload.result;
  return Boolean(result && typeof result === "object" && !Array.isArray(result) && own(result, "effectPermit"));
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function rowBinding(row: BindingRow): WorkerBinding {
  return {
    runtimeId: row.runtimeId, machineId: row.machineId, sessionId: row.sessionId,
    sessionEpoch: row.sessionEpoch, agentId: row.agentId, epoch: row.epoch
  };
}

function exactAck(value: unknown): WorkerReceipt | undefined {
  if (
    !plainObject(value) || !exactKeys(value, ["messageId", "sequence", "sha256"])
    || !validId(value.messageId) || !validEpoch(value.sequence)
    || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)
  ) return undefined;
  return { messageId: value.messageId, sequence: value.sequence, sha256: value.sha256 };
}

export function parseWorkerBinding(value: unknown): WorkerBinding | undefined {
  try {
    return bindingFrom(normalizeJson(value));
  } catch {
    return undefined;
  }
}

export function parseWorkerReceipt(value: unknown): WorkerReceipt | undefined {
  try {
    return exactAck(normalizeJson(value));
  } catch {
    return undefined;
  }
}

function checkLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error("Worker mailbox limit must be an integer from 1 to 64");
}

export function parseWorkerEnvelope(value: unknown): WorkerEnvelope | undefined {
  try {
    const normalized = normalizeJson(value);
    if (!plainObject(normalized) || !exactKeys(normalized, ["binding", "messageId", "sequence", "payload"])) return undefined;
    const binding = bindingFrom(normalized.binding);
    if (!binding || !validId(normalized.messageId) || !validEpoch(normalized.sequence)) return undefined;
    const payload = payloadFrom(normalized.payload, binding);
    if (!payload) return undefined;
    canonicalBytes(normalized);
    return { binding, messageId: normalized.messageId, sequence: normalized.sequence, payload };
  } catch {
    return undefined;
  }
}

/**
 * Internal durable transport storage. Authentication of the node bearer and
 * current session must happen before callers invoke this class; the mailbox
 * is not an authentication boundary.
 */
export class DurableWorkerMailbox {
  private savepointId = 0;
  readonly db: DatabaseSync;
  readonly side: MailboxSide;

  constructor(db: DatabaseSync, side: MailboxSide) {
    if (side !== "node" && side !== "coordinator") throw new Error("Invalid worker mailbox side");
    this.db = db;
    this.side = side;
    this.atomic(() => this.initialize());
  }

  static migrate(db: DatabaseSync, side: MailboxSide): void {
    new DurableWorkerMailbox(db, side);
  }

  private atomic<T>(fn: () => T): T {
    const nested = this.db.isTransaction;
    const savepoint = `worker_mailbox_sp_${++this.savepointId}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return value;
    } catch (error) {
      try {
        this.db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : "ROLLBACK");
      } catch {
        // Preserve the operation's error if the caller has already changed the transaction.
      }
      throw error;
    }
  }

  private initialize(): void {
    const tables = this.db.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'worker_mailbox_%'"
    ).all() as Array<{ name: string }>;
    const existing = tables.some((table) => table.name === "worker_mailbox_meta")
      ? this.db.prepare("SELECT side FROM worker_mailbox_meta WHERE singleton=1").get() as { side?: unknown } | undefined
      : undefined;
    const names = [
      "worker_mailbox_meta", "worker_mailbox_bindings", "worker_mailbox_outbox", "worker_mailbox_inbox"
    ];
    if (existing) {
      if (existing.side !== this.side) throw new Error("Worker mailbox side does not match its initialized database");
      if (names.some((name) => !tables.some((table) => table.name === name))) {
        throw new Error("Worker mailbox database is incomplete");
      }
      return;
    }
    if (tables.length > 0) throw new Error("Worker mailbox database has an uninitialized namespace");
    this.db.exec(`
      CREATE TABLE worker_mailbox_meta (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        side TEXT NOT NULL CHECK(side IN ('node','coordinator'))
      );
      CREATE TABLE worker_mailbox_bindings (
        runtime_id TEXT PRIMARY KEY,
        machine_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_epoch INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open','closed','uncertain')),
        send_sequence INTEGER,
        receive_sequence INTEGER
      );
      CREATE TABLE worker_mailbox_outbox (
        message_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL REFERENCES worker_mailbox_bindings(runtime_id),
        sequence INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','offered','acknowledged','cancelled','uncertain')),
        source_inbox_id TEXT UNIQUE,
        UNIQUE(runtime_id, sequence)
      );
      CREATE TABLE worker_mailbox_inbox (
        message_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL REFERENCES worker_mailbox_bindings(runtime_id),
        sequence INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('received','processing','applied','cancelled','uncertain')),
        UNIQUE(runtime_id, sequence)
      );
      CREATE INDEX worker_mailbox_outbox_runtime_status
        ON worker_mailbox_outbox(runtime_id, status, sequence);
      CREATE INDEX worker_mailbox_inbox_runtime_status
        ON worker_mailbox_inbox(runtime_id, status, sequence);
    `);
    this.db.prepare("INSERT INTO worker_mailbox_meta(singleton,side) VALUES(1,?)").run(this.side);
  }

  private checkedBinding(value: WorkerBinding): WorkerBinding {
    const binding = bindingFrom(value);
    if (!binding) throw new Error("Invalid worker binding");
    return binding;
  }

  private bindingRow(binding: WorkerBinding): BindingRow {
    const row = this.db.prepare(
      "SELECT runtime_id AS runtimeId,machine_id AS machineId,session_id AS sessionId,session_epoch AS sessionEpoch,agent_id AS agentId,epoch,status,send_sequence,receive_sequence FROM worker_mailbox_bindings WHERE runtime_id=?"
    ).get(binding.runtimeId) as BindingRow | undefined;
    if (!row) throw new Error("Worker binding is not open in this mailbox");
    if (!sameBinding(rowBinding(row), binding)) throw new Error("Worker binding identity mismatch");
    return row;
  }

  private openRow(binding: WorkerBinding): BindingRow {
    const row = this.bindingRow(binding);
    if (row.status !== "open") throw new Error(`Worker binding is ${row.status}`);
    return row;
  }

  private status(row: BindingRow): WorkerBindingStatus {
    return freeze({
      ...rowBinding(row),
      status: row.status,
      nextSendSequence: row.send_sequence,
      nextReceiveSequence: row.receive_sequence
    });
  }

  open(value: WorkerBinding): WorkerBindingStatus {
    const binding = this.checkedBinding(value);
    return this.atomic(() => {
      const current = this.db.prepare(
        "SELECT runtime_id AS runtimeId,machine_id AS machineId,session_id AS sessionId,session_epoch AS sessionEpoch,agent_id AS agentId,epoch,status,send_sequence,receive_sequence FROM worker_mailbox_bindings WHERE runtime_id=?"
      ).get(binding.runtimeId) as BindingRow | undefined;
      if (current) {
        if (!sameBinding(rowBinding(current), binding)) throw new Error("Worker runtime ID is already bound to a different identity");
        return this.status(current);
      }
      const owner = this.db.prepare(
        "SELECT runtime_id FROM worker_mailbox_bindings WHERE agent_id=? AND status IN ('open','uncertain') LIMIT 1"
      ).get(binding.agentId) as { runtime_id?: string } | undefined;
      if (owner) throw new Error("Another open or uncertain worker runtime owns this agent");
      this.db.prepare(
        "INSERT INTO worker_mailbox_bindings(runtime_id,machine_id,session_id,session_epoch,agent_id,epoch,status,send_sequence,receive_sequence) VALUES(?,?,?,?,?,?, 'open',1,1)"
      ).run(
        binding.runtimeId, binding.machineId, binding.sessionId, binding.sessionEpoch,
        binding.agentId, binding.epoch
      );
      const created = this.bindingRow(binding);
      return this.status(created);
    });
  }

  inspectBindings(): readonly WorkerBindingStatus[] {
    const rows = this.db.prepare(
      "SELECT runtime_id AS runtimeId,machine_id AS machineId,session_id AS sessionId,session_epoch AS sessionEpoch,agent_id AS agentId,epoch,status,send_sequence,receive_sequence FROM worker_mailbox_bindings ORDER BY runtime_id"
    ).all() as unknown as BindingRow[];
    return freeze(rows.map((row) => this.status(row)));
  }

  inspectBinding(value: WorkerBinding): WorkerBindingStatus {
    const binding = this.checkedBinding(value);
    return this.status(this.bindingRow(binding));
  }

  private envelope(value: string, expectedHash: string): WorkerEnvelope {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Worker mailbox contains invalid envelope JSON");
    }
    const envelope = parseWorkerEnvelope(parsed);
    if (!envelope || sha256(canonicalBytes(normalizeJson(parsed))) !== expectedHash) {
      throw new Error("Worker mailbox contains an invalid envelope hash");
    }
    return envelope;
  }

  private envelopeHash(envelope: WorkerEnvelope): { encoded: string; hash: string } {
    const normalized = normalizeJson(envelope);
    const encoded = canonicalBytes(normalized);
    return { encoded, hash: sha256(encoded) };
  }

  private outboxRow(row: OutboxRow): WorkerMailboxOutboxStatus {
    return freeze({ envelope: this.envelope(row.envelope_json, row.sha256), sha256: row.sha256, status: row.status });
  }

  private inboxRow(row: InboxRow): WorkerMailboxInboxStatus {
    return freeze({ envelope: this.envelope(row.envelope_json, row.sha256), sha256: row.sha256, status: row.status });
  }

  inspectOutbox(value: WorkerBinding): readonly WorkerMailboxOutboxStatus[] {
    const binding = this.checkedBinding(value);
    this.bindingRow(binding);
    const rows = this.db.prepare(
      "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status,source_inbox_id FROM worker_mailbox_outbox WHERE runtime_id=? ORDER BY sequence"
    ).all(binding.runtimeId) as OutboxRow[];
    return freeze(rows.map((row) => this.outboxRow(row)));
  }

  inspectOutboxMessage(value: WorkerBinding, messageId: string): WorkerMailboxOutboxStatus | undefined {
    const binding = this.checkedBinding(value);
    this.bindingRow(binding);
    const row = this.existingOutbox(messageId);
    return row?.runtime_id === binding.runtimeId ? this.outboxRow(row) : undefined;
  }

  inspectInbox(value: WorkerBinding): readonly WorkerMailboxInboxStatus[] {
    const binding = this.checkedBinding(value);
    this.bindingRow(binding);
    const rows = this.db.prepare(
      "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status FROM worker_mailbox_inbox WHERE runtime_id=? ORDER BY sequence"
    ).all(binding.runtimeId) as InboxRow[];
    return freeze(rows.map((row) => this.inboxRow(row)));
  }

  private payloadFor(value: WorkerPayload, binding: WorkerBinding): WorkerPayload {
    const normalized = normalizeJson(value);
    const payload = payloadFrom(normalized, binding);
    if (!payload || !outgoing(this.side, payload)) throw new Error(`Worker ${this.side} mailbox cannot enqueue this payload direction`);
    return payload;
  }

  private existingOutbox(messageId: string): OutboxRow | undefined {
    return this.db.prepare(
      "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status,source_inbox_id FROM worker_mailbox_outbox WHERE message_id=?"
    ).get(messageId) as OutboxRow | undefined;
  }

  private existingInbox(messageId: string): InboxRow | undefined {
    return this.db.prepare(
      "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status FROM worker_mailbox_inbox WHERE message_id=?"
    ).get(messageId) as InboxRow | undefined;
  }

  private enqueueWithinTransaction(
    binding: WorkerBinding,
    payload: WorkerPayload,
    messageId: string,
    sourceInboxId: string | null = null
  ): WorkerEnvelope {
    const existing = this.existingOutbox(messageId);
    if (existing) {
      const existingEnvelope = this.envelope(existing.envelope_json, existing.sha256);
      if (
        sameBinding(existingEnvelope.binding, binding)
        && canonical(existingEnvelope.payload as JsonValue) === canonical(payload as JsonValue)
        && (sourceInboxId === null || existing.source_inbox_id === sourceInboxId)
      ) return existingEnvelope;
      throw new Error("Worker message ID is already used for a different payload or binding");
    }
    if (this.existingInbox(messageId)) throw new Error("Worker message ID is already used by an inbound envelope");
    const row = this.openRow(binding);
    if (row.send_sequence === null || !validEpoch(row.send_sequence)) throw new Error("Worker send sequence is exhausted");
    const envelope = parseWorkerEnvelope({ binding, messageId, sequence: row.send_sequence, payload });
    if (!envelope) throw new Error("Invalid worker envelope");
    const encoded = canonicalBytes(normalizeJson(envelope));
    const digest = sha256(encoded);
    this.db.prepare(
      "INSERT INTO worker_mailbox_outbox(message_id,runtime_id,sequence,sha256,envelope_json,status,source_inbox_id) VALUES(?,?,?,?,?,'queued',?)"
    ).run(messageId, binding.runtimeId, envelope.sequence, digest, encoded, sourceInboxId);
    this.db.prepare("UPDATE worker_mailbox_bindings SET send_sequence=? WHERE runtime_id=?")
      .run(envelope.sequence === MAX_SAFE ? null : envelope.sequence + 1, binding.runtimeId);
    return envelope;
  }

  enqueue(value: WorkerBinding, valuePayload: WorkerPayload, messageId: string = randomUUID()): WorkerEnvelope {
    const binding = this.checkedBinding(value);
    if (!validId(messageId)) throw new Error("Invalid worker message ID");
    const payload = this.payloadFor(valuePayload, binding);
    return freeze(this.atomic(() => this.enqueueWithinTransaction(binding, payload, messageId)));
  }

  pending(value: WorkerBinding, limit = 32, include?: (envelope: WorkerEnvelope) => boolean): readonly WorkerEnvelope[] {
    checkLimit(limit);
    const binding = this.checkedBinding(value);
    return freeze(this.atomic(() => {
      this.openRow(binding);
      const rows = this.db.prepare(
        "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status,source_inbox_id FROM worker_mailbox_outbox WHERE runtime_id=? AND status IN ('queued','offered') ORDER BY sequence"
      ).all(binding.runtimeId) as OutboxRow[];
      const selected: OutboxRow[] = [];
      for (const row of rows) {
        const parsed = this.outboxRow(row);
        if (include && !include(parsed.envelope)) break;
        if (selected.length >= limit) break;
        if (row.status === "queued") {
          this.db.prepare("UPDATE worker_mailbox_outbox SET status='offered' WHERE message_id=? AND status='queued'")
            .run(row.message_id);
        }
        selected.push({ ...row, status: row.status === "queued" ? "offered" : row.status });
      }
      return selected.map((row) => this.outboxRow(row));
    }).map((row) => row.envelope));
  }

  acknowledge(value: WorkerBinding, valueReceipt: WorkerReceipt): boolean {
    const binding = this.checkedBinding(value);
    const receipt = exactAck(valueReceipt);
    if (!receipt) throw new Error("Invalid worker acknowledgement");
    return this.atomic(() => {
      const row = this.existingOutbox(receipt.messageId);
      if (!row) throw new Error("Worker outbound message was not found");
      if (row.runtime_id !== binding.runtimeId) throw new Error("Worker acknowledgement targets another binding");
      const envelope = this.envelope(row.envelope_json, row.sha256);
      if (
        !sameBinding(envelope.binding, binding)
        || envelope.sequence !== receipt.sequence
        || row.sha256 !== receipt.sha256
      ) throw new Error("Worker acknowledgement identity mismatch");
      if (row.status === "acknowledged") return true;
      if (row.status !== "offered") throw new Error("Worker outbound message is not offered");
      this.openRow(binding);
      this.db.prepare("UPDATE worker_mailbox_outbox SET status='acknowledged' WHERE message_id=? AND status='offered'")
        .run(receipt.messageId);
      return true;
    });
  }

  receive(value: WorkerBinding, rawEnvelope: unknown): WorkerReceipt {
    const binding = this.checkedBinding(value);
    const envelope = parseWorkerEnvelope(rawEnvelope);
    if (!envelope || !sameBinding(envelope.binding, binding) || !incoming(this.side, envelope.payload)) {
      throw new Error("Worker inbound envelope is invalid, misbound, or has the wrong direction");
    }
    const { encoded, hash } = this.envelopeHash(envelope);
    return this.atomic(() => {
      const row = this.openRow(binding);
      const existing = this.existingInbox(envelope.messageId);
      if (existing) {
        const existingEnvelope = this.envelope(existing.envelope_json, existing.sha256);
        if (
          existing.runtime_id === binding.runtimeId
          && existing.sequence === envelope.sequence
          && existing.sha256 === hash
          && canonical(existingEnvelope as unknown as JsonValue) === canonical(envelope as unknown as JsonValue)
        ) return { messageId: envelope.messageId, sequence: envelope.sequence, sha256: hash };
        throw new Error("Worker inbound message ID conflicts with existing evidence");
      }
      if (this.existingOutbox(envelope.messageId)) throw new Error("Worker inbound message ID conflicts with outbound evidence");
      if (row.receive_sequence === null || envelope.sequence !== row.receive_sequence) {
        throw new Error("Worker inbound sequence is not the next expected sequence");
      }
      if (envelope.payload.kind === "rpc") {
        const rpcConflict = this.db.prepare(
          "SELECT message_id FROM worker_mailbox_inbox WHERE runtime_id=? AND json_extract(envelope_json,'$.payload.rpcId')=? LIMIT 1"
        ).get(binding.runtimeId, envelope.payload.rpcId) as { message_id?: string } | undefined;
        if (rpcConflict) throw new Error("Worker RPC ID is already used by a different inbound message");
      }
      const sequenceConflict = this.db.prepare(
        "SELECT message_id FROM worker_mailbox_inbox WHERE runtime_id=? AND sequence=?"
      ).get(binding.runtimeId, envelope.sequence);
      if (sequenceConflict) throw new Error("Worker inbound sequence is already used");
      this.db.prepare(
        "INSERT INTO worker_mailbox_inbox(message_id,runtime_id,sequence,sha256,envelope_json,status) VALUES(?,?,?,?,?,'received')"
      ).run(envelope.messageId, binding.runtimeId, envelope.sequence, hash, encoded);
      this.db.prepare("UPDATE worker_mailbox_bindings SET receive_sequence=? WHERE runtime_id=?")
        .run(envelope.sequence === MAX_SAFE ? null : envelope.sequence + 1, binding.runtimeId);
      return { messageId: envelope.messageId, sequence: envelope.sequence, sha256: hash };
    });
  }

  received(value: WorkerBinding, limit = 32): readonly WorkerEnvelope[] {
    checkLimit(limit);
    const binding = this.checkedBinding(value);
    return freeze(this.atomic(() => {
      this.openRow(binding);
      const rows = this.db.prepare(
        "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status FROM worker_mailbox_inbox WHERE runtime_id=? AND status='received' ORDER BY sequence LIMIT ?"
      ).all(binding.runtimeId, limit) as InboxRow[];
      return rows.map((row) => this.inboxRow(row).envelope);
    }));
  }

  claim(value: WorkerBinding, messageId: string): WorkerEnvelope | undefined {
    const binding = this.checkedBinding(value);
    if (!validId(messageId)) throw new Error("Invalid worker message ID");
    return freeze(this.atomic(() => {
      this.openRow(binding);
      const row = this.db.prepare(
        "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status FROM worker_mailbox_inbox WHERE message_id=?"
      ).get(messageId) as InboxRow | undefined;
      if (!row || row.runtime_id !== binding.runtimeId || row.status !== "received") return undefined;
      this.db.prepare("UPDATE worker_mailbox_inbox SET status='processing' WHERE message_id=? AND status='received'")
        .run(messageId);
      return this.inboxRow({ ...row, status: "processing" }).envelope;
    }));
  }

  finish(value: WorkerBinding, messageId: string): boolean {
    const binding = this.checkedBinding(value);
    if (!validId(messageId)) throw new Error("Invalid worker message ID");
    return this.atomic(() => {
      this.bindingRow(binding);
      const row = this.db.prepare(
        "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status FROM worker_mailbox_inbox WHERE message_id=?"
      ).get(messageId) as InboxRow | undefined;
      if (!row || row.runtime_id !== binding.runtimeId) throw new Error("Worker inbound message was not found");
      if (row.status === "applied") return true;
      if (row.status !== "processing") return false;
      this.openRow(binding);
      this.db.prepare("UPDATE worker_mailbox_inbox SET status='applied' WHERE message_id=? AND status='processing'")
        .run(messageId);
      return true;
    });
  }

  finishWithReply(
    value: WorkerBinding,
    incomingId: string,
    reply: WorkerDownlinkPayload,
    replyMessageId = randomUUID()
  ): WorkerEnvelope {
    if (this.side !== "coordinator") throw new Error("Only a coordinator mailbox can finish an RPC with a reply");
    const binding = this.checkedBinding(value);
    if (!validId(incomingId) || !validId(replyMessageId)) throw new Error("Invalid worker message ID");
    const payload = this.payloadFor(reply, binding);
    if (payload.kind !== "reply") throw new Error("Only reply payloads can finish an RPC");
    return freeze(this.atomic(() => {
      this.bindingRow(binding);
      const incomingRow = this.db.prepare(
        "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status FROM worker_mailbox_inbox WHERE message_id=?"
      ).get(incomingId) as InboxRow | undefined;
      if (!incomingRow || incomingRow.runtime_id !== binding.runtimeId) throw new Error("Worker inbound RPC was not found");
      const incomingEnvelope = this.envelope(incomingRow.envelope_json, incomingRow.sha256);
      if (incomingEnvelope.payload.kind !== "rpc") throw new Error("Worker inbound message is not an RPC");
      if (payload.rpcId !== incomingEnvelope.payload.rpcId) throw new Error("Worker reply RPC ID does not match the inbound RPC");
      const relation = this.db.prepare(
        "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status,source_inbox_id FROM worker_mailbox_outbox WHERE source_inbox_id=?"
      ).get(incomingId) as OutboxRow | undefined;
      if (relation) {
        const relationEnvelope = this.envelope(relation.envelope_json, relation.sha256);
        if (
          relation.message_id !== replyMessageId
          || canonical(relationEnvelope.payload as JsonValue) !== canonical(payload as JsonValue)
        ) throw new Error("Worker RPC already has a different durable reply");
        if (incomingRow.status !== "applied") throw new Error("Worker RPC reply relation has no applied inbox evidence");
        return relationEnvelope;
      }
      if (incomingRow.status === "applied") throw new Error("Worker RPC is already applied with a different reply");
      if (incomingRow.status !== "processing") throw new Error("Worker inbound RPC is not processing");
      const envelope = this.enqueueWithinTransaction(binding, payload, replyMessageId, incomingId);
      this.db.prepare("UPDATE worker_mailbox_inbox SET status='applied' WHERE message_id=? AND status='processing'")
        .run(incomingId);
      return envelope;
    }));
  }

  /**
   * Whether a fenced outbox row no longer blocks closing the binding.
   *
   * Acknowledged and cancelled rows are settled. An uncertain coordinator
   * reply is settled only when it answers an already-applied whitelist RPC
   * and the reply itself contains no effect permit. An uncertain node upload
   * is settled only when `appliedUploadIds` contains its message id. The
   * caller may add an id only after a read-only coordinator answer matched
   * this row's message id, sequence, and sha256 and reported `applied`.
   * The row status is left unchanged: settlement does not replay or rebind it.
   * Any other uncertain, queued, or offered row still blocks.
   */
  outboxSettledForStop(value: WorkerBinding, messageId: string, appliedUploadIds?: ReadonlySet<string>): boolean {
    const binding = this.checkedBinding(value);
    if (!validId(messageId)) return false;
    const row = this.existingOutbox(messageId);
    if (!row || row.runtime_id !== binding.runtimeId) return false;
    if (row.status === "acknowledged" || row.status === "cancelled") return true;
    if (row.status !== "uncertain") return false;
    if (this.uncertainReplySettled(row)) return true;
    if (this.side !== "node" || !appliedUploadIds?.has(row.message_id)) return false;
    const envelope = this.envelope(row.envelope_json, row.sha256);
    return envelope.payload.kind === "rpc" || envelope.payload.kind === "notice";
  }

  /**
   * Whether a fenced inbox row no longer blocks closing the binding.
   *
   * Applied and cancelled rows are settled. On the node, an uncertain reply
   * to a whitelist RPC already stored in this mailbox's outbox is settled:
   * the worker was stopped while handling a non-authorizing result. Business
   * deliveries, effect-permit replies, and every coordinator inbox row that
   * is not applied or cancelled still block. Status is not changed.
   */
  inboxSettledForStop(value: WorkerBinding, messageId: string): boolean {
    const binding = this.checkedBinding(value);
    if (!validId(messageId)) return false;
    const row = this.existingInbox(messageId);
    if (!row || row.runtime_id !== binding.runtimeId) return false;
    if (row.status === "applied" || row.status === "cancelled") return true;
    if (row.status !== "uncertain" || this.side !== "node") return false;
    return this.uncertainInboundReplySettled(binding, row);
  }

  private uncertainReplySettled(row: OutboxRow): boolean {
    if (!row.source_inbox_id) return false;
    const reply = this.envelope(row.envelope_json, row.sha256);
    if (reply.payload.kind !== "reply" || replyCarriesEffectPermit(reply.payload)) return false;
    const source = this.existingInbox(row.source_inbox_id);
    if (!source || source.runtime_id !== row.runtime_id || source.status !== "applied") return false;
    const request = this.envelope(source.envelope_json, source.sha256);
    if (request.payload.kind !== "rpc" || request.payload.rpcId !== reply.payload.rpcId) return false;
    return REMOTE_NONAUTHORIZING_RPC_METHODS.has(request.payload.method);
  }

  private uncertainInboundReplySettled(binding: WorkerBinding, row: InboxRow): boolean {
    const reply = this.envelope(row.envelope_json, row.sha256);
    if (reply.payload.kind !== "reply" || replyCarriesEffectPermit(reply.payload)) return false;
    const rpcId = reply.payload.rpcId;
    const matches = this.db.prepare(
      "SELECT message_id,runtime_id,sequence,sha256,envelope_json,status,source_inbox_id FROM worker_mailbox_outbox WHERE runtime_id=? AND json_extract(envelope_json,'$.payload.kind')='rpc' AND json_extract(envelope_json,'$.payload.rpcId')=?"
    ).all(binding.runtimeId, rpcId) as OutboxRow[];
    return matches.some((upload) => {
      const request = this.envelope(upload.envelope_json, upload.sha256);
      return request.payload.kind === "rpc"
        && request.payload.rpcId === rpcId
        && REMOTE_NONAUTHORIZING_RPC_METHODS.has(request.payload.method);
    });
  }

  confirmClosed(value: WorkerBinding): WorkerBindingStatus {
    const binding = this.checkedBinding(value);
    return this.atomic(() => {
      const row = this.bindingRow(binding);
      if (row.status === "closed") return this.status(row);
      // This trusted attestation cannot prove process death; it only records
      // ownership evidence after unsettled transport entries are fenced.
      const activeOutbox = this.db.prepare(
        "SELECT 1 FROM worker_mailbox_outbox WHERE runtime_id=? AND status IN ('queued','offered') LIMIT 1"
      ).get(binding.runtimeId);
      const activeInbox = this.db.prepare(
        "SELECT 1 FROM worker_mailbox_inbox WHERE runtime_id=? AND status IN ('received','processing') LIMIT 1"
      ).get(binding.runtimeId);
      if (activeOutbox || activeInbox) throw new Error("Worker binding has unsettled mailbox entries");
      this.db.prepare("UPDATE worker_mailbox_bindings SET status='closed' WHERE runtime_id=?").run(binding.runtimeId);
      return this.status({ ...row, status: "closed" });
    });
  }

  fence(value: WorkerBinding): WorkerBindingStatus {
    const binding = this.checkedBinding(value);
    return this.atomic(() => {
      const row = this.bindingRow(binding);
      if (row.status === "closed") throw new Error("Closed worker bindings cannot be fenced");
      if (row.status === "open") {
        this.db.prepare(
          "UPDATE worker_mailbox_outbox SET status=CASE status WHEN 'queued' THEN 'cancelled' WHEN 'offered' THEN 'uncertain' ELSE status END WHERE runtime_id=?"
        ).run(binding.runtimeId);
        this.db.prepare(
          "UPDATE worker_mailbox_inbox SET status=CASE status WHEN 'received' THEN 'cancelled' WHEN 'processing' THEN 'uncertain' ELSE status END WHERE runtime_id=?"
        ).run(binding.runtimeId);
        this.db.prepare("UPDATE worker_mailbox_bindings SET status='uncertain' WHERE runtime_id=?").run(binding.runtimeId);
      }
      return this.status({ ...row, status: "uncertain" });
    });
  }

  recover(): number {
    return this.atomic(() => {
      const rows = this.db.prepare(
        "SELECT runtime_id AS runtimeId,machine_id AS machineId,session_id AS sessionId,session_epoch AS sessionEpoch,agent_id AS agentId,epoch,status,send_sequence,receive_sequence FROM worker_mailbox_bindings WHERE status='open'"
      ).all() as unknown as BindingRow[];
      for (const row of rows) this.fence(rowBinding(row));
      return rows.length;
    });
  }
}
