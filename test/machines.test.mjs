import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { ControlPlane } from "../dist/control.js";
import { MachineRegistry, parseNodeCapabilities } from "../dist/machines.js";
import { startServer } from "../dist/server.js";
import { WorkerManager } from "../dist/workers.js";

const capabilities = (root) => ({
  protocol: 1, version: "test", platform: process.platform, arch: process.arch,
  node: process.version, piDurable: "1.1.0", roots: [root], credentialRefs: [], executionEnabled: false
});
const uuid = () => crypto.randomUUID();

test("node capabilities accept only readonly v1 or explicit metadata-only v2", () => {
  const v1 = capabilities("/remote");
  assert.equal(parseNodeCapabilities(v1).executionEnabled, false);
  const v2 = parseNodeCapabilities({
    ...v1, protocol: 2, executionEnabled: true, executionMode: "metadata-only"
  });
  assert.equal(v2.executionEnabled, true);
  assert.equal(v2.executionMode, "metadata-only");
  for (const invalid of [
    { ...v1, protocol: 1, executionEnabled: true },
    { ...v1, protocol: 1, executionEnabled: false, executionMode: "metadata-only" },
    { ...v1, protocol: 2, executionEnabled: false },
    { ...v1, protocol: 2, executionEnabled: true },
    { ...v1, protocol: 2, executionEnabled: true, executionMode: "full" },
    { ...v1, protocol: 2, executionEnabled: true, executionMode: "metadata-only", testOnlyScripted: true }
  ]) assert.throws(() => parseNodeCapabilities(invalid));
});

