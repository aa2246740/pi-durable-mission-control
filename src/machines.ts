import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute, normalize, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const NODE_LEASE_MS = 20_000;
export const NODE_PROTOCOL_VERSION = 1;
export const NODE_EXECUTION_PROTOCOL_VERSION = 2;
export const NODE_COMMAND_KIND = "inspect_workspace" as const;

export class MachineError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface NodeCapabilities {
  protocol: number;
  version: string;
  platform: string;
  arch: string;
  node: string;
  piDurable: string;
  roots: string[];
  credentialRefs: string[];
  executionEnabled: boolean;
  executionMode?: "metadata-only";
}

export interface RemoteMachine {
  id: string;
  name: string;
  kind: "remote";
  status: "enrolled" | "online" | "offline" | "revoked";
  sessionEpoch: number;
  sessionId?: string;
  registrationId?: string;
  capabilitiesHash?: string;
  lastSeenAt?: number;
  leaseExpiresAt?: number;
  capabilities?: NodeCapabilities;
  createdAt: string;
}

export type NodeCommandStatus = "queued" | "dispatched" | "completed" | "failed" | "uncertain" | "cancelled";

export interface NodeCommand {
  id: string;
  machineId: string;
  requestId?: string;
  kind: typeof NODE_COMMAND_KIND;
  payload: { path: string };
  status: NodeCommandStatus;
  sessionEpoch?: number;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

type MachineRow = { id: string; token_hash: string; data: string };
type CommandRow = {
  id: string;
  machine_id: string;
  request_id: string;
  payload_hash: string;
  kind: typeof NODE_COMMAND_KIND;
  payload: string;
  status: NodeCommandStatus;
  session_epoch: number | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sameHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  if (value === undefined) return "null";
  return JSON.stringify(value);
}

export function stableJson(value: unknown): string {
  return stable(value);
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

function stringList(value: unknown, name: string, pattern: (item: string) => boolean, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new MachineError(400, `${name} must be an array of at most ${max} entries`);
  const items = value.map((item) => {
    if (typeof item !== "string" || !pattern(item)) throw new MachineError(400, `${name} contains an invalid entry`);
    return item;
  });
  if (new Set(items).size !== items.length) throw new MachineError(400, `${name} contains duplicates`);
  return items;
}

function shortText(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MachineError(400, `${name} must be printable text of at most ${max} characters`);
  }
  return value;
}

export function parseNodeCapabilities(value: unknown): NodeCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MachineError(400, "Node capabilities must be an object");
  const input = value as Record<string, unknown>;
  const allowed = ["protocol", "version", "platform", "arch", "node", "piDurable", "roots", "credentialRefs", "executionEnabled", "executionMode"];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new MachineError(400, "Unsupported node capability fields");
  const readonly = input.protocol === NODE_PROTOCOL_VERSION && input.executionEnabled === false && !Object.hasOwn(input, "executionMode");
  const metadataOnly = input.protocol === NODE_EXECUTION_PROTOCOL_VERSION
    && input.executionEnabled === true && input.executionMode === "metadata-only";
  if (!readonly && !metadataOnly) throw new MachineError(409, "Node protocol and execution mode are not supported");
  const roots = stringList(input.roots, "roots", (item) => item.startsWith("/") && item.length <= 4096 && !/[\u0000-\u001f]/.test(item), 32);
  if (!roots.length) throw new MachineError(400, "A node must declare at least one workspace root");
  return {
    protocol: input.protocol as number,
    version: shortText(input.version, "version", 40),
    platform: shortText(input.platform, "platform", 40),
    arch: shortText(input.arch, "arch", 40),
    node: shortText(input.node, "node", 40),
    piDurable: shortText(input.piDurable, "piDurable", 80),
    roots,
    credentialRefs: stringList(input.credentialRefs, "credentialRefs", (item) => CREDENTIAL_REF.test(item), 64),
    executionEnabled: metadataOnly,
    ...(metadataOnly ? { executionMode: "metadata-only" as const } : {})
  };
}

function parseMachineId(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value === "local") throw new MachineError(400, "Machine id is invalid");
  return value;
}

function parseRequestId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new MachineError(400, "requestId must be a UUID");
  return value;
}

function parseSessionId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new MachineError(400, "sessionId is invalid");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRegistrationId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new MachineError(400, "registrationId is invalid");
  return value;
}

function parseEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new MachineError(400, "sessionEpoch is invalid");
  return value as number;
}

