import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseWorkerStartSpec, workerStartSpecHash, type WorkerStartSpec } from "./node-worker-spec.js";
import type { WorkerBinding } from "./worker-mailbox.js";

export type RuntimeStopReason = "requested" | "unexpected";
export type RuntimeReport = {
  reportId: string; binding: WorkerBinding; descriptorHash: string; outcome: "stopped" | "uncertain" | "rejected";
  stopReason?: RuntimeStopReason;
};

export type RemoteRuntimeState = "queued" | "offered" | "running" | "stopping" | "closed" | "uncertain";
export type RemoteRuntimeDirective =
  | { action: "start"; descriptor: WorkerStartSpec; descriptorHash: string }
  | { action: "stop"; binding: WorkerBinding; descriptorHash: string };

export type RemoteRuntimeRow = {
  runtime_id: string; machine_id: string; session_id: string; session_epoch: number; agent_id: string; epoch: number;
  descriptor_json: string; descriptor_hash: string; state: RemoteRuntimeState; desired: "run" | "stop";
  stop_provenance: "unproven" | "controlled" | "unexpected" | "uncertain";
  stop_request_reason: "controlled" | "ownership-lost" | null; stop_request_epoch: number | null; stop_fenced_epoch: number | null;
  created_at: number; updated_at: number; last_offered_at: number | null; last_report_json: string | null;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function rowBinding(row: RemoteRuntimeRow): WorkerBinding {
  return { runtimeId: row.runtime_id, machineId: row.machine_id, sessionId: row.session_id, sessionEpoch: row.session_epoch, agentId: row.agent_id, epoch: row.epoch };
}

export class RemoteRuntimeRegistry {
  constructor(private readonly db: DatabaseSync) {}

  static migrate(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS remote_worker_runtimes (
        runtime_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, session_id TEXT NOT NULL, session_epoch INTEGER NOT NULL,
        agent_id TEXT NOT NULL, epoch INTEGER NOT NULL, descriptor_json TEXT NOT NULL, descriptor_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','offered','running','stopping','closed','uncertain')),
        desired TEXT NOT NULL CHECK(desired IN ('run','stop')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_offered_at INTEGER, last_report_json TEXT,
        stop_provenance TEXT NOT NULL DEFAULT 'unproven' CHECK(stop_provenance IN ('unproven','controlled','unexpected','uncertain'))
      );
      CREATE INDEX IF NOT EXISTS remote_worker_runtimes_agent_idx ON remote_worker_runtimes(agent_id,state);
      CREATE INDEX IF NOT EXISTS remote_worker_runtimes_offer_idx ON remote_worker_runtimes(machine_id,state,last_offered_at,created_at);
      CREATE TABLE IF NOT EXISTS remote_worker_runtime_reports (
        report_id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, body_json TEXT NOT NULL, runtime_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const columns = db.prepare("PRAGMA table_info(remote_worker_runtimes)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "stop_provenance")) {
      db.exec("ALTER TABLE remote_worker_runtimes ADD COLUMN stop_provenance TEXT NOT NULL DEFAULT 'unproven' CHECK(stop_provenance IN ('unproven','controlled','unexpected','uncertain'))");
    }
    if (!columns.some((column) => column.name === "stop_request_reason")) {
      db.exec("ALTER TABLE remote_worker_runtimes ADD COLUMN stop_request_reason TEXT CHECK(stop_request_reason IN ('controlled','ownership-lost'))");
    }
    if (!columns.some((column) => column.name === "stop_request_epoch")) {
      db.exec("ALTER TABLE remote_worker_runtimes ADD COLUMN stop_request_epoch INTEGER");
    }
    if (!columns.some((column) => column.name === "stop_fenced_epoch")) {
      db.exec("ALTER TABLE remote_worker_runtimes ADD COLUMN stop_fenced_epoch INTEGER");
    }
    // Schema 9 inferred controlled stops without node evidence. This also
    // stays fail-closed if an earlier migration stopped between column adds.
    db.exec(`UPDATE remote_worker_runtimes SET stop_provenance='unproven' WHERE stop_provenance='controlled'
      AND (stop_request_reason IS NULL OR stop_request_reason!='controlled' OR stop_request_epoch IS NULL OR stop_request_epoch!=epoch)`);
  }

  markControlledStopFence(agentId: string, priorEpoch: number): void {
    this.db.prepare(`UPDATE remote_worker_runtimes SET stop_fenced_epoch=?
      WHERE agent_id=? AND epoch=? AND stop_request_epoch=? AND stop_request_reason='controlled'
        AND desired='stop' AND state='stopping' AND stop_fenced_epoch IS NULL`)
      .run(priorEpoch + 1, agentId, priorEpoch, priorEpoch);
  }

  activeForAgent(agentId: string): RemoteRuntimeRow | undefined {
    return this.db.prepare("SELECT * FROM remote_worker_runtimes WHERE agent_id=? AND state IN ('queued','offered','running','stopping','uncertain') ORDER BY epoch DESC,created_at DESC LIMIT 1")
      .get(agentId) as RemoteRuntimeRow | undefined;
  }

  byAgent(agentId: string): RemoteRuntimeRow | undefined {
    return this.db.prepare("SELECT * FROM remote_worker_runtimes WHERE agent_id=? ORDER BY epoch DESC,created_at DESC LIMIT 1").get(agentId) as RemoteRuntimeRow | undefined;
  }

  byRuntime(runtimeId: string): RemoteRuntimeRow | undefined {
    return this.db.prepare("SELECT * FROM remote_worker_runtimes WHERE runtime_id=?").get(runtimeId) as RemoteRuntimeRow | undefined;
  }

  assign(specValue: unknown): { binding: WorkerBinding; descriptor: WorkerStartSpec; descriptorHash: string; existing: boolean } {
    const descriptor = parseWorkerStartSpec(specValue);
    const binding = descriptor.binding;
    const descriptorHash = workerStartSpecHash(descriptor);
    const active = this.activeForAgent(binding.agentId);
    if (active) {
      if (active.state === "uncertain" || active.state === "stopping") {
        throw new Error("An unresolved remote runtime binding requires trusted reconciliation");
      }
      if (active.descriptor_hash !== descriptorHash || stable(rowBinding(active)) !== stable(binding)) {
        throw new Error("An unresolved remote runtime binding already owns this agent");
      }
      return { binding, descriptor, descriptorHash, existing: true };
    }
    const existingBinding = this.db.prepare("SELECT status FROM worker_mailbox_bindings WHERE runtime_id=?").get(binding.runtimeId) as { status: string } | undefined;
    if (existingBinding) throw new Error("Remote runtime mailbox binding already exists");
    const at = Date.now();
    this.db.prepare(`INSERT INTO remote_worker_runtimes(runtime_id,machine_id,session_id,session_epoch,agent_id,epoch,
      descriptor_json,descriptor_hash,state,desired,created_at,updated_at,last_offered_at,last_report_json)
      VALUES(?,?,?,?,?,?,?,?,'queued','run',?,?,NULL,NULL)`)
      .run(binding.runtimeId, binding.machineId, binding.sessionId, binding.sessionEpoch, binding.agentId, binding.epoch,
        stable(descriptor), descriptorHash, at, at);
    return { binding, descriptor, descriptorHash, existing: false };
  }

  poll(machineId: string, sessionId: string, sessionEpoch: number, stopRuntimeId?: string): RemoteRuntimeDirective[] {
    const rows = this.db.prepare(`SELECT * FROM remote_worker_runtimes
      WHERE machine_id=? AND (
        (desired='run' AND state IN ('queued','offered') AND session_id=? AND session_epoch=?) OR
        (desired='stop' AND state IN ('stopping','offered','uncertain'))
      ) AND (? IS NULL OR (runtime_id=? AND desired='stop')) ORDER BY COALESCE(last_offered_at,0),created_at,runtime_id LIMIT 1`)
      .all(machineId, sessionId, sessionEpoch, stopRuntimeId ?? null, stopRuntimeId ?? null) as RemoteRuntimeRow[];
    const row = rows[0];
    if (!row) return [];
    const at = Date.now();
    this.db.prepare("UPDATE remote_worker_runtimes SET state=CASE WHEN desired='run' THEN 'offered' ELSE state END,last_offered_at=?,updated_at=? WHERE runtime_id=?")
      .run(at, at, row.runtime_id);
    if (row.desired === "stop") return [{ action: "stop", binding: rowBinding(row), descriptorHash: row.descriptor_hash }];
    return [{ action: "start", descriptor: parseWorkerStartSpec(JSON.parse(row.descriptor_json)), descriptorHash: row.descriptor_hash }];
  }

  setRunning(binding: WorkerBinding, descriptorHash: string): boolean {
    const result = this.db.prepare(`UPDATE remote_worker_runtimes SET state='running',updated_at=?
      WHERE runtime_id=? AND machine_id=? AND session_id=? AND session_epoch=? AND agent_id=? AND epoch=?
        AND descriptor_hash=? AND desired='run' AND state IN ('queued','offered','running')`)
      .run(Date.now(), binding.runtimeId, binding.machineId, binding.sessionId, binding.sessionEpoch, binding.agentId, binding.epoch, descriptorHash);
    return result.changes === 1;
  }

  markReady(binding: WorkerBinding): boolean {
    const row = this.db.prepare("SELECT descriptor_hash FROM remote_worker_runtimes WHERE runtime_id=? AND machine_id=? AND session_id=? AND session_epoch=? AND agent_id=? AND epoch=?")
      .get(binding.runtimeId, binding.machineId, binding.sessionId, binding.sessionEpoch, binding.agentId, binding.epoch) as { descriptor_hash: string } | undefined;
    return row ? this.setRunning(binding, row.descriptor_hash) : false;
  }

  requestStop(binding: WorkerBinding, reason: "controlled" | "ownership-lost", requestEpoch: number | null = null): boolean {
    const result = this.db.prepare(`UPDATE remote_worker_runtimes SET desired='stop',
      state=CASE WHEN state IN ('closed','uncertain') THEN state ELSE 'stopping' END,updated_at=?,
      stop_request_reason=CASE WHEN ?='ownership-lost' THEN 'ownership-lost' ELSE COALESCE(stop_request_reason,?) END,
      stop_request_epoch=COALESCE(stop_request_epoch,?),
      stop_provenance=CASE WHEN ?='ownership-lost' THEN 'uncertain' ELSE stop_provenance END
      WHERE runtime_id=? AND machine_id=? AND session_id=? AND session_epoch=? AND agent_id=? AND epoch=?
        AND (state!='closed' OR ?='ownership-lost')`)
      .run(Date.now(), reason, reason, requestEpoch, reason, binding.runtimeId, binding.machineId, binding.sessionId, binding.sessionEpoch, binding.agentId, binding.epoch, reason);
    return result.changes === 1;
  }

  report(report: RuntimeReport): {
    recorded: true; duplicate: boolean; state: RemoteRuntimeState; unexpected: boolean
  } {
    const body = stable(report);
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const prior = this.db.prepare("SELECT body_hash,runtime_id FROM remote_worker_runtime_reports WHERE report_id=?").get(report.reportId) as { body_hash: string; runtime_id: string } | undefined;
    if (prior) {
      if (prior.body_hash !== bodyHash) throw new Error("Runtime report ID was reused with different content");
      const row = this.db.prepare("SELECT state FROM remote_worker_runtimes WHERE runtime_id=?").get(prior.runtime_id) as { state: RemoteRuntimeState } | undefined;
      return { recorded: true, duplicate: true, state: row?.state ?? "uncertain", unexpected: false };
    }
    const b = report.binding;
    const row = this.db.prepare("SELECT * FROM remote_worker_runtimes WHERE runtime_id=?").get(b.runtimeId) as RemoteRuntimeRow | undefined;
    if (!row || row.machine_id !== b.machineId || row.session_id !== b.sessionId || row.session_epoch !== b.sessionEpoch ||
        row.agent_id !== b.agentId || row.epoch !== b.epoch || row.descriptor_hash !== report.descriptorHash) {
      throw new Error("Runtime report does not match its assignment");
    }
    const controlledRequest = row.desired === "stop" && row.stop_request_reason === "controlled" && row.stop_request_epoch === row.epoch;
    // A later stop request/report cannot erase an unsafe first ending.
    const provenance = row.stop_provenance === "unexpected" || row.stop_provenance === "uncertain" ? row.stop_provenance
      : report.stopReason === "unexpected" ? "unexpected"
      : report.outcome !== "stopped" ? "uncertain"
      : row.last_report_json === null && row.state === "stopping" && controlledRequest && report.stopReason === "requested" ? "controlled"
      : row.stop_provenance === "controlled" && controlledRequest && report.stopReason === "requested" ? "controlled" : "unproven";
    const unexpected = row.desired === "run" || provenance === "unexpected";
    const nextState: RemoteRuntimeState = report.outcome === "stopped" ? "closed" : "uncertain";
    const state: RemoteRuntimeState = row.state === "closed" ? "closed" : nextState;
    const at = Date.now();
    this.db.prepare("INSERT INTO remote_worker_runtime_reports(report_id,body_hash,body_json,runtime_id,created_at) VALUES(?,?,?,?,?)")
      .run(report.reportId, bodyHash, body, b.runtimeId, at);
    this.db.prepare(`UPDATE remote_worker_runtimes SET state=?,desired='stop',updated_at=?,stop_provenance=?,
      last_report_json=CASE WHEN state='closed' AND ?!='stopped' THEN last_report_json ELSE ? END
      WHERE runtime_id=?`)
      .run(state, at, provenance, report.outcome, body, b.runtimeId);
    return { recorded: true, duplicate: false, state, unexpected };
  }

  snapshots(missionId: string): Array<Record<string, unknown>> {
    return (this.db.prepare(`SELECT r.* FROM remote_worker_runtimes r JOIN agents a ON a.id=r.agent_id
      WHERE a.mission_id=? ORDER BY r.created_at,r.runtime_id`).all(missionId) as RemoteRuntimeRow[]).map((row) => ({
      binding: rowBinding(row), descriptorHash: row.descriptor_hash, state: row.state, desired: row.desired,
      stopProvenance: row.stop_provenance, stopRequestReason: row.stop_request_reason, createdAt: row.created_at, updatedAt: row.updated_at, lastOfferedAt: row.last_offered_at,
      report: row.last_report_json ? JSON.parse(row.last_report_json) as { outcome: string } : undefined
    }));
  }
}
