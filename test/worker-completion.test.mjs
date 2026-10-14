import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { applyWorkerNotice } from "../dist/worker-events.js";
import { WorkerManager } from "../dist/workers.js";

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "worker-completion-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const control = new ControlPlane(join(home, "state"));
  const workers = new WorkerManager(control);
  t.after(async () => {
    if (!control.closed) {
      await workers.close();
      control.close();
    }
    rmSync(home, { recursive: true, force: true });
  });
  control.upsertProfile({
    id: "completion-profile", name: "Completion test", api: "openai-completions", modelId: "faux-1",
    baseUrl: "http://127.0.0.1:9", credentialEnv: "", contextWindow: 16000, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false, revision: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  });
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: kind, name: kind, kind, instructions: "", profileId: "completion-profile" });
  }
  const workspace = control.addWorkspace("completion", workspacePath);
  const mission = control.createMission({
    title: "Completion race", goal: "Finish without interrupting the final submission", acceptance: "Delivery exists",
    workspaceId: workspace.id, roleIds: ["orchestrator", "worker", "validator"], maxTurns: 50, maxCost: 1, autonomy: "trusted"
  });
  const started = control.missionAction(mission.id, "start");
  const agent = control.getAgentPublic(started.orchestratorId);
  const owner = control.createAgent(mission.id, "Owner", "worker", "", "owner");
  const validator = control.createAgent(mission.id, "Validator", "validator", "", "validator");
  const task = control.createTask(agent.id, agent.epoch, "task", {
    missionId: mission.id, title: "Delivery", description: "", acceptance: "Delivery exists", dependencies: [],
    ownerId: owner.id, validatorId: validator.id, fulfills: ["REQ-001"]
  });
  control.updateTask(owner.id, owner.epoch, "running", task.id, { status: "running" });
  const path = join(workspacePath, "delivery.txt");
  writeFileSync(path, "ready");
  const artifact = control.publishArtifact(owner.id, owner.epoch, "publish", "Delivery", path, Buffer.from("ready"), task.id);
  control.updateTask(owner.id, owner.epoch, "review", task.id, { status: "review" });
  const receipt = await control.runValidation(validator.id, validator.epoch, "validate", { taskId: task.id, command: "test -f delivery.txt", artifactIds: [artifact.id] });
  control.validateTask(validator.id, validator.epoch, "accept", task.id, receipt.id, true, "Delivery exists",
    [{ assertionId: "REQ-001", status: "passed", evidence: "Independent command found the delivery" }]);
  const row = control.pendingOutbox().find((item) => control.message(item.message_id).recipientId === agent.id);
  assert.equal(control.markOutboxDispatching(row.id, agent.epoch), true);
  assert.equal(control.ackOutbox(row.message_id, row.request_id, row.attempt, agent.epoch, "admitted"), true);
  const child = new EventEmitter();
  Object.assign(child, { connected: true, exitCode: null, signalCode: null });
  let replied;
  const reply = new Promise((resolve) => { replied = resolve; });
  const sent = [];
  let settled = false;
  const notice = (body) => child.emit("message", { ...body, agentId: agent.id, epoch: agent.epoch });
  const settle = (status = "done", error) => {
    if (settled) return;
    settled = true;
    notice({ type: "settled", messageId: row.message_id, requestId: row.request_id, attempt: row.attempt,
      submissionId: "final-submission", status, ...(error ? { error } : { result: { status } }) });
  };
  child.on("message", (message) => applyWorkerNotice(control, agent, message, String));
  child.send = (message, callback) => {
    sent.push(message);
    callback(null);
    if (message.id) replied(message);
    if (message.type === "shutdown") {
      settle("unanswered", "Harness is closed");
      notice({ type: "closed" });
      child.exitCode = 0;
      child.connected = false;
      child.emit("exit", 0);
    }
    if (message.type === "abort") notice({ type: "aborted" });
  };
  const handle = { child, token: "completion-token", epoch: agent.epoch, ready: Promise.resolve(), stopping: false };
  workers.handles.set(agent.id, handle);
  const complete = () => workers.onRpc(agent, handle, {
    type: "rpc", id: "complete-rpc", token: handle.token, agentId: agent.id, epoch: agent.epoch,
    method: "CompleteMission", args: {}, taskId: "complete-mission"
  });
  return { home, control, workers, mission, agent, owner, row, child, handle, sent, reply, notice, settle, complete };
}

