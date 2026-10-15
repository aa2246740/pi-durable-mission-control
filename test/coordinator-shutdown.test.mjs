import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { startServer } from "../dist/server.js";
import { WorkerManager } from "../dist/workers.js";

async function fixture(t, remoteShutdownTimeoutMs = 2000) {
  const home = mkdtempSync(join(tmpdir(), "coordinator-shutdown-"));
  const service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0, remoteShutdownTimeoutMs });
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  const control = service.control;
  const root = join(home, "workspace");
  mkdirSync(root);
  const local = control.addWorkspace("Local", root);
  const enrolled = control.enrollMachine("shutdown-node", "Shutdown node");
  const capabilities = { protocol: 2, version: "test", platform: "linux", arch: "arm64", node: process.version,
    piDurable: "test", roots: [root], credentialRefs: [], executionEnabled: true, executionMode: "metadata-only" };
  const session = control.nodeSession(enrolled.machine.id, enrolled.token, capabilities, crypto.randomUUID());
  const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), root);
  control.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  control.nodeEvent(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, probe.id,
    { ok: true, result: { requestedPath: root, path: root, isDirectory: true } });
  const remote = control.addRemoteWorkspace("Remote", enrolled.machine.id, probe.id);
  control.upsertProfile({ id: "shutdown-profile", name: "Fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "http://127.0.0.1:1", credentialEnv: "", contextWindow: 4096, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false, revision: 1 });
  const roleIds = ["orchestrator", "worker", "validator"].map(kind => {
    const id = `shutdown-${kind}`;
    control.upsertRole({ id, name: kind, kind, instructions: "fixture", profileId: "shutdown-profile" });
    return id;
  });
  const mission = control.createMission({ title: "Shutdown", goal: "Stop safely", acceptance: "No replay",
    workspaceId: local.id, remoteWorkspaceIds: [remote.id], roleIds, maxTurns: 20, maxCost: 0,
    autonomy: "trusted", workspaceStrategy: "shared" });
  control.missionAction(mission.id, "start");
  const agent = control.createAgent(mission.id, "Remote worker", roleIds[1], "fixture", crypto.randomUUID(), remote.id);
  const assignment = control.assignRemoteRuntime(agent.id);
  control.remoteRuntimeReady(assignment.binding);
  const message = control.detail(mission.id).messages.find(item => item.recipientId === agent.id);
  const outbox = control.pendingOutbox().find(item => item.message_id === message.id);
  assert.equal(control.markOutboxDispatching(outbox.id, assignment.binding.epoch), true);
  assert.equal(control.ackOutbox(message.id, outbox.request_id, outbox.attempt, assignment.binding.epoch, "admitted"), true);
  const report = { reportId: crypto.randomUUID(), binding: assignment.binding, descriptorHash: assignment.descriptorHash,
    outcome: "stopped", stopReason: "requested" };
  return { service, control, home, enrolled, capabilities, session, mission, agent, assignment, message, outbox, report };
}

async function beginShutdown(f, viaHttp) {
  if (viaHttp) {
    const token = readFileSync(join(f.home, "control", "admin.token"), "utf8").trim();
    const response = await fetch(`http://127.0.0.1:${f.service.port}/api/daemon/stop`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "x-mission-control-daemon-id": f.control.daemonId }
    });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("connection"), "close");
    assert.equal(response.headers.get("cache-control"), "no-store");
    await response.arrayBuffer();
    assert.equal(f.control.missionById(f.mission.id).status, "paused", "The route must start shutdown before the test joins its close flight");
    assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_request_reason, "controlled");
  }
  return { closing: f.service.close() };
}

function reconnect(f, control) {
  return control.nodeSession(f.enrolled.machine.id, f.enrolled.token, f.capabilities, crypto.randomUUID());
}

