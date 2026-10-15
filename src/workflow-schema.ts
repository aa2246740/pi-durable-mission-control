import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { parseMcpPermissions } from "./mcp-config.js";

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_JSON_DEPTH = 64;

export const Id = Type.String({ minLength: 1, maxLength: 240 });
export const Text = Type.String({ minLength: 1, maxLength: 20000 });
export const Digest = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });
export const Revision = Type.Integer({ minimum: 0, maximum: SAFE_INTEGER });
export const PositiveRevision = Type.Integer({ minimum: 1, maximum: SAFE_INTEGER });
export const Ids = Type.Array(Id, { maxItems: 2000, uniqueItems: true });

export const ErrorCodeSchema = Type.Union([
  Type.Literal("OPERATION_REJECTED"),
  Type.Literal("AUTHENTICATION_FAILED"),
  Type.Literal("INTERNAL_ERROR"),
  Type.Literal("CAPABILITY_UNAVAILABLE"),
  Type.Literal("DIGEST_MISMATCH")
]);
export type ErrorCode = Static<typeof ErrorCodeSchema>;

export const RequiredActionSchema = Type.Union([
  Type.Literal("accept_plan"),
  Type.Literal("refresh_state"),
  Type.Literal("start_run"),
  Type.Literal("request_bonus"),
  Type.Literal("resolve_blocker"),
  Type.Literal("confirm_stop"),
  Type.Literal("resume"),
  Type.Literal("revalidate"),
  Type.Literal("report")
]);

export const SafeErrorDetailsSchema = Type.Object({
  expectedRevision: Type.Optional(Revision),
  actualRevision: Type.Optional(Revision),
  taskId: Type.Optional(Id),
  runId: Type.Optional(Id),
  blockerId: Type.Optional(Id),
  requiredAction: Type.Optional(RequiredActionSchema)
}, { additionalProperties: false });
export type SafeErrorDetails = Static<typeof SafeErrorDetailsSchema>;

export function classifyHttpError(status: number): ErrorCode {
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status >= 500) return "INTERNAL_ERROR";
  return "OPERATION_REJECTED";
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: SafeErrorDetails;

  constructor(status: number, message: string, code?: ErrorCode, details?: SafeErrorDetails) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code ?? classifyHttpError(status);
    if (details !== undefined) {
      if (!Check(SafeErrorDetailsSchema, details)) throw new Error("SafeErrorDetails is invalid");
      this.details = details;
    }
  }
}

export class WorkflowOperationError extends HttpError {
  constructor(status: number, code: ErrorCode, message: string, details?: SafeErrorDetails) {
    super(status, message, code, details);
    this.name = "WorkflowOperationError";
  }
}

export function httpErrorEnvelope(message: string, code: ErrorCode, details?: SafeErrorDetails): { error: string; code: ErrorCode; details?: SafeErrorDetails } {
  if (details === undefined) return { error: message, code };
  return { error: message, code, details };
}

export function adminErrorBody(error: unknown, status: number, message: string): { error: string; code: ErrorCode; details?: SafeErrorDetails } {
  if (status >= 500) return { error: "Internal server error", code: "INTERNAL_ERROR" };
  if (error instanceof HttpError) return httpErrorEnvelope(message, error.code, error.details);
  return httpErrorEnvelope(message, classifyHttpError(status));
}

function rejected(message: string): WorkflowOperationError {
  return new WorkflowOperationError(400, "OPERATION_REJECTED", message);
}

function unavailable(message: string): WorkflowOperationError {
  return new WorkflowOperationError(409, "CAPABILITY_UNAVAILABLE", message);
}

export const ReasoningEffortSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max")
]);
export type ReasoningEffort = Static<typeof ReasoningEffortSchema>;

export const WorkflowSlotSchema = Type.Union([
  Type.Literal("orchestrator"),
  Type.Literal("worker"),
  Type.Literal("task-validator"),
  Type.Literal("scrutiny"),
  Type.Literal("user-testing")
]);
export type WorkflowSlot = Static<typeof WorkflowSlotSchema>;

