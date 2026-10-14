import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DurableWorkerMailbox, parseWorkerBinding, parseWorkerEnvelope, type JsonValue, type WorkerBinding, type WorkerEnvelope
} from "./worker-mailbox.js";
import { parseWorkerNotice, type WorkerNotice } from "./worker-events.js";
import {
  NodeEffectJournal, type NodeEffectReceipt, type NodeEffectSpec, type NodeEffectUpload
} from "./node-effects.js";
import { abortNodeEffect, executeNodeEffect, nodeEffectExtinct, readNodeArtifactChunk, snapshotNodeArtifact, verifyNodeArtifactSnapshot, type NodeArtifactSnapshot } from "./node-effect-executor.js";
import type { RuntimeStopReason } from "./remote-runtimes.js";
import type { RemoteArtifactManifest } from "./remote-artifacts.js";
import { REMOTE_EFFECT_METHODS } from "./remote-rpc-methods.js";
import { redactDiagnosticChunk, sanitizeDiagnostic } from "./workers.js";
import {
  isReservedCredentialEnvironmentName, parseWorkerStartSpec, workerStartSpecHash, RESERVED_ENVIRONMENT_NAMES,
  type WorkerStartSpec
} from "./node-worker-spec.js";

export type NodeWorkerState = "admitted" | "running" | "stopping" | "closed" | "uncertain";

export interface NodeWorkerSnapshot {
  runtimeId: string;
  agentId: string;
  epoch: number;
  descriptorHash: string;
  workspacePath: string;
  state: NodeWorkerState;
  pid: number | null;
  confirmedStopped: boolean;
  stopReason: RuntimeStopReason | null;
  live: boolean;
  diagnostic?: string;
}

export interface NodeWorkerStopEvidence {
  runtimeId: string;
  state: "closed" | "uncertain";
  confirmedStopped: boolean;
  stopReason: RuntimeStopReason | null;
  pid: number | null;
  reason: string;
}

export interface NodeWorkerSupervisorOptions {
  home: string;
  machineId: string;
  sessionId: string;
  sessionEpoch: number;
  roots: string[];
  credentialRefs: string[];
  forbiddenCredentialRefs?: string[];
  executionEnabled?: boolean;
  executionMode?: "metadata-only" | "workspace-effects";
  effectApprovals?: boolean;
  isLeaseCurrent: (binding: WorkerBinding) => boolean;
  onMailboxActivity?: () => void;
  testOnlyScripted?: boolean;
  testOnlyToolLoop?: boolean;
  testOnlyWorkspaceEffectLoop?: boolean;
  testOnlyArtifactTransferLoop?: boolean;
  testOnlyArtifactTaskId?: string;
  artifactTransfers?: boolean;
  uploadArtifact?: (input: {
    spec: NodeEffectSpec;
    manifest: RemoteArtifactManifest;
    readChunk: (offset: number, length: number) => Buffer;
    verifySnapshot: () => void;
  }) => Promise<JsonValue>;
}

export class NodeWorkerError extends Error {}

type RuntimeRow = {
  runtime_id: string;
  agent_id: string;
  epoch: number;
  binding_json: string;
  descriptor_hash: string;
  workspace_path: string;
  state: NodeWorkerState;
  pid: number | null;
  confirmed_stopped: number;
  stop_reason: RuntimeStopReason | null;
};

type DeliveryKey = string;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

type Handle = {
  binding: WorkerBinding;
  descriptorHash: string;
  workspacePath: string;
  child: ChildProcess;
  token: string;
  secret: string | undefined;
  pid: number;
  ready: Promise<void>;
  pendingRpc: Set<string>;
  pendingEffects: Map<string, { taskId: string; method: "read_file" | "write_file" | "bash" | "PublishArtifact"; args: { [key: string]: JsonValue } }>;
  effectApprovals: boolean;
  artifactTransfers: boolean;
  completedEffects: Map<string, { identity: string; receipt: string; expiresAt: number }>;
  pendingDeliveries: Map<DeliveryKey, string>;
  pendingAbort: string | undefined;
  exitObserved: Promise<void>;
  exited: boolean;
  stopping: Promise<NodeWorkerStopEvidence> | undefined;
};

const START_TIMEOUT_MS = 30000;
const WATCHDOG_INTERVAL_MS = 250;
const STOP_GRACE_MS = 3000;
const STOP_KILL_MS = 2000;
const MAX_PUMP_CLAIMS = 16;

function deliveryKey(messageId: string, requestId: string, attempt: number): DeliveryKey {
  return JSON.stringify([messageId, requestId, attempt]);
}

