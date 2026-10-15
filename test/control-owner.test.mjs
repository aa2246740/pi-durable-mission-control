import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ControlPlane, CONTROL_SCHEMA_VERSION, tryAcquireDaemonOwnership } from "../dist/control.js";
import { backupHome, restoreHome } from "../dist/backup.js";

const controlModule = new URL("../dist/control.js", import.meta.url).href;
const backupModule = new URL("../dist/backup.js", import.meta.url).href;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mission-control-owner-"));
  const home = join(root, "home");
  mkdirSync(home);
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
      await child.done;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const launch = (source) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { ControlPlane } from ${JSON.stringify(controlModule)};
      import { backupHome } from ${JSON.stringify(backupModule)};
      const home = ${JSON.stringify(home)};
      ${source}
    `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const done = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal, output })));
    const result = { process: child, done };
    children.push(result);
    return result;
  };
  const start = async (before = "") => {
    const child = launch(`
      ${before}
      const control = new ControlPlane(home);
      const timer = setInterval(() => control.heartbeat(), 1000);
      process.on('SIGTERM', () => { clearInterval(timer); control.close(); process.disconnect(); });
      process.send({ daemonId: control.daemonId, ...control.db.prepare('SELECT epoch, pid FROM daemon_owner').get() });
    `);
    const [info] = await Promise.race([
      once(child.process, "message"),
      child.done.then((result) => { throw new Error(`Coordinator exited before readiness: ${JSON.stringify(result)}`); })
    ]);
    return { ...child, info };
  };
  const stop = async (child, signal = "SIGTERM") => {
    child.process.kill(signal);
    const result = await child.done;
    if (signal === "SIGKILL") assert.equal(result.signal, signal, result.output);
    else assert.equal(result.code, 0, result.output);
  };
  const initialize = () => {
    new ControlPlane(home).close();
    writeFileSync(join(home, "admin.token"), "owner-test-token\n", { mode: 0o600 });
  };
  return { root, home, launch, start, stop, initialize };
}

for (const stale of ["current PID", "unrelated live PID"]) {
  test(`coordinator starts and backs up with a stale owner containing the ${stale}`, { timeout: 30000 }, async (t) => {
    const f = fixture(t);
    f.initialize();
    const child = await f.start(`
      const db = new DatabaseSync(home + '/control.sqlite');
      const stalePid = ${stale === "current PID" ? "process.pid" : process.pid};
      process.kill(stalePid, 0);
      db.prepare('INSERT INTO daemon_owner VALUES (1, ?, ?, ?, ?)').run('stale-owner', 12, stalePid, Date.now());
      db.close();
      await backupHome(home, ${JSON.stringify(join(f.root, "stale-backup"))}, 'test', async () => {});
    `);
    assert.equal(child.info.epoch, 13);
    assert.equal(child.info.pid, child.process.pid);
    assert.notEqual(child.info.daemonId, "stale-owner");
    assert.equal(existsSync(join(f.root, "stale-backup", "manifest.json")), true);
    await f.stop(child);
  });
}

test("SIGKILL releases coordinator ownership and preserves epoch fencing on restart", { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  f.initialize();
  const first = await f.start();
  await f.stop(first, "SIGKILL");
  const db = new DatabaseSync(join(f.home, "control.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT pid FROM daemon_owner").get().pid, first.process.pid); }
  finally { db.close(); }
  await backupHome(f.home, join(f.root, "after-kill"), "test", async () => {});
  const second = await f.start();
  assert.equal(second.info.epoch, first.info.epoch + 1);
  assert.notEqual(second.info.daemonId, first.info.daemonId);
  await f.stop(second);
});

test("a live coordinator excludes another process and backup, then normal stop allows both", { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  f.initialize();
  const first = await f.start();
  const rejected = await f.launch("new ControlPlane(home);").done;
  assert.equal(rejected.code, 1, rejected.output);
  assert.match(rejected.output, /already has an owner/);
  const output = join(f.root, "after-stop");
  await assert.rejects(backupHome(f.home, output, "test", async () => {}), /ownership lock is held/);
  assert.equal(existsSync(output), false);
  await f.stop(first);
  await backupHome(f.home, output, "test", async () => {});
  const second = await f.start();
  await f.stop(second);
});

test("same-process and symlink-alias opens refuse ownership without releasing the first owner", (t) => {
  const f = fixture(t);
  const control = new ControlPlane(f.home);
  const alias = join(f.root, "alias");
  symlinkSync(f.home, alias);
  try {
    assert.throws(() => new ControlPlane(f.home), /already has an owner/);
    assert.throws(() => new ControlPlane(alias), /already has an owner/);
    assert.equal(tryAcquireDaemonOwnership(f.home), undefined);
    assert.equal(control.db.prepare("SELECT daemon_id FROM daemon_owner").get().daemon_id, control.daemonId);
    assert.equal(statSync(join(f.home, "daemon.ownership.sqlite")).mode & 0o777, 0o600);
  } finally { control.close(); }
  control.close();
  new ControlPlane(f.home).close();
});

test("backup holds ownership across async checks and excludes startup and concurrent backup", { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  f.initialize();
  const output = join(f.root, "backup");
  await backupHome(f.home, output, "test", async () => {
    const rejected = await f.launch("new ControlPlane(home);").done;
    assert.equal(rejected.code, 1, rejected.output);
    assert.match(rejected.output, /offline backup in progress/);
    await assert.rejects(backupHome(f.home, join(f.root, "concurrent"), "test", async () => {}), /ownership lock is held/);
  });
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.files.some((file) => file.path === "daemon.ownership.sqlite"), false);
  const child = await f.start();
  assert.throws(() => restoreHome(output, f.home), /target is not empty/);
  await f.stop(child);
  const restored = join(f.root, "restored");
  restoreHome(output, restored);
  new ControlPlane(restored).close();
});

test("backup failure releases ownership for immediate startup", async (t) => {
  const f = fixture(t);
  f.initialize();
  await assert.rejects(backupHome(f.home, join(f.root, "failed"), "test", async () => {
    throw new Error("offline check failed");
  }), /offline check failed/);
  new ControlPlane(f.home).close();
  rmSync(join(f.home, "admin.token"));
  await assert.rejects(backupHome(f.home, join(f.root, "missing-token"), "test", async () => {}), /token is missing/);
  new ControlPlane(f.home).close();
});

test("failed database open and compatibility check release ownership", (t) => {
  const f = fixture(t);
  const path = join(f.home, "control.sqlite");
  mkdirSync(path);
  assert.throws(() => new ControlPlane(f.home));
  rmSync(path, { recursive: true });
  new ControlPlane(f.home).close();
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA user_version=${CONTROL_SCHEMA_VERSION + 1}`);
    assert.throws(() => new ControlPlane(f.home), /not supported/);
    db.exec(`PRAGMA user_version=${CONTROL_SCHEMA_VERSION}`);
  } finally { db.close(); }
  new ControlPlane(f.home).close();
});
