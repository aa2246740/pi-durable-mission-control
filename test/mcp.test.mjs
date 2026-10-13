import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { test } from "node:test";
import { backupHome, restoreHome } from "../dist/backup.js";
import { ControlPlane } from "../dist/control.js";
import { McpRuntimeManager } from "../dist/mcp-runtime.js";
import { startServer } from "../dist/server.js";

const stdioServerPath = fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url));

const profileTemplate = {
  name: "MCP test profile", api: "openai-completions", modelId: "test-model",
  baseUrl: "http://127.0.0.1:1", credentialEnv: "", contextWindow: 4096,
  maxTokens: 256, reasoning: false, toolCalling: true, vision: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

async function closeControl(control) {
  if (!control) return;
  await control.mcpRuntime.close();
  await control.settlePendingOperations();
  if (!control.closed) control.close();
}

async function fixture(t, {
  grants = [{ toolName: "mark", mode: "allow" }],
  autonomy = "trusted",
  timeoutMs = 10000
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "mission-control-mcp-"));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const home = join(root, "home");
  const marker = join(root, "calls.log");
  const started = join(root, "started.log");
  const pidFile = join(root, "server.pid");
  const suffix = randomBytes(6).toString("hex").toUpperCase();
  const sources = {
    marker: `MCP_TEST_${suffix}_MARKER`,
    started: `MCP_TEST_${suffix}_STARTED`,
    token: `MCP_TEST_${suffix}_TOKEN`,
    schema: `MCP_TEST_${suffix}_SCHEMA`,
    pidFile: `MCP_TEST_${suffix}_PID`
  };
  const previousEnv = Object.fromEntries(Object.values(sources).map((key) => [key, process.env[key]]));
  process.env[sources.marker] = marker;
  process.env[sources.started] = started;
  process.env[sources.token] = "mcp-test-secret-value";
  process.env[sources.schema] = "schema-v1";
  process.env[sources.pidFile] = pidFile;
  const control = new ControlPlane(home);
  writeFileSync(join(home, "admin.token"), "mcp-test-admin-token\n", { mode: 0o600 });
  const profile = control.upsertProfile({ ...profileTemplate, id: `profile-${suffix}` });
  const server = await control.upsertMcpServer({
    id: "fixture", name: "Local MCP fixture", enabled: true, timeoutMs,
    transport: "stdio", command: process.execPath, args: [stdioServerPath],
    envRefs: {
      MCP_FIXTURE_MARKER: sources.marker,
      MCP_FIXTURE_STARTED: sources.started,
      MCP_FIXTURE_TOKEN: sources.token,
      MCP_FIXTURE_SCHEMA: sources.schema,
      MCP_FIXTURE_PID_FILE: sources.pidFile
    }
  });
  const roleIds = ["orchestrator", "worker", "validator"];
  for (const kind of roleIds) {
    control.upsertRole({
      id: `${kind}-${suffix}`, name: kind, kind, instructions: `${kind} test role`,
      profileId: profile.id,
      ...(kind === "worker" ? { mcpPermissions: grants.map((grant) => ({ serverId: server.id, ...grant })) } : {})
    });
  }
  const workspace = control.addWorkspace("MCP fixture workspace", workspacePath);
  const mission = control.createMission({
    title: "MCP backend test", goal: "Exercise the MCP journal", acceptance: "MCP calls remain scoped",
    workspaceId: workspace.id, roleIds: roleIds.map((kind) => `${kind}-${suffix}`),
    maxTurns: 10, maxCost: 1, autonomy
  });
  const startedMission = control.missionAction(mission.id, "start");
  const worker = control.createAgent(mission.id, "MCP worker", `worker-${suffix}`, "test prompt", `worker-${suffix}`);
  const value = {
    root, home, workspacePath, workspace, control, profile, server, mission: startedMission, worker,
    marker, started, pidFile, sources
  };
  t.after(async () => {
    await closeControl(value.control);
    rmSync(root, { recursive: true, force: true });
    for (const [key, previous] of Object.entries(previousEnv)) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
  return value;
}

async function discover(f) {
  const result = await f.control.discoverMcpServer(f.server.id, f.workspace.id);
  return result.tools;
}

function markerLines(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

test("operator discovery uses real stdio SDK; exact grant calls write one marker", async (t) => {
  const f = await fixture(t);
  const tools = await discover(f);
  const tool = tools.find((item) => item.name === "mark");
  assert.equal(typeof tool.definitionHash, "string");
  assert.equal(markerLines(f.started).length, 1);
  const approval = await f.control.createMcpApproval(
    f.worker.id, f.worker.epoch, "stdio-call-1", f.server.id, "mark", { value: "v1" }, tool.definitionHash
  );
  assert.equal(approval.status, "succeeded");
  assert.equal(approval.authorizationSource, "role-permission");
  assert.equal(approval.receipt.exitCode, 0);
  assert.deepEqual(markerLines(f.marker), ["v1"]);
  assert.equal(f.control.mcpRuntime.activeCount, 0);
});

test("default deny rejects before connecting and explicit approval gates dispatch", async (t) => {
  const denied = await fixture(t, { grants: [] });
  await assert.rejects(
    denied.control.createMcpApproval(denied.worker.id, denied.worker.epoch, "denied-call", denied.server.id, "mark", { value: "v1" }, "a".repeat(64)),
    /exact MCP tool is not granted/
  );
  assert.equal(existsSync(denied.started), false);
  assert.equal(denied.control.db.prepare("SELECT count(*) AS n FROM approvals").get().n, 0);

  const approved = await fixture(t, { autonomy: "approve" });
  const tool = (await discover(approved)).find((item) => item.name === "mark");
  const pending = await approved.control.createMcpApproval(
    approved.worker.id, approved.worker.epoch, "approval-call", approved.server.id, "mark", { value: "v1" }, tool.definitionHash
  );
  assert.equal(pending.status, "pending");
  assert.deepEqual(markerLines(approved.marker), []);
  const decision = approved.control.resolveApproval(pending.id, "approved");
  assert.equal(decision.authorizationSource, "user-approval");
  const result = await approved.control.executeApproved(pending.id);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(markerLines(approved.marker), ["v1"]);
});

test("inactive MCP approvals reject before journaling or a new connection", async (t) => {
  const f = await fixture(t);
  const tool = (await discover(f)).find((item) => item.name === "mark");
  const startedBefore = markerLines(f.started).length;
  f.control.missionAction(f.mission.id, "pause");
  await assert.rejects(
    f.control.createMcpApproval(f.worker.id, f.worker.epoch, "inactive-mcp", f.server.id, "mark", { value: "v1" }, tool.definitionHash),
    /Mission is not active/
  );
  assert.equal(f.control.db.prepare("SELECT count(*) AS n FROM approvals").get().n, 0);
  assert.equal(markerLines(f.started).length, startedBefore);
});

test("concurrent duplicate trusted calls join one journaled dispatch", async (t) => {
  const f = await fixture(t);
  const tool = (await discover(f)).find((item) => item.name === "mark");
  const args = [f.worker.id, f.worker.epoch, "duplicate-call", f.server.id, "mark", { value: "v1" }, tool.definitionHash];
  const [first, second] = await Promise.all([f.control.createMcpApproval(...args), f.control.createMcpApproval(...args)]);
  assert.equal(first.id, second.id);
  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.deepEqual(markerLines(f.marker), ["v1"]);
  const journal = f.control.db.prepare("SELECT data FROM approvals WHERE mission_id=?").all(f.mission.id);
  assert.equal(journal.map((row) => JSON.parse(row.data)).filter((item) => item.tool === "mcp_call").length, 1);
  await assert.rejects(
    f.control.createMcpApproval(f.worker.id, f.worker.epoch, "duplicate-call", f.server.id, "mark", { value: "different" }, tool.definitionHash),
    /different arguments/
  );
});

test("terminal isError results are durable failures and explicit references redact metadata and results", async (t) => {
  const f = await fixture(t, { grants: [
    { toolName: "fail", mode: "allow" }, { toolName: "echoSecret", mode: "allow" }, { toolName: "mark", mode: "allow" }
  ] });
  const catalog = await discover(f);
  const mark = catalog.find((item) => item.name === "mark");
  assert.equal(mark.description.includes("mcp-test-secret-value"), false);
  assert.equal(mark.description.includes("[REDACTED]"), true);
  await assert.rejects(
    f.control.createMcpApproval(f.worker.id, f.worker.epoch, "credential-argument", f.server.id, "mark", { value: "mcp-test-secret-value" }, mark.definitionHash),
    /must not contain configured credential values/
  );
  const failure = await f.control.createMcpApproval(
    f.worker.id, f.worker.epoch, "is-error", f.server.id, "fail", {}, catalog.find((item) => item.name === "fail").definitionHash
  );
  assert.equal(failure.status, "failed");
  assert.equal(failure.receipt.exitCode, 1);
  const secret = await f.control.createMcpApproval(
    f.worker.id, f.worker.epoch, "redacted-result", f.server.id, "echoSecret", {}, catalog.find((item) => item.name === "echoSecret").definitionHash
  );
  assert.equal(secret.receipt.stdout.includes("mcp-test-secret-value"), false);
  assert.equal(secret.receipt.stdout.includes("[REDACTED]"), true);
  const persisted = f.control.db.prepare("SELECT data FROM approvals WHERE id=?").get(secret.id).data;
  assert.equal(persisted.includes("mcp-test-secret-value"), false);
  assert.equal(readFileSync(join(f.home, "control.sqlite")).includes("mcp-test-secret-value"), false);
});

test("schema and configuration revisions become explicit not-executed failures", async (t) => {
  const f = await fixture(t);
  const tool = (await discover(f)).find((item) => item.name === "mark");
  process.env[f.sources.schema] = "schema-v2";
  const staleSchema = await f.control.createMcpApproval(
    f.worker.id, f.worker.epoch, "stale-schema", f.server.id, "mark", { value: "v1" }, tool.definitionHash
  );
  assert.equal(staleSchema.status, "failed");
  assert.match(staleSchema.receipt.stderr, /not executed/i);
  assert.deepEqual(markerLines(f.marker), []);

  process.env[f.sources.schema] = "schema-v1";
  const fresh = (await discover(f)).find((item) => item.name === "mark");
  const staleConfig = f.control.createMcpApproval(
    f.worker.id, f.worker.epoch, "stale-config", f.server.id, "mark", { value: "v1" }, fresh.definitionHash
  );
  const revised = await f.control.upsertMcpServer({
    id: f.server.id, name: "Revised fixture", enabled: true, timeoutMs: f.server.timeoutMs,
    transport: "stdio", command: process.execPath, args: [stdioServerPath],
    envRefs: f.server.envRefs, expectedRevision: f.server.revision
  });
  assert.equal(revised.revision, f.server.revision + 1);
  const configOutcome = await staleConfig;
  assert.equal(configOutcome.status, "failed");
  assert.deepEqual(markerLines(f.marker), []);
});

test("changed role revisions invalidate an already approved call before dispatch", async (t) => {
  const f = await fixture(t, { autonomy: "approve" });
  const tool = (await discover(f)).find((item) => item.name === "mark");
  const pending = await f.control.createMcpApproval(
    f.worker.id, f.worker.epoch, "stale-role", f.server.id, "mark", { value: "v1" }, tool.definitionHash
  );
  f.control.missionAction(f.mission.id, "pause");
  f.control.resolveApproval(pending.id, "approved");
  const roleId = f.worker.roleId;
  const role = f.control.role(roleId);
  const withoutPermissions = { ...role };
  delete withoutPermissions.mcpPermissions;
  const preserved = f.control.upsertRole({ ...withoutPermissions, name: `${role.name}-preserved` });
  assert.deepEqual(preserved.mcpPermissions, role.mcpPermissions);
  f.control.upsertRole({ ...preserved, mcpPermissions: [] });
  f.control.missionAction(f.mission.id, "resume");
  const result = await f.control.executeApproved(pending.id);
  assert.equal(result.status, "failed");
  assert.match(result.receipt.stderr, /not executed/i);
  assert.deepEqual(markerLines(f.marker), []);
  assert.equal(markerLines(f.started).length, 1);
});

test("trusted role approval mode gates dispatch and disabled scope never spawns", async (t) => {
  const f = await fixture(t, { grants: [{ toolName: "mark", mode: "approve" }] });
  const tool = (await discover(f)).find((item) => item.name === "mark");
  const pending = await f.control.createMcpApproval(f.worker.id, f.worker.epoch, "approval-mode", f.server.id, "mark", { value: "v1" }, tool.definitionHash);
  assert.equal(pending.status, "pending");
  f.control.missionAction(f.mission.id, "pause");
  f.control.resolveApproval(pending.id, "approved");
  const before = markerLines(f.started).length;
  f.control.missionAction(f.mission.id, "resume");
  const staleRevision = await f.control.createMcpApproval(
    f.worker.id, f.worker.epoch, "stale-enabled-revision", f.server.id, "mark", { value: "v2" }, tool.definitionHash
  );
  assert.equal(staleRevision.status, "pending");
  f.control.missionAction(f.mission.id, "pause");
  f.control.resolveApproval(staleRevision.id, "approved");
  const revisedEnabled = await f.control.upsertMcpServer({
    id: f.server.id, name: f.server.name, enabled: true, timeoutMs: f.server.timeoutMs + 1,
    transport: f.server.transport, command: f.server.command, args: f.server.args, envRefs: f.server.envRefs,
    expectedRevision: f.server.revision
  });
  f.control.missionAction(f.mission.id, "resume");
  const staleResult = await f.control.executeApproved(staleRevision.id);
  assert.equal(staleResult.status, "failed");
  assert.equal(markerLines(f.started).length, before);
  const revised = await f.control.upsertMcpServer({
    id: f.server.id, name: f.server.name, enabled: false, timeoutMs: f.server.timeoutMs,
    transport: f.server.transport, command: f.server.command, args: f.server.args, envRefs: f.server.envRefs,
    expectedRevision: revisedEnabled.revision
  });
  assert.equal(revised.enabled, false);
  const result = await f.control.executeApproved(pending.id);
  assert.equal(result.status, "failed");
  assert.equal(markerLines(f.started).length, before);
});

test("returned oversized result is terminal and never replayed", async (t) => {
  const f = await fixture(t, { grants: [{ toolName: "oversized", mode: "allow" }] });
  const tool = (await discover(f)).find((item) => item.name === "oversized");
  const result = await f.control.createMcpApproval(f.worker.id, f.worker.epoch, "oversized-result", f.server.id, "oversized", {}, tool.definitionHash);
  assert.equal(result.status, "failed");
  assert.match(result.receipt.stderr, /response was received|external effects may have happened/i);
  assert.doesNotMatch(result.receipt.stderr, /tool was not executed/i);
  assert.deepEqual(markerLines(f.marker), ["oversized"]);
  const again = await f.control.executeApproved(result.id);
  assert.equal(again.status, "failed");
  assert.deepEqual(markerLines(f.marker), ["oversized"]);
});

test("empty credential references fail before stdio spawn", async (t) => {
  const f = await fixture(t);
  const empty = `MCP_EMPTY_${randomBytes(4).toString("hex").toUpperCase()}`;
  const previous = process.env[empty];
  process.env[empty] = "";
  t.after(() => { if (previous === undefined) delete process.env[empty]; else process.env[empty] = previous; });
  const config = { ...f.server, envRefs: { ...f.server.envRefs, EMPTY: empty } };
  const runtime = new McpRuntimeManager();
  try {
    await assert.rejects(runtime.discover(config, f.workspacePath, { serverId: config.id, revision: config.revision }), /unavailable/);
    assert.equal(markerLines(f.started).length, 0);
  } finally {
    await runtime.close();
  }
});

test("timed-out dispatched call is uncertain across reopen and never replays", async (t) => {
  const f = await fixture(t, {
    grants: [{ toolName: "hang", mode: "allow" }],
    timeoutMs: 1000
  });
  const tool = (await discover(f)).find((item) => item.name === "hang");
  const result = await f.control.createMcpApproval(
    f.worker.id, f.worker.epoch, "hang-call", f.server.id, "hang", {}, tool.definitionHash
  );
  assert.equal(result.status, "uncertain");
  assert.deepEqual(markerLines(f.marker), ["hang"]);
  assert.ok(f.control.blockers(f.mission.id).some((item) => item.id === `approval:${result.id}` && item.status === "open"));
  const childPid = Number(readFileSync(f.pidFile, "utf8"));
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
  await closeControl(f.control);
  f.control = new ControlPlane(f.home);
  f.control.reconcileInFlightOperations();
  await f.control.executeApprovedPending(f.mission.id);
  assert.deepEqual(markerLines(f.marker), ["hang"]);
  assert.equal(f.control.approvalFlights.size, 0);
});

test("configuration, grants, and reconciliation quarantine survive offline backup and restore", async (t) => {
  const f = await fixture(t, { grants: [{ toolName: "mark", mode: "approve" }] });
  const tool = (await discover(f)).find((item) => item.name === "mark");
  const pending = await f.control.createMcpApproval(f.worker.id, f.worker.epoch, "backup-pending", f.server.id, "mark", { value: "pending" }, tool.definitionHash);
  const approved = await f.control.createMcpApproval(f.worker.id, f.worker.epoch, "backup-approved", f.server.id, "mark", { value: "approved" }, tool.definitionHash);
  f.control.resolveApproval(approved.id, "approved");
  const originalApprovalData = f.control.db.prepare("SELECT id,data,status FROM approvals WHERE id IN (?,?) ORDER BY id").all(pending.id, approved.id);
  const originalMappings = f.control.db.prepare("SELECT actor_id,command_id,payload_hash,approval_id FROM mcp_call_commands WHERE command_id IN (?,?) ORDER BY command_id").all("backup-pending", "backup-approved");
  const state = f.control.getMissionState(f.worker.id, f.worker.epoch);
  assert.deepEqual(state.mcpServers, [{
    id: f.server.id, name: f.server.name, revision: f.server.revision,
    tools: [{ toolName: "mark", mode: "approve" }]
  }]);
  assert.equal(JSON.stringify(state.mcpServers).includes("envRefs"), false);
  await closeControl(f.control);
  const backup = join(f.root, "backup");
  await backupHome(f.home, backup, "test", async () => {});
  const restored = join(f.root, "restored");
  restoreHome(backup, restored);
  f.control = new ControlPlane(restored);
  const restoredApprovalData = f.control.db.prepare("SELECT id,data,status FROM approvals WHERE id IN (?,?) ORDER BY id").all(pending.id, approved.id);
  const restoredMappings = f.control.db.prepare("SELECT actor_id,command_id,payload_hash,approval_id FROM mcp_call_commands WHERE command_id IN (?,?) ORDER BY command_id").all("backup-pending", "backup-approved");
  assert.deepEqual(restoredMappings, originalMappings);
  const binding = (row) => {
    const data = JSON.parse(row.data);
    delete data.status;
    return { id: row.id, data };
  };
  assert.deepEqual(restoredApprovalData.map(binding), originalApprovalData.map(binding));
  assert.deepEqual(restoredApprovalData.map((row) => row.status), ["uncertain", "uncertain"]);
  assert.ok(f.control.blockers(f.mission.id).some((item) => item.id === `approval:${pending.id}` && item.kind === "approval"));
  assert.ok(f.control.blockers(f.mission.id).some((item) => item.id === `approval:${approved.id}` && item.kind === "approval"));
  assert.equal(markerLines(f.marker).length, 0);
  for (const approvalId of [pending.id, approved.id]) f.control.resolveBlocker(`approval:${approvalId}`, "Reviewed external effect; do not replay.");
  await f.control.executeApprovedPending(f.mission.id);
  assert.equal(markerLines(f.marker).length, 0);
  const servers = f.control.mcpServers();
  assert.equal(servers[0].id, f.server.id);
  assert.equal(JSON.stringify(servers).includes("mcp-test-secret-value"), false);
  const role = f.control.role(`worker-${f.profile.id.slice("profile-".length)}`);
  assert.deepEqual(role.mcpPermissions, [{ serverId: f.server.id, toolName: "mark", mode: "approve" }]);
  assert.equal(f.control.missionById(f.mission.id).status, "blocked");
  assert.ok(f.control.blockers(f.mission.id).some((item) => item.kind === "unsafe_execution" && item.status === "open"));
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function httpFixture() {
  const token = "http-mcp-secret";
  const calls = [];
  const errors = [];
  const requests = [];
  const makeServer = () => {
    const server = new Server({ name: "HTTP fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "mark", description: "http marker", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }]
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(request.params.arguments.value);
      return { content: [{ type: "text", text: `http:${request.params.arguments.value}` }] };
    });
    return server;
  };
  const http = createServer((request, response) => {
    const record = {
      method: request.method, path: request.url, accept: request.headers.accept,
      contentType: request.headers["content-type"], authenticated: request.headers.authorization === `Bearer ${token}`, body: ""
    };
    requests.push(record);
    if (!record.authenticated) {
      response.writeHead(401).end("missing expected authentication");
      return;
    }
    const end = response.end.bind(response);
    response.end = (chunk, ...args) => {
      if (chunk !== undefined) record.responseBody = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return end(chunk, ...args);
    };
    response.once("finish", () => record.status = response.statusCode);
    void (async () => {
      const server = makeServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      response.once("close", () => {
        void transport.close();
        void server.close();
      });
      await transport.handleRequest(request, response);
    })().catch((error) => {
      errors.push(error instanceof Error ? error.stack || error.message : String(error));
      if (!response.headersSent) response.writeHead(500).end("MCP fixture request failed");
    });
  });
  const port = await listen(http);
  return { url: `http://127.0.0.1:${port}/mcp`, token, calls, errors, requests, close: async () => {
    await new Promise((resolve) => http.close(resolve));
  } };
}

async function paginatedCatalogFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mission-control-mcp-pages-"));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const suffix = randomBytes(6).toString("hex");
  const tokenEnv = `MCP_PAGE_TOKEN_${suffix.toUpperCase()}`;
  const previousToken = process.env[tokenEnv];
  process.env[tokenEnv] = "catalog-secret";
  const schema = "https://json-schema.org/draft/2020-12/schema#";
  const sharedId = "https://example.test/shared-output";
  const pageOne = [
    { name: "earlier", inputSchema: { $schema: schema, type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, outputSchema: { $schema: schema, $id: sharedId, type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } },
    { name: "wrong", inputSchema: { $schema: schema, type: "object", additionalProperties: false }, outputSchema: { $schema: schema, $id: sharedId, type: "object", properties: { result: { type: "number" } }, required: ["result"], additionalProperties: false } }
  ];
  const pageTwo = [
    { name: "required-task", execution: { taskSupport: "required" }, inputSchema: { $schema: schema, type: "object", additionalProperties: false }, outputSchema: { $schema: schema, $id: sharedId, type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } },
    { name: "malformed-ungranted", inputSchema: { $schema: "https://example.invalid/schema", type: "object" }, outputSchema: { $schema: schema, $id: sharedId, type: "object" } }
  ];
  const calls = [];
  const errors = [];
  const http = createServer((request, response) => {
    const server = new Server({ name: "Paginated catalog", version: "1.0.0" }, {
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {}, experimental: { fixture: {} } }
    });
    server.setRequestHandler(ListToolsRequestSchema, async (message) => message.params?.cursor === "page-2"
      ? { tools: pageTwo }
      : { tools: pageOne, nextCursor: "page-2" });
    server.setRequestHandler(CallToolRequestSchema, async (message) => {
      calls.push(message.params.name);
      if (message.params.name === "earlier") return { content: [{ type: "text", text: "ok" }], structuredContent: { result: "ok" } };
      if (message.params.name === "wrong") return { content: [{ type: "text", text: "wrong" }], structuredContent: { result: "not-a-number" } };
      return { content: [{ type: "text", text: "unexpected" }], structuredContent: { result: "unexpected" } };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.once("close", () => { void transport.close(); void server.close(); });
    void server.connect(transport).then(() => transport.handleRequest(request, response)).catch((error) => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500).end("fixture failure");
    });
  });
  const port = await listen(http);
  const control = new ControlPlane(join(root, "home"));
  const profile = control.upsertProfile({ ...profileTemplate, id: `catalog-profile-${suffix}` });
  const roleIds = [`catalog-orchestrator-${suffix}`, `catalog-worker-${suffix}`, `catalog-validator-${suffix}`];
  const serverConfig = await control.upsertMcpServer({ id: "catalog", name: "Paginated catalog", enabled: true, timeoutMs: 10000, transport: "http", url: `http://127.0.0.1:${port}/mcp`, headerRefs: { Authorization: { env: tokenEnv, prefix: "Bearer " } } });
  control.upsertRole({ id: roleIds[0], name: "orchestrator", kind: "orchestrator", instructions: "orchestrator", profileId: profile.id });
  control.upsertRole({ id: roleIds[1], name: "worker", kind: "worker", instructions: "worker", profileId: profile.id, mcpPermissions: [
    { serverId: "catalog", toolName: "earlier", mode: "allow" },
    { serverId: "catalog", toolName: "wrong", mode: "allow" },
    { serverId: "catalog", toolName: "required-task", mode: "allow" }
  ] });
  control.upsertRole({ id: roleIds[2], name: "validator", kind: "validator", instructions: "validator", profileId: profile.id });
  const workspace = control.addWorkspace("catalog", workspacePath);
  const mission = control.missionAction(control.createMission({ title: "catalog", goal: "catalog", acceptance: "catalog", workspaceId: workspace.id, roleIds, maxTurns: 10, maxCost: 1, autonomy: "trusted" }).id, "start");
  const worker = control.createAgent(mission.id, "worker", roleIds[1], "worker", `catalog-worker-${suffix}`);
  const value = { root, control, workspace, server: serverConfig, mission, worker, calls, errors };
  t.after(async () => {
    await closeControl(control);
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
    rmSync(root, { recursive: true, force: true });
    if (previousToken === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previousToken;
  });
  return value;
}

test("server close cancels an in-flight operator HTTP discovery before its deadline", async (t) => {
  let listStartedResolve;
  let remoteClosedResolve;
  const listStarted = new Promise((resolve) => { listStartedResolve = resolve; });
  const remoteClosed = new Promise((resolve) => { remoteClosedResolve = resolve; });
  const remote = createServer((request, response) => {
    const provider = new Server({ name: "slow discovery", version: "1.0.0" }, { capabilities: { tools: {} } });
    provider.setRequestHandler(ListToolsRequestSchema, async () => {
      listStartedResolve();
      await new Promise((_, reject) => response.once("close", () => reject(new Error("discovery cancelled"))));
      return { tools: [] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.once("close", () => {
      void transport.close();
      void provider.close();
      remoteClosedResolve();
    });
    void provider.connect(transport).then(() => transport.handleRequest(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500).end("cancelled");
    });
  });
  const remotePort = await listen(remote);
  const root = mkdtempSync(join(tmpdir(), "mission-control-mcp-shutdown-"));
  const app = await startServer({ home: join(root, "home"), port: 0 });
  let productClosed = false;
  let handlerSettled = false;
  let databaseClosedBeforeHandlerSettled = false;
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const workspace = app.control.addWorkspace("shutdown", workspacePath);
  const serverConfig = await app.control.upsertMcpServer({
    id: "slow", name: "Slow discovery", enabled: true, timeoutMs: 30000,
    transport: "http", url: `http://127.0.0.1:${remotePort}/mcp`
  });
  app.server.on("request", (incoming, outgoing) => {
    if (incoming.url === `/api/mcp-servers/${serverConfig.id}/discover`) {
      outgoing.once("finish", () => { handlerSettled = true; });
    }
  });
  const closeDatabase = app.control.close.bind(app.control);
  app.control.close = () => {
    databaseClosedBeforeHandlerSettled ||= !handlerSettled;
    closeDatabase();
  };
  const token = readFileSync(join(root, "home", "admin.token"), "utf8").trim();
  t.after(async () => {
    if (!productClosed) await app.close().catch(() => {});
    remote.closeAllConnections();
    await new Promise((resolve) => remote.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const startedAt = Date.now();
  const request = fetch(`http://127.0.0.1:${app.port}/api/mcp-servers/${serverConfig.id}/discover`, {
    method: "POST", headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: workspace.id })
  });
  await listStarted;
  assert.equal(app.control.mcpRuntime.activeCount, 1);
  const closing = app.close();
  const response = await request;
  await closing;
  productClosed = true;
  assert.ok(Date.now() - startedAt < 5000);
  assert.ok(response.status >= 400);
  assert.equal(handlerSettled, true);
  assert.equal(databaseClosedBeforeHandlerSettled, false);
  const remoteCloseTimeout = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("remote provider did not close")), 2000);
    remoteClosed.finally(() => clearTimeout(timer));
  });
  await Promise.race([remoteClosed, remoteCloseTimeout]);
  assert.equal(app.control.mcpRuntime.activeCount, 0);
});

test("paginated SDK catalogs isolate selected schemas and optional capabilities", async (t) => {
  const f = await paginatedCatalogFixture(t);
  await assert.rejects(f.control.discoverMcpServer(f.server.id, f.workspace.id), /schema|invalid/i);
  const selected = await f.control.listGrantedMcpTools(f.worker.id, f.worker.epoch, f.server.id);
  assert.deepEqual(selected.map((tool) => tool.name), ["earlier", "wrong", "required-task"]);
  const success = await f.control.createMcpApproval(f.worker.id, f.worker.epoch, "catalog-earlier", f.server.id, "earlier", { value: "ok" }, selected[0].definitionHash);
  assert.equal(success.status, "succeeded");
  assert.deepEqual(f.calls, ["earlier"]);
  assert.deepEqual(selected.map((tool) => tool.name), ["earlier", "wrong", "required-task"]);
  const wrong = selected.find((tool) => tool.name === "wrong");
  const wrongResult = await f.control.createMcpApproval(f.worker.id, f.worker.epoch, "catalog-wrong", f.server.id, "wrong", {}, wrong.definitionHash);
  assert.equal(wrongResult.status, "failed");
  assert.match(wrongResult.receipt.stderr, /response was received|external effects may have happened/i);
  assert.doesNotMatch(wrongResult.receipt.stderr, /tool was not executed/i);
  const required = selected.find((tool) => tool.name === "required-task");
  const requiredResult = await f.control.createMcpApproval(f.worker.id, f.worker.epoch, "catalog-required", f.server.id, "required-task", {}, required.definitionHash);
  assert.equal(requiredResult.status, "failed");
  assert.match(requiredResult.receipt.stderr, /task execution/i);
  assert.deepEqual(f.calls, ["earlier", "wrong"]);
});

test("real Streamable HTTP initializes, lists, and calls tools with referenced headers", async (t) => {
  const fixture = await httpFixture();
  const runtime = new McpRuntimeManager();
  const root = mkdtempSync(join(tmpdir(), "mission-control-mcp-http-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const envName = `MCP_HTTP_TOKEN_${randomBytes(4).toString("hex").toUpperCase()}`;
  const previous = process.env[envName];
  process.env[envName] = fixture.token;
  t.after(async () => {
    await runtime.close();
    await fixture.close();
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
  });
  const config = {
    id: "http-fixture", name: "HTTP fixture", revision: 1, enabled: true, timeoutMs: 10000,
    transport: "http", url: fixture.url, headerRefs: { Authorization: { env: envName, prefix: "Bearer " } }
  };
  let tools;
  try {
    tools = await runtime.discover(config, workspace, { serverId: config.id, revision: 1 });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; server errors: ${fixture.errors.join(" | ")}; requests: ${JSON.stringify(fixture.requests)}`);
  }
  const result = await runtime.call(config, workspace, { serverId: config.id, revision: 1 }, "mark", { value: "ok" }, tools[0].definitionHash, () => {});
  assert.ok(fixture.requests.length > 0);
  assert.ok(fixture.requests.every((request) => request.authenticated));
  assert.deepEqual(fixture.calls, ["ok"]);
  assert.match(JSON.stringify(result.result), /http:ok/);
  const missingName = `MCP_HTTP_MISSING_${randomBytes(4).toString("hex").toUpperCase()}`;
  const missingConfig = {
    ...config,
    headerRefs: { Authorization: { env: missingName, prefix: "Bearer " } }
  };
  const requestsBeforeMissing = fixture.requests.length;
  await assert.rejects(runtime.discover(missingConfig, workspace, { serverId: config.id, revision: 1 }), /unavailable/);
  assert.equal(fixture.requests.length, requestsBeforeMissing);
});

test("HTTP redirects are rejected before credentials reach a second receiver", async (t) => {
  let received = 0;
  const second = createServer((request, response) => {
    received += 1;
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const secondPort = await listen(second);
  const first = createServer((request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${secondPort}/collect` }).end();
  });
  const firstPort = await listen(first);
  const runtime = new McpRuntimeManager();
  const root = mkdtempSync(join(tmpdir(), "mission-control-mcp-redirect-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const envName = `MCP_REDIRECT_TOKEN_${randomBytes(4).toString("hex").toUpperCase()}`;
  const previous = process.env[envName];
  process.env[envName] = "redirect-secret";
  t.after(async () => {
    await runtime.close();
    await Promise.all([new Promise((resolve) => first.close(resolve)), new Promise((resolve) => second.close(resolve))]);
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
  });
  const config = {
    id: "redirect", name: "Redirect", revision: 1, enabled: true, timeoutMs: 5000,
    transport: "http", url: `http://127.0.0.1:${firstPort}/mcp`,
    headerRefs: { Authorization: { env: envName, prefix: "Bearer " } }
  };
  await assert.rejects(runtime.discover(config, workspace, { serverId: config.id, revision: 1 }));
  assert.equal(received, 0);
});
