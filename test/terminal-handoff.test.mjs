import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { test } from "node:test";
import { applyWorkerNotice } from "../dist/worker-events.js";
import { fixture } from "./fixtures/completion.mjs";

for (const terminal of ["completed", "cancelled"]) {
  for (const outcome of ["settled", "timeout"]) {
    test(`${terminal} keeps actual ${outcome} evidence when admission expires during terminal settlement`, async t => {
      const f = await fixture(t);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const extra = f.control.sendMessage(f.mission.id, f.agent.id, "Previously sent follow-up", "followUp", "unack-follow-up");
      const row = f.control.pendingOutbox().find(item => item.message_id === extra.id);
      assert.equal(f.control.markOutboxDispatching(row.id, f.agent.epoch), true);
      const clock = Date.now();
      // This delivery was sent 29 seconds ago; admission has not arrived.
      f.control.db.prepare("UPDATE outbox SET deadline_at=? WHERE id=?").run(clock + 1000, row.id);
      let stopping;
      if (terminal === "completed") {
        stopping = f.complete();
        await f.reply;
      } else {
        f.control.missionAction(f.mission.id, "cancel");
        stopping = f.workers.syncMissionLifecycle(f.mission.id);
      }
      await nextImmediate();
      const terminalDeadline = f.control.db.prepare("SELECT deadline_at FROM outbox WHERE id=?").get(row.id).deadline_at;
      t.mock.method(Date, "now", () => clock + 1001);
      await f.workers.dispatchPending(); // The server heartbeat uses this path.
      const afterHeartbeat = f.control.db.prepare("SELECT status,retry_count FROM outbox WHERE id=?").get(row.id);
      f.settle();
      if (outcome === "settled") f.notice({ type: "settled", messageId: extra.id, requestId: row.request_id,
        attempt: row.attempt, submissionId: "extra", status: "done", result: { status: "done" } });
      t.mock.timers.tick(5000);
      await stopping;
      assert.equal(f.control.message(extra.id).status, outcome === "settled" ? "completed" : "uncertain");
      assert.equal(terminalDeadline, null);
      assert.deepEqual({ ...afterHeartbeat }, { status: "dispatching", retry_count: 0 });
      assert.equal(f.control.missionById(f.mission.id).status, terminal);
      assert.deepEqual(f.control.blockers(f.mission.id).map(blocker => blocker.id),
        terminal === "cancelled" && outcome === "timeout" ? [`delivery:${row.id}`] : []);
      assert.equal(f.sent.some(message => message.type === "deliver"), false);
    });
  }

  test(`${terminal} legacy admission timeout cannot requeue a sent input`, async t => {
    const f = await fixture(t, { admitted: false, settleOnShutdown: false });
    // Model a terminal record written before completion cleared admission deadlines.
    f.control.db.prepare("UPDATE missions SET status=?,data=json_set(data,'$.status',?) WHERE id=?").run(terminal, terminal, f.mission.id);
    f.control.db.prepare("UPDATE outbox SET deadline_at=? WHERE id=?").run(Date.now() - 1, f.row.id);
    f.control.pendingOutbox();
    f.child.exitCode = 1;
    f.child.connected = false;
    f.child.emit("exit", 1);
    await f.workers.syncMissionLifecycle(f.mission.id);
    assert.equal(f.control.message(f.row.message_id).status, "uncertain");
    assert.equal(f.control.db.prepare("SELECT retry_count FROM outbox WHERE id=?").get(f.row.id).retry_count, 0);
    assert.equal(f.control.blockers(f.mission.id).length, terminal === "cancelled" ? 1 : 0);
  });
}

function installReplacement(f, deliveries) {
  f.workers.startAgentOnce = async agent => {
    if (agent.id !== f.agent.id) return;
    assert.notEqual(f.child.exitCode ?? f.child.signalCode, null, "The old process must exit before replacement");
    const owner = f.control.claimAgentOwner(agent.id);
    const child = new EventEmitter();
    Object.assign(child, { connected: true, exitCode: null, signalCode: null });
    child.send = (message, callback) => {
      callback(null);
      if (message.type === "deliver") {
        deliveries.push(message);
        assert.equal(f.control.ackOutbox(message.messageId, message.requestId, message.attempt, owner.epoch, "admitted"), true);
        applyWorkerNotice(f.control, owner, { type: "settled", agentId: owner.id, epoch: owner.epoch,
          messageId: message.messageId, requestId: message.requestId, attempt: message.attempt,
          submissionId: "answer", status: "done", result: { status: "done" } }, String);
      }
      if (message.type === "shutdown") {
        child.emit("message", { type: "closed", agentId: owner.id, epoch: owner.epoch });
        child.exitCode = 0;
        child.connected = false;
        child.emit("exit", 0);
      }
    };
    f.workers.handles.set(owner.id, { child, token: "replacement", epoch: owner.epoch, ready: Promise.resolve(), stopping: false });
  };
}

async function answeredQuestion(f) {
  const pausing = f.workers.onRpc(f.agent, f.handle, { type: "rpc", id: "question-rpc", token: f.handle.token,
    agentId: f.agent.id, epoch: f.agent.epoch, method: "RequestUserInput", args: { question: "Proceed?" }, taskId: "question" });
  const reply = await f.reply;
  await nextImmediate();
  f.control.resolveBlocker(reply.result.id, "Proceed with the next step");
  const answerId = `blocker-resolution:${reply.result.id}`;
  await f.workers.dispatchPending();
  assert.equal(f.control.message(answerId).status, "queued");
  f.settle();
  await nextImmediate();
  assert.equal(f.sent.some(message => message.type === "abort"), true);
  return { pausing, answerId };
}

