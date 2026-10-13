import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { startServer } from "../dist/server.js";

const profile = {
  id: "watchdog-faux-profile",
  name: "Watchdog test profile",
  api: "openai-completions",
  modelId: "faux-1",
  baseUrl: "http://127.0.0.1:9999",
  credentialEnv: "",
  contextWindow: 16000,
  maxTokens: 512,
  reasoning: false,
  toolCalling: true,
  vision: false,
  revision: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

function baseFixture({ draft = false, taskCount = 1, maxTurns = 20, maxCost = 2 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mission-control-watchdog-"));
  const stateHome = join(root, "state");
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const control = new ControlPlane(stateHome);
  control.upsertProfile(profile);
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: `watchdog-${kind}`, name: kind, kind, instructions: `${kind} test role`, profileId: profile.id });
  }
  const workspace = control.addWorkspace("watchdog test workspace", workspacePath);
  let mission = control.createMission({
    title: "Watchdog test Mission",
    goal: "Exercise watchdog persistence",
    acceptance: "The watchdog remains safe",
    workspaceId: workspace.id,
    roleIds: ["watchdog-orchestrator", "watchdog-worker", "watchdog-validator"],
    maxTurns,
    maxCost,
    autonomy: "trusted"
  });
  let orchestrator;
  if (!draft) {
    mission = control.missionAction(mission.id, "start");
    orchestrator = control.getAgentPublic(mission.orchestratorId);
    setAgentStatus(control, orchestrator.id, "idle");
    orchestrator = control.getAgentPublic(orchestrator.id);
    control.db.prepare("UPDATE outbox SET status='completed' WHERE message_id=?").run(`mission-opening:${mission.id}`);
  }
  const tasks = [];
  if (!draft && taskCount > 0) {
    for (let index = 0; index < taskCount; index += 1) {
      tasks.push(control.createTask(orchestrator.id, orchestrator.epoch, `watchdog-task-${index}`, {
        missionId: mission.id,
        title: `Pending task ${index}`,
        description: `Description ${index}`,
        acceptance: `Accept ${index}`,
        dependencies: []
      }));
    }
  }
  return { root, stateHome, workspacePath, control, workspace, mission, orchestrator, tasks };
}

function cleanup(f) {
  try {
    f.control.close();
  } catch {}
  rmSync(f.root, { recursive: true, force: true });
}

function setAgentStatus(control, agentId, status) {
  const row = control.db.prepare("SELECT data FROM agents WHERE id=?").get(agentId);
  const agent = JSON.parse(row.data);
  const updated = { ...agent, status, updatedAt: new Date().toISOString() };
  control.db.prepare("UPDATE agents SET status=?,data=? WHERE id=?").run(status, JSON.stringify(updated), agentId);
}

function setMissionStatus(control, missionId, status, changes = {}) {
  const row = control.db.prepare("SELECT data FROM missions WHERE id=?").get(missionId);
  const mission = { ...JSON.parse(row.data), ...changes, status };
  control.db.prepare("UPDATE missions SET status=?,data=? WHERE id=?").run(status, JSON.stringify(mission), missionId);
  return mission;
}

function setTaskStatus(control, taskId, status) {
  const row = control.db.prepare("SELECT data FROM tasks WHERE id=?").get(taskId);
  const task = { ...JSON.parse(row.data), status };
  control.db.prepare("UPDATE tasks SET status=?,data=? WHERE id=?").run(status, JSON.stringify(task), taskId);
}

function addBlocker(control, { id, missionId, kind = "delivery", status = "resolved" }) {
  const blocker = { id, missionId, kind, status, text: "Test-only human resolution", createdAt: new Date().toISOString(), ...(status === "resolved" ? { resolvedAt: new Date().toISOString() } : {}) };
  control.db.prepare("INSERT INTO blockers(id,mission_id,status,data) VALUES(?,?,?,?)")
    .run(id, missionId, status, JSON.stringify(blocker));
  return blocker;
}

function markOutboxStatus(control, messageId, status) {
  control.db.prepare("UPDATE outbox SET status=? WHERE message_id=?").run(status, messageId);
}

const clock = Date.parse("2032-04-05T06:07:08.000Z");