test("CompleteMission replies before submission settlement and shutdown waits for durable completion", async (t) => {
  const f = await fixture(t);
  const completing = f.complete();
  assert.equal((await f.reply).result.status, "completed");
  await nextImmediate();
  assert.equal(f.sent.some((message) => message.type === "shutdown"), false, "the final submission must be allowed to settle after the RPC reply");
  assert.equal(f.control.message(f.row.message_id).status, "admitted");
  f.notice({ type: "turn_end", turnId: "complete-turn" });
  await nextImmediate();
  assert.equal(f.sent.some((message) => message.type === "shutdown"), false, "turn_end alone is not submission settlement");
  f.settle();
  await completing;
  assert.equal(f.control.message(f.row.message_id).status, "completed");
  assert.equal(f.control.db.prepare("SELECT status,attempt FROM outbox WHERE id=?").get(f.row.id).status, "completed");
  assert.equal(f.sent.filter((message) => message.type === "shutdown").length, 1);
  assert.equal(f.workers.handles.has(f.agent.id), false);
  assert.equal(f.control.getAgentPublic(f.agent.id).epoch, f.agent.epoch + 1);
  assert.deepEqual(f.control.blockers(f.mission.id), []);
  assert.equal(f.control.exportMission(f.mission.id).events.some((event) => event.type === "delivery_uncertain"), false);
});

for (const terminal of ["completed", "cancelled"]) {
  test(`${terminal} shutdown deadline preserves uncertain evidence without pretending completion`, async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let stopping;
    if (terminal === "completed") {
      stopping = f.complete();
      await f.reply;
    } else {
      f.control.missionAction(f.mission.id, "cancel");
      assert.equal(f.control.message(f.row.message_id).status, "admitted");
      stopping = f.workers.syncMissionLifecycle(f.mission.id);
    }
    await nextImmediate();
    t.mock.timers.tick(4999);
    await nextImmediate();
    assert.equal(f.sent.some((message) => message.type === "shutdown"), false);
    t.mock.timers.tick(1);
    await stopping;
    const outbox = f.control.db.prepare("SELECT status,attempt,result FROM outbox WHERE id=?").get(f.row.id);
    assert.equal(outbox.status, "uncertain");
    assert.equal(outbox.attempt, 1);
    assert.match(outbox.result, /Harness is closed/);
    assert.equal(f.control.message(f.row.message_id).status, "uncertain");
    assert.equal(f.control.missionById(f.mission.id).status, terminal);
    assert.equal(f.control.blockers(f.mission.id).filter((blocker) => blocker.status === "open").length, terminal === "completed" ? 0 : 1);
    assert.equal(f.control.pendingOutbox().length, 0);
    assert.equal(f.sent.filter((message) => message.type === "shutdown").length, 1);
    assert.equal(f.child.listenerCount("message"), 1, "settlement and shutdown listeners are removed");
    assert.equal(f.child.listenerCount("exit"), 0);
    assert.match(f.control.getAgentPublic(f.agent.id).error, /5000 ms/);
    await f.workers.close();
    f.control.close();
    const reopened = new ControlPlane(join(f.home, "state"));
    try {
      assert.equal(reopened.message(f.row.message_id).status, "uncertain");
      assert.equal(reopened.blockers(f.mission.id).filter((blocker) => blocker.status === "open").length, terminal === "completed" ? 0 : 1);
    } finally {
      reopened.close();
    }
  });
}

