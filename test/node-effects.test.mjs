import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { NodeEffectJournal } from "../dist/node-effects.js";

const spec = {
  binding: { runtimeId: "runtime-1", machineId: "node-1", sessionId: "session-1", sessionEpoch: 1, agentId: "agent-1", epoch: 1 },
  descriptorHash: "a".repeat(64), taskId: "agent-1:tool-1",
  method: "bash", args: { command: "printf effect >> marker" }
};
const normalizedJson = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-effect-"));
  let db;
  t.after(() => { db?.close(); rmSync(home, { recursive: true, force: true }); });
  const open = () => {
    db = new DatabaseSync(join(home, "effects.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    return new NodeEffectJournal(db);
  };
  return { home, open, close: () => { db.close(); db = undefined; } };
}

test("effect receipt is cached without repeating the external action, including after restart", t => {
  const f = fixture(t), journal = f.open(), marker = join(f.home, "marker");
  const id = journal.admit(spec);
  assert.equal(journal.admit(spec), id);
  assert.throws(() => journal.complete(spec, { status: "succeeded", result: { exitCode: 0 } }), /execution claim/);
  assert.equal(journal.begin(spec).execute, true);
  appendFileSync(marker, "effect");
  assert.throws(() => journal.begin(spec), /not be repeated/);
  const receipt = { status: "succeeded", result: { exitCode: 0 } };
  assert.deepEqual(normalizedJson(journal.complete(spec, receipt)), receipt);
  assert.deepEqual(normalizedJson(journal.complete(spec, receipt)), receipt);
  assert.deepEqual(normalizedJson(journal.begin(spec)), { execute: false, receipt });
  assert.throws(() => journal.complete(spec, { status: "failed", result: { exitCode: 1 } }), /cannot be replaced/);
  f.close();
  const resumed = f.open(); resumed.recover();
  assert.deepEqual(normalizedJson(resumed.begin(spec)), { execute: false, receipt });
  assert.equal(readFileSync(marker, "utf8"), "effect");
});

test("real process exit after an effect leaves uncertainty and cannot replay under a new runtime", t => {
  const f = fixture(t), marker = join(f.home, "marker");
  const modulePath = new URL("../dist/node-effects.js", import.meta.url).href;
  const script = `
    import {DatabaseSync} from "node:sqlite";
    import {appendFileSync} from "node:fs";
    import {NodeEffectJournal} from ${JSON.stringify(modulePath)};
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    const journal = new NodeEffectJournal(db), spec = JSON.parse(process.argv[3]);
    journal.admit(spec);
    if (!journal.begin(spec).execute) process.exit(2);
    appendFileSync(process.argv[2], "effect");
    process.exit(17);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, join(f.home, "effects.sqlite"), marker, JSON.stringify(spec)], { encoding: "utf8" });
  assert.equal(child.status, 17, child.stderr);
  const journal = f.open(); journal.recover();
  assert.equal(journal.inspect()[0].state, "uncertain");
  assert.throws(() => journal.begin(spec), /not be repeated/);
  assert.throws(() => journal.admit({ ...spec, binding: { ...spec.binding, runtimeId: "runtime-2", sessionEpoch: 2, epoch: 2 } }), /different binding or payload/);
  assert.throws(() => journal.complete(spec, { status: "succeeded", result: { exitCode: 0 } }), /cannot be replaced/);
  assert.equal(readFileSync(marker, "utf8"), "effect");
  journal.recover();
  assert.equal(journal.inspect()[0].state, "uncertain");
});

test("prepared effects survive restart; changed payload, identity, and malformed receipts fail closed", t => {
  const f = fixture(t), journal = f.open();
  journal.admit(spec); journal.recover();
  assert.equal(journal.inspect()[0].state, "prepared");
  for (const changed of [
    { ...spec, args: { command: "another command" } },
    { ...spec, descriptorHash: "b".repeat(64) },
    { ...spec, binding: { ...spec.binding, machineId: "other" } }
  ]) assert.throws(() => journal.admit(changed), /different binding or payload/);
  assert.throws(() => journal.admit({ ...spec, method: "McpCall" }), /Invalid node effect/);
  assert.throws(() => journal.admit({ ...spec, args: { command: "true", extra: true } }), /Invalid node effect/);
  assert.throws(() => journal.admit({ ...spec, args: { command: "x".repeat(32001) } }), /Invalid node effect/);
  assert.equal(journal.begin(spec).execute, true);
  assert.throws(() => journal.complete(spec, { status: "succeeded", result: undefined }), /Invalid node effect/);
  assert.equal(journal.inspect()[0].state, "executing");
  journal.complete(spec, { status: "uncertain", error: "Connection was lost after dispatch" });
  assert.throws(() => journal.begin(spec), /not be repeated/);
});

test("an outer transaction cannot authorize execution before the claim is durably committed", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const journal = new NodeEffectJournal(db);
  journal.admit(spec);
  db.exec("BEGIN IMMEDIATE");
  assert.throws(() => journal.begin(spec), /committed top-level execution claim/);
  assert.equal(journal.inspect()[0].state, "prepared");
  db.exec("ROLLBACK");
  assert.equal(journal.begin(spec).execute, true);
  assert.doesNotThrow(() => db.exec("BEGIN IMMEDIATE; ROLLBACK"));
});

test("effect receipts carry the node-local read_file content limit", t => {
  const f = fixture(t), journal = f.open();
  const readSpec = { ...spec, method: "read_file", args: { path: "large.txt" } };
  const receipt = {
    status: "succeeded",
    result: { path: "/node/workspace/large.txt", content: "x".repeat(300000), truncated: false }
  };
  journal.admit(readSpec);
  assert.equal(journal.begin(readSpec).execute, true);
  assert.equal(journal.complete(readSpec, receipt).result.content.length, 300000);
});

test("terminal receipt uploads survive restart and require an exact durable acknowledgement", t => {
  const f = fixture(t), journal = f.open();
  journal.admit(spec);
  assert.equal(journal.begin(spec).execute, true);
  journal.complete(spec, { status: "succeeded", result: { exitCode: 0 } });
  const [upload] = journal.pendingReceipts();
  assert.ok(upload);
  const ack = { recorded: true, duplicate: false, effectId: upload.effectId, receiptHash: upload.receiptHash };
  assert.throws(() => journal.acknowledgeReceipt(upload, { ...ack, receiptHash: "f".repeat(64) }), /does not match/);
  f.close();
  const resumed = f.open(); resumed.recover();
  assert.deepEqual(normalizedJson(resumed.pendingReceipts()), normalizedJson([upload]));
  assert.equal(resumed.begin(spec).execute, false);
  resumed.acknowledgeReceipt(upload, ack);
  resumed.acknowledgeReceipt(upload, { ...ack, duplicate: true });
  assert.deepEqual(resumed.pendingReceipts(), []);
  f.close();
  const again = f.open(); again.recover();
  assert.deepEqual(again.pendingReceipts(), []);
  assert.equal(again.begin(spec).execute, false);
});
