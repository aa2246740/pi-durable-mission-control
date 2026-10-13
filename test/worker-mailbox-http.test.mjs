import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../dist/server.js";
import { DurableWorkerMailbox } from "../dist/worker-mailbox.js";
import { exchangeWorkerMailbox } from "../dist/node.js";

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "mc-mailbox-http-"));
  const service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0 });
  const control = service.control;
  const enrolled = control.enrollMachine("transport-node", "Transport fixture");
  const session = control.nodeSession(enrolled.machine.id, enrolled.token, {
    protocol: 1, version: "test", platform: "linux", arch: "arm64",
    node: process.version, piDurable: "1.1.0", roots: ["/remote-fixture"], credentialRefs: [], executionEnabled: false
  }, crypto.randomUUID());
  const binding = {
    runtimeId: "transport-runtime", machineId: enrolled.machine.id,
    sessionId: session.sessionId, sessionEpoch: session.sessionEpoch, agentId: "transport-agent", epoch: 1
  };
  // Transport fixture only: no remote process or model is started.
  const agent = { id: binding.agentId, missionId: "transport-mission", machineId: binding.machineId, epoch: 1, status: "idle" };
  control.db.prepare("INSERT INTO agents(id,mission_id,status,epoch,data) VALUES(?,?,?,?,?)").run(agent.id, agent.missionId, agent.status, agent.epoch, JSON.stringify(agent));
  control.workerMailbox.open(binding);
  const nodeDb = new DatabaseSync(join(home, "node.sqlite"));
  const node = new DurableWorkerMailbox(nodeDb, "node");
  node.open(binding);
  let serviceClosed = false;
  const closeService = async () => {
    if (serviceClosed) return;
    serviceClosed = true;
    await service.close();
  };
  t.after(async () => { nodeDb.close(); await closeService(); rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${service.nodePort}`;
  const identity = { machineId: binding.machineId, sessionId: binding.sessionId, sessionEpoch: binding.sessionEpoch, binding };
  const post = (action, extra = {}, token = enrolled.token, headers = {}) => fetch(`${base}/api/nodes/mailbox/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ ...identity, ...extra })
  });
  return { home, service, workers: service.workers, closeService, control, binding, agent, nodeDb, node, base, identity, post, token: enrolled.token };
}

test("HTTP mailbox persists uplink before application and durable reply reaches the separate node store", async (t) => {
  const f = await fixture(t);
  const envelope = f.node.enqueue(f.binding, { kind: "rpc", rpcId: "rpc-1", taskId: "task-1", method: "GetMissionState", args: {} });
  await exchangeWorkerMailbox(f.base, f.token, f.node, f.binding);
  assert.equal(f.node.inspectOutbox(f.binding)[0].status, "acknowledged");
  assert.equal(f.control.workerMailbox.inspectInbox(f.binding)[0].status, "received");
  assert.deepEqual(f.control.workerMailbox.claim(f.binding, envelope.messageId), envelope);
  f.control.workerMailbox.finishWithReply(f.binding, envelope.messageId, { kind: "reply", rpcId: "rpc-1", ok: true, result: { retained: true } });
  await exchangeWorkerMailbox(f.base, f.token, f.node, f.binding);
  assert.equal(f.control.workerMailbox.inspectOutbox(f.binding)[0].status, "acknowledged");
  assert.equal(f.node.inspectInbox(f.binding)[0].status, "received");
  assert.deepEqual(f.node.received(f.binding)[0].payload.result, Object.assign(Object.create(null), { retained: true }));
});

test("lost upload receipt and downlink ACK retransmit without duplicate application", async (t) => {
  const f = await fixture(t);
  const envelope = f.node.enqueue(f.binding, { kind: "notice", notice: { type: "ready", agentId: f.binding.agentId, epoch: 1 } });
  f.node.pending(f.binding);
  const first = await f.post("upload", { envelope });
  assert.equal(first.status, 200);
  const receipt = await first.json();
  const second = await f.post("upload", { envelope });
  assert.deepEqual(await second.json(), receipt);
  assert.equal(f.control.workerMailbox.inspectInbox(f.binding).length, 1);
  f.control.workerMailbox.enqueue(f.binding, { kind: "abort" });
  const polled = await (await f.post("poll")).json();
  assert.equal(polled.envelopes.length, 1);
  f.node.receive(f.binding, polled.envelopes[0]);
  await exchangeWorkerMailbox(f.base, f.token, f.node, f.binding);
  assert.equal(f.node.inspectInbox(f.binding).length, 1);
  assert.equal(f.node.inspectInbox(f.binding)[0].status, "received");
  assert.equal(f.control.workerMailbox.inspectOutbox(f.binding)[0].status, "acknowledged");
});

