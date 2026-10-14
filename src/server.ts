import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { ModelProfile, RoleProfile } from "./contracts.js";
import { artifactContentDisposition, artifactDownloadName } from "./artifact-download.js";
import { McpConfigurationError } from "./mcp-config.js";
import { ControlPlane, HttpError, parseCreateMissionInput, parseValidationContractUpdateInput } from "./control.js";
import { MachineError } from "./machines.js";
import { applyWorkerNotice } from "./worker-events.js";
import { parseWorkerBinding, type JsonValue, type WorkerBinding, type WorkerRpcPayload } from "./worker-mailbox.js";
import { WorkerMailboxDispatcher } from "./worker-mailbox-dispatcher.js";
import { sanitizeDiagnostic, WorkerManager } from "./workers.js";

const BODY_LIMIT = 1024 * 1024;
const tokenFileName = "admin.token";

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function normalizeRpcResult(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : JSON.parse(encoded) as JsonValue;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function getCookie(request: IncomingMessage, name: string): string | undefined {
  const cookies = request.headers.cookie?.split(";").map((part) => part.trim()) ?? [];
  const value = cookies.find((part) => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : undefined;
}

function isLocalHost(host: string | undefined): boolean {
  return Boolean(host && /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(host));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new HttpError(413, "Request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "JSON object required");
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 20000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, `${name} must be a non-empty string of at most ${max} characters`);
  return value;
}

function number(value: unknown, name: string, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw new HttpError(400, `${name} must be a finite number >= ${min}`);
  return value;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, `${name} must be a positive safe integer`);
  return value;
}

function exactKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new HttpError(400, `Unexpected fields: ${unknown.join(", ")}`);
}

export type ServerOptions = { home: string; port: number; nodePort?: number; testOnlyScripted?: boolean; testOnlyToolLoop?: boolean };

