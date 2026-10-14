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

function installPeer(f, { stuck = false } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { connected: true, exitCode: null, signalCode: null });
  const sent = [];
  child.send = (message, callback) => {
    sent.push(message.type);
    callback(null);
    if (stuck) return;
    if (message.type === "abort") child.emit("message", { type: "aborted", agentId: f.owner.id, epoch: f.owner.epoch });
    if (message.type === "shutdown") {
      child.emit("message", { type: "closed", agentId: f.owner.id, epoch: f.owner.epoch });
      child.exitCode = 0;
      child.connected = false;
      child.emit("exit", 0);
    }
  };
  child.kill = () => true;
  const handle = { child, token: "peer", epoch: f.owner.epoch, ready: Promise.resolve(), stopping: false };
  f.workers.handles.set(f.owner.id, handle);
  return { child, handle, sent };
}

function exitChildren(...children) {
  for (const child of children) {
    child.exitCode = 0;
    child.connected = false;
    child.emit("exit", 0);
  }
}

test("question handoff stops remaining workers after a peer stop fails and preserves the answer for resume", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const peer = installPeer(f, { stuck: true });
  const deliveries = [];
  installReplacement(f, deliveries);
  try {
    const pausing = f.workers.onRpc(f.agent, f.handle, { type: "rpc", id: "question-rpc", token: f.handle.token,
      agentId: f.agent.id, epoch: f.agent.epoch, method: "RequestUserInput", args: { question: "Proceed?" }, taskId: "question" });
    const reply = await f.reply;
    f.control.resolveBlocker(reply.result.id, "Proceed with the next step");
    const answerId = `blocker-resolution:${reply.result.id}`;
    f.settle();
    await nextImmediate();
    for (const ms of [5000, 5000, 1000, 2000]) { t.mock.timers.tick(ms); await nextImmediate(); }
    await pausing;
    assert.equal(f.child.exitCode, 0, "The asking worker must stop even when its peer did not exit");
    assert.deepEqual(f.sent.filter(message => message.type).map(message => message.type), ["abort", "shutdown"]);
    assert.equal(f.control.getAgentPublic(f.agent.id).epoch, f.agent.epoch + 1);
    assert.equal(f.control.getAgentPublic(f.owner.id).epoch, f.owner.epoch + 1);
    assert.equal(f.workers.handles.get(f.owner.id), peer.handle);
    assert.equal(f.control.missionById(f.mission.id).status, "blocked");
    assert.equal(f.control.message(answerId).status, "queued");
    assert.equal(f.control.message(answerId).attempt, 1);
    assert.deepEqual(deliveries, []);
    const blockers = f.control.blockers(f.mission.id).filter(blocker => blocker.status === "open");
    assert.deepEqual(blockers.map(blocker => blocker.kind), ["unsafe_execution"]);
    exitChildren(peer.child);
    await f.workers.stopAgent(f.owner.id);
    f.control.resolveBlocker(blockers[0].id, "Confirmed peer exit and inspected workspace");
    f.control.missionAction(f.mission.id, "resume");
    await f.workers.dispatchPending();
    await f.workers.dispatchPending();
    assert.equal(f.control.message(answerId).status, "completed");
    assert.deepEqual(deliveries.map(message => message.messageId), [answerId]);
    assert.equal(deliveries[0].attempt, 1);
    assert.ok(deliveries[0].epoch > f.agent.epoch);
  } finally {
    exitChildren(f.child, peer.child);
  }
});

