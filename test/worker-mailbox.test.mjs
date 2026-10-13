import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DurableWorkerMailbox, parseWorkerEnvelope } from "../dist/worker-mailbox.js";

const binding = {
  runtimeId: "runtime-a",
  machineId: "machine-a",
  sessionId: "session-a",
  sessionEpoch: 3,
  agentId: "agent-a",
  epoch: 7
};

function pair(t, suffix = "worker-mailbox-") {
  const home = mkdtempSync(join(tmpdir(), suffix));
  const nodeDb = new DatabaseSync(join(home, "node.sqlite"));
  const coordinatorDb = new DatabaseSync(join(home, "coordinator.sqlite"));
  const node = new DurableWorkerMailbox(nodeDb, "node");
  const coordinator = new DurableWorkerMailbox(coordinatorDb, "coordinator");
  node.open(binding);
  coordinator.open(binding);
  let closed = false;
  const closeDatabases = () => {
    if (closed) return;
    closed = true;
    nodeDb.close();
    coordinatorDb.close();
  };
  t.after(() => {
    closeDatabases();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, nodeDb, coordinatorDb, node, coordinator, closeDatabases };
}

function rpc(rpcId, taskId = `task-${rpcId}`) {
  return { kind: "rpc", rpcId, taskId, method: "GetMissionState", args: {} };
}

function deliver(messageId, content = messageId) {
  return { kind: "deliver", messageId, requestId: `request-${messageId}`, attempt: 1, content, mode: "followUp" };
}

function statuses(mailbox, kind, ids) {
  const rows = kind === "outbox" ? mailbox.inspectOutbox(binding) : mailbox.inspectInbox(binding);
  return Object.fromEntries(rows.filter((row) => ids.includes(row.envelope.messageId)).map((row) => [row.envelope.messageId, row.status]));
}

test("durable RPC and reply transport retransmits without implicit handler execution", (t) => {
  const { node, coordinator } = pair(t);
  const uplink = node.enqueue(binding, rpc("rpc-1"), "uplink-1");
  const offered = node.pending(binding);
  assert.deepEqual(offered, [uplink]);
  assert.deepEqual(node.pending(binding), [uplink]);

  const uplinkReceipt = coordinator.receive(binding, offered[0]);
  assert.deepEqual(coordinator.receive(binding, offered[0]), uplinkReceipt);
  assert.deepEqual(coordinator.inspectInbox(binding).map((row) => row.status), ["received"]);
  assert.deepEqual(coordinator.received(binding), [uplink]);

  const claimed = coordinator.claim(binding, "uplink-1");
  assert.deepEqual(claimed, uplink);
  assert.equal(coordinator.claim(binding, "uplink-1"), undefined);
  const reply = coordinator.finishWithReply(
    binding, "uplink-1", { kind: "reply", rpcId: "rpc-1", ok: true, result: { answer: "durable" } }, "reply-1"
  );
  assert.equal(coordinator.inspectInbox(binding)[0].status, "applied");
  assert.equal(coordinator.inspectOutbox(binding)[0].status, "queued");
  assert.deepEqual(
    coordinator.finishWithReply(
      binding, "uplink-1", { kind: "reply", rpcId: "rpc-1", ok: true, result: { answer: "durable" } }, "reply-1"
    ),
    reply
  );
  for (const mismatch of [
    { sessionId: "forged-session" },
    { sessionEpoch: binding.sessionEpoch + 1 },
    { agentId: "forged-agent" },
    { epoch: binding.epoch + 1 }
  ]) {
    assert.throws(
      () => coordinator.finishWithReply(
        { ...binding, ...mismatch },
        "uplink-1",
        { kind: "reply", rpcId: "rpc-1", ok: true, result: { answer: "durable" } },
        "reply-1"
      ),
      /identity mismatch/
    );
  }
  assert.equal(coordinator.inspectInbox(binding)[0].status, "applied");

  const downlink = coordinator.pending(binding);
  assert.deepEqual(downlink, [reply]);
  const replyReceipt = node.receive(binding, downlink[0]);
  assert.deepEqual(node.receive(binding, downlink[0]), replyReceipt);
  assert.deepEqual(node.received(binding), [reply]);
  assert.deepEqual(node.claim(binding, "reply-1"), reply);
  assert.equal(node.claim(binding, "reply-1"), undefined);
  assert.equal(node.finish(binding, "reply-1"), true);
  assert.deepEqual(node.receive(binding, downlink[0]), replyReceipt);
  assert.equal(node.finish(binding, "reply-1"), true);
  for (const mismatch of [
    { sessionId: "forged-session" },
    { sessionEpoch: binding.sessionEpoch + 1 },
    { agentId: "forged-agent" },
    { epoch: binding.epoch + 1 }
  ]) {
    assert.throws(
      () => node.finish({ ...binding, ...mismatch }, "reply-1"),
      /identity mismatch/
    );
  }
  assert.equal(node.inspectInbox(binding)[0].status, "applied");

  assert.equal(node.acknowledge(binding, uplinkReceipt), true);
  assert.deepEqual(node.pending(binding), []);
  assert.equal(coordinator.acknowledge(binding, replyReceipt), true);
  assert.deepEqual(coordinator.pending(binding), []);
});

test("an RPC ID cannot be reused with a different inbound envelope", (t) => {
  const { node, coordinator } = pair(t, "worker-mailbox-rpc-id-");
  const first = node.enqueue(binding, rpc("rpc-same"), "uplink-first");
  assert.equal(coordinator.receive(binding, first).messageId, first.messageId);

  const duplicate = node.enqueue(binding, rpc("rpc-same", "different-task"), "uplink-second");
  assert.throws(() => coordinator.receive(binding, duplicate), /RPC ID is already used/);
  assert.equal(coordinator.inspectBinding(binding).nextReceiveSequence, 2);
  assert.deepEqual(coordinator.inspectInbox(binding).map((row) => row.envelope.messageId), ["uplink-first"]);

  const validNext = {
    ...duplicate,
    messageId: "uplink-valid-next",
    payload: { ...duplicate.payload, rpcId: "rpc-next", taskId: "task-next" }
  };
  assert.equal(coordinator.receive(binding, validNext).sequence, 2);
});

test("envelope parser and mailbox fences reject malformed, misbound, swapped, and conflicting input", (t) => {
  const { node, coordinator } = pair(t, "worker-mailbox-validation-");
  const valid = node.enqueue(binding, rpc("validation-rpc"), "validation-1");
  assert.deepEqual(node.enqueue(binding, rpc("validation-rpc"), "validation-1"), valid);
  assert.throws(
    () => node.enqueue(binding, rpc("different-rpc"), "validation-1"),
    /different payload or binding/
  );
  assert.ok(parseWorkerEnvelope(valid));
  assert.equal(parseWorkerEnvelope({ ...valid, extra: true }), undefined);
  assert.equal(parseWorkerEnvelope({ ...valid, sequence: Number.MAX_SAFE_INTEGER + 1 }), undefined);
  assert.equal(parseWorkerEnvelope({
    ...valid, binding: { ...binding, epoch: Number.MAX_SAFE_INTEGER + 1 }
  }), undefined);
  assert.equal(parseWorkerEnvelope({
    ...valid,
    payload: { ...valid.payload, token: "not-a-transport-field" }
  }), undefined);
  assert.equal(parseWorkerEnvelope({
    ...valid,
    payload: { ...valid.payload, args: { value: undefined } }
  }), undefined);
  assert.equal(parseWorkerEnvelope({
    ...valid,
    payload: { ...valid.payload, args: { value: Number.POSITIVE_INFINITY } }
  }), undefined);
  const cyclic = { value: null };
  cyclic.value = cyclic;
  assert.equal(parseWorkerEnvelope({
    ...valid,
    payload: { ...valid.payload, args: cyclic }
  }), undefined);
  assert.equal(parseWorkerEnvelope({
    ...valid,
    payload: { ...valid.payload, args: { value: 1n } }
  }), undefined);
  assert.equal(parseWorkerEnvelope({
    ...valid,
    payload: {
      kind: "notice",
      notice: { type: "ready", agentId: "other-agent", epoch: binding.epoch }
    }
  }), undefined);
  assert.equal(parseWorkerEnvelope({
    binding, messageId: "oversized", sequence: 1,
    payload: { kind: "deliver", ...deliver("oversized"), content: "x".repeat(512 * 1024) }
  }), undefined);
  assert.equal(parseWorkerEnvelope({
    binding, messageId: "escaped-oversized", sequence: 1,
    payload: { kind: "deliver", ...deliver("escaped-oversized"), content: "\u0000".repeat(100_000) }
  }), undefined);
  let shared = { leaf: "x" };
  for (let level = 0; level < 22; level += 1) shared = { left: shared, right: shared };
  assert.equal(parseWorkerEnvelope({
    binding, messageId: "shared-dag", sequence: 1,
    payload: { kind: "rpc", rpcId: "dag-rpc", taskId: "dag-task", method: "Run", args: { shared } }
  }), undefined);

  const beforeReceive = coordinator.inspectBinding(binding);
  assert.throws(
    () => coordinator.receive({ ...binding, machineId: "other-machine" }, valid),
    /misbound/
  );
  for (const mismatch of [
    { sessionId: "other-session" },
    { sessionEpoch: binding.sessionEpoch + 1 },
    { agentId: "other-agent" }
  ]) {
    assert.throws(() => coordinator.receive({ ...binding, ...mismatch }, valid), /misbound/);
  }
  assert.equal(coordinator.inspectBinding(binding).nextReceiveSequence, beforeReceive.nextReceiveSequence);
  assert.throws(() => node.receive(binding, valid), /wrong direction/);
  assert.equal(node.inspectBinding(binding).nextReceiveSequence, 1);
  const receipt = coordinator.receive(binding, valid);
  assert.equal(coordinator.inspectBinding(binding).nextReceiveSequence, 2);
  assert.throws(
    () => coordinator.receive(binding, { ...valid, messageId: "sequence-conflict" }),
    /sequence/
  );
  assert.throws(
    () => coordinator.receive(binding, {
      ...valid, payload: { ...valid.payload, method: "DifferentMethod" }
    }),
    /conflicts/
  );
  assert.equal(coordinator.inspectBinding(binding).nextReceiveSequence, 2);
  assert.throws(
    () => coordinator.receive(binding, {
      ...valid, messageId: "gap", sequence: 9
    }),
    /sequence/
  );
  assert.equal(coordinator.inspectBinding(binding).nextReceiveSequence, 2);
  assert.deepEqual(coordinator.receive(binding, valid), receipt);
  assert.throws(
    () => node.open({ ...binding, runtimeId: binding.runtimeId, epoch: binding.epoch + 1 }),
    /already bound/
  );
  assert.throws(() => new DurableWorkerMailbox(coordinatorDbFor(t), "node"), /side/);
});

test("runtime-invalid mailbox sides are rejected before creating any tables", (t) => {
  const home = mkdtempSync(join(tmpdir(), "worker-mailbox-invalid-side-"));
  const db = new DatabaseSync(join(home, "invalid-side.sqlite"));
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const injectedSide = "node'); CREATE TABLE injected(x); --";
  assert.throws(() => new DurableWorkerMailbox(db, injectedSide), /side/);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all(),
    []
  );
});

