import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { DurableWorkerMailbox } from "../dist/worker-mailbox.js";
import { WorkerMailboxDispatcher } from "../dist/worker-mailbox-dispatcher.js";

const binding = {
  runtimeId: "dispatch-runtime",
  machineId: "dispatch-machine",
  sessionId: "dispatch-session",
  sessionEpoch: 1,
  agentId: "dispatch-agent",
  epoch: 1
};

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "worker-mailbox-dispatcher-"));
  const nodeDb = new DatabaseSync(join(home, "node.sqlite"));
  const coordinatorDb = new DatabaseSync(join(home, "coordinator.sqlite"));
  const node = new DurableWorkerMailbox(nodeDb, "node");
  const coordinator = new DurableWorkerMailbox(coordinatorDb, "coordinator");
  node.open(binding);
  coordinator.open(binding);
  t.after(() => {
    nodeDb.close();
    coordinatorDb.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { node, coordinator };
}

function receive(coordinator, node, payload, messageId) {
  const envelope = node.enqueue(binding, payload, messageId);
  coordinator.receive(binding, envelope);
  return envelope;
}

function options(mailbox, overrides = {}) {
  return {
    mailbox,
    isCurrent: () => true,
    canDispatch: () => true,
    rpc: async (_binding, request) => ({ kind: "reply", rpcId: request.rpcId, ok: true, result: { done: true } }),
    notice: () => {},
    ...overrides
  };
}

function controlFixture(autonomy = "trusted") {
  const home = mkdtempSync(join(tmpdir(), "worker-mailbox-guard-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const control = new ControlPlane(join(home, "state"));
  const profile = {
    id: "dispatcher-guard-profile", name: "Dispatcher guard", api: "openai-completions",
    modelId: "test", baseUrl: "http://127.0.0.1:9", credentialEnv: "", contextWindow: 16000,
    maxTokens: 128, reasoning: false, toolCalling: true, vision: false, revision: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  control.upsertProfile(profile);
  control.upsertRole({ id: "dispatcher-guard-orchestrator", name: "orchestrator", kind: "orchestrator", instructions: "", profileId: profile.id });
  control.upsertRole({ id: "dispatcher-guard-worker", name: "worker", kind: "worker", instructions: "", profileId: profile.id });
  control.upsertRole({ id: "dispatcher-guard-validator", name: "validator", kind: "validator", instructions: "", profileId: profile.id });
  const workspace = control.addWorkspace("dispatcher guard", workspacePath);
  const mission = control.createMission({
    title: "Dispatcher guard", goal: "Guard remote effects", acceptance: "No local effect",
    workspaceId: workspace.id, roleIds: ["dispatcher-guard-orchestrator", "dispatcher-guard-worker", "dispatcher-guard-validator"],
    maxTurns: 10, maxCost: 1, autonomy
  });
  control.missionAction(mission.id, "start");
  const agent = control.createAgent(mission.id, "worker", "dispatcher-guard-worker", "prompt", "create-worker");
  return { home, control, mission, agent, workspacePath };
}

function setRemote(control, agent) {
  const row = control.db.prepare("SELECT data FROM agents WHERE id=?").get(agent.id);
  const updated = { ...JSON.parse(row.data), machineId: "remote-guard-machine" };
  control.db.prepare("UPDATE agents SET data=? WHERE id=?").run(JSON.stringify(updated), agent.id);
}

function workerRequest(agent, method, args, taskId = `task-${method}`) {
  return { type: "rpc", id: `request-${taskId}`, token: "", agentId: agent.id, epoch: agent.epoch, method, args, taskId };
}

test("racing drains share one flight and durably reply after the callback settles", async (t) => {
  const { node, coordinator } = fixture(t);
  receive(coordinator, node, { kind: "rpc", rpcId: "rpc-race", taskId: "task-race", method: "GetMissionState", args: {} }, "uplink-race");
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const callbackGate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const dispatcher = new WorkerMailboxDispatcher(options(coordinator, {
    rpc: async (_binding, request) => {
      calls += 1;
      started();
      await callbackGate;
      return { kind: "reply", rpcId: request.rpcId, ok: true, result: { durable: true } };
    }
  }));

  const first = dispatcher.drain(binding);
  await startedPromise;
  assert.equal(dispatcher.drain(binding), first);
  let closed = false;
  const closing = dispatcher.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await Promise.all([first, closing]);
  assert.equal(calls, 1);
  assert.equal(closed, true);
  assert.equal(coordinator.inspectInbox(binding)[0].status, "applied");
  assert.equal(coordinator.pending(binding)[0].payload.rpcId, "rpc-race");
});

test("a stale in-flight callback and a rejected callback remain uncertain and are never replayed", async (t) => {
  const firstFixture = fixture(t);
  receive(firstFixture.coordinator, firstFixture.node,
    { kind: "rpc", rpcId: "rpc-stale", taskId: "task-stale", method: "CreateTask", args: {} }, "uplink-stale");
  let current = true;
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const callbackGate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const staleDispatcher = new WorkerMailboxDispatcher(options(firstFixture.coordinator, {
    isCurrent: () => current,
    rpc: async (_binding, request) => {
      calls += 1;
      started();
      await callbackGate;
      return { kind: "reply", rpcId: request.rpcId, ok: true, result: { stale: true } };
    }
  }));
  const flight = staleDispatcher.drain(binding);
  await startedPromise;
  current = false;
  release();
  await flight;
  assert.equal(firstFixture.coordinator.inspectBinding(binding).status, "uncertain");
  assert.equal(firstFixture.coordinator.inspectInbox(binding)[0].status, "uncertain");
  assert.equal(firstFixture.coordinator.inspectOutbox(binding).length, 0);
  await staleDispatcher.drain(binding);
  assert.equal(calls, 1);

  const secondFixture = fixture(t);
  receive(secondFixture.coordinator, secondFixture.node,
    { kind: "rpc", rpcId: "rpc-error", taskId: "task-error", method: "CreateTask", args: {} }, "uplink-error");
  let rejectedCalls = 0;
  const rejectingDispatcher = new WorkerMailboxDispatcher(options(secondFixture.coordinator, {
    rpc: async () => {
      rejectedCalls += 1;
      throw new Error("private exception text is never logged");
    }
  }));
  await rejectingDispatcher.drain(binding);
  await rejectingDispatcher.drain(binding);
  assert.equal(rejectedCalls, 1);
  assert.equal(secondFixture.coordinator.inspectBinding(binding).status, "uncertain");
  assert.equal(secondFixture.coordinator.inspectInbox(binding)[0].status, "uncertain");
  assert.equal(secondFixture.coordinator.inspectOutbox(binding).length, 0);
});

test("a closed notice does not confirm or release runtime ownership", async (t) => {
  const { node, coordinator } = fixture(t);
  receive(coordinator, node, {
    kind: "notice",
    notice: { type: "closed", agentId: binding.agentId, epoch: binding.epoch }
  }, "closed-notice");
  let observed = false;
  const dispatcher = new WorkerMailboxDispatcher(options(coordinator, {
    notice: (_binding, notice) => { observed = notice.type === "closed"; }
  }));
  await dispatcher.drain(binding);
  assert.equal(observed, true);
  assert.equal(coordinator.inspectBinding(binding).status, "open");
  assert.equal(coordinator.inspectInbox(binding)[0].status, "applied");
  assert.throws(() => coordinator.open({ ...binding, runtimeId: "replacement-runtime" }), /owner|owns this agent/i);
});

test("drainAll processes a bounded backlog across successive passes", async (t) => {
  const { node, coordinator } = fixture(t);
  for (let index = 0; index < 17; index += 1) {
    receive(coordinator, node, {
      kind: "notice",
      notice: { type: "ready", agentId: binding.agentId, epoch: binding.epoch }
    }, `backlog-${index}`);
  }
  let handled = 0;
  const dispatcher = new WorkerMailboxDispatcher(options(coordinator, {
    notice: () => { handled += 1; }
  }));
  await dispatcher.drainAll();
  assert.equal(handled, 16);
  assert.equal(coordinator.inspectInbox(binding).filter((row) => row.status === "received").length, 1);
  await dispatcher.drainAll();
  assert.equal(handled, 17);
  assert.equal(coordinator.inspectInbox(binding).every((row) => row.status === "applied"), true);
});

test("remote worker commands cannot reach filesystem, shell, or MCP effects", async () => {
  const f = controlFixture();
  const marker = join(f.workspacePath, "remote-effect-marker");
  try {
    setRemote(f.control, f.agent);
    for (const request of [
      workerRequest(f.agent, "write_file", { path: marker, content: "write" }),
      workerRequest(f.agent, "bash", { command: `printf shell > '${marker}'` }),
      workerRequest(f.agent, "CallMcpTool", { serverId: "missing", toolName: "mark", definitionHash: "missing", arguments: {} })
    ]) {
      await assert.rejects(() => f.control.workerCommand(request), (error) =>
        error?.status === 409 && error.message === "Remote operation is unavailable for this agent"
      );
    }
    assert.equal(existsSync(marker), false);
  } finally {
    f.control.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("an approved local effect remains approved when its agent becomes remote", async () => {
  const f = controlFixture("approve");
  const marker = join(f.workspacePath, "approved-remote-marker");
  try {
    const approval = await f.control.workerCommand(workerRequest(
      f.agent, "bash", { command: `printf approved > '${marker}'` }, "approved-effect"
    ));
    assert.equal(approval.status, "pending");
    f.control.resolveApproval(approval.id, "approved");
    setRemote(f.control, f.agent);
    await assert.rejects(() => f.control.executeApproved(approval.id), (error) =>
      error?.status === 409 && error.message === "Remote operation is unavailable for this agent"
    );
    assert.equal(f.control.db.prepare("SELECT status FROM approvals WHERE id=?").get(approval.id).status, "approved");
    assert.equal(existsSync(marker), false);
  } finally {
    f.control.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});