for (const cancel of [false, true]) {
  test(`abort acknowledgement timeout ${cancel ? "does not deliver an answer after cancellation" : "delivers the queued answer once on a new epoch"}`, async t => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const send = f.child.send;
    f.child.send = (message, callback) => {
      if (message.type === "abort") { f.sent.push(message); callback(null); return; }
      send(message, callback);
    };
    const deliveries = [];
    installReplacement(f, deliveries);
    const { pausing, answerId } = await answeredQuestion(f);
    if (cancel) f.control.missionAction(f.mission.id, "cancel");
    t.mock.timers.tick(5000);
    await pausing;
    assert.equal(f.control.message(answerId).status, cancel ? "aborted" : "completed");
    assert.equal(f.control.missionById(f.mission.id).status, cancel ? "cancelled" : "active");
    assert.deepEqual(deliveries.map(message => message.messageId), cancel ? [] : [answerId]);
    if (!cancel) {
      assert.ok(deliveries[0].epoch > f.handle.epoch);
      assert.equal(deliveries[0].attempt, 1);
    }
    assert.equal(f.control.blockers(f.mission.id).some(blocker => blocker.status === "open"), false);
  });
}

test("unconfirmed old worker exit blocks the mission and retains the unsent answer", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const send = f.child.send;
  f.child.send = (message, callback) => {
    if (message.type === "abort" || message.type === "shutdown") { f.sent.push(message); callback(null); return; }
    send(message, callback);
  };
  f.child.kill = () => true; // Signals are accepted, but no exit is observed.
  const deliveries = [];
  installReplacement(f, deliveries);
  const { pausing, answerId } = await answeredQuestion(f);
  try {
    for (const ms of [5000, 5000, 1000, 2000]) { t.mock.timers.tick(ms); await nextImmediate(); }
    await pausing;
    assert.equal(f.control.missionById(f.mission.id).status, "blocked");
    assert.equal(f.control.message(answerId).status, "queued");
    assert.equal(f.control.message(answerId).attempt, 1);
    assert.equal(f.workers.handles.get(f.agent.id), f.handle, "Retain ownership of an unconfirmed process");
    assert.deepEqual(deliveries, []);
    const blockers = f.control.blockers(f.mission.id).filter(blocker => blocker.status === "open");
    assert.equal(blockers.length, 1);
    assert.match(blockers[0].text, /exit.*not.*confirmed/i);
    assert.ok(f.control.getAgentPublic(f.agent.id).epoch > f.agent.epoch);
    f.child.exitCode = 0;
    f.child.connected = false;
    f.child.emit("exit", 0);
    await f.workers.stopAgent(f.agent.id);
    f.control.resolveBlocker(blockers[0].id, "Confirmed the old process exited and inspected its workspace");
    assert.equal(f.control.missionById(f.mission.id).status, "paused");
    f.control.missionAction(f.mission.id, "resume");
    await f.workers.dispatchPending();
    assert.equal(f.control.message(answerId).status, "completed");
    assert.deepEqual(deliveries.map(message => message.messageId), [answerId]);
    assert.equal(deliveries[0].attempt, 1);
  } finally {
    f.child.exitCode = 0;
    f.child.connected = false;
    f.child.emit("exit", 0);
  }
});

for (const terminal of ["completed", "cancelled"]) {
  test(`${terminal} late delivery error cannot requeue a sent input`, async t => {
    const f = await fixture(t, { admitted: false, settleOnShutdown: false });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let stopping;
    if (terminal === "completed") {
      stopping = f.complete();
      await f.reply;
    } else {
      f.control.missionAction(f.mission.id, "cancel");
      stopping = f.workers.syncMissionLifecycle(f.mission.id);
    }
    await nextImmediate();
    f.notice({ type: "delivery_error", messageId: f.row.message_id, requestId: f.row.request_id,
      attempt: f.row.attempt, error: "Worker submission response was lost" });
    t.mock.timers.tick(5000);
    await stopping;
    assert.equal(f.control.message(f.row.message_id).status, "uncertain");
    assert.equal(f.control.db.prepare("SELECT retry_count FROM outbox WHERE id=?").get(f.row.id).retry_count, 0);
    assert.equal(f.control.blockers(f.mission.id).length, terminal === "cancelled" ? 1 : 0);
  });
}

for (const action of ["cancel", "close"]) {
  test(`${action} while waiting for a stopping worker prevents replacement startup`, async t => {
    const f = await fixture(t);
    const stopped = Promise.withResolvers();
    f.handle.stopping = true;
    t.mock.method(f.workers, "stopAgent", async () => {
      await stopped.promise;
      f.child.exitCode = 0;
      f.child.connected = false;
      f.workers.handles.delete(f.agent.id);
    });
    const prepare = t.mock.method(f.control, "prepareAgentWorkspace", () => assert.fail("Replacement startup must recheck lifecycle after the old worker exits"));
    const starting = f.workers.startAgent(f.agent);
    let closing;
    if (action === "cancel") f.control.missionAction(f.mission.id, "cancel");
    else closing = f.workers.close();
    stopped.resolve();
    await Promise.all([starting, closing]);
    assert.equal(prepare.mock.callCount(), 0);
    assert.equal(f.workers.handles.size, 0);
  });
}
