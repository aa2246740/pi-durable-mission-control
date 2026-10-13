import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseWorkerBinding, parseWorkerEnvelope, type JsonValue, type WorkerBinding } from "./worker-mailbox.js";

export interface NodeEffectSpec {
  binding: WorkerBinding;
  descriptorHash: string;
  taskId: string;
  method: "read_file" | "write_file" | "bash";
  args: { [key: string]: JsonValue };
}

export type NodeEffectReceipt =
  | { status: "succeeded" | "failed"; result: JsonValue }
  | { status: "uncertain"; error: string };

export interface NodeEffectUpload {
  effectId: string;
  receiptHash: string;
  spec: NodeEffectSpec;
  receipt: NodeEffectReceipt;
}

export interface NodeEffectAck {
  recorded: true;
  duplicate: boolean;
  effectId: string;
  receiptHash: string;
}

type EffectState = "prepared" | "executing" | NodeEffectReceipt["status"];
type EffectRow = {
  effect_id: string; input_hash: string; spec_json: string; state: EffectState;
  receipt_json: string | null; created_at: number; updated_at: number;
};

const MAX_RECEIPT_BYTES = 480 * 1024;

export class NodeEffectError extends Error {}

function fail(): never {
  throw new NodeEffectError("Invalid node effect identity or payload");
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null)
    && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function checkedSpec(value: unknown): NodeEffectSpec {
  if (!exact(value, ["binding", "descriptorHash", "taskId", "method", "args"])) fail();
  const binding = parseWorkerBinding(value.binding);
  if (!binding || typeof value.descriptorHash !== "string" || !/^[a-f0-9]{64}$/.test(value.descriptorHash)) fail();
  if (typeof value.taskId !== "string" || !value.taskId.startsWith(binding.agentId + ":") || value.taskId.length > 240 || /\p{Cc}/u.test(value.taskId)) fail();
  const method = value.method;
  if (method !== "read_file" && method !== "write_file" && method !== "bash") fail();
  const args = value.args;
  const keys = method === "bash" ? ["command"] : method === "write_file" ? ["path", "content"] : ["path"];
  if (!exact(args, keys)) fail();
  const path = method === "bash" ? args.command : args.path;
  if (typeof path !== "string" || !path.trim() || path.length > (method === "bash" ? 32000 : 4096) || path.includes("\0")) fail();
  if (method !== "bash" && /\p{Cc}/u.test(path)) fail();
  if (method === "write_file" && (typeof args.content !== "string" || Buffer.byteLength(args.content) > 256 * 1024)) fail();
  const envelope = parseWorkerEnvelope({
    binding, messageId: "node-effect-validation", sequence: 1,
    payload: { kind: "rpc", rpcId: "node-effect-validation", taskId: value.taskId, method, args }
  });
  if (!envelope || envelope.payload.kind !== "rpc") fail();
  return { binding, descriptorHash: value.descriptorHash, taskId: value.taskId, method, args: envelope.payload.args };
}

function checkedReceipt(value: unknown, binding: WorkerBinding): NodeEffectReceipt {
  if (!value || typeof value !== "object") fail();
  const status = (value as { status?: unknown }).status;
  if (status === "uncertain") {
    if (!exact(value, ["status", "error"]) || typeof value.error !== "string" || !value.error.trim() || value.error.length > 4000) fail();
    return { status, error: value.error };
  }
  if ((status !== "succeeded" && status !== "failed") || !exact(value, ["status", "result"])) fail();
  const envelope = parseWorkerEnvelope({
    binding, messageId: "node-effect-receipt", sequence: 1,
    payload: { kind: "reply", rpcId: "node-effect-receipt", ok: true, result: value.result }
  });
  if (!envelope || envelope.payload.kind !== "reply" || !envelope.payload.ok ||
      Buffer.byteLength(stable(envelope.payload.result)) > MAX_RECEIPT_BYTES) fail();
  return { status, result: envelope.payload.result };
}

export function parseNodeEffectReceipt(value: unknown, binding: WorkerBinding): NodeEffectReceipt | undefined {
  try {
    return checkedReceipt(value, binding);
  } catch {
    return undefined;
  }
}

export function nodeEffectUpload(specValue: NodeEffectSpec, receiptValue: NodeEffectReceipt): NodeEffectUpload {
  const spec = checkedSpec(specValue);
  const receipt = checkedReceipt(receiptValue, spec.binding);
  return {
    effectId: digest(spec.binding.agentId + "\0" + spec.taskId),
    receiptHash: digest(stable(receipt)), spec, receipt
  };
}

export function parseNodeEffectUpload(value: unknown): NodeEffectUpload | undefined {
  try {
    if (!exact(value, ["effectId", "receiptHash", "spec", "receipt"])) return undefined;
    const upload = nodeEffectUpload(value.spec as NodeEffectSpec, value.receipt as NodeEffectReceipt);
    return upload.effectId === value.effectId && upload.receiptHash === value.receiptHash ? upload : undefined;
  } catch { return undefined; }
}

