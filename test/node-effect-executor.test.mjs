import assert from "node:assert/strict";
import { constants, appendFileSync, chmodSync, closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { abortNodeEffect, executeNodeEffect, nodeEffectExtinct, readNodeArtifactChunk, snapshotNodeArtifact, verifyNodeArtifactSnapshot } from "../dist/node-effect-executor.js";
import { parseNodeEffectReceipt } from "../dist/node-effects.js";
import { REMOTE_ARTIFACT_CHUNK_BYTES } from "../dist/remote-artifacts.js";

const binding = { runtimeId: "executor-runtime", machineId: "node", sessionId: "session", sessionEpoch: 1, agentId: "agent", epoch: 1 };
const spec = (method, args) => ({ binding, descriptorHash: "a".repeat(64), taskId: "agent:effect-1", method, args });
const normalizedJson = value => JSON.parse(JSON.stringify(value));

test("executor confines read/write paths and returns bounded node-local results", async t => {
  const root = mkdtempSync(join(tmpdir(), "node-effect-executor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  mkdirSync(workspace); mkdirSync(outside);
  symlinkSync(outside, join(workspace, "escape"));
  const written = await executeNodeEffect(spec("write_file", { path: "nested/file.txt", content: "node-only" }), workspace);
  assert.equal(written.status, "succeeded");
  const read = await executeNodeEffect(spec("read_file", { path: "nested/file.txt" }), workspace);
  assert.equal(read.status, "succeeded");
  assert.equal(read.result.content, "node-only");
  writeFileSync(join(workspace, "large.txt"), "x".repeat(300000));
  const large = await executeNodeEffect(spec("read_file", { path: "large.txt" }), workspace);
  assert.equal(large.status, "succeeded");
  assert.equal(large.result.content.length, 300000);
  assert.equal(large.result.truncated, false);
  for (const request of [
    spec("read_file", { path: "../outside/secret" }),
    spec("write_file", { path: "../outside/secret", content: "bad" }),
    spec("read_file", { path: "escape/secret" }),
    spec("write_file", { path: "escape/secret", content: "bad" })
  ]) await assert.rejects(executeNodeEffect(request, workspace));
});

test("shell has minimal environment, returns output, and abort confirms group extinction", async t => {
  const root = mkdtempSync(join(tmpdir(), "node-effect-shell-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.MC_NODE_EFFECT_SECRET = "must-not-leak";
  t.after(() => { delete process.env.MC_NODE_EFFECT_SECRET; });
  const output = await executeNodeEffect(spec("bash", { command: "printf 'hello:%s' \"${MC_NODE_EFFECT_SECRET-unset}\"" }), root);
  assert.equal(output.status, "succeeded");
  assert.equal(output.result.stdout, "hello:unset");
  const marker = join(root, "late-marker");
  const running = executeNodeEffect(spec("bash", { command: `sleep 30; printf late > '${marker}'` }), root);
  await new Promise(resolve => setTimeout(resolve, 100));
  abortNodeEffect(binding.runtimeId);
  const stopped = await running;
  assert.equal(stopped.status, "uncertain");
  assert.equal(nodeEffectExtinct(binding.runtimeId), true);
  assert.throws(() => readFileSync(marker));
});

test("shell timeout kills the process group and preserves uncertainty about partial effects", async t => {
  const root = mkdtempSync(join(tmpdir(), "node-effect-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await executeNodeEffect(spec("bash", { command: "printf partial > partial.txt; sleep 30" }), root, { timeoutMs: 50 });
  assert.equal(result.status, "uncertain");
  assert.match(result.error, /timed out/);
  assert.equal(readFileSync(join(root, "partial.txt"), "utf8"), "partial");
  assert.equal(nodeEffectExtinct(binding.runtimeId), true);
});

test("escaped and multibyte file content fits the durable receipt limit", async t => {
  const root = mkdtempSync(join(tmpdir(), "node-effect-size-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const source of ["\u0001".repeat(300000), "中文😀".repeat(100000)]) {
    writeFileSync(join(root, "large.txt"), source);
    const result = await executeNodeEffect(spec("read_file", { path: "large.txt" }), root);
    assert.equal(result.status, "succeeded");
    assert.equal(result.result.truncated, true);
    assert.ok(source.startsWith(result.result.content));
    assert.ok(result.result.content.length > 0);
    assert.deepEqual(normalizedJson(parseNodeEffectReceipt(result, binding)), normalizedJson(result));
  }
});

test("FIFO paths are rejected for reads and writes without blocking", async t => {
  const root = mkdtempSync(join(tmpdir(), "node-effect-fifo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fifo = join(root, "pipe");
  const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    for (const method of ["read_file", "write_file"]) {
      const args = method === "write_file" ? { path: "pipe", content: "not written" } : { path: "pipe" };
      const specJson = JSON.stringify(spec(method, args));
      const moduleUrl = new URL("../dist/node-effect-executor.js", import.meta.url).href;
      const fixture = `
        import { executeNodeEffect } from ${JSON.stringify(moduleUrl)};
        const spec = ${specJson};
        try {
          await executeNodeEffect(spec, ${JSON.stringify(root)});
          process.stdout.write("resolved");
        } catch (error) {
          process.stdout.write(error.message);
        }
      `;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", fixture], {
        encoding: "utf8",
        timeout: 3000
      });
      assert.equal(child.error, undefined, `${method}: ${child.error}`);
      assert.equal(child.status, 0, `${method}: ${child.stderr}`);
      assert.equal(child.stdout, "Path is not a file");
    }
  } finally {
    closeSync(reader);
  }
});

test("artifact snapshot is bounded, immutable, stable, and scans credentials across chunk boundaries", t => {
  const root = mkdtempSync(join(tmpdir(), "node-artifact-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), snapshots = join(root, "snapshots");
  mkdirSync(workspace);
  const artifactSpec = {
    ...spec("PublishArtifact", { name: "evidence", path: "artifact.bin", taskId: "domain-task" }),
    taskAttempt: 1
  };
  const secretSource = Buffer.concat([
    Buffer.alloc(REMOTE_ARTIFACT_CHUNK_BYTES - 2, 0x78), Buffer.from("known-secret")
  ]);
  writeFileSync(join(workspace, "artifact.bin"), secretSource);
  assert.throws(() => snapshotNodeArtifact(artifactSpec, workspace, snapshots, ["known-secret"]), /known credential/i);
  assert.deepEqual(readdirSync(snapshots), []);

  const source = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.alloc(REMOTE_ARTIFACT_CHUNK_BYTES + 7, 0x45)]);
  writeFileSync(join(workspace, "artifact.bin"), source);
  const snapshot = snapshotNodeArtifact(artifactSpec, workspace, snapshots, ["known-secret"]);
  assert.deepEqual(readNodeArtifactChunk(snapshot, 0, REMOTE_ARTIFACT_CHUNK_BYTES), source.subarray(0, REMOTE_ARTIFACT_CHUNK_BYTES));
  assert.deepEqual(readNodeArtifactChunk(snapshot, REMOTE_ARTIFACT_CHUNK_BYTES, source.length - REMOTE_ARTIFACT_CHUNK_BYTES),
    source.subarray(REMOTE_ARTIFACT_CHUNK_BYTES));
  verifyNodeArtifactSnapshot(snapshot);
  writeFileSync(join(workspace, "artifact.bin"), "changed source after publication");
  verifyNodeArtifactSnapshot(snapshot);
  chmodSync(snapshot.path, 0o600);
  writeFileSync(snapshot.path, source);
  appendFileSync(snapshot.path, Buffer.from([0]));
  assert.throws(() => verifyNodeArtifactSnapshot(snapshot), /changed|size|grew/i);
  writeFileSync(snapshot.path, "tampered snapshot");
  assert.throws(() => verifyNodeArtifactSnapshot(snapshot), /changed|digest/i);
});

test("shell exit kills background children and preserves the shell exit status", async t => {
  const root = mkdtempSync(join(tmpdir(), "node-effect-background-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = await executeNodeEffect(spec("bash", { command: "sleep 30 &" }), root, { timeoutMs: 500 });
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.exitCode, 0);
  assert.equal(nodeEffectExtinct(binding.runtimeId), true);
});
