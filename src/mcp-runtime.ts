import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { McpServerConfig } from "./mcp-config.js";

const MAX_JSON_BYTES = 256 * 1024;
const addFormats = addFormatsImport as unknown as (ajv: InstanceType<typeof Ajv> | InstanceType<typeof Ajv2020>) => void;

export type McpOperationScope = {
  missionId?: string;
  agentId?: string;
  serverId: string;
  revision: number;
};

export class McpOperationError extends Error {
  constructor(
    message: string,
    readonly submitted: boolean,
    readonly terminal = false
  ) {
    super(message);
  }
}

type ActiveOperation = {
  scope: McpOperationScope;
  controller: AbortController;
  promise: Promise<unknown>;
  settled: boolean;
  cleanupError?: string;
  closeResource?: () => Promise<void>;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const compare = (left: string, right: string): number => {
      const a = Array.from(left, (item) => item.codePointAt(0)!);
      const b = Array.from(right, (item) => item.codePointAt(0)!);
      for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        if (a[index] !== b[index]) return a[index]! - b[index]!;
      }
      return a.length - b.length;
    };
    return `{${Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function mcpDefinitionHash(tool: unknown): string {
  return createHash("sha256").update(stable(tool)).digest("hex");
}

function jsonSize(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new McpOperationError("MCP value is not JSON serializable.", false);
  return Buffer.byteLength(serialized);
}

function boundedJson(value: unknown, label: string): void {
  if (jsonSize(value) > MAX_JSON_BYTES) throw new McpOperationError(`${label} exceeds the 256 KiB limit.`, false);
}

function redact(value: unknown, secrets: string[]): unknown {
  const replace = (text: string): string => secrets.reduce((result, secret) =>
    secret ? result.split(secret).join("[REDACTED]") : result, text);
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [replace(key), redact(item, secrets)]));
  }
  return value;
}

export function redactMcpValue(value: unknown, secrets: string[]): unknown {
  return redact(value, secrets);
}

export function mcpSecretValues(config: McpServerConfig): string[] {
  const references = config.transport === "stdio"
    ? Object.values(config.envRefs)
    : Object.values(config.headerRefs).map((reference) => reference.env);
  return [...new Set(references.map((reference) => process.env[reference]).filter((value): value is string => Boolean(value)))]
    .filter(Boolean);
}

function safeError(error: unknown, secrets: string[]): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "MCP operation failed.";
  const clean = redact(message, secrets);
  return String(clean).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, 2000);
}

function resolvedReferences(config: McpServerConfig): { values: Record<string, string>; secrets: string[] } {
  const values: Record<string, string> = {};
  const references = config.transport === "stdio"
    ? config.envRefs
    : Object.fromEntries(Object.entries(config.headerRefs).map(([name, reference]) => [name, reference.env]));
  for (const [destination, reference] of Object.entries(references)) {
    const value = process.env[reference];
    if (value === undefined || value.trim().length === 0) throw new McpOperationError(`MCP credential reference ${reference} is unavailable.`, false);
    values[destination] = config.transport === "http"
      ? `${config.headerRefs[destination]!.prefix}${value}`
      : value;
  }
  return { values, secrets: mcpSecretValues(config) };
}

function validator(schema: unknown): (input: unknown) => boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new McpOperationError("MCP tool input schema must be a JSON Schema object.", false);
  const schemaObject = schema as Record<string, unknown>;
  const dialect = schemaObject.$schema;
  const options = {
    allErrors: true,
    validateSchema: true,
    coerceTypes: false as const,
    useDefaults: false as const,
    removeAdditional: false as const
  };
  let ajv: InstanceType<typeof Ajv> | InstanceType<typeof Ajv2020>;
  if (dialect === undefined || dialect === "http://json-schema.org/draft-07/schema#" || dialect === "https://json-schema.org/draft-07/schema#") {
    ajv = new Ajv(options);
  } else if (dialect === "https://json-schema.org/draft/2020-12/schema" || dialect === "https://json-schema.org/draft/2020-12/schema#") {
    ajv = new Ajv2020(options);
  } else {
    throw new McpOperationError("MCP tool schema declares an unsupported JSON Schema dialect.", false);
  }
  addFormats(ajv);
  try {
    const input = dialect === "https://json-schema.org/draft-07/schema#"
      ? { ...schemaObject, $schema: "http://json-schema.org/draft-07/schema#" }
      : schema;
    return ajv.compile(input as object);
  } catch {
    throw new McpOperationError("MCP tool schema is invalid or contains an unresolved reference.", false);
  }
}

function normalizedArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new McpOperationError("MCP tool arguments must be a JSON object.", false);
  let copy: unknown;
  try {
    copy = JSON.parse(JSON.stringify(args));
  } catch {
    throw new McpOperationError("MCP tool arguments are not valid JSON.", false);
  }
  boundedJson(copy, "MCP tool arguments");
  return copy as Record<string, unknown>;
}

function makeTransport(config: McpServerConfig, workspacePath: string, refs: Record<string, string>) {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...refs },
      cwd: workspacePath,
      stderr: "pipe",
      maxBufferSize: MAX_JSON_BYTES * 4
    });
  }
  const headers = Object.fromEntries(Object.entries(refs).map(([name, value]) => [name, value]));
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers, redirect: "error" },
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
    redirectPolicy: "same-origin",
    reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 }
  });
}

function checkCapabilities(client: Client): void {
  const capabilities = client.getServerCapabilities() ?? {};
  if (!capabilities.tools) throw new McpOperationError("MCP server does not advertise the required tools capability.", false, true);
}

export class McpRuntimeManager {
  private readonly operations = new Map<symbol, ActiveOperation>();
  private closing = false;

  async discover(config: McpServerConfig, workspacePath: string, scope: McpOperationScope, selectedTools?: ReadonlySet<string>) {
    if (!config.enabled) throw new McpOperationError("MCP server is disabled; no connection was attempted.", false, true);
    return this.withClient(config, workspacePath, scope, (client, secrets, signal) =>
      this.discoverWithClient(client, signal, secrets, selectedTools));
  }

  async call(
    config: McpServerConfig,
    workspacePath: string,
    scope: McpOperationScope,
    toolName: string,
    args: unknown,
    expectedDefinitionHash: string,
    beforeDispatch: () => void
  ): Promise<{ result: unknown; secrets: string[] }> {
    if (!config.enabled) throw new McpOperationError("MCP server is disabled; no connection was attempted.", false, true);
    const normalized = normalizedArguments(args);
    return this.withClient(config, workspacePath, scope, async (client, secrets, signal) => {
      const tools = await this.listRawTools(client, signal);
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (!tool) throw new McpOperationError("MCP tool is no longer present; operation was not executed.", false, true);
      if (mcpDefinitionHash(tool) !== expectedDefinitionHash) throw new McpOperationError("MCP tool definition changed; operation was not executed.", false, true);
      if (tool.execution?.taskSupport === "required") {
        throw new McpOperationError("MCP tool requires unsupported task execution; tool was not dispatched.", false, true);
      }
      const validate = validator(tool.inputSchema);
      const outputValidate = tool.outputSchema === undefined ? undefined : validator(tool.outputSchema);
      if (!validate(normalized)) throw new McpOperationError("MCP tool arguments do not match its current input schema.", false, true);
      beforeDispatch();
      const result = await client.request(
        { method: "tools/call", params: { name: toolName, arguments: normalized } },
        CallToolResultSchema,
        { signal }
      );
      if (!result.isError && outputValidate) {
        if (result.structuredContent === undefined || !outputValidate(result.structuredContent)) {
          throw new McpOperationError("MCP tool returned structured content that does not match its output schema; a response was received and must not be replayed automatically.", true, true);
        }
      }
      const safeResult = redact(result, secrets);
      try {
        boundedJson(safeResult, "MCP tool result");
      } catch {
        throw new McpOperationError("MCP tool returned a result over 256 KiB; its result was not stored.", true, true);
      }
      return { result: safeResult, secrets };
    });
  }

  cancelMission(missionId: string): Promise<void> { return this.cancelWhere((op) => op.scope.missionId === missionId); }
  cancelAgent(agentId: string): Promise<void> { return this.cancelWhere((op) => op.scope.agentId === agentId); }
  cancelServer(serverId: string, beforeRevision?: number): Promise<void> {
    return this.cancelWhere((op) => op.scope.serverId === serverId && (beforeRevision === undefined || op.scope.revision < beforeRevision));
  }
  cancelAll(): Promise<void> { return this.cancelWhere(() => true); }

  async close(): Promise<void> {
    this.closing = true;
    await this.cancelAll();
    const stuck = [...this.operations.values()].filter((operation) => operation.cleanupError);
    if (stuck.length) throw new Error(`MCP runtime still owns ${stuck.length} transport resource(s) after close failure.`);
  }

  get activeCount(): number { return this.operations.size; }

  private async cancelWhere(predicate: (operation: ActiveOperation) => boolean): Promise<void> {
    const selected = [...this.operations.entries()].filter(([, operation]) => predicate(operation));
    for (const [, operation] of selected) operation.controller.abort(new Error("MCP operation cancelled."));
    await Promise.allSettled(selected.map(([, operation]) => operation.promise));
    for (const [id, operation] of selected) {
      if (!operation.cleanupError || !operation.closeResource) continue;
      try {
        await operation.closeResource();
        delete operation.cleanupError;
        delete operation.closeResource;
        this.operations.delete(id);
      } catch (error) {
        operation.cleanupError = safeError(error, []);
      }
    }
    if (selected.some(([, operation]) => operation.cleanupError)) {
      throw new McpOperationError("MCP operation cleanup could not be confirmed; owned resources remain retained.", false);
    }
  }

  private async discoverWithClient(client: Client, signal: AbortSignal, secrets: string[], selectedTools?: ReadonlySet<string>) {
    const tools: Array<Record<string, unknown>> = [];
    const rawTools = await this.listRawTools(client, signal);
    for (const tool of rawTools) {
      if (selectedTools && !selectedTools.has(tool.name)) continue;
      validator(tool.inputSchema);
      if (tool.outputSchema !== undefined) validator(tool.outputSchema);
      const safeTool = redact(tool, secrets) as Record<string, unknown>;
      boundedJson(safeTool, "MCP tool metadata");
      tools.push({ ...safeTool, definitionHash: mcpDefinitionHash(tool) });
    }
    boundedJson(tools, "MCP tool catalog");
    return tools;
  }

  private async listRawTools(client: Client, signal: AbortSignal) {
    const tools: Array<Awaited<ReturnType<Client["listTools"]>>["tools"][number]> = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.request(
        { method: "tools/list", params: cursor ? { cursor } : {} },
        ListToolsResultSchema,
        { signal }
      );
      for (const tool of page.tools) {
        if (tools.length >= 256) throw new McpOperationError("MCP server exceeds the 256-tool limit.", false);
        if (!tool.name || names.has(tool.name)) throw new McpOperationError("MCP server returned a duplicate or invalid tool name.", false);
        names.add(tool.name);
        tools.push(tool);
      }
      cursor = page.nextCursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new McpOperationError("MCP server repeated a pagination cursor.", false);
        cursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }

  private async withClient<T>(
    config: McpServerConfig,
    workspacePath: string,
    scope: McpOperationScope,
    action: (client: Client, secrets: string[], signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.closing) throw new McpOperationError("MCP runtime is shutting down.", false);
    const controller = new AbortController();
    let submitted = false;
    let client: Client | undefined;
    let transport: ReturnType<typeof makeTransport> | undefined;
    const operation: ActiveOperation = { scope, controller, promise: Promise.resolve(), settled: false };
    const id = Symbol(config.id);
    this.operations.set(id, operation);
    const timer = setTimeout(() => controller.abort(new Error("MCP operation deadline exceeded.")), config.timeoutMs);
    const work = (async () => {
      let secrets: string[] = [];
      try {
        const refs = resolvedReferences(config);
        secrets = refs.secrets;
        transport = makeTransport(config, workspacePath, refs.values);
        let stdioSpawned = false;
        let stdioClosed = false;
        let resolveStdioClosed: (() => void) | undefined;
        const stdioClosedPromise = new Promise<void>((resolve) => { resolveStdioClosed = resolve; });
        if (transport instanceof StdioClientTransport) {
          const stderr = transport.stderr as (NodeJS.ReadableStream & { resume?: () => void }) | null;
          stderr?.resume?.();
          const priorClose = transport.onclose;
          transport.onclose = () => {
            priorClose?.();
            stdioClosed = true;
            resolveStdioClosed?.();
          };
          const start = transport.start.bind(transport);
          transport.start = async () => {
            await start();
            stdioSpawned = true;
          };
        }
        const ownedTransport = transport as Transport;
        const send = ownedTransport.send.bind(ownedTransport);
        ownedTransport.send = async (message, options) => {
          if (message && typeof message === "object" && "method" in message && message.method === "tools/call") submitted = true;
          return send(message, options);
        };
        client = new Client({ name: "mission-control", version: "0.1.0" }, { capabilities: {} });
        operation.closeResource = async () => {
          if (client) await client.close();
          else if (transport) await transport.close();
          if (stdioSpawned && !stdioClosed) {
            await Promise.race([
              stdioClosedPromise,
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("MCP stdio child exit was not confirmed after transport close.")), 5000).unref())
            ]);
          }
        };
        await client.connect(transport as Transport, { signal: controller.signal });
        checkCapabilities(client);
        return await action(client, secrets, controller.signal);
      } catch (error) {
        if (error instanceof McpOperationError) throw error;
        throw new McpOperationError(
          `MCP operation ${submitted ? "has an uncertain outcome" : "failed before tool dispatch"}: ${safeError(error, secrets)}`,
          submitted
        );
      } finally {
        clearTimeout(timer);
        operation.settled = true;
        try {
          if (operation.closeResource) await operation.closeResource();
          delete operation.closeResource;
          this.operations.delete(id);
        } catch (error) {
          operation.cleanupError = safeError(error, []);
        }
      }
    })();
    operation.promise = work;
    return work;
  }
}