const WORKFLOW_SLOTS = ["orchestrator", "worker", "task-validator", "scrutiny", "user-testing"] as const;
const SLOT_KIND = {
  orchestrator: "orchestrator",
  worker: "worker",
  "task-validator": "validator",
  scrutiny: "validator",
  "user-testing": "validator"
} as const;

const McpPermissionSchema = Type.Object({
  serverId: Type.String({ minLength: 1, maxLength: 128 }),
  toolName: Type.String({ minLength: 1, maxLength: 128 }),
  mode: Type.Union([Type.Literal("approve"), Type.Literal("allow")])
}, { additionalProperties: false });

const FiniteCost = Type.Number({ minimum: 0 });
export const ModelProfileSnapshotSchema = Type.Object({
  id: Id,
  name: Text,
  api: Type.Union([
    Type.Literal("openai-completions"),
    Type.Literal("openai-responses"),
    Type.Literal("anthropic-messages")
  ]),
  modelId: Text,
  baseUrl: Text,
  credentialEnv: Type.String({ maxLength: 240 }),
  contextWindow: PositiveRevision,
  maxTokens: PositiveRevision,
  reasoning: Type.Boolean(),
  toolCalling: Type.Boolean(),
  vision: Type.Boolean(),
  revision: PositiveRevision,
  cost: Type.Optional(Type.Object({
    input: FiniteCost,
    output: FiniteCost,
    cacheRead: FiniteCost,
    cacheWrite: FiniteCost
  }, { additionalProperties: false })),
  available: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
export type ModelProfileSnapshot = Static<typeof ModelProfileSnapshotSchema>;

export const RoleProfileSnapshotSchema = Type.Object({
  id: Id,
  name: Text,
  kind: Type.Union([Type.Literal("orchestrator"), Type.Literal("worker"), Type.Literal("validator")]),
  instructions: Text,
  profileId: Id,
  mcpPermissions: Type.Optional(Type.Array(McpPermissionSchema, { maxItems: 256 }))
}, { additionalProperties: false });
export type RoleProfileSnapshot = Static<typeof RoleProfileSnapshotSchema>;

export const EffectiveExecutionConfigSchema = Type.Object({
  profileId: Id,
  profileRevision: PositiveRevision,
  profileSnapshot: ModelProfileSnapshotSchema,
  roleId: Id,
  roleRevision: PositiveRevision,
  roleSnapshot: RoleProfileSnapshotSchema,
  reasoningEffort: ReasoningEffortSchema,
  adapterVersion: Id
}, { additionalProperties: false });
export type EffectiveExecutionConfig = Static<typeof EffectiveExecutionConfigSchema>;

export const RoleBindingSchema = Type.Object({
  slot: WorkflowSlotSchema,
  expectedRoleId: Id,
  reasoningEffort: Type.Optional(ReasoningEffortSchema),
  resolved: EffectiveExecutionConfigSchema
}, { additionalProperties: false });
export type RoleBinding = Static<typeof RoleBindingSchema>;

export const RoleBindingsSchema = Type.Array(RoleBindingSchema, { uniqueKey: "slot" });

const policyFields = {
  autoAcceptPlan: Type.Boolean(),
  autoAcceptRepairs: Type.Boolean(),
  defaultAttemptLimit: Type.Integer({ minimum: 1, maximum: 1000 }),
  maxParallelTasks: Type.Integer({ minimum: 1, maximum: 1000 }),
  skipScrutiny: Type.Boolean(),
  skipUserTesting: Type.Boolean()
} as const;

export const WorkflowPolicyRequestSchema = Type.Object(policyFields, { additionalProperties: false });
export const WorkflowPolicyStorageSchema = Type.Object({
  autoAcceptPlan: Type.Boolean(),
  autoAcceptRepairs: Type.Literal(false),
  defaultAttemptLimit: Type.Integer({ minimum: 1, maximum: 1000 }),
  maxParallelTasks: Type.Literal(1),
  skipScrutiny: Type.Boolean(),
  skipUserTesting: Type.Boolean()
}, { additionalProperties: false });
export type WorkflowPolicy = Static<typeof WorkflowPolicyStorageSchema>;

const ServerTimeSchema = Type.String({ minLength: 24, maxLength: 24, pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

export const MissionWorkflowDataV1Schema = Type.Object({
  schemaVersion: Type.Literal(1),
  policy: WorkflowPolicyStorageSchema,
  policyRevision: PositiveRevision,
  roleBindings: RoleBindingsSchema,
  createdAt: ServerTimeSchema,
  updatedAt: ServerTimeSchema
}, { additionalProperties: false });
export type MissionWorkflowDataV1 = Static<typeof MissionWorkflowDataV1Schema>;

export interface MissionWorkflowRecord extends MissionWorkflowDataV1 {
  missionId: string;
  mode: "classic" | "parity-v1";
  phase: "planning";
  revision: number;
}

export const WORKFLOW_DIGEST_DOMAINS = ["policy", "roles", "command-payload", "execution-config"] as const;
export type WorkflowDigestDomain = typeof WORKFLOW_DIGEST_DOMAINS[number];

const POLICY_KEYS = ["autoAcceptPlan", "autoAcceptRepairs", "defaultAttemptLimit", "maxParallelTasks", "skipScrutiny", "skipUserTesting"];
const SERVER_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function missionParityGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MC_ENABLE_MISSION_PARITY === "1";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPairedSurrogates(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) throw rejected("Workflow JSON contains an unpaired UTF-16 surrogate");
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw rejected("Workflow JSON contains an unpaired UTF-16 surrogate");
    }
  }
}

function assertJsonCompatible(value: unknown, depth: number): void {
  if (depth > MAX_JSON_DEPTH) throw rejected("Workflow JSON is nested too deeply");
  if (value === undefined) throw rejected("Workflow JSON cannot contain undefined");
  if (typeof value === "string") {
    assertPairedSurrogates(value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw rejected("Workflow JSON numbers must be finite");
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw rejected("Workflow JSON cannot contain a sparse array");
      assertJsonCompatible(value[index], depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) throw rejected("Workflow JSON contains an unsupported value");
  for (const key of Object.keys(value)) {
    assertPairedSurrogates(key);
    assertJsonCompatible(value[key], depth + 1);
  }
}

export function parseJsonText(text: string): unknown {
  if (typeof text !== "string") throw rejected("Workflow JSON must be text");
  let index = 0;
  const value = parseValue(0);
  skip();
  if (index !== text.length) throw rejected("Workflow JSON has trailing data");
  return value;

  function skip(): void {
    while (index < text.length) {
      const char = text[index];
      if (char !== " " && char !== "\n" && char !== "\r" && char !== "\t") return;
      index += 1;
    }
  }

  function parseValue(depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) throw rejected("Workflow JSON is nested too deeply");
    skip();
    if (index >= text.length) throw rejected("Workflow JSON is incomplete");
    const char = text[index]!;
    if (char === "{") return parseObject(depth);
    if (char === "[") return parseArray(depth);
    if (char === "\"") return parseString();
    if (char === "t") return parseLiteral("true", true);
    if (char === "f") return parseLiteral("false", false);
    if (char === "n") return parseLiteral("null", null);
    if (char === "-" || (char >= "0" && char <= "9")) return parseNumber();
    throw rejected("Workflow JSON has an invalid value");
  }

  function parseLiteral(literal: string, value: unknown): unknown {
    if (text.slice(index, index + literal.length) !== literal) throw rejected("Workflow JSON has an invalid value");
    index += literal.length;
    return value;
  }

  function parseNumber(): number {
    const start = index;
    if (text[index] === "-") index += 1;
    if (text[index] === "0") index += 1;
    else if (text[index]! >= "1" && text[index]! <= "9") {
      while (text[index]! >= "0" && text[index]! <= "9") index += 1;
    } else throw rejected("Workflow JSON has an invalid number");
    if (text[index] === ".") {
      index += 1;
      if (!(text[index]! >= "0" && text[index]! <= "9")) throw rejected("Workflow JSON has an invalid number");
      while (text[index]! >= "0" && text[index]! <= "9") index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!(text[index]! >= "0" && text[index]! <= "9")) throw rejected("Workflow JSON has an invalid number");
      while (text[index]! >= "0" && text[index]! <= "9") index += 1;
    }
    const value = JSON.parse(text.slice(start, index)) as number;
    if (typeof value !== "number" || !Number.isFinite(value)) throw rejected("Workflow JSON numbers must be finite");
    return value;
  }

  function parseString(): string {
    index += 1;
    let result = "";
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\"") {
        index += 1;
        assertPairedSurrogates(result);
        return result;
      }
      if (char === "\\") {
        index += 1;
        const escape = text[index++];
        if (escape === "\"" || escape === "\\" || escape === "/") {
          result += escape;
          continue;
        }
        if (escape === "b") { result += "\b"; continue; }
        if (escape === "f") { result += "\f"; continue; }
        if (escape === "n") { result += "\n"; continue; }
        if (escape === "r") { result += "\r"; continue; }
        if (escape === "t") { result += "\t"; continue; }
        if (escape === "u") {
          const hex = text.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw rejected("Workflow JSON has an invalid escape");
          index += 4;
          const code = Number.parseInt(hex, 16);
          if (code >= 0xD800 && code <= 0xDBFF) {
            if (text[index] !== "\\" || text[index + 1] !== "u") throw rejected("Workflow JSON contains an unpaired UTF-16 surrogate");
            const lowHex = text.slice(index + 2, index + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) throw rejected("Workflow JSON contains an unpaired UTF-16 surrogate");
            const low = Number.parseInt(lowHex, 16);
            if (low < 0xDC00 || low > 0xDFFF) throw rejected("Workflow JSON contains an unpaired UTF-16 surrogate");
            result += String.fromCharCode(code, low);
            index += 6;
            continue;
          }
          if (code >= 0xDC00 && code <= 0xDFFF) throw rejected("Workflow JSON contains an unpaired UTF-16 surrogate");
          result += String.fromCharCode(code);
          continue;
        }
        throw rejected("Workflow JSON has an invalid escape");
      }
      if (char <= "\u001F") throw rejected("Workflow JSON strings cannot contain raw control characters");
      result += char;
      index += 1;
    }
    throw rejected("Workflow JSON string is unterminated");
  }

  function parseObject(depth: number): Record<string, unknown> {
    index += 1;
    skip();
    const result: Record<string, unknown> = {};
    if (text[index] === "}") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      skip();
      if (text[index] !== "\"") throw rejected("Workflow JSON object keys must be strings");
      const key = parseString();
      if (Object.hasOwn(result, key)) throw rejected("Workflow JSON objects cannot contain duplicate keys");
      skip();
      if (text[index] !== ":") throw rejected("Workflow JSON object is missing a colon");
      index += 1;
      result[key] = parseValue(depth + 1);
      skip();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      throw rejected("Workflow JSON object is invalid");
    }
    throw rejected("Workflow JSON object is unterminated");
  }

  function parseArray(depth: number): unknown[] {
    index += 1;
    skip();
    const result: unknown[] = [];
    if (text[index] === "]") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      result.push(parseValue(depth + 1));
      skip();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      throw rejected("Workflow JSON array is invalid");
    }
    throw rejected("Workflow JSON array is unterminated");
  }
}