function resolve(f, control) {
  for (const blocker of control.blockers(f.mission.id).filter(item => item.status === "open")) {
    control.resolveBlocker(blocker.id, "Inspected the old runtime, workspace and receipts; do not replay this delivery.");
  }
  control.missionAction(f.mission.id, "resume");
}

for (const viaHttp of [false, true]) {
  test(`normal server close keeps node reports reachable, preserves proof across restart and reassigns once without replay (${viaHttp ? "daemon stop route" : "service.close"})`, async t => {
    const f = await fixture(t);
    const adminToken = readFileSync(join(f.home, "control", "admin.token"), "utf8").trim();
    const received = new Promise(resolveRequest => f.service.server.once("request", resolveRequest));
    const slowRequest = httpRequest(`http://127.0.0.1:${f.service.port}/api/missions/${f.mission.id}/resume`, {
      method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json", "content-length": 2 }
    });
    const slowResponse = new Promise((resolveResponse, reject) => {
      slowRequest.on("response", response => { response.resume(); response.on("end", () => resolveResponse(response.statusCode)); });
      slowRequest.on("error", reject);
    });
    slowRequest.write("{");
    await received;
    const { closing } = await beginShutdown(f, viaHttp);
    slowRequest.end("}");
    assert.equal(await slowResponse, 503, "A request admitted before shutdown cannot mutate after its body arrives");
    assert.equal(f.service.close(), closing, "Concurrent close must share the shutdown flight");
    assert.equal(f.control.missionById(f.mission.id).status, "paused");
    assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_request_reason, "controlled");
    const mutation = await fetch(`http://127.0.0.1:${f.service.port}/api/missions/${f.mission.id}/resume`, {
      method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: "{}"
    });
    assert.equal(mutation.status, 503);
    await mutation.arrayBuffer();
    const response = await fetch(`http://127.0.0.1:${f.service.nodePort}/api/nodes/runtimes/events`, {
      method: "POST", headers: { authorization: `Bearer ${f.enrolled.token}`, "content-type": "application/json" },
      body: JSON.stringify({ machineId: f.enrolled.machine.id, sessionId: f.session.sessionId,
        sessionEpoch: f.session.sessionEpoch, ...f.report })
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    await closing;
    const control = new ControlPlane(join(f.home, "control"));
    try {
      reconnect(f, control);
      const old = control.remoteRuntimeForAgent(f.agent.id);
      assert.equal(old.state, "closed");
      assert.equal(old.stop_provenance, "controlled");
      assert.equal(control.detail(f.mission.id).events.some(event => event.type === "remote_runtime_uncertain"), false);
      assert.equal(control.detail(f.mission.id).events.some(event => event.type === "coordinator_stopping"), true);
      assert.equal(control.blockers(f.mission.id).find(item => item.id === `delivery:${f.outbox.id}`).status, "open");
      assert.throws(() => control.missionAction(f.mission.id, "resume"), /Resolve mission blockers/);
      const before = control.message(f.message.id);
      resolve(f, control);
      const next = control.assignRemoteRuntime(f.agent.id);
      assert.notEqual(next.binding.runtimeId, f.assignment.binding.runtimeId);
      assert.ok(next.binding.epoch > control.remoteRuntimes.byRuntime(f.assignment.binding.runtimeId).epoch);
      assert.equal(next.binding.machineId, f.assignment.binding.machineId);
      assert.equal(control.assignRemoteRuntime(f.agent.id).binding.runtimeId, next.binding.runtimeId);
      assert.equal(control.detail(f.mission.id).events.filter(event => event.type === "remote_runtime_reassigned").length, 1);
      assert.deepEqual(control.remoteRuntimes.byRuntime(f.assignment.binding.runtimeId), old);
      assert.deepEqual(control.message(f.message.id), before);
      assert.equal(control.pendingOutbox().some(item => item.id === f.outbox.id), false);
      assert.equal(control.workerMailbox.inspectOutbox(next.binding).length, 0);
      const notices = control.detail(f.mission.id).messages.filter(item => item.senderId === "system:coordinator");
      assert.equal(notices.length, 1);
      assert.equal(notices[0].id, `coordinator-resume:${f.assignment.binding.runtimeId}`);
      assert.equal(notices[0].attempt, 1);
      assert.equal(notices[0].recipientId, f.agent.id);
      assert.equal(notices[0].status, "queued");
      assert.equal(control.detail(f.mission.id).events.filter(event => event.type === "coordinator_resume_queued").length, 1);
    } finally { control.close(); }
  });
}

test("shutdown deadline without confirmation remains irrecoverable after a late stopped report and reconciliation", async t => {
  const f = await fixture(t, 100);
  const started = Date.now();
  await f.service.close();
  assert.ok(Date.now() - started < 3000, "Shutdown must not wait indefinitely for an offline node");
  const control = new ControlPlane(join(f.home, "control"));
  try {
    const session = reconnect(f, control);
    control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, session.sessionId, session.sessionEpoch, f.report);
    assert.equal(control.remoteRuntimeForAgent(f.agent.id).stop_provenance, "uncertain");
    assert.equal(control.detail(f.mission.id).events.some(event => event.type === "coordinator_stop_unconfirmed"), true);
    resolve(f, control);
    const workers = new WorkerManager(control);
    await assert.rejects(workers.startAgent(control.getAgentPublic(f.agent.id)), /uncertain/);
    assert.equal(control.missionById(f.mission.id).status, "failed");
    const failure = control.detail(f.mission.id).events.find(event => event.type === "worker_start_failed");
    assert.equal(failure.data.recoverable, false);
    assert.match(failure.data.reason, /^remote_runtime_/);
    assert.equal(control.remoteRuntimeSnapshots(f.mission.id).length, 1);
    assert.equal(control.message(f.message.id).attempt, 1);
  } finally { control.close(); }
});