test("watchdog observes by default, preserves identity through config/reopen, and rearms only for semantic progress", () => {
  const f = baseFixture();
  try {
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS n FROM watchdog_state").get().n, 0);
    const defaultState = f.control.watchdog(f.mission.id);
    assert.deepEqual({
      autoWake: defaultState.autoWake,
      revision: defaultState.revision,
      diagnosis: defaultState.diagnosis,
      pendingTaskIds: defaultState.pendingTaskIds,
      idleThresholdMs: defaultState.idleThresholdMs,
      runningThresholdMs: defaultState.runningThresholdMs
    }, {
      autoWake: false,
      revision: 1,
      diagnosis: "not_observed",
      pendingTaskIds: [],
      idleThresholdMs: 60_000,
      runningThresholdMs: 600_000
    });
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS n FROM watchdog_state").get().n, 0, "reading the default must not persist it");

    f.control.tickWatchdogs(clock);
    const firstObservation = f.control.watchdog(f.mission.id);
    assert.equal(firstObservation.diagnosis, "observing");
    assert.equal(firstObservation.progressSince, new Date(clock).toISOString());
    assert.equal(firstObservation.eligibleSince, new Date(clock).toISOString());
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 0, "observe-only is the default");

    const enabled = f.control.configureWatchdog(f.mission.id, "watchdog-enable", 1, true);
    assert.equal(enabled.revision, 2);
    assert.equal(enabled.eligibleSince, firstObservation.eligibleSince, "configuration must preserve the observation window");
    f.control.tickWatchdogs(clock + 59_999);
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 0);
    f.control.tickWatchdogs(clock + 60_000);

    let wakes = f.control.watchdogWakes(f.mission.id);
    assert.equal(wakes.length, 1);
    const originalWake = wakes[0];
    assert.equal(originalWake.id, `watchdog-wake:${f.mission.id}:${originalWake.fingerprint}`);
    assert.equal(originalWake.messageId, `watchdog-message:${f.mission.id}:${originalWake.fingerprint}`);
    assert.equal(originalWake.requestId, `${originalWake.messageId}:1`);
    assert.equal(originalWake.attempt, 1);
    const messageRow = f.control.db.prepare("SELECT data FROM messages WHERE id=?").get(originalWake.messageId);
    assert.equal(JSON.parse(messageRow.data).recipientId, f.mission.orchestratorId);
    assert.equal(JSON.parse(messageRow.data).content, [
      "Mission watchdog: pending tasks have remained unchanged while the whole team was idle for at least 60 seconds.",
      "This is one new bounded recovery input, NOT a retry of any earlier operation.",
      "Call GetMissionState once, inspect the existing tasks and evidence, then advance one actionable task using the original team, or use RequestUserInput to explain a concrete blocker.",
      "Do not poll, send acknowledgement-only messages, spawn replacement agents merely to retry, or replay uncertain operations. Normal approval, budget, independent validation and completion gates still apply.",
      "If waiting, call WaitForMessage alone. If reporting a real outcome, call Report alone. Each ends this run. A report or this input is not acceptance evidence."
    ].join("\n"));
    const outbox = f.control.db.prepare("SELECT id,status,message_id,attempt,request_id FROM outbox WHERE message_id=?").get(originalWake.messageId);
    assert.deepEqual({ status: outbox.status, messageId: outbox.message_id, attempt: outbox.attempt, requestId: outbox.request_id }, {
      status: "queued", messageId: originalWake.messageId, attempt: 1, requestId: originalWake.requestId
    });
    assert.equal(f.control.detail(f.mission.id).watchdogWakes[0].deliveryStatus, "queued");
    assert.equal(f.control.exportMission(f.mission.id).watchdogWakes[0].deliveryStatus, "queued");

    const originalOutboxId = f.control.db.prepare("SELECT id FROM outbox WHERE message_id=?").get(originalWake.messageId).id;
    f.control.db.prepare("UPDATE outbox SET status='uncertain' WHERE id=?").run(originalOutboxId);
    addBlocker(f.control, { id: `delivery:${originalOutboxId}`, missionId: f.mission.id, kind: "delivery", status: "resolved" });
    f.control.tickWatchdogs(clock + 60_005);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "needs_attention");
    assert.equal(f.control.watchdogWakes(f.mission.id)[0].deliveryStatus, "uncertain");
    f.control.updateTask(f.orchestrator.id, f.orchestrator.epoch, "same-task-revision", f.tasks[0].id, { title: f.tasks[0].title });
    const unrelated = f.control.sendMessage(f.mission.id, f.orchestrator.id, "A separate user message", "followUp", "watchdog-unrelated-message");
    markOutboxStatus(f.control, unrelated.id, "completed");
    f.control.db.prepare("INSERT INTO events(mission_id,type,data) VALUES(?,?,?)").run(
      f.mission.id, "agent_report", JSON.stringify({ missionId: f.mission.id, type: "agent_report", text: "A report is not progress", createdAt: new Date().toISOString() })
    );
    f.control.tickWatchdogs(clock + 60_010);
    assert.equal(f.control.watchdog(f.mission.id).fingerprint, originalWake.fingerprint, "revision, message, and report changes are excluded");
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "needs_attention");
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 1);

    const disabled = f.control.configureWatchdog(f.mission.id, "watchdog-disable", 2, false);
    assert.equal(disabled.revision, 3);
    assert.equal(disabled.fingerprint, originalWake.fingerprint);
    assert.equal(disabled.progressSince, firstObservation.progressSince);
    const reenabled = f.control.configureWatchdog(f.mission.id, "watchdog-reenable", 3, true);
    assert.equal(reenabled.revision, 4);
    f.control.tickWatchdogs(clock + 60_020);
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 1, "toggling auto-wake cannot rearm a used fingerprint");

    f.control.close();
    f.control = new ControlPlane(f.stateHome);
    f.orchestrator = f.control.getAgentPublic(f.mission.orchestratorId);
    f.control.tickWatchdogs(clock + 60_030);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "offline", "restart recovery is not idle");
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 1);
    setAgentStatus(f.control, f.orchestrator.id, "idle");
    f.orchestrator = f.control.getAgentPublic(f.orchestrator.id);
    f.control.tickWatchdogs(clock + 60_040);
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 1, "reopen retains the immutable wake ledger");

    f.control.updateTask(f.orchestrator.id, f.orchestrator.epoch, "semantic-task-change", f.tasks[0].id, { title: "A genuinely changed task" });
    f.control.tickWatchdogs(clock + 70_000);
    assert.notEqual(f.control.watchdog(f.mission.id).fingerprint, originalWake.fingerprint);
    assert.equal(f.control.watchdog(f.mission.id).eligibleSince, new Date(clock + 70_000).toISOString());
    f.control.tickWatchdogs(clock + 129_999);
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 1);
    f.control.tickWatchdogs(clock + 130_000);
    wakes = f.control.watchdogWakes(f.mission.id);
    assert.equal(wakes.length, 2);
    assert.notEqual(wakes[1].fingerprint, originalWake.fingerprint);
  } finally {
    cleanup(f);
  }
});

