import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../dist/server.js";

const cli = join(process.cwd(), "dist", "cli.js");
const waitFor = async (fn, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out");
};

test("real node child receives a probe and writes an isolated journal", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-child-"));
  const root = join(home, "root");
  const nodeHome = join(home, "node-home");
  mkdirSync(root);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const service = await startServer({ home: join(home, "control"), port: 0 });
  t.after(() => service.close());
  const enrolled = service.control.enrollMachine("child-node", "Child Node");
  const adminToken = readFileSync(join(home, "control", "admin.token"), "utf8").trim();
  const child = spawn(process.execPath, [cli, "node", "--coordinator", `http://127.0.0.1:${service.port}`, "--machine-id", "child-node", "--token-env", "NODE_TEST_TOKEN", "--home", nodeHome, "--root", realpathSync(root)], {
    env: { ...process.env, NODE_TEST_TOKEN: enrolled.token }, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { if (!child.killed) child.kill("SIGTERM"); });
  await waitFor(() => service.control.machineRegistry.get("child-node")?.status === "online");
  const packageVersion = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version;
  const remote = service.control.machineRegistry.get("child-node");
  assert.equal(remote.capabilities.version, packageVersion);
  assert.equal(remote.capabilities.node, process.version);
  assert.equal(remote.capabilities.executionEnabled, false);
  const requestId = crypto.randomUUID();
  const response = await fetch(`http://127.0.0.1:${service.port}/api/machines/child-node/probe`, {
    method: "POST", headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ path: root, requestId })
  });
  assert.equal(response.status, 202);
  const command = await response.json();
  await waitFor(() => service.control.machineCommand("child-node", command.id).status === "completed");
  const receipt = service.control.machineCommand("child-node", command.id);
  assert.deepEqual(receipt.result, { requestedPath: root, path: realpathSync(root), isDirectory: true });
  assert.equal(readFileSync(join(nodeHome, "node.sqlite")).length > 0, true);
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
});

