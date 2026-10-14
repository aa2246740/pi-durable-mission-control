import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { exchangeWorkerMailbox } from "../dist/node.js";
import { DurableWorkerMailbox } from "../dist/worker-mailbox.js";

const binding = {
  runtimeId: "exchange-runtime", machineId: "exchange-machine", sessionId: "exchange-session",
  sessionEpoch: 1, agentId: "exchange-agent", epoch: 1
};

async function fixture(t, reply) {
  const db = new DatabaseSync(":memory:");
  const mailbox = new DurableWorkerMailbox(db, "node");
  mailbox.open(binding);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const { status = 200, value } = reply(request.url, body, mailbox);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const exchange = () => exchangeWorkerMailbox(`http://127.0.0.1:${server.address().port}`, "fixture", mailbox, binding);
  return { mailbox, exchange, db };
}

test("mailbox exchange isolates a local fence before offering uploads", async t => {
  const { mailbox, exchange } = await fixture(t, () => assert.fail("A fenced mailbox must not send HTTP"));
  mailbox.fence(binding);
  await assert.rejects(exchange(), /Worker mailbox was fenced during exchange/);
});

test("mailbox exchange preserves unacknowledged evidence when fenced during upload", async t => {
  const { mailbox, exchange } = await fixture(t, (path, body, local) => {
    assert.equal(path, "/api/nodes/mailbox/upload");
    const row = local.inspectOutbox(binding)[0];
    local.fence(binding);
    return { value: { messageId: body.envelope.messageId, sequence: body.envelope.sequence, sha256: row.sha256 } };
  });
  mailbox.enqueue(binding, { kind: "notice", notice: { type: "ready", agentId: binding.agentId, epoch: binding.epoch } }, "upload-message");
  await assert.rejects(exchange(), /Worker mailbox was fenced during exchange/);
  assert.equal(mailbox.inspectOutbox(binding)[0].status, "uncertain");
});

test("mailbox exchange never admits a downlink returned after the local fence", async t => {
  const { mailbox, exchange } = await fixture(t, (_path, _body, local) => {
    local.fence(binding);
    return { value: { envelopes: [{ binding, messageId: "downlink-message", sequence: 1, payload: { kind: "shutdown" } }] } };
  });
  await assert.rejects(exchange(), /Worker mailbox was fenced during exchange/);
  assert.deepEqual(mailbox.inspectInbox(binding), []);
});

for (const [label, reply] of [
  ["authentication failure", () => ({ status: 401, value: { error: "unauthorized" } })],
  ["malformed poll", () => ({ value: { envelopes: [], extra: true } })],
  ["malformed envelope", () => ({ value: { envelopes: [{ invalid: true }] } })],
  ["misbound envelope", () => ({ value: { envelopes: [{ binding: { ...binding, epoch: 2 }, messageId: "bad-message", sequence: 1, payload: { kind: "shutdown" } }] } })]
]) {
  test(`mailbox exchange keeps ${label} fatal even after a local fence`, async t => {
    const { exchange } = await fixture(t, (...args) => {
      args[2].fence(binding);
      return reply();
    });
    await assert.rejects(exchange(), /Node connection failed/);
  });
}

for (const receipt of [
  { messageId: "different-message", sequence: 1, sha256: "0".repeat(64) },
  { invalid: true }
]) {
  test(`mailbox exchange rejects a ${"invalid" in receipt ? "malformed" : "mismatched"} upload receipt before treating a fence as local`, async t => {
    const { mailbox, exchange } = await fixture(t, (_path, _body, local) => {
      local.fence(binding);
      return { value: receipt };
    });
    mailbox.enqueue(binding, { kind: "notice", notice: { type: "ready", agentId: binding.agentId, epoch: binding.epoch } }, "bad-receipt-message");
    await assert.rejects(exchange(), /Node connection failed/);
    assert.equal(mailbox.inspectOutbox(binding)[0].status, "uncertain");
  });
}

test("mailbox exchange only reads the target among acknowledged outbox history", async t => {
  const requests = [];
  const { mailbox, exchange, db } = await fixture(t, (path, body, local) => {
    requests.push(path);
    if (path === "/api/nodes/mailbox/poll") return { value: { envelopes: [] } };
    const row = local.inspectOutboxMessage(binding, body.envelope.messageId);
    return { value: { messageId: body.envelope.messageId, sequence: body.envelope.sequence, sha256: row.sha256 } };
  });
  const coordinatorDb = new DatabaseSync(":memory:");
  t.after(() => coordinatorDb.close());
  const coordinator = new DurableWorkerMailbox(coordinatorDb, "coordinator");
  coordinator.open(binding);
  const payload = { kind: "notice", notice: { type: "ready", agentId: binding.agentId, epoch: binding.epoch } };
  for (let index = 0; index < 256; index++) {
    const envelope = mailbox.enqueue(binding, payload, `history-${index}`);
    mailbox.pending(binding, 1);
    mailbox.acknowledge(binding, coordinator.receive(binding, envelope));
  }
  const target = mailbox.enqueue(binding, payload, "target-message");
  const expected = mailbox.inspectOutbox(binding).find(row => row.envelope.messageId === target.messageId);
  db.prepare("UPDATE worker_mailbox_outbox SET envelope_json='invalid-json' WHERE status='acknowledged'").run();
  assert.throws(() => mailbox.inspectOutbox(binding), /invalid envelope JSON/);
  assert.deepEqual(mailbox.inspectOutboxMessage(binding, target.messageId), expected);
  assert.equal(mailbox.inspectOutboxMessage(binding, "missing-message"), undefined);
  assert.equal(await exchange(), true);
  assert.equal(mailbox.inspectOutboxMessage(binding, target.messageId).status, "acknowledged");
  assert.deepEqual(requests, ["/api/nodes/mailbox/upload", "/api/nodes/mailbox/poll"]);
});

for (const [label, change] of [
  ["message ID", row => ({ messageId: "wrong-message", sequence: row.envelope.sequence, sha256: row.sha256 })],
  ["sequence", row => ({ messageId: row.envelope.messageId, sequence: row.envelope.sequence + 1, sha256: row.sha256 })],
  ["hash", row => ({ messageId: row.envelope.messageId, sequence: row.envelope.sequence, sha256: "0".repeat(64) })],
  ["missing outbox record", row => ({ messageId: row.envelope.messageId, sequence: row.envelope.sequence, sha256: row.sha256 })]
]) {
  test(`mailbox exchange rejects ${label} before classifying a local fence`, async t => {
    const { mailbox, exchange, db } = await fixture(t, (_path, body, local) => {
      const row = local.inspectOutboxMessage(binding, body.envelope.messageId);
      local.fence(binding);
      if (label === "missing outbox record") {
        db.prepare("DELETE FROM worker_mailbox_outbox WHERE message_id=?").run(body.envelope.messageId);
      }
      return { value: change(row) };
    });
    mailbox.enqueue(binding, { kind: "notice", notice: { type: "ready", agentId: binding.agentId, epoch: binding.epoch } }, "mismatch-message");
    await assert.rejects(exchange(), /Node connection failed/);
    assert.equal(mailbox.inspectOutboxMessage(binding, "mismatch-message")?.status, label === "missing outbox record" ? undefined : "uncertain");
  });
}