test("watchdog fingerprint sorts semantic data and deduplicates identical artifact task digests", () => {
  const f = baseFixture({ taskCount: 2 });
  try {
    let worker = f.control.createAgent(f.mission.id, "Artifact owner", "watchdog-worker", "", "watchdog-artifact-owner");
    setAgentStatus(f.control, worker.id, "idle");
    worker = f.control.getAgentPublic(worker.id);
    f.control.updateTask(f.orchestrator.id, f.orchestrator.epoch, "assign-artifact-task", f.tasks[0].id, { ownerId: worker.id });
    const taskRow = f.control.db.prepare("SELECT data FROM tasks WHERE id=?").get(f.tasks[0].id);
    const taskData = JSON.parse(taskRow.data);
    taskData.dependencies = [f.tasks[0].id, f.tasks[1].id];
    taskData.fulfills = ["REQ-B", "REQ-A"];
    f.control.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(taskData), f.tasks[0].id);
    const first = f.control.publishArtifact(worker.id, worker.epoch, "watchdog-artifact-one", "one", join(f.workspacePath, "one.txt"), Buffer.from("identical bytes"), f.tasks[0].id);
    f.control.tickWatchdogs(clock);
    const firstFingerprint = f.control.watchdog(f.mission.id).fingerprint;
    f.control.publishArtifact(worker.id, worker.epoch, "watchdog-unassigned-artifact", "unassigned", join(f.workspacePath, "unassigned.txt"), Buffer.from("unrelated bytes"));
    f.control.tickWatchdogs(clock + 1);
    assert.equal(f.control.watchdog(f.mission.id).fingerprint, firstFingerprint, "unassigned artifacts are not progress for this Mission");
    const duplicate = f.control.publishArtifact(worker.id, worker.epoch, "watchdog-artifact-two", "renamed copy", join(f.workspacePath, "two.txt"), Buffer.from("identical bytes"), f.tasks[0].id);
    assert.notEqual(first.id, duplicate.id);
    assert.equal(first.sha256, duplicate.sha256);
    f.control.tickWatchdogs(clock + 2);
    assert.equal(f.control.watchdog(f.mission.id).fingerprint, firstFingerprint);

    const taskRows = f.control.db.prepare("SELECT id,status,data FROM tasks WHERE mission_id=?").all(f.mission.id);
    f.control.db.prepare("DELETE FROM tasks WHERE mission_id=?").run(f.mission.id);
    for (const row of [...taskRows].reverse()) {
      const data = JSON.parse(row.data);
      if (data.id === f.tasks[0].id) {
        data.dependencies.reverse();
        data.fulfills.reverse();
      }
      f.control.db.prepare("INSERT INTO tasks(id,mission_id,status,data) VALUES(?,?,?,?)").run(row.id, f.mission.id, row.status, JSON.stringify(data));
    }
    f.control.tickWatchdogs(clock + 3);
    assert.equal(f.control.watchdog(f.mission.id).fingerprint, firstFingerprint, "task and semantic array ordering is irrelevant");

    const taskProgress = f.control.publishArtifact(worker.id, worker.epoch, "watchdog-task-artifact-progress", "new bytes", join(f.workspacePath, "new.txt"), Buffer.from("new task bytes"), f.tasks[0].id);
    assert.notEqual(first.sha256, taskProgress.sha256);
    f.control.tickWatchdogs(clock + 4);
    assert.notEqual(f.control.watchdog(f.mission.id).fingerprint, firstFingerprint, "a task-bound digest is substantive progress");
    const withTaskArtifact = f.control.watchdog(f.mission.id).fingerprint;

    f.control.db.prepare("INSERT INTO validation_receipts(id,mission_id,task_id,data) VALUES(?,?,?,?)")
      .run("watchdog-receipt-new", f.mission.id, f.tasks[0].id, JSON.stringify({ id: "watchdog-receipt-new" }));
    f.control.tickWatchdogs(clock + 5);
    assert.notEqual(f.control.watchdog(f.mission.id).fingerprint, withTaskArtifact, "receipt identity is substantive progress");
    const withReceipt = f.control.watchdog(f.mission.id).fingerprint;
    const mission = f.control.missionById(f.mission.id);
    setMissionStatus(f.control, f.mission.id, mission.status, { contractRevision: mission.contractRevision + 1 });
    f.control.tickWatchdogs(clock + 6);
    assert.notEqual(f.control.watchdog(f.mission.id).fingerprint, withReceipt, "contract revision is substantive progress");
  } finally {
    cleanup(f);
  }
});

