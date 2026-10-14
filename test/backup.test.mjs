import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CONTROL_SCHEMA_VERSION, ControlPlane } from "../dist/control.js";
import { backupHome, restoreHome } from "../dist/backup.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const profile = {
  id: "backup-test-profile",
  name: "Backup test profile",
  api: "openai-completions",
  modelId: "faux-1",
  baseUrl: "http://127.0.0.1:1",
  credentialEnv: "",
  contextWindow: 16000,
  maxTokens: 512,
  reasoning: false,
  toolCalling: true,
  vision: false,
  revision: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mission-control-backup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home: join(realpathSync(root), "home") };
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function initializeHome(home, { worktree = false, workspaceStrategy = "shared" } = {}) {
  const control = new ControlPlane(home);
  control.upsertProfile(profile);
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: `backup-${kind}`, name: kind, kind, instructions: `${kind} instructions`, profileId: profile.id });
  }
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const workspace = control.addWorkspace("backup workspace", workspacePath);
  const mission = control.createMission({
    title: "Backup fixture",
    goal: "Exercise offline backup and restore",
    acceptance: "All fixture rows survive a verified round trip",
    workspaceId: workspace.id,
    roleIds: ["backup-orchestrator", "backup-worker", "backup-validator"],
    maxTurns: 10,
    maxCost: 0,
    autonomy: "trusted",
    workspaceStrategy
  });
  if (worktree) {
    const row = control.db.prepare("SELECT data FROM missions WHERE id=?").get(mission.id);
    const data = JSON.parse(row.data);
    data.workspaceStrategy = "worktree";
    data.repository = { path: join(home, "source-repository"), gitCommonDir: join(home, "source-repository", ".git"), baseCommit: "a".repeat(40) };
    control.db.prepare("UPDATE missions SET data=? WHERE id=?").run(JSON.stringify(data), mission.id);
    control.db.prepare("INSERT INTO worktrees(id,mission_id,status,data) VALUES(?,?,?,?)").run(
      "backup-worktree",
      mission.id,
      "ready",
      JSON.stringify({
        id: "backup-worktree",
        missionId: mission.id,
        kind: "agent",
        path: join(home, "worktrees", mission.id, "agent"),
        branch: "mission/backup",
        baseCommit: "a".repeat(40),
        repositoryPath: join(home, "source-repository"),
        gitCommonDir: join(home, "source-repository", ".git"),
        status: "ready"
      })
    );
  }
  return { control, mission };
}

function seedRows(control, missionId) {
  const message = { id: "backup-message", missionId, senderId: "sender", recipientId: "receiver", content: "fixture", mode: "steer", status: "queued", attempt: 1, createdAt: "2026-01-01T00:00:00.000Z" };
  control.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, missionId, message.status, JSON.stringify(message));
  control.db.prepare("INSERT INTO outbox(id,mission_id,message_id,attempt,request_id,status,epoch,created_at,deadline_at,result) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("backup-outbox", missionId, message.id, 1, "backup-request", "queued", 1, message.createdAt, 123, "preserved-result");
  const uncertainMessage = { ...message, id: "backup-uncertain-message", status: "uncertain", error: "historical uncertainty" };
  control.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(
    uncertainMessage.id, missionId, uncertainMessage.status, JSON.stringify(uncertainMessage)
  );
  control.db.prepare("INSERT INTO outbox(id,mission_id,message_id,attempt,request_id,status,epoch,created_at,deadline_at,result) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("backup-uncertain-outbox", missionId, uncertainMessage.id, 2, "backup-uncertain-request", "uncertain", 1, message.createdAt, null, "historical-result");
  const receipt = { id: "backup-receipt", missionId, taskId: "task", validatorId: "validator", command: "true", stdout: "ok", stderr: "", exitCode: 0, attempt: 1, taskRevision: 1, artifactIds: [], artifactDigests: {}, createdAt: message.createdAt };
  control.db.prepare("INSERT INTO validation_receipts(id,mission_id,task_id,data) VALUES(?,?,?,?)")
    .run(receipt.id, missionId, receipt.taskId, JSON.stringify(receipt));
  const failedReceipt = { ...receipt, id: "backup-failed-receipt", stdout: "", stderr: "failed historically", exitCode: 1, attempt: 2 };
  control.db.prepare("INSERT INTO validation_receipts(id,mission_id,task_id,data) VALUES(?,?,?,?)")
    .run(failedReceipt.id, missionId, failedReceipt.taskId, JSON.stringify(failedReceipt));
}

function tableRows(home, table) {
  const db = new DatabaseSync(join(home, "control.sqlite"), { readOnly: true });
  try { return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); } finally { db.close(); }
}