test("shutdown preparation preserves local-only missions and already closed runtime missions", async t => {
  const f = await fixture(t);
  const localMission = f.control.createMission({ title: "Local only", goal: "Keep lifecycle", acceptance: "Unchanged",
    workspaceId: f.mission.workspaceId, roleIds: f.mission.roleIds, maxTurns: 20, maxCost: 0,
    autonomy: "trusted", workspaceStrategy: "shared" });
  f.control.missionAction(localMission.id, "start");
  f.control.requestRemoteRuntimeStop(f.agent.id);
  f.control.markAgentInterrupted(f.agent.id, f.assignment.binding.epoch, { controlledRemoteStop: true });
  f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, f.report);
  await f.service.close();
  const control = new ControlPlane(join(f.home, "control"));
  try {
    for (const missionId of [f.mission.id, localMission.id]) {
      assert.equal(control.missionById(missionId).status, missionId === localMission.id ? "active" : "blocked");
      assert.equal(control.detail(missionId).events.some(event => event.type === "coordinator_stopping"), false);
    }
  } finally { control.close(); }
});

for (const [missing, sql] of [
  ["request reason", "stop_request_reason=NULL"],
  ["request epoch", "stop_request_epoch=epoch-1"],
  ["report", "last_report_json=NULL"],
  ["node first stop reason", "last_report_json=json_remove(last_report_json,'$.stopReason')"],
  ["stopped outcome", "last_report_json=json_set(last_report_json,'$.outcome','uncertain')"]
]) {
  test(`restart refuses closed/controlled runtime with missing ${missing} evidence`, async t => {
    const f = await fixture(t);
    f.control.missionAction(f.mission.id, "pause");
    f.control.requestRemoteRuntimeStop(f.agent.id);
    f.control.markAgentInterrupted(f.agent.id, f.assignment.binding.epoch, { controlledRemoteStop: true });
    f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, f.report);
    f.control.db.prepare(`UPDATE remote_worker_runtimes SET ${sql} WHERE runtime_id=?`).run(f.assignment.binding.runtimeId);
    await f.service.close();
    const control = new ControlPlane(join(f.home, "control"));
    try {
      reconnect(f, control);
      assert.equal(control.confirmedRemoteRuntimeStop(f.assignment.binding.runtimeId), false);
      assert.equal(control.detail(f.mission.id).events.some(event => event.type === "remote_runtime_uncertain"), true);
      resolve(f, control);
      assert.throws(() => control.assignRemoteRuntime(f.agent.id), /controlled stop cannot be proven/);
      assert.equal(control.remoteRuntimeSnapshots(f.mission.id).length, 1);
      assert.equal(control.message(f.message.id).attempt, 1);
    } finally { control.close(); }
  });
}