test("watchdog diagnoses Mission, blocker, pending-task, and budget safety gates", () => {
  const f = baseFixture({ taskCount: 2, maxTurns: 1 });
  try {
    f.control.tickWatchdogs(clock);
    f.control.configureWatchdog(f.mission.id, "watchdog-safety-enable", 1, true);
    const mission = f.control.missionById(f.mission.id);
    setMissionStatus(f.control, f.mission.id, "active", { ...mission, turns: mission.maxTurns });
    f.control.tickWatchdogs(clock + 1);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "budget_exhausted");

    setMissionStatus(f.control, f.mission.id, "active", { turns: 0 });
    const missionAtCostLimit = f.control.missionById(f.mission.id);
    setMissionStatus(f.control, f.mission.id, "active", { cost: missionAtCostLimit.maxCost });
    f.control.tickWatchdogs(clock + 2);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "budget_exhausted");
    setMissionStatus(f.control, f.mission.id, "active", { cost: 0 });
    setTaskStatus(f.control, f.tasks[0].id, "blocked");
    f.control.tickWatchdogs(clock + 3);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "blocked", "any blocked task suppresses wake");
    assert.deepEqual(f.control.watchdog(f.mission.id).pendingTaskIds, [f.tasks[1].id]);
    setTaskStatus(f.control, f.tasks[1].id, "blocked");
    f.control.tickWatchdogs(clock + 4);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "blocked", "all-blocked is not completion");
    f.control.db.prepare("DELETE FROM tasks WHERE mission_id=?").run(f.mission.id);
    f.control.tickWatchdogs(clock + 5);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "no_pending_tasks");
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 0);

    const generic = baseFixture();
    try {
      generic.control.tickWatchdogs(clock);
      addBlocker(generic.control, { id: "unsafe-test", missionId: generic.mission.id, kind: "unsafe_execution", status: "open" });
      setMissionStatus(generic.control, generic.mission.id, "blocked");
      generic.control.tickWatchdogs(clock + 1);
      assert.equal(generic.control.watchdog(generic.mission.id).diagnosis, "blocked");
      const userBlocker = addBlocker(generic.control, { id: "user-test", missionId: generic.mission.id, kind: "user_input", status: "open" });
      generic.control.tickWatchdogs(clock + 2);
      assert.equal(generic.control.watchdog(generic.mission.id).diagnosis, "waiting_user");
      const resolvedUser = { ...userBlocker, status: "resolved", resolvedAt: new Date().toISOString() };
      generic.control.db.prepare("UPDATE blockers SET status='resolved',data=? WHERE id=?").run(JSON.stringify(resolvedUser), userBlocker.id);
      const approvalBlocker = addBlocker(generic.control, { id: "approval-test", missionId: generic.mission.id, kind: "approval", status: "open" });
      generic.control.tickWatchdogs(clock + 3);
      assert.equal(generic.control.watchdog(generic.mission.id).diagnosis, "waiting_approval");
      const resolvedApproval = { ...approvalBlocker, status: "resolved", resolvedAt: new Date().toISOString() };
      generic.control.db.prepare("UPDATE blockers SET status='resolved',data=? WHERE id=?").run(JSON.stringify(resolvedApproval), approvalBlocker.id);
    } finally {
      cleanup(generic);
    }

    for (const status of ["draft", "paused", "failed", "completed", "cancelled"]) {
      const gated = baseFixture();
      try {
        gated.control.tickWatchdogs(clock);
        setMissionStatus(gated.control, gated.mission.id, status);
        gated.control.tickWatchdogs(clock + 1);
        assert.equal(gated.control.watchdog(gated.mission.id).diagnosis, "mission_inactive", `${status} must not wake`);
        assert.equal(gated.control.watchdogWakes(gated.mission.id).length, 0);
        if (status === "completed" || status === "cancelled") {
          assert.throws(() => gated.control.configureWatchdog(gated.mission.id, "terminal-config", 1, true), /completed or cancelled/);
        }
      } finally {
        cleanup(gated);
      }
    }
  } finally {
    cleanup(f);
  }
});