function fileInventory(root) {
  const files = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = join(directory, entry);
      const path = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(absolute).isDirectory()) visit(absolute, path);
      else {
        const bytes = readFileSync(absolute);
        files.push({ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  };
  visit(root);
  return files;
}

test("backup and restore preserve database rows and bytes while excluding runtime files", async (t) => {
  const f = fixture(t);
  const { control, mission } = initializeHome(f.home);
  seedRows(control, mission.id);
  const activeMission = JSON.parse(control.db.prepare("SELECT data FROM missions WHERE id=?").get(mission.id).data);
  activeMission.status = "active";
  control.db.prepare("UPDATE missions SET status='active',data=? WHERE id=?").run(JSON.stringify(activeMission), mission.id);
  const artifact = Buffer.from([0, 1, 2, 255, 128, 10]);
  const artifactDigest = createHash("sha256").update(artifact).digest("hex");
  writeFileSync(join(f.home, "artifacts", artifactDigest), artifact);
  control.db.prepare("INSERT INTO artifacts(id,mission_id,data) VALUES(?,?,?)").run(
    "backup-artifact",
    mission.id,
    JSON.stringify({
      id: "backup-artifact", missionId: mission.id, agentId: "fixture-agent", name: "payload.bin", path: "payload.bin",
      sha256: artifactDigest, size: artifact.length, createdAt: "2026-01-01T00:00:00.000Z",
      snapshotPath: join(f.home, "artifacts", artifactDigest)
    })
  );
  writeFileSync(join(f.home, "admin.token"), "test-admin-token\n", { mode: 0o600 });
  mkdirSync(join(f.home, "agents"), { recursive: true });
  const agentDb = new DatabaseSync(join(f.home, "agents", "fixture.sqlite"));
  agentDb.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('kept');");
  agentDb.close();
  writeFileSync(join(f.home, "daemon.log"), "not backed up\n");
  writeFileSync(join(f.home, "daemon.json"), JSON.stringify({ pid: 2147483647, port: 65535, daemonId: "00000000-0000-4000-8000-000000000001" }));
  writeFileSync(join(f.home, "worktrees", "do-not-copy"), "local Git state");
  const before = Object.fromEntries(["missions", "messages", "outbox", "validation_receipts"].map((table) => [table, tableRows(f.home, table)]));
  control.close();
  const sourceInventory = fileInventory(f.home);

  const backup = join(f.root, "backup");
  const created = await runCli(["backup", "--home", f.home, "--out", backup]);
  assert.equal(created.code, 0, `${created.stdout}\n${created.stderr}`);
  assert.deepEqual(fileInventory(f.home), sourceInventory);
  const repeatBackup = join(f.root, "backup-repeat");
  const repeatedBackup = await runCli(["backup", "--home", f.home, "--out", repeatBackup]);
  assert.equal(repeatedBackup.code, 0, `${repeatedBackup.stdout}\n${repeatedBackup.stderr}`);
  assert.deepEqual(fileInventory(f.home), sourceInventory);
  assert.match(created.stdout, /Git repositories and worktree directories are not included/);
  assert.deepEqual(readdirSync(backup).sort(), ["admin.token", "agents", "artifacts", "control.sqlite", "manifest.json"]);
  assert.equal(existsSync(join(backup, "daemon.json")), false);
  assert.equal(existsSync(join(backup, "daemon.log")), false);
  assert.equal(existsSync(join(backup, "worktrees")), false);
  assert.equal(statSync(join(backup, "admin.token")).mode & 0o777, 0o600);

  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
  assert.equal(manifest.format, "mission-control-backup");
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.sourceHome, f.home);
  assert.deepEqual(manifest.files.map((file) => file.path), [...manifest.files.map((file) => file.path)].sort());
  for (const file of manifest.files) {
    const bytes = readFileSync(join(backup, file.path));
    assert.equal(bytes.length, file.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
  const originalBackupInventory = fileInventory(backup);

  renameSync(f.home, join(f.root, "old-home"));
  const restored = join(f.root, "restored");
  const result = await runCli(["restore", "--from", backup, "--home", restored]);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Git repositories and worktrees are NOT included/);
  assert.deepEqual(fileInventory(backup), originalBackupInventory);
  const restoredMissionRow = tableRows(restored, "missions")[0];
  const restoredMission = JSON.parse(restoredMissionRow.data);
  assert.equal(restoredMissionRow.status, "blocked");
  assert.equal(restoredMission.status, "blocked");
  assert.equal(restoredMission.title, JSON.parse(before.missions[0].data).title);
  const restoredMessage = tableRows(restored, "messages")[0];
  assert.equal(restoredMessage.id, before.messages[0].id);
  assert.equal(restoredMessage.status, "uncertain");
  assert.equal(JSON.parse(restoredMessage.data).content, JSON.parse(before.messages[0].data).content);
  const restoredOutbox = tableRows(restored, "outbox")[0];
  assert.equal(restoredOutbox.id, before.outbox[0].id);
  assert.equal(restoredOutbox.status, "uncertain");
  assert.equal(restoredOutbox.deadline_at, null);
  assert.equal(restoredOutbox.result, before.outbox[0].result);
  const restoredUncertainMessage = tableRows(restored, "messages").find((row) => row.id === "backup-uncertain-message");
  const originalUncertainMessage = before.messages.find((row) => row.id === "backup-uncertain-message");
  assert.deepEqual(restoredUncertainMessage, originalUncertainMessage);
  const restoredUncertainOutbox = tableRows(restored, "outbox").find((row) => row.id === "backup-uncertain-outbox");
  const originalUncertainOutbox = before.outbox.find((row) => row.id === "backup-uncertain-outbox");
  assert.deepEqual(restoredUncertainOutbox, originalUncertainOutbox);
  assert.deepEqual(tableRows(restored, "validation_receipts"), before.validation_receipts);
  const artifactDb = new DatabaseSync(join(restored, "control.sqlite"), { readOnly: true });
  let restoredArtifact;
  try {
    restoredArtifact = JSON.parse(artifactDb.prepare("SELECT data FROM artifacts WHERE id='backup-artifact'").get().data);
  } finally { artifactDb.close(); }
  assert.equal(restoredArtifact.snapshotPath, join(realpathSync(restored), "artifacts", artifactDigest));
  assert.deepEqual(readFileSync(restoredArtifact.snapshotPath), artifact);
  const blocker = new DatabaseSync(join(restored, "control.sqlite"), { readOnly: true });
  try {
    assert.equal(blocker.prepare("SELECT count(*) AS n FROM blockers WHERE mission_id=? AND status='open' AND data LIKE '%restore-reconciliation%'").get(mission.id).n, 1);
  } finally { blocker.close(); }
  assert.equal(existsSync(join(restored, "daemon.json")), false);
  assert.equal(existsSync(join(restored, "daemon.log")), false);
  assert.equal(statSync(join(restored, "admin.token")).mode & 0o777, 0o600);
  const restoredAgent = new DatabaseSync(join(restored, "agents", "fixture.sqlite"), { readOnly: true });
  try { assert.equal(restoredAgent.prepare("SELECT value FROM fixture").get().value, "kept"); } finally { restoredAgent.close(); }
  const reopened = new ControlPlane(restored);
  try {
    assert.equal(reopened.getMission(mission.id).title, mission.title);
    assert.throws(() => reopened.missionAction(mission.id, "resume"), /Resolve mission blockers before resuming/);
  } finally { reopened.close(); }
  const restoredAgain = join(f.root, "restored-again");
  const repeated = await runCli(["restore", "--from", backup, "--home", restoredAgain]);
  assert.equal(repeated.code, 0, `${repeated.stdout}\n${repeated.stderr}`);
  assert.deepEqual(fileInventory(backup), originalBackupInventory);
  assert.deepEqual(readFileSync(join(restoredAgain, "artifacts", artifactDigest)), artifact);
});

test("backup and restore accept an unpinned draft worktree Mission", async (t) => {
  const f = fixture(t);
  const { control, mission } = initializeHome(f.home, { workspaceStrategy: "worktree" });
  assert.equal(mission.status, "draft");
  assert.equal(mission.repository, undefined);
  writeFileSync(join(f.home, "admin.token"), "draft-worktree-token\n", { mode: 0o600 });
  control.close();

  const backup = join(f.root, "draft-backup");
  const created = await runCli(["backup", "--home", f.home, "--out", backup]);
  assert.equal(created.code, 0, `${created.stdout}\n${created.stderr}`);
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.worktrees, []);
  assert.deepEqual(manifest.worktreeMissions, []);
  const restoredHome = join(f.root, "draft-restored");
  const restored = await runCli(["restore", "--from", backup, "--home", restoredHome]);
  assert.equal(restored.code, 0, `${restored.stdout}\n${restored.stderr}`);
  const reopened = new ControlPlane(restoredHome);
  try { assert.equal(reopened.getMission(mission.id).status, "draft"); } finally { reopened.close(); }
});

