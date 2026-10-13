import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ControlPlane, CONTROL_SCHEMA_VERSION } from "../dist/control.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "mission-control-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, path: join(home, "control.sqlite") };
}

function version(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}

function schema(db) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
}

function legacy(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, message_id TEXT NOT NULL,
      attempt INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      epoch INTEGER NOT NULL, created_at TEXT NOT NULL, error TEXT
    );
    INSERT INTO outbox VALUES('old-delivery','old-mission','old-message',1,'old-request','uncertain',2,'2026-01-01T00:00:00Z','original failure');
    CREATE TABLE missions (id TEXT PRIMARY KEY,status TEXT NOT NULL,data TEXT NOT NULL);
    INSERT INTO missions VALUES('old-mission','paused','{"id":"old-mission","status":"paused","turns":121,"maxTurns":300}');
    CREATE TABLE validation_receipts (id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,task_id TEXT NOT NULL,data TEXT NOT NULL);
    INSERT INTO validation_receipts VALUES('old-failure','old-mission','old-task','{"id":"old-failure","exitCode":1,"stderr":"original failure"}');
  `);
  return db;
}

test("fresh schema is versioned and reopening preserves application state", (t) => {
  const f = fixture(t);
  let control = new ControlPlane(f.home);
  try {
    assert.equal(version(control.db), CONTROL_SCHEMA_VERSION);
    control.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?)").run("test", "immutable", "hash", '{"ok":true}', "2026-01-01");
  } finally {
    control.close();
  }
  control = new ControlPlane(f.home);
  try {
    assert.equal(version(control.db), CONTROL_SCHEMA_VERSION);
    assert.equal(control.db.prepare("SELECT response FROM commands WHERE command_id='immutable'").get().response, '{"ok":true}');
    assert.equal(control.db.prepare("SELECT count(*) AS n FROM daemon_owner").get().n, 1);
  } finally {
    control.close();
  }
});

test("legacy migration adds missing columns without rewriting evidence or replaying uncertain delivery", (t) => {
  const f = fixture(t);
  const db = legacy(f.path);
  const beforeMission = db.prepare("SELECT * FROM missions").all();
  const beforeReceipt = db.prepare("SELECT * FROM validation_receipts").all();
  const beforeDelivery = db.prepare("SELECT * FROM outbox").get();
  db.close();
  const control = new ControlPlane(f.home);
  try {
    assert.equal(version(control.db), CONTROL_SCHEMA_VERSION);
    assert.deepEqual(control.db.prepare("SELECT * FROM missions").all(), beforeMission);
    assert.deepEqual(control.db.prepare("SELECT * FROM validation_receipts").all(), beforeReceipt);
    const delivery = control.db.prepare("SELECT * FROM outbox").get();
    for (const key of Object.keys(beforeDelivery)) assert.equal(delivery[key], beforeDelivery[key]);
    assert.equal(delivery.retry_count, 0);
    assert.equal(delivery.deadline_at, null);
    assert.equal(delivery.next_attempt_at, null);
    assert.equal(delivery.result, null);
    assert.equal(control.db.prepare("SELECT count(*) AS n FROM worktrees").get().n, 0);
  } finally {
    control.close();
  }
});

test("schema 3 upgrades to the current schema with durable node registration history", (t) => {
  const f = fixture(t);
  const initial = new ControlPlane(f.home);
  const enrolled = initial.enrollMachine("legacy-node", "Legacy node");
  const unopened = initial.enrollMachine("unopened-node", "Never connected");
  const capabilities = {
    protocol: 1, version: "test", platform: process.platform, arch: process.arch,
    node: process.version, piDurable: "1.1.0", roots: [f.home], credentialRefs: [], executionEnabled: false
  };
  const registrationId = crypto.randomUUID();
  const session = initial.nodeSession(enrolled.machine.id, enrolled.token, capabilities, registrationId);
  const command = initial.probeMachine(enrolled.machine.id, crypto.randomUUID(), f.home);
  initial.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  initial.close();
  const db = new DatabaseSync(f.path);
  db.exec("DROP TABLE IF EXISTS node_registrations; PRAGMA user_version=3");
  db.close();
  const upgraded = new ControlPlane(f.home);
  try {
    assert.equal(version(upgraded.db), CONTROL_SCHEMA_VERSION);
    assert.ok(upgraded.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='node_registrations'").get());
    assert.equal(upgraded.machineRegistry.get(enrolled.machine.id).status, "revoked");
    assert.throws(() => upgraded.nodeSession(enrolled.machine.id, enrolled.token, capabilities, registrationId), /authentication failed/);
    assert.throws(() => upgraded.nodeSession(enrolled.machine.id, enrolled.token, capabilities, crypto.randomUUID()), /authentication failed/);
    assert.equal(upgraded.machineCommand(enrolled.machine.id, command.id).status, "uncertain");
    assert.equal(upgraded.nodeSession(unopened.machine.id, unopened.token, capabilities, crypto.randomUUID()).machine.status, "online");
  } finally {
    upgraded.close();
  }
});

test("failed initialization rolls back all DDL, version changes and ownership, then can retry", (t) => {
  const f = fixture(t);
  let db = legacy(f.path);
  db.exec(`
    CREATE TABLE profiles(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TRIGGER migration_fault BEFORE INSERT ON profiles BEGIN SELECT RAISE(ABORT,'injected migration fault'); END;
  `);
  const beforeSchema = schema(db);
  const beforeRows = db.prepare("SELECT * FROM outbox").all();
  db.close();
  assert.throws(() => new ControlPlane(f.home), /injected migration fault/);
  db = new DatabaseSync(f.path);
  try {
    assert.equal(version(db), 0);
    assert.deepEqual(schema(db), beforeSchema);
    assert.deepEqual(db.prepare("SELECT * FROM outbox").all(), beforeRows);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='daemon_owner'").get(), undefined);
    db.exec("DROP TRIGGER migration_fault");
  } finally {
    db.close();
  }
  const control = new ControlPlane(f.home);
  try {
    assert.equal(version(control.db), CONTROL_SCHEMA_VERSION);
  } finally {
    control.close();
  }
});

test("future schema is rejected before journal mode, schema or bytes are modified", (t) => {
  const f = fixture(t);
  const db = legacy(f.path);
  db.exec(`PRAGMA user_version=${CONTROL_SCHEMA_VERSION + 1}`);
  db.close();
  const before = readFileSync(f.path);
  assert.throws(() => new ControlPlane(f.home), /schema .*not supported.*Automatic downgrade is not supported/);
  assert.deepEqual(readFileSync(f.path), before);
  const check = new DatabaseSync(f.path, { readOnly: true });
  try {
    assert.equal(version(check), CONTROL_SCHEMA_VERSION + 1);
    assert.equal(check.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  } finally {
    check.close();
  }
});

test("a live owner blocks schema migration before any database writes", (t) => {
  const f = fixture(t);
  const db = legacy(f.path);
  db.exec("CREATE TABLE daemon_owner(singleton INTEGER PRIMARY KEY,daemon_id TEXT NOT NULL,epoch INTEGER NOT NULL,pid INTEGER NOT NULL,heartbeat_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO daemon_owner VALUES(1,?,?,?,?)").run("existing-owner", 7, process.pid, Date.now());
  db.close();
  const before = readFileSync(f.path);
  assert.throws(() => new ControlPlane(f.home), /already has an owner.*schema migration is refused/);
  assert.deepEqual(readFileSync(f.path), before);
  const check = new DatabaseSync(f.path, { readOnly: true });
  try {
    assert.equal(version(check), 0);
    assert.equal(check.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
    assert.equal(check.prepare("SELECT daemon_id FROM daemon_owner").get().daemon_id, "existing-owner");
  } finally {
    check.close();
  }
});