function coordinatorDbFor(t) {
  const home = mkdtempSync(join(tmpdir(), "worker-mailbox-opposite-"));
  const db = new DatabaseSync(join(home, "db.sqlite"));
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  new DurableWorkerMailbox(db, "coordinator");
  return db;
}

test("recovery fences in-flight work, retains evidence, and requires explicit closure before ownership", (t) => {
  const { home, node, coordinator, closeDatabases } = pair(t, "worker-mailbox-recovery-");
  const offered = node.enqueue(binding, rpc("offered-rpc"), "offered-out");
  const offeredEnvelope = node.pending(binding)[0];
  const offeredReceipt = coordinator.receive(binding, offeredEnvelope);
  coordinator.claim(binding, offeredEnvelope.messageId);
  coordinator.finish(binding, offeredEnvelope.messageId);
  node.acknowledge(binding, offeredReceipt);

  const uncertainOut = node.enqueue(binding, rpc("uncertain-rpc"), "uncertain-out");
  node.pending(binding);
  const queuedOut = node.enqueue(binding, rpc("queued-rpc"), "queued-out");

  const receivedIn = coordinator.enqueue(binding, deliver("received-in"), "received-in");
  const processingIn = coordinator.enqueue(binding, deliver("processing-in"), "processing-in");
  const appliedIn = coordinator.enqueue(binding, deliver("applied-in"), "applied-in");
  for (const envelope of coordinator.pending(binding)) node.receive(binding, envelope);
  node.claim(binding, processingIn.messageId);
  node.claim(binding, appliedIn.messageId);
  node.finish(binding, appliedIn.messageId);

  assert.throws(() => node.confirmClosed(binding), /unsettled/);
  closeDatabases();

  const nodeDb2 = new DatabaseSync(join(home, "node.sqlite"));
  const coordinatorDb2 = new DatabaseSync(join(home, "coordinator.sqlite"));
  const node2 = new DurableWorkerMailbox(nodeDb2, "node");
  const coordinator2 = new DurableWorkerMailbox(coordinatorDb2, "coordinator");
  t.after(() => {
    nodeDb2.close();
    coordinatorDb2.close();
  });
  assert.equal(node2.inspectBinding(binding).status, "open");
  assert.equal(node2.recover(), 1);
  assert.equal(coordinator2.recover(), 1);
  assert.deepEqual(statuses(node2, "outbox", [offered.messageId, uncertainOut.messageId, queuedOut.messageId]), {
    [offered.messageId]: "acknowledged",
    [uncertainOut.messageId]: "uncertain",
    [queuedOut.messageId]: "cancelled"
  });
  assert.deepEqual(statuses(node2, "inbox", [receivedIn.messageId, processingIn.messageId, appliedIn.messageId]), {
    [receivedIn.messageId]: "cancelled",
    [processingIn.messageId]: "uncertain",
    [appliedIn.messageId]: "applied"
  });
  assert.throws(
    () => node2.open({ ...binding, runtimeId: "runtime-b" }),
    /open or uncertain/
  );
  assert.equal(node2.confirmClosed(binding).status, "closed");
  assert.equal(node2.inspectOutbox(binding).length, 3);
  assert.equal(node2.inspectInbox(binding).length, 3);
  assert.equal(node2.open({ ...binding, runtimeId: "runtime-b" }).status, "open");
  assert.equal(node2.open(binding).status, "closed");
  assert.throws(() => node2.fence(binding), /Closed/);
});

