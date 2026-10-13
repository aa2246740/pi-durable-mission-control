import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RemoteArtifactStore, REMOTE_ARTIFACT_CHUNK_BYTES } from "../dist/remote-artifacts.js";
import { parseNodeEffectSpec } from "../dist/node-effects.js";

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), "remote-artifact-store-"));
  const db = new DatabaseSync(join(home, "control.sqlite"));
  const store = new RemoteArtifactStore(db, home);
  t.after(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, db, store };
}

function identity(id, bytes) {
  const binding = {
    runtimeId: `runtime-${id}`, machineId: "machine-1", sessionId: "session-1",
    sessionEpoch: 1, agentId: "agent-1", epoch: 1
  };
  const taskId = `agent-1:${id}`;
  const spec = {
    binding, descriptorHash: "a".repeat(64), taskId: `agent-1:rpc-${id}`,
    method: "PublishArtifact", taskAttempt: 1,
    args: { name: `artifact-${id}`, path: "artifact.bin", taskId }
  };
  const manifest = {
    sourcePath: `/remote/${id}/artifact.bin`, relativePath: "artifact.bin",
    size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")
  };
  return { binding, spec, manifest };
}

function finalize(store, { binding, spec, manifest }, label, save = () => {}) {
  return store.complete(spec, manifest, (snapshotPath, transferId) => ({
    id: label, missionId: "mission-1", agentId: binding.agentId, taskId: spec.args.taskId,
    name: spec.args.name, path: manifest.sourcePath, size: manifest.size, sha256: manifest.sha256,
    snapshotPath, relativePath: manifest.relativePath, createdAt: new Date().toISOString(),
    remoteProvenance: { transferId, machineId: binding.machineId, runtimeId: binding.runtimeId,
      agentId: binding.agentId, taskAttempt: spec.taskAttempt }
  }), save);
}

test("remote artifact store persists ordered binary chunks and installs verified immutable CAS", t => {
  const { db, store } = setup(t);
  const bytes = Buffer.alloc(REMOTE_ARTIFACT_CHUNK_BYTES + 19);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 97) & 255;
  const transfer = identity("binary", bytes);
  const first = bytes.subarray(0, REMOTE_ARTIFACT_CHUNK_BYTES);
  const second = bytes.subarray(REMOTE_ARTIFACT_CHUNK_BYTES);
  assert.throws(() => store.chunk(transfer.spec, transfer.manifest, first.length, second), /gap|overlap/i);
  const firstReceipt = store.chunk(transfer.spec, transfer.manifest, 0, first);
  assert.match(firstReceipt.transferId, /^[a-f0-9]{64}$/);
  assert.deepEqual({ ...firstReceipt, transferId: "redacted" },
    { transferId: "redacted", offset: 0, bytes: first.length, duplicate: false });
  const reboundManifest = { ...transfer.manifest, sha256: "f".repeat(64) };
  assert.throws(() => store.chunk(transfer.spec, reboundManifest, 0, first), /identity conflicts/i);
  assert.throws(() => store.complete(transfer.spec, reboundManifest, () => { throw new Error("must not create"); }, () => {}),
    /identity conflicts/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM remote_artifact_transfers").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM remote_artifact_chunks").get().count, 1);
  assert.equal(store.chunk(transfer.spec, transfer.manifest, 0, first).duplicate, true);
  assert.throws(() => store.chunk(transfer.spec, transfer.manifest, 0, Buffer.from(first).fill(0)), /conflicting/i);
  assert.equal(store.chunk(transfer.spec, transfer.manifest, first.length, second).duplicate, false);
  const artifact = finalize(store, transfer, "binary-artifact");
  assert.deepEqual(readFileSync(artifact.snapshotPath), bytes);
  assert.equal(statSync(artifact.snapshotPath).mode & 0o777, 0o400);
  assert.throws(() => store.complete(transfer.spec, reboundManifest, () => { throw new Error("must not create"); }, () => {}),
    /identity conflicts/i);
  assert.equal(finalize(store, transfer, "ignored").id, "binary-artifact");
  assert.equal(store.chunk(transfer.spec, transfer.manifest, 0, first).duplicate, true);
  assert.throws(() => store.chunk(transfer.spec, transfer.manifest, 0, Buffer.from(first).fill(0)),
    /conflicting/i);
});

test("remote artifact store completes empty files and rejects incomplete or digest-invalid transfers", t => {
  const { store } = setup(t);
  const empty = identity("empty", Buffer.alloc(0));
  const emptyArtifact = finalize(store, empty, "empty-artifact");
  assert.deepEqual(readFileSync(emptyArtifact.snapshotPath), Buffer.alloc(0));

  const bytes = Buffer.from("verified bytes");
  const invalid = identity("bad-digest", bytes);
  invalid.manifest.sha256 = "b".repeat(64);
  assert.equal(store.chunk(invalid.spec, invalid.manifest, 0, bytes).duplicate, false);
  assert.throws(() => finalize(store, invalid, "invalid"), /digest/i);
  assert.throws(() => store.chunk(invalid.spec, invalid.manifest, 1, bytes.subarray(1, 2)), /gap|overlap/i);
});

test("existing CAS reuse verifies the incoming transfer bytes before returning the digest path", t => {
  const { db, store } = setup(t);
  const bytes = Buffer.from("verified CAS bytes");
  const first = identity("cas-first", bytes);
  let saved = 0;
  store.chunk(first.spec, first.manifest, 0, bytes);
  const original = finalize(store, first, "cas-original", () => { saved++; });
  assert.deepEqual(readFileSync(original.snapshotPath), bytes);

  const forgedBytes = Buffer.alloc(bytes.length, 0x78);
  const forged = identity("cas-forged", forgedBytes);
  forged.manifest = {
    ...forged.manifest, sourcePath: first.manifest.sourcePath,
    relativePath: first.manifest.relativePath, sha256: first.manifest.sha256
  };
  store.chunk(forged.spec, forged.manifest, 0, forgedBytes);
  assert.throws(() => finalize(store, forged, "cas-forged-artifact", () => { saved++; }), /digest/i);
  assert.equal(saved, 1);
  assert.deepEqual(readFileSync(original.snapshotPath), bytes);

  const identical = identity("cas-identical", bytes);
  identical.manifest = {
    ...identical.manifest, sourcePath: first.manifest.sourcePath, relativePath: first.manifest.relativePath
  };
  store.chunk(identical.spec, identical.manifest, 0, bytes);
  const reused = finalize(store, identical, "cas-reuse", () => { saved++; });
  assert.equal(reused.snapshotPath, original.snapshotPath);
  assert.deepEqual(readFileSync(reused.snapshotPath), bytes);
  assert.equal(saved, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM remote_artifact_transfers WHERE status='complete'").get().count, 2);
});

test("PublishArtifact task attempts must be positive safe integers", () => {
  const valid = identity("attempt", Buffer.from("x")).spec;
  assert.ok(parseNodeEffectSpec(valid));
  assert.equal(parseNodeEffectSpec({ ...valid, taskAttempt: 0 }), undefined);
  assert.equal(parseNodeEffectSpec({ ...valid, taskAttempt: -1 }), undefined);
});
