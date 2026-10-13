import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export interface McpPermission {
  serverId: string;
  toolName: string;
  mode: "approve" | "allow";
}

export type McpServerInput = {
  id: string;
  name: string;
  enabled: boolean;
  timeoutMs: number;
  expectedRevision?: number;
} & (
  | { transport: "stdio"; command: string; args: string[]; envRefs: Record<string, string> }
  | { transport: "http"; url: string; headerRefs: Record<string, { env: string; prefix: "" | "Bearer " | "Basic " }> }
);

export type McpServerConfig = Omit<McpServerInput, "expectedRevision"> & { revision: number } & (
  | { transport: "stdio"; command: string; args: string[]; envRefs: Record<string, string> }
  | { transport: "http"; url: string; headerRefs: Record<string, { env: string; prefix: "" | "Bearer " | "Basic " }> }
);

export class McpConfigurationError extends Error {}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpConfigurationError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, fields: string[], name: string): void {
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new McpConfigurationError(`${name} contains unsupported fields`);
}

function string(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new McpConfigurationError(`${name} must be non-empty text of at most ${max} characters without control characters`);
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  const result = string(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) throw new McpConfigurationError(`${name} has an invalid identifier format`);
  return result;
}

function envName(value: unknown): string {
  const name = string(value, "Environment reference", 128);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new McpConfigurationError("Environment references must be variable names, not credential values");
  return name;
}

export function parseMcpPermissions(value: unknown): McpPermission[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) throw new McpConfigurationError("mcpPermissions must be an array of at most 256 exact tool grants");
  const seen = new Set<string>();
  return value.map((entry) => {
    const item = object(entry, "MCP permission");
    exact(item, ["serverId", "toolName", "mode"], "MCP permission");
    const serverId = identifier(item.serverId, "serverId");
    const toolName = string(item.toolName, "toolName", 128);
    if (toolName.includes("*")) throw new McpConfigurationError("Wildcard tool grants are not supported; select an exact tool name");
    if (item.mode !== "approve" && item.mode !== "allow") throw new McpConfigurationError("MCP permission mode must be approve or allow");
    const key = JSON.stringify([serverId, toolName]);
    if (seen.has(key)) throw new McpConfigurationError("Duplicate MCP tool grant");
    seen.add(key);
    return { serverId, toolName, mode: item.mode };
  });
}

export function parseMcpServer(value: unknown): McpServerInput {
  const input = object(value, "MCP server");
  const common = ["id", "name", "enabled", "timeoutMs", "expectedRevision", "transport"];
  if (input.transport !== "stdio" && input.transport !== "http") throw new McpConfigurationError("MCP transport must be stdio or http (Streamable HTTP)");
  exact(input, [...common, ...(input.transport === "stdio" ? ["command", "args", "envRefs"] : ["url", "headerRefs"])], "MCP server");
  if (typeof input.enabled !== "boolean") throw new McpConfigurationError("enabled must be boolean");
  const timeoutMs = input.timeoutMs === undefined ? 30000 : input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new McpConfigurationError("timeoutMs must be an integer between 1000 and 60000");
  }
  if (input.expectedRevision !== undefined && (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    throw new McpConfigurationError("expectedRevision must be a positive integer");
  }
  const base = {
    id: input.id === undefined ? randomUUID() : identifier(input.id, "id"),
    name: string(input.name, "name"), enabled: input.enabled, timeoutMs,
    ...(typeof input.expectedRevision === "number" ? { expectedRevision: input.expectedRevision } : {})
  };
  if (input.transport === "stdio") {
    const command = string(input.command, "command", 4096);
    if (!isAbsolute(command)) throw new McpConfigurationError("stdio command must be an absolute executable path; no shell interpolation is performed");
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || args.length > 128 || args.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0")) || JSON.stringify(args).length > 65536) {
      throw new McpConfigurationError("args must be a bounded array of strings without NUL characters");
    }
    const refs = object(input.envRefs ?? {}, "envRefs");
    if (Object.keys(refs).length > 64) throw new McpConfigurationError("Too many environment references");
    const envRefs: Record<string, string> = {};
    for (const [destination, reference] of Object.entries(refs)) {
      envName(destination);
      if (/^(NODE_|LD_|DYLD_|MC_)/.test(destination) || ["PATH", "HOME", "SHELL", "TMPDIR", "LANG", "BASH_ENV", "ENV", "IFS"].includes(destination)) {
        throw new McpConfigurationError("MCP environment destinations must not override runtime or shell configuration");
      }
      envRefs[destination] = envName(reference);
    }
    return { ...base, transport: "stdio", command, args: args as string[], envRefs };
  }
  const address = string(input.url, "url", 4096);
  let url: URL;
  try { url = new URL(address); } catch { throw new McpConfigurationError("MCP URL is invalid"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new McpConfigurationError("MCP requires HTTPS (or loopback HTTP) without embedded credentials, query parameters or fragments");
  }
  const refs = object(input.headerRefs ?? {}, "headerRefs");
  if (Object.keys(refs).length > 32) throw new McpConfigurationError("Too many header references");
  const headerRefs: Record<string, { env: string; prefix: "" | "Bearer " | "Basic " }> = {};
  for (const [original, value] of Object.entries(refs)) {
    const name = original.toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || /^(host|content-length|content-type|connection|transfer-encoding|cookie|origin|accept|mcp-.*|proxy-.*|sec-.*)$/.test(name) || Object.hasOwn(headerRefs, name)) {
      throw new McpConfigurationError("MCP header name is invalid, reserved or duplicated");
    }
    const ref = object(value, "Header reference");
    exact(ref, ["env", "prefix"], "Header reference");
    const prefix = ref.prefix ?? "";
    if (prefix !== "" && prefix !== "Bearer " && prefix !== "Basic ") throw new McpConfigurationError("Header prefix must be empty, Bearer or Basic; do not store credentials here");
    headerRefs[name] = { env: envName(ref.env), prefix };
  }
  return { ...base, transport: "http", url: url.href, headerRefs };
}