test("cancellation drains the local submission and keeps remote interruption immediate", async (t) => {
  const f = await fixture(t);
  const message = f.control.sendMessage(f.mission.id, f.owner.id, "Remote input", "followUp", "remote-input");
  const remoteRow = f.control.pendingOutbox().find((row) => row.message_id === message.id);
  f.control.markOutboxDispatching(remoteRow.id, f.owner.epoch);
  f.control.ackOutbox(message.id, remoteRow.request_id, remoteRow.attempt, f.owner.epoch, "admitted");
  const data = f.control.db.prepare("SELECT data FROM agents WHERE id=?").get(f.owner.id);
  f.control.db.prepare("UPDATE agents SET data=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(data.data), machineId: "remote-test" }), f.owner.id);
  f.control.missionAction(f.mission.id, "cancel");
  assert.equal(f.control.message(f.row.message_id).status, "admitted");
  assert.equal(f.control.message(message.id).status, "uncertain");
  const stopping = f.workers.syncMissionLifecycle(f.mission.id);
  const concurrent = f.workers.stopMission(f.mission.id);
  await nextImmediate();
  assert.equal(f.sent.some((message) => message.type === "shutdown"), false);
  f.settle();
  await Promise.all([stopping, concurrent]);
  assert.equal(f.control.message(f.row.message_id).status, "completed");
  assert.equal(f.control.missionById(f.mission.id).status, "cancelled");
  assert.deepEqual(f.control.blockers(f.mission.id).map((blocker) => blocker.id), [`delivery:${remoteRow.id}`]);
  assert.equal(f.sent.filter((message) => message.type === "shutdown").length, 1);
  assert.equal(f.control.getAgentPublic(f.agent.id).epoch, f.agent.epoch + 1);
});

test("a terminal stop requires every local delivery to settle and ignores stale notices", async (t) => {
  const f = await fixture(t);
  const extra = f.control.sendMessage(f.mission.id, f.agent.id, "Already admitted follow-up", "followUp", "extra-input");
  const extraRow = f.control.pendingOutbox().find((row) => row.message_id === extra.id);
  f.control.markOutboxDispatching(extraRow.id, f.agent.epoch);
  f.control.ackOutbox(extra.id, extraRow.request_id, extraRow.attempt, f.agent.epoch, "admitted");
  const stopping = f.complete();
  await f.reply;
  await nextImmediate();
  const body = { type: "settled", messageId: extra.id, requestId: extraRow.request_id,
    attempt: extraRow.attempt, submissionId: "extra-submission", status: "done", result: { status: "done" } };
  f.child.emit("message", { ...body, agentId: f.agent.id, epoch: f.agent.epoch + 1 });
  f.notice({ ...body, requestId: "wrong-request" });
  f.settle();
  await nextImmediate();
  assert.equal(f.control.message(extra.id).status, "admitted");
  assert.equal(f.sent.some((message) => message.type === "shutdown"), false);
  f.notice(body);
  await stopping;
  assert.equal(f.control.message(extra.id).status, "completed");
  assert.deepEqual(f.control.blockers(f.mission.id), []);
  assert.equal(f.control.pendingOutbox().length, 0);
});

test("a worker exit during terminal settlement retains uncertainty without waiting for the deadline", async (t) => {
  const f = await fixture(t);
  const stopping = f.complete();
  await f.reply;
  await nextImmediate();
  f.child.exitCode = 1;
  f.child.connected = false;
  f.child.emit("exit", 1);
  await stopping;
  assert.equal(f.control.message(f.row.message_id).status, "uncertain");
  assert.equal(f.control.db.prepare("SELECT result FROM outbox WHERE id=?").get(f.row.id).result, null);
  assert.equal(f.sent.some((message) => message.type === "shutdown"), false);
  assert.deepEqual(f.control.blockers(f.mission.id), []);
  assert.equal(f.workers.handles.has(f.agent.id), false);
  assert.equal(f.child.listenerCount("exit"), 0);
  assert.match(f.control.getAgentPublic(f.agent.id).error, /worker exited/);
});

test("an unanswered terminal submission remains uncertain even when it settles within the grace period", async (t) => {
  const f = await fixture(t);
  const stopping = f.complete();
  await f.reply;
  await nextImmediate();
  f.settle("unanswered", "Submission failed independently of shutdown");
  await stopping;
  assert.equal(f.control.message(f.row.message_id).status, "uncertain");
  assert.match(f.control.db.prepare("SELECT result FROM outbox WHERE id=?").get(f.row.id).result, /failed independently/);
  assert.deepEqual(f.control.blockers(f.mission.id), []);
});

test("a terminal worker with no pending delivery closes immediately", async (t) => {
  const f = await fixture(t);
  f.settle();
  await f.complete();
  assert.equal(f.sent.filter((message) => message.type === "shutdown").length, 1);
  assert.equal(f.control.message(f.row.message_id).status, "completed");
  assert.deepEqual(f.control.blockers(f.mission.id), []);
});

test("pause still aborts immediately and records interrupted delivery blockers", async (t) => {
  const f = await fixture(t);
  f.control.missionAction(f.mission.id, "pause");
  await f.workers.pauseMission(f.mission.id);
  assert.deepEqual(f.sent.map((message) => message.type), ["abort", "shutdown"]);
  assert.equal(f.control.message(f.row.message_id).status, "uncertain");
  assert.equal(f.control.missionById(f.mission.id).status, "paused");
  assert.deepEqual(f.control.blockers(f.mission.id).map((blocker) => blocker.id), [`delivery:${f.row.id}`]);
});

test("RequestUserInput still replies before immediate blocked-mission interruption", async (t) => {
  const f = await fixture(t);
  const pausing = f.workers.onRpc(f.agent, f.handle, {
    type: "rpc", id: "question-rpc", token: f.handle.token, agentId: f.agent.id, epoch: f.agent.epoch,
    method: "RequestUserInput", args: { question: "Confirm the next step" }, taskId: "question"
  });
  const reply = await f.reply;
  assert.equal(reply.error, undefined);
  await pausing;
  assert.deepEqual(f.sent.map((message) => message.id ?? message.type), ["question-rpc", "abort", "shutdown"]);
  assert.equal(f.control.missionById(f.mission.id).status, "blocked");
  assert.equal(f.control.message(f.row.message_id).status, "uncertain");
  assert.equal(f.control.blockers(f.mission.id).filter((blocker) => blocker.status === "open").length, 2);
});