export async function startServer(options: ServerOptions) {
  const home = resolve(options.home);
  const control = new ControlPlane(home);
  const workers = new WorkerManager(
    control,
    options.testOnlyScripted === true,
    options.testOnlyScripted === true && options.testOnlyToolLoop === true
  );
  const lifecycleFlights = new Set<Promise<void>>();
  const scheduleLifecycleSync = (missionId: string, owner?: { id: string; epoch: number }): void => {
    const flight = Promise.resolve()
      .then(() => workers.syncMissionLifecycle(missionId))
      .catch(() => {
        if (!owner) return;
        try {
          const current = control.getAgentPublic(owner.id);
          if (!current || current.missionId !== missionId || current.epoch !== owner.epoch) return;
          control.recordWorkerDiagnostic(owner.id, owner.epoch, "Worker lifecycle synchronization failed");
        } catch {
          return;
        }
      })
      .finally(() => lifecycleFlights.delete(flight));
    lifecycleFlights.add(flight);
  };
  const isCurrentWorkerBinding = (binding: WorkerBinding): boolean => {
    const mailbox = control.workerMailbox.inspectBinding(binding);
    const machine = control.machineRegistry.get(binding.machineId);
    const agent = control.getAgentPublic(binding.agentId);
    return mailbox.status === "open"
      && Boolean(machine && machine.status === "online" && machine.sessionId === binding.sessionId
        && machine.sessionEpoch === binding.sessionEpoch && machine.leaseExpiresAt !== undefined
        && machine.leaseExpiresAt > Date.now())
      && Boolean(agent && agent.machineId === binding.machineId && agent.epoch === binding.epoch);
  };
  const mailboxDispatcher = new WorkerMailboxDispatcher({
    mailbox: control.workerMailbox,
    isCurrent: isCurrentWorkerBinding,
    canDispatch: (binding) => {
      const enabled = control.machineRegistry.get(binding.machineId)?.capabilities?.executionEnabled as boolean | undefined;
      return enabled === true;
    },
    rpc: async (binding, payload: WorkerRpcPayload) => {
      try {
        const result = await control.workerCommand({
          type: "rpc",
          id: payload.rpcId,
          token: "",
          agentId: binding.agentId,
          epoch: binding.epoch,
          method: payload.method,
          args: payload.args,
          taskId: payload.taskId
        });
        return { kind: "reply", rpcId: payload.rpcId, ok: true, result: normalizeRpcResult(result) };
      } catch (error) {
        if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
          return { kind: "reply", rpcId: payload.rpcId, ok: false, error: "Remote operation was rejected" };
        }
        throw error;
      }
    },
    // Lifecycle sync can fence this binding. It must run only after the
    // dispatcher has stored finishWithReply, including when the RPC itself
    // blocked the mission. The error path still schedules sync after fence.
    afterRpc: (binding) => {
      const owner = control.getAgentPublic(binding.agentId);
      if (owner?.missionId) scheduleLifecycleSync(owner.missionId, { id: owner.id, epoch: owner.epoch });
    },
    notice: (binding, notice) => {
      const owner = control.getAgentPublic(binding.agentId);
      if (!owner || owner.machineId !== binding.machineId || owner.epoch !== binding.epoch) {
        throw new Error("Worker notice owner is no longer current");
      }
      const profile = control.profile(owner.profileId);
      const secret = profile?.credentialEnv ? process.env[profile.credentialEnv] : undefined;
      const result = applyWorkerNotice(control, owner, notice, (value) => sanitizeDiagnostic(value, secret));
      if (result.ready && control.remoteRuntimeReady(binding)) setImmediate(() => { void workers.dispatchPending(); });
      if (result.lifecycleSync) scheduleLifecycleSync(owner.missionId, { id: owner.id, epoch: owner.epoch });
    }
  });
  const sseClients = new Set<ServerResponse>();
  const tokenPath = join(home, tokenFileName);
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const token = readFileSync(tokenPath, "utf8").trim();
  const handleRequest = (nodeOnly: boolean) => async (request: IncomingMessage, response: ServerResponse) => {
    try {
      response.setHeader("x-content-type-options", "nosniff");
      response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'");
      if (!isLocalHost(request.headers.host)) throw new HttpError(403, "Host is not a loopback host");
      const origin = request.headers.origin;
      if (origin) {
        const originUrl = new URL(origin);
        if (originUrl.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(originUrl.hostname)) throw new HttpError(403, "Origin is not local");
        if (request.headers.host && originUrl.host !== request.headers.host) throw new HttpError(403, "Cross-origin request rejected");
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const method = request.method ?? "GET";
      const mutation = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
      if (request.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, "Cross-site request rejected");
      const nodeRoute = url.pathname.startsWith("/api/nodes/");
      if (nodeOnly && !nodeRoute) throw new HttpError(404, "Node listener does not expose administrator routes");
      if (nodeRoute) {
        if (request.headers.origin !== undefined || request.headers.cookie !== undefined) throw new MachineError(403, "Node authentication failed");
        const authorization = request.headers.authorization;
        if (!authorization || !/^Bearer [^\s]+$/.test(authorization) || authorization.length > 512) {
          throw new MachineError(401, "Node authentication failed");
        }
        const nodeToken = authorization.slice("Bearer ".length);
        if (method !== "POST") throw new MachineError(404, "Node route not found");
        if (url.pathname === "/api/nodes/session") {
          const body = await readBody(request);
          exactKeys(body, ["machineId", "capabilities", "registrationId"]);
          return jsonResponse(response, 200, control.nodeSession(
            text(body.machineId, "machineId", 64),
            nodeToken,
            body.capabilities as never,
            text(body.registrationId, "registrationId", 64)
          ));
        }
        if (url.pathname === "/api/nodes/poll") {
          const body = await readBody(request);
          exactKeys(body, ["machineId", "sessionId", "sessionEpoch"]);
          return jsonResponse(response, 200, control.nodePoll(
            text(body.machineId, "machineId", 64),
            nodeToken,
            text(body.sessionId, "sessionId", 64),
            positiveSafeInteger(body.sessionEpoch, "sessionEpoch")
          ));
        }
        if (url.pathname === "/api/nodes/events") {
          const body = await readBody(request);
          exactKeys(body, ["machineId", "sessionId", "sessionEpoch", "commandId", "outcome"]);
          return jsonResponse(response, 200, control.nodeEvent(
            text(body.machineId, "machineId", 64),
            nodeToken,
            text(body.sessionId, "sessionId", 64),
            positiveSafeInteger(body.sessionEpoch, "sessionEpoch"),
            text(body.commandId, "commandId", 64),
            body.outcome
          ));
        }
        if (url.pathname === "/api/nodes/effects/receipts") {
          const body = await readBody(request);
          exactKeys(body, ["machineId", "sessionId", "sessionEpoch", "upload"]);
          if (Object.keys(body).length !== 4) throw new MachineError(400, "Receipt upload fields are required");
          return jsonResponse(response, 200, control.nodeEffectReceipt(
            text(body.machineId, "machineId", 64),
            nodeToken,
            text(body.sessionId, "sessionId", 64),
            positiveSafeInteger(body.sessionEpoch, "sessionEpoch"),
            body.upload
          ));
        }
        if (url.pathname === "/api/nodes/artifacts/chunk") {
          const body = await readBody(request);
          exactKeys(body, ["machineId", "sessionId", "sessionEpoch", "spec", "manifest", "offset", "chunkBase64"]);
          if (typeof body.offset !== "number" || !Number.isSafeInteger(body.offset) || body.offset < 0) {
            throw new MachineError(400, "Artifact chunk offset must be a non-negative safe integer");
          }
          return jsonResponse(response, 200, control.nodeArtifactChunk(
            text(body.machineId, "machineId", 64), nodeToken, text(body.sessionId, "sessionId", 64),
            positiveSafeInteger(body.sessionEpoch, "sessionEpoch"), body.spec, body.manifest, body.offset, body.chunkBase64
          ));
        }
        if (url.pathname === "/api/nodes/artifacts/complete") {
          const body = await readBody(request);
          exactKeys(body, ["machineId", "sessionId", "sessionEpoch", "spec", "manifest"]);
          return jsonResponse(response, 200, control.nodeArtifactComplete(
            text(body.machineId, "machineId", 64), nodeToken, text(body.sessionId, "sessionId", 64),
            positiveSafeInteger(body.sessionEpoch, "sessionEpoch"), body.spec, body.manifest
          ));
        }
        if (url.pathname === "/api/nodes/runtimes/poll") {
          const body = await readBody(request);
          exactKeys(body, ["machineId", "sessionId", "sessionEpoch", "stopRuntimeId"]);
          return jsonResponse(response, 200, control.nodeRuntimePoll(
            text(body.machineId, "machineId", 64), nodeToken, text(body.sessionId, "sessionId", 64),
            positiveSafeInteger(body.sessionEpoch, "sessionEpoch"),
            body.stopRuntimeId === undefined ? undefined : text(body.stopRuntimeId, "stopRuntimeId", 128)
          ));
        }
        if (url.pathname === "/api/nodes/runtimes/events") {
          const body = await readBody(request);
          exactKeys(body, ["machineId", "sessionId", "sessionEpoch", "reportId", "binding", "descriptorHash", "outcome", "stopReason"]);
          const binding = parseWorkerBinding(body.binding);
          if (!binding || typeof body.reportId !== "string" ||
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.reportId) ||
              typeof body.descriptorHash !== "string" || !/^[0-9a-f]{64}$/.test(body.descriptorHash) ||
              !["stopped", "uncertain", "rejected"].includes(String(body.outcome)) ||
              (body.stopReason !== undefined && body.stopReason !== "requested" && body.stopReason !== "unexpected")) {
            throw new MachineError(400, "Runtime report is invalid");
          }
          return jsonResponse(response, 200, control.nodeRuntimeReport(
            text(body.machineId, "machineId", 64), nodeToken, text(body.sessionId, "sessionId", 64),
            positiveSafeInteger(body.sessionEpoch, "sessionEpoch"), {
              reportId: body.reportId, binding, descriptorHash: body.descriptorHash,
              outcome: body.outcome as "stopped" | "uncertain" | "rejected",
              ...(body.stopReason === undefined ? {} : { stopReason: body.stopReason })
            }
          ));
        }
        if (url.pathname === "/api/nodes/mailbox/settlement") {
          const body = await readBody(request);
          exactKeys(body, ["machineId", "sessionId", "sessionEpoch", "binding", "entries"]);
          return jsonResponse(response, 200, control.nodeWorkerMailboxSettlement(
            text(body.machineId, "machineId", 64),
            nodeToken,
            text(body.sessionId, "sessionId", 64),
            positiveSafeInteger(body.sessionEpoch, "sessionEpoch"),
            body.binding,
            body.entries
          ));
        }
        const mailboxAction = new Map([
          ["/api/nodes/mailbox/upload", "upload"],
          ["/api/nodes/mailbox/poll", "poll"],
          ["/api/nodes/mailbox/ack", "ack"]
        ]).get(url.pathname);
        if (mailboxAction) {
          const body = await readBody(request);
          exactKeys(body, ["machineId", "sessionId", "sessionEpoch", "binding",
            ...(mailboxAction === "upload" ? ["envelope"] : mailboxAction === "ack" ? ["receipt"] : [])]);
          const identity: [string, string, string, number, unknown] = [
            text(body.machineId, "machineId", 64), nodeToken,
            text(body.sessionId, "sessionId", 64), positiveSafeInteger(body.sessionEpoch, "sessionEpoch"), body.binding
          ];
          if (mailboxAction === "upload") {
            const receipt = control.nodeWorkerUpload(...identity, body.envelope);
            jsonResponse(response, 200, receipt);
            const binding = parseWorkerBinding(body.binding);
            if (binding) setImmediate(() => { void mailboxDispatcher.drain(binding); });
            return;
          }
          const result = mailboxAction === "ack"
            ? control.nodeWorkerAck(...identity, body.receipt)
            : control.nodeWorkerPoll(...identity);
          return jsonResponse(response, 200, result);
        }
        throw new MachineError(404, "Node route not found");
      }
      if (url.pathname === "/api/bootstrap" && method === "GET") {
        response.writeHead(204, { "set-cookie": `mission-control-auth=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store" });
        response.end();
        return;
      }
      const publicApi = url.pathname === "/api/health" || url.pathname === "/api/bootstrap";
      const protectedApi = url.pathname.startsWith("/api/") && !publicApi;
      if (mutation || protectedApi) {
        const authorization = request.headers.authorization?.replace(/^Bearer /, "");
        const cookie = getCookie(request, "mission-control-auth");
        if (!safeEqual(authorization ?? cookie ?? "", token)) throw new HttpError(401, "Authentication required");
        if (mutation && cookie && (request.headers["x-requested-with"] !== "MissionControl" || !origin)) {
          throw new HttpError(403, "Cookie mutations require the same-origin MissionControl request header");
        }
      }
      if (method === "POST" && url.pathname === "/api/machines") {
        const body = await readBody(request);
        exactKeys(body, ["id", "name"]);
        const enrolled = control.enrollMachine(text(body.id, "id", 64), text(body.name, "name", 120));
        return jsonResponse(response, 201, enrolled);
      }
      const machineRevokeMatch = /^\/api\/machines\/([^/]+)\/revoke$/.exec(url.pathname);
      if (machineRevokeMatch && method === "POST") {
        exactKeys(await readBody(request), []);
        return jsonResponse(response, 200, control.revokeMachine(decodeURIComponent(machineRevokeMatch[1]!)));
      }
      const machineReenrollMatch = /^\/api\/machines\/([^/]+)\/reenroll$/.exec(url.pathname);
      if (machineReenrollMatch && method === "POST") {
        exactKeys(await readBody(request), []);
        return jsonResponse(response, 201, control.reenrollMachine(decodeURIComponent(machineReenrollMatch[1]!)));
      }
      const machineProbeMatch = /^\/api\/machines\/([^/]+)\/probe$/.exec(url.pathname);
      if (machineProbeMatch && method === "POST") {
        const body = await readBody(request);
        exactKeys(body, ["path", "requestId"]);
        const command = control.probeMachine(
          decodeURIComponent(machineProbeMatch[1]!),
          text(body.requestId, "requestId", 80),
          text(body.path, "path", 4096)
        );
        return jsonResponse(response, 202, command);
      }
      const machineHistoryMatch = /^\/api\/machines\/([^/]+)\/commands$/.exec(url.pathname);
      if (machineHistoryMatch && method === "GET") {
        if (url.searchParams.getAll("before").length > 1 || [...url.searchParams.keys()].some((key) => key !== "before")) {
          throw new HttpError(400, "Invalid command history query");
        }
        return jsonResponse(response, 200, control.machineRegistry.commands(
          decodeURIComponent(machineHistoryMatch[1]!), url.searchParams.get("before") ?? undefined
        ));
      }
      const machineCommandMatch = /^\/api\/machines\/([^/]+)\/commands\/([^/]+)$/.exec(url.pathname);
      if (machineCommandMatch && method === "GET") {
        return jsonResponse(response, 200, control.machineCommand(
          decodeURIComponent(machineCommandMatch[1]!),
          decodeURIComponent(machineCommandMatch[2]!)
        ));
      }
      if (method === "GET" && url.pathname === "/api/state") return jsonResponse(response, 200, {
        ...control.state(), nodePort: (nodeServer?.address() as AddressInfo | null)?.port ?? null
      });
      if (method === "GET" && url.pathname === "/api/health") return jsonResponse(response, 200, { pid: process.pid, daemonId: control.daemonId });
      if (method === "POST" && url.pathname === "/api/mcp-servers") {
        const body = await readBody(request);
        const saved = await control.upsertMcpServer(body);
        return jsonResponse(response, 201, saved);
      }
      const mcpDiscoverMatch = /^\/api\/mcp-servers\/([^/]+)\/discover$/.exec(url.pathname);
      if (mcpDiscoverMatch && method === "POST") {
        const body = await readBody(request);
        exactKeys(body, ["workspaceId"]);
        const result = await control.discoverMcpServer(decodeURIComponent(mcpDiscoverMatch[1]!), text(body.workspaceId, "workspaceId"));
        return jsonResponse(response, 200, result);
      }
      if (method === "POST" && url.pathname === "/api/profiles") {
        const body = await readBody(request);
        exactKeys(body, ["id", "name", "api", "modelId", "baseUrl", "credentialEnv", "contextWindow", "maxTokens", "reasoning", "toolCalling", "vision", "cost"]);
        if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(String(body.api))) throw new HttpError(400, "Unsupported API type");
        for (const field of ["reasoning", "toolCalling", "vision"]) if (typeof body[field] !== "boolean") throw new HttpError(400, `${field} must be boolean`);
        if (body.credentialEnv !== undefined && (typeof body.credentialEnv !== "string" || (body.credentialEnv && !/^[A-Z_][A-Z0-9_]*$/.test(body.credentialEnv)))) {
          throw new HttpError(400, "credentialEnv must be an environment-variable name");
        }
        let cost: ModelProfile["cost"];
        if (body.cost !== undefined) {
          if (!body.cost || typeof body.cost !== "object" || Array.isArray(body.cost)) throw new HttpError(400, "cost must be an object");
          const rates = body.cost as Record<string, unknown>;
          exactKeys(rates, ["input", "output", "cacheRead", "cacheWrite"]);
          cost = {
            input: number(rates.input, "cost.input"),
            output: number(rates.output, "cost.output"),
            cacheRead: number(rates.cacheRead, "cost.cacheRead"),
            cacheWrite: number(rates.cacheWrite, "cost.cacheWrite")
          };
        }
        const baseUrl = text(body.baseUrl, "baseUrl");
        const endpoint = new URL(baseUrl);
        if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
          throw new HttpError(400, "baseUrl must be an HTTP endpoint without embedded credentials or query data");
        }
        const profile = {
          id: typeof body.id === "string" ? text(body.id, "id") : randomBytes(12).toString("hex"),
          name: text(body.name, "name"), api: text(body.api, "api"), modelId: text(body.modelId, "modelId"),
          baseUrl, credentialEnv: typeof body.credentialEnv === "string" ? body.credentialEnv : "",
          contextWindow: number(body.contextWindow, "contextWindow", 1), maxTokens: number(body.maxTokens, "maxTokens", 1),
          reasoning: body.reasoning, toolCalling: body.toolCalling, vision: body.vision, revision: 0,
          ...(cost ? { cost } : {})
        } as ModelProfile;
        const saved = control.upsertProfile(profile);
        await workers.refreshProfile(saved.id);
        return jsonResponse(response, 201, saved);
      }
      if (method === "POST" && url.pathname === "/api/roles") {
        const body = await readBody(request);
        exactKeys(body, ["id", "name", "kind", "instructions", "profileId", "mcpPermissions"]);
        if (!["orchestrator", "worker", "validator"].includes(String(body.kind))) throw new HttpError(400, "Invalid role kind");
        const role: RoleProfile = { id: typeof body.id === "string" ? text(body.id, "id") : randomUUID(), name: text(body.name, "name"), kind: body.kind as RoleProfile["kind"], instructions: text(body.instructions, "instructions"), profileId: text(body.profileId, "profileId"), ...(body.mcpPermissions === undefined ? {} : { mcpPermissions: body.mcpPermissions as NonNullable<RoleProfile["mcpPermissions"]> }) };
        const saved = control.upsertRole(role);
        await workers.refreshRole(saved.id);
        return jsonResponse(response, 201, saved);
      }
      if (method === "POST" && url.pathname === "/api/workspaces") {
        const body = await readBody(request);
        if (body.machineId !== undefined && body.machineId !== "local") {
          exactKeys(body, ["name", "machineId", "probeCommandId"]);
          return jsonResponse(response, 201, control.addRemoteWorkspace(
            text(body.name, "name", 120), text(body.machineId, "machineId", 64), text(body.probeCommandId, "probeCommandId", 80)
          ));
        }
        exactKeys(body, ["name", "path", "machineId"]);
        let path: string;
        try {
          path = realpathSync(text(body.path, "path"));
        } catch {
          throw new HttpError(400, "Workspace path must exist");
        }
        if (!statSync(path).isDirectory()) throw new HttpError(400, "Workspace path must be a directory");
        return jsonResponse(response, 201, control.addWorkspace(text(body.name, "name"), path));
      }
      if (method === "POST" && url.pathname === "/api/missions") {
        const body = await readBody(request);
        if (Object.keys(body).some((key) => !["title", "goal", "acceptance", "workspaceId", "remoteWorkspaceIds", "roleIds", "maxTurns", "maxCost", "autonomy", "assertions", "workspaceStrategy"].includes(key))) {
          throw new HttpError(400, "Unexpected mission field");
        }
        const mission = control.createMission(parseCreateMissionInput(body));
        return jsonResponse(response, 201, mission);
      }
      const scheduleCollectionMatch = /^\/api\/missions\/([^/]+)\/schedules$/.exec(url.pathname);
      if (scheduleCollectionMatch && method === "POST") {
        const body = await readBody(request);
        exactKeys(body, ["requestId", "name", "prompt", "schedule", "enabled"]);
        const saved = control.createSchedule(
          decodeURIComponent(scheduleCollectionMatch[1]!),
          text(body.requestId, "requestId", 240),
          text(body.name, "name", 160),
          text(body.prompt, "prompt", 10000),
          body.schedule,
          body.enabled === undefined ? false : body.enabled as boolean
        );
        return jsonResponse(response, 201, saved);
      }
      const scheduleMatch = /^\/api\/missions\/([^/]+)\/schedules\/([^/]+)$/.exec(url.pathname);
      if (scheduleMatch && method === "PATCH") {
        const body = await readBody(request);
        exactKeys(body, ["requestId", "expectedRevision", "name", "prompt", "schedule", "enabled"]);
        if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be boolean");
        const saved = control.updateSchedule(
          decodeURIComponent(scheduleMatch[1]!),
          decodeURIComponent(scheduleMatch[2]!),
          text(body.requestId, "requestId", 240),
          positiveSafeInteger(body.expectedRevision, "expectedRevision"),
          text(body.name, "name", 160),
          text(body.prompt, "prompt", 10000),
          body.schedule,
          body.enabled
        );
        return jsonResponse(response, 200, saved);
      }
      const scheduleActionMatch = /^\/api\/missions\/([^/]+)\/schedules\/([^/]+)\/(hold|resume|delete)$/.exec(url.pathname);
      if (scheduleActionMatch && method === "POST") {
        const body = await readBody(request);
        exactKeys(body, ["requestId", "expectedRevision"]);
        const missionId = decodeURIComponent(scheduleActionMatch[1]!);
        const scheduleId = decodeURIComponent(scheduleActionMatch[2]!);
        const requestId = text(body.requestId, "requestId", 240);
        const expectedRevision = positiveSafeInteger(body.expectedRevision, "expectedRevision");
        const action = scheduleActionMatch[3];
        const saved = action === "hold"
          ? control.holdSchedule(missionId, scheduleId, requestId, expectedRevision)
          : action === "resume"
            ? control.resumeSchedule(missionId, scheduleId, requestId, expectedRevision)
            : control.deleteSchedule(missionId, scheduleId, requestId, expectedRevision);
        return jsonResponse(response, 200, saved);
      }
      const watchdogMatch = /^\/api\/missions\/([^/]+)\/watchdog$/.exec(url.pathname);
      if (watchdogMatch && method === "POST") {
        const body = await readBody(request);
        exactKeys(body, ["requestId", "expectedRevision", "autoWake"]);
        if (typeof body.autoWake !== "boolean") throw new HttpError(400, "autoWake must be boolean");
        const saved = control.configureWatchdog(
          decodeURIComponent(watchdogMatch[1]!),
          text(body.requestId, "requestId", 240),
          positiveSafeInteger(body.expectedRevision, "expectedRevision"),
          body.autoWake
        );
        return jsonResponse(response, 200, saved);
      }
      const missionMatch = /^\/api\/missions\/([^/]+)$/.exec(url.pathname);
      if (missionMatch && method === "PATCH") {
        const body = await readBody(request); exactKeys(body, ["title", "maxTurns", "maxCost"]);
        if (body.title !== undefined) return jsonResponse(response, 200, control.patchMission(decodeURIComponent(missionMatch[1]!), text(body.title, "title")));
        if (body.maxTurns !== undefined || body.maxCost !== undefined) return jsonResponse(response, 200, control.updateMissionLimits(
          decodeURIComponent(missionMatch[1]!),
          body.maxTurns === undefined ? undefined : number(body.maxTurns, "maxTurns", 1),
          body.maxCost === undefined ? undefined : number(body.maxCost, "maxCost")
        ));
        throw new HttpError(400, "At least one supported mission field is required");
      }
      if (missionMatch && method === "GET") {
        const detail = control.detail(decodeURIComponent(missionMatch[1]!));
        return jsonResponse(response, 200, {
          ...detail,
          artifacts: detail.artifacts.map((artifact) => ({ ...artifact, downloadName: artifactDownloadName(artifact) }))
        });
      }
      const runtimeMatch = /^\/api\/missions\/([^/]+)\/runtimes$/.exec(url.pathname);
      if (runtimeMatch && method === "GET") return jsonResponse(response, 200, control.remoteRuntimeSnapshots(decodeURIComponent(runtimeMatch[1]!)));
      const contractMatch = /^\/api\/missions\/([^/]+)\/validation-contract$/.exec(url.pathname);
      if (contractMatch && method === "PUT") {
        const body = await readBody(request);
        const contract = control.updateValidationContract(decodeURIComponent(contractMatch[1]!), parseValidationContractUpdateInput(body));
        return jsonResponse(response, 200, contract);
      }
      const exportMatch = /^\/api\/missions\/([^/]+)\/export$/.exec(url.pathname);
      if (exportMatch && method === "GET") return jsonResponse(response, 200, control.exportMission(decodeURIComponent(exportMatch[1]!)));
      const actionMatch = /^\/api\/missions\/([^/]+)\/(start|pause|resume|cancel)$/.exec(url.pathname);
      if (actionMatch && method === "POST") {
        exactKeys(await readBody(request), []);
        const mission = control.missionAction(decodeURIComponent(actionMatch[1]!), actionMatch[2] as "start" | "pause" | "resume" | "cancel");
        if (mission.status === "active") await workers.startMission(mission.id);
        else if (mission.status === "paused") await workers.pauseMission(mission.id);
        else if (mission.status === "cancelled") await workers.stopMission(mission.id);
        if (actionMatch[2] === "resume" && mission.status === "active") await control.executeApprovedPending(mission.id);
        await workers.dispatchPending();
        return jsonResponse(response, 200, mission);
      }
      const agentsMatch = /^\/api\/missions\/([^/]+)\/agents$/.exec(url.pathname);
      if (agentsMatch && method === "POST") {
        const body = await readBody(request);
        if (Object.keys(body).some((key) => !["title", "roleId", "prompt", "requestId", "targetWorkspaceId"].includes(key))) {
          throw new HttpError(400, "Unexpected agent field");
        }
        const agent = control.createAgent(decodeURIComponent(agentsMatch[1]!), text(body.title, "title"), text(body.roleId, "roleId"), text(body.prompt, "prompt"), text(body.requestId, "requestId"),
          body.targetWorkspaceId === undefined ? undefined : text(body.targetWorkspaceId, "targetWorkspaceId", 64));
        if (control.missionForAgent(agent.id)?.status === "active") await workers.startAgent(agent);
        return jsonResponse(response, 201, agent);
      }
      const messageMatch = /^\/api\/missions\/([^/]+)\/messages$/.exec(url.pathname);
      if (messageMatch && method === "POST") {
        const body = await readBody(request); exactKeys(body, ["recipientId", "content", "mode", "requestId"]);
        if (body.mode !== "steer" && body.mode !== "followUp") throw new HttpError(400, "Invalid message mode");
        const message = control.sendMessage(decodeURIComponent(messageMatch[1]!), text(body.recipientId, "recipientId"), text(body.content, "content"), body.mode, text(body.requestId, "requestId"));
        await workers.dispatchPending();
        return jsonResponse(response, 201, message);
      }
      if (method === "POST" && /^\/api\/agents\/[^/]+\/interrupt$/.test(url.pathname)) {
        exactKeys(await readBody(request), []);
        const id = decodeURIComponent(url.pathname.split("/")[3]!);
        await workers.interruptAgent(id);
        return jsonResponse(response, 200, control.getAgentPublic(id));
      }
      const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(url.pathname);
      if (agentMatch && method === "PATCH") {
        const body = await readBody(request); exactKeys(body, ["profileId"]);
        const agent = control.updateAgentProfile(decodeURIComponent(agentMatch[1]!), text(body.profileId, "profileId"));
        await workers.stopAgent(agent.id);
        if (control.missionForAgent(agent.id)?.status === "active") {
          await workers.startAgent(agent);
          await workers.dispatchPending();
        }
        return jsonResponse(response, 200, agent);
      }
      const transcriptMatch = /^\/api\/agents\/([^/]+)\/transcript$/.exec(url.pathname);
      if (transcriptMatch && method === "GET") return jsonResponse(response, 200, { entries: control.transcript(decodeURIComponent(transcriptMatch[1]!)) });
      const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(url.pathname);
      if (approvalMatch && method === "POST") {
        const body = await readBody(request); exactKeys(body, ["decision"]);
        if (body.decision !== "approved" && body.decision !== "denied") throw new HttpError(400, "Invalid approval decision");
        const approval = control.resolveApproval(decodeURIComponent(approvalMatch[1]!), body.decision);
        const mission = control.missionById(approval.missionId);
        const result = approval.remoteEffectBinding
          ? body.decision === "approved" && mission?.status === "active"
            ? await control.executeApproved(approval.id)
            : control.getApproval(approval.id)
          : body.decision === "approved" && mission?.status === "active"
            ? await control.executeApproved(approval.id)
            : approval;
        if (mission?.status === "active" && ["succeeded", "failed", "uncertain", "denied"].includes(result.status)) await workers.dispatchPending();
        return jsonResponse(response, 200, result);
      }
      const blockerMatch = /^\/api\/blockers\/([^/]+)\/resolve$/.exec(url.pathname);
      if (blockerMatch && method === "POST") {
        const body = await readBody(request);
        exactKeys(body, ["resolution"]);
        const blocker = control.resolveBlocker(decodeURIComponent(blockerMatch[1]!), text(body.resolution, "resolution"));
        if (control.missionById(blocker.missionId)?.status === "active") await workers.dispatchPending();
        return jsonResponse(response, 200, blocker);
      }
      if (method === "GET" && url.pathname === "/api/events") {
        const after = Number(url.searchParams.get("after") ?? "0");
        const missionId = url.searchParams.get("missionId") ?? undefined;
        if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, "after must be a non-negative sequence");
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        let seq = after;
        const timer = setInterval(() => {
          for (const event of control.events(seq, missionId)) {
            seq = event.seq;
            response.write(`id: ${event.seq}\nevent: mission\ndata: ${JSON.stringify(event)}\n\n`);
          }
        }, 500);
        sseClients.add(response);
        response.on("close", () => {
          clearInterval(timer);
          sseClients.delete(response);
        });
        return;
      }
      if (method === "GET" && url.pathname.startsWith("/api/artifacts/") && url.pathname.endsWith("/content")) {
        const id = decodeURIComponent(url.pathname.split("/")[3]!);
        const artifact = control.artifact(id);
        if (!artifact) throw new HttpError(404, "Artifact not found");
        if (!artifact.snapshotPath) throw new HttpError(409, "Artifact snapshot is unavailable");
        const bytes = readFileSync(artifact.snapshotPath);
        if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new HttpError(409, "Artifact digest changed");
        response.writeHead(200, {
          "content-type": "application/octet-stream", "content-length": bytes.length,
          "content-disposition": artifactContentDisposition(artifact)
        });
        response.end(bytes);
        return;
      }
      if (method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "set-cookie": `mission-control-auth=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`, "content-type": "text/html; charset=utf-8" });
        response.end(readStatic("index.html"));
        return;
      }
      if (method === "GET" && /^\/(app\.js|style\.css)$/.test(url.pathname)) {
        const file = url.pathname.slice(1);
        response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/css" });
        response.end(readStatic(file));
        return;
      }
      throw new HttpError(404, "Route not found");
    } catch (error) {
      const status = error instanceof HttpError || error instanceof MachineError ? error.status : error instanceof McpConfigurationError ? 400 : 500;
      const message = error instanceof MachineError && error.status === 401 ? "Node authentication failed" :
        error instanceof HttpError || error instanceof MachineError || error instanceof McpConfigurationError ? error.message : "Internal server error";
      jsonResponse(response, status, { error: message });
    }
  };
  const server = createServer(handleRequest(false));
  const nodeServer = options.nodePort === undefined ? undefined : createServer(handleRequest(true));
  let maintenanceTicking = false;
  const heartbeat = setInterval(() => {
    control.heartbeat();
    control.machineRegistry.expireLeases();
    if (!maintenanceTicking) {
      maintenanceTicking = true;
      try {
        control.tickSchedules();
        control.tickWatchdogs();
        control.reconcileRemoteEffectApprovals();
      } finally {
        maintenanceTicking = false;
      }
    }
    void workers.dispatchPending();
    void mailboxDispatcher.drainAll();
  }, 5000);
  server.on("close", () => clearInterval(heartbeat));
  const closeListeners = async (): Promise<void> => {
    await Promise.all([server, nodeServer].filter((listener) => listener !== undefined).map((listener) =>
      new Promise<void>((resolveClose, rejectClose) => {
        if (!listener.listening) return resolveClose();
        listener.close((error) => error ? rejectClose(error) : resolveClose());
        listener.closeIdleConnections();
      })
    ));
  };
  try {
    control.reconcileInFlightOperations();
    await workers.recoverActiveMissions();
    for (const [listener, port] of [[server, options.port], [nodeServer, options.nodePort]] as const) {
      if (!listener) continue;
      await new Promise<void>((resolveListen, reject) => {
        listener.once("error", reject);
        listener.listen(port, "127.0.0.1", () => {
          listener.removeListener("error", reject);
          resolveListen();
        });
      });
    }
  } catch (error) {
    clearInterval(heartbeat);
    for (const client of sseClients) client.end();
    await closeListeners();
    await mailboxDispatcher.close();
    await Promise.all([...lifecycleFlights]);
    await workers.close();
    await control.mcpRuntime.close();
    await control.settlePendingOperations();
    control.close();
    throw error;
  }
  function readStatic(file: string): Buffer {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const packagedRoot = join(moduleDirectory, "public");
    const sourceRoot = resolve(moduleDirectory, "..", "public");
    const root = existsSync(packagedRoot) ? packagedRoot : sourceRoot;
    const target = resolve(root, basename(file));
    if (!target.startsWith(resolve(root) + sep) && target !== resolve(root, basename(file))) throw new HttpError(403, "Invalid static path");
    if (!existsSync(target)) throw new HttpError(404, "UI asset not found");
    return readFileSync(target);
  }
  return {
    server,
    control,
    workers,
    port: (server.address() as AddressInfo).port,
    nodePort: (nodeServer?.address() as AddressInfo | null)?.port,
    close: async () => {
      clearInterval(heartbeat);
      for (const client of sseClients) client.end();
      const listenerClosed = closeListeners();
      const failures: unknown[] = [];
      await mailboxDispatcher.close();
      await Promise.all([...lifecycleFlights]);
      await Promise.all([
        workers.close().catch((error) => { failures.push(error); }),
        control.mcpRuntime.close().catch((error) => { failures.push(error); })
      ]);
      try {
        await control.settlePendingOperations();
      } catch (error) {
        failures.push(error);
      }
      try {
        await listenerClosed;
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw new AggregateError(failures, "Mission Control shutdown did not settle all owned resources");
      control.close();
    }
  };
}