export function decodeWorkflowJson(input: unknown): unknown {
  if (typeof input === "string") return parseJsonText(input);
  assertJsonCompatible(input, 0);
  return input;
}

interface CanonicalSchema {
  uniqueKey?: unknown;
  items?: CanonicalSchema;
  properties?: Record<string, CanonicalSchema>;
}

function asSchema(schema: TSchema | CanonicalSchema | undefined): CanonicalSchema | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  return schema as CanonicalSchema;
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const delta = leftBytes[index]! - rightBytes[index]!;
    if (delta !== 0) return delta;
  }
  return leftBytes.length - rightBytes.length;
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) throw rejected("Workflow JSON numbers must be finite");
  if (Object.is(value, -0)) return "0";
  return JSON.stringify(value);
}

function encodeValue(value: unknown, schema: CanonicalSchema | undefined, depth: number): string {
  if (depth > MAX_JSON_DEPTH) throw rejected("Workflow JSON is nested too deeply");
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "string") {
    assertPairedSurrogates(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw rejected("Workflow JSON cannot contain a sparse array");
    }
    let items = value;
    if (typeof schema?.uniqueKey === "string") {
      const key = schema.uniqueKey;
      const seen = new Set<string>();
      for (const item of value) {
        if (!isPlainObject(item) || typeof item[key] !== "string") throw rejected("Workflow set entries must contain their key");
        if (seen.has(item[key])) throw rejected("Workflow set entries must be unique");
        seen.add(item[key]);
      }
      items = [...value].sort((left, right) => compareUtf8(
        (left as Record<string, string>)[key]!,
        (right as Record<string, string>)[key]!
      ));
    }
    return `[${items.map((item) => encodeValue(item, schema?.items, depth + 1)).join(",")}]`;
  }
  if (!isPlainObject(value)) throw rejected("Workflow JSON contains an unsupported value");
  const keys = Object.keys(value).sort(compareUtf16);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${encodeValue(value[key], schema?.properties?.[key], depth + 1)}`).join(",")}}`;
}