function canonicalDirectory(path: string, label: string): string {
  let real: string;
  try {
    real = realpathSync(resolve(path));
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new NodeWorkerError(`${label} is not an existing directory`);
  }
  return real;
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitForExitOrTimeout(childExit: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      childExit,
      new Promise<void>((done) => { timer = setTimeout(done, timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function redactExact(value: string, secret: string | undefined, token: string, additional: readonly string[] = []): string {
  const privateValues = [secret, token, ...additional]
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .sort((left, right) => right.length - left.length);
  let result = value;
  for (const privateValue of privateValues) result = result.split(privateValue).join("[REDACTED]");
  return result;
}

function safeDiagnostic(value: unknown, secret: string | undefined, token: string, additional: readonly string[] = []): string {
  const text = value instanceof Error ? value.message : String(value);
  return sanitizeDiagnostic(redactExact(text, secret, token, additional));
}

/**
 * Standalone node-local supervisor for real worker child processes. It owns
 * its own durable journal and mailbox; it is not wired into the node CLI or
 * the shipped node protocol, performs no filesystem, shell, MCP or Git
 * effects, and never claims a process group stopped without kill(-pid,0)
 * evidence.
 */
export class NodeWorkerSupervisor {
  readonly mailbox: DurableWorkerMailbox;
  private readonly db!: DatabaseSync;
  private readonly lockDb!: DatabaseSync;
  private readonly home: string;
  private readonly roots: string[];
  private readonly credentialRefs: Set<string>;
  private readonly forbidden: Set<string>;
  private readonly redactionValues: string[];
  private readonly handles = new Map<string, Handle>();
  private readonly flights = new Map<string, { hash: string; promise: Promise<NodeWorkerSnapshot> }>();
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly diagnostics = new Map<string, string>();
  private readonly watchdog: NodeJS.Timeout;
  private readonly effects!: NodeEffectJournal;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: NodeWorkerSupervisorOptions) {
    if (!options.machineId || !options.sessionId) throw new NodeWorkerError("Supervisor machine and session identity are required");
    if (!Number.isSafeInteger(options.sessionEpoch) || options.sessionEpoch <= 0) {
      throw new NodeWorkerError("Supervisor session epoch must be a positive integer");
    }
    if (typeof options.isLeaseCurrent !== "function") throw new NodeWorkerError("Supervisor requires a lease predicate");
    mkdirSync(options.home, { recursive: true, mode: 0o700 });
    this.home = canonicalDirectory(resolve(options.home), "Supervisor home");
    chmodSync(this.home, 0o700);
    if (options.roots.length === 0) throw new NodeWorkerError("Supervisor requires at least one declared root");
    this.roots = options.roots.map((root) => canonicalDirectory(resolve(root), "Declared root"));
    this.credentialRefs = new Set(options.credentialRefs);
    this.forbidden = new Set([...(options.forbiddenCredentialRefs ?? []), ...RESERVED_ENVIRONMENT_NAMES]);
    this.redactionValues = [...new Set([
      ...options.credentialRefs,
      ...(options.forbiddenCredentialRefs ?? [])
    ])]
      .filter((name) => !RESERVED_ENVIRONMENT_NAMES.includes(name))
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value));
    for (const ref of this.credentialRefs) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new NodeWorkerError("Allowed credential reference names must be environment variable names");
      if (this.forbidden.has(ref) || isReservedCredentialEnvironmentName(ref)) {
        throw new NodeWorkerError(`Credential reference ${ref} is reserved or forbidden`);
      }
    }
    mkdirSync(join(this.home, "agents"), { recursive: true, mode: 0o700 });
    chmodSync(join(this.home, "agents"), 0o700);
    this.lockDb = new DatabaseSync(join(this.home, "node-workers.ownership.sqlite"));
    try {
      this.lockDb.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL");
      this.lockDb.exec("CREATE TABLE IF NOT EXISTS node_worker_ownership(singleton INTEGER PRIMARY KEY CHECK(singleton=1))");
      this.lockDb.exec("BEGIN EXCLUSIVE");
      chmodSync(join(this.home, "node-workers.ownership.sqlite"), 0o600);
    } catch (error) {
      this.lockDb.close();
      throw new NodeWorkerError(`Another node worker supervisor already owns ${this.home}: ${sanitizeDiagnostic(error)}`);
    }
    try {
      this.db = new DatabaseSync(join(this.home, "node-workers.sqlite"));
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
      chmodSync(join(this.home, "node-workers.sqlite"), 0o600);
      try { chmodSync(join(this.home, "node-workers.sqlite-wal"), 0o600); } catch { /* WAL is created by the first write */ }
      this.db.exec(`CREATE TABLE IF NOT EXISTS node_worker_runtimes(
        runtime_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        binding_json TEXT NOT NULL,
        descriptor_hash TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('admitted','running','stopping','closed','uncertain')),
        pid INTEGER,
        confirmed_stopped INTEGER NOT NULL DEFAULT 0
      )`);
      const runtimeColumns = this.db.prepare("PRAGMA table_info(node_worker_runtimes)").all() as Array<{ name: string }>;
      if (!runtimeColumns.some((column) => column.name === "stop_reason")) {
        this.db.exec("ALTER TABLE node_worker_runtimes ADD COLUMN stop_reason TEXT CHECK(stop_reason IN ('requested','unexpected'))");
      }
      this.mailbox = new DurableWorkerMailbox(this.db, "node");
      this.db.exec(`CREATE TABLE IF NOT EXISTS node_effect_approvals(
        approval_id TEXT PRIMARY KEY, spec_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS node_effect_approval_replies(
        rpc_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, result_json TEXT NOT NULL
      )`);
      this.effects = new NodeEffectJournal(this.db);
      this.effects.recover();
      this.recover();
    } catch (error) {
      try { this.db?.close(); } catch { /* preserve the setup error */ }
      try { this.lockDb.exec("ROLLBACK"); } catch { /* keep the original failure */ }
      this.lockDb.close();
      throw error;
    }
    this.watchdog = setInterval(() => this.sweep(), WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
  }

  /**
   * Prior live records survive as uncertain evidence: a restart never kills a
   * possibly reused PID, never resumes, and never forks a replacement.
   */
  private recover(): void {
    const rows = this.db.prepare(
      "SELECT * FROM node_worker_runtimes WHERE state IN ('admitted','running','stopping')"
    ).all() as unknown as RuntimeRow[];
    for (const row of rows) {
      this.db.prepare("UPDATE node_worker_runtimes SET state='uncertain' WHERE runtime_id=?").run(row.runtime_id);
    }
    this.mailbox.recover();
  }

  private leaseCurrent(binding: WorkerBinding): boolean {
    try {
      return this.options.isLeaseCurrent(binding) === true;
    } catch {
      return false;
    }
  }

  private row(runtimeId: string): RuntimeRow | undefined {
    return this.db.prepare("SELECT * FROM node_worker_runtimes WHERE runtime_id=?").get(runtimeId) as unknown as RuntimeRow | undefined;
  }

  private snapshotOf(row: RuntimeRow): NodeWorkerSnapshot {
    const diagnostic = this.diagnostics.get(row.runtime_id);
    return {
      runtimeId: row.runtime_id,
      agentId: row.agent_id,
      epoch: row.epoch,
      descriptorHash: row.descriptor_hash,
      workspacePath: row.workspace_path,
      state: row.state,
      pid: row.pid,
      confirmedStopped: row.confirmed_stopped === 1,
      stopReason: row.stop_reason,
      live: this.handles.has(row.runtime_id),
      ...(diagnostic === undefined ? {} : { diagnostic })
    };
  }

  inspect(): readonly NodeWorkerSnapshot[] {
    const rows = this.db.prepare("SELECT * FROM node_worker_runtimes ORDER BY runtime_id").all() as unknown as RuntimeRow[];
    return rows.map((row) => this.snapshotOf(row));
  }

  inspectBindings(): Array<{ binding: WorkerBinding; descriptorHash: string; state: NodeWorkerState; confirmedStopped: boolean; stopReason: RuntimeStopReason | null }> {
    return (this.db.prepare("SELECT binding_json,descriptor_hash,state,confirmed_stopped,stop_reason FROM node_worker_runtimes ORDER BY rowid").all() as Array<{
      binding_json: string; descriptor_hash: string; state: NodeWorkerState; confirmed_stopped: number; stop_reason: RuntimeStopReason | null;
    }>).map((row) => ({
      binding: JSON.parse(row.binding_json) as WorkerBinding, descriptorHash: row.descriptor_hash,
      state: row.state, confirmedStopped: row.confirmed_stopped === 1, stopReason: row.stop_reason
    }));
  }

  pendingEffectReceipts(limit = 16): NodeEffectUpload[] {
    return this.effects.pendingReceipts(Math.min(16, Math.max(1, Math.floor(limit))));
  }

  acknowledgeEffectReceipt(upload: NodeEffectUpload, ack: unknown): void {
    this.effects.acknowledgeReceipt(upload, ack);
  }

  private note(runtimeId: string, text: string): void {
    this.diagnostics.set(runtimeId, text.slice(-1000));
  }

  private durablePath(agentId: string): string {
    return join(this.home, "agents", `${createHash("sha256").update(agentId, "utf8").digest("hex")}.sqlite`);
  }

  private resolveCredential(name: string): string | undefined {
    if (!name) return undefined;
    if (this.forbidden.has(name) || isReservedCredentialEnvironmentName(name)) {
      throw new NodeWorkerError("Descriptor credential reference is reserved or forbidden");
    }
    if (!this.credentialRefs.has(name)) throw new NodeWorkerError("Descriptor credential reference is not in the node allow-list");
    const value = process.env[name];
    if (!value) throw new NodeWorkerError("Declared model credential is not available on this node");
    return value;
  }

  async start(raw: unknown, options: { coordinatorAssigned?: boolean } = {}): Promise<NodeWorkerSnapshot> {
    if (this.closed) throw new NodeWorkerError("Supervisor is closed");
    if (this.options.executionEnabled !== true) {
      throw new NodeWorkerError("Node worker execution is not enabled on this supervisor");
    }
    const spec = parseWorkerStartSpec(raw);
    const hash = workerStartSpecHash(spec);
    const binding = spec.binding;
    if (
      binding.machineId !== this.options.machineId
      || binding.sessionId !== this.options.sessionId
      || binding.sessionEpoch !== this.options.sessionEpoch
    ) throw new NodeWorkerError("Descriptor binding does not match this node session");
    const flight = this.flights.get(binding.runtimeId);
    if (flight) {
      if (flight.hash !== hash) throw new NodeWorkerError("A different descriptor is already starting for this runtime");
      return flight.promise;
    }
    const live = this.handles.get(binding.runtimeId);
    if (live) {
      if (live.descriptorHash !== hash) throw new NodeWorkerError("A different descriptor is already running for this runtime");
      const row = this.row(binding.runtimeId);
      if (!row) throw new NodeWorkerError("Live runtime has no durable record");
      return this.snapshotOf(row);
    }
    const existing = this.row(binding.runtimeId);
    if (existing) {
      throw new NodeWorkerError(`Runtime ${binding.runtimeId} already has ${existing.state} evidence; explicit reconciliation is required before a replacement`);
    }
    if (this.db.prepare("SELECT 1 FROM node_worker_runtimes WHERE agent_id=? AND state IN ('admitted','running','stopping','uncertain') LIMIT 1").get(spec.binding.agentId)) {
      throw new NodeWorkerError("This agent still has unreconciled node runtime evidence");
    }
    const promise = this.startOnce(spec, hash, options.coordinatorAssigned === true).finally(() => this.flights.delete(binding.runtimeId));
    this.flights.set(binding.runtimeId, { hash, promise });
    return promise;
  }

  private closeStoppedMailboxesForAssignment(binding: WorkerBinding): void {
    const previous = this.db.prepare("SELECT * FROM node_worker_runtimes WHERE agent_id=?")
      .all(binding.agentId) as unknown as RuntimeRow[];
    for (const row of previous) {
      const oldBinding = parseWorkerBinding(JSON.parse(row.binding_json));
      if (!oldBinding || row.state !== "closed" || row.confirmed_stopped !== 1 || row.epoch >= binding.epoch ||
          oldBinding.machineId !== binding.machineId) {
        throw new NodeWorkerError("Prior node runtime has no confirmed stop for this agent epoch");
      }
      const status = this.mailbox.inspectBinding(oldBinding).status;
      if (status === "closed") continue;
      if (status !== "uncertain" ||
          this.mailbox.inspectOutbox(oldBinding).some(item => !["acknowledged", "cancelled"].includes(item.status)) ||
          this.mailbox.inspectInbox(oldBinding).some(item => !["applied", "cancelled"].includes(item.status))) {
        throw new NodeWorkerError("Prior node mailbox has unacknowledged or uncertain work");
      }
      if (this.effects.inspect().some(item => item.spec.binding.runtimeId === row.runtime_id &&
          (!item.receipt || item.state === "prepared" || item.state === "executing" || item.receipt.status === "uncertain"))) {
        throw new NodeWorkerError("Prior node runtime has missing or uncertain workspace effect receipts");
      }
      // The authenticated coordinator's new assignment has already passed its
      // persisted controlled-stop gate. Local evidence must also be settled.
      this.mailbox.confirmClosed(oldBinding);
    }
  }

  private async startOnce(spec: WorkerStartSpec, hash: string, coordinatorAssigned: boolean): Promise<NodeWorkerSnapshot> {
    const binding = spec.binding;
    if (spec.effects && this.options.executionMode !== "workspace-effects") {
      throw new NodeWorkerError("Workspace effects are not enabled for this node session");
    }
    if (spec.effectApprovals && (spec.effects !== true || this.options.effectApprovals !== true)) {
      throw new NodeWorkerError("Remote effect approvals are not enabled for this node session");
    }
    if (spec.artifactTransfers && (spec.effects !== true || this.options.artifactTransfers !== true)) {
      throw new NodeWorkerError("Remote artifact transfers are not enabled for this node session");
    }
    if (!this.leaseCurrent(binding)) throw new NodeWorkerError("Node lease is not current for this binding");
    const workspace = canonicalDirectory(spec.workspacePath, "Workspace path");
    if (!this.roots.some((root) => within(root, workspace))) {
      throw new NodeWorkerError("Workspace path is not inside a declared node root");
    }
    const secret = this.resolveCredential(spec.profile.credentialEnv);
    const token = randomBytes(32).toString("hex");
    const config = {
      agentId: binding.agentId,
      missionId: spec.missionId,
      epoch: binding.epoch,
      token,
      durablePath: this.durablePath(binding.agentId),
      workspacePath: workspace,
      workspaceStrategy: "shared" as const,
      profile: spec.profile,
      role: spec.role,
      runtimeMode: spec.effects ? "remote-workspace-effects" as const : "remote-metadata-only" as const,
      ...(spec.effectApprovals ? { effectApprovals: true as const } : {}),
      ...(spec.artifactTransfers ? { artifactTransfers: true as const } : {}),
      ...(this.options.testOnlyScripted ? { testOnlyScripted: true } : {}),
      ...(this.options.testOnlyToolLoop ? { testOnlyToolLoop: true } : {}),
      ...(this.options.testOnlyWorkspaceEffectLoop ? { testOnlyWorkspaceEffectLoop: true } : {}),
      ...(this.options.testOnlyArtifactTransferLoop ? {
        testOnlyArtifactTransferLoop: true,
        ...(this.options.testOnlyArtifactTaskId ? { testOnlyArtifactTaskId: this.options.testOnlyArtifactTaskId } : {})
      } : {})
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (coordinatorAssigned) this.closeStoppedMailboxesForAssignment(binding);
      const mailboxStatus = this.mailbox.open(binding);
      if (mailboxStatus.status !== "open") throw new NodeWorkerError("Mailbox binding is not open for a new worker");
      this.db.prepare(
        "INSERT INTO node_worker_runtimes(runtime_id,agent_id,epoch,binding_json,descriptor_hash,workspace_path,state,pid,confirmed_stopped) VALUES(?,?,?,?,?,?,'admitted',NULL,0)"
      ).run(binding.runtimeId, binding.agentId, binding.epoch, JSON.stringify(binding), hash, workspace);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve admission failure */ }
      throw error;
    }
    try { chmodSync(join(this.home, "node-workers.sqlite-wal"), 0o600); } catch { /* the database may remain checkpointed */ }
    if (!this.leaseCurrent(binding)) {
      this.fenceRuntime(binding, "Node lease was lost before the worker was forked");
      throw new NodeWorkerError("Node lease is not current for this binding");
    }
    let child: ChildProcess;
    try {
      child = fork(new URL("./worker.js", import.meta.url), [], {
        cwd: workspace,
        env: this.childEnvironment(spec.profile.credentialEnv, secret, Buffer.from(JSON.stringify(config)).toString("base64")),
        execArgv: [],
        detached: true,
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      });
    } catch {
      this.fenceRuntime(binding, "Worker process could not be started");
      throw new NodeWorkerError("Worker process could not be started");
    }
    const handleRef: { current: Handle | undefined } = { current: undefined };
    let didExit = false;
    let resolveExit!: () => void;
    const exitObserved = new Promise<void>((done) => { resolveExit = done; });
    const cleanupFailedChild = (): void => {
      child.removeAllListeners("error");
      child.on("error", () => undefined);
      child.removeAllListeners("disconnect");
      child.removeAllListeners("message");
      child.stderr?.destroy();
      if (child.connected) {
        try { child.disconnect(); } catch { /* failed children may already be disconnected */ }
      }
    };
    child.on("error", (error: Error) => {
      const activeHandle = handleRef.current;
      if (!activeHandle) {
        this.note(binding.runtimeId, safeDiagnostic(error, secret, token, this.redactionValues));
        if (!this.closed) this.fenceRuntime(binding, "Worker process failed before ownership was established");
        cleanupFailedChild();
        return;
      }
      this.note(binding.runtimeId, this.safeText(activeHandle, error));
      void this.stopHandle(activeHandle, "Worker process emitted an error").catch(() => undefined);
    });
    child.on("disconnect", () => {
      const activeHandle = handleRef.current;
      if (!activeHandle) {
        if (!this.closed) this.fenceRuntime(binding, "Worker IPC disconnected before ownership was established");
        cleanupFailedChild();
        return;
      }
      this.note(binding.runtimeId, "Worker IPC channel disconnected");
      void this.stopHandle(activeHandle, "Worker IPC channel disconnected").catch(() => undefined);
    });
    child.once("exit", (code, signal) => {
      didExit = true;
      resolveExit();
      const activeHandle = handleRef.current;
      if (!activeHandle) {
        if (!this.closed) this.fenceRuntime(binding, "Worker exited before ownership was established");
        cleanupFailedChild();
        return;
      }
      activeHandle.exited = true;
      if (!activeHandle.stopping) {
        void this.stopHandle(activeHandle, `Worker process exited (${code ?? signal ?? "unknown"})`).catch(() => undefined);
      }
    });
    const pid = child.pid;
    if (pid === undefined) {
      this.fenceRuntime(binding, "Worker process could not be started");
      throw new NodeWorkerError("Worker process could not be started");
    }
    const handle: Handle = {
      binding, descriptorHash: hash, workspacePath: workspace, child, token, secret, pid,
      ready: Promise.resolve(),
      pendingRpc: new Set(),
      pendingEffects: new Map(),
      effectApprovals: spec.effectApprovals === true,
      artifactTransfers: spec.artifactTransfers === true,
      completedEffects: new Map(),
      pendingDeliveries: new Map(),
      pendingAbort: undefined,
      exitObserved,
      exited: didExit,
      stopping: undefined
    };
    handleRef.current = handle;
    this.handles.set(binding.runtimeId, handle);
    this.attachStderr(handle);
    handle.ready = this.readiness(handle);
    try {
      this.db.prepare("UPDATE node_worker_runtimes SET state='running',pid=? WHERE runtime_id=?").run(pid, binding.runtimeId);
      try { chmodSync(join(this.home, "node-workers.sqlite-wal"), 0o600); } catch { /* WAL may be checkpointed */ }
      await handle.ready;
    } catch (error) {
      const reason = this.safeText(handle, error);
      await this.stopHandle(handle, reason);
      this.db.prepare("UPDATE node_worker_runtimes SET state='uncertain' WHERE runtime_id=?").run(binding.runtimeId);
      throw new NodeWorkerError(`Worker start did not reach readiness: ${reason}`);
    }
    const row = this.row(binding.runtimeId);
    if (!row) throw new NodeWorkerError("Durable runtime record disappeared during start");
    return this.snapshotOf(row);
  }

  private childEnvironment(credentialEnv: string, secret: string | undefined, config: string): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG"]) {
      const value = process.env[key];
      if (value) environment[key] = value;
    }
    if (credentialEnv && secret) environment[credentialEnv] = secret;
    environment.MC_WORKER_CONFIG = config;
    return environment;
  }

  private safeText(handle: Handle, value: unknown): string {
    return safeDiagnostic(value, handle.secret, handle.token, this.redactionValues);
  }

  private attachStderr(handle: Handle): void {
    const stages = [...new Set(
      [handle.secret, handle.token, ...this.redactionValues]
        .filter((value): value is string => Boolean(value))
    )]
      .sort((left, right) => right.length - left.length)
      .map((value) => ({ value, pending: "" }));
    const append = (chunk: string, final = false): void => {
      let output = chunk;
      for (const stage of stages) {
        const redacted = redactDiagnosticChunk(stage.pending, output, stage.value, final);
        stage.pending = redacted.pending;
        output = redacted.complete;
      }
      if (output) this.note(handle.binding.runtimeId, sanitizeDiagnostic(output));
    };
    handle.child.stderr?.on("data", (chunk: Buffer) => {
      append(chunk.toString("utf8"));
    });
    handle.child.once("exit", () => {
      append("", true);
    });
  }

  /** Only the child's own ready notice proves readiness; a successful fork does not. */
  private readiness(handle: Handle): Promise<void> {
    return new Promise<void>((done, failed) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        failed(new Error("Worker startup timed out"));
      }, START_TIMEOUT_MS);
      timer.unref?.();
      handle.child.on("message", (raw: unknown) => {
        try {
          const applied = this.onChildMessage(handle, raw);
          if (applied === "ready" && !settled) {
            settled = true;
            clearTimeout(timer);
            done();
          }
        } catch (error) {
          const reason = this.safeText(handle, error);
          this.note(handle.binding.runtimeId, reason);
          void this.stopHandle(handle, "Worker IPC traffic could not be persisted").catch(() => undefined);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            failed(new Error(reason));
          }
        }
      });
      handle.child.on("error", (error: Error) => {
        this.note(handle.binding.runtimeId, this.safeText(handle, error));
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        failed(error);
      });
      handle.child.once("disconnect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        failed(new Error("Worker IPC disconnected before readiness"));
      });
      handle.child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        failed(new Error(`Worker exited before readiness (${code ?? "signal"})`));
      });
    });
  }

  private onChildMessage(handle: Handle, raw: unknown): "ready" | "other" {
    if (!this.handles.get(handle.binding.runtimeId)) return "other";
    if (!this.leaseCurrent(handle.binding)) {
      void this.stopHandle(handle, "Node lease was lost while receiving worker IPC").catch(() => undefined);
      return "other";
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { type?: unknown }).type === "rpc") {
      this.onChildRpc(handle, raw as Record<string, unknown>);
      return "other";
    }
    const notice = parseWorkerNotice(raw);
    if (!notice) return "other";
    if (notice.agentId !== handle.binding.agentId || notice.epoch !== handle.binding.epoch) return "other";
    this.onChildNotice(handle, notice);
    return notice.type === "ready" ? "ready" : "other";
  }

  /** The private IPC token authenticates the child and is then discarded. */
  private onChildRpc(handle: Handle, raw: Record<string, unknown>): void {
    const expectedKeys = ["type", "id", "token", "agentId", "epoch", "method", "args", "taskId"];
    const actualKeys = Reflect.ownKeys(raw);
    if (
      actualKeys.length !== expectedKeys.length
      || actualKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) {
      throw new Error("Worker RPC contains unsupported fields");
    }
    if (typeof raw.token !== "string" || raw.token.length !== handle.token.length) {
      throw new Error("Worker RPC failed private IPC authentication");
    }
    const token = Buffer.from(raw.token);
    const expected = Buffer.from(handle.token);
    if (
      token.length !== expected.length || !timingSafeEqual(token, expected)
      || raw.agentId !== handle.binding.agentId || raw.epoch !== handle.binding.epoch
      || typeof raw.id !== "string" || typeof raw.method !== "string" || typeof raw.taskId !== "string"
    ) throw new Error("Worker RPC failed private IPC authentication");
    for (const id of [raw.agentId, raw.id, raw.method, raw.taskId]) {
      this.requireUnredactedIdentifier(handle, id as string);
    }
    const preflight = parseWorkerEnvelope({
      binding: handle.binding,
      messageId: "node-worker-rpc-preflight",
      sequence: 1,
      payload: {
        kind: "rpc",
        rpcId: raw.id,
        taskId: raw.taskId,
        method: raw.method,
        args: raw.args
      }
    });
    if (!preflight || preflight.payload.kind !== "rpc") {
      throw new Error("Worker RPC payload is invalid or exceeds the mailbox JSON limit");
    }
    const uplink = {
      kind: "rpc" as const,
      rpcId: preflight.payload.rpcId,
      taskId: preflight.payload.taskId,
      method: preflight.payload.method,
      args: this.redactStructured(handle, preflight.payload.args) as { [key: string]: JsonValue }
    };
    if (REMOTE_EFFECT_METHODS.has(preflight.payload.method) && canonicalJson(uplink.args) !== canonicalJson(preflight.payload.args)) {
      throw new Error("Workspace effect arguments contain a credential or private token and cannot be redacted");
    }
    const checked = parseWorkerEnvelope({
      binding: handle.binding,
      messageId: "node-worker-rpc-redaction-check",
      sequence: 1,
      payload: uplink
    });
    if (!checked || checked.payload.kind !== "rpc") throw new Error("Redacted worker RPC is invalid");
    this.mailbox.enqueue(handle.binding, checked.payload);
    handle.pendingRpc.add(checked.payload.rpcId);
    if (REMOTE_EFFECT_METHODS.has(checked.payload.method)) {
      handle.pendingEffects.set(checked.payload.rpcId, {
        taskId: checked.payload.taskId,
        method: checked.payload.method as "read_file" | "write_file" | "bash" | "PublishArtifact",
        args: checked.payload.args
      });
    }
    this.options.onMailboxActivity?.();
  }

  private onChildNotice(handle: Handle, notice: WorkerNotice): void {
    const sanitized = this.sanitizeNotice(handle, notice);
    const admittedInbox = notice.type === "admitted"
      ? handle.pendingDeliveries.get(deliveryKey(notice.messageId, notice.requestId, notice.attempt))
      : undefined;
    const abortInbox = notice.type === "aborted" ? handle.pendingAbort : undefined;
    const nested = this.db.isTransaction;
    if (!nested) this.db.exec("BEGIN IMMEDIATE");
    try {
      this.mailbox.enqueue(handle.binding, { kind: "notice", notice: sanitized });
      if (admittedInbox) this.mailbox.finish(handle.binding, admittedInbox);
      if (abortInbox) this.mailbox.finish(handle.binding, abortInbox);
      if (!nested) this.db.exec("COMMIT");
    } catch (error) {
      if (!nested) {
        try { this.db.exec("ROLLBACK"); } catch { /* keep the original failure */ }
      }
      throw error;
    }
    if (admittedInbox && notice.type === "admitted") {
      handle.pendingDeliveries.delete(deliveryKey(notice.messageId, notice.requestId, notice.attempt));
    }
    this.options.onMailboxActivity?.();
    if (abortInbox) handle.pendingAbort = undefined;
  }

  private requireUnredactedIdentifier(handle: Handle, value: string): void {
    if (redactExact(value, handle.secret, handle.token, this.redactionValues) !== value) {
      throw new Error("Worker IPC identifier contains private data");
    }
  }

  private redactStructured(handle: Handle, value: JsonValue, depth = 0): JsonValue {
    if (depth > 256) throw new Error("Worker IPC payload is too deeply nested");
    if (typeof value === "string") return redactExact(value, handle.secret, handle.token, this.redactionValues);
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value)) return value.map((item) => this.redactStructured(handle, item, depth + 1));
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, item] of Object.entries(value)) {
      const redactedKey = redactExact(key, handle.secret, handle.token, this.redactionValues);
      if (redactedKey !== key || Object.hasOwn(result, redactedKey)) {
        throw new Error("Worker IPC object key contains private data or collides after redaction");
      }
      result[key] = this.redactStructured(handle, item, depth + 1);
    }
    return result;
  }

  private sanitizeNotice(handle: Handle, notice: WorkerNotice): WorkerNotice {
    const preflight = parseWorkerEnvelope({
      binding: handle.binding,
      messageId: "node-worker-notice-preflight",
      sequence: 1,
      payload: { kind: "notice", notice }
    });
    if (!preflight || preflight.payload.kind !== "notice") {
      throw new Error("Worker notice is invalid or exceeds the mailbox JSON limit");
    }
    const normalized = preflight.payload.notice;
    const identifiers = new Set([
      "type", "agentId", "epoch", "messageId", "requestId", "attempt", "submissionId",
      "status", "turnId", "generationId"
    ]);
    const redacted: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, value] of Object.entries(normalized)) {
      if (identifiers.has(key) && typeof value === "string") {
        this.requireUnredactedIdentifier(handle, value);
        redacted[key] = value;
      } else {
        redacted[key] = this.redactStructured(handle, value as JsonValue);
      }
    }
    const checked = parseWorkerEnvelope({
      binding: handle.binding,
      messageId: "node-worker-notice-redaction-check",
      sequence: 1,
      payload: { kind: "notice", notice: redacted }
    });
    if (!checked || checked.payload.kind !== "notice") throw new Error("Redacted worker notice is invalid");
    return checked.payload.notice;
  }

  /** Downlink handling for envelopes already persisted in the node inbox. */
  async pump(value: WorkerBinding): Promise<void> {
    if (this.closed) throw new NodeWorkerError("Supervisor is closed");
    const binding = this.checkedBinding(value);
    const existing = this.pumps.get(binding.runtimeId);
    if (existing) return existing;
    const flight = this.pumpOnce(binding).finally(() => this.pumps.delete(binding.runtimeId));
    this.pumps.set(binding.runtimeId, flight);
    return flight;
  }

  private checkedBinding(value: WorkerBinding): WorkerBinding {
    const binding = parseWorkerBinding(value);
    if (!binding) throw new NodeWorkerError("Invalid worker binding");
    this.mailbox.inspectBinding(binding);
    return binding;
  }

  private async pumpOnce(binding: WorkerBinding): Promise<void> {
    for (let processed = 0; processed < MAX_PUMP_CLAIMS; processed++) {
      const handle = this.handles.get(binding.runtimeId);
      if (!handle || handle.stopping) return;
      try {
        if (!this.leaseCurrent(binding)) {
          await this.stopHandle(handle, "Node lease was lost while handling downlink traffic");
          return;
        }
        const next = this.mailbox.received(binding, 1)[0];
        if (!next) return;
        const claimed = this.mailbox.claim(binding, next.messageId);
        if (!claimed) return;
        await this.apply(handle, claimed);
      } catch {
        this.note(binding.runtimeId, "Node worker mailbox handling failed; delivery evidence remains uncertain");
        await this.stopHandle(handle, "Node worker mailbox handling failed");
        return;
      }
    }
  }

  private async apply(handle: Handle, envelope: WorkerEnvelope): Promise<void> {
    const payload = envelope.payload;
    const binding = handle.binding;
    if (!this.leaseCurrent(binding)) {
      await this.stopHandle(handle, "Node lease was lost before downlink dispatch");
      return;
    }
    if (payload.kind === "deliver") {
      const key = deliveryKey(payload.messageId, payload.requestId, payload.attempt);
      handle.pendingDeliveries.set(key, envelope.messageId);
      try {
        await this.send(handle, {
          type: "deliver", messageId: payload.messageId, requestId: payload.requestId,
          attempt: payload.attempt, epoch: binding.epoch, content: payload.content, mode: payload.mode
        });
      } catch (error) {
        handle.pendingDeliveries.delete(key);
        this.note(binding.runtimeId, this.safeText(handle, error));
        await this.stopHandle(handle, "A delivery could not be handed to the worker");
      }
      if (!this.leaseCurrent(binding)) await this.stopHandle(handle, "Node lease was lost after delivery dispatch");
      // A successful IPC send is not admission: only a matching admitted
      // notice from the real worker finishes this claim.
      return;
    }
    if (payload.kind === "reply") {
      if (!handle.pendingRpc.has(payload.rpcId)) {
        if (this.acceptDuplicatePendingApprovalReply(handle, payload.rpcId, payload) ||
            this.acceptDuplicateEffectReply(handle, payload.rpcId, payload)) {
          this.mailbox.finish(binding, envelope.messageId);
          return;
        }
        this.note(binding.runtimeId, "A reply arrived for an RPC this worker did not issue");
        await this.stopHandle(handle, "A reply did not match an issued worker RPC");
        return;
      }
      const effect = handle.pendingEffects.get(payload.rpcId);
      if (effect) {
        await this.applyEffectReply(handle, envelope, payload, effect);
        return;
      }
      try {
        await this.send(handle, payload.ok ? { id: payload.rpcId, result: payload.result } : { id: payload.rpcId, error: payload.error });
      } catch (error) {
        this.note(binding.runtimeId, this.safeText(handle, error));
        await this.stopHandle(handle, "A reply could not be handed to the worker");
        return;
      }
      if (!this.leaseCurrent(binding)) {
        await this.stopHandle(handle, "Node lease was lost before the worker reply was recorded");
        return;
      }
      handle.pendingRpc.delete(payload.rpcId);
      this.mailbox.finish(binding, envelope.messageId);
      return;
    }
    if (payload.kind === "abort") {
      handle.pendingAbort = envelope.messageId;
      try {
        await this.send(handle, { type: "abort" });
      } catch (error) {
        handle.pendingAbort = undefined;
        this.note(binding.runtimeId, this.safeText(handle, error));
        await this.stopHandle(handle, "An abort could not be handed to the worker");
      }
      if (!this.leaseCurrent(binding)) await this.stopHandle(handle, "Node lease was lost after abort dispatch");
      return;
    }
    if (payload.kind === "approved-effect") {
      await this.applyApprovedEffect(handle, envelope, payload.approvalId, payload.permit);
      return;
    }
    const evidence = await this.stopHandle(handle, "A durable shutdown instruction stopped this worker", "requested");
    if (evidence.confirmedStopped) {
      try {
        this.mailbox.finish(binding, envelope.messageId);
      } catch {
        // The binding is fenced; the processing claim stays as uncertain evidence.
      }
    }
  }

  private async applyEffectReply(
    handle: Handle,
    envelope: WorkerEnvelope,
    payload: Extract<WorkerEnvelope["payload"], { kind: "reply" }>,
    effect: { taskId: string; method: "read_file" | "write_file" | "bash" | "PublishArtifact"; args: { [key: string]: JsonValue } }
  ): Promise<void> {
    const binding = handle.binding;
    const pendingResult = payload.ok && payload.result && typeof payload.result === "object"
      ? payload.result as Record<string, unknown> : undefined;
    if (pendingResult?.status === "pending") {
      if (!handle.effectApprovals || !pendingResult.approvalId || typeof pendingResult.approvalId !== "string" ||
          Reflect.ownKeys(pendingResult).length !== 2 ||
          !["status", "approvalId"].every((key) => Object.hasOwn(pendingResult, key))) {
        await this.stopHandle(handle, "A pending effect approval response was invalid or unsupported");
        return;
      }
      const spec: NodeEffectSpec = {
        binding, descriptorHash: handle.descriptorHash, taskId: effect.taskId, method: effect.method, args: effect.args
      };
      const resultJson = canonicalJson(pendingResult);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const prior = this.db.prepare("SELECT spec_json FROM node_effect_approvals WHERE approval_id=?")
          .get(pendingResult.approvalId) as { spec_json: string } | undefined;
        if (prior && prior.spec_json !== canonicalJson(spec)) throw new Error("Approval ID is already bound to another effect");
        this.db.prepare("INSERT OR IGNORE INTO node_effect_approvals(approval_id,spec_json) VALUES(?,?)")
          .run(pendingResult.approvalId, canonicalJson(spec));
        const priorReply = this.db.prepare("SELECT approval_id,result_json FROM node_effect_approval_replies WHERE rpc_id=?")
          .get(payload.rpcId) as { approval_id: string; result_json: string } | undefined;
        if (priorReply && (priorReply.approval_id !== pendingResult.approvalId || priorReply.result_json !== resultJson)) {
          throw new Error("Pending RPC reply changed after durable acceptance");
        }
        this.db.prepare("INSERT OR IGNORE INTO node_effect_approval_replies(rpc_id,approval_id,result_json) VALUES(?,?,?)")
          .run(payload.rpcId, pendingResult.approvalId, resultJson);
        if (!this.mailbox.finish(binding, envelope.messageId)) throw new Error("Pending approval reply was not processing");
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch {}
        await this.stopHandle(handle, this.safeText(handle, error));
        return;
      }
      handle.pendingRpc.delete(payload.rpcId);
      handle.pendingEffects.delete(payload.rpcId);
      this.options.onMailboxActivity?.();
      try { await this.send(handle, { id: payload.rpcId, result: pendingResult }); }
      catch { await this.stopHandle(handle, "A durable pending approval could not be handed to the worker"); }
      return;
    }
    const permit = payload.ok && payload.result && typeof payload.result === "object" ? (payload.result as Record<string, unknown>).effectPermit : undefined;
    const permitRecord = permit && typeof permit === "object" ? permit as Record<string, unknown> : undefined;
    const permitKeys = permitRecord && Reflect.ownKeys(permitRecord);
    const args = permitRecord?.args;
    const method = permitRecord?.method;
    const permitBinding = parseWorkerBinding(permitRecord?.binding);
    const bindingMatches = Boolean(permitBinding && ["runtimeId", "machineId", "sessionId", "sessionEpoch", "agentId", "epoch"].every((key) =>
      Object.hasOwn(permitBinding, key) && permitBinding[key as keyof WorkerBinding] === binding[key as keyof WorkerBinding]));
    const descriptorMatches = permitRecord?.descriptorHash === handle.descriptorHash;
    const taskMatches = permitRecord?.taskId === effect.taskId;
    const expiresAt = permitRecord?.expiresAt;
    const hasAttempt = Object.hasOwn(permitRecord ?? {}, "taskAttempt");
    const exactPermit = Boolean(permitRecord && permitKeys?.length === (hasAttempt ? 7 : 6) &&
      ["binding", "descriptorHash", "taskId", "method", "args", "expiresAt"].every(key => Object.hasOwn(permitRecord, key)));
    if (!payload.ok || !exactPermit || !bindingMatches || !descriptorMatches || !taskMatches ||
        typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) ||
        method !== effect.method || canonicalJson(args) !== canonicalJson(effect.args) ||
        (effect.method === "PublishArtifact" && (typeof permitRecord?.taskAttempt !== "number" || !Number.isSafeInteger(permitRecord.taskAttempt) || permitRecord.taskAttempt <= 0)) ||
        (effect.method !== "PublishArtifact" && hasAttempt)) {
      await this.send(handle, { id: payload.rpcId, error: payload.ok ? "Coordinator effect permit did not match the requested operation" : payload.error });
      await this.stopHandle(handle, "A workspace effect permit was rejected or mismatched");
      return;
    }
    const spec: NodeEffectSpec = {
      binding, descriptorHash: handle.descriptorHash, taskId: effect.taskId, method: effect.method, args: effect.args,
      ...(effect.method === "PublishArtifact" ? { taskAttempt: permitRecord!.taskAttempt as number } : {})
    };
    const receipt = await this.executePermittedEffect(handle, spec, expiresAt);
    const durable = this.effects.inspect().find(entry => canonicalJson(entry.spec) === canonicalJson(spec));
    if (durable && durable.state !== "prepared" && durable.state !== "executing" && durable.receipt &&
        canonicalJson(durable.receipt) === canonicalJson(receipt)) {
      handle.completedEffects.set(payload.rpcId, {
        identity: canonicalJson(spec), receipt: canonicalJson(receipt), expiresAt
      });
    }
    const returnedReceipt = receipt;
    let transactionOpen = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      if (!this.mailbox.finish(binding, envelope.messageId)) {
        throw new Error("Workspace effect permit reply was not processing");
      }
      this.db.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        try { this.db.exec("ROLLBACK"); } catch {}
      }
      throw error;
    }
    handle.pendingRpc.delete(payload.rpcId);
    handle.pendingEffects.delete(payload.rpcId);
    this.options.onMailboxActivity?.();
    if (returnedReceipt.status === "uncertain") {
      await this.stopHandle(handle, "A workspace effect outcome is uncertain; the worker must not retry it");
      return;
    }
    await this.send(handle, { id: payload.rpcId, result: returnedReceipt });
  }

  private acceptDuplicatePendingApprovalReply(
    handle: Handle,
    rpcId: string,
    payload: Extract<WorkerEnvelope["payload"], { kind: "reply" }>
  ): boolean {
    if (!handle.effectApprovals || !payload.ok || !payload.result || typeof payload.result !== "object") return false;
    const result = payload.result as Record<string, unknown>;
    if (result.status !== "pending" || typeof result.approvalId !== "string" || Reflect.ownKeys(result).length !== 2) return false;
    const row = this.db.prepare(`SELECT r.approval_id,r.result_json,a.spec_json
      FROM node_effect_approval_replies r
      JOIN node_effect_approvals a ON a.approval_id=r.approval_id
      WHERE r.rpc_id=?`).get(rpcId) as
      { approval_id: string; result_json: string; spec_json: string } | undefined;
    if (!row || row.approval_id !== result.approvalId || row.result_json !== canonicalJson(result)) return false;
    let saved: NodeEffectSpec;
    try { saved = JSON.parse(row.spec_json) as NodeEffectSpec; } catch { return false; }
    return canonicalJson(saved.binding) === canonicalJson(handle.binding) &&
      saved.descriptorHash === handle.descriptorHash &&
      saved.taskId.startsWith(`${handle.binding.agentId}:`) &&
      (saved.method === "write_file" || saved.method === "bash");
  }

  private async applyApprovedEffect(
    handle: Handle,
    envelope: WorkerEnvelope,
    approvalId: string,
    permit: Extract<WorkerEnvelope["payload"], { kind: "approved-effect" }>["permit"]
  ): Promise<void> {
    const binding = handle.binding;
    const row = this.db.prepare("SELECT spec_json FROM node_effect_approvals WHERE approval_id=?")
      .get(approvalId) as { spec_json: string } | undefined;
    let saved: NodeEffectSpec | undefined;
    try { if (row) saved = JSON.parse(row.spec_json) as NodeEffectSpec; } catch {}
    const requested: NodeEffectSpec = {
      binding: permit.binding, descriptorHash: permit.descriptorHash, taskId: permit.taskId,
      method: permit.method, args: permit.args
    };
    if (!handle.effectApprovals || !row || !saved || canonicalJson(saved) !== canonicalJson(requested) ||
        canonicalJson(requested.binding) !== canonicalJson(binding) ||
        requested.descriptorHash !== handle.descriptorHash || handle.stopping ||
        !this.leaseCurrent(binding) || Date.now() >= permit.expiresAt) {
      await this.stopHandle(handle, "An approved-effect command was unsolicited, stale, or mismatched");
      return;
    }
    const receipt = await this.executePermittedEffect(handle, requested, permit.expiresAt);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.mailbox.finish(binding, envelope.messageId)) throw new Error("Approved effect command was not processing");
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    this.options.onMailboxActivity?.();
    if (receipt.status === "uncertain") {
      await this.stopHandle(handle, "A workspace effect outcome is uncertain; it will not be replayed");
    }
  }

  private async executePermittedEffect(handle: Handle, spec: NodeEffectSpec, expiresAt: number): Promise<NodeEffectReceipt> {
    const binding = handle.binding;
    let receipt: NodeEffectReceipt | undefined;
    let errorText: string | undefined;
    try {
      this.effects.admit(spec);
      const prior = this.effects.inspect().find((entry) =>
        entry.spec.binding.runtimeId === binding.runtimeId && entry.spec.taskId === spec.taskId);
      if (handle.stopping || !this.leaseCurrent(binding)) throw new Error("Node lease or runtime ownership was lost before the durable effect claim");
      if (prior?.state === "prepared" && Date.now() >= expiresAt) throw new Error("Remote effect permit expired before the durable effect claim");
      const claim = this.effects.begin(spec);
      if (!claim.execute) {
        receipt = claim.receipt;
      } else {
        try {
          if (handle.stopping || Date.now() >= expiresAt || !this.leaseCurrent(binding)) {
            throw new Error("Remote effect permit expired or runtime ownership was lost before dispatch");
          }
          if (spec.method === "PublishArtifact") {
            if (!handle.artifactTransfers || !this.options.uploadArtifact) throw new Error("Negotiated remote artifact upload is unavailable");
            const snapshot: NodeArtifactSnapshot = snapshotNodeArtifact(
              spec, handle.workspacePath, join(this.home, "artifact-snapshots"),
              [...this.redactionValues, handle.secret ?? "", handle.token]
            );
            const result = await this.options.uploadArtifact({
              spec, manifest: snapshot.manifest,
              readChunk: (offset, length) => readNodeArtifactChunk(snapshot, offset, length),
              verifySnapshot: () => verifyNodeArtifactSnapshot(snapshot)
            });
            receipt = { status: "succeeded", result };
          } else {
            receipt = await executeNodeEffect(spec, handle.workspacePath);
          }
          if (handle.stopping || !this.leaseCurrent(binding)) {
            receipt = { status: "uncertain", error: "Node lease or runtime ownership was lost during workspace effect execution" };
          }
        } catch (error) {
          receipt = { status: "uncertain", error: this.safeText(handle, error) };
        }
        receipt = this.redactStructured(handle, receipt as unknown as JsonValue) as unknown as NodeEffectReceipt;
        receipt = this.effects.complete(spec, receipt);
      }
    } catch (error) {
      errorText = this.safeText(handle, error);
    }
    const durable = this.effects.inspect().find(entry => canonicalJson(entry.spec) === canonicalJson(spec));
    if (!durable || durable.state === "prepared" || durable.state === "executing" || !durable.receipt) {
      throw new Error(`Workspace effect has no durable terminal receipt${errorText ? `: ${errorText}` : ""}`);
    }
    if (receipt && canonicalJson(receipt) !== canonicalJson(durable.receipt)) {
      throw new Error("Workspace effect terminal receipt does not match its durable journal evidence");
    }
    return this.redactStructured(handle, durable.receipt as unknown as JsonValue) as unknown as NodeEffectReceipt;
  }

  private acceptDuplicateEffectReply(
    handle: Handle,
    rpcId: string,
    payload: Extract<WorkerEnvelope["payload"], { kind: "reply" }>
  ): boolean {
    const cached = handle.completedEffects.get(rpcId);
    if (!cached || !payload.ok || !payload.result || typeof payload.result !== "object") return false;
    const permit = (payload.result as Record<string, unknown>).effectPermit;
    if (!permit || typeof permit !== "object") return false;
    const record = permit as Record<string, unknown>;
    const keys = Reflect.ownKeys(record);
    const binding = parseWorkerBinding(record.binding);
    if (keys.length !== 6 || !["binding", "descriptorHash", "taskId", "method", "args", "expiresAt"].every(key => Object.hasOwn(record, key)) ||
        !binding || ["runtimeId", "machineId", "sessionId", "sessionEpoch", "agentId", "epoch"].some(key =>
          binding[key as keyof WorkerBinding] !== handle.binding[key as keyof WorkerBinding]) ||
        record.descriptorHash !== handle.descriptorHash || typeof record.taskId !== "string" ||
        (record.method !== "read_file" && record.method !== "write_file" && record.method !== "bash") ||
        !Number.isSafeInteger(record.expiresAt) || record.expiresAt !== cached.expiresAt) return false;
    const spec: NodeEffectSpec = {
      binding, descriptorHash: record.descriptorHash as string, taskId: record.taskId,
      method: record.method, args: record.args as { [key: string]: JsonValue }
    };
    if (canonicalJson(spec) !== cached.identity) return false;
    const entry = this.effects.inspect().find(item => canonicalJson(item.spec) === cached.identity);
    return Boolean(entry && entry.state !== "prepared" && entry.state !== "executing" && entry.receipt &&
      canonicalJson(entry.receipt) === cached.receipt);
  }

  private send(handle: Handle, message: object): Promise<void> {
    const child = handle.child;
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new Error("Worker IPC channel is disconnected"));
    }
    return new Promise<void>((done, failed) => {
      try {
        child.send(message, (error) => error ? failed(error) : done());
      } catch (error) {
        failed(error);
      }
    });
  }

  private fenceRuntime(binding: WorkerBinding, reason: string): void {
    this.note(binding.runtimeId, reason);
    try {
      this.mailbox.fence(binding);
    } catch {
      // Terminal bindings keep their existing evidence.
    }
    this.db.prepare("UPDATE node_worker_runtimes SET state='uncertain',stop_reason=COALESCE(stop_reason,'unexpected') WHERE runtime_id=? AND state IN ('admitted','running','stopping')")
      .run(binding.runtimeId);
  }

  async stop(value: WorkerBinding, stopReason: RuntimeStopReason = "requested"): Promise<NodeWorkerStopEvidence> {
    const binding = this.checkedBinding(value);
    const handle = this.handles.get(binding.runtimeId);
    if (!handle) {
      const row = this.row(binding.runtimeId);
      if (!row) throw new NodeWorkerError("Unknown node worker runtime");
      return {
        runtimeId: row.runtime_id,
        state: row.state === "closed" ? "closed" : "uncertain",
        confirmedStopped: row.confirmed_stopped === 1,
        stopReason: row.stop_reason,
        pid: row.pid,
        reason: "This runtime is no longer live on this supervisor"
      };
    }
    return this.stopHandle(handle, "An explicit stop request ended this worker", stopReason);
  }

  private stopHandle(handle: Handle, reason: string, stopReason: RuntimeStopReason = "unexpected"): Promise<NodeWorkerStopEvidence> {
    if (handle.stopping) return handle.stopping;
    this.db.prepare("UPDATE node_worker_runtimes SET stop_reason=COALESCE(stop_reason,?) WHERE runtime_id=?")
      .run(stopReason, handle.binding.runtimeId);
    const flight = this.stopOnce(handle, reason);
    handle.stopping = flight;
    return flight;
  }

  /**
   * Only kills the detached group this supervisor forked and still holds, and
   * only claims a confirmed stop when kill(-pid, 0) reports ESRCH.
   */
  private async stopOnce(handle: Handle, reason: string): Promise<NodeWorkerStopEvidence> {
    const binding = handle.binding;
    abortNodeEffect(binding.runtimeId);
    this.db.prepare("UPDATE node_worker_runtimes SET state='stopping' WHERE runtime_id=? AND state IN ('admitted','running')")
      .run(binding.runtimeId);
    try {
      this.mailbox.fence(binding);
    } catch {
      // Already fenced or terminal mailbox evidence remains unchanged.
    }
    try {
      await this.send(handle, { type: "shutdown" });
    } catch {
      // The channel may already be gone; signals still follow.
    }
    await waitForExitOrTimeout(handle.exitObserved, STOP_GRACE_MS);
    if (!this.groupExtinct(handle)) {
      this.signalGroup(handle, "SIGTERM");
      await this.waitForGroup(handle, STOP_KILL_MS);
    }
    if (!this.groupExtinct(handle)) {
      this.signalGroup(handle, "SIGKILL");
      await this.waitForGroup(handle, STOP_KILL_MS);
    }
    if (!handle.exited) await waitForExitOrTimeout(handle.exitObserved, STOP_KILL_MS);
    const effectDeadline = Date.now() + STOP_KILL_MS;
    while (!nodeEffectExtinct(binding.runtimeId) && Date.now() < effectDeadline) await delay(50);
    const confirmed = handle.exited && this.groupExtinct(handle) && nodeEffectExtinct(binding.runtimeId);
    if (this.handles.get(binding.runtimeId) === handle) this.handles.delete(binding.runtimeId);
    handle.child.stderr?.destroy();
    if (handle.child.connected) handle.child.disconnect();
    this.note(binding.runtimeId, reason);
    try {
      this.mailbox.fence(binding);
    } catch {
      // Terminal bindings keep their existing evidence.
    }
    // Physical stop alone keeps the mailbox fenced. Only a new authenticated
    // coordinator assignment may close it after checking settled local evidence.
    this.db.prepare("UPDATE node_worker_runtimes SET state=?,confirmed_stopped=? WHERE runtime_id=?")
      .run(confirmed ? "closed" : "uncertain", confirmed ? 1 : 0, binding.runtimeId);
    return {
      runtimeId: binding.runtimeId,
      state: confirmed ? "closed" : "uncertain",
      confirmedStopped: confirmed,
      stopReason: this.row(binding.runtimeId)?.stop_reason ?? null,
      pid: handle.pid,
      reason
    };
  }

  private signalGroup(handle: Handle, signal: NodeJS.Signals): void {
    try {
      process.kill(-handle.pid, 0);
    } catch {
      return;
    }
    try {
      process.kill(-handle.pid, signal);
    } catch {
      // A vanished group is checked explicitly below.
    }
  }

  private async waitForGroup(handle: Handle, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.groupExtinct(handle) && Date.now() < deadline) await delay(50);
  }

  private groupExtinct(handle: Handle): boolean {
    try {
      process.kill(-handle.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  private sweep(): void {
    if (this.closed) return;
    for (const handle of [...this.handles.values()]) {
      if (handle.stopping) continue;
      if (this.leaseCurrent(handle.binding)) continue;
      void this.stopHandle(handle, "The node lease for this binding is no longer current").catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    this.closing = (async () => {
      const flights: Promise<unknown>[] = [];
      for (const handle of [...this.handles.values()]) {
        flights.push(this.stopHandle(handle, "The supervisor closed and stopped this worker").catch(() => undefined));
      }
      for (const pump of [...this.pumps.values()]) flights.push(pump.catch(() => undefined));
      for (const flight of this.flights.values()) flights.push(flight.promise.catch(() => undefined));
      await Promise.all(flights);
      this.db.close();
      try {
        this.lockDb.exec("ROLLBACK");
      } catch {
        // The ownership transaction may already be gone.
      }
      this.lockDb.close();
    })();
    return this.closing;
  }
}

export { parseWorkerStartSpec, workerStartSpecHash };
export type { WorkerStartSpec };

export function newRuntimeId(): string {
  return randomUUID();
}