for (const terminal of ["completed", "cancelled"]) {
  test(`${terminal} stops and fences remaining workers after the first worker cannot exit`, async t => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const peer = installPeer(f);
    const message = f.control.sendMessage(f.mission.id, f.owner.id, "Already sent input", "followUp", "peer-input");
    const row = f.control.pendingOutbox().find(item => item.message_id === message.id);
    assert.equal(f.control.markOutboxDispatching(row.id, f.owner.epoch), true);
    assert.equal(f.control.ackOutbox(message.id, row.request_id, row.attempt, f.owner.epoch, "admitted"), true);
    f.child.send = (message, callback) => { f.sent.push(message); callback(null); };
    f.child.kill = () => true;
    try {
      if (terminal === "completed") await f.control.workerCommand({ type: "rpc", id: "complete-rpc", token: f.handle.token,
        agentId: f.agent.id, epoch: f.agent.epoch, method: "CompleteMission", args: {}, taskId: "complete" });
      else f.control.missionAction(f.mission.id, "cancel");
      const stopping = f.workers.syncMissionLifecycle(f.mission.id);
      const rejected = assert.rejects(stopping, /Local worker exit was not confirmed|Mission quiescence did not stop all workers/);
      await nextImmediate();
      for (const ms of [5000, 5000, 1000, 2000]) { t.mock.timers.tick(ms); await nextImmediate(); }
      await rejected;
      assert.equal(peer.child.exitCode, 0, "Other workers must stop before the failure is returned");
      assert.deepEqual(peer.sent, ["shutdown"]);
      assert.equal(f.control.getAgentPublic(f.owner.id).epoch, f.owner.epoch + 1);
      assert.equal(f.control.getAgentPublic(f.agent.id).epoch, f.agent.epoch + 1);
      assert.equal(f.control.message(message.id).status, "uncertain");
      assert.equal(f.control.db.prepare("SELECT status FROM outbox WHERE id=?").get(row.id).status, "uncertain");
      assert.equal(f.control.missionById(f.mission.id).status, terminal);
      assert.equal(f.workers.handles.get(f.agent.id), f.handle);
      assert.equal(f.workers.handles.has(f.owner.id), false);
      assert.deepEqual(f.control.blockers(f.mission.id).map(blocker => blocker.kind), terminal === "completed" ? [] : ["delivery", "delivery"]);
    } finally {
      exitChildren(f.child, peer.child);
    }
  });
}

function refuseExit(f) {
  const send = f.child.send;
  f.child.send = (message, callback) => {
    if (message.type === "abort" || message.type === "shutdown") { f.sent.push(message); callback(null); return; }
    send(message, callback);
  };
  f.child.kill = () => true;
}

async function drainStops(t, count = 1) {
  await nextImmediate();
  for (let i = 0; i < count; i++) {
    for (const ms of [5000, 5000, 1000, 2000]) { t.mock.timers.tick(ms); await nextImmediate(); }
  }
}

async function failedAnsweredQuestion(t, f, count = 1) {
  const pausing = f.workers.onRpc(f.agent, f.handle, { type: "rpc", id: "question-rpc", token: f.handle.token,
    agentId: f.agent.id, epoch: f.agent.epoch, method: "RequestUserInput", args: { question: "Proceed?" }, taskId: "question" });
  const reply = await f.reply;
  f.control.resolveBlocker(reply.result.id, "Proceed");
  f.settle();
  await drainStops(t, count);
  await pausing;
  return `blocker-resolution:${reply.result.id}`;
}

function stopSnapshot(f, answerId) {
  return {
    agents: f.control.listAgents(f.mission.id).map(agent => ({ id: agent.id, epoch: agent.epoch, error: agent.error, updatedAt: agent.updatedAt })),
    blockers: f.control.blockers(f.mission.id).filter(blocker => blocker.kind === "unsafe_execution"),
    stopEvents: f.control.detail(f.mission.id).events.filter(event => event.type === "operation_uncertain"),
    message: f.control.message(answerId),
    outbox: { ...f.control.db.prepare("SELECT * FROM outbox WHERE message_id=?").get(answerId) }
  };
}