export function canonicalJson(value: unknown, schema?: TSchema | CanonicalSchema): string {
  assertJsonCompatible(value, 0);
  return encodeValue(value, asSchema(schema), 0);
}

function assertRegisteredDomain(domain: string): asserts domain is WorkflowDigestDomain {
  if (!WORKFLOW_DIGEST_DOMAINS.includes(domain as WorkflowDigestDomain)) throw rejected("Unknown workflow digest domain");
}

export function workflowDigestFromCanonical(domain: WorkflowDigestDomain, canonical: string): string {
  assertRegisteredDomain(domain);
  if (typeof canonical !== "string" || canonical.includes("\u0000")) throw rejected("Workflow canonical bytes are invalid");
  return createHash("sha256").update(`mc:${domain}:v1\n${canonical}`, "utf8").digest("hex");
}

function assertServerTime(value: string): void {
  if (!SERVER_TIME.test(value) || !Number.isFinite(Date.parse(value))) {
    throw rejected("Workflow timestamps must be server UTC timestamps");
  }
}

function assertCredentialEnv(value: string): void {
  if (value !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw rejected("Model profile credentialEnv must be an environment variable name");
  }
  if (["PATH", "HOME", "TMPDIR", "LANG", "MC_WORKER_CONFIG"].includes(value)) {
    throw rejected("Model profile credentialEnv must be an environment variable name");
  }
}

function assertBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw rejected("Model profile baseUrl is invalid");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw rejected("Model profile baseUrl must be an HTTP endpoint without embedded credentials");
  }
}

function parseModelProfileSnapshot(input: unknown): ModelProfileSnapshot {
  const value = decodeWorkflowJson(input);
  if (!Check(ModelProfileSnapshotSchema, value)) throw rejected("Model profile snapshot is invalid");
  assertCredentialEnv(value.credentialEnv);
  assertBaseUrl(value.baseUrl);
  return value;
}

function parseRoleProfileSnapshot(input: unknown): RoleProfileSnapshot {
  const value = decodeWorkflowJson(input);
  if (!Check(RoleProfileSnapshotSchema, value)) throw rejected("Role profile snapshot is invalid");
  if (value.mcpPermissions !== undefined) {
    try {
      parseMcpPermissions(value.mcpPermissions);
    } catch {
      throw rejected("Role snapshot MCP permissions are invalid");
    }
  }
  return value;
}

export function parseEffectiveExecutionConfig(input: unknown): EffectiveExecutionConfig {
  const value = decodeWorkflowJson(input);
  if (!isPlainObject(value) || !Check(EffectiveExecutionConfigSchema, value)) throw rejected("Effective execution config is invalid");
  const profileSnapshot = parseModelProfileSnapshot(value.profileSnapshot);
  const roleSnapshot = parseRoleProfileSnapshot(value.roleSnapshot);
  if (value.profileId !== profileSnapshot.id || value.profileRevision !== profileSnapshot.revision) {
    throw rejected("Effective execution config does not match its profile snapshot");
  }
  if (value.roleId !== roleSnapshot.id || roleSnapshot.profileId !== value.profileId) {
    throw rejected("Effective execution config does not match its role snapshot");
  }
  if (profileSnapshot.reasoning === false && value.reasoningEffort !== "off") {
    throw rejected("Resolved reasoning effort must be off when the model profile does not support reasoning");
  }
  return { ...value, profileSnapshot, roleSnapshot };
}