test("watchdog requires every agent to be idle and uses fresh runningSince after pause or offline", () => {
  const f = baseFixture();
  try {
    f.control.configureWatchdog(f.mission.id, "watchdog-busy-enable", 1, true);
    const statuses = [
      ["waiting_user", "waiting_user"],
      ["waiting_approval", "waiting_approval"],
      ["offline", "offline"],
      ["error", "offline"],
      ["recovering", "offline"]
    ];
    for (const [status, diagnosis] of statuses) {
      setAgentStatus(f.control, f.orchestrator.id, status);
      f.control.tickWatchdogs(clock);
      assert.equal(f.control.watchdog(f.mission.id).diagnosis, diagnosis);
      assert.equal(f.control.watchdogWakes(f.mission.id).length, 0);
    }

    setAgentStatus(f.control, f.orchestrator.id, "running");
    f.control.tickWatchdogs(clock + 1);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "running");
    assert.equal(f.control.watchdog(f.mission.id).runningSince, new Date(clock + 1).toISOString());
    setMissionStatus(f.control, f.mission.id, "paused");
    f.control.tickWatchdogs(clock + 86_400_000);
    assert.equal(f.control.watchdog(f.mission.id).runningSince, undefined);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "mission_inactive");

    setMissionStatus(f.control, f.mission.id, "active");
    setAgentStatus(f.control, f.orchestrator.id, "offline");
    f.control.tickWatchdogs(clock + 86_400_001);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "offline");
    setAgentStatus(f.control, f.orchestrator.id, "running");
    f.control.tickWatchdogs(clock + 86_400_002);
    assert.equal(f.control.watchdog(f.mission.id).runningSince, new Date(clock + 86_400_002).toISOString());
    f.control.tickWatchdogs(clock + 86_400_002 + 599_999);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "running");
    f.control.tickWatchdogs(clock + 86_400_002 + 600_000);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "running_no_progress");
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 0, "long-running diagnosis is advisory");

    setAgentStatus(f.control, f.orchestrator.id, "idle");
    f.control.tickWatchdogs(clock + 86_400_003 + 600_000);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "observing");
    const future = clock + 86_400_003 + 600_000;
    f.control.tickWatchdogs(future - 1);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "observing", "a backward clock jump restarts observation");
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 0);
  } finally {
    cleanup(f);
  }
});

test("watchdog describes live execution and offline state without delivery masking", () => {
  const f = baseFixture();
  try {
    const admittedMessage = f.control.sendMessage(f.mission.id, f.orchestrator.id, "Run the bounded task.", "followUp", "watchdog-running-message");
    const admittedOutbox = f.control.db.prepare("SELECT id,request_id,attempt FROM outbox WHERE message_id=?").get(admittedMessage.id);
    assert.equal(f.control.markOutboxDispatching(admittedOutbox.id, f.orchestrator.epoch), true);
    assert.equal(f.control.ackOutbox(admittedMessage.id, admittedOutbox.request_id, admittedOutbox.attempt, f.orchestrator.epoch, "admitted"), true);
    setAgentStatus(f.control, f.orchestrator.id, "running");
    f.control.tickWatchdogs(clock);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "running");
    f.control.tickWatchdogs(clock + 600_000);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "running_no_progress");
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 0);
    assert.equal(f.control.db.prepare("SELECT status FROM outbox WHERE id=?").get(admittedOutbox.id).status, "admitted");

    const queuedMessage = f.control.sendMessage(f.mission.id, f.orchestrator.id, "Queue another bounded input.", "followUp", "watchdog-queued-message");
    const queuedOutbox = f.control.db.prepare("SELECT id,status FROM outbox WHERE message_id=?").get(queuedMessage.id);
    setAgentStatus(f.control, f.orchestrator.id, "offline");
    f.control.tickWatchdogs(clock + 600_001);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "offline");
    assert.equal(f.control.db.prepare("SELECT status FROM outbox WHERE id=?").get(queuedOutbox.id).status, "queued");

    f.control.db.prepare("UPDATE outbox SET status='uncertain' WHERE id=?").run(queuedOutbox.id);
    f.control.tickWatchdogs(clock + 600_002);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "delivery_pending", "unresolved uncertain delivery remains high priority");
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 0);
  } finally {
    cleanup(f);
  }
});

