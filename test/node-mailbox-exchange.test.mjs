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
  return { mailbox, exchange };
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