test("remote workspace registration binds an authenticated receipt, never a coordinator path, and survives restart", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-remote-workspace-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let service = await startServer({ home, port: 0 });
  t.after(() => service.close());
  const control = service.control;
  const remoteRoot = `/remote-only-${uuid()}`;
  assert.equal(existsSync(remoteRoot), false);
  const enrolled = control.enrollMachine("binding-node", "Binding node");
  const session = control.nodeSession(enrolled.machine.id, enrolled.token, capabilities(remoteRoot), uuid());
  const probe = control.probeMachine(enrolled.machine.id, uuid(), remoteRoot + "/alias");
  const headers = {
    authorization: `Bearer ${readFileSync(join(home, "admin.token"), "utf8").trim()}`,
    "content-type": "application/json"
  };
  const body = { name: "Linux project", machineId: enrolled.machine.id, probeCommandId: probe.id };
  const post = (payload, auth = headers) => fetch(`http://127.0.0.1:${service.port}/api/workspaces`, {
    method: "POST", headers: auth, body: JSON.stringify(payload)
  });
  assert.equal((await post(body)).status, 409);
  control.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  assert.equal((await post(body)).status, 409);
  const receipt = control.nodeEvent(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: remoteRoot + "/alias", path: remoteRoot + "/canonical", isDirectory: true }
  });
  assert.equal((await post(body, { ...headers, authorization: `Bearer ${enrolled.token}` })).status, 401);
  assert.equal((await post({ ...body, path: home })).status, 400);
  assert.equal((await post({ ...body, machineId: "unrelated-node" })).status, 404);
  const response = await post(body);
  assert.equal(response.status, 201);
  const workspace = await response.json();
  assert.equal(workspace.path, remoteRoot + "/canonical");
  assert.equal(workspace.machineId, enrolled.machine.id);
  assert.deepEqual(workspace.probe, {
    commandId: probe.id, sessionEpoch: session.sessionEpoch,
    requestedPath: remoteRoot + "/alias", verifiedAt: receipt.updatedAt
  });
  assert.deepEqual(await (await post(body)).json(), workspace);
  assert.equal((await post({ ...body, name: "Changed binding" })).status, 409);
  assert.equal(control.state().workspaces.length, 1);
  assert.equal(existsSync(remoteRoot), false);
  assert.throws(() => control.createMission({
    title: "Remote cannot be the delivery root", goal: "test", acceptance: "test",
    workspaceId: workspace.id, roleIds: [], maxTurns: 1, maxCost: 0, autonomy: "approve"
  }), /delivery workspace must be local/);
  const marker = join(home, "mcp-must-not-start");
  await control.upsertMcpServer({
    id: "local-discovery-guard", name: "Local discovery guard", enabled: true,
    timeoutMs: 1000, transport: "stdio", command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`], envRefs: {}
  });
  await assert.rejects(control.discoverMcpServer("local-discovery-guard", workspace.id), /requires a local workspace/);
  assert.equal(existsSync(marker), false);
  await service.close();
  service = await startServer({ home, port: 0 });
  assert.deepEqual(service.control.workspace(workspace.id), workspace);
  assert.deepEqual(await (await post(body)).json(), workspace);
  assert.equal(service.control.state().workspaces.length, 1);
});

test("remote workspace assignments are mission-scoped and readonly protocol-1 nodes cannot spawn workers", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-remote-assignment-"));
  const control = new ControlPlane(join(home, "state"));
  let manager;
  t.after(async () => {
    await manager?.close();
    control.close();
    rmSync(home, { recursive: true, force: true });
  });

  const workspacePath = join(home, "local-project");
  mkdirSync(workspacePath);
  const localWorkspace = control.addWorkspace("Local project", workspacePath);
  control.upsertProfile({
    id: "remote-assignment-profile", name: "Remote assignment test", api: "openai-completions",
    modelId: "assignment-test", baseUrl: "http://127.0.0.1:9999", credentialEnv: "",
    contextWindow: 16000, maxTokens: 512, reasoning: false, toolCalling: true, vision: false, revision: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  });
  const roleIds = ["assignment-orchestrator", "assignment-worker", "assignment-validator"];
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({
      id: `assignment-${kind}`, name: `Assignment ${kind}`, kind,
      instructions: "Remote assignment test role.", profileId: "remote-assignment-profile"
    });
  }
  const remoteRoot = `/remote-assignment-${uuid()}`;
  const enrolled = control.enrollMachine("assignment-node", "Assignment node");
  const session = control.nodeSession(enrolled.machine.id, enrolled.token, capabilities(remoteRoot), uuid());
  const probe = control.probeMachine(enrolled.machine.id, uuid(), remoteRoot);
  control.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  control.nodeEvent(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: remoteRoot, path: remoteRoot, isDirectory: true }
  });
  const remoteWorkspace = control.addRemoteWorkspace("Remote project", enrolled.machine.id, probe.id);
  const missionInput = {
    title: "Remote assignment mission", goal: "Test workspace assignment",
    acceptance: "Only allowed workspace assignments are accepted.",
    workspaceId: localWorkspace.id, roleIds, maxTurns: 10, maxCost: 1, autonomy: "trusted"
  };

  const withoutAssignments = control.createMission(missionInput);
  const emptyAssignments = control.createMission({ ...missionInput, remoteWorkspaceIds: [] });
  assert.equal(Object.hasOwn(withoutAssignments, "remoteWorkspaceIds"), false);
  assert.equal(Object.hasOwn(emptyAssignments, "remoteWorkspaceIds"), false);
  assert.throws(
    () => control.createMission({ ...missionInput, remoteWorkspaceIds: ["unknown-workspace"] }),
    (error) => error.status === 400
  );
  assert.throws(
    () => control.createMission({ ...missionInput, remoteWorkspaceIds: [localWorkspace.id] }),
    (error) => error.status === 409
  );
  assert.throws(
    () => control.createMission({ ...missionInput, remoteWorkspaceIds: [remoteWorkspace.id, remoteWorkspace.id] }),
    (error) => error.status === 400
  );
  assert.throws(
    () => control.createMission({ ...missionInput, remoteWorkspaceIds: "not-an-array" }),
    (error) => error.status === 400
  );
  assert.throws(
    () => control.createMission({ ...missionInput, remoteWorkspaceIds: [42] }),
    (error) => error.status === 400
  );
  assert.throws(
    () => control.createMission({ ...missionInput, remoteWorkspaceIds: ["   "] }),
    (error) => error.status === 400
  );

  const mission = control.createMission({ ...missionInput, remoteWorkspaceIds: [remoteWorkspace.id] });
  assert.deepEqual(mission.remoteWorkspaceIds, [remoteWorkspace.id]);
  const worktreeMission = control.createMission({
    ...missionInput, remoteWorkspaceIds: [remoteWorkspace.id], workspaceStrategy: "worktree"
  });
  const worktreeCounts = () => {
    const detail = control.detail(worktreeMission.id);
    return {
      agents: detail.agents.length, messages: detail.messages.length,
      events: detail.events.length, blockers: detail.blockers.length
    };
  };
  const unchangedWorktreeCounts = worktreeCounts();
  assert.throws(
    () => control.createAgent(
      worktreeMission.id, "Remote worktree worker", "assignment-worker", "", "remote-worktree-worker", remoteWorkspace.id
    ),
    (error) => error.status === 409 && error.message === "Remote worktrees are not supported yet"
  );
  assert.deepEqual(worktreeCounts(), unchangedWorktreeCounts);
  const started = control.missionAction(mission.id, "start");
  const orchestrator = control.getAgentPublic(started.orchestratorId);
  const request = (taskId, method, args) => control.workerCommand({
    id: taskId, token: "internal", agentId: orchestrator.id, epoch: orchestrator.epoch,
    method, args, taskId
  });
  const state = await request("remote-assignment-state", "GetMissionState", {});
  assert.deepEqual(state.remoteWorkspaces, [{
    id: remoteWorkspace.id, name: remoteWorkspace.name, machineId: remoteWorkspace.machineId,
    path: remoteWorkspace.path, executionEnabled: false
  }]);

  const missionCounts = () => {
    const detail = control.detail(mission.id);
    return {
      agents: detail.agents.length, messages: detail.messages.length,
      events: detail.events.length, blockers: detail.blockers.length
    };
  };
  const unlistedWorkspace = control.addWorkspace("Unlisted local workspace", workspacePath);
  const unchangedCounts = missionCounts();
  const spawnArgs = { title: "Remote worker", roleId: "assignment-worker", prompt: "Start the worker." };
  await assert.rejects(
    () => request("spawn-remote-worker", "SpawnAgent", { ...spawnArgs, targetWorkspaceId: remoteWorkspace.id }),
    (error) => error.status === 409 && /Remote execution is not enabled|metadata-only node session/.test(error.message)
  );
  assert.deepEqual(missionCounts(), unchangedCounts);
  await assert.rejects(
    () => request("spawn-unlisted-workspace", "SpawnAgent", { ...spawnArgs, targetWorkspaceId: unlistedWorkspace.id }),
    (error) => error.status === 409 && error.message === "Target workspace is not allowed for this Mission"
  );
  assert.deepEqual(missionCounts(), unchangedCounts);
  await assert.rejects(
    () => request("spawn-remote-validator", "SpawnAgent", {
      ...spawnArgs, roleId: "assignment-validator", targetWorkspaceId: remoteWorkspace.id
    }),
    (error) => error.status === 409 && error.message === "Remote targets are only available to worker agents"
  );
  assert.deepEqual(missionCounts(), unchangedCounts);
  await assert.rejects(
    () => request("spawn-invalid-target", "SpawnAgent", { ...spawnArgs, targetWorkspaceId: 42 }),
    (error) => error.status === 400 && error.message === "targetWorkspaceId must be a string"
  );
  assert.deepEqual(missionCounts(), unchangedCounts);

  const defaultAgent = await request("spawn-default-worker", "SpawnAgent", spawnArgs);
  assert.equal(defaultAgent.workspaceId, localWorkspace.id);
  assert.equal(defaultAgent.machineId, "local");
  const primaryAgent = await request("spawn-primary-worker", "SpawnAgent", {
    ...spawnArgs, targetWorkspaceId: localWorkspace.id
  });
  assert.equal(primaryAgent.workspaceId, localWorkspace.id);
  assert.equal(primaryAgent.machineId, "local");

  const forgedOriginal = control.createAgent(mission.id, "Forged remote worker", "assignment-worker", "", "forged-remote-worker");
  const forgedRemoteAgent = {
    ...forgedOriginal, machineId: remoteWorkspace.machineId, workspaceId: remoteWorkspace.id,
    workspacePath: localWorkspace.path
  };
  control.db.prepare("UPDATE agents SET data=? WHERE id=?").run(JSON.stringify(forgedRemoteAgent), forgedRemoteAgent.id);
  manager = new WorkerManager(control, true);
  await assert.rejects(
    () => manager.startAgent(forgedRemoteAgent),
    (error) => error.status === 409 && /Remote execution is not enabled|metadata-only node session/.test(error.message)
  );
  assert.equal(existsSync(join(control.home, "agents", `${forgedRemoteAgent.id}.sqlite`)), false);
});

test("failed, uncertain, expired and old-epoch probes cannot create a remote workspace", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-binding-fences-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const control = new ControlPlane(home);
  t.after(() => control.close());
  let now = Date.now();
  const registry = new MachineRegistry(control.db, () => now);
  const enrolled = registry.enroll("binding-fences", "Binding fences");
  const machineId = enrolled.machine.id;
  const session = registry.openSession(machineId, enrolled.token, capabilities(home), uuid());
  const failed = registry.enqueueProbe(machineId, uuid(), home);
  const unfinished = registry.enqueueProbe(machineId, uuid(), home);
  const completed = registry.enqueueProbe(machineId, uuid(), home);
  registry.poll(machineId, enrolled.token, session.sessionId, session.sessionEpoch, 10);
  registry.complete(machineId, enrolled.token, session.sessionId, session.sessionEpoch, failed.id, {
    ok: false, error: "probe path is outside a declared root"
  });
  registry.complete(machineId, enrolled.token, session.sessionId, session.sessionEpoch, completed.id, {
    ok: true, result: { requestedPath: home, path: home, isDirectory: true }
  });
  assert.throws(() => control.addRemoteWorkspace("failed", machineId, failed.id), /completed workspace probe/);
  now += 20_001;
  registry.expireLeases();
  assert.equal(registry.command(unfinished.id).status, "uncertain");
  assert.throws(() => control.addRemoteWorkspace("uncertain", machineId, unfinished.id), /completed workspace probe/);
  assert.throws(() => control.addRemoteWorkspace("expired", machineId, completed.id), /fresh workspace probe/);
  const next = registry.openSession(machineId, enrolled.token, capabilities(home), uuid());
  assert.ok(next.sessionEpoch > session.sessionEpoch);
  assert.throws(() => control.addRemoteWorkspace("old epoch", machineId, completed.id), /fresh workspace probe/);
  registry.revoke(machineId);
  assert.throws(() => control.addRemoteWorkspace("revoked", machineId, completed.id), /fresh workspace probe/);
  assert.equal(control.state().workspaces.length, 0);
});

test("administrator command history survives restart and paginates without losing uncertain evidence", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-history-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let service = await startServer({ home, port: 0 });
  t.after(() => service.close());
  const enrolled = service.control.enrollMachine("history-node", "History node");
  const session = service.control.nodeSession(enrolled.machine.id, enrolled.token, capabilities(home), uuid());
  const ids = [];
  for (let index = 0; index < 55; index += 1) {
    ids.push(service.control.probeMachine(enrolled.machine.id, uuid(), home).id);
  }
  service.control.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  await service.close();
  service = await startServer({ home, port: 0 });
  const adminToken = readFileSync(join(home, "admin.token"), "utf8").trim();
  const base = `http://127.0.0.1:${service.port}/api/machines/history-node/commands`;
  const get = (suffix = "", token = adminToken) => fetch(base + suffix, { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await get("", enrolled.token)).status, 401);
  const first = await (await get()).json();
  assert.equal(first.commands.length, 50);
  assert.ok(first.nextCursor);
  const second = await (await get(`?before=${first.nextCursor}`)).json();
  assert.equal(second.commands.length, 5);
  assert.equal(second.nextCursor, undefined);
  const all = [...first.commands, ...second.commands];
  assert.deepEqual(new Set(all.map((command) => command.id)), new Set(ids));
  assert.ok(all.some((command) => command.status === "uncertain"));
  assert.equal((await get("?before=invalid")).status, 400);
  assert.equal((await get(`?before=${uuid()}`)).status, 400);
});

