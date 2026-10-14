import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServer } from "../dist/server.js";

const nodeModule = pathToFileURL(join(process.cwd(), "dist/node.js")).href;

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-owner-lock-"));
  const root = join(home, "root"), nodeHome = join(home, "node-home");
  mkdirSync(root); mkdirSync(nodeHome);
  const service = await startServer({ home: join(home, "control"), port: 0 });
  const enrolled = service.control.enrollMachine("lock-node", "Owner lock regression");
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
      await child.done;
    }
    await service.close();
    rmSync(home, { recursive: true, force: true });
  });
  const options = { coordinator: `http://127.0.0.1:${service.port}`, machineId: "lock-node", tokenEnv: "NODE_OWNER_TEST_TOKEN", home: nodeHome, roots: [realpathSync(root)], credentialRefs: [] };
  const launch = (source, ipc = false) => {
    const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", source], {
      env: { ...globalThis.process.env, NODE_OWNER_TEST_TOKEN: enrolled.token, NODE_OWNER_BAD_TOKEN: "invalid-test-token" },
      stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])]
    });
    let output = "";
    process.stdout.on("data", (chunk) => { output += chunk; });
    process.stderr.on("data", (chunk) => { output += chunk; });
    const done = new Promise((resolve) => process.once("close", (code, signal) => resolve({ code, signal, output })));
    const child = { process, done, output: () => output };
    children.push(child);
    return child;
  };
  const start = (before = "", changed = {}) => launch(`
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { runNode } from ${JSON.stringify(nodeModule)};
    const options = ${JSON.stringify({ ...options, ...changed })};
    try {
      ${before}
      await runNode(options);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  `);
  const wait = async (child, predicate) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      assert.equal(child.process.exitCode, null, child.output());
      assert.equal(child.process.signalCode, null, child.output());
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`Node did not become ready: ${child.output()}`);
  };
  const online = (child, previousSession) => wait(child, () => {
    const machine = service.control.machineRegistry.get("lock-node");
    return machine?.status === "online" && machine.sessionId !== previousSession && machine;
  });
  const expireLease = () => {
    const machine = service.control.machineRegistry.get("lock-node");
    // Isolate home locking from the coordinator's independent 20-second lease.
    service.control.db.prepare("UPDATE remote_machines SET data=? WHERE id=?")
      .run(JSON.stringify({ ...machine, leaseExpiresAt: Date.now() - 1 }), "lock-node");
  };
  const read = (sql) => {
    const db = new DatabaseSync(join(nodeHome, "node.sqlite"), { readOnly: true });
    try { return db.prepare(sql).all().map((row) => ({ ...row })); }
    finally { db.close(); }
  };
  const probe = async (child) => {
    const command = service.control.machineRegistry.enqueueProbe("lock-node", crypto.randomUUID(), root);
    await wait(child, () => service.control.machineCommand("lock-node", command.id).status === "completed");
    assert.deepEqual(service.control.machineCommand("lock-node", command.id).result, { requestedPath: root, path: realpathSync(root), isDirectory: true });
  };
  const stop = async (child, signal = "SIGTERM") => {
    child.process.kill(signal);
    const result = await child.done;
    if (signal === "SIGKILL") assert.equal(result.signal, signal, result.output);
    else assert.equal(result.code, 0, result.output);
  };
  return { home, nodeHome, options, start, launch, wait, online, expireLease, read, probe, stop };
}

for (const stale of ["current PID", "unrelated live PID"]) {
  test(`node starts with a stale owner record containing the ${stale}`, { timeout: 45000 }, async (t) => {
    const f = await fixture(t);
    let unrelated;
    if (stale === "unrelated live PID") {
      unrelated = f.launch("process.send('ready'); setInterval(() => {}, 1000);", true);
      await once(unrelated.process, "message");
    }
    const stalePid = unrelated ? String(unrelated.process.pid) : "process.pid";
    const node = f.start(`
      const db = new DatabaseSync(options.home + '/node.sqlite');
      db.exec('CREATE TABLE node_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL, pid INTEGER NOT NULL)');
      db.prepare('INSERT INTO node_owner VALUES(1,?,?)').run('stale-owner', ${stalePid});
      db.close();
    `);
    await f.online(node);
    await f.probe(node);
    const [owner] = f.read("SELECT * FROM node_owner");
    assert.equal(owner.pid, node.process.pid);
    assert.notEqual(owner.owner_id, "stale-owner");
    if (unrelated) assert.equal(unrelated.process.exitCode, null, "Unrelated live process was disturbed");
    await f.stop(node);
  });
}

test("SIGKILL releases the real node owner while preserving its journal for the next session", { timeout: 45000 }, async (t) => {
  const f = await fixture(t);
  const first = f.start();
  const previous = await f.online(first);
  await f.probe(first);
  await f.wait(first, () => f.read("SELECT * FROM node_operations").every((row) => row.status === "sent"));
  const before = f.read("SELECT * FROM node_operations");
  await f.stop(first, "SIGKILL");
  assert.equal(f.read("SELECT pid FROM node_owner")[0].pid, first.process.pid);
  f.expireLease();
  const second = f.start();
  const current = await f.online(second, previous.sessionId);
  assert.ok(current.sessionEpoch > previous.sessionEpoch);
  await f.probe(second);
  assert.deepEqual(f.read("SELECT * FROM node_operations").find((row) => row.command_id === before[0].command_id), before[0]);
  assert.equal(f.read("SELECT pid FROM node_owner")[0].pid, second.process.pid);
  await f.stop(second);
});

test("same-process and other-process duplicates cannot release a live owner's lock; graceful exit does", { timeout: 45000 }, async (t) => {
  const f = await fixture(t);
  const alias = join(f.home, "node-alias");
  symlinkSync(f.nodeHome, alias);
  const first = f.start(`
    const running = runNode(options);
    await assert.rejects(runNode({ ...options, home: ${JSON.stringify(alias)} }), /another node owner is already running/);
    console.log('duplicate-rejected');
    await running;
    process.exit(0);
  `);
  const previous = await f.online(first);
  await f.wait(first, () => first.output().includes("duplicate-rejected"));
  const owner = f.read("SELECT * FROM node_owner");
  const second = f.start();
  const rejection = await second.done;
  assert.equal(rejection.code, 1, rejection.output);
  assert.match(rejection.output, /another node owner is already running/);
  assert.deepEqual(f.read("SELECT * FROM node_owner"), owner);
  await f.probe(first);
  await f.stop(first);
  assert.deepEqual(f.read("SELECT * FROM node_owner"), []);
  f.expireLease();
  const replacement = f.start();
  await f.online(replacement, previous.sessionId);
  await f.probe(replacement);
  await f.stop(replacement);
});

test("identity rejection releases ownership before a correct same-process retry", { timeout: 45000 }, async (t) => {
  const f = await fixture(t);
  const first = f.start();
  const previous = await f.online(first);
  await f.stop(first);
  f.expireLease();
  const second = f.start(`
    await assert.rejects(runNode({ ...options, machineId: 'wrong-machine' }), /bound to a different coordinator or machine/);
  `);
  await f.online(second, previous.sessionId);
  await f.probe(second);
  await f.stop(second);
});

test("failed session registration releases ownership before a same-process retry", { timeout: 45000 }, async (t) => {
  const f = await fixture(t);
  const node = f.start(`
    await assert.rejects(runNode({ ...options, tokenEnv: 'NODE_OWNER_BAD_TOKEN' }), /Node connection failed/);
  `);
  await f.online(node);
  await f.probe(node);
  await f.stop(node);
});