for (const retry of ["sync", "rpc", "question", "pause", "close", "cancel"]) {
  test(`unconfirmed stop remains one fence across repeated ${retry}`, async t => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    refuseExit(f);
    try {
      const answerId = await failedAnsweredQuestion(t, f);
      const first = stopSnapshot(f, answerId);
      assert.equal(first.message.status, "queued");
      assert.equal(first.blockers.length, 1);
      const ordinary = f.control.sendMessage(f.mission.id, f.agent.id, "Ordinary follow-up", "followUp", "ordinary");
      for (let round = 0; round < 3; round++) {
        let operation;
        if (retry === "rpc") {
          operation = f.workers.onRpc(f.agent, f.handle, { type: "rpc", id: `late-${round}`, token: f.handle.token,
            agentId: f.agent.id, epoch: f.agent.epoch, method: "Report", args: { summary: "late result" }, taskId: `late-${round}` });
        } else if (retry === "question") {
          operation = f.workers.quiesceMission(f.mission.id, { kind: "question", agentId: f.agent.id });
        } else if (retry === "close") operation = f.workers.close();
        else if (retry === "pause") {
          if (round === 0) f.control.missionAction(f.mission.id, "pause");
          operation = f.workers.pauseMission(f.mission.id);
        } else {
          if (retry === "cancel" && round === 0) f.control.missionAction(f.mission.id, "cancel");
          operation = f.workers.syncMissionLifecycle(f.mission.id);
        }
        const finished = retry === "rpc" ? operation : assert.rejects(operation, AggregateError);
        await drainStops(t);
        await finished;
        const current = stopSnapshot(f, answerId);
        assert.deepEqual(current.agents, first.agents, "Retry must not advance an already fenced process or rewrite its diagnostic");
        assert.deepEqual(current.blockers, first.blockers, "The same process must keep one stable stop blocker");
        assert.deepEqual(current.stopEvents, first.stopEvents);
        if (retry === "cancel") {
          assert.equal(current.message.status, "aborted");
          assert.equal(current.outbox.status, "aborted");
          assert.equal(f.control.missionById(f.mission.id).status, "cancelled");
        } else {
          assert.deepEqual(current.message, first.message);
          assert.deepEqual(current.outbox, first.outbox);
        }
        if (retry === "pause" || retry === "cancel") assert.equal(f.control.message(ordinary.id).status, "aborted");
        assert.equal(f.workers.quiescenceFlights.size, 0);
        assert.equal(f.workers.handles.get(f.agent.id), f.handle);
        assert.equal(f.sent.filter(message => message.type === "deliver").length, 0);
      }
    } finally { exitChildren(f.child); }
  });
}

for (const resolveFirst of [false, true]) {
  test(`late exit ${resolveFirst ? "after" : "before"} blocker resolution releases the answer once`, async t => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    refuseExit(f);
    try {
      const answerId = await failedAnsweredQuestion(t, f);
      const blocker = f.control.blockers(f.mission.id).find(item => item.status === "open");
      if (resolveFirst) f.control.resolveBlocker(blocker.id, "Inspected the old process; awaiting exit");
      exitChildren(f.child);
      await f.workers.stopAgent(f.agent.id);
      assert.equal(f.workers.handles.has(f.agent.id), false);
      const deliveries = [];
      installReplacement(f, deliveries);
      await f.workers.startAgent(f.control.getAgentPublic(f.agent.id));
      await f.workers.dispatchPending();
      assert.deepEqual(deliveries, []);
      assert.equal(f.control.message(answerId).status, "queued");
      if (!resolveFirst) {
        assert.throws(() => f.control.missionAction(f.mission.id, "resume"), /Resolve mission blockers/);
        f.control.resolveBlocker(blocker.id, "Confirmed exit and inspected workspace");
      }
      assert.equal(f.control.missionById(f.mission.id).status, "paused");
      f.control.missionAction(f.mission.id, "resume");
      await f.workers.dispatchPending();
      await f.workers.dispatchPending();
      assert.equal(f.control.message(answerId).status, "completed");
      assert.equal(f.control.message(answerId).attempt, 1);
      assert.deepEqual(deliveries.map(message => message.messageId), [answerId]);
      assert.ok(deliveries[0].epoch > f.handle.epoch);
    } finally { exitChildren(f.child); }
  });
}