test("workspace probe rejects symlink escapes and permits legal '..notes' names", async () => {
  const { inspectWorkspace } = await import("../dist/node.js");
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-path-"));
  const root = join(home, "root");
  const outside = join(home, "outside");
  const sibling = join(root, "..notes");
  mkdirSync(root); mkdirSync(outside); mkdirSync(sibling); symlinkSync(outside, join(root, "escape"));
  try {
    assert.deepEqual(inspectWorkspace(root, [realpathSync(root)]), { requestedPath: root, path: realpathSync(root), isDirectory: true });
    assert.deepEqual(inspectWorkspace(sibling, [realpathSync(root)]), { requestedPath: sibling, path: realpathSync(sibling), isDirectory: true });
    assert.throws(() => inspectWorkspace(join(root, "escape"), [realpathSync(root)]), /outside/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("node HTTP requests remove abort listeners across bounded repeated calls", async (t) => {
  const { fetchJson } = await import("../dist/node.js");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); }
  };
  const base = new URL(`http://127.0.0.1:${address.port}`);
  for (let index = 0; index < 32; index += 1) {
    assert.deepEqual(await fetchJson(base, "/api/nodes/poll", "node-test-secret", {}, signal), {});
    assert.equal(listeners.size, 0);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchJson(base, "/api/nodes/poll", "node-test-secret", {}, controller.signal), /Node connection failed/);
  assert.equal(requests, 32);
});

test("second real CLI owner cannot mutate the first owner's admitted journal row", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-owner-"));
  const root = join(home, "root");
  const nodeHome = join(home, "node-home");
  mkdirSync(root);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const service = await startServer({ home: join(home, "control"), port: 0 });
  t.after(() => service.close());
  const enrolled = service.control.enrollMachine("owner-node", "Owner Node");
  const args = [cli, "node", "--coordinator", `http://127.0.0.1:${service.port}`, "--machine-id", "owner-node",
    "--token-env", "NODE_TEST_TOKEN", "--home", nodeHome, "--root", realpathSync(root)];
  const env = { ...process.env, NODE_TEST_TOKEN: enrolled.token };
  const first = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let firstOutput = "";
  first.stdout.setEncoding("utf8"); first.stderr.setEncoding("utf8");
  first.stdout.on("data", (chunk) => { firstOutput += chunk; });
  first.stderr.on("data", (chunk) => { firstOutput += chunk; });
  try {
    await waitFor(() => service.control.machineRegistry.get("owner-node")?.status === "online");
    const db = new DatabaseSync(join(nodeHome, "node.sqlite"));
    const commandId = crypto.randomUUID();
    const machine = service.control.machineRegistry.get("owner-node");
    db.prepare("INSERT INTO node_operations(command_id,requested_path,status,updated_at,session_id,session_epoch) VALUES(?,?,?,?,?,?)")
      .run(commandId, root, "admitted", Date.now(), machine.sessionId, machine.sessionEpoch);
    const beforeRow = db.prepare("SELECT * FROM node_operations WHERE command_id=?").get(commandId);
    const beforeOwner = db.prepare("SELECT * FROM node_owner WHERE singleton=1").get();
    const second = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    assert.notEqual(second.code, 0);
    assert.equal(second.output.includes(enrolled.token), false);
    assert.deepEqual(db.prepare("SELECT * FROM node_operations WHERE command_id=?").get(commandId), beforeRow);
    assert.deepEqual(db.prepare("SELECT * FROM node_owner WHERE singleton=1").get(), beforeOwner);
    db.close();
  } finally {
    if (first.exitCode === null && first.signalCode === null) {
      first.kill("SIGTERM");
      await new Promise((resolve) => first.once("exit", resolve));
    }
  }
  assert.equal(firstOutput.includes(enrolled.token), false);
  const variants = [
    args.map((value, index) => index === args.indexOf("--machine-id") + 1 ? "different-node" : value),
    args.map((value, index) => index === args.indexOf("--coordinator") + 1 ? "http://127.0.0.1:1" : value)
  ];
  for (const variant of variants) {
    const mismatch = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, variant, { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    assert.notEqual(mismatch.code, 0);
    assert.equal(mismatch.output.includes(enrolled.token), false);
  }
  const identityDb = new DatabaseSync(join(nodeHome, "node.sqlite"), { readOnly: true });
  const identity = identityDb.prepare("SELECT coordinator_id,machine_id FROM node_identity WHERE singleton=1").get();
  assert.equal(identity.coordinator_id, `http://127.0.0.1:${service.port}`);
  assert.equal(identity.machine_id, "owner-node");
  assert.equal(identityDb.prepare("SELECT 1 FROM node_owner WHERE singleton=1").get(), undefined);
  identityDb.close();
});

test("new CLI session quarantines an old completed receipt instead of replaying it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-recovery-"));
  const root = join(home, "root");
  const target = join(root, "target");
  const nodeHome = join(home, "node-home");
  mkdirSync(target, { recursive: true });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const service = await startServer({ home: join(home, "control"), port: 0 });
  t.after(() => service.close());
  const enrolled = service.control.enrollMachine("recovery-node", "Recovery Node");
  const args = [cli, "node", "--coordinator", `http://127.0.0.1:${service.port}`, "--machine-id", "recovery-node",
    "--token-env", "NODE_TEST_TOKEN", "--home", nodeHome, "--root", realpathSync(root)];
  const env = { ...process.env, NODE_TEST_TOKEN: enrolled.token };
  const first = spawn(process.execPath, args, { env, stdio: "ignore" });
  await waitFor(() => service.control.machineRegistry.get("recovery-node")?.status === "online");
  const original = service.control.machineRegistry.get("recovery-node");
  first.kill("SIGKILL");
  await new Promise((resolve) => first.once("exit", resolve));

  const command = service.control.machineRegistry.enqueueProbe("recovery-node", crypto.randomUUID(), target);
  service.control.machineRegistry.poll("recovery-node", enrolled.token, original.sessionId, original.sessionEpoch, 1);
  const outcome = { ok: true, result: { requestedPath: target, path: target, isDirectory: true } };
  const journal = new DatabaseSync(join(nodeHome, "node.sqlite"));
  journal.prepare("INSERT INTO node_operations(command_id,requested_path,status,outcome,updated_at,session_id,session_epoch) VALUES(?,?,?,?,?,?,?)")
    .run(command.id, target, "completed", JSON.stringify(outcome), Date.now(), original.sessionId, original.sessionEpoch);
  journal.close();
  const authority = service.control.db.prepare("SELECT id,data FROM remote_machines WHERE id=?").get("recovery-node");
  const machine = JSON.parse(authority.data);
  machine.leaseExpiresAt = Date.now() - 1;
  service.control.db.prepare("UPDATE remote_machines SET data=? WHERE id=?").run(JSON.stringify(machine), machine.id);
  rmSync(target, { recursive: true, force: true });

  const second = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitFor(() => {
      const current = service.control.machineRegistry.get("recovery-node");
      return current?.status === "online" && current.sessionEpoch > original.sessionEpoch;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(second.exitCode, null);
    assert.equal(service.control.machineCommand("recovery-node", command.id).status, "uncertain");
    const check = new DatabaseSync(join(nodeHome, "node.sqlite"), { readOnly: true });
    const row = check.prepare("SELECT status,outcome,session_id,session_epoch FROM node_operations WHERE command_id=?").get(command.id);
    check.close();
    assert.equal(row.status, "uncertain");
    assert.equal(row.outcome, JSON.stringify(outcome));
    assert.equal(row.session_id, original.sessionId);
    assert.equal(row.session_epoch, original.sessionEpoch);
  } finally {
    if (second.exitCode === null && second.signalCode === null) {
      second.kill("SIGTERM");
      await new Promise((resolve) => second.once("exit", resolve));
    }
  }
});