test("watchdog persists isolated observation errors, deduplicates failures, and recovers with a fresh window", () => {
  const f = baseFixture();
  let secondMission;
  try {
    f.control.configureWatchdog(f.mission.id, "watchdog-error-enable", 1, true);
    secondMission = f.control.createMission({
      title: "Watchdog second Mission",
      goal: "Prove one failed observation does not stop another Mission",
      acceptance: "The second Mission is observed",
      workspaceId: f.workspace.id,
      roleIds: ["watchdog-orchestrator", "watchdog-worker", "watchdog-validator"],
      maxTurns: 20,
      maxCost: 2,
      autonomy: "trusted"
    });
    secondMission = f.control.missionAction(secondMission.id, "start");
    const secondOrchestrator = f.control.getAgentPublic(secondMission.orchestratorId);
    setAgentStatus(f.control, secondOrchestrator.id, "idle");
    const secondIdleOrchestrator = f.control.getAgentPublic(secondOrchestrator.id);
    f.control.db.prepare("UPDATE outbox SET status='completed' WHERE message_id=?").run(`mission-opening:${secondMission.id}`);
    f.control.createTask(secondIdleOrchestrator.id, secondIdleOrchestrator.epoch, "watchdog-second-task", {
      missionId: secondMission.id,
      title: "Second pending task",
      description: "A second Mission remains independently observable",
      acceptance: "It is seen",
      dependencies: []
    });
    f.control.tickWatchdogs(clock);
    const before = f.control.watchdog(f.mission.id);
    const beforeOutbox = f.control.db.prepare("SELECT id,status,attempt,request_id FROM outbox WHERE mission_id=? ORDER BY id").all(f.mission.id);
    const originalFingerprint = f.control.watchdogFingerprint;
    f.control.watchdogFingerprint = function (mission) {
      if (mission.id === f.mission.id) throw new Error("secret watchdog failure must not leak");
      return originalFingerprint.call(this, mission);
    };

    assert.equal(f.control.tickWatchdogs(clock + 1), 1, "the second Mission still gets processed");
    const failed = f.control.watchdog(f.mission.id);
    assert.equal(failed.diagnosis, "observation_error");
    assert.equal(failed.autoWake, true);
    assert.equal(failed.revision, before.revision);
    assert.equal(failed.fingerprint, before.fingerprint);
    assert.equal(failed.progressSince, before.progressSince);
    assert.equal(failed.eligibleSince, undefined);
    assert.equal(failed.runningSince, undefined);
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 0);
    assert.deepEqual(f.control.db.prepare("SELECT id,status,attempt,request_id FROM outbox WHERE mission_id=? ORDER BY id").all(f.mission.id), beforeOutbox);
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS count FROM events WHERE mission_id=? AND type='watchdog_observation_error'").get(f.mission.id).count, 1);
    const eventData = f.control.db.prepare("SELECT data FROM events WHERE mission_id=?").all(f.mission.id);
    assert.doesNotMatch(JSON.stringify(eventData), /secret watchdog failure/);

    f.control.tickWatchdogs(clock + 2);
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS count FROM events WHERE mission_id=? AND type='watchdog_observation_error'").get(f.mission.id).count, 1);
    assert.equal(f.control.watchdog(secondMission.id).diagnosis, "observing");

    f.control.watchdogFingerprint = originalFingerprint;
    f.control.tickWatchdogs(clock + 3);
    const recovered = f.control.watchdog(f.mission.id);
    assert.equal(recovered.diagnosis, "observing");
    assert.equal(recovered.eligibleSince, new Date(clock + 3).toISOString());
    f.control.tickWatchdogs(clock + 60_002);
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 0, "recovery must observe for a fresh 60 seconds");
    f.control.tickWatchdogs(clock + 60_003);
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 1);
  } finally {
    cleanup(f);
  }
});

