import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { backupHome, restoreHome } from "../dist/backup.js";
import { fixture } from "./fixtures/completion.mjs";

async function crash(t, terminal) {
  const child = fork(new URL("./fixtures/terminal-crash.mjs", import.meta.url), [terminal], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  });
  const [f] = await Promise.race([
    once(child, "message"),
    exit.then(() => { throw new Error(`Coordinator exited before settlement wait: ${stderr}`); })
  ]);
  t.after(() => rmSync(f.home, { recursive: true, force: true }));
  child.kill("SIGKILL");
  assert.deepEqual(await exit, [null, "SIGKILL"]);
  return f;
}

function assertFenced(db, f, terminal) {
  const outbox = db.prepare("SELECT status,deadline_at,attempt FROM outbox WHERE id=?").get(f.row.id);
  assert.deepEqual({ ...outbox }, { status: "uncertain", deadline_at: null, attempt: 1 });
  const message = db.prepare("SELECT status,data FROM messages WHERE id=?").get(f.row.message_id);
  assert.equal(message.status, "uncertain");
  assert.equal(JSON.parse(message.data).status, "uncertain");
  assert.equal(db.prepare("SELECT status FROM missions WHERE id=?").get(f.missionId).status, terminal);
  const blockers = db.prepare("SELECT id,status FROM blockers WHERE mission_id=?").all(f.missionId);
  assert.deepEqual(blockers.map((row) => ({ ...row })), terminal === "cancelled" ? [{ id: `delivery:${f.row.id}`, status: "open" }] : []);
}

for (const terminal of ["completed", "cancelled"]) {
  for (const recovery of ["startup", "backup"]) {
    test(`${recovery} fences ${terminal} local delivery after SIGKILL during settlement`, { timeout: 20000 }, async (t) => {
      const f = await crash(t, terminal);
      let home = join(f.home, "state");
      if (recovery === "backup") {
        const backup = join(f.home, "backup");
        await backupHome(home, backup, "0.1.0", async () => {});
        home = join(f.home, "restored");
        restoreHome(backup, home);
        const db = new DatabaseSync(join(home, "control.sqlite"));
        try { assertFenced(db, f, terminal); } finally { db.close(); }
      }
      for (let restart = 0; restart < 2; restart++) {
        const control = new ControlPlane(home);
        try {
          if (restart === 0 && recovery === "startup") await delay(5500);
          assertFenced(control.db, f, terminal);
          assert.equal(control.getAgentPublic(f.agentId).status, "offline");
          assert.deepEqual(control.pendingOutbox(), []);
        } finally { control.close(); }
      }
    });
  }
}

async function storedDelivery(t, terminal, state) {
  const f = await fixture(t, { admitted: state !== "dispatching" });
  f.control.db.prepare("UPDATE missions SET status=?,data=json_set(data,'$.status',?) WHERE id=?").run(terminal, terminal, f.mission.id);
  f.control.db.prepare("UPDATE outbox SET status=?,deadline_at=? WHERE id=?").run(state, Date.now() + 60000, f.row.id);
  const messageStatus = state === "dispatching" ? "queued" : state;
  f.control.db.prepare("UPDATE messages SET status=?,data=json_set(data,'$.status',?) WHERE id=?").run(messageStatus, messageStatus, f.row.message_id);
  writeFileSync(join(f.home, "state", "admin.token"), "terminal-recovery-test-token\n", { mode: 0o600 });
  f.control.close();
  return { ...f, missionId: f.mission.id, agentId: f.agent.id };
}

async function restore(f) {
  const backup = join(f.home, "backup");
  await backupHome(join(f.home, "state"), backup, "0.1.0", async () => {});
  const restored = join(f.home, "restored");
  restoreHome(backup, restored);
  return restored;
}

for (const terminal of ["completed", "cancelled"]) {
  for (const recovery of ["startup", "backup"]) {
    for (const state of ["dispatching", "admitted", "delivering", "delivered"]) {
      test(`${recovery} atomically fences ${terminal} ${state} records and clears their deadline`, async (t) => {
        const f = await storedDelivery(t, terminal, state);
        const home = recovery === "backup" ? await restore(f) : join(f.home, "state");
        const control = recovery === "startup" ? new ControlPlane(home) : undefined;
        const db = control?.db ?? new DatabaseSync(join(home, "control.sqlite"));
        try { assertFenced(db, f, terminal); } finally { if (control) control.close(); else db.close(); }
      });
    }
  }
}