/** The owner must hold the node supervisor's exclusive lock. This journal does not authorize or execute effects. */
export class NodeEffectJournal {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS node_effects(
      effect_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, spec_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','executing','succeeded','failed','uncertain')),
      receipt_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS node_effect_upload_acks(
      effect_id TEXT PRIMARY KEY, receipt_hash TEXT NOT NULL, acknowledged_at INTEGER NOT NULL
    )`);
  }

  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT node_effect_journal");
    try {
      const result = fn();
      this.db.exec("RELEASE node_effect_journal");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO node_effect_journal; RELEASE node_effect_journal");
      throw error;
    }
  }

  private durableClaim<T>(fn: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw new NodeEffectError("An external effect requires a committed top-level execution claim", { cause: error });
    }
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private identity(value: unknown): { spec: NodeEffectSpec; id: string; hash: string } {
    const spec = checkedSpec(value);
    return { spec, id: digest(spec.binding.agentId + "\0" + spec.taskId), hash: digest(stable(spec)) };
  }

  private row(id: string): EffectRow | undefined {
    return this.db.prepare("SELECT * FROM node_effects WHERE effect_id=?").get(id) as EffectRow | undefined;
  }

  private matching(id: string, hash: string): EffectRow {
    const row = this.row(id);
    if (!row || row.input_hash !== hash) throw new NodeEffectError("Effect identity is absent or was reused with a different binding or payload");
    return row;
  }

  admit(value: NodeEffectSpec): string {
    const { spec, id, hash } = this.identity(value);
    return this.atomic(() => {
      const prior = this.row(id);
      if (prior) {
        this.matching(id, hash);
        return id;
      }
      const at = Date.now();
      this.db.prepare("INSERT INTO node_effects(effect_id,input_hash,spec_json,state,created_at,updated_at) VALUES(?,?,?,'prepared',?,?)")
        .run(id, hash, stable(spec), at, at);
      return id;
    });
  }

  begin(value: NodeEffectSpec): { execute: true } | { execute: false; receipt: NodeEffectReceipt } {
    const { spec, id, hash } = this.identity(value);
    return this.durableClaim(() => {
      const row = this.matching(id, hash);
      if (row.state === "executing" || row.state === "uncertain") throw new NodeEffectError("Prior effect may have executed; it will not be repeated automatically");
      if (row.state !== "prepared") {
        if (!row.receipt_json) throw new NodeEffectError("Effect receipt is missing");
        return { execute: false, receipt: checkedReceipt(JSON.parse(row.receipt_json), spec.binding) };
      }
      this.db.prepare("UPDATE node_effects SET state='executing',updated_at=? WHERE effect_id=?").run(Date.now(), id);
      return { execute: true };
    });
  }

  complete(value: NodeEffectSpec, receiptValue: NodeEffectReceipt): NodeEffectReceipt {
    const { spec, id, hash } = this.identity(value);
    const receipt = checkedReceipt(receiptValue, spec.binding);
    const encoded = stable(receipt);
    return this.atomic(() => {
      const row = this.matching(id, hash);
      if (row.state !== "executing") {
        if (row.receipt_json === encoded) return receipt;
        throw new NodeEffectError("A node effect needs a live execution claim; terminal or uncertain evidence cannot be replaced");
      }
      this.db.prepare("UPDATE node_effects SET state=?,receipt_json=?,updated_at=? WHERE effect_id=?")
        .run(receipt.status, encoded, Date.now(), id);
      return receipt;
    });
  }

  recover(): void {
    const receipt: NodeEffectReceipt = {
      status: "uncertain",
      error: "Node restarted before the external effect outcome was durably recorded; do not repeat automatically"
    };
    this.db.prepare("UPDATE node_effects SET state='uncertain',receipt_json=?,updated_at=? WHERE state='executing'")
      .run(stable(receipt), Date.now());
  }

  pendingReceipts(limit = 16): NodeEffectUpload[] {
    const rows = this.db.prepare(`SELECT e.* FROM node_effects e
      LEFT JOIN node_effect_upload_acks a ON a.effect_id=e.effect_id
      WHERE e.state IN ('succeeded','failed','uncertain') AND a.effect_id IS NULL
      ORDER BY e.created_at,e.effect_id LIMIT ?`).all(limit) as EffectRow[];
    return rows.map(row => nodeEffectUpload(JSON.parse(row.spec_json), JSON.parse(row.receipt_json!)));
  }

  acknowledgeReceipt(uploadValue: NodeEffectUpload, ack: unknown): void {
    const upload = parseNodeEffectUpload(uploadValue);
    if (!upload || !exact(ack, ["recorded", "duplicate", "effectId", "receiptHash"]) ||
        ack.recorded !== true || typeof ack.duplicate !== "boolean" ||
        ack.effectId !== upload.effectId || ack.receiptHash !== upload.receiptHash) {
      throw new NodeEffectError("Receipt acknowledgement does not match the durable effect");
    }
    this.atomic(() => {
      const { id, hash } = this.identity(upload.spec);
      const row = this.matching(id, hash);
      if (!row.receipt_json || digest(row.receipt_json) !== upload.receiptHash) {
        throw new NodeEffectError("Receipt acknowledgement cannot replace terminal evidence");
      }
      const prior = this.db.prepare("SELECT receipt_hash FROM node_effect_upload_acks WHERE effect_id=?").get(id) as { receipt_hash: string } | undefined;
      if (prior && prior.receipt_hash !== upload.receiptHash) throw new NodeEffectError("Receipt acknowledgement conflicts with prior evidence");
      this.db.prepare("INSERT OR IGNORE INTO node_effect_upload_acks(effect_id,receipt_hash,acknowledged_at) VALUES(?,?,?)")
        .run(id, upload.receiptHash, Date.now());
    });
  }

  inspect(): Array<{ effectId: string; spec: NodeEffectSpec; state: EffectState; receipt: NodeEffectReceipt | null }> {
    return (this.db.prepare("SELECT * FROM node_effects ORDER BY created_at,effect_id").all() as EffectRow[]).map(row => ({
      effectId: row.effect_id, spec: checkedSpec(JSON.parse(row.spec_json)), state: row.state,
      receipt: row.receipt_json ? checkedReceipt(JSON.parse(row.receipt_json), checkedSpec(JSON.parse(row.spec_json)).binding) : null
    }));
  }
}