test("HTTP mailbox rejects unauthenticated, misbound, forged and malformed traffic without claiming work", async (t) => {
  const f = await fixture(t);
  f.control.workerMailbox.enqueue(f.binding, { kind: "abort" });
  const admin = readFileSync(join(f.home, "control", "admin.token"), "utf8").trim();
  for (const token of ["invalid", admin]) assert.equal((await f.post("poll", {}, token)).status, 401);
  assert.equal((await f.post("poll", {}, f.token, { origin: f.base })).status, 403);
  assert.equal((await f.post("poll", {}, f.token, { cookie: "x=1" })).status, 403);
  assert.equal((await f.post("poll", { binding: { ...f.binding, machineId: "another" } })).status, 403);
  assert.equal((await f.post("poll", { binding: { ...f.binding, runtimeId: "self-enrolled" } })).status, 409);
  assert.equal((await f.post("poll", { binding: { ...f.binding, epoch: 2 } })).status, 409);
  assert.equal((await f.post("poll", { binding: { ...f.binding, extra: true } })).status, 400);
  assert.equal((await f.post("poll", { sessionEpoch: Number.MAX_SAFE_INTEGER + 1 })).status, 400);
  assert.equal((await f.post("poll", { extra: true })).status, 400);
  assert.equal((await f.post("upload", { envelope: { bad: true } })).status, 409);
  assert.equal((await f.post("ack", { receipt: { messageId: "fake", sequence: 1, sha256: "a".repeat(64), extra: true } })).status, 400);
  assert.equal(f.control.workerMailbox.inspectOutbox(f.binding)[0].status, "queued");
  assert.equal(f.control.workerMailbox.inspectInbox(f.binding).length, 0);
  assert.equal((await fetch(f.base + "/api/bootstrap", { headers: { authorization: `Bearer ${f.token}` } })).status, 404);
});

test("expired lease fences offered and processing messages, preserving uncertain ownership", async (t) => {
  const f = await fixture(t);
  const envelope = f.node.enqueue(f.binding, { kind: "rpc", rpcId: "rpc", taskId: "task", method: "bash", args: { command: "must-not-run" } });
  await exchangeWorkerMailbox(f.base, f.token, f.node, f.binding);
  f.control.workerMailbox.claim(f.binding, envelope.messageId);
  f.control.workerMailbox.enqueue(f.binding, { kind: "abort" });
  assert.equal((await f.post("poll")).status, 200);
  const machine = f.control.machineRegistry.get(f.binding.machineId);
  machine.leaseExpiresAt = Date.now() - 1;
  f.control.db.prepare("UPDATE remote_machines SET data=? WHERE id=?").run(JSON.stringify(machine), machine.id);
  assert.equal((await f.post("poll")).status, 409);
  f.control.heartbeat();
  assert.equal(f.control.workerMailbox.inspectBinding(f.binding).status, "uncertain");
  assert.equal(f.control.workerMailbox.inspectInbox(f.binding)[0].status, "uncertain");
  assert.equal(f.control.workerMailbox.inspectOutbox(f.binding)[0].status, "uncertain");
  assert.throws(() => f.control.workerMailbox.open({ ...f.binding, runtimeId: "replacement" }), /uncertain|owner|runtime/i);
});

test("coordinator restart retains mailbox evidence but never reoffers old runtime traffic", async (t) => {
  const f = await fixture(t);
  f.control.workerMailbox.enqueue(f.binding, { kind: "abort" });
  assert.equal((await f.post("poll")).status, 200);
  await f.closeService();
  const reopened = await startServer({ home: join(f.home, "control"), port: 0, nodePort: 0 });
  try {
    assert.equal(reopened.control.workerMailbox.inspectBinding(f.binding).status, "uncertain");
    assert.equal(reopened.control.workerMailbox.inspectOutbox(f.binding)[0].status, "uncertain");
    const result = await fetch(`http://127.0.0.1:${reopened.nodePort}/api/nodes/mailbox/poll`, {
      method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" }, body: JSON.stringify(f.identity)
    });
    assert.equal(result.status, 409);
  } finally { await reopened.close(); }
});

test("revocation and stale agent epochs fence bindings before mailbox traffic is accepted", async (t) => {
  const f = await fixture(t);
  f.control.workerMailbox.enqueue(f.binding, { kind: "abort" });
  f.agent.epoch += 1;
  f.control.db.prepare("UPDATE agents SET epoch=?,data=? WHERE id=?").run(f.agent.epoch, JSON.stringify(f.agent), f.agent.id);
  assert.equal((await f.post("poll")).status, 409);
  assert.equal(f.control.workerMailbox.inspectBinding(f.binding).status, "uncertain");
  assert.equal(f.control.workerMailbox.inspectOutbox(f.binding)[0].status, "cancelled");
  f.control.revokeMachine(f.binding.machineId);
  assert.equal((await f.post("poll")).status, 401);
  assert.equal(f.control.workerMailbox.inspectOutbox(f.binding)[0].status, "cancelled");
});