for (const timeout of [0, -1, 0.5, NaN, 10001]) {
  test(`rejects invalid remote shutdown deadline ${timeout}`, async () => {
    await assert.rejects(startServer({ home: "unused", port: 0, remoteShutdownTimeoutMs: timeout }), /Remote shutdown timeout/);
  });
}


test("a first stop report processed after the persisted deadline is fenced before the timeout callback", async t => {
  const f = await fixture(t, 50);
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const closing = f.service.close();
  // Advance wall time without running the pending timeout. This is the exact
  // ordering produced when the event loop handles a late report first.
  clock += 112;
  f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, f.report);
  const confirmed = f.control.confirmedRemoteRuntimeStop(f.assignment.binding.runtimeId);
  await closing;
  assert.equal(confirmed, false, "A late report must not establish controlled stop proof");
  const control = new ControlPlane(join(f.home, "control"));
  try {
    reconnect(f, control);
    assert.equal(control.remoteRuntimeForAgent(f.agent.id).stop_request_reason, "ownership-lost");
    assert.equal(control.detail(f.mission.id).events.filter(event => event.type === "coordinator_stop_unconfirmed").length, 1);
    resolve(f, control);
    assert.throws(() => control.assignRemoteRuntime(f.agent.id), /uncertain/);
    assert.equal(control.remoteRuntimeSnapshots(f.mission.id).length, 1);
  } finally { control.close(); }
});

for (const viaHttp of [false, true]) {
  test(`remote confirmation waiting stops an unrelated local shell and MCP immediately (${viaHttp ? "daemon stop route" : "service.close"})`, async t => {
    const f = await fixture(t, 1000);
    const localMission = f.control.createMission({ title: "Local only", goal: "Stop immediately", acceptance: "No late write",
      workspaceId: f.mission.workspaceId, roleIds: f.mission.roleIds, maxTurns: 20, maxCost: 0,
      autonomy: "trusted", workspaceStrategy: "shared" });
    const started = f.control.missionAction(localMission.id, "start");
    const localAgent = f.control.getAgentPublic(started.orchestratorId);
    const child = new EventEmitter();
    Object.assign(child, { connected: true, exitCode: null, signalCode: null });
    child.send = (message, callback) => {
      callback(null);
      if (message.type === "shutdown") {
        child.emit("message", { type: "closed", agentId: localAgent.id, epoch: localAgent.epoch });
        child.exitCode = 0;
        child.connected = false;
        child.emit("exit", 0);
      }
    };
    f.service.workers.handles.set(localAgent.id, { child, token: "local", epoch: localAgent.epoch,
      ready: Promise.resolve(), stopping: false });
    const ready = join(localAgent.workspacePath, "shutdown-shell-ready");
    const marker = join(localAgent.workspacePath, "after-close-marker");
    const shell = f.control.workerCommand({ type: "rpc", id: "shutdown-shell", token: "", agentId: localAgent.id, epoch: localAgent.epoch,
      method: "bash", taskId: "shutdown-shell", args: {
        command: "printf ready > shutdown-shell-ready; sleep 0.2; printf late > after-close-marker"
      } });
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      assert.ok(Date.now() < deadline, "Shell did not start");
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    let mcpClosed = false;
    const closeMcp = f.control.mcpRuntime.close.bind(f.control.mcpRuntime);
    f.control.mcpRuntime.close = async () => { mcpClosed = true; await closeMcp(); };
    const { closing } = await beginShutdown(f, viaHttp);
    try {
      const result = await shell;
      assert.equal(result.exitCode, null, "Local shell must stop before its delayed write");
      assert.equal(existsSync(marker), false);
      assert.equal(mcpClosed, true);
      // Allow the local quiescence continuation after the real shell closes.
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
      assert.equal(child.connected, false, "Local worker must close while the remote report is still pending");
      assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).state, "stopping", "The node report must still be pending");
    } finally {
      f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, f.report);
      await closing;
    }
  });
}