for (const recovery of ["startup", "backup"]) {
  for (const failure of ["message", "blocker"]) {
    test(`${recovery} rolls back terminal fencing if ${failure} persistence fails`, async (t) => {
      const f = await storedDelivery(t, "cancelled", "dispatching");
      const source = join(f.home, "state", "control.sqlite");
      let db = new DatabaseSync(source);
      const before = {
        outbox: db.prepare("SELECT * FROM outbox WHERE id=?").get(f.row.id),
        message: db.prepare("SELECT * FROM messages WHERE id=?").get(f.row.message_id),
        agent: db.prepare("SELECT * FROM agents WHERE id=?").get(f.agentId)
      };
      db.exec(failure === "message"
        ? "CREATE TRIGGER reject_terminal_fence BEFORE UPDATE ON messages WHEN NEW.status='uncertain' BEGIN SELECT RAISE(ABORT,'injected terminal failure'); END"
        : "CREATE TRIGGER reject_terminal_fence BEFORE INSERT ON blockers WHEN NEW.id LIKE 'delivery:%' BEGIN SELECT RAISE(ABORT,'injected terminal failure'); END");
      db.close();
      if (recovery === "startup") assert.throws(() => new ControlPlane(join(f.home, "state")), /injected terminal failure/);
      else {
        await assert.rejects(restore(f), /injected terminal failure/);
        assert.equal(existsSync(join(f.home, "restored")), false);
      }
      db = new DatabaseSync(source);
      try {
        assert.deepEqual(db.prepare("SELECT * FROM outbox WHERE id=?").get(f.row.id), before.outbox);
        assert.deepEqual(db.prepare("SELECT * FROM messages WHERE id=?").get(f.row.message_id), before.message);
        assert.deepEqual(db.prepare("SELECT * FROM agents WHERE id=?").get(f.agentId), before.agent);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM blockers WHERE mission_id=?").get(f.missionId).count, 0);
      } finally { db.close(); }
    });
  }

  test(`${recovery} preserves a previously resolved terminal delivery blocker`, async (t) => {
    const f = await storedDelivery(t, "cancelled", "admitted");
    const db = new DatabaseSync(join(f.home, "state", "control.sqlite"));
    const blocker = { id: `delivery:${f.row.id}`, missionId: f.missionId, kind: "delivery", status: "resolved", text: "Already checked", createdAt: new Date().toISOString(), resolution: "Verified the workspace" };
    db.prepare("INSERT INTO blockers(id,mission_id,status,data) VALUES(?,?,'resolved',?)").run(blocker.id, f.missionId, JSON.stringify(blocker));
    db.close();
    const home = recovery === "backup" ? await restore(f) : join(f.home, "state");
    const control = new ControlPlane(home);
    try {
      assert.equal(control.message(f.row.message_id).status, "uncertain");
      assert.deepEqual(control.blockers(f.missionId), [blocker]);
    } finally { control.close(); }
  });
}

test("schema-zero backup fences terminal local delivery without migrating", async (t) => {
  const f = await storedDelivery(t, "cancelled", "delivered");
  const db = new DatabaseSync(join(f.home, "state", "control.sqlite"));
  db.exec("ALTER TABLE outbox DROP COLUMN deadline_at; PRAGMA user_version=0;");
  db.close();
  const home = await restore(f);
  const restored = new DatabaseSync(join(home, "control.sqlite"));
  try {
    assert.equal(restored.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(restored.prepare("SELECT status FROM outbox WHERE id=?").get(f.row.id).status, "uncertain");
    assert.equal(restored.prepare("SELECT status FROM messages WHERE id=?").get(f.row.message_id).status, "uncertain");
    assert.equal(restored.prepare("SELECT status FROM blockers WHERE id=?").get(`delivery:${f.row.id}`).status, "open");
  } finally { restored.close(); }
});