function parseOutcome(
  value: unknown,
  expectedPath: string,
  roots: string[]
): { ok: true; result: { requestedPath: string; path: string; isDirectory: true } } | { ok: false; error: string } {
  if (!isRecord(value)) throw new MachineError(400, "outcome must be an object");
  const input = value;
  if (input.ok === true) {
    const result = input.result;
    if (Object.keys(input).length !== 2 || !isRecord(result)) {
      throw new MachineError(400, "outcome contains unsupported fields");
    }
    const parsed = result;
    const requestedPath = parsed.requestedPath;
    const reportedPath = parsed.path;
    if (Object.keys(parsed).length !== 3 || typeof requestedPath !== "string" ||
        typeof reportedPath !== "string" || requestedPath !== expectedPath ||
        !requestedPath.startsWith("/") || requestedPath.length > 4096 || requestedPath.includes("\0") ||
        !reportedPath.startsWith("/") || reportedPath.length > 4096 || reportedPath.includes("\0") ||
        normalize(reportedPath) !== reportedPath || parsed.isDirectory !== true ||
        !roots.some((root) => {
          const suffix = relative(root, reportedPath);
          return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
        })) {
      throw new MachineError(400, "workspace probe result is invalid");
    }
    return {
      ok: true,
      result: { requestedPath, path: reportedPath, isDirectory: true }
    };
  }
  if (input.ok === false && Object.keys(input).length === 2 && typeof input.error === "string" &&
      input.error.length > 0 && input.error.length <= 4000) {
    const safeErrors = new Set([
      "probe path must be an absolute path",
      "probe path does not exist",
      "probe path is not a directory",
      "probe path is unavailable",
      "probe path is outside a declared root"
    ]);
    if (!safeErrors.has(input.error)) throw new MachineError(400, "workspace probe error is invalid");
    return { ok: false, error: input.error };
  }
  throw new MachineError(400, "outcome must be a successful result or a bounded error");
}