test("separate node listener authenticates sessions but never exposes administrator bootstrap or APIs", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-listener-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const service = await startServer({ home, port: 0, nodePort: 0 });
  t.after(() => service.close());
  assert.ok(service.nodePort > 0);
  assert.notEqual(service.nodePort, service.port);
  const enrolled = service.control.enrollMachine("gateway-node", "Gateway node");
  const adminToken = readFileSync(join(home, "admin.token"), "utf8").trim();
  const base = `http://127.0.0.1:${service.nodePort}`;
  for (const path of ["/", "/app.js", "/api/bootstrap", "/api/state", "/api/health", "/api/machines", "/api/nodes/../bootstrap"]) {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("set-cookie"), null, path);
    assert.equal((await response.text()).includes(adminToken), false);
  }
  const body = JSON.stringify({ machineId: enrolled.machine.id, capabilities: capabilities(home), registrationId: uuid() });
  const post = (token) => fetch(`${base}/api/nodes/session`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body
  });
  assert.equal((await post(adminToken)).status, 401);
  const connected = await post(enrolled.token);
  assert.equal(connected.status, 200);
  assert.equal((await connected.json()).machine.id, enrolled.machine.id);
  const state = await (await fetch(`http://127.0.0.1:${service.port}/api/state`, {
    headers: { authorization: `Bearer ${adminToken}` }
  })).json();
  assert.equal(state.nodePort, service.nodePort);
});