test("watchdog blocks unresolved uncertain delivery and approval but accepts only exact resolved blockers", () => {
  const f = baseFixture();
  try {
    const messageId = `mission-opening:${f.mission.id}`;
    const outboxRow = f.control.db.prepare("SELECT id FROM outbox WHERE message_id=?").get(messageId);
    f.control.db.prepare("UPDATE outbox SET status='queued' WHERE id=?").run(outboxRow.id);
    const approvalId = "watchdog-uncertain-approval";
    const approval = {
      id: approvalId, missionId: f.mission.id, agentId: f.orchestrator.id, tool: "bash", args: {},
      status: "pending", createdAt: new Date().toISOString()
    };
    f.control.db.prepare("INSERT INTO approvals(id,mission_id,status,data) VALUES(?,?,?,?)")
      .run(approvalId, f.mission.id, approval.status, JSON.stringify(approval));
    f.control.configureWatchdog(f.mission.id, "watchdog-uncertain-enable", 1, true);
    f.control.tickWatchdogs(clock);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "waiting_approval");
    f.control.db.prepare("UPDATE outbox SET status='uncertain' WHERE id=?").run(outboxRow.id);
    f.control.db.prepare("UPDATE approvals SET status='uncertain',data=? WHERE id=?")
      .run(JSON.stringify({ ...approval, status: "uncertain" }), approvalId);

    addBlocker(f.control, { id: "approval:wrong-id", missionId: f.mission.id, kind: "approval", status: "resolved" });
    f.control.tickWatchdogs(clock + 1);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "waiting_approval");
    const approvalWrongMission = addBlocker(f.control, {
      id: `approval:${approvalId}`, missionId: "another-mission", kind: "approval", status: "resolved"
    });
    f.control.tickWatchdogs(clock + 2);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "waiting_approval");
    const approvalResolved = { ...approvalWrongMission, missionId: f.mission.id };
    f.control.db.prepare("UPDATE blockers SET mission_id=?,data=? WHERE id=?")
      .run(f.mission.id, JSON.stringify(approvalResolved), approvalResolved.id);
    f.control.tickWatchdogs(clock + 3);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "delivery_pending");

    addBlocker(f.control, { id: "delivery:wrong-id", missionId: f.mission.id, kind: "delivery", status: "resolved" });
    f.control.tickWatchdogs(clock + 4);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "delivery_pending");
    const deliveryWrongMission = addBlocker(f.control, {
      id: `delivery:${outboxRow.id}`, missionId: "another-mission", kind: "delivery", status: "resolved"
    });
    f.control.tickWatchdogs(clock + 5);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "delivery_pending");
    const deliveryResolved = { ...deliveryWrongMission, missionId: f.mission.id };
    f.control.db.prepare("UPDATE blockers SET mission_id=?,data=? WHERE id=?")
      .run(f.mission.id, JSON.stringify(deliveryResolved), deliveryResolved.id);
    f.control.tickWatchdogs(clock + 6);
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "observing");
    f.control.tickWatchdogs(clock + 60_006);
    const [wake] = f.control.watchdogWakes(f.mission.id);
    assert.ok(wake);
    assert.equal(wake.deliveryStatus, "queued");
    assert.equal(f.control.db.prepare("SELECT status FROM outbox WHERE id=?").get(outboxRow.id).status, "uncertain");
    assert.equal(f.control.db.prepare("SELECT status FROM approvals WHERE id=?").get(approvalId).status, "uncertain");
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE message_id=?").get(messageId).n, 1, "the uncertain request was not replayed");
  } finally {
    cleanup(f);
  }
});