export class MachineRegistry {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => number = Date.now) {}

  static migrate(db: DatabaseSync): void {
    const hadRegistrationHistory = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='node_registrations'").get());
    db.exec(`
      CREATE TABLE IF NOT EXISTS remote_machines (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS node_commands (
        id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
        session_epoch INTEGER, result TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(machine_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS node_registrations (
        machine_id TEXT NOT NULL, registration_id TEXT NOT NULL, capabilities_hash TEXT NOT NULL,
        session_id TEXT NOT NULL, session_epoch INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(machine_id,registration_id)
      );
      CREATE INDEX IF NOT EXISTS node_commands_machine_idx ON node_commands(machine_id,status,created_at);
    `);
    const columns = db.prepare("PRAGMA table_info(node_commands)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "request_id")) db.exec("ALTER TABLE node_commands ADD COLUMN request_id TEXT NOT NULL DEFAULT ''");
    if (!columns.some((column) => column.name === "payload_hash")) db.exec("ALTER TABLE node_commands ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS node_commands_request_idx ON node_commands(machine_id,request_id)");
    if (!hadRegistrationHistory) {
      const rows = db.prepare("SELECT id,data FROM remote_machines").all() as Array<{ id: string; data: string }>;
      for (const row of rows) {
        const machine = JSON.parse(row.data) as RemoteMachine;
        if (machine.sessionEpoch === 0 && machine.status === "enrolled") continue;
        machine.status = "revoked";
        machine.sessionEpoch += 1;
        delete machine.sessionId;
        delete machine.registrationId;
        delete machine.capabilitiesHash;
        delete machine.leaseExpiresAt;
        db.prepare("UPDATE remote_machines SET token_hash=?,data=? WHERE id=?")
          .run(tokenHash(randomBytes(32).toString("base64url")), JSON.stringify(machine), row.id);
      }
    }
  }

  static fenceOnCoordinatorStart(db: DatabaseSync, at = Date.now()): void {
    const rows = db.prepare("SELECT id,data FROM remote_machines").all() as Array<{ id: string; data: string }>;
    for (const row of rows) {
      const machine = JSON.parse(row.data) as RemoteMachine;
      if (machine.status !== "online") continue;
      const fenced: RemoteMachine = { ...machine, status: "offline", sessionEpoch: machine.sessionEpoch + 1 };
      delete fenced.sessionId;
      delete fenced.registrationId;
      delete fenced.capabilitiesHash;
      delete fenced.leaseExpiresAt;
      db.prepare("UPDATE remote_machines SET data=? WHERE id=?").run(JSON.stringify(fenced), machine.id);
    }
    db.prepare("UPDATE node_commands SET status='cancelled',error=?,updated_at=? WHERE status='queued'")
      .run("Coordinator restarted before this command was claimed", at);
    db.prepare("UPDATE node_commands SET status='uncertain',error=?,updated_at=? WHERE status='dispatched'")
      .run("Coordinator restarted while this command was dispatched; outcome is unknown and it will not be replayed", at);
  }

  private atomic<T>(fn: () => T): T {
    const nested = this.db.isTransaction;
    const savepoint = `node_registry_${randomUUID().replaceAll("-", "")}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return value;
    } catch (error) {
      try {
        if (nested) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } else this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  private row(machineId: string): { row: MachineRow; machine: RemoteMachine } {
    const row = this.db.prepare("SELECT id,token_hash,data FROM remote_machines WHERE id=?").get(machineId) as MachineRow | undefined;
    if (!row) throw new MachineError(404, "Machine not found");
    return { row, machine: JSON.parse(row.data) as RemoteMachine };
  }

  private save(machine: RemoteMachine): void {
    this.db.prepare("UPDATE remote_machines SET data=? WHERE id=?").run(JSON.stringify(machine), machine.id);
  }

  private markInFlightUncertain(machineId: string, reason: string, at = this.clock()): void {
    this.db.prepare("UPDATE node_commands SET status='uncertain',error=?,updated_at=? WHERE machine_id=? AND status='dispatched'")
      .run(reason, at, machineId);
  }

  private expireLeasesInside(at: number): string[] {
    const expired: string[] = [];
    for (const row of this.db.prepare("SELECT id,data FROM remote_machines").all() as Array<{ id: string; data: string }>) {
      const machine = JSON.parse(row.data) as RemoteMachine;
      if (machine.status !== "online" || machine.leaseExpiresAt === undefined || machine.leaseExpiresAt > at) continue;
      const offline: RemoteMachine = { ...machine, status: "offline", sessionEpoch: machine.sessionEpoch + 1 };
      delete offline.sessionId;
      delete offline.registrationId;
      delete offline.capabilitiesHash;
      delete offline.leaseExpiresAt;
      this.save(offline);
      this.markInFlightUncertain(machine.id, "Node lease expired while the command was dispatched; outcome is unknown and it will not be replayed", at);
      expired.push(machine.id);
    }
    return expired;
  }

  expireLeases(): string[] {
    return this.atomic(() => this.expireLeasesInside(this.clock()));
  }

  list(): RemoteMachine[] {
    this.expireLeases();
    return (this.db.prepare("SELECT data FROM remote_machines ORDER BY id").all() as Array<{ data: string }>).map((row) => JSON.parse(row.data) as RemoteMachine);
  }

  get(id: string): RemoteMachine | undefined {
    const row = this.db.prepare("SELECT data FROM remote_machines WHERE id=?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as RemoteMachine : undefined;
  }

  workspaceReceipt(machineId: string, commandId: string): {
    path: string; requestedPath: string; sessionEpoch: number; verifiedAt: number;
  } {
    const machine = this.get(parseMachineId(machineId));
    const command = this.command(commandId, machineId);
    if (!machine || !command) throw new MachineError(404, "Node workspace receipt not found");
    if (command.kind !== NODE_COMMAND_KIND || command.status !== "completed" || command.sessionEpoch === undefined) {
      throw new MachineError(409, "A completed workspace probe is required");
    }
    if (machine.status !== "online" || !machine.leaseExpiresAt || machine.leaseExpiresAt <= this.clock() ||
        machine.sessionEpoch !== command.sessionEpoch || !machine.capabilities) {
      throw new MachineError(409, "Run a fresh workspace probe in the current live node session");
    }
    const outcome = parseOutcome({ ok: true, result: command.result }, command.payload.path, machine.capabilities.roots);
    if (!outcome.ok) throw new MachineError(409, "A successful workspace probe is required");
    return {
      path: outcome.result.path, requestedPath: outcome.result.requestedPath,
      sessionEpoch: command.sessionEpoch, verifiedAt: command.updatedAt
    };
  }

  enroll(id: string, name: string): { machine: RemoteMachine; token: string } {
    parseMachineId(id);
    const displayName = shortText(name, "name", 120);
    return this.atomic(() => {
      if (this.db.prepare("SELECT 1 FROM remote_machines WHERE id=?").get(id)) throw new MachineError(409, "Machine id already exists");
      const token = randomBytes(32).toString("base64url");
      const machine: RemoteMachine = { id, name: displayName, kind: "remote", status: "enrolled", sessionEpoch: 0, createdAt: new Date(this.clock()).toISOString() };
      this.db.prepare("INSERT INTO remote_machines(id,token_hash,data) VALUES(?,?,?)").run(id, tokenHash(token), JSON.stringify(machine));
      return { machine, token };
    });
  }

  revoke(id: string): RemoteMachine {
    return this.atomic(() => {
      const { machine } = this.row(parseMachineId(id));
      if (machine.status === "revoked") return machine;
      const revoked: RemoteMachine = { ...machine, status: "revoked", sessionEpoch: machine.sessionEpoch + 1 };
      delete revoked.sessionId;
      delete revoked.registrationId;
      delete revoked.capabilitiesHash;
      delete revoked.leaseExpiresAt;
      this.save(revoked);
      this.markInFlightUncertain(id, "Machine was revoked while the command was dispatched");
      this.db.prepare("UPDATE node_commands SET status='cancelled',error=?,updated_at=? WHERE machine_id=? AND status='queued'")
        .run("Machine was revoked before this command was claimed", this.clock(), id);
      return revoked;
    });
  }

  reenroll(id: string): { machine: RemoteMachine; token: string } {
    return this.atomic(() => {
      const { machine } = this.row(parseMachineId(id));
      if (machine.status !== "revoked") throw new MachineError(409, "Reenrollment requires explicit machine revocation");
      const token = randomBytes(32).toString("base64url");
      const enrolled: RemoteMachine = { ...machine, status: "enrolled", sessionEpoch: machine.sessionEpoch + 1 };
      delete enrolled.sessionId;
      delete enrolled.registrationId;
      delete enrolled.capabilitiesHash;
      delete enrolled.leaseExpiresAt;
      delete enrolled.capabilities;
      delete enrolled.lastSeenAt;
      this.db.prepare("UPDATE remote_machines SET token_hash=?,data=? WHERE id=?")
        .run(tokenHash(token), JSON.stringify(enrolled), machine.id);
      return { machine: enrolled, token };
    });
  }

  private authenticateTokenInside(machineId: string, token: string): { row: MachineRow; machine: RemoteMachine } {
    let current: { row: MachineRow; machine: RemoteMachine };
    try {
      current = this.row(parseMachineId(machineId));
    } catch (error) {
      if (error instanceof MachineError && error.status === 404) throw new MachineError(401, "Node authentication failed");
      throw error;
    }
    if (typeof token !== "string" || !token || !sameHash(current.row.token_hash, tokenHash(token)) ||
        current.machine.status === "revoked") throw new MachineError(401, "Node authentication failed");
    return current;
  }

  private requireSessionInside(machineId: string, token: string, sessionId: unknown, sessionEpoch: unknown, at: number): { machine: RemoteMachine } | { error: MachineError } {
    const { machine } = this.authenticateTokenInside(machineId, token);
    const parsedSession = parseSessionId(sessionId);
    const parsedEpoch = parseEpoch(sessionEpoch);
    if (machine.status !== "online" || machine.sessionId !== parsedSession || machine.sessionEpoch !== parsedEpoch) {
      throw new MachineError(409, "Node session is fenced; stop local work and isolate this node");
    }
    if (machine.leaseExpiresAt === undefined || machine.leaseExpiresAt <= at) {
      const offline: RemoteMachine = { ...machine, status: "offline", sessionEpoch: machine.sessionEpoch + 1 };
      delete offline.sessionId;
      delete offline.registrationId;
      delete offline.capabilitiesHash;
      delete offline.leaseExpiresAt;
      this.save(offline);
      this.markInFlightUncertain(machine.id, "Node lease expired while the command was dispatched; outcome is unknown and it will not be replayed", at);
      return { error: new MachineError(409, "Node lease expired; isolate this node and reconnect") };
    }
    return { machine };
  }

  private withSession<T>(machineId: string, token: string, sessionId: unknown, sessionEpoch: unknown, action: (machine: RemoteMachine, at: number) => T): T {
    const result = this.atomic(() => {
      const at = this.clock();
      const authority = this.requireSessionInside(machineId, token, sessionId, sessionEpoch, at);
      return "error" in authority ? authority : { value: action(authority.machine, at) };
    });
    if ("error" in result) throw result.error;
    return result.value;
  }

  requireSession(machineId: string, token: string, sessionId: unknown, sessionEpoch: unknown): RemoteMachine {
    return this.withSession(machineId, token, sessionId, sessionEpoch, (machine) => machine);
  }

  openSession(machineId: string, token: string, capabilities: unknown, registrationId: unknown): { machine: RemoteMachine; sessionId: string; sessionEpoch: number; leaseMs: number } {
    return this.atomic(() => {
      this.authenticateTokenInside(machineId, token);
      const parsedCapabilities = parseNodeCapabilities(capabilities);
      const parsedRegistration = parseRegistrationId(registrationId);
      const capabilitiesDigest = payloadHash(parsedCapabilities);
      const at = this.clock();
      this.expireLeasesInside(at);
      const fresh = this.authenticateTokenInside(machineId, token).machine;
      const used = this.db.prepare("SELECT capabilities_hash,session_id,session_epoch FROM node_registrations WHERE machine_id=? AND registration_id=?")
        .get(fresh.id, parsedRegistration) as { capabilities_hash: string; session_id: string; session_epoch: number } | undefined;
      if (used) {
        if (fresh.status === "online" && fresh.leaseExpiresAt !== undefined && fresh.leaseExpiresAt > at &&
            fresh.registrationId === parsedRegistration && used.capabilities_hash === capabilitiesDigest &&
            used.session_id === fresh.sessionId && used.session_epoch === fresh.sessionEpoch && fresh.sessionId) {
          return { machine: fresh, sessionId: fresh.sessionId, sessionEpoch: fresh.sessionEpoch, leaseMs: NODE_LEASE_MS };
        }
        throw new MachineError(409, "Registration is no longer valid");
      }
      if (fresh.status === "online" && fresh.leaseExpiresAt !== undefined && fresh.leaseExpiresAt > at) {
        throw new MachineError(409, "Another node session still holds this machine lease");
      }
      this.markInFlightUncertain(machineId, "A new node session replaced the session that held this command", at);
      const sessionId = randomUUID();
      const machine: RemoteMachine = {
        ...fresh,
        status: "online",
        sessionEpoch: fresh.sessionEpoch + 1,
        sessionId,
        registrationId: parsedRegistration,
        capabilitiesHash: capabilitiesDigest,
        lastSeenAt: at,
        leaseExpiresAt: at + NODE_LEASE_MS,
        capabilities: parsedCapabilities
      };
      this.save(machine);
      this.db.prepare("INSERT INTO node_registrations(machine_id,registration_id,capabilities_hash,session_id,session_epoch,created_at) VALUES(?,?,?,?,?,?)")
        .run(machine.id, parsedRegistration, capabilitiesDigest, sessionId, machine.sessionEpoch, at);
      return { machine, sessionId, sessionEpoch: machine.sessionEpoch, leaseMs: NODE_LEASE_MS };
    });
  }

  poll(machineId: string, token: string, sessionId: unknown, sessionEpoch: unknown, limit = 50): { machine: RemoteMachine; commands: NodeCommand[]; leaseMs: number } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MachineError(400, "command limit is invalid");
    return this.withSession(machineId, token, sessionId, sessionEpoch, (machine, at) => {
      const renewed: RemoteMachine = { ...machine, lastSeenAt: at, leaseExpiresAt: at + NODE_LEASE_MS };
      this.save(renewed);
      const rows = this.db.prepare("SELECT * FROM node_commands WHERE machine_id=? AND status='queued' ORDER BY created_at,id LIMIT ?")
        .all(machine.id, limit) as CommandRow[];
      const commands: NodeCommand[] = [];
      for (const row of rows) {
        const changed = this.db.prepare("UPDATE node_commands SET status='dispatched',session_epoch=?,updated_at=? WHERE id=? AND machine_id=? AND status='queued'")
          .run(machine.sessionEpoch, at, row.id, machine.id);
        if (changed.changes !== 1) continue;
        commands.push({ ...this.decode(row), status: "dispatched", sessionEpoch: machine.sessionEpoch });
      }
      return { machine: renewed, commands, leaseMs: NODE_LEASE_MS };
    });
  }

  complete(machineId: string, token: string, sessionId: unknown, sessionEpoch: unknown, commandId: string, rawOutcome: unknown): NodeCommand {
    return this.withSession(machineId, token, sessionId, sessionEpoch, (machine, at) => {
      if (typeof commandId !== "string" || !UUID.test(commandId)) throw new MachineError(400, "commandId is invalid");
      const command = this.command(commandId);
      if (!command || command.machineId !== machine.id) throw new MachineError(404, "Node command not found");
      const outcome = parseOutcome(rawOutcome, command.payload.path, machine.capabilities?.roots ?? []);
      if (command.status === "completed" || command.status === "failed") {
        const same = outcome.ok
          ? command.status === "completed" && stable(command.result) === stable(outcome.result)
          : command.status === "failed" && command.error === outcome.error;
        if (!same) throw new MachineError(409, "Node command already has a different terminal result");
        return command;
      }
      if (command.status !== "dispatched" || command.sessionEpoch !== machine.sessionEpoch) {
        throw new MachineError(409, `Node command is ${command.status} for another session; the late result is not accepted`);
      }
      if (outcome.ok) this.db.prepare("UPDATE node_commands SET status='completed',result=?,updated_at=? WHERE id=? AND status='dispatched'")
        .run(JSON.stringify(outcome.result === undefined ? null : outcome.result), at, commandId);
      else this.db.prepare("UPDATE node_commands SET status='failed',error=?,updated_at=? WHERE id=? AND status='dispatched'")
        .run(outcome.error, at, commandId);
      return this.command(commandId)!;
    });
  }

  enqueueProbe(machineId: string, requestId: unknown, requestedPath: unknown): NodeCommand {
    const parsedRequest = parseRequestId(requestId);
    if (typeof requestedPath !== "string" || !requestedPath.startsWith("/") || requestedPath.length > 4096) {
      throw new MachineError(400, "path must be an absolute path");
    }
    const payload = { path: requestedPath };
    const digest = payloadHash(payload);
    return this.atomic(() => {
      this.expireLeasesInside(this.clock());
      const { machine } = this.row(parseMachineId(machineId));
      if (machine.status !== "online") throw new MachineError(409, "Machine must be online for a workspace probe");
      const existing = this.db.prepare("SELECT * FROM node_commands WHERE machine_id=? AND request_id=?").get(machine.id, parsedRequest) as CommandRow | undefined;
      if (existing) {
        if (existing.payload_hash !== digest || existing.kind !== NODE_COMMAND_KIND) throw new MachineError(409, "requestId was already used with a different probe payload");
        return this.decode(existing);
      }
      const id = randomUUID();
      const at = this.clock();
      this.db.prepare("INSERT INTO node_commands(id,machine_id,request_id,payload_hash,kind,payload,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id, machine.id, parsedRequest, digest, NODE_COMMAND_KIND, JSON.stringify(payload), "queued", at, at);
      return this.command(id)!;
    });
  }

  command(id: string, machineId?: string): NodeCommand | undefined {
    const row = this.db.prepare("SELECT * FROM node_commands WHERE id=?").get(id) as CommandRow | undefined;
    if (!row || (machineId !== undefined && row.machine_id !== machineId)) return undefined;
    return this.decode(row);
  }

  commands(machineId: string, before?: string): { commands: NodeCommand[]; nextCursor?: string } {
    this.row(parseMachineId(machineId));
    let cursor: NodeCommand | undefined;
    if (before !== undefined) {
      if (!UUID.test(before)) throw new MachineError(400, "Invalid command history cursor");
      cursor = this.command(before, machineId);
      if (!cursor) throw new MachineError(400, "Invalid command history cursor");
    }
    const rows = (cursor
      ? this.db.prepare("SELECT * FROM node_commands WHERE machine_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 51")
        .all(machineId, cursor.createdAt, cursor.createdAt, cursor.id)
      : this.db.prepare("SELECT * FROM node_commands WHERE machine_id=? ORDER BY created_at DESC,id DESC LIMIT 51")
        .all(machineId)) as CommandRow[];
    const commands = rows.slice(0, 50).map((row) => this.decode(row));
    return { commands, ...(rows.length > 50 ? { nextCursor: commands[49]!.id } : {}) };
  }

  private decode(row: CommandRow): NodeCommand {
    return {
      id: row.id,
      machineId: row.machine_id,
      ...(row.request_id ? { requestId: row.request_id } : {}),
      kind: NODE_COMMAND_KIND,
      payload: JSON.parse(row.payload) as { path: string },
      status: row.status,
      ...(row.session_epoch === null ? {} : { sessionEpoch: row.session_epoch }),
      ...(row.result === null ? {} : { result: JSON.parse(row.result) }),
      ...(row.error === null ? {} : { error: row.error }),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