export function parseRoleBindings(input: unknown): RoleBinding[] {
  const value = decodeWorkflowJson(input);
  if (!Array.isArray(value) || !Check(RoleBindingsSchema, value)) throw rejected("Role bindings are invalid");
  const bindings = value.map((item) => {
    if (!isPlainObject(item)) throw rejected("Role bindings are invalid");
    const resolved = parseEffectiveExecutionConfig(item.resolved);
    if (item.expectedRoleId !== resolved.roleId) throw rejected("Role binding does not match its resolved role");
    if (item.slot === "orchestrator" || item.slot === "worker" || item.slot === "task-validator" || item.slot === "scrutiny" || item.slot === "user-testing") {
      if (resolved.roleSnapshot.kind !== SLOT_KIND[item.slot]) throw rejected("Role binding kind does not match its slot");
    }
    if (resolved.profileSnapshot.reasoning === false && item.reasoningEffort !== undefined && item.reasoningEffort !== "off") {
      throw rejected("Requested reasoning effort must be off or omitted when the model profile does not support reasoning");
    }
    const binding: RoleBinding = {
      slot: item.slot,
      expectedRoleId: item.expectedRoleId,
      resolved,
      ...(item.reasoningEffort === undefined ? {} : { reasoningEffort: item.reasoningEffort })
    };
    return binding;
  });
  const slots = bindings.map((binding) => binding.slot);
  if (new Set(slots).size !== slots.length) throw rejected("Role bindings contain a duplicate slot");
  const sorted = [...bindings].sort((left, right) => compareUtf8(left.slot, right.slot));
  if (sorted.map((binding) => binding.slot).join("\n") !== [...WORKFLOW_SLOTS].sort(compareUtf8).join("\n")) {
    throw rejected("Role bindings must contain each workflow slot once");
  }
  return sorted;
}

function provided(record: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return Object.hasOwn(record, key) ? record[key] : fallback;
}

export function parseWorkflowPolicyRequest(input: unknown): WorkflowPolicy {
  const value = decodeWorkflowJson(input);
  if (!isPlainObject(value)) throw rejected("Workflow policy must be an object");
  if (Object.keys(value).some((key) => !POLICY_KEYS.includes(key))) throw rejected("Workflow policy contains an unknown field");
  const filled = {
    autoAcceptPlan: provided(value, "autoAcceptPlan", false),
    autoAcceptRepairs: provided(value, "autoAcceptRepairs", false),
    defaultAttemptLimit: provided(value, "defaultAttemptLimit", 5),
    maxParallelTasks: provided(value, "maxParallelTasks", 1),
    skipScrutiny: provided(value, "skipScrutiny", false),
    skipUserTesting: provided(value, "skipUserTesting", false)
  };
  if (!Check(WorkflowPolicyRequestSchema, filled)) throw rejected("Workflow policy is invalid");
  if (filled.autoAcceptRepairs === true || filled.maxParallelTasks > 1) {
    throw unavailable("Workflow policy values are not available in this build");
  }
  if (!Check(WorkflowPolicyStorageSchema, filled)) throw rejected("Workflow policy is invalid");
  return filled;
}