test("restore canonicalizes symlinked parent paths before rebasing artifact snapshots", async (t) => {
  const f = fixture(t);
  const { control, mission } = initializeHome(f.home);
  const artifact = Buffer.from("canonical target snapshot");
  const digest = createHash("sha256").update(artifact).digest("hex");
  writeFileSync(join(f.home, "artifacts", digest), artifact);
  control.db.prepare("INSERT INTO artifacts(id,mission_id,data) VALUES(?,?,?)").run(
    "canonical-artifact",
    mission.id,
    JSON.stringify({
      id: "canonical-artifact", missionId: mission.id, agentId: "fixture-agent", name: "canonical.bin", path: "canonical.bin",
      sha256: digest, size: artifact.length, createdAt: "2026-01-01T00:00:00.000Z",
      snapshotPath: join(f.home, "artifacts", digest)
    })
  );
  writeFileSync(join(f.home, "admin.token"), "canonical-target-token\n", { mode: 0o600 });
  control.close();
  const backup = join(f.root, "canonical-backup");
  assert.equal((await runCli(["backup", "--home", f.home, "--out", backup])).code, 0);

  const alias = join(f.root, "parent-alias");
  symlinkSync(f.root, alias);
  const requestedTarget = join(alias, "canonical-restored");
  const canonicalTarget = join(realpathSync(f.root), "canonical-restored");
  const realFinalTarget = join(f.root, "final-target");
  const finalSymlink = join(f.root, "final-target-link");
  mkdirSync(realFinalTarget);
  symlinkSync(realFinalTarget, finalSymlink);
  const finalSymlinkRefused = await runCli(["restore", "--from", backup, "--home", finalSymlink]);
  assert.equal(finalSymlinkRefused.code, 1);
  assert.match(finalSymlinkRefused.stderr, /Restore target must not exist or must be an empty directory/);
  assert.deepEqual(readdirSync(realFinalTarget), []);
  const restored = await runCli(["restore", "--from", backup, "--home", requestedTarget]);
  assert.equal(restored.code, 0, `${restored.stdout}\n${restored.stderr}`);
  assert.match(restored.stdout, new RegExp(canonicalTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const db = new DatabaseSync(join(canonicalTarget, "control.sqlite"), { readOnly: true });
  try {
    const savedArtifact = JSON.parse(db.prepare("SELECT data FROM artifacts WHERE id='canonical-artifact'").get().data);
    assert.equal(savedArtifact.snapshotPath, join(canonicalTarget, "artifacts", digest));
    assert.deepEqual(readFileSync(savedArtifact.snapshotPath), artifact);
  } finally { db.close(); }
});

test("backup refuses a live SQLite owner without creating output", async (t) => {
  const f = fixture(t);
  const { control } = initializeHome(f.home);
  writeFileSync(join(f.home, "admin.token"), "live-owner-token\n", { mode: 0o600 });
  const output = join(f.root, "must-not-exist");
  try {
    const result = await runCli(["backup", "--home", f.home, "--out", output]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /daemon ownership lock is held/);
    assert.equal(existsSync(output), false);
  } finally {
    control.close();
  }
});

test("backup refuses an existing agent ownership lease", async (t) => {
  const f = fixture(t);
  const { control } = initializeHome(f.home);
  writeFileSync(join(f.home, "admin.token"), "worker-lease-token\n", { mode: 0o600 });
  const agentPath = join(f.home, "agents", "fixture.sqlite");
  const agent = new DatabaseSync(agentPath);
  agent.exec("CREATE TABLE fixture(value TEXT)");
  agent.close();
  const lease = new DatabaseSync(`${agentPath}.ownership.sqlite`, { timeout: 0 });
  lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  control.close();
  const output = join(f.root, "leased-backup");
  try {
    const result = await runCli(["backup", "--home", f.home, "--out", output]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already owned by a live worker/);
    assert.equal(existsSync(output), false);
  } finally {
    lease.exec("ROLLBACK");
    lease.close();
  }
});

test("backup refuses control database write-lock contention", async (t) => {
  const f = fixture(t);
  const { control } = initializeHome(f.home);
  writeFileSync(join(f.home, "admin.token"), "control-lock-token\n", { mode: 0o600 });
  control.close();
  const lock = new DatabaseSync(join(f.home, "control.sqlite"), { timeout: 0 });
  lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
  const output = join(f.root, "locked-backup");
  try {
    const result = await runCli(["backup", "--home", f.home, "--out", output]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /offline backup boundary/);
    assert.equal(existsSync(output), false);
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
});

test("schema-zero restore quarantines delivery without migrating until ControlPlane opens", async (t) => {
  const f = fixture(t);
  const { control, mission } = initializeHome(f.home);
  seedRows(control, mission.id);
  const missionData = JSON.parse(control.db.prepare("SELECT data FROM missions WHERE id=?").get(mission.id).data);
  missionData.status = "active";
  control.db.prepare("UPDATE missions SET status='active',data=? WHERE id=?").run(JSON.stringify(missionData), mission.id);
  writeFileSync(join(f.home, "admin.token"), "schema-zero-token\n", { mode: 0o600 });
  control.close();

  const legacy = new DatabaseSync(join(f.home, "control.sqlite"));
  legacy.exec(`
    ALTER TABLE outbox DROP COLUMN retry_count;
    ALTER TABLE outbox DROP COLUMN deadline_at;
    ALTER TABLE outbox DROP COLUMN next_attempt_at;
    ALTER TABLE outbox DROP COLUMN result;
    PRAGMA user_version=0;
  `);
  legacy.close();

  const backup = join(f.root, "schema-zero-backup");
  const made = await runCli(["backup", "--home", f.home, "--out", backup]);
  assert.equal(made.code, 0, `${made.stdout}\n${made.stderr}`);
  const restoredHome = join(f.root, "schema-zero-restored");
  const restored = await runCli(["restore", "--from", backup, "--home", restoredHome]);
  assert.equal(restored.code, 0, `${restored.stdout}\n${restored.stderr}`);
  let check = new DatabaseSync(join(restoredHome, "control.sqlite"), { readOnly: true });
  try {
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 0);
    const columns = check.prepare("PRAGMA table_info(outbox)").all().map((column) => column.name);
    assert.equal(columns.includes("deadline_at"), false);
    assert.equal(check.prepare("SELECT status FROM outbox WHERE id='backup-outbox'").get().status, "uncertain");
    assert.equal(check.prepare("SELECT status FROM messages WHERE id='backup-message'").get().status, "uncertain");
  } finally { check.close(); }

  const reopened = new ControlPlane(restoredHome);
  try {
    assert.equal(reopened.db.prepare("PRAGMA user_version").get().user_version, CONTROL_SCHEMA_VERSION);
    assert.equal(reopened.db.prepare("SELECT status FROM outbox WHERE id='backup-outbox'").get().status, "uncertain");
  } finally { reopened.close(); }
});

test("approved operations and held deliveries remain uncertain after explicit resolution and resume", async (t) => {
  const f = fixture(t);
  const { control, mission } = initializeHome(f.home);
  const started = control.missionAction(mission.id, "start");
  const agentId = started.orchestratorId;
  const marker = join(f.root, "approved-side-effect");
  const approval = {
    id: "backup-approved-operation",
    missionId: mission.id,
    agentId,
    tool: "bash",
    args: { command: `printf replayed > ${marker}` },
    status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z",
    receipt: { stdout: "prior recorded evidence", stderr: "", exitCode: null }
  };
  control.db.prepare("INSERT INTO approvals(id,mission_id,status,data) VALUES(?,?,?,?)")
    .run(approval.id, mission.id, approval.status, JSON.stringify(approval));
  const terminalApproval = {
    id: "backup-terminal-approval", missionId: mission.id, agentId, tool: "bash",
    args: { command: "printf should-not-change" }, status: "failed",
    createdAt: approval.createdAt, receipt: { stdout: "", stderr: "historical failure", exitCode: 1 }
  };
  control.db.prepare("INSERT INTO approvals(id,mission_id,status,data) VALUES(?,?,?,?)")
    .run(terminalApproval.id, mission.id, terminalApproval.status, JSON.stringify(terminalApproval));
  const heldMessage = {
    id: "backup-held-message", missionId: mission.id, senderId: "user", recipientId: agentId,
    content: "A delivery held before the backup", mode: "followUp", status: "aborted", attempt: 3,
    createdAt: approval.createdAt, error: "Held while paused"
  };
  control.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)")
    .run(heldMessage.id, mission.id, heldMessage.status, JSON.stringify(heldMessage));
  control.db.prepare("INSERT INTO outbox(id,mission_id,message_id,attempt,request_id,status,epoch,created_at,deadline_at,result) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("backup-held-outbox", mission.id, heldMessage.id, 3, "backup-held-request", "aborted", 1, approval.createdAt, 456, "held-result");
  writeFileSync(join(f.home, "admin.token"), "approval-quarantine-token\n", { mode: 0o600 });
  control.close();

  const backup = join(f.root, "approval-backup");
  assert.equal((await runCli(["backup", "--home", f.home, "--out", backup])).code, 0);
  renameSync(f.home, join(f.root, "old-home"));
  mkdirSync(join(f.home, "workspace"), { recursive: true });
  const restoredHome = join(f.root, "approval-restored");
  const restored = await runCli(["restore", "--from", backup, "--home", restoredHome]);
  assert.equal(restored.code, 0, `${restored.stdout}\n${restored.stderr}`);

  const reopened = new ControlPlane(restoredHome);
  try {
    const pendingApproval = reopened.db.prepare("SELECT status,data FROM approvals WHERE id=?").get(approval.id);
    assert.equal(pendingApproval.status, "uncertain");
    const restoredApproval = JSON.parse(pendingApproval.data);
    assert.deepEqual(restoredApproval.args, approval.args);
    assert.deepEqual(restoredApproval.receipt, approval.receipt);
    assert.deepEqual(JSON.parse(reopened.db.prepare("SELECT data FROM approvals WHERE id=?").get(terminalApproval.id).data), terminalApproval);
    assert.equal(reopened.db.prepare("SELECT status FROM messages WHERE id=?").get(heldMessage.id).status, "uncertain");
    assert.equal(reopened.blockers(mission.id).some((item) => item.id === `approval:${approval.id}` && item.status === "open"), true);
    const heldOutbox = reopened.db.prepare("SELECT status,deadline_at,result FROM outbox WHERE id='backup-held-outbox'").get();
    assert.equal(heldOutbox.status, "uncertain");
    assert.equal(heldOutbox.deadline_at, null);
    assert.equal(heldOutbox.result, "held-result");
    assert.equal(reopened.blockers(mission.id).find(item => item.id === "delivery:backup-held-outbox")?.status, "open");
    const unreconciled = reopened.db.prepare(`SELECT o.id FROM outbox o LEFT JOIN blockers b ON b.id='delivery:' || o.id
      WHERE o.mission_id=? AND o.status='uncertain' AND b.id IS NULL`).all(mission.id);
    assert.deepEqual(unreconciled, []);

    for (const blocker of reopened.blockers(mission.id).filter((item) => item.status === "open")) {
      reopened.resolveBlocker(blocker.id, "Reviewed the real workspace; do not replay the uncertain operation.");
    }
    reopened.missionAction(mission.id, "resume");
    await reopened.executeApprovedPending(mission.id);
    assert.equal(existsSync(marker), false);
    assert.equal(reopened.db.prepare("SELECT status FROM approvals WHERE id=?").get(approval.id).status, "uncertain");
    assert.equal(reopened.db.prepare("SELECT status FROM messages WHERE id=?").get(heldMessage.id).status, "uncertain");
    assert.equal(reopened.db.prepare("SELECT status FROM outbox WHERE id='backup-held-outbox'").get().status, "uncertain");
  } finally { reopened.close(); }
});

test("restore rejects changed digests and unlisted files before creating its target", async (t) => {
  const f = fixture(t);
  const { control } = initializeHome(f.home);
  writeFileSync(join(f.home, "admin.token"), "tamper-test-token\n", { mode: 0o600 });
  writeFileSync(join(f.home, "artifacts", "payload.txt"), "original");
  control.close();
  const backup = join(f.root, "backup");
  const made = await runCli(["backup", "--home", f.home, "--out", backup]);
  assert.equal(made.code, 0, made.stderr);

  writeFileSync(join(backup, "artifacts", "payload.txt"), "tampered");
  const tamperedTarget = join(f.root, "tampered-target");
  const tampered = await runCli(["restore", "--from", backup, "--home", tamperedTarget]);
  assert.equal(tampered.code, 1);
  assert.match(tampered.stderr, /unlisted file|size or SHA-256 verification/);
  assert.equal(existsSync(tamperedTarget), false);

  const extraBackup = join(f.root, "extra-backup");
  cpSync(backup, extraBackup, { recursive: true });
  writeFileSync(join(extraBackup, "extra.txt"), "unlisted");
  const extraTarget = join(f.root, "extra-target");
  const extra = await runCli(["restore", "--from", extraBackup, "--home", extraTarget]);
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /unlisted file/);
  assert.equal(existsSync(extraTarget), false);
});

test("restore refuses a non-empty target without changing it", async (t) => {
  const f = fixture(t);
  const { control } = initializeHome(f.home);
  writeFileSync(join(f.home, "admin.token"), "target-test-token\n", { mode: 0o600 });
  control.close();
  const backup = join(f.root, "backup");
  assert.equal((await runCli(["backup", "--home", f.home, "--out", backup])).code, 0);
  const target = join(f.root, "non-empty");
  mkdirSync(target);
  writeFileSync(join(target, "sentinel"), "unchanged");
  const result = await runCli(["restore", "--from", backup, "--home", target]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not empty; refusing to overwrite/);
  assert.equal(readFileSync(join(target, "sentinel"), "utf8"), "unchanged");
  assert.deepEqual(readdirSync(target), ["sentinel"]);
});

test("worktree backups restore only to the original home after it is moved aside", async (t) => {
  const f = fixture(t);
  const { control } = initializeHome(f.home, { worktree: true });
  writeFileSync(join(f.home, "admin.token"), "worktree-test-token\n", { mode: 0o600 });
  control.close();
  const backup = join(f.root, "backup");
  assert.equal((await runCli(["backup", "--home", f.home, "--out", backup])).code, 0);
  const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
  assert.equal(manifest.worktrees.length, 1);
  assert.equal(manifest.worktreeMissions.length, 1);

  const metadataTamperedBackup = join(f.root, "metadata-tampered-backup");
  cpSync(backup, metadataTamperedBackup, { recursive: true });
  const metadataManifestPath = join(metadataTamperedBackup, "manifest.json");
  const metadataManifest = JSON.parse(readFileSync(metadataManifestPath, "utf8"));
  metadataManifest.worktrees = [];
  metadataManifest.worktreeMissions = [];
  writeFileSync(metadataManifestPath, `${JSON.stringify(metadataManifest, null, 2)}\n`);
  const metadataTarget = join(f.root, "metadata-target");
  const metadataRefused = await runCli(["restore", "--from", metadataTamperedBackup, "--home", metadataTarget]);
  assert.equal(metadataRefused.code, 1);
  assert.match(metadataRefused.stderr, /manifest worktree metadata does not match the verified control database/);
  assert.equal(existsSync(metadataTarget), false);

  const otherTarget = join(f.root, "wrong-home");
  const refused = await runCli(["restore", "--from", backup, "--home", otherTarget]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /bound to .*restore there after moving the old home aside/);
  assert.equal(existsSync(otherTarget), false);

  renameSync(f.home, join(f.root, "old-home"));
  const alias = join(f.root, "worktree-home-alias");
  symlinkSync(f.root, alias);
  const restored = await runCli(["restore", "--from", backup, "--home", join(alias, "home")]);
  assert.equal(restored.code, 0, `${restored.stdout}\n${restored.stderr}`);
  const reopened = new ControlPlane(f.home);
  try { assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM worktrees").get().n, 1); } finally { reopened.close(); }
});

test("restored backups revoke node authorization and quarantine queued and dispatched probes", async (t) => {
  const f = fixture(t);
  const source = join(f.root, "node-source");
  mkdirSync(source);
  const control = new ControlPlane(source);
  const enrolled = control.enrollMachine("restore-node", "Restore Node");
  const capabilities = {
    protocol: 1, version: "test", platform: process.platform, arch: process.arch,
    node: process.version, piDurable: "1.1.0", roots: [source], credentialRefs: [], executionEnabled: false
  };
  const session = control.nodeSession("restore-node", enrolled.token, capabilities, "restore-registration");
  const dispatched = control.probeMachine("restore-node", "11111111-1111-4111-8111-111111111111", source);
  assert.equal(control.machineRegistry.poll("restore-node", enrolled.token, session.sessionId, session.sessionEpoch, 1).commands[0].id, dispatched.id);
  const queued = control.probeMachine("restore-node", "22222222-2222-4222-8222-222222222222", join(source, "other"));
  writeFileSync(join(source, "admin.token"), "node-backup-test-token\n", { mode: 0o600 });
  control.close();

  const backup = join(f.root, "node-backup");
  await backupHome(source, backup, "0.1.0", async () => {});
  const restoredHome = join(f.root, "node-restored");
  restoreHome(backup, restoredHome);
  const restored = new ControlPlane(restoredHome);
  try {
    assert.equal(restored.machineRegistry.get("restore-node").status, "revoked");
    assert.equal(restored.machineCommand("restore-node", dispatched.id).status, "uncertain");
    assert.equal(restored.machineCommand("restore-node", queued.id).status, "cancelled");
    assert.throws(() => restored.nodeSession("restore-node", enrolled.token, capabilities, "new-registration"), /Node authentication failed/);
  } finally {
    restored.close();
  }
});