test("resolving a stop blocker before exit cannot start a replacement", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  refuseExit(f);
  try {
    const answerId = await failedAnsweredQuestion(t, f);
    const blocker = f.control.blockers(f.mission.id).find(item => item.status === "open");
    f.control.resolveBlocker(blocker.id, "Inspected process");
    f.control.missionAction(f.mission.id, "resume");
    const prepare = t.mock.method(f.control, "prepareAgentWorkspace", () => assert.fail("Old process is still live"));
    const starting = assert.rejects(f.workers.startAgent(f.control.getAgentPublic(f.agent.id)), /Mission quiescence|Local worker exit/);
    await drainStops(t, 2);
    await starting;
    assert.equal(prepare.mock.callCount(), 0);
    assert.equal(f.workers.handles.get(f.agent.id), f.handle);
    assert.equal(f.control.getAgentPublic(f.agent.id).epoch, f.handle.epoch + 1);
    assert.equal(f.control.message(answerId).status, "queued");
    assert.equal(f.control.blockers(f.mission.id).filter(item => item.kind === "unsafe_execution").length, 1);
    assert.equal(f.control.missionById(f.mission.id).status, "failed");
    exitChildren(f.child);
    await f.workers.stopAgent(f.agent.id);
    prepare.mock.restore();
    const deliveries = [];
    installReplacement(f, deliveries);
    f.control.missionAction(f.mission.id, "resume");
    await f.workers.dispatchPending();
    await f.workers.dispatchPending();
    assert.deepEqual(deliveries.map(message => message.messageId), [answerId]);
    assert.equal(f.control.message(answerId).attempt, 1);
  } finally { exitChildren(f.child); }
});

test("two unconfirmed processes retain independent fences across three sync retries", async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  refuseExit(f);
  const peer = installPeer(f, { stuck: true });
  try {
    const answerId = await failedAnsweredQuestion(t, f, 2);
    const first = stopSnapshot(f, answerId);
    assert.equal(first.blockers.length, 2);
    for (let round = 0; round < 3; round++) {
      const finished = assert.rejects(f.workers.syncMissionLifecycle(f.mission.id), error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        return true;
      });
      await drainStops(t, 2);
      await finished;
      assert.deepEqual(stopSnapshot(f, answerId), first);
      assert.equal(f.workers.quiescenceFlights.size, 0);
      assert.equal(f.workers.handles.size, 2);
    }
    assert.ok(f.sent.some(message => message.type === "shutdown"));
    assert.ok(peer.sent.includes("shutdown"));
  } finally { exitChildren(f.child, peer.child); }
});

for (const failing of ["asking", "peer"]) {
  test(`an answer received after ${failing} stop failure stays queued through manual pause`, async t => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const peer = failing === "peer" ? installPeer(f, { stuck: true }) : undefined;
    if (!peer) refuseExit(f);
    try {
      const pausing = f.workers.onRpc(f.agent, f.handle, { type: "rpc", id: "question-rpc", token: f.handle.token,
        agentId: f.agent.id, epoch: f.agent.epoch, method: "RequestUserInput", args: { question: "Proceed?" }, taskId: "question" });
      const reply = await f.reply;
      f.settle();
      await drainStops(t);
      await pausing;
      f.control.resolveBlocker(reply.result.id, "Proceed after inspection");
      const answerId = `blocker-resolution:${reply.result.id}`;
      assert.equal(f.control.message(answerId).status, "queued");
      f.control.missionAction(f.mission.id, "pause");
      const paused = assert.rejects(f.workers.pauseMission(f.mission.id), AggregateError);
      await drainStops(t);
      await paused;
      assert.equal(f.control.message(answerId).status, "queued");
      assert.equal(f.control.message(answerId).attempt, 1);
      const stopBlocker = f.control.blockers(f.mission.id).find(item => item.status === "open");
      exitChildren(f.child, ...(peer ? [peer.child] : []));
      await f.workers.stopAgent(peer ? f.owner.id : f.agent.id);
      f.control.resolveBlocker(stopBlocker.id, "Confirmed exit");
      const deliveries = [];
      installReplacement(f, deliveries);
      f.control.missionAction(f.mission.id, "resume");
      await f.workers.dispatchPending();
      await f.workers.dispatchPending();
      assert.deepEqual(deliveries.map(message => message.messageId), [answerId]);
      assert.equal(f.control.message(answerId).attempt, 1);
    } finally { exitChildren(f.child, ...(peer ? [peer.child] : [])); }
  });
}