test("node listener bind failure releases both listeners and coordinator ownership", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-bind-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  t.after(() => new Promise((done) => occupied.close(done)));
  await assert.rejects(startServer({ home, port: 0, nodePort: occupied.address().port }), { code: "EADDRINUSE" });
  const recovered = await startServer({ home, port: 0, nodePort: 0 });
  await recovered.close();
});

test("machine registry authenticates, deduplicates registration, and fences old sessions", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-machines-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const control = new ControlPlane(home);
  t.after(() => control.close());
  const enrolled = control.enrollMachine("node-a", "Node A");
  const registrationId = uuid();
  const first = control.nodeSession("node-a", enrolled.token, capabilities(home), registrationId);
  const duplicate = control.nodeSession("node-a", enrolled.token, capabilities(home), registrationId);
  assert.equal(duplicate.sessionId, first.sessionId);
  assert.equal(duplicate.machine.leaseExpiresAt, first.machine.leaseExpiresAt);
  assert.throws(() => control.nodeSession("node-a", enrolled.token, capabilities(home), uuid()), /lease/);
  assert.throws(() => control.nodeSession("node-a", enrolled.token, { ...capabilities(home), version: "different" }, registrationId), /capabilit|Registration/);
  const probe = control.probeMachine("node-a", uuid(), home);
  const polled = control.nodePoll("node-a", enrolled.token, first.sessionId, first.sessionEpoch);
  assert.equal(polled.commands[0].id, probe.id);
  assert.throws(() => control.nodeEvent("node-a", enrolled.token, first.sessionId, first.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: home, path: "/etc", isDirectory: true }
  }), /workspace probe result is invalid/);
  assert.throws(() => control.nodeEvent("node-a", enrolled.token, first.sessionId, first.sessionEpoch, probe.id, {
    ok: false, error: "ambient-secret-must-not-be-stored"
  }), /workspace probe error is invalid/);
  assert.equal(control.machineCommand("node-a", probe.id).status, "dispatched");
  const completed = control.nodeEvent("node-a", enrolled.token, first.sessionId, first.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: home, path: home, isDirectory: true }
  });
  assert.equal(completed.status, "completed");
  assert.deepEqual(control.nodeEvent("node-a", enrolled.token, first.sessionId, first.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: home, path: home, isDirectory: true }
  }), completed);
  assert.throws(() => control.nodeEvent("node-a", enrolled.token, first.sessionId, first.sessionEpoch, probe.id, {
    ok: false, error: "probe path does not exist"
  }), /different terminal result/);
  assert.throws(() => control.nodeEvent("node-a", enrolled.token, first.sessionId, first.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: home, path: `${home}/other`, isDirectory: true }
  }), /different terminal/);
});