test("node upload returns before an execution-enabled test handler settles", async (t) => {
  const f = await fixture(t);
  const workspacePath = join(f.home, "workspace");
  mkdirSync(workspacePath);
  const profile = {
    id: "mailbox-held-profile", name: "Held handler", api: "openai-completions", modelId: "test",
    baseUrl: "http://127.0.0.1:9", credentialEnv: "", contextWindow: 16000, maxTokens: 128,
    reasoning: false, toolCalling: true, vision: false, revision: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  f.control.upsertProfile(profile);
  f.control.upsertRole({ id: "mailbox-held-orchestrator", name: "orchestrator", kind: "orchestrator", instructions: "", profileId: profile.id });
  f.control.upsertRole({ id: "mailbox-held-worker", name: "worker", kind: "worker", instructions: "", profileId: profile.id });
  f.control.upsertRole({ id: "mailbox-held-validator", name: "validator", kind: "validator", instructions: "", profileId: profile.id });
  const workspace = f.control.addWorkspace("held handler", workspacePath);
  const mission = f.control.createMission({
    title: "Held handler", goal: "Prove async upload", acceptance: "Receipt precedes handler completion",
    workspaceId: workspace.id,
    roleIds: ["mailbox-held-orchestrator", "mailbox-held-worker", "mailbox-held-validator"],
    maxTurns: 3, maxCost: 1, autonomy: "trusted"
  });
  const startedMission = f.control.missionAction(mission.id, "start");
  const orchestrator = f.control.getAgentPublic(startedMission.orchestratorId);
  const machine = f.control.machineRegistry.get(f.binding.machineId);
  machine.capabilities = { ...machine.capabilities, executionEnabled: true };
  f.control.db.prepare("UPDATE remote_machines SET data=? WHERE id=?").run(JSON.stringify(machine), machine.id);
  const row = f.control.db.prepare("SELECT data FROM agents WHERE id=?").get(orchestrator.id);
  const remoteAgent = { ...JSON.parse(row.data), machineId: f.binding.machineId };
  f.control.db.prepare("UPDATE agents SET data=? WHERE id=?").run(JSON.stringify(remoteAgent), orchestrator.id);
  const heldBinding = {
    ...f.binding, runtimeId: "held-runtime", agentId: orchestrator.id, epoch: orchestrator.epoch
  };
  f.control.workerMailbox.open(heldBinding);
  f.node.open(heldBinding);
  const heldIdentity = {
    machineId: heldBinding.machineId, sessionId: heldBinding.sessionId,
    sessionEpoch: heldBinding.sessionEpoch, binding: heldBinding
  };
  const heldPost = (action, extra = {}) => fetch(`${f.base}/api/nodes/mailbox/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...heldIdentity, ...extra })
  });
  let release;
  let startedResolve;
  let finishedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const finished = new Promise((resolve) => { finishedResolve = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let releaseLifecycle;
  const lifecycleGate = new Promise((resolve) => { releaseLifecycle = resolve; });
  let lifecycleStartedResolve;
  const lifecycleStarted = new Promise((resolve) => { lifecycleStartedResolve = resolve; });
  const lifecycleCalls = [];
  const originalLifecycleSync = f.workers.syncMissionLifecycle.bind(f.workers);
  f.workers.syncMissionLifecycle = async (missionId) => {
    lifecycleCalls.push(missionId);
    lifecycleStartedResolve();
    if (lifecycleCalls.length === 2) throw new Error("private lifecycle failure detail");
    await lifecycleGate;
    await originalLifecycleSync(missionId);
  };
  const originalWorkerCommand = f.control.workerCommand.bind(f.control);
  f.control.workerCommand = async (request) => {
    startedResolve();
    await gate;
    const result = await originalWorkerCommand(request);
    finishedResolve();
    return result;
  };
  try {
    const envelope = f.node.enqueue(heldBinding, {
      kind: "rpc", rpcId: "held-rpc", taskId: "held-task", method: "GetMissionState", args: {}
    });
    const uploaded = await heldPost("upload", { envelope });
    assert.equal(uploaded.status, 200);
    await started;
    let settled = false;
    finished.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    await finished;
    let downlink;
    for (let attempt = 0; attempt < 32 && !downlink; attempt += 1) {
      const polled = await heldPost("poll");
      const body = await polled.json();
      downlink = body.envelopes[0];
      if (!downlink) await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(downlink);
    assert.equal(downlink.payload.kind, "reply");
    assert.equal(downlink.payload.rpcId, "held-rpc");
    await lifecycleStarted;
    assert.deepEqual(lifecycleCalls, [mission.id]);
    const replyReceipt = f.node.receive(heldBinding, downlink);
    assert.equal((await heldPost("ack", { receipt: replyReceipt })).status, 200);

    const rejected = f.node.enqueue(heldBinding, {
      kind: "rpc", rpcId: "held-rejected-rpc", taskId: "held-rejected-task", method: "UnknownRemoteMethod", args: {}
    });
    assert.equal((await heldPost("upload", { envelope: rejected })).status, 200);
    let rejectedReply;
    for (let attempt = 0; attempt < 32 && !rejectedReply; attempt += 1) {
      const polled = await heldPost("poll");
      const body = await polled.json();
      rejectedReply = body.envelopes[0];
      if (!rejectedReply) await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(rejectedReply);
    assert.equal(rejectedReply.payload.ok, false);
    for (let attempt = 0; attempt < 32 && lifecycleCalls.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(lifecycleCalls, [mission.id, mission.id]);
    assert.equal(f.control.getAgentPublic(orchestrator.id).error, "Worker lifecycle synchronization failed");
  } finally {
    releaseLifecycle();
  }
});