test("finishWithReply rolls back a conflicting reply ID and leaves the RPC processing", (t) => {
  const { node, coordinator } = pair(t, "worker-mailbox-reply-conflict-");
  const incoming = node.enqueue(binding, rpc("conflict-rpc"), "conflict-in");
  const received = coordinator.receive(binding, incoming);
  assert.deepEqual(coordinator.claim(binding, incoming.messageId), incoming);
  const conflicting = coordinator.enqueue(
    binding, { kind: "reply", rpcId: "different-rpc", ok: false, error: "existing" }, "conflict-reply"
  );
  assert.equal(conflicting.messageId, "conflict-reply");
  assert.throws(
    () => coordinator.finishWithReply(
      binding, incoming.messageId, { kind: "reply", rpcId: "conflict-rpc", ok: true, result: { ok: true } }, "conflict-reply"
    ),
    /different payload or binding/
  );
  assert.equal(coordinator.inspectInbox(binding)[0].status, "processing");
  assert.equal(coordinator.inspectOutbox(binding)[0].status, "queued");
  const reply = coordinator.finishWithReply(
    binding, incoming.messageId, { kind: "reply", rpcId: "conflict-rpc", ok: true, result: { ok: true } }, "reply-after-conflict"
  );
  assert.equal(reply.payload.kind, "reply");
  assert.equal(reply.payload.rpcId, "conflict-rpc");
  assert.equal(reply.payload.ok, true);
  assert.equal(reply.payload.result.ok, true);
  assert.equal(coordinator.inspectInbox(binding)[0].status, "applied");
  assert.ok(received.sha256);
});