test("injected-clock lifecycle commits expiry fencing, blocks registration replay, and isolates restart/revoke", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-machine-lifecycle-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const control = new ControlPlane(home);
  t.after(() => control.close());
  let now = Date.now();
  const registry = new MachineRegistry(control.db, () => now);
  const enrolled = registry.enroll("lifecycle-node", "Lifecycle Node");
  const registrationId = uuid();
  const session = registry.openSession("lifecycle-node", enrolled.token, capabilities(home), registrationId);
  const expiredCommand = registry.enqueueProbe("lifecycle-node", uuid(), home);
  registry.poll("lifecycle-node", enrolled.token, session.sessionId, session.sessionEpoch, 1);
  now += 20_001;
  assert.throws(() => registry.poll("lifecycle-node", enrolled.token, session.sessionId, session.sessionEpoch), /lease expired/);
  assert.equal(registry.get("lifecycle-node").status, "offline");
  assert.equal(control.machineCommand("lifecycle-node", expiredCommand.id).status, "uncertain");
  assert.throws(() => registry.openSession("lifecycle-node", enrolled.token, capabilities(home), registrationId), /Registration is no longer valid/);
  const fresh = registry.openSession("lifecycle-node", enrolled.token, capabilities(home), uuid());
  assert.ok(fresh.sessionEpoch > session.sessionEpoch);
  assert.notEqual(fresh.sessionId, session.sessionId);
  assert.throws(() => registry.complete("lifecycle-node", enrolled.token, session.sessionId, session.sessionEpoch, expiredCommand.id, {
    ok: true, result: { requestedPath: home, path: home, isDirectory: true }
  }), /fenced/);

  const eventEnrollment = registry.enroll("event-node", "Event Node");
  const eventSession = registry.openSession("event-node", eventEnrollment.token, capabilities(home), uuid());
  const expiredEvent = registry.enqueueProbe("event-node", uuid(), home);
  registry.poll("event-node", eventEnrollment.token, eventSession.sessionId, eventSession.sessionEpoch, 1);
  now += 20_001;
  assert.throws(() => registry.complete("event-node", eventEnrollment.token, eventSession.sessionId, eventSession.sessionEpoch, expiredEvent.id, {
    ok: true, result: { requestedPath: home, path: home, isDirectory: true }
  }), /lease expired/);
  assert.equal(control.machineCommand("event-node", expiredEvent.id).status, "uncertain");
  assert.equal(registry.get("event-node").status, "offline");
  const current = registry.openSession("lifecycle-node", enrolled.token, capabilities(home), uuid());

  const revokeDispatched = registry.enqueueProbe("lifecycle-node", uuid(), home);
  const revokeQueued = registry.enqueueProbe("lifecycle-node", uuid(), home);
  const revokePoll = registry.poll("lifecycle-node", enrolled.token, current.sessionId, current.sessionEpoch, 1);
  registry.revoke("lifecycle-node");
  const revokeClaimedId = revokePoll.commands[0].id;
  const revokeUnclaimedId = revokeClaimedId === revokeDispatched.id ? revokeQueued.id : revokeDispatched.id;
  assert.equal(control.machineCommand("lifecycle-node", revokeClaimedId).status, "uncertain");
  assert.equal(control.machineCommand("lifecycle-node", revokeUnclaimedId).status, "cancelled");

  const restartEnrollment = registry.enroll("restart-node", "Restart Node");
  const restartSession = registry.openSession("restart-node", restartEnrollment.token, capabilities(home), uuid());
  const dispatched = registry.enqueueProbe("restart-node", uuid(), home);
  const queued = registry.enqueueProbe("restart-node", uuid(), home);
  const restartPoll = registry.poll("restart-node", restartEnrollment.token, restartSession.sessionId, restartSession.sessionEpoch, 1);
  MachineRegistry.fenceOnCoordinatorStart(control.db, now);
  const restartClaimedId = restartPoll.commands[0].id;
  const restartUnclaimedId = restartClaimedId === dispatched.id ? queued.id : dispatched.id;
  assert.equal(control.machineCommand("restart-node", restartClaimedId).status, "uncertain");
  assert.equal(control.machineCommand("restart-node", restartUnclaimedId).status, "cancelled");
  assert.equal(registry.get("restart-node").status, "offline");
});