for (const firstAt of [49, 50]) {
  test(`first shutdown confirmation at ${firstAt}ms keeps its deadline decision on retry and restart`, async t => {
    const f = await fixture(t, 50);
    const started = Date.now();
    let clock = started;
    t.mock.method(Date, "now", () => clock);
    const closing = f.service.close();
    const event = f.control.detail(f.mission.id).events.find(item => item.type === "coordinator_stopping");
    assert.equal(event.data.deadlineAt, started + 50);
    clock = started + firstAt;
    f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, f.report);
    clock = started + 112;
    f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, f.report);
    f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch,
      { ...f.report, reportId: crypto.randomUUID() });
    await closing;
    const control = new ControlPlane(join(f.home, "control"));
    try {
      reconnect(f, control);
      assert.equal(control.confirmedRemoteRuntimeStop(f.assignment.binding.runtimeId), firstAt < 50);
      resolve(f, control);
      if (firstAt < 50) assert.notEqual(control.assignRemoteRuntime(f.agent.id).binding.runtimeId, f.assignment.binding.runtimeId);
      else assert.throws(() => control.assignRemoteRuntime(f.agent.id), /uncertain/);
    } finally { control.close(); }
  });
}

test("an already paused Mission also persists and enforces the shutdown deadline", async t => {
  const f = await fixture(t, 50);
  f.control.missionAction(f.mission.id, "pause");
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const closing = f.service.close();
  clock += 112;
  f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, f.report);
  assert.equal(f.control.confirmedRemoteRuntimeStop(f.assignment.binding.runtimeId), false);
  const events = f.control.detail(f.mission.id).events;
  assert.equal(events.some(event => event.type === "coordinator_stopping"), false, "Do not change recovery notification eligibility");
  assert.equal(events.find(event => event.type === "coordinator_stop_waiting").data.deadlineAt, clock - 62);
  await closing;
});