export function parseStoredWorkflowPolicy(input: unknown): WorkflowPolicy {
  const value = decodeWorkflowJson(input);
  if (!Check(WorkflowPolicyStorageSchema, value)) throw rejected("Stored workflow policy is invalid");
  return value;
}

export function parseMissionWorkflowDataV1(input: unknown): MissionWorkflowDataV1 {
  const value = decodeWorkflowJson(input);
  if (!isPlainObject(value)) throw rejected("Mission workflow data must be an object");
  if (value.schemaVersion !== 1) throw rejected("Unsupported mission workflow data version");
  if (!Check(MissionWorkflowDataV1Schema, value)) throw rejected("Mission workflow data is invalid");
  const policy = parseStoredWorkflowPolicy(value.policy);
  const roleBindings = parseRoleBindings(value.roleBindings);
  assertServerTime(value.createdAt);
  assertServerTime(value.updatedAt);
  return {
    schemaVersion: 1,
    policy,
    policyRevision: value.policyRevision,
    roleBindings,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  };
}

export function parseStoredMissionWorkflowRow(row: unknown): MissionWorkflowRecord {
  if (!isPlainObject(row)) throw rejected("Mission workflow row is invalid");
  const missionId = row.mission_id ?? row.missionId;
  const mode = row.mode;
  const phase = row.phase;
  const revision = row.revision;
  if (typeof missionId !== "string" || !Check(Id, missionId)) throw rejected("Mission workflow row is invalid");
  if (mode !== "classic" && mode !== "parity-v1") throw rejected("Mission workflow row is invalid");
  if (phase !== "planning") throw rejected("Unsupported mission workflow phase");
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || Object.is(revision, -0) || revision < 1) {
    throw rejected("Mission workflow row is invalid");
  }
  const data = typeof row.data === "string" || isPlainObject(row.data) ? parseMissionWorkflowDataV1(row.data) : (() => {
    throw rejected("Mission workflow data is invalid");
  })();
  return { missionId, mode, phase, revision, ...data };
}

export function canonicalMissionWorkflowData(data: MissionWorkflowDataV1): string {
  return canonicalJson(data, MissionWorkflowDataV1Schema);
}

export function assertSupportedFoundationWorkflows(db: DatabaseSync): void {
  const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='mission_workflows'").get() as { present: number } | undefined;
  if (!table) return;
  const rows = db.prepare("SELECT mission_id, mode, phase, revision, data FROM mission_workflows").all();
  for (const row of rows) parseStoredMissionWorkflowRow(row);
}

function projectDigestValue(domain: WorkflowDigestDomain, value: unknown): { projected: unknown; schema?: TSchema } {
  if (domain === "policy") return { projected: parseStoredWorkflowPolicy(value), schema: WorkflowPolicyStorageSchema };
  if (domain === "roles") return { projected: parseRoleBindings(value), schema: RoleBindingsSchema };
  if (domain === "execution-config") return { projected: parseEffectiveExecutionConfig(value), schema: EffectiveExecutionConfigSchema };
  const projected = decodeWorkflowJson(value);
  return { projected };
}

export function workflowDigest(domain: WorkflowDigestDomain, value: unknown): string {
  assertRegisteredDomain(domain);
  const projected = projectDigestValue(domain, value);
  return workflowDigestFromCanonical(domain, canonicalJson(projected.projected, projected.schema));
}

export function assertWorkflowDigest(domain: WorkflowDigestDomain, value: unknown, expected: unknown): string {
  const actual = workflowDigest(domain, value);
  if (typeof expected !== "string" || !Check(Digest, expected) || !Check(Digest, actual) || expected !== actual) {
    throw new WorkflowOperationError(409, "DIGEST_MISMATCH", "Workflow digest does not match the stored content");
  }
  return actual;
}
