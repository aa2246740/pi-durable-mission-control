import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, readFileSync, writeFileSync, statSync, existsSync, chmodSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { RpcMessage } from "./worker.js";
import type {
  Agent,
  AppState,
  Approval,
  Artifact,
  Blocker,
  AssertionResult,
  CreateMissionInput,
  Machine,
  Message,
  Mission,
  MissionDetail,
  MissionEvent,
  ModelProfile,
  MissionStateView,
  RoleProfile,
  Task,
  TranscriptEntry,
  Validation,
  ValidationContract,
  Requirement,
  RequirementCoverage,
  MissionSchedule,
  MissionWatchdog,
  ScheduleOccurrence,
  ScheduleSpec,
  ValidationReceipt,
  Workspace,
  WatchdogWake,
  WorktreeRecord
} from "./contracts.js";
import { parseMcpPermissions, parseMcpServer, type McpServerConfig } from "./mcp-config.js";
import { mcpSecretValues, McpOperationError, McpRuntimeManager, redactMcpValue } from "./mcp-runtime.js";
import { parseScheduleSpec } from "./schedules.js";
import { MachineRegistry, type NodeCommand, type RemoteMachine } from "./machines.js";
import { DurableWorkerMailbox, parseWorkerBinding, parseWorkerReceipt, type WorkerBinding, type WorkerEnvelope, type WorkerReceipt } from "./worker-mailbox.js";
import { parseWorkerStartSpec, workerStartSpecHash } from "./node-worker-spec.js";
import { RemoteRuntimeRegistry, type RemoteRuntimeDirective, type RemoteRuntimeRow } from "./remote-runtimes.js";
import { REMOTE_RPC_METHODS } from "./remote-rpc-methods.js";
import {
  addAgentWorktree,
  addDetachedWorktree,
  branchExists,
  ensureWorktreeParent,
  inspectRepository,
  isAncestor,
  isTrackedSnapshotClean,
  isWorktreeClean,
  listWorktrees,
  repositoryCommonDir,
  repositoryHead,
  trackedArtifactPath,
  trackedBlobAt,
  verifyWorktree,
  type RepositoryIdentity
} from "./worktrees.js";

export const CONTROL_SCHEMA_VERSION = 7;
const REMOTE_OPERATION_UNAVAILABLE = "Remote operation is unavailable for this agent";
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Row = { data: string };
type OutboxRow = { id: string; mission_id: string; message_id: string; attempt: number; request_id: string; retry_count: number };
type ScheduleRow = {
  id: string; mission_id: string; name: string; prompt: string; schedule: string; status: MissionSchedule["status"];
  revision: number; next_run_at: string | null; last_occurrence_id: string | null; reason: string | null;
  created_at: string; updated_at: string;
};
type WatchdogWakeRow = {
  id: string; mission_id: string; fingerprint: string; message_id: string; request_id: string;
  attempt: number; created_at: string; delivery_status?: string | null; delivery_error?: string | null;
};
type OwnerRow = { daemon_id: string; epoch: number; pid: number; heartbeat_at: number };
type ShellEvidence = { command: string; stdout: string; stderr: string; exitCode: number | null };
type ValidationApprovalBinding = {
  validationTaskId: string;
  validationAttempt: number;
  validationTaskRevision: number;
  contractRevision?: number;
  requirementRevisions: Record<string, number>;
};

const now = (): string => new Date().toISOString();
const json = <T>(value: T): string => JSON.stringify(value);
const decode = <T>(value: string): T => JSON.parse(value) as T;
const watchdogIdleThresholdMs = 60_000;
const watchdogRunningThresholdMs = 600_000;
const watchdogPrompt = [
  "Mission watchdog: pending tasks have remained unchanged while the whole team was idle for at least 60 seconds.",
  "This is one new bounded recovery input, NOT a retry of any earlier operation.",
  "Call GetMissionState once, inspect the existing tasks and evidence, then advance one actionable task using the original team, or use RequestUserInput to explain a concrete blocker.",
  "Do not poll, send acknowledgement-only messages, spawn replacement agents merely to retry, or replay uncertain operations. Normal approval, budget, independent validation and completion gates still apply.",
  "If waiting, call WaitForMessage alone. If reporting a real outcome, call Report alone. Each ends this run. A report or this input is not acceptance evidence."
].join("\n");

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

const assertionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const createMissionFields = ["title", "goal", "acceptance", "workspaceId", "remoteWorkspaceIds", "roleIds", "maxTurns", "maxCost", "autonomy", "assertions", "workspaceStrategy"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseNonEmptyString(value: unknown, name: string, max = 20000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new HttpError(400, `${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function parseAssertions(value: unknown, allowUndefined = true): Array<Pick<Requirement, "id" | "description">> | undefined {
  if (value === undefined && allowUndefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, "assertions must be a non-empty array");
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item) || Object.keys(item).some((key) => !["id", "description"].includes(key))) {
      throw new HttpError(400, `assertions[${index}] must contain only id and description`);
    }
    const id = parseNonEmptyString(item.id, `assertions[${index}].id`, 80);
    if (!assertionIdPattern.test(id)) throw new HttpError(400, `assertions[${index}].id has an unsafe format`);
    if (seen.has(id)) throw new HttpError(400, `Duplicate assertion id: ${id}`);
    seen.add(id);
    return { id, description: parseNonEmptyString(item.description, `assertions[${index}].description`) };
  });
}

function parseFulfills(value: unknown, allowUndefined = true): string[] | undefined {
  if (value === undefined && allowUndefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new HttpError(400, "fulfills must be an array of non-empty assertion ids");
  }
  if (new Set(value).size !== value.length) throw new HttpError(400, "fulfills must not contain duplicate assertion ids");
  return [...value];
}

export function parseCreateMissionInput(value: unknown): CreateMissionInput {
  if (!isRecord(value)) throw new HttpError(400, "Mission input must be an object");
  const unknown = Object.keys(value).filter((key) => !createMissionFields.includes(key));
  if (unknown.length) throw new HttpError(400, `Unexpected mission fields: ${unknown.join(", ")}`);
  if (!Array.isArray(value.roleIds) || value.roleIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new HttpError(400, "roleIds must be a non-empty array of string ids");
  }
  if (new Set(value.roleIds).size !== value.roleIds.length) throw new HttpError(400, "roleIds must contain unique roles");
  if (value.remoteWorkspaceIds !== undefined &&
    (!Array.isArray(value.remoteWorkspaceIds) || value.remoteWorkspaceIds.some((id) => typeof id !== "string" || !id.trim()))) {
    throw new HttpError(400, "remoteWorkspaceIds must be an array of non-empty workspace ids");
  }
  if (Array.isArray(value.remoteWorkspaceIds) && new Set(value.remoteWorkspaceIds).size !== value.remoteWorkspaceIds.length) {
    throw new HttpError(400, "remoteWorkspaceIds must contain unique workspace ids");
  }
  if (typeof value.maxTurns !== "number" || !Number.isSafeInteger(value.maxTurns) || value.maxTurns < 1) {
    throw new HttpError(400, "maxTurns must be a positive safe integer");
  }
  if (typeof value.maxCost !== "number" || !Number.isFinite(value.maxCost) || value.maxCost < 0) {
    throw new HttpError(400, "maxCost must be a finite number >= 0");
  }
  if (value.autonomy !== "approve" && value.autonomy !== "trusted") throw new HttpError(400, "Invalid autonomy mode");
  if (value.workspaceStrategy !== undefined && value.workspaceStrategy !== "shared" && value.workspaceStrategy !== "worktree") {
    throw new HttpError(400, "workspaceStrategy must be shared or worktree");
  }
  const assertions = parseAssertions(value.assertions);
  return {
    title: parseNonEmptyString(value.title, "title"),
    goal: parseNonEmptyString(value.goal, "goal"),
    acceptance: parseNonEmptyString(value.acceptance, "acceptance"),
    workspaceId: parseNonEmptyString(value.workspaceId, "workspaceId"),
    ...(Array.isArray(value.remoteWorkspaceIds) && value.remoteWorkspaceIds.length ? { remoteWorkspaceIds: [...value.remoteWorkspaceIds] as string[] } : {}),
    roleIds: [...value.roleIds],
    maxTurns: value.maxTurns,
    maxCost: value.maxCost,
    autonomy: value.autonomy,
    workspaceStrategy: value.workspaceStrategy === "worktree" ? "worktree" : "shared",
    ...(assertions === undefined ? {} : { assertions })
  };
}

export function parseValidationContractUpdateInput(value: unknown): {
  expectedRevision: number;
  assertions: Array<Pick<Requirement, "id" | "description">>;
  reason: string;
  confirmRemoval: boolean;
} {
  if (!isRecord(value)) throw new HttpError(400, "Validation contract input must be an object");
  const unknown = Object.keys(value).filter((key) => !["expectedRevision", "assertions", "reason", "confirmRemoval"].includes(key));
  if (unknown.length) throw new HttpError(400, `Unexpected validation contract fields: ${unknown.join(", ")}`);
  if (typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw new HttpError(400, "expectedRevision must be a non-negative safe integer");
  }
  if (typeof value.confirmRemoval !== "boolean") throw new HttpError(400, "confirmRemoval must be boolean");
  return {
    expectedRevision: value.expectedRevision,
    assertions: parseAssertions(value.assertions, false)!,
    reason: parseNonEmptyString(value.reason, "reason"),
    confirmRemoval: value.confirmRemoval
  };
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class ControlPlane {
  readonly mcpRuntime = new McpRuntimeManager();
  readonly home: string;
  readonly db: DatabaseSync;
  readonly daemonId = randomUUID();
  private ownerEpoch = 0;
  private closed = false;
  private watchdogFailureLogAt: number | undefined;
  private readonly shellFlights = new Map<string, { digest: string; promise: Promise<ShellEvidence> }>();
  private readonly validationFlights = new Map<string, { digest: string; promise: Promise<ValidationReceipt> }>();
  private readonly approvalFlights = new Map<string, Promise<Approval>>();
  private readonly externalProcesses = new Map<ChildProcess, { missionId: string; agentId: string }>();
  private readonly activeWorkspaceOperations = new Map<string, number>();
  readonly machineRegistry: MachineRegistry;
  readonly workerMailbox: DurableWorkerMailbox;
  readonly remoteRuntimes: RemoteRuntimeRegistry;

  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.home = realpathSync(home);
    mkdirSync(join(home, "agents"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "artifacts"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "worktrees"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(home, "control.sqlite"), { timeout: 5000 });
    this.machineRegistry = new MachineRegistry(this.db);
    this.remoteRuntimes = new RemoteRuntimeRegistry(this.db);
    try {
      this.checkStartupCompatibility();
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      this.workerMailbox = this.transaction(() => {
        this.checkStartupCompatibility();
        this.migrate();
        const workerMailbox = new DurableWorkerMailbox(this.db, "coordinator");
        this.seedProfiles();
        this.acquireOwner();
        this.fenceRecoveredAgents();
        MachineRegistry.fenceOnCoordinatorStart(this.db);
        const interruptedRuntimes = this.db.prepare("SELECT runtime_id,agent_id FROM remote_worker_runtimes WHERE state IN ('queued','offered','running','stopping')")
          .all() as Array<{ runtime_id: string; agent_id: string }>;
        this.db.prepare("UPDATE remote_worker_runtimes SET desired='stop',state='uncertain',updated_at=? WHERE state IN ('queued','offered','running','stopping')")
          .run(Date.now());
        for (const runtime of interruptedRuntimes) {
          const agent = this.getAgent(runtime.agent_id);
          if (agent) this.insertSystemBlocker(`remote-runtime:${runtime.runtime_id}`, agent.missionId, "delivery",
            "Remote runtime ownership became uncertain after coordinator restart. Reconcile ownership and in-flight work before resuming.");
        }
        workerMailbox.recover();
        return workerMailbox;
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private schemaVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  private checkStartupCompatibility(): void {
    const version = this.schemaVersion();
    if (version < 0 || version > CONTROL_SCHEMA_VERSION) {
      throw new HttpError(409, `Control database schema ${version} is not supported by this build (maximum ${CONTROL_SCHEMA_VERSION}); use a compatible version or restore a complete backup. Automatic downgrade is not supported.`);
    }
    if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='daemon_owner'").get()) {
      const owner = this.db.prepare("SELECT pid FROM daemon_owner WHERE singleton=1").get() as { pid: number } | undefined;
      if (owner && processExists(owner.pid)) {
        throw new HttpError(409, `Mission Control already has an owner process (${owner.pid}); schema migration is refused while it is alive`);
      }
    }
  }

  private migrate(): void {
    if (this.schemaVersion() === CONTROL_SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_owner (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        daemon_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_server_revisions (
        server_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(server_id,revision)
      );
      CREATE TABLE IF NOT EXISTS mcp_call_commands (
        actor_id TEXT NOT NULL, command_id TEXT NOT NULL, payload_hash TEXT NOT NULL, approval_id TEXT NOT NULL,
        PRIMARY KEY(actor_id,command_id)
      );
      CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profile_revisions (profile_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(profile_id, revision));
      CREATE TABLE IF NOT EXISTS role_revisions (role_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(role_id, revision));
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS validation_contracts (
        mission_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(mission_id, revision)
      );
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, status TEXT NOT NULL, epoch INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agents_mission_idx ON agents(mission_id);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_mission_idx ON tasks(mission_id);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS validations (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS validation_receipts (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, task_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS validation_intents (
        scope TEXT NOT NULL, command_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        status TEXT NOT NULL, mission_id TEXT NOT NULL, task_id TEXT NOT NULL,
        receipt_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(scope, command_id)
      );
      CREATE TABLE IF NOT EXISTS blockers (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_mission_seq_idx ON events(mission_id, seq);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, message_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
        epoch INTEGER NOT NULL, created_at TEXT NOT NULL, error TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
        deadline_at INTEGER, next_attempt_at INTEGER, result TEXT
      );
      CREATE TABLE IF NOT EXISTS commands (
        scope TEXT NOT NULL, command_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
        response TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(scope, command_id)
      );
      CREATE TABLE IF NOT EXISTS transcript (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_usage (
        agent_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, cost REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounted_turns (
        agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, PRIMARY KEY(agent_id,turn_id)
      );
      CREATE TABLE IF NOT EXISTS generation_admissions (
        agent_id TEXT NOT NULL, generation_id TEXT NOT NULL, mission_id TEXT NOT NULL,
        epoch INTEGER NOT NULL, turn_number INTEGER NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(agent_id,generation_id)
      );
      CREATE TABLE IF NOT EXISTS generation_denials (
        agent_id TEXT NOT NULL, generation_id TEXT NOT NULL, mission_id TEXT NOT NULL,
        epoch INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(agent_id,generation_id)
      );
      CREATE TABLE IF NOT EXISTS mission_schedules (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
        schedule TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
        next_run_at TEXT, last_occurrence_id TEXT, reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mission_schedules_due_idx ON mission_schedules(status,next_run_at,id);
      CREATE TABLE IF NOT EXISTS schedule_occurrences (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, schedule_id TEXT NOT NULL,
        schedule_revision INTEGER NOT NULL, scheduled_for TEXT NOT NULL, observed_at TEXT NOT NULL,
        outcome TEXT NOT NULL, reason TEXT, message_id TEXT, request_id TEXT, attempt INTEGER,
        UNIQUE(schedule_id,schedule_revision,scheduled_for)
      );
      CREATE INDEX IF NOT EXISTS schedule_occurrences_mission_idx ON schedule_occurrences(mission_id,observed_at);
      CREATE TABLE IF NOT EXISTS watchdog_state (
        mission_id TEXT PRIMARY KEY, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS watchdog_wakes (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        message_id TEXT NOT NULL, request_id TEXT NOT NULL, attempt INTEGER NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(mission_id,fingerprint)
      );
      CREATE INDEX IF NOT EXISTS watchdog_wakes_mission_idx ON watchdog_wakes(mission_id,created_at,id);
      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS worktrees_mission_idx ON worktrees(mission_id,id);
    `);
    MachineRegistry.migrate(this.db);
    DurableWorkerMailbox.migrate(this.db, "coordinator");
    RemoteRuntimeRegistry.migrate(this.db);
    const outboxColumns = this.db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
    if (!outboxColumns.some((column) => column.name === "retry_count")) {
      this.db.exec("ALTER TABLE outbox ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!outboxColumns.some((column) => column.name === "deadline_at")) this.db.exec("ALTER TABLE outbox ADD COLUMN deadline_at INTEGER");
    if (!outboxColumns.some((column) => column.name === "next_attempt_at")) this.db.exec("ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER");
    if (!outboxColumns.some((column) => column.name === "result")) this.db.exec("ALTER TABLE outbox ADD COLUMN result TEXT");
    this.db.exec(`PRAGMA user_version=${CONTROL_SCHEMA_VERSION}`);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private transactionIfNeeded<T>(fn: () => T): T {
    return this.db.isTransaction ? fn() : this.transaction(fn);
  }

  private acquireOwner(): void {
    const previous = this.db.prepare("SELECT daemon_id, epoch, pid, heartbeat_at FROM daemon_owner WHERE singleton=1").get() as OwnerRow | undefined;
    this.ownerEpoch = (previous?.epoch ?? 0) + 1;
    this.db.prepare("INSERT INTO daemon_owner(singleton,daemon_id,epoch,pid,heartbeat_at) VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET daemon_id=excluded.daemon_id,epoch=excluded.epoch,pid=excluded.pid,heartbeat_at=excluded.heartbeat_at")
      .run(this.daemonId, this.ownerEpoch, process.pid, Date.now());
  }

  private fenceRecoveredAgents(): void {
    const rows = this.db.prepare("SELECT id,mission_id,status,epoch,data FROM agents").all() as Array<{ id: string; mission_id: string; status: string; epoch: number; data: string }>;
    for (const row of rows) {
      const agent = decode<Agent>(row.data);
      const mission = this.getMission(row.mission_id);
      const remote = agent.machineId !== "local";
      const nextStatus = !remote && mission?.status === "active" ? "recovering" : "offline";
      const next = { ...agent, status: nextStatus as Agent["status"], epoch: row.epoch + 1, updatedAt: now() };
      this.db.prepare("UPDATE agents SET status=?,epoch=?,data=? WHERE id=?").run(next.status, next.epoch, json(next), row.id);
      if (mission && nextStatus === "recovering") this.event(mission.id, "agent_recovering", `Agent ownership advanced to epoch ${next.epoch}.`, agent.id);
      if (remote) {
        this.db.prepare(`UPDATE outbox SET status='uncertain',deadline_at=NULL,error='Remote delivery outcome is uncertain after coordinator restart'
          WHERE message_id IN (SELECT id FROM messages WHERE json_extract(data,'$.recipientId')=?) AND status IN ('dispatching','admitted')`).run(agent.id);
        this.db.prepare(`UPDATE messages SET status='uncertain',
          data=json_set(data,'$.status','uncertain','$.error','Remote delivery outcome is uncertain after coordinator restart')
          WHERE json_extract(data,'$.recipientId')=? AND (
            status IN ('dispatching','admitted','delivering','delivered') OR
            EXISTS (SELECT 1 FROM outbox o WHERE o.message_id=messages.id AND o.status='uncertain')
          )`).run(agent.id);
        if (mission) this.event(mission.id, "remote_runtime_uncertain", "Remote runtime ownership is uncertain after coordinator restart; no delivery was replayed.", agent.id);
      }
    }
    this.db.prepare(`UPDATE outbox SET status='queued',deadline_at=NULL,next_attempt_at=0
      WHERE status IN ('dispatching','admitted') AND mission_id IN (SELECT id FROM missions WHERE status='active')
      AND COALESCE((SELECT json_extract(a.data,'$.machineId') FROM agents a
        JOIN messages m ON json_extract(m.data,'$.recipientId')=a.id WHERE m.id=outbox.message_id),'local')='local'`).run();
  }

  private seedProfiles(): void {
    const presets: ModelProfile[] = [
      {
        id: "glm-4.7-coding",
        name: "GLM-4.7 Coding",
        api: "openai-completions",
        modelId: "glm-4.7",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        credentialEnv: "ZHIPU_API_KEY",
        contextWindow: 128000,
        maxTokens: 8192,
        reasoning: true,
        toolCalling: true,
        vision: false,
        revision: 1
      },
      {
        id: "minimax-m2.5",
        name: "MiniMax-M2.5",
        api: "anthropic-messages",
        modelId: "MiniMax-M2.5",
        baseUrl: "https://api.minimaxi.com/anthropic",
        credentialEnv: "MINIMAX_CN",
        contextWindow: 128000,
        maxTokens: 8192,
        reasoning: true,
        toolCalling: true,
        vision: false,
        revision: 1
      }
    ];
    const insert = this.db.prepare("INSERT OR IGNORE INTO profiles(id,data) VALUES(?,?)");
    for (const profile of presets) insert.run(profile.id, json(profile));
  }

  private event(missionId: string, type: string, text: string, agentId?: string, data?: unknown): MissionEvent {
    const value = { missionId, type, text, createdAt: now(), ...(agentId === undefined ? {} : { agentId }), ...(data === undefined ? {} : { data }) };
    const result = this.db.prepare("INSERT INTO events(mission_id,type,data) VALUES(?,?,?)").run(missionId, type, json(value));
    return { seq: Number(result.lastInsertRowid), ...value };
  }

  private getMission(id: string): Mission | undefined {
    const row = this.db.prepare("SELECT data FROM missions WHERE id=?").get(id) as Row | undefined;
    return row ? decode<Mission>(row.data) : undefined;
  }

  validationContract(missionId: string): ValidationContract | undefined {
    const mission = this.getMission(missionId);
    if (!mission) return undefined;
    const anySnapshot = this.db.prepare("SELECT 1 FROM validation_contracts WHERE mission_id=? LIMIT 1").get(missionId);
    if (mission.contractRevision === undefined) {
      if (anySnapshot) throw new HttpError(409, "Mission validation contract linkage is inconsistent");
      return undefined;
    }
    if (!Number.isSafeInteger(mission.contractRevision) || mission.contractRevision < 1) {
      throw new HttpError(409, "Mission validation contract revision is invalid");
    }
    const row = this.db.prepare("SELECT data FROM validation_contracts WHERE mission_id=? AND revision=?")
      .get(missionId, mission.contractRevision) as Row | undefined;
    if (!row) throw new HttpError(409, "Mission validation contract snapshot is missing");
    let contract: ValidationContract;
    try {
      contract = decode<ValidationContract>(row.data);
    } catch {
      throw new HttpError(409, "Mission validation contract snapshot is corrupt");
    }
    if (!isRecord(contract) || contract.missionId !== missionId || contract.revision !== mission.contractRevision ||
      !Array.isArray(contract.assertions) || contract.assertions.length === 0 ||
      contract.assertions.some((assertion) => !isRecord(assertion) || typeof assertion.id !== "string" ||
        typeof assertion.description !== "string" || !Number.isSafeInteger(assertion.revision))) {
      throw new HttpError(409, "Mission validation contract snapshot is corrupt");
    }
    return contract;
  }

  private validationContractHistory(missionId: string): ValidationContract[] {
    const rows = this.db.prepare("SELECT data FROM validation_contracts WHERE mission_id=? ORDER BY revision").all(missionId) as Row[];
    return rows.map((row) => decode<ValidationContract>(row.data));
  }

  private missionHasValidationFlight(missionId: string): boolean {
    return [...this.validationFlights.keys()].some((key) => key.startsWith(`mission:${missionId}:`));
  }

  updateValidationContract(missionId: string, input: {
    expectedRevision: number;
    assertions: Array<Pick<Requirement, "id" | "description">>;
    reason: string;
    confirmRemoval: boolean;
  }): ValidationContract {
    const parsed = parseValidationContractUpdateInput(input);
    const assertions = parsed.assertions;
    const reason = parsed.reason;
    return this.transaction(() => {
      const mission = this.getMission(missionId);
      if (!mission) throw new HttpError(404, "Mission not found");
      if (!["draft", "paused", "blocked"].includes(mission.status)) throw new HttpError(409, "Validation contract can only change while mission is draft, paused, or blocked");
      if (this.listAgents(missionId).some((agent) => ["running", "recovering", "waiting_approval"].includes(agent.status))) {
        throw new HttpError(409, "All mission agents must be stopped before changing the validation contract");
      }
      if ([...this.externalProcesses.values()].some((owner) => owner.missionId === missionId) || this.missionHasValidationFlight(missionId)) {
        throw new HttpError(409, "Mission has running validation or external work");
      }
      const current = this.validationContract(missionId);
      const currentRevision = mission.contractRevision ?? current?.revision ?? 0;
      if (parsed.expectedRevision !== currentRevision) throw new HttpError(409, `Expected validation contract revision ${parsed.expectedRevision}, current revision is ${currentRevision}`);
      const oldAssertions = current?.assertions ?? [];
      const oldById = new Map(oldAssertions.map((assertion) => [assertion.id, assertion]));
      const nextById = new Map(assertions.map((assertion) => [assertion.id, assertion]));
      const removed = oldAssertions.filter((assertion) => !nextById.has(assertion.id)).map((assertion) => assertion.id);
      const added = assertions.filter((assertion) => !oldById.has(assertion.id)).map((assertion) => assertion.id);
      const changed = assertions.filter((assertion) => {
        const old = oldById.get(assertion.id);
        return old !== undefined && old.description !== assertion.description;
      }).map((assertion) => assertion.id);
      if (removed.length && !parsed.confirmRemoval) throw new HttpError(400, "Removing assertions requires confirmRemoval=true");
      const usedIds = new Set<string>(
        this.validationContractHistory(missionId).flatMap((contract) => contract.assertions.map((assertion) => assertion.id))
      );
      if (assertions.some((assertion) => usedIds.has(assertion.id) && !oldById.has(assertion.id))) {
        throw new HttpError(409, "A removed assertion id cannot be reused");
      }
      if (oldAssertions.length === assertions.length && oldAssertions.every((assertion) => nextById.get(assertion.id)?.description === assertion.description)) {
        return current!;
      }
      const revision = currentRevision + 1;
      const nextAssertions: Requirement[] = assertions.map((assertion) => {
        const old = oldById.get(assertion.id);
        return { ...assertion, revision: old ? (old.description === assertion.description ? old.revision : old.revision + 1) : 1 };
      });
      const contract: ValidationContract = { missionId, revision, assertions: nextAssertions, createdAt: now() };
      this.db.prepare("INSERT INTO validation_contracts(mission_id,revision,data,created_at) VALUES(?,?,?,?)")
        .run(missionId, revision, json(contract), contract.createdAt);
      const impacted = new Set<string>();
      const rows = this.db.prepare("SELECT id,data FROM tasks WHERE mission_id=?").all(missionId) as Array<{ id: string; data: string }>;
      const tasks = rows.map((row) => decode<Task>(row.data));
      for (const task of tasks) {
        if ((task.fulfills ?? []).some((id) => changed.includes(id) || removed.includes(id))) impacted.add(task.id);
      }
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const task of tasks) {
          if (!impacted.has(task.id) && task.dependencies.some((dependency) => impacted.has(dependency))) {
            impacted.add(task.id);
            expanded = true;
          }
        }
      }
      for (const task of tasks) {
        if (!impacted.has(task.id)) continue;
        const fulfills = (task.fulfills ?? []).filter((id) => !removed.includes(id));
        const updated: Task = { ...task, status: "blocked", attempt: task.attempt + 1, revision: (task.revision ?? 0) + 1, fulfills };
        delete updated.evidence;
        this.db.prepare("UPDATE tasks SET status=?,data=? WHERE id=?").run(updated.status, json(updated), updated.id);
      }
      const updatedMission = { ...mission, contractRevision: revision, updatedAt: now() };
      this.putMission(updatedMission);
      this.event(missionId, "validation_contract_updated", "Validation contract updated by the user.", undefined, {
        reason, confirmRemoval: parsed.confirmRemoval, added, changed, removed,
        previousRevision: currentRevision, revision, invalidatedTaskIds: [...impacted]
      });
      return contract;
    });
  }

  private putMission(mission: Mission): void {
    this.db.prepare("INSERT INTO missions(id,status,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data")
      .run(mission.id, mission.status, json(mission));
  }

  private getAgent(id: string): Agent | undefined {
    const row = this.db.prepare("SELECT data FROM agents WHERE id=?").get(id) as Row | undefined;
    return row ? decode<Agent>(row.data) : undefined;
  }

  private putAgent(agent: Agent): void {
    this.db.prepare("INSERT INTO agents(id,mission_id,status,epoch,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,epoch=excluded.epoch,data=excluded.data")
      .run(agent.id, agent.missionId, agent.status, agent.epoch, json(agent));
  }

  private command<T>(scope: string, commandId: string, payload: unknown, create: () => T): T {
    if (!commandId || commandId.length > 240) throw new HttpError(400, "A command id is required (maximum 240 characters)");
    return this.transaction(() => {
      const digest = hash(payload);
      const previous = this.db.prepare("SELECT payload_hash,response FROM commands WHERE scope=? AND command_id=?").get(scope, commandId) as { payload_hash: string; response: string } | undefined;
      if (previous) {
        if (previous.payload_hash !== digest) throw new HttpError(409, "The command id was already used with a different payload");
        return decode<T>(previous.response);
      }
      const result = create();
      this.db.prepare("INSERT INTO commands(scope,command_id,payload_hash,response,created_at) VALUES(?,?,?,?,?)")
        .run(scope, commandId, digest, json(result), now());
      return result;
    });
  }

  private commandReplay<T>(scope: string, commandId: string, payload: unknown): T | undefined {
    const previous = this.db.prepare("SELECT payload_hash,response FROM commands WHERE scope=? AND command_id=?")
      .get(scope, commandId) as { payload_hash: string; response: string } | undefined;
    if (!previous) return undefined;
    if (previous.payload_hash !== hash(payload)) throw new HttpError(409, "The command id was already used with a different payload");
    return decode<T>(previous.response);
  }

  private rows<T>(table: string): T[] {
    const rows = this.db.prepare(`SELECT data FROM ${table}`).all() as Row[];
    return rows.map((row) => decode<T>(row.data));
  }

  profile(id: string): ModelProfile | undefined {
    const row = this.db.prepare("SELECT data FROM profiles WHERE id=?").get(id) as Row | undefined;
    return row ? decode<ModelProfile>(row.data) : undefined;
  }

  role(id: string): RoleProfile | undefined {
    const row = this.db.prepare("SELECT data FROM roles WHERE id=?").get(id) as Row | undefined;
    return row ? decode<RoleProfile>(row.data) : undefined;
  }

  workspace(id: string): Workspace | undefined {
    const row = this.db.prepare("SELECT data FROM workspaces WHERE id=?").get(id) as Row | undefined;
    return row ? decode<Workspace>(row.data) : undefined;
  }

  state(): AppState {
    const profiles = this.rows<ModelProfile>("profiles").map((profile) => ({
      ...profile,
      available: !profile.credentialEnv || Boolean(process.env[profile.credentialEnv])
    }));
    const machines: Machine[] = [
      { id: "local", name: "Local machine", kind: "local", status: "available" },
      ...this.machineRegistry.list()
    ];
    return {
      missions: this.rows<Mission>("missions"),
      profiles,
      roles: this.rows<RoleProfile>("roles"),
      mcpServers: this.mcpServers(),
      workspaces: this.rows<Workspace>("workspaces"),
      machines,
      version: "0.1.0"
    };
  }

  enrollMachine(id: string, name: string): { machine: RemoteMachine; token: string } {
    return this.machineRegistry.enroll(id, name);
  }

  revokeMachine(id: string): RemoteMachine {
    const machine = this.machineRegistry.revoke(id);
    this.fenceStaleWorkerBindings();
    return machine;
  }

  reenrollMachine(id: string): { machine: RemoteMachine; token: string } {
    return this.machineRegistry.reenroll(id);
  }

  probeMachine(id: string, requestId: string, path: string): NodeCommand {
    return this.machineRegistry.enqueueProbe(id, requestId, path);
  }

  nodeSession(machineId: string, token: string, capabilities: unknown, registrationId: string): {
    machine: RemoteMachine; sessionId: string; sessionEpoch: number; leaseMs: number;
  } {
    return this.machineRegistry.openSession(machineId, token, capabilities, registrationId);
  }

  nodePoll(machineId: string, token: string, sessionId: string, sessionEpoch: number): {
    machine: RemoteMachine; commands: NodeCommand[]; leaseMs: number;
  } {
    return this.machineRegistry.poll(machineId, token, sessionId, sessionEpoch);
  }

  nodeRuntimePoll(machineId: string, token: string, sessionId: string, sessionEpoch: number): { directives: RemoteRuntimeDirective[] } {
    this.machineRegistry.requireSession(machineId, token, sessionId, sessionEpoch);
    return { directives: this.remoteRuntimes.poll(machineId, sessionId, sessionEpoch) };
  }

  nodeRuntimeReport(machineId: string, token: string, sessionId: string, sessionEpoch: number, report: {
    reportId: string; binding: WorkerBinding; descriptorHash: string; outcome: "stopped" | "uncertain" | "rejected";
  }): { recorded: true; duplicate: boolean } {
    this.machineRegistry.requireSession(machineId, token, sessionId, sessionEpoch);
    if (report.binding.machineId !== machineId) throw new HttpError(403, "Runtime report does not belong to this machine");
    try {
      return this.transaction(() => {
        const saved = this.remoteRuntimes.report(report);
        this.workerMailbox.fence(report.binding);
        if (!saved.duplicate) {
          const agent = this.getAgent(report.binding.agentId);
          const mission = agent ? this.getMission(agent.missionId) : undefined;
          const unexpected = saved.unexpected && mission?.status === "active";
          if (unexpected && agent) this.markAgentInterrupted(agent.id, report.binding.epoch);
          if (report.outcome !== "stopped" || unexpected) {
            if (agent) this.insertSystemBlocker(`remote-runtime:${report.binding.runtimeId}`, agent.missionId, "delivery",
              "Remote runtime ownership or in-flight work requires trusted reconciliation before resuming.");
          }
          if (unexpected && mission) this.event(mission.id, "remote_runtime_uncertain",
            "An active remote runtime ended unexpectedly; delivery state is fenced and requires trusted reconciliation.", agent?.id);
        }
        return { recorded: true, duplicate: saved.duplicate };
      });
    } catch {
      throw new HttpError(409, "Runtime report does not match its assignment or conflicts with a prior report");
    }
  }

  remoteRuntimeSnapshots(missionId: string): Array<Record<string, unknown>> {
    if (!this.getMission(missionId)) throw new HttpError(404, "Mission not found");
    return this.remoteRuntimes.snapshots(missionId);
  }

  assignRemoteRuntime(agentId: string): { binding: WorkerBinding; descriptor: ReturnType<typeof parseWorkerStartSpec>; descriptorHash: string; existing: boolean } {
    return this.transaction(() => {
      const agent = this.getAgent(agentId);
      const mission = agent ? this.getMission(agent.missionId) : undefined;
      const role = agent ? this.role(agent.roleId) : undefined;
      const profile = agent ? this.profile(agent.profileId) : undefined;
      const workspace = agent?.workspaceId ? this.workspace(agent.workspaceId) : undefined;
      const machine = agent && agent.machineId !== "local" ? this.machineRegistry.get(agent.machineId) : undefined;
      if (!agent || !mission || !role || !profile || !workspace || !machine ||
          mission.status !== "active" ||
          role.kind !== "worker" || mission.workspaceStrategy === "worktree" ||
          workspace.machineId !== agent.machineId || !mission.remoteWorkspaceIds?.includes(workspace.id) || !workspace.probe ||
          machine.status !== "online" || (machine.leaseExpiresAt ?? 0) <= Date.now() ||
          machine.sessionId === undefined || machine.capabilities?.executionMode !== "metadata-only" ||
          machine.capabilities.executionEnabled !== true ||
          (profile.credentialEnv && !machine.capabilities.credentialRefs.includes(profile.credentialEnv))) {
        throw new HttpError(409, "Remote worker assignment is not valid for the current metadata-only node session");
      }
      const active = this.remoteRuntimes.activeForAgent(agentId);
      if (active) {
        if (active.state === "uncertain" || active.state === "stopping") {
          throw new HttpError(409, "Remote runtime ownership is unresolved and requires trusted reconciliation");
        }
        if (active.desired !== "run" || active.machine_id !== machine.id ||
            active.session_id !== machine.sessionId || active.session_epoch !== machine.sessionEpoch ||
            active.epoch !== agent.epoch) {
          throw new HttpError(409, "Remote runtime assignment no longer matches the current owner and node session");
        }
        const activeBinding: WorkerBinding = {
          runtimeId: active.runtime_id, machineId: active.machine_id, sessionId: active.session_id,
          sessionEpoch: active.session_epoch, agentId: active.agent_id, epoch: active.epoch
        };
        try {
          if (this.workerMailbox.inspectBinding(activeBinding).status !== "open") throw new Error("closed");
        } catch {
          throw new HttpError(409, "Remote runtime mailbox binding is no longer open");
        }
        const descriptor = parseWorkerStartSpec(JSON.parse(active.descriptor_json));
        return { binding: descriptor.binding, descriptor, descriptorHash: active.descriptor_hash, existing: true };
      }
      if (this.remoteRuntimes.byAgent(agentId)) {
        throw new HttpError(409, "A prior remote runtime still requires trusted ownership reconciliation");
      }
      const openMailbox = this.db.prepare("SELECT 1 FROM worker_mailbox_bindings WHERE agent_id=? AND status IN ('open','uncertain') LIMIT 1").get(agentId);
      if (openMailbox) throw new HttpError(409, "Remote worker ownership is uncertain and requires reconciliation");
      if (!machine.sessionId || !machine.sessionEpoch) throw new HttpError(409, "Remote node session is unavailable");
      const owned = this.claimAgentOwner(agentId);
      const binding: WorkerBinding = {
        runtimeId: randomUUID(), machineId: machine.id, sessionId: machine.sessionId,
        sessionEpoch: machine.sessionEpoch, agentId: owned.id, epoch: owned.epoch
      };
      const descriptor = parseWorkerStartSpec({
        binding, missionId: mission.id, workspacePath: workspace.path,
        workspaceStrategy: "shared", profile, role
      });
      const assigned = this.remoteRuntimes.assign(descriptor);
      this.workerMailbox.open(binding);
      return { binding, descriptor, descriptorHash: workerStartSpecHash(descriptor), existing: assigned.existing };
    });
  }

  remoteRuntimeReady(binding: WorkerBinding): boolean {
    return this.remoteRuntimes.markReady(binding);
  }

  requestRemoteRuntimeStop(agentId: string): boolean {
    return this.transactionIfNeeded(() => {
      const active = this.remoteRuntimes.activeForAgent(agentId);
      if (!active) return false;
      const binding: WorkerBinding = {
        runtimeId: active.runtime_id, machineId: active.machine_id, sessionId: active.session_id,
        sessionEpoch: active.session_epoch, agentId: active.agent_id, epoch: active.epoch
      };
      this.workerMailbox.fence(binding);
      return this.remoteRuntimes.requestStop(binding);
    });
  }

  nodeEvent(machineId: string, token: string, sessionId: string, sessionEpoch: number, commandId: string, outcome: unknown): NodeCommand {
    return this.machineRegistry.complete(machineId, token, sessionId, sessionEpoch, commandId, outcome);
  }

  fenceStaleWorkerBindings(): void {
    this.transactionIfNeeded(() => {
      const seen = new Set<string>();
      const fence = (binding: WorkerBinding, registered: boolean): void => {
        const machine = this.machineRegistry.get(binding.machineId);
        const agent = this.getAgent(binding.agentId);
        if (machine?.status === "online" && machine.sessionId === binding.sessionId &&
            machine.sessionEpoch === binding.sessionEpoch && (machine.leaseExpiresAt ?? 0) > Date.now() &&
            agent?.machineId === binding.machineId && agent.epoch === binding.epoch) return;
        if (!registered) {
          this.workerMailbox.fence(binding);
          return;
        }
        try { this.workerMailbox.fence(binding); } catch { /* the registered assignment is still fenced below */ }
        this.remoteRuntimes.requestStop(binding);
        if (agent) {
          this.markAgentInterrupted(agent.id, binding.epoch);
          this.insertSystemBlocker(`remote-runtime:${binding.runtimeId}`, agent.missionId, "delivery",
            "Remote runtime ownership or in-flight work requires trusted reconciliation before resuming.");
        }
        seen.add(binding.runtimeId);
      };
      for (const row of this.workerMailbox.inspectBindings()) {
        if (row.status !== "open") continue;
        const binding: WorkerBinding = {
          runtimeId: row.runtimeId, machineId: row.machineId, sessionId: row.sessionId,
          sessionEpoch: row.sessionEpoch, agentId: row.agentId, epoch: row.epoch
        };
        fence(binding, Boolean(this.remoteRuntimes.byRuntime(binding.runtimeId)));
      }
      const runtimes = this.db.prepare("SELECT * FROM remote_worker_runtimes WHERE state IN ('queued','offered','running','stopping','uncertain')")
        .all() as RemoteRuntimeRow[];
      for (const runtime of runtimes) {
        if (seen.has(runtime.runtime_id)) continue;
        fence({
          runtimeId: runtime.runtime_id, machineId: runtime.machine_id, sessionId: runtime.session_id,
          sessionEpoch: runtime.session_epoch, agentId: runtime.agent_id, epoch: runtime.epoch
        }, true);
      }
    });
  }

  private authorizeWorkerMailbox(machineId: string, token: string, sessionId: string, sessionEpoch: number, rawBinding: unknown): WorkerBinding {
    this.machineRegistry.requireSession(machineId, token, sessionId, sessionEpoch);
    this.fenceStaleWorkerBindings();
    const binding = parseWorkerBinding(rawBinding);
    if (!binding) throw new HttpError(400, "Invalid worker binding");
    if (binding.machineId !== machineId || binding.sessionId !== sessionId || binding.sessionEpoch !== sessionEpoch) {
      throw new HttpError(403, "Worker binding does not belong to this node session");
    }
    const agent = this.getAgent(binding.agentId);
    if (!agent || agent.machineId !== machineId || agent.epoch !== binding.epoch) {
      throw new HttpError(409, "Worker binding is not current");
    }
    try {
      if (this.workerMailbox.inspectBinding(binding).status !== "open") throw new Error("fenced");
    } catch {
      throw new HttpError(409, "Worker runtime is not open");
    }
    return binding;
  }

  nodeWorkerUpload(machineId: string, token: string, sessionId: string, sessionEpoch: number, rawBinding: unknown, envelope: unknown): WorkerReceipt {
    const binding = this.authorizeWorkerMailbox(machineId, token, sessionId, sessionEpoch, rawBinding);
    try {
      // Receipt confirms durable arrival only; application dispatch is separate.
      return this.workerMailbox.receive(binding, envelope);
    } catch {
      throw new HttpError(409, "Worker envelope rejected");
    }
  }

  nodeWorkerPoll(machineId: string, token: string, sessionId: string, sessionEpoch: number, rawBinding: unknown): { envelopes: readonly WorkerEnvelope[] } {
    const binding = this.authorizeWorkerMailbox(machineId, token, sessionId, sessionEpoch, rawBinding);
    return { envelopes: this.workerMailbox.pending(binding, 1) };
  }

  nodeWorkerAck(machineId: string, token: string, sessionId: string, sessionEpoch: number, rawBinding: unknown, rawReceipt: unknown): { acknowledged: boolean } {
    const binding = this.authorizeWorkerMailbox(machineId, token, sessionId, sessionEpoch, rawBinding);
    const receipt = parseWorkerReceipt(rawReceipt);
    if (!receipt) throw new HttpError(400, "Invalid worker receipt");
    try {
      return { acknowledged: this.workerMailbox.acknowledge(binding, receipt) };
    } catch {
      throw new HttpError(409, "Worker receipt rejected");
    }
  }

  machineCommand(machineId: string, commandId: string): NodeCommand {
    const command = this.machineRegistry.command(commandId, machineId);
    if (!command) throw new HttpError(404, "Node command not found");
    return command;
  }

  upsertProfile(profile: ModelProfile): ModelProfile {
    if (profile.credentialEnv && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.credentialEnv) || ["PATH", "HOME", "TMPDIR", "LANG", "MC_WORKER_CONFIG"].includes(profile.credentialEnv))) {
      throw new HttpError(400, "Credential environment variable name is invalid or reserved");
    }
    const previous = this.profile(profile.id);
    if (previous && this.listAgents().some((agent) => agent.profileId === profile.id && this.agentHasWork(agent.id))) {
      throw new HttpError(409, "A profile used by a running agent cannot be changed");
    }
    const saved = { ...profile, revision: (previous?.revision ?? 0) + 1 };
    this.transaction(() => {
      this.db.prepare("INSERT INTO profiles(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(saved.id, json(saved));
      this.db.prepare("INSERT INTO profile_revisions(profile_id,revision,data,created_at) VALUES(?,?,?,?)")
        .run(saved.id, saved.revision, json(saved), now());
      for (const agent of this.listAgents().filter((item) => item.profileId === saved.id && ["idle", "offline"].includes(item.status))) {
        this.putAgent({ ...agent, profileRevision: saved.revision, updatedAt: now() });
        this.event(agent.missionId, "agent_profile_changed", "An idle agent's model profile was revised.", agent.id, { profileId: saved.id, profileRevision: saved.revision });
      }
    });
    return saved;
  }

  upsertRole(role: RoleProfile): RoleProfile {
    if (!this.profile(role.profileId)) throw new HttpError(400, "Role references an unknown model profile");
    const previousRow = this.db.prepare("SELECT data FROM roles WHERE id=?").get(role.id) as Row | undefined;
    const previous = previousRow ? decode<RoleProfile>(previousRow.data) : undefined;
    const permissions = role.mcpPermissions === undefined ? previous?.mcpPermissions ?? [] : parseMcpPermissions(role.mcpPermissions);
    for (const permission of permissions) {
      if (!this.mcpServer(permission.serverId)) throw new HttpError(400, `Role references unknown MCP server ${permission.serverId}`);
    }
    role = { ...role, mcpPermissions: permissions };
    if (previous && previous.kind !== role.kind && this.listAgents().some((agent) => agent.roleId === role.id)) {
      throw new HttpError(409, "A role kind cannot change after an agent has been bound to it");
    }
    if (this.listAgents().some((agent) => agent.roleId === role.id && this.agentHasWork(agent.id))) {
      throw new HttpError(409, "A role used by a running agent cannot be changed");
    }
    return this.transaction(() => {
      const revisionRow = this.db.prepare("SELECT MAX(revision) AS revision FROM role_revisions WHERE role_id=?").get(role.id) as { revision: number | null } | undefined;
      const revision = (revisionRow?.revision ?? 0) + 1;
      this.db.prepare("INSERT INTO roles(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(role.id, json(role));
      this.db.prepare("INSERT INTO role_revisions(role_id,revision,data,created_at) VALUES(?,?,?,?)").run(role.id, revision, json(role), now());
      for (const agent of this.listAgents().filter((item) => item.roleId === role.id && ["idle", "offline"].includes(item.status))) {
        const profile = this.profile(role.profileId);
        if (profile) this.putAgent({ ...agent, profileId: profile.id, profileRevision: profile.revision, updatedAt: now() });
      }
      const missions = this.db.prepare("SELECT data FROM missions").all() as Row[];
      for (const missionRow of missions) {
        const mission = decode<Mission>(missionRow.data);
        if (mission.roleIds.includes(role.id)) this.event(mission.id, "role_profile_changed", "A bound role profile was revised.", undefined, {
          roleId: role.id, roleRevision: revision, profileId: role.profileId, modelRevision: this.profile(role.profileId)?.revision
        });
      }
      return role;
    });
  }

  mcpServers(): McpServerConfig[] {
    return (this.db.prepare("SELECT data FROM mcp_servers ORDER BY id").all() as Row[])
      .map((row) => decode<McpServerConfig>(row.data));
  }

  mcpServer(id: string): McpServerConfig | undefined {
    const row = this.db.prepare("SELECT data FROM mcp_servers WHERE id=?").get(id) as Row | undefined;
    return row ? decode<McpServerConfig>(row.data) : undefined;
  }

  async upsertMcpServer(input: unknown): Promise<McpServerConfig> {
    const parsed = parseMcpServer(input);
    const previous = this.mcpServer(parsed.id);
    if (previous && parsed.expectedRevision === undefined) throw new HttpError(400, "Updating an MCP server requires expectedRevision");
    if (previous && parsed.expectedRevision !== previous.revision) throw new HttpError(409, "MCP server revision is stale");
    if (!previous && parsed.expectedRevision !== undefined) throw new HttpError(409, "A new MCP server cannot specify expectedRevision");
    const canonical = { ...parsed };
    delete (canonical as Partial<typeof parsed>).expectedRevision;
    const saved = { ...canonical, revision: (previous?.revision ?? 0) + 1 } as McpServerConfig;
    this.transaction(() => {
      this.db.prepare("INSERT INTO mcp_servers(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(saved.id, json(saved));
      this.db.prepare("INSERT INTO mcp_server_revisions(server_id,revision,data,created_at) VALUES(?,?,?,?)")
        .run(saved.id, saved.revision, json(saved), now());
    });
    if (previous) await this.mcpRuntime.cancelServer(previous.id, previous.revision + 1);
    return saved;
  }

  async discoverMcpServer(id: string, workspaceId: string): Promise<{ serverId: string; revision: number; tools: Array<Record<string, unknown>> }> {
    const config = this.mcpServer(id);
    if (!config || !config.enabled) throw new HttpError(404, "Enabled MCP server not found");
    const workspace = this.workspace(workspaceId);
    if (!workspace) throw new HttpError(404, "Workspace not found");
    if (workspace.machineId !== "local") throw new HttpError(409, "Local MCP discovery requires a local workspace");
    const tools = await this.mcpRuntime.discover(config, workspace.path, { serverId: id, revision: config.revision });
    return { serverId: id, revision: config.revision, tools };
  }

  async listGrantedMcpTools(agentId: string, epoch: number, serverId: string): Promise<Array<Record<string, unknown>>> {
    const agent = this.getAgent(agentId);
    const auth = this.authorizeAgent(agentId, epoch, agent?.missionId ?? "");
    if (auth.mission.status !== "active") throw new HttpError(409, "Mission is not active");
    const roleRevision = this.roleRevision(auth.role.id);
    const serverRevision = this.mcpServer(serverId)?.revision;
    const grants = (auth.role.mcpPermissions ?? []).filter((grant) => grant.serverId === serverId);
    if (!grants.length) throw new HttpError(403, "No MCP tools are granted for this server");
    const config = this.mcpServer(serverId);
    if (!config || !config.enabled) throw new HttpError(404, "Enabled MCP server not found");
    const allowed = new Set(grants.map((grant) => grant.toolName));
    const tools = await this.mcpRuntime.discover(config, agent!.workspacePath, { missionId: agent!.missionId, agentId, serverId, revision: config.revision }, allowed);
    const current = this.getAgent(agentId);
    const currentMission = current ? this.getMission(current.missionId) : undefined;
    const currentRole = current ? this.role(current.roleId) : undefined;
    const currentServer = this.mcpServer(serverId);
    const currentGrants = currentRole?.mcpPermissions?.filter((grant) => grant.serverId === serverId) ?? [];
    if (!current || !currentMission || currentMission.status !== "active" || current.epoch !== epoch ||
      !currentRole || this.roleRevision(currentRole.id) !== roleRevision || currentServer?.revision !== serverRevision ||
      !currentServer || !currentServer.enabled || JSON.stringify(currentGrants) !== JSON.stringify(grants)) {
      throw new HttpError(409, "MCP permission scope changed during discovery");
    }
    return tools.filter((tool) => typeof tool.name === "string" && allowed.has(tool.name));
  }

  addWorkspace(name: string, realPath: string): Workspace {
    const workspace: Workspace = { id: randomUUID(), name, path: realPath, machineId: "local" };
    this.db.prepare("INSERT INTO workspaces(id,data) VALUES(?,?)").run(workspace.id, json(workspace));
    return workspace;
  }

  addRemoteWorkspace(name: string, machineId: string, probeCommandId: string): Workspace {
    const displayName = parseNonEmptyString(name, "name", 120);
    return this.command(`node:${machineId}:workspaces`, probeCommandId, { name: displayName, machineId }, () => {
      const receipt = this.machineRegistry.workspaceReceipt(machineId, probeCommandId);
      const workspace: Workspace = {
        id: randomUUID(), name: displayName, machineId, path: receipt.path,
        probe: {
          commandId: probeCommandId, sessionEpoch: receipt.sessionEpoch,
          requestedPath: receipt.requestedPath, verifiedAt: receipt.verifiedAt
        }
      };
      this.db.prepare("INSERT INTO workspaces(id,data) VALUES(?,?)").run(workspace.id, json(workspace));
      return workspace;
    });
  }

  createMission(input: CreateMissionInput): Mission {
    const parsed = parseCreateMissionInput(input);
    const { assertions: inputAssertions, ...missionInput } = parsed;
    const assertions = (inputAssertions ?? [{ id: "REQ-001", description: parsed.acceptance }]).map((item) => ({
      ...item,
      revision: 1
    }));
    if (!this.workspace(parsed.workspaceId)) throw new HttpError(400, "Unknown workspace");
    if (this.workspace(parsed.workspaceId)!.machineId !== "local") throw new HttpError(409, "The Mission delivery workspace must be local; remote workspaces are execution targets only");
    for (const workspaceId of parsed.remoteWorkspaceIds ?? []) {
      const workspace = this.workspace(workspaceId);
      if (!workspace) throw new HttpError(400, `Unknown remote workspace ${workspaceId}`);
      if (workspace.machineId === "local" || !workspace.probe) {
        throw new HttpError(409, "Mission remote workspaces must be registered remote workspaces with probe provenance");
      }
    }
    const roles = parsed.roleIds.map((id) => this.role(id));
    if (roles.some((role) => !role)) throw new HttpError(400, "Mission references an unknown role");
    const roleKinds = roles.map((role) => role!.kind);
    if (roleKinds.filter((kind) => kind === "orchestrator").length !== 1 ||
      !roleKinds.includes("worker") || !roleKinds.includes("validator")) {
      throw new HttpError(400, "A mission requires unique roles, exactly one orchestrator, at least one worker, and at least one validator role");
    }
    const profiles = roles.map((role) => this.profile(role!.profileId));
    if (profiles.some((profile) => !profile?.toolCalling)) throw new HttpError(409, "Every mission role must use a model profile with tool calling enabled");
    const mission: Mission = {
      ...missionInput,
      id: randomUUID(),
      status: "draft",
      createdAt: now(),
      updatedAt: now(),
      turns: 0,
      cost: 0,
      costKnown: profiles.every((profile) => profile?.cost !== undefined),
      contractRevision: 1
    };
    return this.transaction(() => {
      this.putMission(mission);
      const contract: ValidationContract = { missionId: mission.id, revision: 1, assertions, createdAt: now() };
      this.db.prepare("INSERT INTO validation_contracts(mission_id,revision,data,created_at) VALUES(?,?,?,?)")
        .run(mission.id, contract.revision, json(contract), contract.createdAt);
      this.event(mission.id, "mission_created", "Mission draft created.", undefined, { contractRevision: 1, assertionIds: assertions.map((item) => item.id) });
      return mission;
    });
  }

  patchMission(id: string, title: string): Mission {
    const mission = this.getMission(id);
    if (!mission) throw new HttpError(404, "Mission not found");
    const updated = { ...mission, title, updatedAt: now() };
    this.putMission(updated);
    this.event(id, "mission_updated", `Mission title updated.`);
    return updated;
  }

  updateMissionLimits(id: string, maxTurns?: number, maxCost?: number): Mission {
    const mission = this.getMission(id);
    if (!mission) throw new HttpError(404, "Mission not found");
    if (!["draft", "paused", "blocked", "failed"].includes(mission.status)) throw new HttpError(409, "Limits may only be changed while a mission is stopped");
    if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < Math.max(1, mission.turns))) throw new HttpError(400, "maxTurns must be a positive safe integer at least as large as turns already used");
    if (maxCost !== undefined && (!Number.isFinite(maxCost) || maxCost < 0)) throw new HttpError(400, "maxCost must be a finite number >= 0");
    if (maxCost !== undefined && maxCost > 0 && !mission.costKnown) throw new HttpError(409, "Cannot set an enforced cost limit while model rates are unknown");
    const updated = { ...mission, ...(maxTurns === undefined ? {} : { maxTurns }), ...(maxCost === undefined ? {} : { maxCost }), updatedAt: now() };
    this.putMission(updated);
    this.event(id, "mission_limits_changed", "Mission limits changed by the user.", undefined, { maxTurns: updated.maxTurns, maxCost: updated.maxCost });
    return updated;
  }

  missionAction(id: string, action: "start" | "pause" | "resume" | "cancel"): Mission {
    const mission = this.getMission(id);
    if (!mission) throw new HttpError(404, "Mission not found");
    if (action === "start") {
      return this.command(`mission:${id}:lifecycle`, "mission-start", { action }, () => {
        const current = this.getMission(id);
        if (!current) throw new HttpError(404, "Mission not found");
        if (current.status !== "draft") throw new HttpError(409, "Only a draft mission can start");
        const workspace = this.workspace(current.workspaceId);
        if (!workspace) throw new HttpError(409, "Mission workspace is missing");
        if (workspace.machineId !== "local") throw new HttpError(409, "The Mission delivery workspace must be local");
        let repository: RepositoryIdentity | undefined;
        if (current.workspaceStrategy === "worktree") {
          try {
            repository = inspectRepository(workspace.path);
          } catch (error) {
            throw new HttpError(409, error instanceof Error ? error.message : "Worktree mode requires a valid local Git repository");
          }
        }
        const orchestratorRole = current.roleIds.map((roleId) => this.role(roleId)).find((role) => role?.kind === "orchestrator");
        if (!orchestratorRole) throw new HttpError(409, "Mission needs an orchestrator role");
        if (current.maxCost > 0 && !current.costKnown) throw new HttpError(409, "Cannot enforce a cost limit until every bound profile has explicit rates");
        const profile = this.profile(orchestratorRole.profileId);
        if (!profile) throw new HttpError(409, "Mission workspace or orchestrator model profile is missing");
        if (profile.credentialEnv && !process.env[profile.credentialEnv]) throw new HttpError(409, `Missing required credential ${profile.credentialEnv}`);
        if (!profile.toolCalling) throw new HttpError(409, "Orchestrator profile does not support tool calling");
        const started = {
          ...current,
          status: "active" as const,
          ...(repository ? { repository } : {}),
          updatedAt: now()
        };
        this.putMission(started);
        const orchestrator = this.createAgentRecord(id, `Orchestrator — ${orchestratorRole.name}`, orchestratorRole.id);
        this.putMission({ ...started, orchestratorId: orchestrator.id, updatedAt: now() });
        const enabledRoles = current.roleIds.map((roleId) => {
          const role = this.role(roleId);
          const roleProfile = role ? this.profile(role.profileId) : undefined;
          if (!role || !roleProfile) throw new HttpError(409, `Enabled role ${roleId} has no model profile`);
          if (role.kind !== "worker" && roleProfile.credentialEnv && !process.env[roleProfile.credentialEnv]) {
            throw new HttpError(409, `Missing required credential ${roleProfile.credentialEnv}`);
          }
          if (!roleProfile.toolCalling) throw new HttpError(409, `Role ${role.name} requires a tool-calling model`);
          return `${role.id} (${role.name}; ${roleProfile.name}; model ${roleProfile.modelId})`;
        });
        const opening = [
          `Mission: ${current.title}`,
          `Mission ID: ${current.id}`,
          `Your agent ID: ${orchestrator.id}`,
          `Goal: ${current.goal}`,
          `Acceptance criteria: ${current.acceptance}`,
          `Workspace: ${workspace.path}`,
          `Enabled roles and models:`,
          ...enabledRoles.map((role) => `- ${role}`)
        ].join("\n");
        const message: Message = {
          id: `mission-opening:${current.id}`,
          missionId: id,
          senderId: "user",
          recipientId: orchestrator.id,
          content: opening,
          mode: "followUp",
          status: "queued",
          attempt: 1,
          createdAt: now()
        };
        this.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, id, message.status, json(message));
        this.enqueue(message);
        this.event(id, "mission_started", "Mission started with one orchestrator and one durable opening message.", orchestrator.id, { messageId: message.id, requestId: `${message.id}:1` });
        return { ...started, orchestratorId: orchestrator.id };
      });
    } else if (action === "pause" && !["active", "blocked", "validating"].includes(mission.status)) {
      throw new HttpError(409, "Only an active mission can be paused");
    } else if (action === "resume" && !["paused", "blocked", "failed"].includes(mission.status)) {
      throw new HttpError(409, "Only a paused, blocked, or failed mission can resume");
    } else if (action === "resume" && this.blockers(id).some((blocker) => blocker.status === "open")) {
      throw new HttpError(409, "Resolve mission blockers before resuming");
    } else if (action === "resume" && mission.turns >= mission.maxTurns) {
      throw new HttpError(409, "Mission turn limit has been reached");
    } else if (action === "resume" && mission.costKnown && mission.maxCost > 0 && mission.cost >= mission.maxCost) {
      throw new HttpError(409, "Mission cost limit has been reached");
    } else if (action === "cancel" && ["completed", "cancelled"].includes(mission.status)) {
      throw new HttpError(409, "Mission is already terminal");
    }
    return this.transaction(() => {
    const status: Mission["status"] = action === "resume" ? "active" : action === "pause" ? "paused" : "cancelled";
    const updated = { ...mission, status, updatedAt: now() };
    this.putMission(updated);
    if (action === "pause" || action === "cancel") {
      this.db.prepare("UPDATE outbox SET status='aborted' WHERE mission_id=? AND status='queued'").run(id);
      this.db.prepare("UPDATE outbox SET status='uncertain',deadline_at=NULL WHERE mission_id=? AND status IN ('dispatching','admitted')").run(id);
      const messages = this.db.prepare("SELECT data FROM messages WHERE mission_id=? AND status IN ('queued','dispatching','admitted','delivering','delivered')").all(id) as Row[];
      for (const row of messages) {
        const message = decode<Message>(row.data);
        const uncertain = message.status === "delivered" || this.db.prepare("SELECT 1 FROM outbox WHERE message_id=? AND status='uncertain' LIMIT 1").get(message.id);
        const next = { ...message, status: uncertain ? "uncertain" : "aborted", error: uncertain ? "Delivery state is uncertain after " + action : "Delivery aborted by mission " + action };
        this.db.prepare("UPDATE messages SET status=?,data=? WHERE id=?").run(next.status, json(next), next.id);
        this.event(id, uncertain ? "delivery_uncertain" : "delivery_aborted", `Delivery ${next.id} ${uncertain ? "may have reached" : "was not admitted to"} the worker before ${action}.`, undefined, { messageId: next.id, attempt: next.attempt });
      }
    }
    if (action === "resume") {
      this.releaseHeldMessages(id);
    }
    const eventType = { pause: "mission_paused", resume: "mission_resumed", cancel: "mission_cancelled" }[action];
    this.event(id, eventType, `Mission ${action} requested.`);
    return updated;
    });
  }

  private releaseHeldMessages(missionId: string): void {
    const rows = this.db.prepare("SELECT data FROM messages WHERE mission_id=? AND status='aborted'").all(missionId) as Row[];
    for (const row of rows) {
      const old = decode<Message>(row.data);
      const message: Message = { ...old, status: "queued", attempt: old.attempt + 1 };
      delete message.error;
      this.db.prepare("UPDATE messages SET status=?,data=? WHERE id=?").run(message.status, json(message), message.id);
      this.enqueue(message);
      this.event(missionId, "delivery_resumed", `Delivery ${message.id} resumed as attempt ${message.attempt}.`, undefined, { messageId: message.id, attempt: message.attempt });
    }
  }

  listAgents(missionId?: string): Agent[] {
    const rows = missionId
      ? this.db.prepare("SELECT data FROM agents WHERE mission_id=?").all(missionId)
      : this.db.prepare("SELECT data FROM agents").all();
    return (rows as Row[]).map((row) => decode<Agent>(row.data));
  }

  createAgent(missionId: string, title: string, roleId: string, prompt: string, requestId: string, targetWorkspaceId?: string): Agent {
    const payload = { missionId, title, roleId, prompt, ...(targetWorkspaceId === undefined ? {} : { targetWorkspaceId }) };
    return this.command(`mission:${missionId}:agents`, requestId, payload, () => {
      const mission = this.getMission(missionId);
      if (!mission || ["cancelled", "completed", "failed"].includes(mission.status)) throw new HttpError(409, "Mission is not accepting new agents");
      const agent = this.createAgentRecord(missionId, title, roleId, targetWorkspaceId);
      if (prompt.trim()) {
        const message: Message = {
          id: `agent-opening:${missionId}:${requestId}`,
          missionId,
          senderId: "user",
          recipientId: agent.id,
          content: prompt,
          mode: "followUp",
          status: mission.status === "paused" ? "aborted" : "queued",
          attempt: 1,
          createdAt: now()
        };
        this.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, missionId, message.status, json(message));
        if (message.status === "queued") this.enqueue(message);
      }
      return agent;
    });
  }

  private createAgentRecord(missionId: string, title: string, roleId: string, targetWorkspaceId?: string): Agent {
    const mission = this.getMission(missionId);
    const role = this.role(roleId);
    if (!mission || !role) throw new HttpError(404, "Mission or role not found");
    if (!mission.roleIds.includes(roleId)) throw new HttpError(403, "Role is not enabled for this mission");
    if (role.kind === "orchestrator" && this.listAgents(missionId).some((agent) => agent.kind === "orchestrator")) throw new HttpError(409, "Mission already has an orchestrator");
    const profile = this.profile(role.profileId);
    if (!profile) throw new HttpError(400, "Role model profile is missing");
    const workspaceId = targetWorkspaceId ?? mission.workspaceId;
    const workspace = this.workspace(workspaceId);
    if (!workspace) throw new HttpError(409, "Agent workspace is unavailable");
    if (workspace.machineId === "local" && profile.credentialEnv && !process.env[profile.credentialEnv]) {
      throw new HttpError(409, `Missing required credential ${profile.credentialEnv}`);
    }
    if (workspaceId === mission.workspaceId) {
      if (workspace.machineId !== "local") throw new HttpError(409, "The Mission delivery workspace must be local");
    } else {
      if (!mission.remoteWorkspaceIds?.includes(workspaceId)) throw new HttpError(409, "Target workspace is not allowed for this Mission");
      if (workspace.machineId === "local" || !workspace.probe) {
        throw new HttpError(409, "Mission remote workspaces must be registered remote workspaces with probe provenance");
      }
      if (role.kind !== "worker") throw new HttpError(409, "Remote targets are only available to worker agents");
      if (mission.workspaceStrategy === "worktree") throw new HttpError(409, "Remote worktrees are not supported yet");
      const machine = this.machineRegistry.get(workspace.machineId);
      if (machine?.status !== "online" ||
        (machine.leaseExpiresAt ?? 0) <= Date.now() ||
        !machine.sessionId || !machine.sessionEpoch ||
        machine.capabilities?.executionEnabled !== true ||
        machine.capabilities.executionMode !== "metadata-only") {
        throw new HttpError(409, "Remote execution is not enabled on this machine");
      }
      if (profile.credentialEnv && !machine.capabilities.credentialRefs.includes(profile.credentialEnv)) {
        throw new HttpError(409, "Remote node has not declared this model credential reference");
      }
      parseWorkerStartSpec({
        binding: {
          runtimeId: randomUUID(), machineId: workspace.machineId,
          sessionId: machine.sessionId ?? randomUUID(), sessionEpoch: machine.sessionEpoch || 1,
          agentId: randomUUID(), epoch: 1
        },
        missionId: mission.id, workspacePath: workspace.path, workspaceStrategy: "shared", profile, role
      });
    }
    const id = randomUUID();
    const worktree = mission.workspaceStrategy === "worktree"
      ? this.newAgentWorktreeRecord(mission, id)
      : undefined;
    const agent: Agent = {
      id,
      missionId,
      title,
      roleId,
      kind: role.kind,
      profileId: profile.id,
      profileRevision: profile.revision,
      status: mission.status === "active" ? "recovering" : "idle",
      epoch: 1,
      workspacePath: worktree?.path ?? workspace.path,
      workspaceId: workspace.id,
      machineId: workspace.machineId,
      createdAt: now(),
      updatedAt: now(),
      ...(worktree ? { worktreeId: worktree.id } : {})
    };
    this.db.prepare("INSERT INTO agents(id,mission_id,status,epoch,data) VALUES(?,?,?,?,?)").run(agent.id, missionId, agent.status, agent.epoch, json(agent));
    if (worktree) this.saveWorktree(worktree);
    if (role.kind === "orchestrator") this.putMission({ ...mission, orchestratorId: agent.id, updatedAt: now() });
    this.event(missionId, "agent_created", `Agent ${title} created.`, agent.id, { roleId });
    return agent;
  }

  private newAgentWorktreeRecord(mission: Mission, agentId: string): WorktreeRecord {
    if (!mission.repository) throw new HttpError(409, "Worktree repository was not pinned before Mission start");
    return {
      id: `agent:${agentId}`,
      missionId: mission.id,
      kind: "agent",
      agentId,
      path: join(resolve(this.home), "worktrees", mission.id, agentId),
      branch: `mission-control/${mission.id}/${agentId}`,
      baseCommit: mission.repository.baseCommit,
      repositoryPath: mission.repository.path,
      gitCommonDir: mission.repository.gitCommonDir,
      status: "pending",
      createdAt: now()
    };
  }

  private saveWorktree(record: WorktreeRecord): void {
    this.db.prepare(`
      INSERT INTO worktrees(id,mission_id,status,data) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data
    `).run(record.id, record.missionId, record.status, json(record));
  }

  private worktree(id: string): WorktreeRecord | undefined {
    const row = this.db.prepare("SELECT data FROM worktrees WHERE id=?").get(id) as Row | undefined;
    return row ? decode<WorktreeRecord>(row.data) : undefined;
  }

  listWorktrees(missionId: string): WorktreeRecord[] {
    const rows = this.db.prepare("SELECT data FROM worktrees WHERE mission_id=? ORDER BY id").all(missionId) as Row[];
    return rows.map((row) => decode<WorktreeRecord>(row.data));
  }

  prepareAgentWorkspace(agentId: string): Agent {
    const agent = this.getAgent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    const mission = this.getMission(agent.missionId);
    if (!mission || mission.workspaceStrategy !== "worktree") return agent;
    if (!mission.repository || !agent.worktreeId) throw new HttpError(409, "Worktree repository or agent record is missing");
    const record = this.worktree(agent.worktreeId);
    if (!record || record.kind !== "agent" || record.agentId !== agent.id) throw new HttpError(409, "Agent worktree journal is missing");
    const repository: RepositoryIdentity = mission.repository;
    if (record.repositoryPath !== repository.path || record.gitCommonDir !== repository.gitCommonDir || record.baseCommit !== repository.baseCommit) {
      throw new HttpError(409, "Agent worktree record no longer matches the pinned repository identity");
    }
    const fail = (message: string): never => {
      const updated = { ...record, status: "error" as const, error: message, checkedAt: now() };
      this.saveWorktree(updated);
      this.putAgent({ ...agent, error: message, updatedAt: now() });
      this.event(mission.id, "worktree_error", message, agent.id, { worktreeId: record.id, path: record.path, branch: record.branch });
      throw new HttpError(409, message);
    };
    try {
      const expectedPath = join(resolve(this.home), "worktrees", mission.id, agent.id);
      if (resolve(record.path) !== expectedPath) return fail("Agent worktree escaped its predetermined home directory");
      if (realpathSync(repository.path) !== repository.path) return fail("Pinned source repository path was replaced or redirected");
      if (repositoryCommonDir(repository.path) !== repository.gitCommonDir) return fail("Pinned Git common directory changed");
      if (agent.workspacePath !== record.path) return fail("Agent workspace path no longer matches its durable worktree record");
      const registered = listWorktrees(repository.path).find((item) => resolve(item.path) === resolve(record.path));
      if (record.status === "ready") {
        if (!registered) return fail("Ready worktree is no longer registered; files and branch were preserved");
        verifyWorktree(repository, record.path, { ...(record.branch ? { branch: record.branch } : {}) });
      } else {
        if (record.status === "error") throw new HttpError(409, record.error ?? "Worktree preparation previously failed; human reconciliation is required");
        if (registered) {
          if (registered.head !== record.baseCommit || registered.branch !== record.branch) {
            return fail("Pending worktree registration does not prove the expected base commit and branch");
          }
          verifyWorktree(repository, record.path, { ...(record.branch ? { branch: record.branch } : {}), commit: record.baseCommit });
        } else {
          let pathPresent = false;
          try { lstatSync(record.path); pathPresent = true; } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (pathPresent) return fail("Predetermined worktree path already exists but is not registered; it was preserved");
          if (record.branch && branchExists(repository.path, record.branch)) return fail("Predetermined worktree branch is occupied; it was preserved");
          ensureWorktreeParent(this.home, record.path);
          addAgentWorktree(repository, record.path, record.branch!);
          verifyWorktree(repository, record.path, { ...(record.branch ? { branch: record.branch } : {}), commit: record.baseCommit });
        }
        const ready: WorktreeRecord = { ...record, status: "ready", checkedAt: now() };
        delete ready.error;
        this.saveWorktree(ready);
        const updatedAgent: Agent = { ...agent, workspacePath: ready.path, updatedAt: now() };
        delete updatedAgent.error;
        this.putAgent(updatedAgent);
        this.event(mission.id, "worktree_ready", "Agent worktree is ready.", agent.id, { worktreeId: ready.id, path: ready.path, branch: ready.branch, baseCommit: ready.baseCommit });
        return updatedAgent;
      }
      const checked = { ...record, checkedAt: now() };
      this.saveWorktree(checked);
      return agent;
    } catch (error) {
      if (error instanceof HttpError && record.status === "error") throw error;
      return fail(`Worktree could not be verified safely: ${error instanceof Error ? error.message : "unknown Git error"}`);
    }
  }

  getMissionState(agentId: string, epoch: number): MissionStateView & Pick<MissionDetail, "artifacts" | "validationReceipts" | "blockers"> {
    const { mission } = this.authorizeAgent(agentId, epoch, this.getAgent(agentId)?.missionId ?? "");
    const agent = this.getAgent(agentId)!;
    const role = this.role(agent.roleId);
    const detail = this.detail(mission.id);
    const remoteWorkspaces = (mission.remoteWorkspaceIds ?? []).map((workspaceId) => {
      const workspace = this.workspace(workspaceId);
      if (!workspace) throw new HttpError(409, `Mission remote workspace ${workspaceId} is unavailable`);
      const machine = this.machineRegistry.get(workspace.machineId);
      return {
        id: workspace.id,
        name: workspace.name,
        machineId: workspace.machineId,
        path: workspace.path,
        executionEnabled: machine?.status === "online" &&
          (machine.leaseExpiresAt === undefined || machine.leaseExpiresAt > Date.now()) &&
          Boolean(machine.capabilities?.executionEnabled),
        ...(machine?.capabilities?.executionMode ? { executionMode: machine.capabilities.executionMode } : {})
      };
    });
    const roles = mission.roleIds.map((roleId) => {
      const role = this.role(roleId);
      const profile = role ? this.profile(role.profileId) : undefined;
      if (!role || !profile) throw new HttpError(409, `Enabled role ${roleId} has no model profile`);
      return { roleId: role.id, name: role.name, kind: role.kind, profileId: profile.id, modelName: profile.name, modelId: profile.modelId, profileRevision: profile.revision };
    });
    return {
      mission, tasks: detail.tasks, roles, agents: detail.agents, approvals: detail.approvals,
      artifacts: detail.artifacts, validationReceipts: detail.validationReceipts ?? [], blockers: detail.blockers ?? [],
      remoteWorkspaces,
      worktrees: detail.worktrees ?? [],
      mcpServers: [...new Set((role?.mcpPermissions ?? []).map((grant) => grant.serverId))].flatMap((serverId) => {
        const server = this.mcpServer(serverId);
        const tools = (role?.mcpPermissions ?? []).filter((grant) => grant.serverId === serverId)
          .map((grant) => ({ toolName: grant.toolName, mode: grant.mode }));
        return server ? [{ id: server.id, name: server.name, revision: server.revision, tools }] : [];
      }),
      ...(detail.validationContract ? { validationContract: detail.validationContract, requirementCoverage: detail.requirementCoverage ?? [] } : {})
    };
  }

  private requirementCoverage(missionId: string): RequirementCoverage[] {
    const contract = this.validationContract(missionId);
    if (!contract) return [];
    const tasks = this.db.prepare("SELECT data FROM tasks WHERE mission_id=?").all(missionId) as Row[];
    const taskValues = tasks.map((row) => decode<Task>(row.data));
    const validations = this.db.prepare("SELECT data FROM validations WHERE mission_id=? ORDER BY rowid").all(missionId) as Row[];
    const validationValues = validations.map((row) => decode<Validation>(row.data));
    const receipts = new Map(this.detailValidationReceipts(missionId).map((receipt) => [receipt.id, receipt]));
    return contract.assertions.map((assertion) => {
      const owners = taskValues.filter((task) => (task.fulfills ?? []).includes(assertion.id));
      if (owners.length !== 1) return { assertion, status: "unassigned" };
      const task = owners[0]!;
      const latest = validationValues.filter((validation) => validation.taskId === task.id).at(-1);
      const receipt = latest?.receiptId ? receipts.get(latest.receiptId) : undefined;
      const claims = task.fulfills ?? [];
      const claimed = claims.map((id) => contract.assertions.find((item) => item.id === id)).filter((item): item is Requirement => item !== undefined);
      const revisions = Object.fromEntries(claimed.map((item) => [item.id, item.revision]));
      const currentScope = (value: Record<string, number> | undefined): boolean => {
        if (!value || claimed.length !== claims.length || new Set(claims).size !== claims.length) return false;
        return Object.keys(value).length === Object.keys(revisions).length && Object.entries(revisions).every(([id, revision]) => value[id] === revision);
      };
      const results = latest?.assertionResults;
      const resultMatches = results?.filter((item) => item.assertionId === assertion.id) ?? [];
      const result = resultMatches.length === 1 ? resultMatches[0] : undefined;
      const resultsCurrent = Boolean(results && results.length === claims.length && claims.every((id) => {
        const matches = results.filter((item) => item.assertionId === id);
        return matches.length === 1 && ["passed", "failed", "untested"].includes(matches[0]!.status) && Boolean(matches[0]!.evidence.trim());
      }));
      const revisionScopeCurrent = currentScope(latest?.requirementRevisions) && currentScope(receipt?.requirementRevisions);
      const attemptCurrent = Boolean(latest && (latest.attempt === task.attempt || (!latest.passed && latest.attempt === task.attempt - 1)));
      const receiptApplies = Boolean(latest && receipt && latest.receiptId === receipt.id && receipt.taskId === task.id &&
        receipt.validatorId === latest.agentId && receipt.attempt === latest.attempt && receipt.taskRevision === latest.taskRevision &&
        latest.taskRevision === (task.revision ?? 0) && attemptCurrent && revisionScopeCurrent && resultsCurrent);
      if (receiptApplies && latest && result?.status === "failed") {
        return {
          assertion, taskId: task.id, status: "failed", validationId: latest.id,
          ...(latest.receiptId ? { receiptId: latest.receiptId } : {})
        };
      }
      const passed = Boolean(latest && receipt && task.status === "accepted" && latest.passed === true && latest.attempt === task.attempt &&
        latest.taskRevision === (task.revision ?? 0) && receipt?.attempt === task.attempt &&
        receipt.taskRevision === (task.revision ?? 0) && receipt.exitCode === 0 && receiptApplies &&
        result?.status === "passed" && Boolean(result.evidence.trim()));
      return {
        assertion, taskId: task.id, status: passed ? "passed" : "pending",
        ...(receiptApplies && latest ? { validationId: latest.id } : {}),
        ...(receiptApplies && receipt ? { receiptId: receipt.id } : {})
      };
    });
  }

  private detailValidationReceipts(missionId: string): ValidationReceipt[] {
    const rows = this.db.prepare("SELECT data FROM validation_receipts WHERE mission_id=? ORDER BY rowid").all(missionId) as Row[];
    return rows.map((row) => decode<ValidationReceipt>(row.data));
  }

  updateAgentProfile(agentId: string, profileId: string): Agent {
    const agent = this.getAgent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    if (agent.status !== "idle" && agent.status !== "offline") throw new HttpError(409, "Profile can only change while agent is idle");
    if (this.agentHasWork(agentId)) throw new HttpError(409, "Profile cannot change while the agent has queued or in-flight work");
    const role = this.role(agent.roleId);
    const profile = this.profile(profileId);
    if (!role || !profile) throw new HttpError(400, "Unknown role or model profile");
    const mission = this.getMission(agent.missionId);
    if (mission) {
      const profiles = [
        ...mission.roleIds.map((id) => this.profile(this.role(id)?.profileId ?? "")),
        ...this.listAgents(agent.missionId).map((item) => this.profile(item.id === agent.id ? profileId : item.profileId))
      ];
      const costKnown = profiles.every((item) => item?.cost !== undefined);
      if (mission.maxCost > 0 && !costKnown) throw new HttpError(409, "Cannot bind an unpriced profile while a mission cost limit is configured");
      this.putMission({ ...mission, costKnown, updatedAt: now() });
    }
    const updated = { ...agent, profileId, profileRevision: profile.revision, updatedAt: now() };
    this.putAgent(updated);
    this.event(agent.missionId, "agent_profile_changed", "Agent profile changed.", agent.id, { profileId, profileRevision: profile.revision });
    return updated;
  }

  private agentHasWork(agentId: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM messages m JOIN outbox o ON o.message_id=m.id " +
      "WHERE json_extract(m.data,'$.recipientId')=? AND o.status IN ('queued','dispatching','admitted') LIMIT 1"
    ).get(agentId));
  }

  sendMessage(missionId: string, recipientId: string, content: string, mode: "steer" | "followUp", requestId: string): Message {
    return this.command(`mission:${missionId}:messages`, requestId, { recipientId, content, mode }, () => {
      const mission = this.getMission(missionId);
      const recipient = this.getAgent(recipientId);
      if (!mission || !recipient || recipient.missionId !== missionId) throw new HttpError(404, "Recipient not found in this mission");
      if (["cancelled", "completed", "failed"].includes(mission.status)) throw new HttpError(409, "Mission is not accepting messages");
      const message: Message = {
        id: randomUUID(),
        missionId,
        senderId: "user",
        recipientId,
        content,
        mode,
        status: mission.status === "paused" ? "aborted" : "queued",
        attempt: 1,
        createdAt: now(),
        ...(mission.status === "paused" ? { error: "Held while mission is paused; delivery will start after explicit resume" } : {})
      };
      this.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, missionId, message.status, json(message));
      if (mission.status !== "paused") this.enqueue(message);
      this.event(missionId, "message_created", `User message queued for ${recipient.title}.`, recipient.id, { messageId: message.id });
      return message;
    });
  }

  private enqueue(message: Message): void {
    const requestId = `${message.id}:${message.attempt}`;
    this.db.prepare("INSERT OR IGNORE INTO outbox(id,mission_id,message_id,attempt,request_id,status,epoch,created_at,error) VALUES(?,?,?,?,?,'queued',?,?,NULL)")
      .run(randomUUID(), message.missionId, message.id, message.attempt, requestId, 0, now());
  }

  private scheduleRow(id: string, missionId?: string): ScheduleRow | undefined {
    return (missionId
      ? this.db.prepare("SELECT * FROM mission_schedules WHERE id=? AND mission_id=?").get(id, missionId)
      : this.db.prepare("SELECT * FROM mission_schedules WHERE id=?").get(id)) as ScheduleRow | undefined;
  }

  private scheduleFromRow(row: ScheduleRow): MissionSchedule {
    let schedule: ScheduleSpec;
    let corrupt = false;
    try {
      const decoded = decode<unknown>(row.schedule);
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
        const candidate = decoded as Record<string, unknown>;
        if (candidate.kind === "once" && typeof candidate.at === "string") {
          schedule = { kind: "once", at: candidate.at };
        } else if (candidate.kind === "cron" && typeof candidate.expression === "string" && typeof candidate.timeZone === "string") {
          schedule = { kind: "cron", expression: candidate.expression, timeZone: candidate.timeZone };
        } else {
          throw new Error("invalid schedule");
        }
      } else {
        throw new Error("invalid schedule");
      }
    } catch {
      schedule = { kind: "once", at: "" };
      corrupt = true;
    }
    return {
      id: row.id,
      missionId: row.mission_id,
      name: row.name,
      prompt: row.prompt,
      schedule,
      status: row.status,
      revision: row.revision,
      ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
      ...(row.last_occurrence_id === null ? {} : { lastOccurrenceId: row.last_occurrence_id }),
      ...(row.reason !== null ? { reason: row.reason } : corrupt ? { reason: "invalid_schedule" } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private validateScheduleText(value: string, name: string, max: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      throw new HttpError(400, `${name} must be a non-empty string of at most ${max} characters`);
    }
    return value;
  }

  private validateScheduleRevision(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, "expectedRevision must be a positive safe integer");
    return value;
  }

  private assertScheduleMission(missionId: string): Mission {
    const mission = this.getMission(missionId);
    if (!mission) throw new HttpError(404, "Mission not found");
    if (mission.status === "completed" || mission.status === "cancelled") {
      throw new HttpError(409, "Completed or cancelled missions cannot be scheduled");
    }
    return mission;
  }

  private assertScheduleRevision(row: ScheduleRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) throw new HttpError(409, `Schedule revision conflict; expected ${row.revision}`);
    if (row.status === "deleted") throw new HttpError(409, "Schedule has been deleted");
  }

  createSchedule(
    missionId: string,
    requestId: string,
    name: string,
    prompt: string,
    schedule: unknown,
    enabled = false
  ): MissionSchedule {
    const validName = this.validateScheduleText(name, "name", 160);
    const validPrompt = this.validateScheduleText(prompt, "prompt", 10000);
    if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be boolean");
    const payload = { missionId, name: validName, prompt: validPrompt, schedule, enabled };
    return this.command(`mission:${missionId}:schedules`, requestId, payload, () => {
      const mission = this.assertScheduleMission(missionId);
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM mission_schedules WHERE mission_id=? AND status<>'deleted'").get(missionId) as { count: number }).count;
      if (count >= 100) throw new HttpError(409, "A mission may have at most 100 nondeleted schedules");
      let parsed: { schedule: ScheduleSpec; nextRunAt: string };
      try {
        parsed = parseScheduleSpec(schedule);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Invalid schedule");
      }
      const createdAt = now();
      const saved: MissionSchedule = {
        id: randomUUID(),
        missionId,
        name: validName,
        prompt: validPrompt,
        schedule: parsed.schedule,
        status: enabled ? "enabled" : "held",
        revision: 1,
        nextRunAt: parsed.nextRunAt,
        ...(enabled ? {} : { reason: "manual_hold" }),
        createdAt,
        updatedAt: createdAt
      };
      this.db.prepare(`
        INSERT INTO mission_schedules(id,mission_id,name,prompt,schedule,status,revision,next_run_at,last_occurrence_id,reason,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        saved.id, mission.id, saved.name, saved.prompt, json(saved.schedule), saved.status, saved.revision,
        saved.nextRunAt ?? null, null, saved.reason ?? null, saved.createdAt, saved.updatedAt
      );
      this.event(missionId, "schedule_created", `Schedule ${saved.name} was created.`, undefined, { scheduleId: saved.id, status: saved.status, revision: saved.revision });
      return saved;
    });
  }

  updateSchedule(
    missionId: string,
    scheduleId: string,
    requestId: string,
    expectedRevision: number,
    name: string,
    prompt: string,
    schedule: unknown,
    enabled: boolean
  ): MissionSchedule {
    const validName = this.validateScheduleText(name, "name", 160);
    const validPrompt = this.validateScheduleText(prompt, "prompt", 10000);
    this.validateScheduleRevision(expectedRevision);
    if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be boolean");
    const payload = { missionId, scheduleId, expectedRevision, name: validName, prompt: validPrompt, schedule, enabled };
    return this.command(`mission:${missionId}:schedules`, requestId, payload, () => {
      this.assertScheduleMission(missionId);
      const current = this.scheduleRow(scheduleId, missionId);
      if (!current) throw new HttpError(404, "Schedule not found");
      this.assertScheduleRevision(current, expectedRevision);
      let parsed: { schedule: ScheduleSpec; nextRunAt: string };
      try {
        parsed = parseScheduleSpec(schedule);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "Invalid schedule");
      }
      const updatedAt = now();
      const updated: MissionSchedule = {
        ...this.scheduleFromRow(current),
        name: validName,
        prompt: validPrompt,
        schedule: parsed.schedule,
        status: enabled ? "enabled" : "held",
        revision: current.revision + 1,
        nextRunAt: parsed.nextRunAt,
        ...(enabled ? {} : { reason: "manual_hold" }),
        updatedAt
      };
      if (enabled) delete updated.reason;
      this.db.prepare(`
        UPDATE mission_schedules SET name=?,prompt=?,schedule=?,status=?,revision=?,next_run_at=?,reason=?,updated_at=?
        WHERE id=? AND mission_id=?
      `).run(
        updated.name, updated.prompt, json(updated.schedule), updated.status, updated.revision, updated.nextRunAt ?? null,
        updated.reason ?? null, updated.updatedAt, scheduleId, missionId
      );
      this.event(missionId, "schedule_updated", `Schedule ${updated.name} was replaced.`, undefined, { scheduleId, previousRevision: current.revision, revision: updated.revision, status: updated.status });
      return updated;
    });
  }

  holdSchedule(missionId: string, scheduleId: string, requestId: string, expectedRevision: number): MissionSchedule {
    this.validateScheduleRevision(expectedRevision);
    const payload = { missionId, scheduleId, action: "hold", expectedRevision };
    return this.command(`mission:${missionId}:schedules`, requestId, payload, () => {
      this.assertScheduleMission(missionId);
      const current = this.scheduleRow(scheduleId, missionId);
      if (!current) throw new HttpError(404, "Schedule not found");
      this.assertScheduleRevision(current, expectedRevision);
      if (current.status === "finished") throw new HttpError(409, "Finished schedules cannot be held");
      const updatedAt = now();
      const updated = { ...this.scheduleFromRow(current), status: "held" as const, revision: current.revision + 1, reason: "manual_hold", updatedAt };
      this.db.prepare("UPDATE mission_schedules SET status=?,revision=?,reason=?,updated_at=? WHERE id=? AND mission_id=?")
        .run(updated.status, updated.revision, updated.reason, updated.updatedAt, scheduleId, missionId);
      this.event(missionId, "schedule_held", `Schedule ${updated.name} was held.`, undefined, { scheduleId, revision: updated.revision, reason: updated.reason });
      return updated;
    });
  }

  resumeSchedule(missionId: string, scheduleId: string, requestId: string, expectedRevision: number): MissionSchedule {
    this.validateScheduleRevision(expectedRevision);
    const payload = { missionId, scheduleId, action: "resume", expectedRevision };
    return this.command(`mission:${missionId}:schedules`, requestId, payload, () => {
      this.assertScheduleMission(missionId);
      const current = this.scheduleRow(scheduleId, missionId);
      if (!current) throw new HttpError(404, "Schedule not found");
      this.assertScheduleRevision(current, expectedRevision);
      if (current.status !== "held") throw new HttpError(409, "Only held schedules can resume");
      let parsed: { schedule: ScheduleSpec; nextRunAt: string };
      try {
        parsed = parseScheduleSpec(decode<ScheduleSpec>(current.schedule));
      } catch {
        throw new HttpError(409, "Edit a past or invalid one-time schedule before resuming");
      }
      const updatedAt = now();
      const updated: MissionSchedule = {
        ...this.scheduleFromRow(current),
        status: "enabled",
        revision: current.revision + 1,
        schedule: parsed.schedule,
        nextRunAt: parsed.nextRunAt,
        updatedAt
      };
      delete updated.reason;
      this.db.prepare("UPDATE mission_schedules SET schedule=?,status=?,revision=?,next_run_at=?,reason=NULL,updated_at=? WHERE id=? AND mission_id=?")
        .run(json(updated.schedule), updated.status, updated.revision, parsed.nextRunAt, updated.updatedAt, scheduleId, missionId);
      this.event(missionId, "schedule_resumed", `Schedule ${updated.name} was resumed.`, undefined, { scheduleId, revision: updated.revision });
      return updated;
    });
  }

  deleteSchedule(missionId: string, scheduleId: string, requestId: string, expectedRevision: number): MissionSchedule {
    this.validateScheduleRevision(expectedRevision);
    const payload = { missionId, scheduleId, action: "delete", expectedRevision };
    return this.command(`mission:${missionId}:schedules`, requestId, payload, () => {
      this.assertScheduleMission(missionId);
      const current = this.scheduleRow(scheduleId, missionId);
      if (!current) throw new HttpError(404, "Schedule not found");
      this.assertScheduleRevision(current, expectedRevision);
      const updatedAt = now();
      const updated = { ...this.scheduleFromRow(current), status: "deleted" as const, revision: current.revision + 1, reason: "manual_delete", updatedAt };
      delete updated.nextRunAt;
      this.db.prepare("UPDATE mission_schedules SET status=?,revision=?,next_run_at=NULL,reason=?,updated_at=? WHERE id=? AND mission_id=?")
        .run(updated.status, updated.revision, updated.reason, updated.updatedAt, scheduleId, missionId);
      this.event(missionId, "schedule_deleted", `Schedule ${updated.name} was deleted.`, undefined, { scheduleId, revision: updated.revision });
      return updated;
    });
  }

  listSchedules(missionId: string): MissionSchedule[] {
    const rows = this.db.prepare("SELECT * FROM mission_schedules WHERE mission_id=? ORDER BY created_at,id").all(missionId) as ScheduleRow[];
    return rows.map((row) => this.scheduleFromRow(row));
  }

  scheduleOccurrences(missionId: string): ScheduleOccurrence[] {
    const rows = this.db.prepare(`
      SELECT o.*, b.status AS delivery_status, b.error AS delivery_error
      FROM schedule_occurrences o
      LEFT JOIN outbox b ON b.message_id=o.message_id AND b.request_id=o.request_id AND b.attempt=o.attempt
      WHERE o.mission_id=?
      ORDER BY o.observed_at,o.id
    `).all(missionId) as Array<{
      id: string; mission_id: string; schedule_id: string; schedule_revision: number; scheduled_for: string;
      observed_at: string; outcome: ScheduleOccurrence["outcome"]; reason: string | null; message_id: string | null;
      request_id: string | null; attempt: number | null; delivery_status?: string; delivery_error?: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      missionId: row.mission_id,
      scheduleId: row.schedule_id,
      scheduleRevision: row.schedule_revision,
      scheduledFor: row.scheduled_for,
      observedAt: row.observed_at,
      outcome: row.outcome,
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.message_id === null ? {} : { messageId: row.message_id }),
      ...(row.request_id === null ? {} : { requestId: row.request_id }),
      ...(row.attempt === null ? {} : { attempt: row.attempt }),
      ...(row.delivery_status === undefined || row.delivery_status === null ? {} : { deliveryStatus: row.delivery_status }),
      ...(row.delivery_error === undefined || row.delivery_error === null ? {} : { deliveryError: row.delivery_error })
    }));
  }

  private scheduleGate(
    mission: Mission,
    options: { ignoreTeamBusy?: boolean; preferApproval?: boolean; ignoreTransientOutbox?: boolean } = {}
  ): { reason?: string; recipientId?: string } {
    if (mission.status !== "active") return { reason: "mission_not_active" };
    if (mission.turns >= mission.maxTurns) return { reason: "turn_budget_exhausted" };
    if (mission.maxCost > 0 && mission.costKnown && mission.cost >= mission.maxCost) return { reason: "cost_budget_exhausted" };
    const orchestrator = mission.orchestratorId ? this.getAgent(mission.orchestratorId) : undefined;
    if (!orchestrator || orchestrator.missionId !== mission.id || orchestrator.kind !== "orchestrator") return { reason: "orchestrator_unavailable" };
    if (!options.ignoreTeamBusy && this.listAgents(mission.id).some((agent) => !["idle", "offline"].includes(agent.status))) return { reason: "team_busy" };
    if (this.blockers(mission.id).some((blocker) => blocker.status === "open")) return { reason: "open_blocker" };
    const pendingOutbox = () => this.db.prepare(`
      SELECT 1
      FROM outbox o
      LEFT JOIN blockers b
        ON b.id='delivery:' || o.id
       AND b.mission_id=o.mission_id
       AND b.status='resolved'
      WHERE o.mission_id=?
        AND (
          (?=0 AND o.status IN ('queued','dispatching','admitted'))
          OR (o.status='uncertain' AND b.id IS NULL)
      )
      LIMIT 1
    `).get(mission.id, options.ignoreTransientOutbox ? 1 : 0);
    const pendingApproval = () => this.db.prepare(`
      SELECT 1
      FROM approvals a
      LEFT JOIN blockers b
        ON b.id='approval:' || a.id
       AND b.mission_id=a.mission_id
       AND b.status='resolved'
      WHERE a.mission_id=?
        AND (
          a.status IN ('pending','approved','running')
          OR (a.status='uncertain' AND b.id IS NULL)
        )
      LIMIT 1
    `).get(mission.id);
    if (options.preferApproval && pendingApproval()) return { reason: "approval_pending" };
    if (pendingOutbox()) {
      return { reason: "outbox_pending" };
    }
    if (!options.preferApproval && pendingApproval()) {
      return { reason: "approval_pending" };
    }
    return { recipientId: orchestrator.id };
  }

  private holdCorruptSchedule(row: ScheduleRow, reason: string, text: string): void {
    const updatedAt = now();
    this.db.prepare("UPDATE mission_schedules SET status='held',reason=?,next_run_at=NULL,updated_at=? WHERE id=? AND status='enabled'")
      .run(reason, updatedAt, row.id);
    this.event(row.mission_id, "schedule_held", text, undefined, { scheduleId: row.id, reason });
  }

  private processDueSchedule(scheduleId: string, nowMs: number): boolean {
    return this.transaction(() => {
      const row = this.scheduleRow(scheduleId);
      if (!row || row.status !== "enabled") return false;
      if (row.next_run_at === null) {
        this.holdCorruptSchedule(row, "invalid_schedule", "A scheduled run had no persisted timing and was held.");
        return true;
      }
      const scheduledForMs = Date.parse(row.next_run_at);
      if (!Number.isFinite(scheduledForMs)) {
        this.holdCorruptSchedule(row, "invalid_schedule", "A scheduled run had invalid persisted timing and was held.");
        return true;
      }
      if (scheduledForMs > nowMs) {
        return false;
      }
      let schedule: ScheduleSpec;
      try {
        schedule = decode<ScheduleSpec>(row.schedule);
        if (!schedule || (schedule.kind !== "once" && schedule.kind !== "cron")) throw new Error("invalid kind");
        if (schedule.kind === "cron") schedule = parseScheduleSpec(schedule, nowMs).schedule;
        else {
          const persisted = parseScheduleSpec(schedule, scheduledForMs - 1);
          if (persisted.nextRunAt !== row.next_run_at) throw new Error("persisted once time does not match next run");
          schedule = persisted.schedule;
        }
      } catch {
        this.holdCorruptSchedule(row, "invalid_schedule", "A scheduled run had invalid persisted configuration and was held.");
        return true;
      }
      const mission = this.getMission(row.mission_id);
      if (!mission) {
        this.holdCorruptSchedule(row, "mission_not_found", "A schedule referenced a missing Mission and was held.");
        return true;
      }
      let outcome: ScheduleOccurrence["outcome"] = "skipped";
      let reason: string | undefined;
      let recipientId: string | undefined;
      if (mission.status === "completed") reason = "mission_completed";
      else if (mission.status === "cancelled") reason = "mission_cancelled";
      else {
        const gate = this.scheduleGate(mission);
        reason = gate.reason;
        recipientId = gate.recipientId;
        if (!reason) outcome = "queued";
      }
      let nextRunAt: string | null = null;
      let status: MissionSchedule["status"] = "finished";
      if (schedule.kind === "cron" && !["mission_completed", "mission_cancelled"].includes(reason ?? "")) {
        try {
          nextRunAt = parseScheduleSpec(schedule, nowMs).nextRunAt;
          status = "enabled";
        } catch {
          reason = "next_run_unavailable";
          outcome = "skipped";
          recipientId = undefined;
          status = "held";
        }
      } else if (schedule.kind === "cron") {
        status = "held";
      } else if (reason === "mission_completed" || reason === "mission_cancelled") {
        status = "held";
      }
      const observedAt = now();
      const occurrenceId = `schedule-occurrence:${row.id}:${row.revision}:${row.next_run_at}`;
      const occurrenceResult = this.db.prepare(`
        INSERT OR IGNORE INTO schedule_occurrences(
          id,mission_id,schedule_id,schedule_revision,scheduled_for,observed_at,outcome,reason,message_id,request_id,attempt
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `);
      let messageId: string | null = null;
      let requestId: string | null = null;
      let attempt: number | null = null;
      if (outcome === "queued" && recipientId) {
        messageId = `schedule-message:${occurrenceId}`;
        requestId = `${messageId}:1`;
        attempt = 1;
      }
      const inserted = Number(occurrenceResult.run(
        occurrenceId, row.mission_id, row.id, row.revision, row.next_run_at, observedAt, outcome, reason ?? null,
        messageId, requestId, attempt
      ).changes) > 0;
      if (inserted && messageId && requestId && recipientId) {
        const message: Message = {
          id: messageId,
          missionId: row.mission_id,
          senderId: "system:scheduler",
          recipientId,
          content: [
            `Scheduled Mission input: ${row.name}`,
            `Original scheduled time: ${row.next_run_at}`,
            "",
            row.prompt,
            "",
            "This is scheduled delivery, not Mission completion. Normal acceptance, approval, budget, and validation rules still apply."
          ].join("\n"),
          mode: "followUp",
          status: "queued",
          attempt: 1,
          createdAt: observedAt
        };
        this.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, message.missionId, message.status, json(message));
        this.enqueue(message);
      }
      this.db.prepare("UPDATE mission_schedules SET status=?,next_run_at=?,last_occurrence_id=?,reason=?,updated_at=? WHERE id=? AND revision=? AND status='enabled'")
        .run(status, nextRunAt, occurrenceId, status === "enabled" ? null : (reason ?? null), observedAt, row.id, row.revision);
      if (inserted) {
        this.event(row.mission_id, "schedule_occurrence", outcome === "queued" ? `Scheduled input ${row.name} was queued.` : `Scheduled input ${row.name} was skipped (${reason ?? "unknown"}).`, recipientId, {
          scheduleId: row.id, occurrenceId, scheduledFor: row.next_run_at, outcome, reason, messageId, requestId, attempt
        });
      }
      return true;
    });
  }

  tickSchedules(nowMs = Date.now()): number {
    if (this.closed || !Number.isFinite(nowMs)) return 0;
    const due = this.db.prepare(`
      SELECT id
      FROM mission_schedules
      WHERE status='enabled'
        AND (
          next_run_at IS NULL
          OR julianday(next_run_at) IS NULL
          OR next_run_at<=?
        )
      ORDER BY
        CASE WHEN next_run_at IS NULL OR julianday(next_run_at) IS NULL THEN 1 ELSE 0 END,
        next_run_at,
        id
    `).all(new Date(nowMs).toISOString()) as Array<{ id: string }>;
    let processed = 0;
    for (const row of due) {
      try {
        if (this.processDueSchedule(row.id, nowMs)) processed += 1;
      } catch {
        try {
          this.transaction(() => {
            const current = this.scheduleRow(row.id);
            if (current?.status === "enabled") this.holdCorruptSchedule(current, "scheduler_error", "A schedule tick failed safely and the affected schedule was held.");
          });
        } catch {
          // A corrupt schedule must not crash or re-enter the heartbeat.
        }
      }
    }
    return processed;
  }

  private defaultWatchdog(missionId: string): MissionWatchdog {
    return {
      missionId,
      autoWake: false,
      revision: 1,
      diagnosis: "not_observed",
      pendingTaskIds: [],
      idleThresholdMs: watchdogIdleThresholdMs,
      runningThresholdMs: watchdogRunningThresholdMs
    };
  }

  private storedWatchdog(missionId: string): MissionWatchdog | undefined {
    const row = this.db.prepare("SELECT data FROM watchdog_state WHERE mission_id=?").get(missionId) as Row | undefined;
    return row ? decode<MissionWatchdog>(row.data) : undefined;
  }

  private saveWatchdog(state: MissionWatchdog): void {
    this.db.prepare("INSERT INTO watchdog_state(mission_id,data) VALUES(?,?) ON CONFLICT(mission_id) DO UPDATE SET data=excluded.data")
      .run(state.missionId, json(state));
  }

  watchdog(missionId: string): MissionWatchdog {
    if (!this.getMission(missionId)) throw new HttpError(404, "Mission not found");
    return this.storedWatchdog(missionId) ?? this.defaultWatchdog(missionId);
  }

  watchdogWakes(missionId: string): WatchdogWake[] {
    if (!this.getMission(missionId)) throw new HttpError(404, "Mission not found");
    const rows = this.db.prepare(`
      SELECT w.id,w.mission_id,w.fingerprint,w.message_id,w.request_id,w.attempt,w.created_at,
             o.status AS delivery_status,o.error AS delivery_error
      FROM watchdog_wakes w
      LEFT JOIN outbox o
        ON o.mission_id=w.mission_id
       AND o.message_id=w.message_id
       AND o.request_id=w.request_id
       AND o.attempt=w.attempt
      WHERE w.mission_id=?
      ORDER BY w.created_at,w.id
    `).all(missionId) as WatchdogWakeRow[];
    return rows.map((row) => ({
      id: row.id,
      missionId: row.mission_id,
      fingerprint: row.fingerprint,
      messageId: row.message_id,
      requestId: row.request_id,
      attempt: row.attempt,
      createdAt: row.created_at,
      ...(row.delivery_status == null ? {} : { deliveryStatus: row.delivery_status }),
      ...(row.delivery_error == null ? {} : { deliveryError: row.delivery_error })
    }));
  }

  configureWatchdog(missionId: string, requestId: string, expectedRevision: number, autoWake: boolean): MissionWatchdog {
    if (typeof autoWake !== "boolean") throw new HttpError(400, "autoWake must be boolean");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new HttpError(400, "expectedRevision must be a positive safe integer");
    }
    return this.command(`mission:${missionId}:watchdog`, requestId, { expectedRevision, autoWake }, () => {
      const mission = this.getMission(missionId);
      if (!mission) throw new HttpError(404, "Mission not found");
      if (mission.status === "completed" || mission.status === "cancelled") {
        throw new HttpError(409, "Watchdog settings cannot change for a completed or cancelled Mission");
      }
      const current = this.storedWatchdog(missionId) ?? this.defaultWatchdog(missionId);
      if (expectedRevision !== current.revision) {
        throw new HttpError(409, `Expected watchdog revision ${expectedRevision}, current revision is ${current.revision}`);
      }
      const updated = { ...current, autoWake, revision: current.revision + 1 };
      this.saveWatchdog(updated);
      this.event(missionId, "watchdog_configured", `Mission watchdog auto-wake ${autoWake ? "enabled" : "disabled"}.`, undefined, {
        autoWake, revision: updated.revision
      });
      return updated;
    });
  }

  private watchdogFingerprint(mission: Mission): string {
    const rows = this.db.prepare("SELECT data FROM tasks WHERE mission_id=?").all(mission.id) as Row[];
    const tasks = rows.map((row) => decode<Task>(row.data)).map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      acceptance: task.acceptance,
      status: task.status,
      dependencies: [...(task.dependencies ?? [])].sort(),
      ownerId: task.ownerId ?? null,
      validatorId: task.validatorId ?? null,
      attempt: task.attempt,
      fulfills: [...(task.fulfills ?? [])].sort(),
      integration: task.integration === true,
      evidence: task.evidence ?? null
    })).sort((a, b) => a.id.localeCompare(b.id));
    const taskIds = new Set(tasks.map((task) => task.id));
    const artifactRows = this.db.prepare("SELECT data FROM artifacts WHERE mission_id=?").all(mission.id) as Row[];
    const artifacts = [...new Set(artifactRows.map((row) => {
      const artifact = decode<Artifact>(row.data);
      return JSON.stringify([artifact.taskId ?? null, artifact.sha256]);
    }).filter((pair) => {
      const [taskId] = JSON.parse(pair) as [string | null, string];
      return taskId !== null && taskIds.has(taskId);
    }))].map((pair) => JSON.parse(pair) as [string, string])
      .sort(([taskA, hashA], [taskB, hashB]) => (taskA ?? "").localeCompare(taskB ?? "") || hashA.localeCompare(hashB));
    const receipts = this.db.prepare("SELECT id FROM validation_receipts WHERE mission_id=? ORDER BY id")
      .all(mission.id) as Array<{ id: string }>;
    return hash({
      tasks,
      contractRevision: mission.contractRevision ?? 0,
      artifacts,
      validationReceiptIds: [...new Set(receipts.map((receipt) => receipt.id))].sort()
    });
  }

  private watchdogWake(missionId: string, fingerprint: string): WatchdogWake | undefined {
    const row = this.db.prepare("SELECT id,mission_id,fingerprint,message_id,request_id,attempt,created_at FROM watchdog_wakes WHERE mission_id=? AND fingerprint=?")
      .get(missionId, fingerprint) as WatchdogWakeRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      missionId: row.mission_id,
      fingerprint: row.fingerprint,
      messageId: row.message_id,
      requestId: row.request_id,
      attempt: row.attempt,
      createdAt: row.created_at
    };
  }

  private watchdogGateDiagnosis(
    mission: Mission,
    gate: { reason?: string; recipientId?: string } | undefined
  ): MissionWatchdog["diagnosis"] | undefined {
    const openBlockers = this.blockers(mission.id).filter((blocker) => blocker.status === "open");
    if (openBlockers.some((blocker) => blocker.kind === "user_input")) return "waiting_user";
    if (openBlockers.some((blocker) => blocker.kind === "approval")) return "waiting_approval";
    if (openBlockers.some((blocker) => blocker.kind === "limit")) return "budget_exhausted";
    if (openBlockers.length) return "blocked";
    if (mission.status !== "active" && mission.status !== "blocked") return undefined;
    const effectiveGate = gate ?? this.scheduleGate({ ...mission, status: "active" }, { ignoreTeamBusy: true, preferApproval: true });
    if (!effectiveGate.reason || effectiveGate.reason === "team_busy") return undefined;
    return effectiveGate.reason === "turn_budget_exhausted" || effectiveGate.reason === "cost_budget_exhausted" ? "budget_exhausted"
      : effectiveGate.reason === "outbox_pending" ? "delivery_pending"
        : effectiveGate.reason === "approval_pending" ? "waiting_approval"
          : effectiveGate.reason === "orchestrator_unavailable" ? "offline"
            : effectiveGate.reason === "open_blocker" ? "blocked"
              : "mission_inactive";
  }

  private processWatchdogMission(missionId: string, nowMs: number): boolean {
    return this.transaction(() => {
      const mission = this.getMission(missionId);
      if (!mission) return false;
      const existing = this.storedWatchdog(missionId);
      const terminal = ["completed", "cancelled"].includes(mission.status);
      if (terminal && !existing?.checkedAt) return false;
      const checkedAt = new Date(nowMs).toISOString();
      const fingerprint = this.watchdogFingerprint(mission);
      const state = existing ?? this.defaultWatchdog(missionId);
      const priorProgressMs = state.progressSince ? Date.parse(state.progressSince) : Number.NaN;
      const progressChanged = state.fingerprint !== fingerprint;
      const progressSince = progressChanged || !Number.isFinite(priorProgressMs) || nowMs < priorProgressMs
        ? checkedAt
        : state.progressSince!;
      const tasks = (this.db.prepare("SELECT data FROM tasks WHERE mission_id=?").all(missionId) as Row[])
        .map((row) => decode<Task>(row.data));
      const pendingTaskIds = tasks.filter((task) => task.status !== "accepted" && task.status !== "blocked")
        .map((task) => task.id).sort();
      const agents = this.listAgents(missionId);
      const gate = mission.status === "active"
        ? this.scheduleGate(mission, { ignoreTeamBusy: true, preferApproval: true, ignoreTransientOutbox: true })
        : undefined;
      const hasOfflineAgent = agents.some((agent) => ["offline", "error", "recovering"].includes(agent.status));
      const hasRunningAgent = agents.some((agent) => agent.status === "running");
      const runningEligible = mission.status === "active" && hasRunningAgent && !hasOfflineAgent &&
        agents.every((agent) => ["idle", "running"].includes(agent.status));
      let runningSince = state.runningSince;
      if (!runningEligible) {
        runningSince = undefined;
      } else {
        const runningSinceMs = runningSince ? Date.parse(runningSince) : Number.NaN;
        if (!Number.isFinite(runningSinceMs) || nowMs < runningSinceMs) runningSince = checkedAt;
      }
      let diagnosis: MissionWatchdog["diagnosis"];
      let eligibleSince: string | undefined;
      const gateDiagnosis = this.watchdogGateDiagnosis(mission, gate);
      if (gateDiagnosis) {
        diagnosis = gateDiagnosis;
      } else if (mission.status !== "active") {
        diagnosis = "mission_inactive";
      } else if (tasks.some((task) => task.status === "blocked")) {
        diagnosis = "blocked";
      } else if (pendingTaskIds.length === 0) {
        diagnosis = "no_pending_tasks";
      } else if (agents.some((agent) => agent.status === "waiting_user")) {
        diagnosis = "waiting_user";
      } else if (agents.some((agent) => agent.status === "waiting_approval")) {
        diagnosis = "waiting_approval";
      } else if (hasOfflineAgent) {
        diagnosis = "offline";
      } else if (!agents.length || agents.some((agent) => agent.status !== "idle" && agent.status !== "running")) {
        diagnosis = "offline";
      } else if (hasRunningAgent) {
        const startMs = Math.max(Date.parse(progressSince), runningSince ? Date.parse(runningSince) : Number.NaN);
        if (Number.isFinite(startMs) && nowMs >= startMs && nowMs - startMs >= watchdogRunningThresholdMs) {
          diagnosis = "running_no_progress";
        } else {
          diagnosis = "running";
        }
      } else {
        const activeGate = this.scheduleGate(mission, { ignoreTeamBusy: true, preferApproval: true });
        if (activeGate.reason) {
          diagnosis = activeGate.reason === "turn_budget_exhausted" || activeGate.reason === "cost_budget_exhausted" ? "budget_exhausted"
            : activeGate.reason === "outbox_pending" ? "delivery_pending"
              : activeGate.reason === "approval_pending" ? "waiting_approval"
                : activeGate.reason === "orchestrator_unavailable" ? "offline"
                  : activeGate.reason === "open_blocker" ? "blocked"
                    : activeGate.reason === "team_busy" ? "running"
                      : "mission_inactive";
        } else {
          const priorEligibleMs = state.eligibleSince ? Date.parse(state.eligibleSince) : Number.NaN;
          eligibleSince = !Number.isFinite(priorEligibleMs) || nowMs < priorEligibleMs || progressChanged
            ? checkedAt
            : state.eligibleSince;
          const elapsed = nowMs - Date.parse(eligibleSince!);
          const priorWake = this.watchdogWake(missionId, fingerprint);
          if (priorWake) {
            const delivery = this.db.prepare("SELECT status FROM outbox WHERE mission_id=? AND message_id=? AND request_id=? AND attempt=?")
              .get(missionId, priorWake.messageId, priorWake.requestId, priorWake.attempt) as { status: string } | undefined;
            diagnosis = delivery && ["queued", "dispatching", "admitted"].includes(delivery.status)
              ? "delivery_pending"
              : "needs_attention";
          } else if (elapsed >= watchdogIdleThresholdMs) {
            diagnosis = state.autoWake ? "wake_queued" : "stalled";
            if (state.autoWake && activeGate.recipientId) {
              const wakeId = `watchdog-wake:${missionId}:${fingerprint}`;
              const messageId = `watchdog-message:${missionId}:${fingerprint}`;
              const requestId = `${messageId}:1`;
              const wake: WatchdogWake = {
                id: wakeId, missionId, fingerprint, messageId, requestId, attempt: 1, createdAt: checkedAt
              };
              this.db.prepare(`
                INSERT INTO watchdog_wakes(id,mission_id,fingerprint,message_id,request_id,attempt,created_at)
                VALUES(?,?,?,?,?,?,?)
              `).run(wake.id, wake.missionId, wake.fingerprint, wake.messageId, wake.requestId, wake.attempt, wake.createdAt);
              const message: Message = {
                id: messageId,
                missionId,
                senderId: "system:watchdog",
                recipientId: activeGate.recipientId,
                content: watchdogPrompt,
                mode: "followUp",
                status: "queued",
                attempt: 1,
                createdAt: checkedAt
              };
              this.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)")
                .run(message.id, missionId, message.status, json(message));
              this.enqueue(message);
              this.event(missionId, "watchdog_wake_queued", "Mission watchdog queued one bounded recovery input.", activeGate.recipientId, {
                wakeId, fingerprint, messageId, requestId, attempt: 1
              });
            }
          } else {
            diagnosis = "observing";
          }
        }
      }
      const updated: MissionWatchdog = {
        ...state,
        missionId,
        diagnosis,
        fingerprint,
        progressSince,
        checkedAt,
        pendingTaskIds
      };
      if (eligibleSince) updated.eligibleSince = eligibleSince;
      else delete updated.eligibleSince;
      if (runningSince) updated.runningSince = runningSince;
      else delete updated.runningSince;
      this.saveWatchdog(updated);
      if (state.diagnosis !== diagnosis || state.fingerprint !== fingerprint) {
        this.event(missionId, "watchdog_observed", `Mission watchdog diagnosis: ${diagnosis}.`, undefined, {
          diagnosis, fingerprint, pendingTaskIds
        });
      }
      return true;
    });
  }

  private logWatchdogObservationPersistenceFailure(nowMs: number): void {
    if (this.watchdogFailureLogAt !== undefined && nowMs - this.watchdogFailureLogAt < 60_000) return;
    this.watchdogFailureLogAt = nowMs;
    try {
      process.stderr.write("Mission watchdog observation could not be persisted.\n");
    } catch {
      // A diagnostic failure must not interrupt the heartbeat.
    }
  }

  private persistWatchdogObservationError(missionId: string, nowMs: number): void {
    try {
      this.transaction(() => {
        const row = this.db.prepare("SELECT data FROM watchdog_state WHERE mission_id=?").get(missionId) as Row | undefined;
        const state = row ? decode<MissionWatchdog>(row.data) : this.defaultWatchdog(missionId);
        const shouldEmit = state.diagnosis !== "observation_error";
        const updated: MissionWatchdog = {
          ...state,
          missionId,
          diagnosis: "observation_error",
          checkedAt: new Date(nowMs).toISOString()
        };
        delete updated.eligibleSince;
        delete updated.runningSince;
        this.saveWatchdog(updated);
        if (shouldEmit) {
          this.event(missionId, "watchdog_observation_error", "Mission watchdog observation failed and was not used for recovery.", undefined, {
            diagnosis: "observation_error"
          });
        }
      });
    } catch {
      this.logWatchdogObservationPersistenceFailure(nowMs);
    }
  }

  tickWatchdogs(nowMs = Date.now()): number {
    if (this.closed || !Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) return 0;
    let missionRows: Array<{ id: string }>;
    try {
      missionRows = this.db.prepare(`
        SELECT id FROM missions
        WHERE status NOT IN ('completed','cancelled')
           OR id IN (SELECT mission_id FROM watchdog_state)
        ORDER BY id
      `).all() as Array<{ id: string }>;
    } catch {
      this.logWatchdogObservationPersistenceFailure(nowMs);
      return 0;
    }
    let processed = 0;
    for (const row of missionRows) {
      try {
        if (this.processWatchdogMission(row.id, nowMs)) processed += 1;
      } catch {
        this.persistWatchdogObservationError(row.id, nowMs);
      }
    }
    return processed;
  }

  pendingOutbox(): OutboxRow[] {
    const expired = this.db.prepare(`SELECT o.id,a.id AS agent_id,a.data FROM outbox o
      JOIN messages m ON m.id=o.message_id JOIN agents a ON a.id=json_extract(m.data,'$.recipientId')
      WHERE o.status='dispatching' AND o.deadline_at IS NOT NULL AND o.deadline_at<?`).all(Date.now()) as Array<{ id: string; agent_id: string; data: string }>;
    for (const row of expired) {
      const agent = decode<Agent>(row.data);
      if (agent.machineId === "local") this.retryOutbox(row.id, "Delivery acknowledgement deadline expired");
      else this.markRemoteDeliveryUncertain(row.id, agent.id);
    }
    return this.db.prepare("SELECT id,mission_id,message_id,attempt,request_id,retry_count FROM outbox WHERE status='queued' AND COALESCE(next_attempt_at,0)<=? ORDER BY created_at").all(Date.now()) as OutboxRow[];
  }

  remoteRuntimeForAgent(agentId: string): RemoteRuntimeRow | undefined {
    return this.remoteRuntimes.byAgent(agentId);
  }

  dispatchRemoteOutbox(row: OutboxRow, message: Message, agent: Agent): boolean {
    return this.transaction(() => {
      const freshAgent = this.getAgent(agent.id);
      const freshMessage = this.message(message.id);
      const mission = this.getMission(row.mission_id);
      const outbox = this.db.prepare("SELECT status FROM outbox WHERE id=? AND message_id=? AND mission_id=?")
        .get(row.id, message.id, row.mission_id) as { status: string } | undefined;
      if (!outbox || outbox.status !== "queued" || mission?.status !== "active") return false;
      const runtime = this.remoteRuntimes.activeForAgent(agent.id);
      const machine = runtime ? this.machineRegistry.get(runtime.machine_id) : undefined;
      const routeCurrent = Boolean(
        freshAgent && freshMessage && freshMessage.recipientId === freshAgent.id &&
        freshAgent.machineId !== "local" && freshAgent.machineId === agent.machineId &&
        runtime && runtime.state === "running" && runtime.desired === "run" &&
        runtime.machine_id === freshAgent.machineId && runtime.epoch === freshAgent.epoch &&
        machine?.status === "online" && machine.sessionId === runtime.session_id &&
        machine.sessionEpoch === runtime.session_epoch && (machine.leaseExpiresAt ?? 0) > Date.now() &&
        machine.capabilities?.executionEnabled === true && machine.capabilities.executionMode === "metadata-only"
      );
      if (!routeCurrent || !runtime || !freshAgent || !freshMessage || !machine) {
        this.blockRemoteOutboxWithinTransaction(row.id, agent.id,
          "Remote worker routing is stale or unavailable; reconcile ownership before resuming.");
        return false;
      }
      const binding: WorkerBinding = {
        runtimeId: runtime.runtime_id, machineId: runtime.machine_id, sessionId: runtime.session_id,
        sessionEpoch: runtime.session_epoch, agentId: runtime.agent_id, epoch: runtime.epoch
      };
      try {
        if (this.workerMailbox.inspectBinding(binding).status !== "open") throw new Error("fenced");
      } catch {
        this.blockRemoteOutboxWithinTransaction(row.id, agent.id,
          "Remote worker routing is stale or unavailable; reconcile ownership before resuming.");
        return false;
      }
      if (!this.markOutboxDispatching(row.id, binding.epoch)) return false;
      const digest = createHash("sha256").update(`${message.id}:${row.request_id}:${row.attempt}`).digest("hex").slice(0, 32);
      const transportId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20)}` as ReturnType<typeof randomUUID>;
      this.workerMailbox.enqueue(binding, {
        kind: "deliver", messageId: freshMessage.id, requestId: row.request_id, attempt: row.attempt,
        content: freshMessage.content, mode: freshMessage.mode
      }, transportId);
      return true;
    });
  }

  blockRemoteDispatch(outboxId: string, agentId: string): boolean {
    return this.transactionIfNeeded(() => this.blockRemoteOutboxWithinTransaction(outboxId, agentId,
      "Remote worker routing is stale or unavailable; reconcile ownership before resuming."));
  }

  private blockRemoteOutboxWithinTransaction(outboxId: string, agentId: string, error: string): boolean {
    const row = this.db.prepare("SELECT mission_id,message_id,attempt,status FROM outbox WHERE id=?")
      .get(outboxId) as { mission_id: string; message_id: string; attempt: number; status: string } | undefined;
    if (!row || row.status !== "queued") return false;
    this.db.prepare("UPDATE outbox SET status='aborted',deadline_at=NULL,error=? WHERE id=? AND status='queued'").run(error, outboxId);
    const message = this.message(row.message_id);
    if (message) this.db.prepare("UPDATE messages SET status='aborted',data=? WHERE id=?")
      .run(json({ ...message, status: "aborted", error }), message.id);
    this.insertSystemBlocker(`remote-route:${outboxId}`, row.mission_id, "delivery",
      "Remote worker routing is stale or unavailable. Delivery was fenced and ownership must be reconciled before resuming.");
    this.event(row.mission_id, "remote_route_blocked",
      "A remote delivery could not be routed to the current node binding and was not replayed.", agentId,
      { messageId: row.message_id, attempt: row.attempt });
    return true;
  }

  private markRemoteDeliveryUncertain(outboxId: string, agentId: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT mission_id,message_id,attempt FROM outbox WHERE id=? AND status='dispatching'").get(outboxId) as { mission_id: string; message_id: string; attempt: number } | undefined;
      if (!row) return;
      this.db.prepare("UPDATE outbox SET status='uncertain',deadline_at=NULL,error=? WHERE id=?").run("Remote delivery admission timed out; outcome is uncertain", outboxId);
      const message = this.message(row.message_id);
      if (message) this.db.prepare("UPDATE messages SET status='uncertain',data=? WHERE id=?")
        .run(json({ ...message, status: "uncertain", error: "Remote delivery admission timed out; outcome is uncertain" }), message.id);
      this.insertSystemBlocker(`delivery:${outboxId}`, row.mission_id, "delivery",
        "Remote delivery admission timed out. The runtime was fenced and ownership requires trusted reconciliation; it will not be replayed.");
      this.event(row.mission_id, "delivery_uncertain", `Remote delivery ${row.message_id} became uncertain after timeout.`, agentId, { messageId: row.message_id, attempt: row.attempt });
      this.requestRemoteRuntimeStop(agentId);
      const agent = this.getAgent(agentId);
      this.markAgentInterrupted(agentId, agent?.epoch);
    });
  }

  markOutboxDispatching(id: string, epoch: number): boolean {
    const row = this.db.prepare("SELECT mission_id,status FROM outbox WHERE id=?").get(id) as { mission_id: string; status: string } | undefined;
    if (!row || row.status !== "queued") return false;
    const mission = this.getMission(row.mission_id);
    if (!mission || mission.status !== "active" || mission.turns >= mission.maxTurns) return false;
    this.db.prepare("UPDATE outbox SET status='dispatching',epoch=?,deadline_at=?,next_attempt_at=NULL WHERE id=? AND status='queued'").run(epoch, Date.now() + 30000, id);
    const changed = this.db.prepare("SELECT changes() AS count").get() as { count: number } | undefined;
    return changed?.count === 1 && (this.db.prepare("SELECT status FROM outbox WHERE id=?").get(id) as { status: string }).status === "dispatching";
  }

  ackOutbox(messageId: string, requestId: string, attempt: number, epoch: number, status: "admitted" | "completed" | "uncertain", result?: string): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT id,mission_id,epoch,status FROM outbox WHERE message_id=? AND request_id=? AND attempt=?").get(messageId, requestId, attempt) as { id: string; mission_id: string; epoch: number; status: string } | undefined;
      if (
        !row
        || row.epoch !== epoch
        || !["dispatching", "admitted"].includes(row.status)
        || (row.status === "admitted" && status === "admitted")
      ) return false;
      const message = this.message(messageId);
      const recipient = message ? this.getAgent(message.recipientId) : undefined;
      if (!message || !recipient || recipient.epoch !== epoch || recipient.missionId !== row.mission_id) return false;
      this.db.prepare("UPDATE outbox SET status=?,result=?,deadline_at=NULL WHERE id=?").run(status, result ?? null, row.id);
      const next = { ...message, status, ...(status === "uncertain" ? { error: "Worker completed with an uncertain outcome" } : {}) };
      this.db.prepare("UPDATE messages SET status=?,data=? WHERE id=?").run(status, json(next), messageId);
      this.event(row.mission_id, `delivery_${status}`, `Delivery ${requestId} ${status}.`, undefined, { messageId, requestId, attempt, epoch, result });
      if (status === "uncertain") {
        this.insertSystemBlocker(`delivery:${row.id}`, row.mission_id, "delivery", `Delivery ${requestId} completed with an uncertain outcome. Reconcile it before resuming; it will not be replayed with a new command ID.`);
      }
      return true;
    });
  }

  recoverUnexpectedWorker(agentId: string, epoch: number, diagnostic: string): Agent | undefined {
    return this.transaction(() => {
      const agent = this.getAgent(agentId);
      const mission = agent ? this.getMission(agent.missionId) : undefined;
      if (!agent || !mission || agent.epoch !== epoch || mission.status !== "active") return undefined;
      const cutoff = Date.now() - 10 * 60 * 1000;
      const recent = (this.db.prepare("SELECT data FROM events WHERE mission_id=? AND type='worker_recovery_started'").all(mission.id) as Row[])
        .map((row) => decode<MissionEvent>(row.data))
        .filter((event) => Date.parse(event.createdAt) >= cutoff && event.agentId === agentId).length;
      const nextEpoch = agent.epoch + 1;
      if (recent >= 3) {
        this.insertSystemBlocker(`worker-recovery:${agentId}`, mission.id, "delivery", `Worker ${agent.title} exceeded the recovery budget. Resolve the blocker before resuming; no replacement agent will be created.`);
        const failed = { ...agent, epoch: nextEpoch, status: "error" as const, error: "Worker recovery budget exhausted", updatedAt: now() };
        this.putAgent(failed);
        this.event(mission.id, "worker_recovery_exhausted", "Worker recovery budget exhausted.", agentId, { epoch, nextEpoch, diagnostic });
        return undefined;
      }
      const messages = this.db.prepare("SELECT data FROM messages WHERE mission_id=?").all(mission.id) as Row[];
      for (const row of messages) {
        const message = decode<Message>(row.data);
        if (message.recipientId !== agentId) continue;
        const outbox = this.db.prepare("SELECT id,attempt,request_id,status FROM outbox WHERE message_id=? AND status IN ('dispatching','admitted') ORDER BY attempt DESC LIMIT 1")
          .get(message.id) as { id: string; attempt: number; request_id: string; status: string } | undefined;
        if (!outbox) continue;
        this.db.prepare("UPDATE outbox SET status='queued',epoch=?,deadline_at=NULL,next_attempt_at=0,error=? WHERE id=?")
          .run(nextEpoch, `Worker exited before delivery ${outbox.request_id} reached a terminal outcome`, outbox.id);
        const nextMessage = { ...message, status: "queued", error: `Worker exited before delivery ${outbox.request_id} reached a terminal outcome` };
        this.db.prepare("UPDATE messages SET status='queued',data=? WHERE id=?").run(json(nextMessage), message.id);
      }
      const recovering = { ...agent, epoch: nextEpoch, status: "recovering" as const, error: `Worker exited unexpectedly: ${diagnostic}`, updatedAt: now() };
      this.putAgent(recovering);
      this.event(mission.id, "worker_recovery_started", `Recovering worker ${agent.title} in the same durable store.`, agentId, { epoch, nextEpoch, diagnostic });
      return recovering;
    });
  }

  message(id: string): Message | undefined {
    const row = this.db.prepare("SELECT data FROM messages WHERE id=?").get(id) as Row | undefined;
    return row ? decode<Message>(row.data) : undefined;
  }

  setOutboxStatus(id: string, status: string, error?: string): void {
    const row = this.db.prepare("SELECT mission_id,message_id,attempt FROM outbox WHERE id=?").get(id) as { mission_id: string; message_id: string; attempt: number } | undefined;
    if (!row) return;
    this.db.prepare("UPDATE outbox SET status=?,error=? WHERE id=?").run(status, error ?? null, id);
    const message = this.message(row.message_id);
    if (message) {
      const updated = { ...message, status: status === "delivered" ? "delivered" : status, ...(error ? { error } : {}) };
      this.db.prepare("UPDATE messages SET status=?,data=? WHERE id=?").run(updated.status, json(updated), updated.id);
    }
    this.event(row.mission_id, `outbox_${status}`, `Outbox attempt ${row.attempt} ${status}.`, undefined, { messageId: row.message_id, attempt: row.attempt, error });
  }

  setOutboxStatusForMessage(messageId: string, status: string, error?: string): void {
    const row = this.db.prepare("SELECT id FROM outbox WHERE message_id=? AND status IN ('queued','dispatching') ORDER BY attempt DESC LIMIT 1").get(messageId) as { id: string } | undefined;
    if (row) this.setOutboxStatus(row.id, status, error);
  }

  retryOutboxForMessage(messageId: string, error: string, requestId?: string, attempt?: number, epoch?: number): boolean {
    const row = this.db.prepare("SELECT id,request_id,attempt,epoch,status FROM outbox WHERE message_id=? AND status IN ('queued','dispatching') ORDER BY attempt DESC LIMIT 1").get(messageId) as { id: string; request_id: string; attempt: number; epoch: number; status: string } | undefined;
    if (requestId !== undefined && (!row || row.request_id !== requestId || row.attempt !== attempt || row.epoch !== epoch || row.status !== "dispatching")) return false;
    if (!row) return false;
    this.retryOutbox(row.id, error);
    return true;
  }

  async stopMissionProcesses(missionId: string): Promise<void> {
    const children = [...this.externalProcesses].filter(([, owner]) => owner.missionId === missionId).map(([child]) => child);
    const results = await Promise.allSettled([this.mcpRuntime.cancelMission(missionId), this.stopProcesses(children)]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async stopAgentProcesses(agentId: string): Promise<void> {
    const children = [...this.externalProcesses].filter(([, owner]) => owner.agentId === agentId).map(([child]) => child);
    const results = await Promise.allSettled([this.mcpRuntime.cancelAgent(agentId), this.stopProcesses(children)]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private async stopProcesses(children: ChildProcess[]): Promise<void> {
    await Promise.all(children.map((child) => new Promise<void>((resolveProcess) => {
      let finished = false;
      let final: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(forceTimer);
        clearTimeout(final);
        child.off("exit", finish);
        resolveProcess();
      };
      const forceTimer = setTimeout(() => {
        try {
          if (child.pid && child.pid > 0) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        final = setTimeout(finish, 2000);
      }, 5000);
      child.once("close", finish);
      try {
        if (child.pid && child.pid > 0) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    })));
  }

  retryOutbox(id: string, error: string): void {
    const row = this.db.prepare("SELECT retry_count,mission_id FROM outbox WHERE id=?").get(id) as { retry_count: number; mission_id: string } | undefined;
    if (!row) return;
    const retries = row.retry_count + 1;
    const delay = Math.min(60000, 1000 * (2 ** Math.min(retries, 6)));
    this.db.prepare("UPDATE outbox SET retry_count=?,next_attempt_at=?,deadline_at=NULL WHERE id=?").run(retries, Date.now() + delay, id);
    const exhausted = retries >= 5;
    this.setOutboxStatus(id, exhausted ? "failed" : "queued", error);
    if (exhausted) this.insertSystemBlocker(`delivery:${id}`, row.mission_id, "delivery", `Durable delivery ${id} exhausted its retry budget. Resolve the blocker before resuming the mission.`);
  }

  admitTurn(agentId: string, epoch: number, generationId: string): void {
    if (!generationId || generationId.length > 240) throw new HttpError(400, "A generation id is required");
    const denial = this.transaction(() => {
      const agent = this.getAgent(agentId);
      if (!agent || agent.epoch !== epoch) throw new HttpError(409, "Worker epoch is fenced");
      const mission = this.getMission(agent.missionId);
      if (!mission) throw new HttpError(404, "Mission not found");
      const prior = this.db.prepare("SELECT 1 FROM generation_admissions WHERE agent_id=? AND generation_id=?").get(agentId, generationId);
      const reason = mission.status !== "active" ? "Mission is not accepting model turns"
        : !prior && mission.turns >= mission.maxTurns ? "Mission turn limit exhausted" : undefined;
      if (reason) {
        this.db.prepare("INSERT OR IGNORE INTO generation_denials(agent_id,generation_id,mission_id,epoch,reason,created_at) VALUES(?,?,?,?,?,?)")
          .run(agentId, generationId, mission.id, epoch, reason, now());
        if (mission.status === "active") this.putMission({ ...mission, status: "blocked", updatedAt: now() });
        this.event(mission.id, "turn_admission_denied", reason, agentId, { generationId, turns: mission.turns, maxTurns: mission.maxTurns });
        return reason;
      }
      if (prior) return undefined;
      const turns = mission.turns + 1;
      this.db.prepare("INSERT INTO generation_admissions(agent_id,generation_id,mission_id,epoch,turn_number,created_at) VALUES(?,?,?,?,?,?)")
        .run(agentId, generationId, mission.id, epoch, turns, now());
      this.putMission({ ...mission, turns, updatedAt: now() });
      this.event(mission.id, "turn_accounted", `Mission turn ${turns}/${mission.maxTurns} admitted.`, agentId, { generationId, phase: "admission", turns, maxTurns: mission.maxTurns, costKnown: mission.costKnown });
      return undefined;
    });
    if (denial) throw new HttpError(409, denial);
  }

  recordTurn(agentId: string, epoch: number, turnId: string, generationId?: string): void {
    const agent = this.getAgent(agentId);
    if (!agent || agent.epoch !== epoch || !turnId) return;
    const mission = this.getMission(agent.missionId);
    if (!mission) return;
    const inserted = this.db.prepare("INSERT OR IGNORE INTO accounted_turns(agent_id,turn_id) VALUES(?,?)").run(agentId, turnId);
    if (Number(inserted.changes) === 0) return;
    const admission = generationId ? this.db.prepare("SELECT 1 FROM generation_admissions WHERE agent_id=? AND generation_id=?").get(agentId, generationId) : undefined;
    const denial = generationId ? this.db.prepare("SELECT 1 FROM generation_denials WHERE agent_id=? AND generation_id=?").get(agentId, generationId) : undefined;
    const turns = mission.turns + (admission || denial ? 0 : 1);
    const blocked = turns >= mission.maxTurns && mission.status === "active";
    const updated = { ...mission, turns, status: blocked ? "blocked" as const : mission.status, updatedAt: now() };
    this.putMission(updated);
    this.event(mission.id, admission || denial ? "turn_observed" : "turn_accounted", `Mission turn ${turns}/${mission.maxTurns}.`, agentId, { turnId, generationId, admitted: Boolean(admission), denied: Boolean(denial), turns, maxTurns: mission.maxTurns, costKnown: mission.costKnown });
  }

  recordUsage(agentId: string, epoch: number, cost: number): void {
    const agent = this.getAgent(agentId);
    if (!agent || agent.epoch !== epoch || !Number.isFinite(cost) || cost < 0) throw new HttpError(400, "Invalid worker usage report");
    const mission = this.getMission(agent.missionId);
    if (!mission?.costKnown) return;
    this.db.prepare("INSERT INTO agent_usage(agent_id,mission_id,cost) VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET cost=excluded.cost")
      .run(agentId, agent.missionId, cost);
    const total = (this.db.prepare("SELECT COALESCE(SUM(cost),0) AS total FROM agent_usage WHERE mission_id=?").get(agent.missionId) as { total: number }).total;
    const hitLimit = mission.status === "active" && mission.maxCost > 0 && total >= mission.maxCost;
    this.putMission({ ...mission, cost: total, status: hitLimit ? "blocked" : mission.status, updatedAt: now() });
    this.event(mission.id, "usage_accounted", `Mission cost accounted: ${total}.`, agentId, { cost: total, maxCost: mission.maxCost, costKnown: true, limitReached: hitLimit });
  }

  getAgentPublic(id: string): Agent | undefined {
    return this.getAgent(id);
  }

  claimAgentOwner(agentId: string): Agent {
    const agent = this.getAgent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    const mission = this.getMission(agent.missionId);
    if (!mission || mission.status !== "active") throw new HttpError(409, "Mission is not accepting a worker owner");
    const updated = { ...agent, epoch: agent.epoch + 1, status: "recovering" as const, updatedAt: now() };
    this.putAgent(updated);
    this.event(mission.id, "agent_owner_claimed", `Agent ownership advanced to epoch ${updated.epoch}.`, agent.id, { epoch: updated.epoch });
    return updated;
  }

  missionForAgent(id: string): Mission | undefined {
    const agent = this.getAgent(id);
    return agent ? this.getMission(agent.missionId) : undefined;
  }

  missionById(id: string): Mission | undefined {
    return this.getMission(id);
  }

  workspaceForMission(id: string): Workspace | undefined {
    const mission = this.getMission(id);
    return mission ? this.workspace(mission.workspaceId) : undefined;
  }

  artifact(id: string): Artifact | undefined {
    const row = this.db.prepare("SELECT data FROM artifacts WHERE id=?").get(id) as Row | undefined;
    return row ? decode<Artifact>(row.data) : undefined;
  }

  private createBlocker(agentId: string, epoch: number, commandId: string, kind: Blocker["kind"], text: string, taskId?: string): Blocker {
    const { mission } = this.authorizeAgent(agentId, epoch, this.getAgent(agentId)?.missionId ?? "");
    return this.command(`mission:${mission.id}:blockers`, commandId, { kind, text, taskId }, () => {
      const blocker: Blocker = { id: randomUUID(), missionId: mission.id, agentId, ...(taskId ? { taskId } : {}), kind, status: "open", text, createdAt: now() };
      this.db.prepare("INSERT INTO blockers(id,mission_id,status,data) VALUES(?,?,?,?)").run(blocker.id, mission.id, blocker.status, json(blocker));
      this.putMission({ ...mission, status: "blocked", updatedAt: now() });
      this.setAgentStatus(agentId, epoch, "waiting_user");
      this.event(mission.id, `${kind}_requested`, text, agentId, { blockerId: blocker.id, commandId });
      return blocker;
    });
  }

  resolveBlocker(id: string, resolution: string): Blocker {
    if (!resolution.trim()) throw new HttpError(400, "A human resolution is required");
    return this.command(`mission:blockers`, id, { resolution }, () => {
      const row = this.db.prepare("SELECT data FROM blockers WHERE id=?").get(id) as Row | undefined;
      if (!row) throw new HttpError(404, "Blocker not found");
      const blocker = decode<Blocker>(row.data);
      if (blocker.status !== "open") throw new HttpError(409, "Blocker is already resolved");
      const updated: Blocker = { ...blocker, status: "resolved", resolvedAt: now(), text: `${blocker.text}\nResolution: ${resolution}` };
      this.db.prepare("UPDATE blockers SET status='resolved',data=? WHERE id=?").run(json(updated), id);
      this.event(blocker.missionId, "blocker_resolved", "Human resolution recorded.", blocker.agentId, { blockerId: id, resolution });
      const mission = this.getMission(blocker.missionId);
      const remaining = this.blockers(blocker.missionId).some((item) => item.status === "open");
      if (mission?.status === "blocked" && !remaining && blocker.kind !== "user_input") {
        this.putMission({ ...mission, status: "paused", updatedAt: now() });
      } else if (mission && !remaining && blocker.kind === "user_input" && blocker.agentId &&
        ["blocked", "paused"].includes(mission.status)) {
        const resume = mission.status === "blocked" &&
          mission.turns < mission.maxTurns &&
          (mission.maxCost <= 0 || !mission.costKnown || mission.cost < mission.maxCost);
        const recipient = this.getAgent(blocker.agentId);
        const message: Message | undefined = recipient ? {
          id: `blocker-resolution:${id}`, missionId: mission.id, senderId: "user", recipientId: recipient.id,
          content: resolution, mode: "followUp", status: resume ? "queued" : "aborted", attempt: 1, createdAt: now(),
          ...(!resume ? { error: "Held until the mission can resume; delivery is not released while paused or over budget." } : {})
        } : undefined;
        if (message) {
          this.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, mission.id, message.status, json(message));
          if (resume) this.enqueue(message);
          this.event(mission.id, "message_created", resume ? "Human blocker resolution queued for its requesting agent." : "Human blocker resolution held for explicit resume.", recipient!.id, { messageId: message.id, blockerId: id });
        }
        if (resume) {
          this.putMission({ ...mission, status: "active", updatedAt: now() });
          this.releaseHeldMessages(mission.id);
          if (recipient) this.setAgentStatus(recipient.id, recipient.epoch, "idle");
        }
      } else if (mission && blocker.kind === "user_input" && blocker.agentId) {
        const recipient = this.getAgent(blocker.agentId);
        if (recipient) {
          const message: Message = {
            id: `blocker-resolution:${id}`, missionId: mission.id, senderId: "user", recipientId: recipient.id,
            content: resolution, mode: "followUp", status: "aborted", attempt: 1, createdAt: now(),
            error: "Held until all mission blockers are resolved and resume is allowed."
          };
          this.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, mission.id, message.status, json(message));
          this.event(mission.id, "message_created", "Human blocker resolution held for explicit resume.", recipient.id, { messageId: message.id, blockerId: id });
        }
      }
      return updated;
    });
  }

  blockers(missionId: string): Blocker[] {
    const rows = this.db.prepare("SELECT data FROM blockers WHERE mission_id=? ORDER BY rowid").all(missionId) as Row[];
    return rows.map((row) => decode<Blocker>(row.data));
  }

  private resolveWorkspaceFile(agent: Agent, file: string, allowMissing: boolean): string {
    const workspace = realpathSync(agent.workspacePath);
    const candidate = isAbsolute(file) ? resolve(file) : resolve(workspace, file);
    let target: string;
    try {
      target = realpathSync(candidate);
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw new HttpError(400, "Workspace file does not exist");
      if (candidate !== workspace && !candidate.startsWith(workspace + sep)) throw new HttpError(403, "Workspace path escaped the assigned directory");
      let parent = dirname(candidate);
      while (true) {
        try {
          const realParent = realpathSync(parent);
          if (realParent !== workspace && !realParent.startsWith(workspace + sep)) throw new HttpError(403, "Workspace path escaped the assigned directory");
          break;
        } catch (parentError) {
          if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
          const nextParent = dirname(parent);
          if (nextParent === parent) throw new HttpError(400, "Workspace parent directory is unavailable");
          parent = nextParent;
        }
      }
      target = candidate;
    }
    if (target !== workspace && !target.startsWith(workspace + sep)) throw new HttpError(403, "Workspace path escaped the assigned directory");
    return target;
  }

  async workerCommand(request: RpcMessage): Promise<unknown> {
    const current = this.getAgent(request.agentId);
    if (current && current.machineId !== "local" && !REMOTE_RPC_METHODS.has(request.method)) {
      throw new HttpError(409, REMOTE_OPERATION_UNAVAILABLE);
    }
    if (current && current.epoch !== request.epoch) {
      const mission = this.getMission(current.missionId);
      if (request.epoch < current.epoch && mission && ["paused", "cancelled", "completed", "failed", "active"].includes(mission.status)) {
        if (request.method === "Transcript") {
          const args = request.args && typeof request.args === "object" ? request.args as Record<string, unknown> : {};
          if (typeof args.text === "string" && typeof args.role === "string") {
            this.recordTranscript(current.id, args.role, args.text, `${request.taskId}:late`);
            this.event(mission.id, "late_worker_evidence", "A fenced worker transcript entry was retained.", current.id);
            return { recorded: true, late: true };
          }
        }
        if (request.method === "Report") {
          const args = request.args && typeof request.args === "object" ? request.args as Record<string, unknown> : {};
          if (typeof args.summary === "string" && args.summary.trim()) {
            const summary = args.summary.slice(0, 12000);
            const evidence = typeof args.evidence === "string" ? args.evidence.slice(0, 12000) : "";
            this.recordTranscript(current.id, "assistant", `Late report: ${summary}${evidence ? `\n\nEvidence: ${evidence}` : ""}`, `${request.taskId}:late-report`);
            this.event(mission.id, "late_worker_evidence", summary, current.id, { evidence, fencedEpoch: request.epoch });
            if (mission.status === "paused") {
              const recipient = this.listAgents(mission.id).find((item) => item.kind === "orchestrator");
              if (recipient) {
                const message: Message = {
                  id: `late-report:${current.id}:${request.taskId}`, missionId: mission.id, senderId: current.id,
                  recipientId: recipient.id, content: `${summary}${evidence ? `\n\nEvidence: ${evidence}` : ""}`,
                  mode: "followUp", status: "aborted", attempt: 1, createdAt: now(),
                  error: "Held while mission is paused; delivery will start after explicit resume"
                };
                this.db.prepare("INSERT OR IGNORE INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, mission.id, message.status, json(message));
              }
            }
            return { recorded: true, late: true };
          }
        }
      }
      throw new HttpError(409, "Worker epoch is fenced");
    }
    const { agent, mission, role } = this.authorizeAgent(request.agentId, request.epoch, this.getAgent(request.agentId)?.missionId ?? "");
    if (!["Transcript", "Report", "Usage", "AdmitTurn"].includes(request.method) && mission.status !== "active" && !(request.method === "ValidateTask" && mission.status === "validating")) {
      throw new HttpError(409, "Mission is not accepting worker commands");
    }
    const args = request.args && typeof request.args === "object" ? request.args as Record<string, unknown> : {};
    const getString = (name: string, required = true): string => {
      const value = args[name];
      if (typeof value !== "string" || (required && !value.trim())) throw new HttpError(400, `${name} is required`);
      return value;
    };
    switch (request.method) {
      case "AdmitTurn":
        this.admitTurn(agent.id, request.epoch, getString("generationId"));
        return { admitted: true };
      case "Transcript":
        this.recordTranscript(agent.id, getString("role"), getString("text"), getString("entryId"));
        return { recorded: true };
      case "Usage":
        this.recordUsage(agent.id, request.epoch, typeof args.cost === "number" ? args.cost : Number.NaN);
        return { recorded: true };
      case "ListAgents":
        return this.listAgents(mission.id);
      case "GetMissionState":
        return this.getMissionState(agent.id, request.epoch);
      case "ListMcpTools":
        return this.listGrantedMcpTools(agent.id, request.epoch, getString("serverId"));
      case "CallMcpTool":
        return this.createMcpApproval(
          agent.id, request.epoch, request.taskId, getString("serverId"), getString("toolName"),
          args.arguments, getString("definitionHash")
        );
      case "SendMessage": {
        const recipientId = getString("recipientId");
        const recipient = this.getAgent(recipientId);
        if (!recipient || recipient.missionId !== mission.id) throw new HttpError(404, "Recipient is not in this mission");
        const ownOrchestrator = this.listAgents(mission.id).find((item) => item.kind === "orchestrator");
        if (role.kind !== "orchestrator" && recipient.id !== ownOrchestrator?.id) throw new HttpError(403, "Agents may only message their own orchestrator");
        if (args.mode !== "steer" && args.mode !== "followUp") throw new HttpError(400, "Invalid message mode");
        const mode = args.mode;
        return this.sendAgentMessage(agent, recipient, getString("content"), mode, request.taskId);
      }
      case "InterruptAgent": {
        if (role.kind !== "orchestrator") throw new HttpError(403, "Only the orchestrator may interrupt agents");
        const target = this.getAgent(getString("agentId"));
        if (!target || target.missionId !== mission.id) throw new HttpError(404, "Agent not found in this mission");
        this.event(mission.id, "agent_interrupt_requested", "Agent interrupt requested.", agent.id, { targetAgentId: target.id });
        return { agentId: target.id, interrupted: true };
      }
      case "CreateTask": {
        if (!Array.isArray(args.dependencies) || args.dependencies.some((item) => typeof item !== "string")) throw new HttpError(400, "dependencies must be an array of task ids");
        if (Object.hasOwn(args, "integration") && typeof args.integration !== "boolean") throw new HttpError(400, "integration must be boolean");
        const dependencies = args.dependencies as string[];
        const fulfills = args.fulfills === undefined ? undefined : parseFulfills(args.fulfills, false)!;
        return this.createTask(agent.id, request.epoch, request.taskId, {
          missionId: mission.id, title: getString("title"), description: getString("description"), acceptance: getString("acceptance"),
          dependencies, ...(fulfills === undefined ? {} : { fulfills }),
          ...(typeof args.integration === "boolean" ? { integration: args.integration } : {}),
          ...(typeof args.ownerId === "string" ? { ownerId: args.ownerId } : {}), ...(typeof args.validatorId === "string" ? { validatorId: args.validatorId } : {})
        });
      }
      case "UpdateTask":
        if (Object.hasOwn(args, "integration") && typeof args.integration !== "boolean") throw new HttpError(400, "integration must be boolean");
        if (typeof args.dependencies !== "undefined" && !Array.isArray(args.dependencies)) throw new HttpError(400, "dependencies must be an array of task ids");
        if (typeof args.fulfills !== "undefined") parseFulfills(args.fulfills, false);
        return this.updateTask(agent.id, request.epoch, request.taskId, getString("taskId"), {
          ...(typeof args.status === "string" ? { status: args.status as Task["status"] } : {}),
          ...(typeof args.title === "string" ? { title: args.title } : {}),
          ...(typeof args.description === "string" ? { description: args.description } : {}),
          ...(typeof args.acceptance === "string" ? { acceptance: args.acceptance } : {}),
          ...(typeof args.dependencies !== "undefined" ? { dependencies: args.dependencies as string[] } : {}),
          ...(typeof args.fulfills !== "undefined" ? { fulfills: parseFulfills(args.fulfills, false)! } : {}),
          ...(typeof args.integration === "boolean" ? { integration: args.integration } : {}),
          ...(typeof args.ownerId === "string" ? { ownerId: args.ownerId } : {}),
          ...(typeof args.validatorId === "string" ? { validatorId: args.validatorId } : {}),
          ...(typeof args.evidence === "string" ? { evidence: args.evidence } : {})
        });
      case "ValidateTask":
        if (typeof args.passed !== "boolean") throw new HttpError(400, "passed must be boolean");
        return this.validateTask(agent.id, request.epoch, request.taskId, getString("taskId"), getString("receiptId"), args.passed, getString("evidence"),
          typeof args.assertionResults === "undefined" ? undefined : args.assertionResults as AssertionResult[]);
      case "RunValidation": {
        if (!Array.isArray(args.artifactIds) || args.artifactIds.some((item) => typeof item !== "string")) throw new HttpError(400, "artifactIds must be an array of artifact ids");
        const input = { taskId: getString("taskId"), command: getString("command"), artifactIds: args.artifactIds as string[] };
        if (mission.autonomy === "approve") return this.createApproval(agent.id, request.epoch, request.taskId, "run_validation", input);
        return this.runValidation(agent.id, request.epoch, request.taskId, input);
      }
      case "PublishArtifact": {
        const file = this.resolveWorkspaceFile(agent, getString("path"), false);
        if (!statSync(file).isFile()) throw new HttpError(400, "Artifact must be a file");
        const bytes = readFileSync(file);
        return this.publishArtifact(agent.id, request.epoch, request.taskId, getString("name"), file, bytes, typeof args.taskId === "string" ? args.taskId : undefined);
      }
      case "Report":
        return this.report(agent, request.epoch, request.taskId, getString("summary"), getString("evidence", false));
      case "RequestUserInput": {
        const question = getString("question");
        return this.createBlocker(agent.id, request.epoch, request.taskId, "user_input", question);
      }
      case "CompleteMission":
        return this.completeMission(agent, request.epoch, request.taskId);
      case "SpawnAgent": {
        if (role.kind !== "orchestrator") throw new HttpError(403, "Only the orchestrator may spawn agents");
        let targetWorkspaceId: string | undefined;
        if (Object.hasOwn(args, "targetWorkspaceId")) {
          if (typeof args.targetWorkspaceId !== "string") throw new HttpError(400, "targetWorkspaceId must be a string");
          targetWorkspaceId = args.targetWorkspaceId;
        }
        return this.createAgent(
          mission.id, getString("title"), getString("roleId"), getString("prompt"), request.taskId, targetWorkspaceId
        );
      }
      case "read_file": {
        const file = this.resolveWorkspaceFile(agent, getString("path"), false);
        if (!statSync(file).isFile()) throw new HttpError(400, "Path is not a file");
        const data = readFileSync(file);
        return { path: file, content: data.toString("utf8").slice(0, 300000), truncated: data.length > 300000 };
      }
      case "write_file": {
        if (role.kind === "validator") throw new HttpError(403, "Validators cannot edit workspace files");
        const file = this.resolveWorkspaceFile(agent, getString("path"), true);
        const operation = { path: file, content: getString("content", false) };
        if (mission.autonomy === "approve") return this.createApproval(agent.id, request.epoch, request.taskId, "write_file", operation);
        return this.command(`mission:${mission.id}:writes`, request.taskId, operation, () =>
          this.writeWorkspaceFile(file, operation.content, agent.workspacePath, mission.id)
        );
      }
      case "bash": {
        if (role.kind === "validator") throw new HttpError(403, "Validators cannot execute shell commands");
        const command = getString("command");
        if (mission.autonomy === "approve") return this.createApproval(agent.id, request.epoch, request.taskId, "bash", { command });
        return this.runShellCommand(agent, request.taskId, command);
      }
      default:
        throw new HttpError(400, `Unknown worker operation: ${request.method}`);
    }
  }

  private sendAgentMessage(sender: Agent, recipient: Agent, content: string, mode: "steer" | "followUp", commandId: string): Message {
    return this.command(`mission:${sender.missionId}:agent-messages`, commandId, { sender: sender.id, recipient: recipient.id, content, mode }, () => {
      return this.enqueueAgentMessage(sender, recipient, content, mode);
    });
  }

  private enqueueAgentMessage(sender: Agent, recipient: Agent, content: string, mode: "steer" | "followUp"): Message {
    const mission = this.getMission(sender.missionId);
    const held = mission?.status === "paused";
    const message: Message = {
      id: randomUUID(), missionId: sender.missionId, senderId: sender.id, recipientId: recipient.id, content, mode,
      status: held ? "aborted" : "queued", attempt: 1, createdAt: now(),
      ...(held ? { error: "Held while mission is paused; delivery will start after explicit resume" } : {})
    };
    this.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, message.missionId, message.status, json(message));
    if (!held) this.enqueue(message);
    this.event(sender.missionId, "agent_message_created", "Agent message admitted to durable outbox.", sender.id, { messageId: message.id, recipientId: recipient.id });
    return message;
  }

  private report(agent: Agent, epoch: number, commandId: string, summary: string, evidence: string): unknown {
    return this.command(`mission:${agent.missionId}:reports`, commandId, { summary, evidence }, () => {
      this.authorizeAgent(agent.id, epoch, agent.missionId);
      const mission = this.getMission(agent.missionId)!;
      this.event(mission.id, "agent_report", summary, agent.id, { evidence });
      const orchestrator = this.listAgents(mission.id).find((item) => item.kind === "orchestrator");
      if (orchestrator && orchestrator.id !== agent.id && !["cancelled", "completed"].includes(mission.status)) {
        this.enqueueAgentMessage(agent, orchestrator, `${summary}${evidence ? `\n\nEvidence: ${evidence}` : ""}`, "followUp");
      }
      return { recorded: true };
    });
  }

  private completeMission(agent: Agent, epoch: number, commandId: string): unknown {
    if (agent.kind !== "orchestrator") throw new HttpError(403, "Only the orchestrator may complete a mission");
    return this.command(`mission:${agent.missionId}:completion`, commandId, {}, () => {
      this.authorizeAgent(agent.id, epoch, agent.missionId);
      const detail = this.detail(agent.missionId);
      if (!detail.tasks.length || detail.tasks.some((task) => task.status !== "accepted")) throw new HttpError(409, "All required tasks need independent accepted validation");
      if (detail.validationContract && (detail.requirementCoverage ?? []).some((coverage) => coverage.status !== "passed")) {
        throw new HttpError(409, "Every current validation assertion must have exactly one accepted task and a passing result");
      }
      if (detail.approvals.some((approval) =>
        ["pending", "approved", "running"].includes(approval.status) ||
        (approval.status === "uncertain" && !detail.blockers?.some((blocker) => blocker.id === `approval:${approval.id}` && blocker.status === "resolved"))
      )) throw new HttpError(409, "Pending or unacknowledged uncertain approvals must be resolved before completion");
      if (detail.blockers?.some((blocker) => blocker.status === "open")) throw new HttpError(409, "Open blockers must be resolved before completion");
      if (!detail.artifacts.length) throw new HttpError(409, "At least one published artifact is required");
      const worktreeMode = detail.mission.workspaceStrategy === "worktree";
      const integrationTasks = detail.tasks.filter((task) => task.integration === true);
      const integrationCommit = worktreeMode ? integrationTasks.length === 1
        ? detail.validations.filter((item) => item.taskId === integrationTasks[0]!.id && item.passed).at(-1)
        : undefined : undefined;
      const integrationReceipt = integrationCommit
        ? detail.validationReceipts?.find((receipt) => receipt.id === integrationCommit.receiptId)
        : undefined;
      if (worktreeMode) {
        if (integrationTasks.length !== 1 || !integrationCommit || !integrationReceipt) {
          throw new HttpError(409, "A worktree Mission requires exactly one independently accepted integration task");
        }
        const integration = integrationTasks[0]!;
        const integrationOwner = integration.ownerId ? this.getAgent(integration.ownerId) : undefined;
        if (!integrationOwner || this.role(integrationOwner.roleId)?.kind !== "worker") {
          throw new HttpError(409, "The integration task must be owned by a worker");
        }
        if ((integration.fulfills ?? []).length || !integration.ownerId || integration.ownerId === detail.mission.orchestratorId) {
          throw new HttpError(409, "Integration must be an independently owned task with fulfills=[]");
        }
        const closure = new Set<string>();
        const visit = (taskId: string): void => {
          if (closure.has(taskId)) return;
          closure.add(taskId);
          const task = detail.tasks.find((item) => item.id === taskId);
          if (task) for (const dependency of task.dependencies) visit(dependency);
        };
        visit(integration.id);
        const ordinaryTasks = detail.tasks.filter((task) => !task.integration);
        if (ordinaryTasks.some((task) => !closure.has(task.id))) {
          throw new HttpError(409, "Integration dependencies must include every ordinary task");
        }
        const mission = detail.mission;
        const contract = detail.validationContract;
        const effectiveResults = integrationCommit.assertionResults ?? [];
        if (!contract || effectiveResults.length !== contract.assertions.length ||
          contract.assertions.some((assertion) => !effectiveResults.some((result) => result.assertionId === assertion.id && result.status === "passed")) ||
          Object.keys(integrationReceipt.requirementRevisions ?? {}).length !== contract.assertions.length ||
          contract.assertions.some((assertion) => integrationReceipt.requirementRevisions?.[assertion.id] !== assertion.revision)) {
          throw new HttpError(409, "Integration receipt must independently pass every current contract assertion and revision");
        }
        if (!integrationReceipt.workspaceCommit || integrationReceipt.snapshotIntegrity !== true) {
          throw new HttpError(409, "Integration validation did not preserve an intact committed snapshot");
        }
        const integrationRecord = integrationOwner.worktreeId ? this.worktree(integrationOwner.worktreeId) : undefined;
        if (!integrationRecord || integrationRecord.status !== "ready" ||
          repositoryHead(integrationRecord.path) !== integrationReceipt.workspaceCommit || !isWorktreeClean(integrationRecord.path)) {
          throw new HttpError(409, "Integration owner changed the validated commit or has uncommitted changes");
        }
        for (const ordinary of ordinaryTasks) {
          const accepted = detail.validations.filter((item) => item.taskId === ordinary.id && item.passed).at(-1);
          const receipt = accepted ? detail.validationReceipts?.find((item) => item.id === accepted.receiptId) : undefined;
          if (!receipt?.workspaceCommit || receipt.snapshotIntegrity !== true ||
            !isAncestor(mission.repository!.path, receipt.workspaceCommit, integrationReceipt.workspaceCommit)) {
            throw new HttpError(409, `Ordinary task ${ordinary.id} commit is not included in the accepted integration commit`);
          }
        }
      }
      for (const task of detail.tasks) {
        const validation = detail.validations.filter((item) => item.taskId === task.id && item.passed).at(-1);
        const receipt = detail.validationReceipts?.find((item) => item.id === validation?.receiptId);
        if (!validation || !receipt || receipt.attempt !== task.attempt || receipt.taskRevision !== (task.revision ?? 0) ||
          (worktreeMode && receipt.snapshotIntegrity !== true)) {
          throw new HttpError(409, `Task ${task.id} has no current accepted validation receipt`);
        }
        for (const artifactId of receipt.artifactIds) {
          const artifact = this.artifact(artifactId);
          const snapshotValid = artifact?.snapshotPath &&
            createHash("sha256").update(readFileSync(artifact.snapshotPath)).digest("hex") === artifact.sha256;
          const immutableValid = worktreeMode && artifact?.workspaceCommit && artifact.relativePath && receipt.workspaceCommit &&
            artifact.taskId === task.id && artifact.agentId === task.ownerId &&
            isAncestor(detail.mission.repository!.path, artifact.workspaceCommit, receipt.workspaceCommit) &&
            createHash("sha256").update(trackedBlobAt(detail.mission.repository!.path, receipt.workspaceCommit, artifact.relativePath).bytes).digest("hex") === artifact.sha256;
          const sharedValid = !worktreeMode && artifact &&
            createHash("sha256").update(readFileSync(artifact.path)).digest("hex") === artifact.sha256;
          if (!artifact || !snapshotValid || !(immutableValid || sharedValid)) {
            throw new HttpError(409, `Artifact ${artifactId} or its source has changed`);
          }
        }
      }
      const completed = { ...detail.mission, status: "completed" as const, updatedAt: now() };
      this.putMission(completed);
      this.event(completed.id, "mission_completed", "Mission passed completion gates.", agent.id);
      return completed;
    });
  }

  private writeWorkspaceFile(file: string, content: string, workspace: string, missionId: string): { path: string; bytes: number } {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const realWorkspace = realpathSync(workspace);
    const parent = realpathSync(dirname(file));
    if (parent !== realWorkspace && !parent.startsWith(realWorkspace + sep)) throw new HttpError(403, "Write parent escaped workspace");
    if (existsSync(file)) {
      const target = realpathSync(file);
      if (target !== realWorkspace && !target.startsWith(realWorkspace + sep)) throw new HttpError(403, "Write target escaped workspace");
    }
    writeFileSync(file, content, { mode: 0o600 });
    const bytes = Buffer.byteLength(content);
    this.event(missionId, "workspace_file_written", "Workspace file written.", undefined, { path: file, bytes });
    return { path: file, bytes };
  }

  private async runShellCommand(agent: Agent, commandId: string, command: string): Promise<ShellEvidence> {
    if (!commandId || commandId.length > 240) throw new HttpError(400, "A command id is required (maximum 240 characters)");
    const scope = `mission:${agent.missionId}:bash`;
    const digest = hash({ command });
    const key = `${scope}\0${commandId}`;
    const flight = this.shellFlights.get(key);
    if (flight) {
      if (flight.digest !== digest) throw new HttpError(409, "The command id was already used with a different payload");
      return flight.promise;
    }
    const previous = this.db.prepare("SELECT payload_hash,response FROM commands WHERE scope=? AND command_id=?").get(scope, commandId) as { payload_hash: string; response: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== digest) throw new HttpError(409, "The command id was already used with a different payload");
      const result = decode<ShellEvidence | { status: string }>(previous.response);
      if ("status" in result) throw new HttpError(409, "The prior shell result is uncertain; command was not rerun");
      return result;
    }
    this.db.prepare("INSERT INTO commands(scope,command_id,payload_hash,response,created_at) VALUES(?,?,?,?,?)")
      .run(scope, commandId, digest, json({ status: "pending" }), now());
    const promise = this.runShell(agent, command)
      .then((result) => {
        this.db.prepare("UPDATE commands SET response=? WHERE scope=? AND command_id=?").run(json(result), scope, commandId);
        return result;
      })
      .finally(() => {
        this.shellFlights.delete(key);
      });
    this.shellFlights.set(key, { digest, promise });
    return promise;
  }

  private startShellProcess(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    missionId: string,
    agentId: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const maxBuffer = 1024 * 1024;
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.externalProcesses.set(child, { missionId, agentId });
    return new Promise((resolveResult) => {
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputExceeded = false;
      let timedOut = false;
      let spawnError: Error | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      const signalGroup = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid && child.pid > 0) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          child.kill(signal);
        }
      };
      const append = (current: string, currentBytes: number, chunk: Buffer): { value: string; bytes: number } => {
        const remaining = Math.max(0, maxBuffer - currentBytes);
        const retained = chunk.subarray(0, remaining);
        if (retained.length < chunk.length && !outputExceeded) {
          outputExceeded = true;
          signalGroup("SIGTERM");
          forceTimer = setTimeout(() => signalGroup("SIGKILL"), 5000);
        }
        return { value: current + retained.toString("utf8"), bytes: currentBytes + retained.length };
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        signalGroup("SIGTERM");
        forceTimer = setTimeout(() => signalGroup("SIGKILL"), 5000);
      }, 120000);
      timeout.unref();
      child.stdout?.on("data", (chunk: Buffer) => {
        const captured = append(stdout, stdoutBytes, chunk);
        stdout = captured.value;
        stdoutBytes = captured.bytes;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const captured = append(stderr, stderrBytes, chunk);
        stderr = captured.value;
        stderrBytes = captured.bytes;
      });
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        this.externalProcesses.delete(child);
        if (spawnError && stderrBytes < maxBuffer) stderr += `${stderr ? "\n" : ""}${spawnError.message}`.slice(0, maxBuffer - stderrBytes);
        if (timedOut) stderr = `${stderr}\nCommand timed out after 120 seconds.`.slice(-maxBuffer);
        if (outputExceeded) stderr = `${stderr}\nCommand output exceeded 1 MiB per stream.`.slice(-maxBuffer);
        resolveResult({ stdout, stderr, exitCode: timedOut || outputExceeded || code === null ? null : code });
      });
    });
  }

  private runShell(agent: Agent, command: string, blockUnknown = true): Promise<ShellEvidence> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[key]) env[key] = process.env[key];
    this.activeWorkspaceOperations.set(agent.id, (this.activeWorkspaceOperations.get(agent.id) ?? 0) + 1);
    return this.startShellProcess(command, agent.workspacePath, env, agent.missionId, agent.id).then(({ stdout, stderr, exitCode }) => {
      const evidence = { command, stdout, stderr, exitCode };
      this.recordTranscript(agent.id, "tool", JSON.stringify(evidence));
      this.event(agent.missionId, "shell_evidence", `Shell command exited ${exitCode}.`, agent.id, evidence);
      if (exitCode === null && blockUnknown && this.getAgent(agent.id)?.epoch === agent.epoch) {
        this.createBlocker(agent.id, agent.epoch, `unsafe-shell:${hash({ command })}`, "unsafe_execution", "Shell execution ended without a known exit status. Human review is required; it will not be replayed.");
      }
      return evidence;
    }).finally(() => {
      const remaining = (this.activeWorkspaceOperations.get(agent.id) ?? 1) - 1;
      if (remaining) this.activeWorkspaceOperations.set(agent.id, remaining);
      else this.activeWorkspaceOperations.delete(agent.id);
    });
  }

  async executeApproved(id: string): Promise<Approval> {
    const pending = this.approvalFlights.get(id);
    if (pending) return pending;
    const flight = this.executeApprovedOnce(id).finally(() => this.approvalFlights.delete(id));
    this.approvalFlights.set(id, flight);
    return flight;
  }

  async executeApprovedPending(missionId: string): Promise<void> {
    const rows = this.db.prepare("SELECT id FROM approvals WHERE mission_id=? AND status='approved'").all(missionId) as Array<{ id: string }>;
    for (const row of rows) await this.executeApproved(row.id);
  }

  private async executeApprovedOnce(id: string): Promise<Approval> {
    const row = this.db.prepare("SELECT data FROM approvals WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new HttpError(404, "Approval not found");
    const previous = decode<Approval>(row.data);
    if (["succeeded", "failed", "uncertain", "denied"].includes(previous.status)) return previous;
    const agent = this.getAgent(previous.agentId);
    const mission = this.getMission(previous.missionId);
    if (previous.status !== "approved") throw new HttpError(409, "Approval must be approved before execution");
    if (!agent || !mission || mission.status !== "active") throw new HttpError(409, "Approved operation cannot run outside an active mission");
    if (agent.machineId !== "local") throw new HttpError(409, REMOTE_OPERATION_UNAVAILABLE);
    if (previous.tool === "run_validation") {
      const binding = previous as Approval & Partial<ValidationApprovalBinding>;
      const task = binding.validationTaskId ? this.task(binding.validationTaskId) : undefined;
      const contract = task ? this.validationContract(task.missionId) : undefined;
      const currentRequirements = task && contract
        ? Object.fromEntries((task.fulfills ?? []).map((id) => [id, contract.assertions.find((item) => item.id === id)?.revision]))
        : {};
      const contractStale = binding.contractRevision !== contract?.revision;
      const requirementStale = Object.keys(binding.requirementRevisions ?? {}).length !== Object.keys(currentRequirements).length ||
        Object.entries(binding.requirementRevisions ?? {}).some(([id, revision]) => currentRequirements[id] !== revision);
      if (!task || task.attempt !== binding.validationAttempt || (task.revision ?? 0) !== binding.validationTaskRevision || contractStale || requirementStale) {
        const updated = { ...previous, status: "failed" as const, receipt: { stdout: "", stderr: "Approval scope is stale; validation was not executed.", exitCode: null } };
        this.db.prepare("UPDATE approvals SET status=?,data=? WHERE id=?").run(updated.status, json(updated), id);
        this.insertSystemBlocker(`approval:${id}`, mission.id, "approval", `Approved validation ${id} became stale before execution and was not run.`);
        return updated;
      }
    }
    const persist = (status: Approval["status"], receipt?: NonNullable<Approval["receipt"]>): Approval => {
      const validationReceiptId = receipt && "id" in receipt && typeof receipt.id === "string" ? receipt.id : undefined;
      const updated = {
        ...previous, status, ...(receipt ? { receipt } : {}),
        ...(validationReceiptId ? { validationReceiptId } : {})
      } as Approval;
      this.db.prepare("UPDATE approvals SET status=?,data=? WHERE id=?").run(status, json(updated), id);
      this.event(previous.missionId, "approval_execution", `Approved ${previous.tool} operation is ${status}.`, previous.agentId, { approvalId: id, status, exitCode: receipt?.exitCode });
      if (["succeeded", "failed", "uncertain"].includes(status)) {
        const currentMission = this.getMission(previous.missionId);
        const held = currentMission?.status === "paused";
        const message: Message = {
          id: `approval-execution:${id}:${status}`, missionId: previous.missionId, senderId: "control",
          recipientId: previous.agentId,
          content: `Approval ${id} execution ${status}.${validationReceiptId ? ` Validation receipt: ${validationReceiptId}.` : ""}`,
          mode: "followUp", status: held ? "aborted" : "queued", attempt: 1, createdAt: now(),
          ...(held ? { error: "Held while mission is paused; delivery will start after explicit resume" } : {})
        };
        this.db.prepare("INSERT OR IGNORE INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, message.missionId, message.status, json(message));
        if (!held) this.enqueue(message);
      }
      return updated;
    };
    persist("running");
    try {
      let receipt: NonNullable<Approval["receipt"]>;
      if (previous.tool === "write_file") {
        const args = previous.args as { path?: unknown; content?: unknown };
        if (typeof args.path !== "string" || typeof args.content !== "string") throw new HttpError(400, "Invalid approved file operation");
        const target = this.resolveWorkspaceFile(agent, args.path, true);
        this.writeWorkspaceFile(target, args.content, agent.workspacePath, mission.id);
        receipt = { stdout: "", stderr: "", exitCode: 0 };
      } else if (previous.tool === "bash") {
        const args = previous.args as { command?: unknown };
        if (typeof args.command !== "string") throw new HttpError(400, "Invalid approved shell operation");
        const result = await this.runShell(agent, args.command, false);
        receipt = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
        if (result.exitCode === null) {
          this.insertSystemBlocker(`approval:${id}`, mission.id, "approval", `Approved shell operation ${id} has an unknown result and will not be replayed.`);
          return persist("uncertain", receipt);
        }
      } else if (previous.tool === "run_validation") {
        const args = previous.args as { taskId?: unknown; command?: unknown; artifactIds?: unknown };
        if (typeof args.taskId !== "string" || typeof args.command !== "string" || !Array.isArray(args.artifactIds) || args.artifactIds.some((value) => typeof value !== "string")) {
          throw new HttpError(400, "Invalid approved validation operation");
        }
        const result = await this.runValidation(agent.id, agent.epoch, `approval-${id}`, { taskId: args.taskId, command: args.command, artifactIds: args.artifactIds as string[] }, id);
        receipt = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, id: result.id } as NonNullable<Approval["receipt"]>;
        if (result.exitCode === null) {
          this.insertSystemBlocker(`approval:${id}`, mission.id, "approval", `Approved validation ${id} has an unknown result and will not be replayed.`);
          return persist("uncertain", receipt);
        }
      } else if (previous.tool === "mcp_call") {
        try {
          const result = await this.executeMcpApproval(previous);
          const isError = Boolean(result && typeof result === "object" && "isError" in result && result.isError === true);
          receipt = { stdout: JSON.stringify(result), stderr: "", exitCode: isError ? 1 : 0 };
          return persist(isError ? "failed" : "succeeded", receipt);
        } catch (error) {
          const typed = error instanceof McpOperationError ? error : undefined;
          const uncertain = !typed || (typed.submitted && !typed.terminal);
          const message = typed?.message ?? "MCP operation failed with an unknown outcome.";
          if (uncertain) this.insertSystemBlocker(`approval:${id}`, mission.id, "approval", `MCP call ${id} may have executed; inspect the external system and do not replay it automatically.`);
          const receiptMessage = uncertain
            ? message
            : typed?.submitted && typed.terminal
              ? `${message} A response was received; external effects may have happened; do not repeat automatically.`
              : `${message} Tool was not executed; tool was not dispatched.`;
          return persist(uncertain ? "uncertain" : "failed", { stdout: "", stderr: receiptMessage, exitCode: null });
        }
      } else {
        throw new HttpError(400, "Unsupported approved operation");
      }
      return persist(receipt.exitCode === 0 ? "succeeded" : "failed", receipt);
    } catch (error) {
      if (previous.tool === "run_validation" && error instanceof HttpError) {
        return persist("failed", { stdout: "", stderr: error.message, exitCode: null });
      }
      this.insertSystemBlocker(`approval:${id}`, mission.id, "approval", `Approved operation ${id} has no terminal outcome. It will not be replayed automatically.`);
      return persist("uncertain", { stdout: "", stderr: error instanceof HttpError ? error.message : "Operation failed before a terminal result was recorded.", exitCode: null });
    }
  }

  private async executeMcpApproval(approval: Approval): Promise<unknown> {
    const binding = approval.mcpBinding;
    if (!binding) throw new McpOperationError("MCP approval binding is missing; tool was not executed.", false, true);
    const agent = this.getAgent(approval.agentId);
    const mission = this.getMission(approval.missionId);
    const config = this.mcpServer(binding.serverId);
    if (!agent || !mission || !config) throw new McpOperationError("MCP approval scope is missing; tool was not dispatched.", false, true);
    const validateScope = (): void => {
      const currentMission = this.getMission(approval.missionId);
      const currentAgent = this.getAgent(approval.agentId);
      const currentRole = currentAgent ? this.role(currentAgent.roleId) : undefined;
      const currentServer = this.mcpServer(binding.serverId);
      const grant = currentRole?.mcpPermissions?.find((item) => item.serverId === binding.serverId && item.toolName === binding.toolName);
      if (
        !currentMission || currentMission.status !== "active" ||
        !currentAgent || currentAgent.missionId !== currentMission.id || currentAgent.epoch !== binding.actorEpoch ||
        !currentRole || this.roleRevision(currentRole.id) !== binding.roleRevision ||
        !grant || grant.mode !== binding.permissionMode ||
        !currentServer || !currentServer.enabled || currentServer.revision !== binding.serverRevision
      ) throw new McpOperationError("MCP approval scope is stale; tool was not dispatched.", false, true);
    };
    validateScope();
    const result = await this.mcpRuntime.call(
      config, agent.workspacePath,
      { missionId: mission.id, agentId: agent.id, serverId: binding.serverId, revision: binding.serverRevision },
      binding.toolName, approval.args, binding.definitionHash,
      validateScope
    );
    return result.result;
  }

  setAgentStatus(agentId: string, epoch: number, status: Agent["status"], error?: string): boolean {
    const agent = this.getAgent(agentId);
    if (!agent || agent.epoch !== epoch) return false;
    const updated: Agent = { ...agent, status, updatedAt: now(), ...(error === undefined ? {} : { error }) };
    this.putAgent(updated);
    this.event(agent.missionId, "agent_status", `Agent status: ${status}.`, agent.id, error ? { error } : undefined);
    return true;
  }

  recordWorkerDiagnostic(agentId: string, epoch: number, diagnostic: string): void {
    const agent = this.getAgent(agentId);
    if (!agent || agent.epoch !== epoch) return;
    const text = diagnostic.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(-1000);
    if (!text.trim()) return;
    this.putAgent({ ...agent, error: text, updatedAt: now() });
  }

  failMissionStartup(missionId: string, diagnostic: string): void {
    const mission = this.getMission(missionId);
    if (!mission || !["active", "blocked"].includes(mission.status)) return;
    this.transaction(() => {
      this.putMission({ ...mission, status: "failed", updatedAt: now() });
      this.event(missionId, "worker_start_failed", "A worker could not start; correct its configuration or ownership before resuming.", undefined, {
        diagnostic: diagnostic.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(-1000)
      });
    });
  }

  markAgentInterrupted(agentId: string, expectedEpoch?: number): void {
    const agent = this.getAgent(agentId);
    if (!agent || (expectedEpoch !== undefined && agent.epoch !== expectedEpoch)) return;
    const rows = this.db.prepare("SELECT data FROM messages WHERE mission_id=? AND status IN ('queued','dispatching','admitted','delivering','delivered')").all(agent.missionId) as Row[];
    for (const row of rows) {
      const message = decode<Message>(row.data);
      if (message.recipientId !== agentId) continue;
      const outbox = this.db.prepare("SELECT id,status FROM outbox WHERE message_id=? ORDER BY attempt DESC LIMIT 1").get(message.id) as { id: string; status: string } | undefined;
      const uncertain = outbox?.status !== "queued";
      const status = uncertain ? "uncertain" : "aborted";
      if (outbox && outbox.status !== status) this.db.prepare("UPDATE outbox SET status=? WHERE id=?").run(status, outbox.id);
      const next = { ...message, status, error: uncertain ? "Delivery state is uncertain after interrupt" : "Delivery aborted before worker admission" };
      this.db.prepare("UPDATE messages SET status=?,data=? WHERE id=?").run(status, json(next), next.id);
      this.event(agent.missionId, uncertain ? "delivery_uncertain" : "delivery_aborted", `Delivery ${next.id} ${uncertain ? "may have reached" : "was not admitted to"} the worker before interrupt.`, agentId, { messageId: next.id, attempt: next.attempt });
      if (uncertain && outbox) {
        this.insertSystemBlocker(`delivery:${outbox.id}`, agent.missionId, "delivery", `Delivery ${next.id} may have reached the worker before interruption. Reconcile it before resuming.`);
      }
    }
    this.putAgent({ ...agent, epoch: agent.epoch + 1, status: "offline", updatedAt: now() });
  }

  authorizeAgent(agentId: string, epoch: number, missionId: string): { agent: Agent; mission: Mission; role: RoleProfile } {
    const agent = this.getAgent(agentId);
    const mission = this.getMission(missionId);
    const role = agent ? this.role(agent.roleId) : undefined;
    if (!agent || !mission || !role || agent.missionId !== missionId) throw new HttpError(403, "Worker is not authorized for this mission");
    if (agent.epoch !== epoch) throw new HttpError(409, "Worker epoch is fenced");
    return { agent, mission, role };
  }

  createTask(agentId: string, epoch: number, commandId: string, input: Omit<Task, "id" | "status" | "attempt">): Task {
    const authorized = this.authorizeAgent(agentId, epoch, input.missionId);
    if (authorized.role.kind !== "orchestrator") throw new HttpError(403, "Only the orchestrator may create tasks");
    return this.command(`mission:${input.missionId}:tasks`, commandId, input, () => {
      const dependencies = input.dependencies;
      const fulfills = input.fulfills === undefined ? [] : parseFulfills(input.fulfills, false)!;
      if (input.integration !== undefined && typeof input.integration !== "boolean") throw new HttpError(400, "integration must be boolean");
      if (input.integration && this.getMission(input.missionId)?.workspaceStrategy !== "worktree") throw new HttpError(409, "Integration tasks require worktree mode");
      if (input.integration && fulfills.length) throw new HttpError(400, "Integration tasks must have an empty fulfills list");
      if (input.integration && this.hasIntegrationTask(input.missionId)) {
        throw new HttpError(409, "A worktree Mission can have only one integration task");
      }
      if (new Set(dependencies).size !== dependencies.length) throw new HttpError(400, "Duplicate task dependency");
      this.validateFulfills(input.missionId, fulfills);
      if (input.ownerId && !this.listAgents(input.missionId).some((agent) => agent.id === input.ownerId && agent.kind === "worker")) throw new HttpError(400, "Task owner must be a worker in this mission");
      if (input.validatorId && !this.listAgents(input.missionId).some((agent) => agent.id === input.validatorId && agent.kind === "validator")) throw new HttpError(400, "Task validator must be a validator in this mission");
      for (const dependency of dependencies) {
        const prior = this.db.prepare("SELECT data FROM tasks WHERE id=? AND mission_id=?").get(dependency, input.missionId) as Row | undefined;
        if (!prior) throw new HttpError(400, "Task dependency must belong to the same mission");
      }
      const task: Task = { ...input, fulfills, id: randomUUID(), status: dependencies.length === 0 ? "ready" : "blocked", attempt: 0, revision: 0 };
      this.db.prepare("INSERT INTO tasks(id,mission_id,status,data) VALUES(?,?,?,?)").run(task.id, task.missionId, task.status, json(task));
      this.event(task.missionId, "task_created", `Task ${task.title} created.`, agentId, { taskId: task.id, dependencies });
      return task;
    });
  }

  updateTask(agentId: string, epoch: number, commandId: string, taskId: string, change: Partial<Pick<Task, "title" | "description" | "acceptance" | "status" | "dependencies" | "ownerId" | "validatorId" | "evidence" | "fulfills" | "integration">>): Task {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(taskId) as Row | undefined;
    if (!row) throw new HttpError(404, "Task not found");
    const task = decode<Task>(row.data);
    const auth = this.authorizeAgent(agentId, epoch, task.missionId);
    if (auth.role.kind === "validator") throw new HttpError(403, "Validators cannot edit tasks");
    if (auth.role.kind !== "orchestrator" && task.ownerId !== agentId) throw new HttpError(403, "Agent does not own this task");
    if (auth.role.kind !== "orchestrator" && Object.hasOwn(change, "acceptance")) {
      throw new HttpError(403, "Only the orchestrator may edit authoritative task acceptance");
    }
    if (auth.role.kind !== "orchestrator" && ["ownerId", "validatorId", "dependencies", "fulfills"].some((key) => Object.hasOwn(change, key))) {
      throw new HttpError(403, "Only the orchestrator may assign or reassign tasks");
    }
    if (Object.hasOwn(change, "integration") && auth.role.kind !== "orchestrator") {
      throw new HttpError(403, "Only the orchestrator may set the integration task flag");
    }
    if (change.status === "accepted") throw new HttpError(409, "Tasks can only be accepted by successful validation");
    if (change.status && !["pending", "ready", "running", "review", "blocked"].includes(change.status)) {
      throw new HttpError(400, "Invalid task status");
    }
    const fulfills = Object.hasOwn(change, "fulfills") ? parseFulfills(change.fulfills, false)! : task.fulfills ?? [];
    if (Object.hasOwn(change, "integration") && typeof change.integration !== "boolean") throw new HttpError(400, "integration must be boolean");
    if ((change.integration ?? task.integration) && this.getMission(task.missionId)?.workspaceStrategy !== "worktree") {
      throw new HttpError(409, "Integration tasks require worktree mode");
    }
    if ((change.integration ?? task.integration) && fulfills.length) throw new HttpError(400, "Integration tasks must have an empty fulfills list");
    if (Object.hasOwn(change, "fulfills")) this.validateFulfills(task.missionId, fulfills, task.id);
    if (task.status === "accepted" && Object.keys(change).length > 0) throw new HttpError(409, "An accepted task cannot be modified");
    return this.command(`mission:${task.missionId}:tasks`, commandId, { taskId, change }, () => {
      this.validateFulfills(task.missionId, fulfills, task.id);
      if ((change.integration ?? task.integration) && this.hasIntegrationTask(task.missionId, task.id)) {
        throw new HttpError(409, "A worktree Mission can have only one integration task");
      }
      if (change.dependencies) this.checkDependencies(taskId, task.missionId, change.dependencies);
      const ownerId = change.ownerId ?? task.ownerId;
      const validatorId = change.validatorId ?? task.validatorId;
      if (ownerId && !this.listAgents(task.missionId).some((agent) => agent.id === ownerId && agent.kind === "worker")) throw new HttpError(400, "Task owner must be a worker in this mission");
      if (validatorId && !this.listAgents(task.missionId).some((agent) => agent.id === validatorId && agent.kind === "validator")) throw new HttpError(400, "Task validator must be a validator in this mission");
      if (ownerId && validatorId && ownerId === validatorId) throw new HttpError(400, "Task owner and validator must be distinct");
      if (change.status === "review" && (!ownerId || !validatorId || ownerId === validatorId)) throw new HttpError(409, "A task requires a distinct implementation owner and validator before review");
      const nextAttempt = change.status === "running" && task.attempt === 0 ? 1 : task.attempt;
      const updated = { ...task, ...change, fulfills, attempt: nextAttempt, revision: (task.revision ?? 0) + 1 };
      if (["ready", "running", "review"].includes(updated.status) && updated.dependencies.some((id) => {
        const row = this.db.prepare("SELECT data FROM tasks WHERE id=? AND mission_id=?").get(id, task.missionId) as Row | undefined;
        return !row || decode<Task>(row.data).status !== "accepted";
      })) {
        throw new HttpError(409, "Task dependencies must be accepted before work can proceed");
      }
      this.db.prepare("UPDATE tasks SET status=?,data=? WHERE id=?").run(updated.status, json(updated), taskId);
      this.event(task.missionId, "task_updated", `Task ${updated.title} updated.`, agentId, { taskId, status: updated.status });
      return updated;
    });
  }

  private validateFulfills(missionId: string, fulfills: string[], taskId?: string): void {
    const contract = this.validationContract(missionId);
    if (fulfills.length && !contract) throw new HttpError(409, "Legacy missions do not have assertion IDs to claim");
    const known = new Set(contract?.assertions.map((assertion) => assertion.id) ?? []);
    if (fulfills.some((id) => !known.has(id))) throw new HttpError(400, "Task fulfills an unknown assertion id");
    const rows = this.db.prepare("SELECT id,data FROM tasks WHERE mission_id=?").all(missionId) as Array<{ id: string; data: string }>;
    for (const row of rows) {
      if (row.id === taskId) continue;
      const other = decode<Task>(row.data);
      if ((other.fulfills ?? []).some((id) => fulfills.includes(id))) throw new HttpError(409, "An assertion may only be claimed by one task");
    }
  }

  private checkDependencies(taskId: string, missionId: string, dependencies: string[]): void {
    const rows = this.db.prepare("SELECT id,data FROM tasks WHERE mission_id=?").all(missionId) as Array<{ id: string; data: string }>;
    const graph = new Map(rows.map((row) => [row.id, decode<Task>(row.data).dependencies]));
    graph.set(taskId, dependencies);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new HttpError(400, "Task dependencies cannot contain a cycle");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of graph.get(id) ?? []) {
        if (!graph.has(dependency)) throw new HttpError(400, "Task dependency must belong to the same mission");
        visit(dependency);
      }
      visiting.delete(id);
      visited.add(id);
    };
    visit(taskId);
  }

  private assertValidationActor(agentId: string, role: RoleProfile, task: Task): void {
    if (role.kind !== "validator" || task.validatorId !== agentId || !task.ownerId || task.ownerId === agentId) {
      throw new HttpError(403, "Only the distinct assigned validator can validate this task");
    }
  }

  private async runValidation(
    agentId: string,
    epoch: number,
    commandId: string,
    input: { taskId: string; command: string; artifactIds: string[] },
    approvalId?: string
  ): Promise<ValidationReceipt> {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(input.taskId) as Row | undefined;
    if (!row) throw new HttpError(404, "Task not found");
    const task = decode<Task>(row.data);
    const auth = this.authorizeAgent(agentId, epoch, task.missionId);
    this.assertValidationActor(auth.agent.id, auth.role, task);
    if (!commandId || commandId.length > 240) throw new HttpError(400, "A validation command id is required (maximum 240 characters)");
    const scope = `mission:${task.missionId}:validation:${agentId}${approvalId ? `:approval:${approvalId}` : ""}`;
    const digest = hash(input);
    const existing = this.db.prepare("SELECT payload_hash,status,receipt_id FROM validation_intents WHERE scope=? AND command_id=?")
      .get(scope, commandId) as { payload_hash: string; status: string; receipt_id: string | null } | undefined;
    if (existing) {
      if (existing.payload_hash !== digest) throw new HttpError(409, "The validation command id was already used with a different payload");
      if (existing.status === "terminal" && existing.receipt_id) {
        const receiptRow = this.db.prepare("SELECT data FROM validation_receipts WHERE id=?").get(existing.receipt_id) as Row | undefined;
        if (receiptRow) return decode<ValidationReceipt>(receiptRow.data);
      }
      if (existing.status === "aborted") {
        const worktreeId = `validation:${hash([task.missionId, task.id, commandId]).slice(0, 32)}`;
        const error = this.worktree(worktreeId)?.error ?? "Validation worktree preparation failed";
        throw new HttpError(409, `validation was not executed: ${error}`);
      }
      const inFlight = this.validationFlights.get(`${scope}\0${commandId}`);
      if (inFlight) return inFlight.promise;
      throw new HttpError(409, "Validation outcome is uncertain; resolve its blocker before retrying");
    }
    if (task.status !== "review" && !(task.status === "blocked" && task.attempt > 0)) throw new HttpError(409, "Task must be in review or explicit rework before validation");
    if (task.dependencies.some((id) => this.task(id)?.status !== "accepted")) throw new HttpError(409, "Task dependencies must be accepted before validation");
    if (!input.artifactIds.length) throw new HttpError(400, "Validation requires at least one artifact");
    if (new Set(input.artifactIds).size !== input.artifactIds.length) throw new HttpError(400, "Duplicate artifact id");
    const artifacts = input.artifactIds.map((id) => this.artifact(id));
    if (artifacts.some((artifact) => !artifact || artifact.missionId !== task.missionId || (artifact.taskId && artifact.taskId !== task.id))) {
      throw new HttpError(400, "Every validation artifact must belong to this mission and task");
    }
    if (!input.command.trim() || input.command.length > 12000) throw new HttpError(400, "Validation command must be 1–12000 characters");
    const mission = this.getMission(task.missionId)!;
    const worktreeMode = mission.workspaceStrategy === "worktree";
    const owner = task.ownerId ? this.getAgent(task.ownerId) : undefined;
    const ownerRecord = worktreeMode && owner?.worktreeId ? this.worktree(owner.worktreeId) : undefined;
    let ownerCommit: string | undefined;
    if (worktreeMode) {
      if (!mission.repository || !owner || owner.missionId !== task.missionId || ownerRecord?.status !== "ready") throw new HttpError(409, "Task owner has no ready worktree");
      if (owner.status === "running" || owner.status === "recovering" || this.activeWorkspaceOperations.has(owner.id)) {
        throw new HttpError(409, "Task owner still has active work");
      }
      if (!isWorktreeClean(ownerRecord.path)) throw new HttpError(409, "Task owner worktree must be clean before validation");
      ownerCommit = repositoryHead(ownerRecord.path);
      verifyWorktree(mission.repository!, ownerRecord.path, { ...(ownerRecord.branch ? { branch: ownerRecord.branch } : {}) });
    }
    const artifactDigests = Object.fromEntries(artifacts.map((artifact) => {
      if (!artifact!.snapshotPath) throw new HttpError(409, "Artifact has no immutable daemon snapshot");
      const snapshotDigest = createHash("sha256").update(readFileSync(artifact!.snapshotPath)).digest("hex");
      if (snapshotDigest !== artifact!.sha256) throw new HttpError(409, "Immutable artifact snapshot changed");
      if (worktreeMode) {
        if (artifact!.agentId !== owner!.id || artifact!.taskId !== task.id || !artifact!.workspaceCommit || !artifact!.relativePath ||
          !isAncestor(ownerRecord!.repositoryPath, artifact!.workspaceCommit, ownerCommit!)) {
          throw new HttpError(409, "Every selected worktree artifact must be committed by this task owner and present in its current branch");
        }
        const blob = trackedBlobAt(ownerRecord!.repositoryPath, ownerCommit!, artifact!.relativePath);
        if (createHash("sha256").update(blob.bytes).digest("hex") !== artifact!.sha256 || !blob.bytes.equals(readFileSync(artifact!.snapshotPath))) {
          throw new HttpError(409, "Selected artifact blob does not match its immutable snapshot");
        }
      } else {
        const sourceDigest = createHash("sha256").update(readFileSync(artifact!.path)).digest("hex");
        if (sourceDigest !== artifact!.sha256) throw new HttpError(409, "Artifact source changed");
      }
      return [artifact!.id, snapshotDigest];
    }));
    const workspace = this.workspaceForMission(task.missionId);
    if (!workspace && !worktreeMode) throw new HttpError(409, "Mission workspace is unavailable");
    const contract = this.validationContract(task.missionId);
    const effectiveAssertions = task.integration && contract
      ? contract.assertions.map((assertion) => assertion.id)
      : task.fulfills ?? [];
    const claimedRequirements = contract && effectiveAssertions.length > 0
      ? Object.fromEntries(effectiveAssertions.map((id) => {
        const requirement = contract.assertions.find((item) => item.id === id);
        if (!requirement) throw new HttpError(409, "Task assertion claims are stale; reassign fulfills before validation");
        return [id, requirement.revision];
      }))
      : undefined;
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[key]) env[key] = process.env[key];
    const receiptId = `${task.missionId}:${agentId}:${commandId}`;
    const blockerId = approvalId ? `approval:${approvalId}` : `validation:${task.missionId}:${commandId}`;
    const validationWorktree: WorktreeRecord | undefined = worktreeMode ? {
      id: `validation:${hash([task.missionId, task.id, commandId]).slice(0, 32)}`,
      missionId: task.missionId,
      kind: "validation",
      path: join(resolve(this.home), "worktrees", task.missionId, "validation", hash([task.id, commandId]).slice(0, 32)),
      baseCommit: ownerCommit!,
      repositoryPath: ownerRecord!.repositoryPath,
      gitCommonDir: ownerRecord!.gitCommonDir,
      status: "pending",
      createdAt: now()
    } : undefined;
    this.transaction(() => {
      this.db.prepare("INSERT INTO validation_intents(scope,command_id,payload_hash,status,mission_id,task_id,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(scope, commandId, digest, "pending", task.missionId, task.id, receiptId, now());
      if (validationWorktree) this.saveWorktree(validationWorktree);
    });
    let validationCwd = workspace?.path ?? "";
    if (validationWorktree) {
      try {
        ensureWorktreeParent(this.home, validationWorktree.path);
        addDetachedWorktree(mission.repository!, validationWorktree.path, ownerCommit!);
        verifyWorktree(mission.repository!, validationWorktree.path, { commit: ownerCommit!, detached: true });
        validationWorktree.status = "ready";
        validationWorktree.checkedAt = now();
        this.saveWorktree(validationWorktree);
        validationCwd = validationWorktree.path;
      } catch (error) {
        const failed = { ...validationWorktree, status: "error" as const, error: error instanceof Error ? error.message : "Validation worktree preparation failed", checkedAt: now() };
        this.transaction(() => {
          this.saveWorktree(failed);
          this.db.prepare("UPDATE validation_intents SET status='aborted',receipt_id=NULL WHERE scope=? AND command_id=? AND status='pending'")
            .run(scope, commandId);
        });
        throw new HttpError(409, `Validation worktree could not be prepared safely: ${failed.error}`);
      }
    }
    const key = `${scope}\0${commandId}`;
    const promise = this.startShellProcess(input.command, validationCwd, env, task.missionId, agentId).then(({ stdout, stderr, exitCode }) => {
      const snapshotIntegrity = validationWorktree ? isTrackedSnapshotClean(validationCwd, ownerCommit!) : undefined;
      const receipt: ValidationReceipt = {
        id: receiptId, missionId: task.missionId, taskId: task.id, validatorId: agentId, command: input.command,
        stdout, stderr, exitCode,
        attempt: task.attempt, taskRevision: task.revision ?? 0, artifactIds: [...input.artifactIds], artifactDigests, createdAt: now(),
        ...(contract ? { contractRevision: contract.revision } : {}),
        ...(contract ? { requirementRevisions: claimedRequirements ?? {} } : {}),
        ...(validationWorktree ? {
          workspaceCommit: ownerCommit!, ...(ownerRecord!.branch ? { workspaceBranch: ownerRecord!.branch } : {}), workspacePath: validationCwd,
          snapshotIntegrity: snapshotIntegrity === true, ...(snapshotIntegrity !== true ? { snapshotError: "Tracked validation inputs changed during execution." } : {})
        } : {})
      };
      this.db.prepare("INSERT INTO validation_receipts(id,mission_id,task_id,data) VALUES(?,?,?,?)").run(receipt.id, receipt.missionId, receipt.taskId, json(receipt));
      this.db.prepare("UPDATE validation_intents SET status=?,receipt_id=? WHERE scope=? AND command_id=?").run(exitCode === null ? "uncertain" : "terminal", receipt.id, scope, commandId);
      if (exitCode === null) {
        this.insertSystemBlocker(blockerId, task.missionId, approvalId ? "approval" : "unsafe_execution", `Validation ${commandId} ended without a known result. It will not be replayed automatically.`);
      }
      this.event(task.missionId, "validation_receipt", `Validation command exited ${exitCode}.`, agentId, { receiptId, taskId: task.id, attempt: task.attempt, artifactIds: input.artifactIds, exitCode, stdout: receipt.stdout, stderr: receipt.stderr });
      return receipt;
    });
    this.validationFlights.set(key, { digest, promise });
    return await promise.finally(() => {
      if (this.validationFlights.get(key)?.promise === promise) this.validationFlights.delete(key);
    });
  }

  private task(id: string): Task | undefined {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(id) as Row | undefined;
    return row ? decode<Task>(row.data) : undefined;
  }

  private hasIntegrationTask(missionId: string, exceptTaskId?: string): boolean {
    const rows = this.db.prepare("SELECT id,data FROM tasks WHERE mission_id=?").all(missionId) as Array<{ id: string; data: string }>;
    return rows.some((row) => row.id !== exceptTaskId && decode<Task>(row.data).integration === true);
  }

  validateTask(agentId: string, epoch: number, commandId: string, taskId: string, receiptId: string, passed: boolean, evidence: string, assertionResults?: AssertionResult[]): Validation {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(taskId) as Row | undefined;
    if (!row) throw new HttpError(404, "Task not found");
    const task = decode<Task>(row.data);
    const auth = this.authorizeAgent(agentId, epoch, task.missionId);
    if (auth.role.kind !== "validator") throw new HttpError(403, "Only a validator can validate tasks");
    const validationScope = `mission:${task.missionId}:validations`;
    const contract = this.validationContract(task.missionId);
    const mission = this.getMission(task.missionId)!;
    const worktreeMode = mission.workspaceStrategy === "worktree";
    const claimedIds = task.integration && contract ? contract.assertions.map((assertion) => assertion.id) : task.fulfills ?? [];
    if (task.integration && (!worktreeMode || !contract)) throw new HttpError(409, "Integration validation requires a worktree Mission contract");
    if (assertionResults !== undefined) {
      if (!Array.isArray(assertionResults)) throw new HttpError(400, "assertionResults must be an array");
      const seen = new Set<string>();
      for (const result of assertionResults) {
        if (!isRecord(result) || typeof result.assertionId !== "string" || !["passed", "failed", "untested"].includes(result.status) ||
          typeof result.evidence !== "string" || !result.evidence.trim()) throw new HttpError(400, "Each assertion result requires an id, status, and evidence");
        if (seen.has(result.assertionId)) throw new HttpError(400, "Duplicate assertion result");
        seen.add(result.assertionId);
      }
      if ((claimedIds.length > 0 && (seen.size !== claimedIds.length || claimedIds.some((id) => !seen.has(id)))) ||
        (claimedIds.length === 0 && seen.size > 0)) {
        throw new HttpError(409, task.integration ? "Integration assertion results must exactly match the current contract" : "Assertion results must exactly match the task fulfills claims");
      }
    } else if (contract && claimedIds.length) {
      throw new HttpError(400, "Assertion results are required for claimed contract assertions");
    }
    const normalizedResults = assertionResults?.map((result) => ({ assertionId: result.assertionId, status: result.status, evidence: result.evidence })) as AssertionResult[] | undefined;
    const validationPayload = {
      taskId, receiptId, passed, evidence,
      ...(normalizedResults === undefined ? {} : { assertionResults: normalizedResults })
    };
    const previousCommand = this.db.prepare("SELECT payload_hash,response FROM commands WHERE scope=? AND command_id=?")
      .get(validationScope, commandId) as { payload_hash: string; response: string } | undefined;
    if (previousCommand) {
      if (previousCommand.payload_hash !== hash(validationPayload)) throw new HttpError(409, "The command id was already used with a different payload");
      return decode<Validation>(previousCommand.response);
    }
    if (!task.ownerId || !task.validatorId || task.ownerId === task.validatorId) throw new HttpError(409, "Task must have a distinct implementation owner and validator");
    if (task.ownerId === agentId) throw new HttpError(403, "A task owner cannot validate its own task");
    if (task.validatorId !== agentId) throw new HttpError(403, "Task is assigned to a different validator");
    if (task.status !== "review" && !(task.status === "blocked" && task.attempt > 0)) throw new HttpError(409, "Task must be in review or explicit rework before validation");
    if (!evidence.trim()) throw new HttpError(400, "Validation evidence is required");
    const receiptRow = this.db.prepare("SELECT data FROM validation_receipts WHERE id=? AND task_id=? AND mission_id=?").get(receiptId, taskId, task.missionId) as Row | undefined;
    if (!receiptRow) throw new HttpError(409, "A genuine validation receipt is required");
    const receipt = decode<ValidationReceipt>(receiptRow.data);
    if (receipt.validatorId !== agentId || receipt.attempt !== task.attempt || receipt.taskRevision !== (task.revision ?? 0)) throw new HttpError(409, "Validation receipt is stale or belongs to another validator");
    if (receipt.contractRevision !== contract?.revision) throw new HttpError(409, "Validation receipt is stale for the current contract revision");
    if (worktreeMode) {
      if (receipt.snapshotIntegrity !== true || !receipt.workspaceCommit || !receipt.workspacePath) {
        throw new HttpError(409, "Worktree validation receipt does not prove an intact tracked snapshot");
      }
      const owner = task.ownerId ? this.getAgent(task.ownerId) : undefined;
      const ownerRecord = owner?.worktreeId ? this.worktree(owner.worktreeId) : undefined;
      if (!owner || ownerRecord?.status !== "ready" || repositoryHead(ownerRecord.path) !== receipt.workspaceCommit || !isWorktreeClean(ownerRecord.path)) {
        throw new HttpError(409, "Validation receipt is stale because the task owner's worktree changed");
      }
    }
    const currentRevisions = contract && claimedIds.length
      ? Object.fromEntries(claimedIds.map((id) => {
        const requirement = contract.assertions.find((item) => item.id === id);
        if (!requirement) throw new HttpError(409, "Task assertion claim is no longer in the validation contract");
        return [id, requirement.revision];
      }))
      : undefined;
    if (currentRevisions) {
      const receiptRevisions = receipt.requirementRevisions;
      if (!receiptRevisions || Object.keys(receiptRevisions).length !== Object.keys(currentRevisions).length ||
        Object.entries(currentRevisions).some(([id, revision]) => receiptRevisions[id] !== revision)) {
        throw new HttpError(409, "Validation receipt is stale for the current assertion revisions");
      }
    }
    for (const artifactId of receipt.artifactIds) {
      const artifact = this.artifact(artifactId);
      if (!artifact || !artifact.snapshotPath ||
        (!worktreeMode && createHash("sha256").update(readFileSync(artifact.path)).digest("hex") !== artifact.sha256) ||
        createHash("sha256").update(readFileSync(artifact.snapshotPath)).digest("hex") !== artifact.sha256 ||
        receipt.artifactDigests[artifactId] !== artifact.sha256 ||
        (worktreeMode && (!artifact.workspaceCommit || !artifact.relativePath || artifact.agentId !== task.ownerId ||
          artifact.taskId !== task.id || !isAncestor(mission.repository!.path, artifact.workspaceCommit, receipt.workspaceCommit!) ||
          createHash("sha256").update(trackedBlobAt(mission.repository!.path, artifact.workspaceCommit, artifact.relativePath).bytes).digest("hex") !== artifact.sha256))) {
        throw new HttpError(409, "Validation artifact is stale or has changed");
      }
    }
    if (passed && receipt.exitCode !== 0) throw new HttpError(409, "A passing validation requires a completed exit-0 command receipt");
    if (passed && worktreeMode && receipt.snapshotIntegrity !== true) throw new HttpError(409, "A passing worktree validation requires an intact tracked snapshot");
    if (passed && normalizedResults?.some((result) => result.status !== "passed")) throw new HttpError(409, "Every claimed assertion must pass before the task can be accepted");
    if (task.dependencies.some((id) => this.task(id)?.status !== "accepted")) throw new HttpError(409, "Task dependencies must be accepted before validation");
    return this.command(validationScope, commandId, validationPayload, () => {
      const validation: Validation = {
        id: randomUUID(), missionId: task.missionId, taskId, agentId, passed, evidence, receiptId,
        attempt: task.attempt, taskRevision: task.revision ?? 0, artifactIds: receipt.artifactIds, createdAt: now(),
        ...(currentRevisions ? { requirementRevisions: currentRevisions } : {}),
        ...(normalizedResults ? { assertionResults: normalizedResults } : {})
      };
      const updated: Task = passed
        ? { ...task, status: "accepted", validatorId: agentId, evidence }
        : { ...task, status: "blocked", validatorId: agentId, evidence, attempt: task.attempt + 1 };
      this.db.prepare("INSERT INTO validations(id,mission_id,task_id,data) VALUES(?,?,?,?)").run(validation.id, validation.missionId, validation.taskId, json(validation));
      this.db.prepare("UPDATE tasks SET status=?,data=? WHERE id=?").run(updated.status, json(updated), taskId);
      this.refreshDependentTasks(task.missionId);
      this.event(task.missionId, passed ? "task_accepted" : "task_rework_requested", passed ? "Task passed independent validation." : "Validation failed; task requires an explicit rework attempt.", agentId, { taskId, validationId: validation.id, attempt: updated.attempt });
      return validation;
    });
  }

  private refreshDependentTasks(missionId: string): void {
    const rows = this.db.prepare("SELECT id,data FROM tasks WHERE mission_id=?").all(missionId) as Array<{ id: string; data: string }>;
    for (const row of rows) {
      const task = decode<Task>(row.data);
      if (task.status !== "blocked" || task.attempt > 0) continue;
      const ready = task.dependencies.every((id) => {
        const dependency = rows.find((item) => item.id === id);
        return dependency ? decode<Task>(dependency.data).status === "accepted" : false;
      });
      if (ready) {
        const updated = { ...task, status: "ready" as const };
        this.db.prepare("UPDATE tasks SET status=?,data=? WHERE id=?").run(updated.status, json(updated), updated.id);
      }
    }
  }

  createApproval(agentId: string, epoch: number, commandId: string, tool: string, args: unknown): Approval {
    const agent = this.getAgent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    const auth = this.authorizeAgent(agentId, epoch, agent.missionId);
    if (auth.mission.status !== "active") throw new HttpError(409, "Mission is not active");
    if (auth.role.kind === "validator" && tool !== "run_validation") throw new HttpError(403, "Validators can only request validation approvals");
    let validationTask: Task | undefined;
    if (tool === "run_validation") {
      if (auth.role.kind !== "validator") throw new HttpError(403, "Only an assigned validator may request validation approval");
      if (!args || typeof args !== "object") throw new HttpError(400, "Invalid validation approval payload");
      const input = args as { taskId?: unknown };
      validationTask = typeof input.taskId === "string" ? this.task(input.taskId) : undefined;
      if (!validationTask || validationTask.missionId !== agent.missionId) throw new HttpError(404, "Validation task not found in this mission");
      this.assertValidationActor(agent.id, auth.role, validationTask);
    }
    const commandScope = `mission:${agent.missionId}:approvals`;
    const payload = { tool, args };
    const replay = this.commandReplay<Approval>(commandScope, commandId, payload);
    if (replay) return replay;
    if (tool === "run_validation") {
      if (!args || typeof args !== "object") throw new HttpError(400, "Invalid validation approval payload");
      const input = args as { taskId?: unknown; command?: unknown; artifactIds?: unknown };
      const task = validationTask!;
      if (task.status !== "review" && !(task.status === "blocked" && task.attempt > 0)) throw new HttpError(409, "Task must be in review or explicit rework before validation");
      if (typeof input.command !== "string" || !input.command.trim() || !Array.isArray(input.artifactIds) || input.artifactIds.length === 0 || input.artifactIds.some((id) => typeof id !== "string")) {
        throw new HttpError(400, "Validation approval requires a command and artifact ids");
      }
      for (const artifactId of input.artifactIds) {
        const artifact = this.artifact(artifactId);
        if (!artifact || artifact.missionId !== task.missionId || (artifact.taskId && artifact.taskId !== task.id) || !artifact.snapshotPath) {
          throw new HttpError(400, "Validation approval artifact is not current for this task");
        }
      }
    }
    return this.command(commandScope, commandId, payload, () => {
      const binding: Partial<ValidationApprovalBinding> = tool === "run_validation" && validationTask
        ? (() => {
          const contract = this.validationContract(validationTask!.missionId);
          return {
            validationTaskId: validationTask.id,
            validationAttempt: validationTask.attempt,
            validationTaskRevision: validationTask.revision ?? 0,
            ...(contract ? { contractRevision: contract.revision } : {}),
            requirementRevisions: contract ? Object.fromEntries((validationTask!.fulfills ?? []).map((id) => {
              const requirement = contract.assertions.find((item) => item.id === id);
              if (!requirement) throw new HttpError(409, "Task assertion claim is stale");
              return [id, requirement.revision];
            })) : {}
          };
        })()
        : {};
      const approval: Approval = { id: randomUUID(), missionId: agent.missionId, agentId, tool, args, status: "pending", createdAt: now(), ...binding };
      this.db.prepare("INSERT INTO approvals(id,mission_id,status,data) VALUES(?,?,?,?)").run(approval.id, approval.missionId, approval.status, json(approval));
      this.setAgentStatus(agentId, epoch, "waiting_approval");
      this.event(agent.missionId, "approval_requested", `Approval requested for ${tool}.`, agentId, { approvalId: approval.id });
      return approval;
    });
  }

  async createMcpApproval(
    agentId: string, epoch: number, commandId: string, serverId: string, toolName: string,
    input: unknown, definitionHash: string
  ): Promise<Approval> {
    if (!/^[a-f0-9]{64}$/.test(definitionHash)) throw new HttpError(400, "definitionHash must be a SHA-256 digest");
    let normalized: unknown;
    try {
      const serialized = JSON.stringify(input);
      if (serialized === undefined || Buffer.byteLength(serialized) > 256 * 1024) throw new Error();
      normalized = JSON.parse(serialized);
    } catch {
      throw new HttpError(400, "MCP arguments must be a JSON value no larger than 256 KiB");
    }
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) throw new HttpError(400, "MCP arguments must be a JSON object");
    const agent = this.getAgent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    const auth = this.authorizeAgent(agentId, epoch, agent.missionId);
    if (auth.mission.status !== "active") throw new HttpError(409, "Mission is not active");
    const permission = (auth.role.mcpPermissions ?? []).find((grant) => grant.serverId === serverId && grant.toolName === toolName);
    if (!permission) throw new HttpError(403, "This exact MCP tool is not granted to the role");
    const server = this.mcpServer(serverId);
    if (!server || !server.enabled) throw new HttpError(404, "Enabled MCP server not found");
    const secrets = mcpSecretValues(server);
    if (JSON.stringify(redactMcpValue(normalized, secrets)) !== JSON.stringify(normalized)) {
      throw new HttpError(400, "MCP tool arguments must not contain configured credential values; credentials are supplied through references");
    }
    const roleRevision = this.roleRevision(auth.role.id);
    const mission = auth.mission;
    const payloadHash = hash({ serverId, toolName, normalized, definitionHash });
    const prior = this.db.prepare("SELECT payload_hash,approval_id FROM mcp_call_commands WHERE actor_id=? AND command_id=?")
      .get(agentId, commandId) as { payload_hash: string; approval_id: string } | undefined;
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new HttpError(409, "MCP command id was already used with different arguments");
      const row = this.db.prepare("SELECT data FROM approvals WHERE id=?").get(prior.approval_id) as Row | undefined;
      if (!row) throw new HttpError(409, "MCP approval journal entry is missing");
      const existing = decode<Approval>(row.data);
      return existing.status === "approved" || (existing.status === "running" && this.approvalFlights.has(existing.id))
        ? this.executeApproved(existing.id)
        : existing;
    }
    const pending = mission.autonomy === "approve" || permission.mode === "approve";
    const approval: Approval = {
      id: randomUUID(), missionId: mission.id, agentId, tool: "mcp_call", args: normalized,
      status: pending ? "pending" : "approved", createdAt: now(), authorizationSource: "role-permission",
      mcpBinding: {
        serverId, serverRevision: server.revision, roleRevision, actorEpoch: epoch, toolName,
        definitionHash, commandId, permissionMode: permission.mode
      }
    };
    this.transaction(() => {
      this.db.prepare("INSERT INTO approvals(id,mission_id,status,data) VALUES(?,?,?,?)")
        .run(approval.id, approval.missionId, approval.status, json(approval));
      this.db.prepare("INSERT INTO mcp_call_commands(actor_id,command_id,payload_hash,approval_id) VALUES(?,?,?,?)")
        .run(agentId, commandId, payloadHash, approval.id);
      if (pending) this.setAgentStatus(agentId, epoch, "waiting_approval");
      this.event(mission.id, "approval_requested", "Approval requested for mcp_call.", agentId, { approvalId: approval.id, authorizationSource: "role-permission" });
    });
    return pending ? approval : this.executeApproved(approval.id);
  }

  private roleRevision(roleId: string): number {
    const row = this.db.prepare("SELECT MAX(revision) AS revision FROM role_revisions WHERE role_id=?").get(roleId) as { revision: number | null } | undefined;
    return row?.revision ?? 0;
  }

  resolveApproval(id: string, decision: "approved" | "denied"): Approval {
    return this.command(`approval:${id}`, "user-decision", { decision }, () => {
      const row = this.db.prepare("SELECT data FROM approvals WHERE id=?").get(id) as Row | undefined;
      if (!row) throw new HttpError(404, "Approval not found");
      const approval = decode<Approval>(row.data);
      if (approval.status !== "pending") throw new HttpError(409, "Approval is no longer pending");
      const updated = {
        ...approval, status: decision,
        ...(approval.tool === "mcp_call" && decision === "approved" ? { authorizationSource: "user-approval" as const } : {})
      };
      this.db.prepare("UPDATE approvals SET status=?,data=? WHERE id=?").run(decision, json(updated), id);
      const mission = this.getMission(approval.missionId);
      const recipient = this.getAgent(approval.agentId);
      if (mission && recipient) {
        const message: Message = {
          id: `approval-outcome:${id}:${decision}`, missionId: mission.id, senderId: "user", recipientId: recipient.id,
          content: `Approval ${id} was ${decision}.`, mode: "followUp",
          status: mission.status === "paused" ? "aborted" : "queued", attempt: 1, createdAt: now(),
          ...(mission.status === "paused" ? { error: "Held while mission is paused; delivery will start after explicit resume" } : {})
        };
        this.db.prepare("INSERT OR IGNORE INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, mission.id, message.status, json(message));
        if (message.status === "queued") this.enqueue(message);
      }
      this.event(approval.missionId, `approval_${decision}`, `Approval ${decision}.`, approval.agentId, { approvalId: id });
      return updated;
    });
  }

  consumeApproval(id: string): Approval {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT data FROM approvals WHERE id=?").get(id) as Row | undefined;
      if (!row) throw new HttpError(404, "Approval not found");
      const approval = decode<Approval>(row.data);
      if (approval.status !== "approved") throw new HttpError(409, "Approval is not approved or was already consumed");
      const consumed = { ...approval, status: "consumed" as const };
      this.db.prepare("UPDATE approvals SET status='consumed',data=? WHERE id=? AND status='approved'").run(json(consumed), id);
      return consumed;
    });
  }

  publishArtifact(agentId: string, epoch: number, commandId: string, name: string, path: string, bytes: Buffer, taskId?: string): Artifact {
    const agent = this.getAgent(agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    const auth = this.authorizeAgent(agentId, epoch, agent.missionId);
    if (auth.role.kind === "validator") throw new HttpError(403, "Validators cannot publish workspace artifacts");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const size = bytes.length;
    return this.command(`mission:${agent.missionId}:artifacts`, commandId, { name, path, sha256, size, taskId }, () => {
      const mission = this.getMission(agent.missionId)!;
      let immutable: { workspaceCommit: string; relativePath: string } | undefined;
      if (taskId) {
        const task = this.task(taskId);
        if (!task || task.missionId !== agent.missionId) throw new HttpError(404, "Artifact task is not in this mission");
        if (auth.role.kind !== "orchestrator" && task.ownerId !== agentId) throw new HttpError(403, "Only the task owner or orchestrator may publish its artifact");
      }
      if (mission.workspaceStrategy === "worktree") {
        const task = taskId ? this.task(taskId) : undefined;
        if (!taskId || !task || task.ownerId !== agentId || auth.role.kind !== "worker") {
          throw new HttpError(403, "Worktree artifacts must be published by their task owner for that task");
        }
        const record = agent.worktreeId ? this.worktree(agent.worktreeId) : undefined;
        if (!record || record.status !== "ready" || record.path !== agent.workspacePath) throw new HttpError(409, "Publisher does not have a ready worktree");
        if (!isWorktreeClean(record.path)) throw new HttpError(409, "Commit the worktree changes and remove non-ignored untracked files before publishing");
        try {
          const tracked = trackedArtifactPath(record.repositoryPath, record.path, path);
          if (!tracked.bytes.equals(bytes)) throw new Error("Artifact RPC bytes do not match the worktree file");
          immutable = { workspaceCommit: repositoryHead(record.path), relativePath: tracked.relativePath };
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : "Artifact is not a committed tracked file");
        }
      }
      const snapshotPath = join(this.home, "artifacts", sha256);
      if (!existsSync(snapshotPath)) {
        try {
          writeFileSync(snapshotPath, bytes, { mode: 0o400, flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      chmodSync(snapshotPath, 0o400);
      const snapshot = readFileSync(snapshotPath);
      if (createHash("sha256").update(snapshot).digest("hex") !== sha256) throw new HttpError(500, "Content-addressed artifact snapshot is corrupt");
      const artifact: Artifact = {
        id: randomUUID(), missionId: agent.missionId, agentId, name, path, sha256, size, createdAt: now(), snapshotPath,
        ...(taskId ? { taskId } : {}), ...(immutable ?? {})
      };
      this.db.prepare("INSERT INTO artifacts(id,mission_id,data) VALUES(?,?,?)").run(artifact.id, artifact.missionId, json(artifact));
      this.event(agent.missionId, "artifact_published", `Artifact ${name} published.`, agentId, { artifactId: artifact.id, sha256 });
      return artifact;
    });
  }

  recordTranscript(agentId: string, role: TranscriptEntry["role"], text: string, id: string = randomUUID()): void {
    this.db.prepare("INSERT OR IGNORE INTO transcript(id,agent_id,role,text,created_at) VALUES(?,?,?,?,?)").run(`${agentId}:${id}`, agentId, role, text, now());
  }

  transcript(agentId: string): TranscriptEntry[] {
    const rows = this.db.prepare("SELECT id,role,text,created_at FROM transcript WHERE agent_id=? ORDER BY rowid").all(agentId) as Array<{ id: string; role: string; text: string; created_at: string }>;
    return rows.map((row) => ({ id: row.id, role: row.role, text: row.text, createdAt: row.created_at }));
  }

  detail(id: string): MissionDetail {
    const mission = this.getMission(id);
    if (!mission) throw new HttpError(404, "Mission not found");
    const related = <T>(table: string): T[] => {
      const rows = this.db.prepare(`SELECT data FROM ${table} WHERE mission_id=?`).all(id) as Row[];
      return rows.map((row) => decode<T>(row.data));
    };
    const events = (this.db.prepare("SELECT seq,data FROM events WHERE mission_id=? ORDER BY seq").all(id) as Array<{ seq: number; data: string }>)
      .map((row) => ({ ...decode<Omit<MissionEvent, "seq">>(row.data), seq: row.seq }));
    const receiptRows = this.db.prepare("SELECT data FROM validation_receipts WHERE mission_id=? ORDER BY rowid").all(id) as Row[];
    const validationContract = this.validationContract(id);
    return {
      mission,
      agents: related<Agent>("agents"),
      tasks: related<Task>("tasks"),
      messages: related<Message>("messages"),
      events,
      approvals: related<Approval>("approvals"),
      artifacts: related<Artifact>("artifacts"),
      validations: related<Validation>("validations"),
      validationReceipts: receiptRows.map((row) => decode<ValidationReceipt>(row.data)),
      blockers: this.blockers(id),
      schedules: this.listSchedules(id),
      scheduleOccurrences: this.scheduleOccurrences(id),
      watchdog: this.watchdog(id),
      watchdogWakes: this.watchdogWakes(id),
      worktrees: this.listWorktrees(id),
      ...(validationContract ? { validationContract } : {}),
      ...(validationContract ? { requirementCoverage: this.requirementCoverage(id) } : {}),
      ...(validationContract ? { validationContractHistory: this.validationContractHistory(id) } : {})
    };
  }

  events(after: number, missionId?: string): MissionEvent[] {
    const rows = missionId
      ? this.db.prepare("SELECT seq,data FROM events WHERE seq>? AND mission_id=? ORDER BY seq").all(after, missionId)
      : this.db.prepare("SELECT seq,data FROM events WHERE seq>? ORDER BY seq").all(after);
    return (rows as Array<{ seq: number; data: string }>).map((row) => ({ ...decode<Omit<MissionEvent, "seq">>(row.data), seq: row.seq }));
  }

  exportMission(id: string): unknown {
    const detail = this.detail(id);
    const commands = this.db.prepare("SELECT scope,command_id,payload_hash,response,created_at FROM commands WHERE scope LIKE ? ORDER BY created_at").all(`mission:${id}:%`);
    const outbox = this.db.prepare("SELECT * FROM outbox WHERE mission_id=? ORDER BY created_at").all(id);
    const generationAdmissions = this.db.prepare("SELECT * FROM generation_admissions WHERE mission_id=? ORDER BY turn_number").all(id);
    const generationDenials = this.db.prepare("SELECT * FROM generation_denials WHERE mission_id=? ORDER BY created_at").all(id);
    const transcripts = detail.agents.map((agent) => ({ agentId: agent.id, entries: this.transcript(agent.id) }));
    return {
      format: "mission-control-replay-v1", exportedAt: now(), ...detail, transcripts, commands, outbox, generationAdmissions, generationDenials,
      validationContractHistory: this.validationContractHistory(id)
    };
  }

  reconcileInFlightOperations(): void {
    this.transaction(() => {
      const approvals = this.db.prepare("SELECT id,data FROM approvals WHERE status='running'").all() as Array<{ id: string; data: string }>;
      for (const row of approvals) {
        const approval = decode<Approval>(row.data);
      const uncertain: Approval = { ...approval, status: "uncertain", receipt: { stdout: "", stderr: "Daemon restarted before an execution outcome was recorded.", exitCode: null } };
        this.db.prepare("UPDATE approvals SET status='uncertain',data=? WHERE id=?").run(json(uncertain), row.id);
        this.insertSystemBlocker(`approval:${row.id}`, approval.missionId, "approval", `Approval ${row.id} may have executed before the daemon stopped. Do not replay it; record a human resolution.`);
      }
      const pending = this.db.prepare("SELECT scope,command_id FROM commands WHERE scope LIKE 'mission:%:bash' AND response=?").all(json({ status: "pending" })) as Array<{ scope: string; command_id: string }>;
      for (const row of pending) {
        const missionId = /^mission:(.+):bash$/.exec(row.scope)?.[1];
        if (!missionId) continue;
        this.db.prepare("UPDATE commands SET response=? WHERE scope=? AND command_id=?").run(json({ status: "uncertain" }), row.scope, row.command_id);
        this.insertSystemBlocker(`shell:${row.command_id}`, missionId, "unsafe_execution", `Shell command ${row.command_id} has no recorded terminal outcome. It will not be replayed automatically.`);
      }
    const validations = this.db.prepare("SELECT scope,command_id,mission_id FROM validation_intents WHERE status='pending'").all() as Array<{ scope: string; command_id: string; mission_id: string }>;
    for (const validation of validations) {
      this.db.prepare("UPDATE validation_intents SET status='uncertain' WHERE scope=? AND command_id=?").run(validation.scope, validation.command_id);
      const approvalId = /:approval:([^:]+)$/.exec(validation.scope)?.[1];
      const blockerId = approvalId ? `approval:${approvalId}` : `validation:${validation.mission_id}:${validation.command_id}`;
      this.insertSystemBlocker(blockerId, validation.mission_id, approvalId ? "approval" : "unsafe_execution", `Validation ${validation.command_id} has no recorded terminal outcome. It will not be replayed automatically.`);
      }
    });
  }

  private insertSystemBlocker(id: string, missionId: string, kind: Blocker["kind"], text: string): void {
    if (this.db.prepare("SELECT 1 FROM blockers WHERE id=?").get(id)) return;
    const blocker: Blocker = { id, missionId, kind, status: "open", text, createdAt: now() };
    this.db.prepare("INSERT INTO blockers(id,mission_id,status,data) VALUES(?,?,?,?)").run(id, missionId, "open", json(blocker));
    const mission = this.getMission(missionId);
    if (mission && !["paused", "failed", "cancelled", "completed"].includes(mission.status)) this.putMission({ ...mission, status: "blocked", updatedAt: now() });
    this.event(missionId, "operation_uncertain", text, undefined, { blockerId: id });
  }

  heartbeat(): void {
    this.fenceStaleWorkerBindings();
    this.db.prepare("UPDATE daemon_owner SET heartbeat_at=? WHERE singleton=1 AND daemon_id=? AND epoch=?").run(Date.now(), this.daemonId, this.ownerEpoch);
  }

  close(): void {
    if (this.closed) return;
    if (this.mcpRuntime.activeCount) throw new Error("MCP runtime must be asynchronously closed before the control database.");
    this.closed = true;
    this.db.prepare("DELETE FROM daemon_owner WHERE singleton=1 AND daemon_id=? AND epoch=?").run(this.daemonId, this.ownerEpoch);
    this.db.close();
  }

  async settlePendingShells(): Promise<void> {
    await Promise.allSettled([...this.shellFlights.values()].map((flight) => flight.promise));
  }

  async settlePendingOperations(): Promise<void> {
    await Promise.allSettled([
      ...[...this.shellFlights.values()].map((flight) => flight.promise),
      ...[...this.validationFlights.values()].map((flight) => flight.promise),
      ...this.approvalFlights.values()
    ]);
  }
}