test("shutdown allows node stop evidence and administrator reads while rejecting new business uploads", async t => {
  const f = await fixture(t);
  const adminToken = readFileSync(join(f.home, "control", "admin.token"), "utf8").trim();
  const appliedEnvelope = { binding: f.assignment.binding, messageId: "applied-before-shutdown", sequence: 1,
    payload: { kind: "rpc", rpcId: "read-before-shutdown", taskId: `${f.agent.id}:shutdown-read`, method: "GetMissionState", args: {} } };
  const uploaded = await fetch(`http://127.0.0.1:${f.service.nodePort}/api/nodes/mailbox/upload`, {
    method: "POST", headers: { authorization: `Bearer ${f.enrolled.token}`, "content-type": "application/json" },
    body: JSON.stringify({ machineId: f.enrolled.machine.id, sessionId: f.session.sessionId,
      sessionEpoch: f.session.sessionEpoch, binding: f.assignment.binding, envelope: appliedEnvelope })
  });
  assert.equal(uploaded.status, 200);
  const appliedReceipt = await uploaded.json();
  const until = Date.now() + 1000;
  while (f.control.workerMailbox.inspectInbox(f.assignment.binding)[0]?.status !== "applied" && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(f.control.workerMailbox.inspectInbox(f.assignment.binding)[0].status, "applied");
  const unappliedReceipt = f.control.nodeWorkerUpload(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId,
    f.session.sessionEpoch, f.assignment.binding, { ...appliedEnvelope, messageId: "unapplied-before-shutdown", sequence: 2,
      payload: { ...appliedEnvelope.payload, rpcId: "not-applied" } });
  const closing = f.service.close();
  const read = await fetch(`http://127.0.0.1:${f.service.port}/api/missions/${f.mission.id}`, {
    headers: { authorization: `Bearer ${adminToken}` }
  });
  assert.equal(read.status, 200);
  await read.arrayBuffer();
  const identity = { machineId: f.enrolled.machine.id, sessionId: f.session.sessionId,
    sessionEpoch: f.session.sessionEpoch, binding: f.assignment.binding };
  const inbox = f.control.workerMailbox.inspectInbox(f.assignment.binding);
  const outbox = f.control.workerMailbox.inspectOutbox(f.assignment.binding);
  for (const path of ["mailbox/upload", "mailbox/poll", "mailbox/ack", "artifacts/chunk", "artifacts/complete"]) {
    const response = await fetch(`http://127.0.0.1:${f.service.nodePort}/api/nodes/${path}`, {
      method: "POST", headers: { authorization: `Bearer ${f.enrolled.token}`, "content-type": "application/json" },
      body: JSON.stringify(identity)
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { error: "Coordinator is shutting down", ...(path.startsWith("mailbox/") ? { code: "coordinator_shutting_down" } : {}) });
    assert.equal("envelopes" in body || "acknowledged" in body || "recorded" in body, false,
      "Legacy nodes must receive failure, never successful settlement or stop evidence");
  }
  assert.deepEqual(f.control.workerMailbox.inspectInbox(f.assignment.binding), inbox);
  assert.deepEqual(f.control.workerMailbox.inspectOutbox(f.assignment.binding), outbox);
  const settlement = await fetch(`http://127.0.0.1:${f.service.nodePort}/api/nodes/mailbox/settlement`, {
    method: "POST", headers: { authorization: `Bearer ${f.enrolled.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...identity, entries: [appliedReceipt, unappliedReceipt] })
  });
  assert.equal(settlement.status, 200);
  assert.deepEqual(await settlement.json(), { entries: [{ ...appliedReceipt, applied: true }, { ...unappliedReceipt, applied: false }] });
  const stops = await fetch(`http://127.0.0.1:${f.service.nodePort}/api/nodes/runtimes/poll`, {
    method: "POST", headers: { authorization: `Bearer ${f.enrolled.token}`, "content-type": "application/json" },
    body: JSON.stringify({ machineId: f.enrolled.machine.id, sessionId: f.session.sessionId, sessionEpoch: f.session.sessionEpoch })
  });
  assert.equal(stops.status, 200);
  assert.deepEqual(await stops.json(), { directives: [{ action: "stop", binding: f.assignment.binding, descriptorHash: f.assignment.descriptorHash }] });
  const unauthenticated = await fetch(`http://127.0.0.1:${f.service.nodePort}/api/nodes/mailbox/poll`, {
    method: "POST", headers: { authorization: "Bearer invalid-token", "content-type": "application/json" }, body: JSON.stringify(identity)
  });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: "Node authentication failed" });
  const result = await fetch(`http://127.0.0.1:${f.service.nodePort}/api/nodes/runtimes/events`, {
    method: "POST", headers: { authorization: `Bearer ${f.enrolled.token}`, "content-type": "application/json" },
    body: JSON.stringify({ machineId: f.enrolled.machine.id, sessionId: f.session.sessionId,
      sessionEpoch: f.session.sessionEpoch, ...f.report })
  });
  assert.equal(result.status, 200);
  await result.arrayBuffer();
  await closing;
});
