import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ModelProfile, RoleProfile } from "./contracts.js";
import { parseMcpPermissions } from "./mcp-config.js";
import { parseWorkerBinding, type WorkerBinding } from "./worker-mailbox.js";

/**
 * Node-local start descriptor. It carries identity and configuration only:
 * credential values, IPC tokens, durable paths, executables, argv and
 * test-only switches are never part of a descriptor.
 */
export interface WorkerStartSpec {
  binding: WorkerBinding;
  missionId: string;
  workspacePath: string;
  workspaceStrategy: "shared";
  effects?: boolean;
  profile: ModelProfile;
  role: RoleProfile;
}

export const RESERVED_ENVIRONMENT_NAMES = [
  "PATH", "HOME", "TMPDIR", "LANG", "MC_WORKER_CONFIG", "NODE_OPTIONS",
  "SHELL", "BASH_ENV", "ENV", "IFS"
];

export function isReservedCredentialEnvironmentName(name: string): boolean {
  return RESERVED_ENVIRONMENT_NAMES.includes(name) || /^(NODE_|LD_|DYLD_)/.test(name);
}

const SPEC_KEYS = ["binding", "missionId", "workspacePath", "workspaceStrategy", "effects", "profile", "role"];
const PROFILE_KEYS = [
  "id", "name", "api", "modelId", "baseUrl", "credentialEnv", "contextWindow",
  "maxTokens", "reasoning", "toolCalling", "vision", "revision", "cost"
];
const ROLE_KEYS = ["id", "name", "kind", "instructions", "profileId", "mcpPermissions"];
const APIS = ["openai-completions", "openai-responses", "anthropic-messages"];

export class NodeWorkerSpecError extends Error {}

function fail(message: string): never {
  throw new NodeWorkerSpecError(message);
}

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("descriptor section must be an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("descriptor section must be a plain object");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) {
    fail(`${name} contains unsupported fields`);
  }
}

function text(value: unknown, name: string, max = 240): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\p{Cc}/u.test(value)) {
    fail(`${name} must be bounded text without control characters`);
  }
  return value;
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") fail(`${name} must be boolean`);
  return value;
}

function rate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${name} must be a finite non-negative number`);
  return value;
}

function modelUrl(value: unknown): string {
  const address = text(value, "baseUrl", 2048);
  let url: URL;
  try { url = new URL(address); } catch { return fail("baseUrl must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    fail("baseUrl must be HTTP(S) without credentials, query or fragment");
  }
  return address;
}

function credentialName(value: unknown): string {
  if (value === "") return "";
  const name = text(value, "credentialEnv", 128);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || isReservedCredentialEnvironmentName(name)) {
    fail("credentialEnv must be a non-reserved environment variable name");
  }
  return name;
}

function parseProfile(value: unknown): ModelProfile {
  const input = plain(value);
  if (Object.prototype.hasOwnProperty.call(input, "available")) fail("profile availability is runtime state, not configuration");
  exact(input, PROFILE_KEYS, "profile");
  if (typeof input.api !== "string" || !APIS.includes(input.api)) fail("profile api is not an approved model API");
  if (!flag(input.toolCalling, "toolCalling")) fail("a node worker profile must support tool calling");
  const profile: ModelProfile = {
    id: text(input.id, "profile.id"),
    name: text(input.name, "profile.name"),
    api: input.api as ModelProfile["api"],
    modelId: text(input.modelId, "modelId"),
    baseUrl: modelUrl(input.baseUrl),
    credentialEnv: credentialName(input.credentialEnv),
    contextWindow: positive(input.contextWindow, "contextWindow"),
    maxTokens: positive(input.maxTokens, "maxTokens"),
    reasoning: flag(input.reasoning, "reasoning"),
    toolCalling: true,
    vision: flag(input.vision, "vision"),
    revision: positive(input.revision, "revision")
  };
  if (input.cost === undefined) return profile;
  const cost = plain(input.cost);
  exact(cost, ["input", "output", "cacheRead", "cacheWrite"], "cost");
  return {
    ...profile,
    cost: {
      input: rate(cost.input, "cost.input"),
      output: rate(cost.output, "cost.output"),
      cacheRead: rate(cost.cacheRead, "cost.cacheRead"),
      cacheWrite: rate(cost.cacheWrite, "cost.cacheWrite")
    }
  };
}

function parseRole(value: unknown, profile: ModelProfile): RoleProfile {
  const input = plain(value);
  exact(input, ROLE_KEYS, "role");
  if (input.kind !== "worker") {
    fail("only worker roles can start on a node; orchestrators and validators stay local in this phase");
  }
  const profileId = text(input.profileId, "role.profileId");
  if (profileId !== profile.id) fail("role must reference the descriptor's model profile");
  const instructions = input.instructions;
  if (typeof instructions !== "string" || instructions.length > 20000) fail("role.instructions must be bounded text");
  const role: RoleProfile = {
    id: text(input.id, "role.id"),
    name: text(input.name, "role.name"),
    kind: "worker",
    instructions,
    profileId
  };
  if (input.mcpPermissions === undefined) return role;
  return { ...role, mcpPermissions: parseMcpPermissions(input.mcpPermissions) };
}

function parseWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || value.includes("\0")) {
    fail("workspacePath must be an absolute path of at most 4096 characters");
  }
  return value;
}

export function parseWorkerStartSpec(value: unknown): WorkerStartSpec {
  const input = plain(value);
  exact(input, SPEC_KEYS, "descriptor");
  const binding = parseWorkerBinding(input.binding);
  if (!binding) fail("descriptor binding is invalid");
  if (input.workspaceStrategy !== "shared") {
    fail("only the shared workspace strategy is supported; remote worktrees are not implemented yet");
  }
  const effects = input.effects === undefined ? undefined : flag(input.effects, "effects");
  const profile = parseProfile(input.profile);
  return {
    binding,
    missionId: text(input.missionId, "missionId"),
    workspacePath: parseWorkspacePath(input.workspacePath),
    workspaceStrategy: "shared",
    ...(effects === undefined ? {} : { effects }),
    profile,
    role: parseRole(input.role, profile)
  };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}

export function workerStartSpecHash(spec: WorkerStartSpec): string {
  return createHash("sha256").update(stable(spec), "utf8").digest("hex");
}