test("watchdog HTTP configuration is authenticated, exact, revisioned, and included in detail and export", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-control-watchdog-http-"));
  const home = join(root, "home");
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  const server = await startServer({ home, port: 0, testOnlyScripted: true });
  try {
    const control = server.control;
    control.upsertProfile(profile);
    for (const kind of ["orchestrator", "worker", "validator"]) {
      control.upsertRole({ id: `watchdog-${kind}`, name: kind, kind, instructions: `${kind} test role`, profileId: profile.id });
    }
    const workspace = control.addWorkspace("watchdog HTTP workspace", workspacePath);
    const mission = control.createMission({
      title: "Watchdog HTTP draft",
      goal: "Configure through REST",
      acceptance: "Only exact payloads pass",
      workspaceId: workspace.id,
      roleIds: ["watchdog-orchestrator", "watchdog-worker", "watchdog-validator"],
      maxTurns: 5,
      maxCost: 0,
      autonomy: "trusted"
    });
    const token = readFileSync(join(home, "admin.token"), "utf8").trim();
    const url = `http://127.0.0.1:${server.port}/api/missions/${mission.id}/watchdog`;
    const post = (body, authorization = token) => fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal((await post({ requestId: "unauthorized", expectedRevision: 1, autoWake: true }, "wrong-token")).status, 401);
    assert.equal((await post({ requestId: "extra", expectedRevision: 1, autoWake: true, extra: true })).status, 400);
    assert.equal((await post({ requestId: "wrong-type", expectedRevision: 1, autoWake: "true" })).status, 400);
    assert.equal((await post({ requestId: "bad-revision", expectedRevision: 0, autoWake: true })).status, 400);
    const crossOrigin = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ requestId: "cross-origin", expectedRevision: 1, autoWake: true })
    });
    assert.equal(crossOrigin.status, 403);

    const body = { requestId: "http-watchdog-config", expectedRevision: 1, autoWake: true };
    const configuredResponse = await post(body);
    assert.equal(configuredResponse.status, 200);
    const configured = await configuredResponse.json();
    assert.equal(configured.autoWake, true);
    assert.equal(configured.revision, 2);
    assert.equal((await post(body)).status, 200, "identical request replay is idempotent");
    assert.equal((await post({ ...body, autoWake: false })).status, 409, "request id cannot be reused with a different payload");
    assert.equal((await post({ ...body, requestId: "stale-revision" })).status, 409);

    const headers = { authorization: `Bearer ${token}` };
    const detail = await fetch(`http://127.0.0.1:${server.port}/api/missions/${mission.id}`, { headers });
    const exportResponse = await fetch(`http://127.0.0.1:${server.port}/api/missions/${mission.id}/export`, { headers });
    assert.equal(detail.status, 200);
    assert.equal(exportResponse.status, 200);
    const detailValue = await detail.json();
    const exportValue = await exportResponse.json();
    assert.equal(detailValue.watchdog.revision, 2);
    assert.deepEqual(detailValue.watchdogWakes, []);
    assert.equal(exportValue.watchdog.autoWake, true);
    assert.deepEqual(exportValue.watchdogWakes, []);

    setMissionStatus(control, mission.id, "completed");
    assert.equal((await post({ requestId: "terminal-config", expectedRevision: 2, autoWake: false })).status, 409);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduler queues before watchdog in the same maintenance cycle", () => {
  const f = baseFixture();
  try {
    f.control.configureWatchdog(f.mission.id, "watchdog-cycle-enable", 1, true);
    const scheduleMessage = f.control.createSchedule(
      f.mission.id, "watchdog-cycle-schedule", "Due now", "Scheduled work",
      { kind: "once", at: new Date(clock + 30_000).toISOString() }, true
    );
    f.control.tickSchedules(clock + 30_000);
    f.control.tickWatchdogs(clock + 30_000);
    const [occurrence] = f.control.scheduleOccurrences(f.mission.id);
    assert.ok(occurrence);
    assert.equal(occurrence.outcome, "queued");
    assert.equal(f.control.watchdog(f.mission.id).diagnosis, "delivery_pending");
    assert.equal(f.control.watchdogWakes(f.mission.id).length, 0);
    assert.equal(occurrence.scheduleId, scheduleMessage.id);
    assert.ok(f.control.db.prepare("SELECT 1 FROM messages WHERE id=?").get(occurrence.messageId));
  } finally {
    cleanup(f);
  }
});

test("watchdog does not create a wake without actionable tasks or on a backward clock", () => {
  const noTasks = baseFixture({ taskCount: 0 });
  try {
    noTasks.control.configureWatchdog(noTasks.mission.id, "watchdog-no-task-enable", 1, true);
    noTasks.control.tickWatchdogs(clock);
    assert.equal(noTasks.control.watchdog(noTasks.mission.id).diagnosis, "no_pending_tasks");
    noTasks.control.tickWatchdogs(clock + 60_000);
    assert.equal(noTasks.control.watchdogWakes(noTasks.mission.id).length, 0);
  } finally {
    cleanup(noTasks);
  }

  const reversedClock = baseFixture();
  try {
    reversedClock.control.configureWatchdog(reversedClock.mission.id, "watchdog-clock-enable", 1, true);
    reversedClock.control.tickWatchdogs(clock);
    reversedClock.control.tickWatchdogs(clock + 60_000);
    assert.equal(reversedClock.control.watchdogWakes(reversedClock.mission.id).length, 1);
    markOutboxStatus(reversedClock.control, reversedClock.control.watchdogWakes(reversedClock.mission.id)[0].messageId, "completed");
    reversedClock.control.updateTask(reversedClock.orchestrator.id, reversedClock.orchestrator.epoch, "clock-progress", reversedClock.tasks[0].id, { title: "Changed after wake" });
    reversedClock.control.tickWatchdogs(clock + 70_000);
    reversedClock.control.tickWatchdogs(clock + 69_999);
    assert.equal(reversedClock.control.watchdogWakes(reversedClock.mission.id).length, 1);
    assert.equal(reversedClock.control.watchdog(reversedClock.mission.id).eligibleSince, new Date(clock + 69_999).toISOString());
    reversedClock.control.tickWatchdogs(clock + 129_999);
    assert.equal(reversedClock.control.watchdogWakes(reversedClock.mission.id).length, 2, "the restarted observation window matures only after its new start");
  } finally {
    cleanup(reversedClock);
  }
});