test("real HTTP node session and readonly probe persist a receipt", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-http-"));
  const root = join(home, "root");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(root);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const service = await startServer({ home, port: 0 });
  t.after(() => service.close());
  const adminToken = readFileSync(join(home, "admin.token"), "utf8").trim();
  const base = `http://127.0.0.1:${service.port}`;
  const post = (path, body, token, extraHeaders = {}) => fetch(`${base}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders }, body: JSON.stringify(body)
  });
  const enrollmentResponse = await post("/api/machines", { id: "node-http", name: "HTTP Node" }, adminToken);
  assert.equal(enrollmentResponse.status, 201);
  const enrolled = await enrollmentResponse.json();
  const nodeToken = enrolled.token;
  const registrationId = uuid();
  const sessionResponse = await post("/api/nodes/session", {
    machineId: "node-http", capabilities: capabilities(root), registrationId
  }, nodeToken);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(JSON.stringify(session).includes(nodeToken), false);
  const authBody = { machineId: "node-http", capabilities: capabilities(root), registrationId: uuid() };
  const wrong = await post("/api/nodes/session", authBody, "wrong-node-token");
  const unknown = await post("/api/nodes/session", { ...authBody, machineId: "absent-node" }, "wrong-node-token");
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, wrong.status);
  const wrongBody = await wrong.json();
  const unknownBody = await unknown.json();
  assert.deepEqual(wrongBody, unknownBody);
  assert.equal(JSON.stringify(wrongBody).includes(nodeToken), false);
  assert.equal(JSON.stringify(unknownBody).includes(nodeToken), false);
  const originBlocked = await post("/api/nodes/session", authBody, nodeToken, { origin: "https://attacker.example" });
  const cookieBlocked = await post("/api/nodes/session", authBody, nodeToken, { cookie: "session=browser" });
  assert.equal(originBlocked.status, 403);
  assert.equal(cookieBlocked.status, 403);
  const adminDenied = await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${nodeToken}` } });
  assert.equal(adminDenied.status, 401);
  const requestId = uuid();
  const probeResponse = await post("/api/machines/node-http/probe", { path: root, requestId }, adminToken);
  assert.equal(probeResponse.status, 202);
  const command = await probeResponse.json();
  const pollResponse = await post("/api/nodes/poll", { machineId: "node-http", sessionId: session.sessionId, sessionEpoch: session.sessionEpoch }, nodeToken);
  const polled = await pollResponse.json();
  assert.equal(polled.commands[0].id, command.id);
  const eventResponse = await post("/api/nodes/events", {
    machineId: "node-http", sessionId: session.sessionId, sessionEpoch: session.sessionEpoch,
    commandId: command.id, outcome: { ok: true, result: { requestedPath: root, path: root, isDirectory: true } }
  }, nodeToken);
  assert.equal(eventResponse.status, 200);
  const stored = await (await fetch(`${base}/api/machines/node-http/commands/${command.id}`, { headers: { authorization: `Bearer ${adminToken}` } })).json();
  assert.equal(stored.status, "completed");
  assert.equal(stored.result.isDirectory, true);
  const crossMachine = await fetch(`${base}/api/machines/other-node/commands/${command.id}`, { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(crossMachine.status, 404);
  assert.equal((await post("/api/state", {}, nodeToken)).status, 401);
  const nodeAdminError = await adminDenied.text();
  assert.equal(nodeAdminError.includes(nodeToken), false);
  assert.equal(JSON.stringify(service.control.state()).includes(nodeToken), false);
  for (const name of ["control.sqlite", "control.sqlite-wal"]) {
    const file = join(home, name);
    if (existsSync(file)) assert.equal(readFileSync(file).includes(Buffer.from(nodeToken)), false);
  }
});
