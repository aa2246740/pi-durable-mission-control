import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { startServer } from "../dist/server.js";
import { parseScheduleSpec } from "../dist/schedules.js";

const profile = {
  id: "scheduler-faux",
  name: "Scheduler faux",
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

function fixture({ maxTurns = 10 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "mission-control-scheduler-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const stateHome = join(home, "state");
  const control = new ControlPlane(stateHome);
  control.upsertProfile(profile);
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: kind, name: kind, kind, instructions: `Scheduler ${kind}`, profileId: profile.id });
  }
  const workspace = control.addWorkspace("scheduler workspace", workspacePath);
  const mission = control.createMission({
    title: "Scheduler mission",
    goal: "Exercise durable schedules",
    acceptance: "Scheduled work is durable",
    workspaceId: workspace.id,
    roleIds: ["orchestrator", "worker", "validator"],
    maxTurns,
    maxCost: 1,
    autonomy: "trusted"
  });
  const started = control.missionAction(mission.id, "start");
  const orchestrator = control.getAgentPublic(started.orchestratorId);
  assert.ok(orchestrator);
  return { home, stateHome, workspacePath, control, mission: started, orchestrator };
}

function settleOpening(f) {
  const row = f.control.pendingOutbox().find((item) => item.message_id === `mission-opening:${f.mission.id}`);
  assert.ok(row);
  assert.equal(f.control.markOutboxDispatching(row.id, f.orchestrator.epoch), true);
  assert.equal(f.control.ackOutbox(row.message_id, row.request_id, row.attempt, f.orchestrator.epoch, "completed"), true);
  assert.equal(f.control.setAgentStatus(f.orchestrator.id, f.orchestrator.epoch, "idle"), true);
}

function closeFixture(f) {
  f.control.close();
  rmSync(f.home, { recursive: true, force: true });
}

function onceSoon() {
  return new Date(Date.now() + 1500).toISOString();
}

test("cron upgrade preserves timezone transitions and rejects nondeterministic fields", () => {
  const daily = { kind: "cron", expression: "0 9 * * *", timeZone: "America/New_York" };
  assert.equal(parseScheduleSpec(daily, Date.parse("2026-03-07T14:00:00Z")).nextRunAt, "2026-03-08T13:00:00.000Z");
  assert.equal(parseScheduleSpec(daily, Date.parse("2026-10-31T13:00:00Z")).nextRunAt, "2026-11-01T14:00:00.000Z");
  for (const expression of ["H * * * *", "H(0-10)/5 * * * *", "0 H * * *"]) {
    assert.throws(() => parseScheduleSpec({ ...daily, expression }), /Randomized H/);
  }
  const thursday = { kind: "cron", expression: "0 9 * * THU", timeZone: "UTC" };
  assert.equal(parseScheduleSpec(thursday, Date.parse("2026-01-01T10:00:00Z")).nextRunAt, "2026-01-08T09:00:00.000Z");
});

test("schedule validation, timezone normalization, revisions, and command idempotency", () => {
  const f = fixture();
  try {
    const fixed = parseScheduleSpec(
      { kind: "cron", expression: "0 9 * * *", timeZone: "Asia/Shanghai" },
      Date.parse("2026-01-01T00:00:00.000Z")
    );
    assert.equal(fixed.nextRunAt, "2026-01-01T01:00:00.000Z");
    assert.throws(() => parseScheduleSpec({ kind: "cron", expression: "0 9 * * *", timeZone: "Not/AZone" }), /timezone/);
    assert.throws(() => parseScheduleSpec({ kind: "cron", expression: "0 9 * * * *", timeZone: "UTC" }), /five fields/);
    assert.throws(() => parseScheduleSpec({ kind: "once", at: "2030-02-30T09:00:00Z" }), /calendar/);
    assert.throws(() => parseScheduleSpec({ kind: "once", at: "2030-01-01T09:00:00" }), /explicit timezone/);
    assert.throws(() => parseScheduleSpec({ kind: "once", at: onceSoon(), extra: true }), /Unexpected/);

    const input = { kind: "cron", expression: "*/5 * * * *", timeZone: "UTC" };
    const created = f.control.createSchedule(f.mission.id, "schedule-create-1", "Every five", "Do the scheduled work", input, false);
    assert.equal(created.status, "held");
    assert.equal(created.revision, 1);
    assert.deepEqual(f.control.createSchedule(f.mission.id, "schedule-create-1", "Every five", "Do the scheduled work", input, false), created);
    assert.throws(
      () => f.control.createSchedule(f.mission.id, "schedule-create-1", "Every five", "Changed prompt", input, false),
      (error) => error.status === 409
    );

    const updated = f.control.updateSchedule(f.mission.id, created.id, "schedule-edit-1", 1, "Edited", "Edited prompt", input, true);
    assert.equal(updated.revision, 2);
    assert.equal(updated.status, "enabled");
    assert.equal(updated.reason, undefined);
    assert.deepEqual(f.control.updateSchedule(f.mission.id, created.id, "schedule-edit-1", 1, "Edited", "Edited prompt", input, true), updated);
    assert.throws(
      () => f.control.updateSchedule(f.mission.id, created.id, "schedule-edit-2", 1, "Edited", "Edited prompt", input, true),
      (error) => error.status === 409
    );
  } finally {
    closeFixture(f);
  }
});

test("one-time and recurring due work coalesce across reopen without duplicate messages", () => {
  const onceFixture = fixture();
  try {
    settleOpening(onceFixture);
    const once = onceFixture.control.createSchedule(onceFixture.mission.id, "once-1", "Once", "Run once", { kind: "once", at: onceSoon() }, true);
    const future = Date.parse(once.nextRunAt) + 60_000;
    assert.equal(onceFixture.control.tickSchedules(future), 1);
    assert.equal(onceFixture.control.tickSchedules(future + 60_000), 0);
    const onceOccurrences = onceFixture.control.scheduleOccurrences(onceFixture.mission.id);
    assert.equal(onceOccurrences.length, 1);
    assert.equal(onceOccurrences[0].outcome, "queued");
    assert.equal(onceOccurrences[0].attempt, 1);
    assert.equal(onceFixture.control.listSchedules(onceFixture.mission.id).find((item) => item.id === once.id).status, "finished");
  } finally {
    closeFixture(onceFixture);
  }

  const recurringFixture = fixture();
  try {
    settleOpening(recurringFixture);
    const recurring = recurringFixture.control.createSchedule(
      recurringFixture.mission.id, "cron-1", "Recurring", "Run recurring", { kind: "cron", expression: "*/5 * * * *", timeZone: "UTC" }, true
    );
    const farFuture = Date.parse(recurring.nextRunAt) + 3 * 24 * 60 * 60 * 1000;
    assert.equal(recurringFixture.control.tickSchedules(farFuture), 1);
    const first = recurringFixture.control.scheduleOccurrences(recurringFixture.mission.id);
    assert.equal(first.length, 1);
    const messageId = first[0].messageId;
    const occurrenceId = first[0].id;
    const next = recurringFixture.control.listSchedules(recurringFixture.mission.id).find((item) => item.id === recurring.id);
    assert.equal(next.status, "enabled");
    assert.ok(Date.parse(next.nextRunAt) > farFuture);
    recurringFixture.control.close();
    const reopened = new ControlPlane(recurringFixture.stateHome);
    try {
      assert.equal(reopened.tickSchedules(farFuture), 0);
      const afterReopen = reopened.scheduleOccurrences(recurringFixture.mission.id);
      assert.equal(afterReopen.length, 1);
      assert.equal(afterReopen[0].id, occurrenceId);
      assert.equal(afterReopen[0].messageId, messageId);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE mission_id=?").get(recurringFixture.mission.id).count, 2);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(recurringFixture.home, { recursive: true, force: true });
  }
});

test("paused, busy, budget-exhausted, and uncertain missions record skipped occurrences without wakeups", () => {
  const paused = fixture();
  try {
    const schedule = paused.control.createSchedule(paused.mission.id, "paused-1", "Paused", "Do not wake", { kind: "once", at: onceSoon() }, true);
    paused.control.missionAction(paused.mission.id, "pause");
    assert.equal(paused.control.tickSchedules(Date.parse(schedule.nextRunAt) + 60_000), 1);
    assert.equal(paused.control.scheduleOccurrences(paused.mission.id)[0].reason, "mission_not_active");
    assert.equal(paused.control.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE mission_id=? AND message_id LIKE 'schedule-message:%'").get(paused.mission.id).count, 0);
  } finally {
    closeFixture(paused);
  }

  const busy = fixture();
  try {
    settleOpening(busy);
    busy.control.setAgentStatus(busy.orchestrator.id, busy.orchestrator.epoch, "running");
    const schedule = busy.control.createSchedule(busy.mission.id, "busy-1", "Busy", "Do not wake", { kind: "once", at: onceSoon() }, true);
    busy.control.tickSchedules(Date.parse(schedule.nextRunAt) + 60_000);
    assert.equal(busy.control.scheduleOccurrences(busy.mission.id)[0].reason, "team_busy");
  } finally {
    closeFixture(busy);
  }

  const budget = fixture({ maxTurns: 2 });
  try {
    settleOpening(budget);
    const missionRow = budget.control.db.prepare("SELECT data FROM missions WHERE id=?").get(budget.mission.id);
    const mission = JSON.parse(missionRow.data);
    mission.turns = mission.maxTurns;
    budget.control.db.prepare("UPDATE missions SET data=? WHERE id=?").run(JSON.stringify(mission), budget.mission.id);
    const schedule = budget.control.createSchedule(budget.mission.id, "budget-1", "Budget", "Do not wake", { kind: "once", at: onceSoon() }, true);
    budget.control.tickSchedules(Date.parse(schedule.nextRunAt) + 60_000);
    assert.equal(budget.control.scheduleOccurrences(budget.mission.id)[0].reason, "turn_budget_exhausted");
  } finally {
    closeFixture(budget);
  }

  const uncertain = fixture();
  try {
    settleOpening(uncertain);
    const pending = uncertain.control.sendMessage(uncertain.mission.id, uncertain.orchestrator.id, "uncertain existing work", "followUp", "uncertain-work");
    uncertain.control.setOutboxStatusForMessage(pending.id, "uncertain", "test uncertainty");
    const schedule = uncertain.control.createSchedule(uncertain.mission.id, "uncertain-1", "Uncertain", "Do not wake", { kind: "once", at: onceSoon() }, true);
    uncertain.control.tickSchedules(Date.parse(schedule.nextRunAt) + 60_000);
    assert.equal(uncertain.control.scheduleOccurrences(uncertain.mission.id)[0].reason, "mission_not_active");
    assert.ok(uncertain.control.blockers(uncertain.mission.id).some(blocker => blocker.status === "open" && blocker.kind === "delivery"));
    assert.equal(uncertain.control.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE mission_id=? AND message_id LIKE 'schedule-message:%'").get(uncertain.mission.id).count, 0);
  } finally {
    closeFixture(uncertain);
  }
});

test("resolved uncertain delivery does not block a new schedule or replay the old request", () => {
  const f = fixture();
  try {
    settleOpening(f);
    const oldMessage = f.control.sendMessage(f.mission.id, f.orchestrator.id, "old uncertain work", "followUp", "old-uncertain");
    const oldOutbox = f.control.pendingOutbox().find((item) => item.message_id === oldMessage.id);
    assert.ok(oldOutbox);
    assert.equal(f.control.markOutboxDispatching(oldOutbox.id, f.orchestrator.epoch), true);
    assert.equal(f.control.ackOutbox(oldMessage.id, oldOutbox.request_id, oldOutbox.attempt, f.orchestrator.epoch, "uncertain", "faux uncertain result"), true);
    const oldOutboxAfterUncertainty = f.control.db.prepare("SELECT * FROM outbox WHERE id=?").get(oldOutbox.id);
    const oldMessageAfterUncertainty = f.control.db.prepare("SELECT * FROM messages WHERE id=?").get(oldMessage.id);
    const blocker = f.control.blockers(f.mission.id).find((item) => item.id === `delivery:${oldOutbox.id}`);
    assert.ok(blocker);
    assert.equal(blocker.status, "open");

    f.control.resolveBlocker(blocker.id, "Human reconciled the historical uncertain delivery; do not replay it.");
    f.control.missionAction(f.mission.id, "resume");
    assert.equal(f.control.getMission(f.mission.id).status, "active");
    const schedule = f.control.createSchedule(f.mission.id, "after-reconciliation", "After reconciliation", "Continue new work", { kind: "once", at: onceSoon() }, true);
    assert.equal(f.control.tickSchedules(Date.parse(schedule.nextRunAt) + 60_000), 1);
    const occurrence = f.control.scheduleOccurrences(f.mission.id)[0];
    assert.equal(occurrence.outcome, "queued");
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE message_id=?").get(oldMessage.id).count, 1);
    assert.deepEqual(f.control.db.prepare("SELECT * FROM outbox WHERE id=?").get(oldOutbox.id), oldOutboxAfterUncertainty);
    assert.deepEqual(f.control.db.prepare("SELECT * FROM messages WHERE id=?").get(oldMessage.id), oldMessageAfterUncertainty);
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE message_id LIKE 'schedule-message:%'").get().count, 1);
  } finally {
    closeFixture(f);
  }
});

test("hold, resume, delete preserve schedule history", () => {
  const f = fixture();
  try {
    settleOpening(f);
    const schedule = f.control.createSchedule(f.mission.id, "history-1", "History", "Record this", { kind: "cron", expression: "*/5 * * * *", timeZone: "UTC" }, true);
    const due = Date.parse(schedule.nextRunAt) + 60_000;
    f.control.tickSchedules(due);
    const before = f.control.scheduleOccurrences(f.mission.id);
    assert.equal(before.length, 1);
    const held = f.control.holdSchedule(f.mission.id, schedule.id, "history-hold", 1);
    assert.equal(held.revision, 2);
    const resumed = f.control.resumeSchedule(f.mission.id, schedule.id, "history-resume", held.revision);
    assert.equal(resumed.revision, 3);
    const deleted = f.control.deleteSchedule(f.mission.id, schedule.id, "history-delete", resumed.revision);
    assert.equal(deleted.status, "deleted");
    assert.equal(f.control.scheduleOccurrences(f.mission.id).length, 1);
    assert.equal(f.control.detail(f.mission.id).scheduleOccurrences.length, 1);
    assert.equal(f.control.exportMission(f.mission.id).scheduleOccurrences.length, 1);
  } finally {
    closeFixture(f);
  }
});

test("corrupt persisted configuration or timing holds only the affected schedule", () => {
  const f = fixture();
  try {
    settleOpening(f);
    const malformed = f.control.createSchedule(f.mission.id, "corrupt-json", "Corrupt JSON", "Never enqueue", { kind: "once", at: onceSoon() }, true);
    const invalidTiming = f.control.createSchedule(f.mission.id, "corrupt-time", "Corrupt time", "Never enqueue", { kind: "once", at: onceSoon() }, true);
    const invalidNotDate = f.control.createSchedule(f.mission.id, "corrupt-not-date", "Corrupt not date", "Never enqueue", { kind: "once", at: onceSoon() }, true);
    const invalidNull = f.control.createSchedule(f.mission.id, "corrupt-null", "Corrupt null", "Never enqueue", { kind: "once", at: onceSoon() }, true);
    const invalidCalendar = f.control.createSchedule(f.mission.id, "corrupt-calendar", "Corrupt calendar", "Never enqueue", { kind: "once", at: onceSoon() }, true);
    const valid = f.control.createSchedule(f.mission.id, "valid-after-corruption", "Valid", "Enqueue this", { kind: "once", at: onceSoon() }, true);
    f.control.db.prepare("UPDATE mission_schedules SET schedule=? WHERE id=?").run("{", malformed.id);
    f.control.db.prepare("UPDATE mission_schedules SET next_run_at=? WHERE id=?").run("", invalidTiming.id);
    f.control.db.prepare("UPDATE mission_schedules SET next_run_at=? WHERE id=?").run("not-a-date", invalidNotDate.id);
    f.control.db.prepare("UPDATE mission_schedules SET next_run_at=NULL WHERE id=?").run(invalidNull.id);
    f.control.db.prepare("UPDATE mission_schedules SET schedule=? WHERE id=?").run(JSON.stringify({ kind: "once", at: "2030-02-30T09:00:00Z" }), invalidCalendar.id);
    assert.equal(f.control.tickSchedules(Date.parse(malformed.nextRunAt) + 60_000), 6);
    const schedules = f.control.listSchedules(f.mission.id);
    assert.equal(schedules.find((item) => item.id === malformed.id).status, "held");
    assert.equal(schedules.find((item) => item.id === malformed.id).reason, "invalid_schedule");
    assert.equal(schedules.find((item) => item.id === invalidTiming.id).status, "held");
    assert.equal(schedules.find((item) => item.id === invalidTiming.id).reason, "invalid_schedule");
    assert.equal(schedules.find((item) => item.id === invalidNotDate.id).status, "held");
    assert.equal(schedules.find((item) => item.id === invalidNull.id).status, "held");
    assert.equal(schedules.find((item) => item.id === invalidCalendar.id).status, "held");
    assert.equal(schedules.find((item) => item.id === valid.id).status, "finished");
    assert.equal(f.control.scheduleOccurrences(f.mission.id).find((item) => item.scheduleId === valid.id).outcome, "queued");
    assert.equal(f.control.detail(f.mission.id).schedules.length, 6);
    assert.equal(f.control.events(0, f.mission.id).filter((event) => event.type === "schedule_held").length, 5);
  } finally {
    closeFixture(f);
  }
});

test("HTTP heartbeat delivers one scheduled input to the original native worker", { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-scheduler-http-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const server = await startServer({ home, port: 0, testOnlyScripted: true, testOnlyToolLoop: true });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(base);
    const cookie = page.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", cookie, origin: base, "x-requested-with": "MissionControl" };
    const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const httpProfile = { ...profile };
    delete httpProfile.revision;
    const profileResponse = await post("/api/profiles", { ...httpProfile, id: "http-scheduler-faux", name: "HTTP scheduler faux" });
    assert.equal(profileResponse.status, 201);
    for (const kind of ["orchestrator", "worker", "validator"]) {
      const response = await post("/api/roles", { id: `http-scheduler-${kind}`, name: kind, kind, instructions: `Scheduler ${kind}`, profileId: "http-scheduler-faux" });
      assert.equal(response.status, 201);
    }
    const workspaceResponse = await post("/api/workspaces", { name: "scheduler", path: workspacePath, machineId: "local" });
    const workspace = await workspaceResponse.json();
    const missionResponse = await post("/api/missions", {
      title: "HTTP scheduler", goal: "Deliver scheduled input", acceptance: "The original worker receives it",
      workspaceId: workspace.id, roleIds: ["http-scheduler-orchestrator", "http-scheduler-worker", "http-scheduler-validator"],
      maxTurns: 10, maxCost: 1, autonomy: "trusted"
    });
    const mission = await missionResponse.json();
    assert.equal((await post(`/api/missions/${mission.id}/start`, {})).status, 200);
    const openingDeadline = Date.now() + 10000;
    let detail;
    do {
      detail = await (await fetch(`${base}/api/missions/${mission.id}`, { headers: { cookie } })).json();
      if (detail.messages.some((message) => message.id === `mission-opening:${mission.id}` && message.status === "completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < openingDeadline);
    const original = detail.agents.find((agent) => agent.kind === "orchestrator");
    assert.ok(original);
    const storePath = join(home, "agents", `${original.id}.sqlite`);
    const beforeStore = statSync(storePath);
    const invalid = await post(`/api/missions/${mission.id}/schedules`, {
      requestId: "scheduler-invalid", name: "Invalid", prompt: "Invalid", schedule: { kind: "once", at: onceSoon(), extra: true }, enabled: true
    });
    assert.equal(invalid.status, 400);
    const create = await post(`/api/missions/${mission.id}/schedules`, {
      requestId: "scheduler-http-1", name: "Heartbeat input", prompt: "Continue the scheduled durable work.", schedule: { kind: "once", at: onceSoon() }, enabled: true
    });
    assert.equal(create.status, 201);
    const created = await create.json();
    const deadline = Date.now() + 18000;
    do {
      detail = await (await fetch(`${base}/api/missions/${mission.id}`, { headers: { cookie } })).json();
      const occurrence = detail.scheduleOccurrences?.find((item) => item.scheduleId === created.id);
      if (occurrence?.deliveryStatus === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    const occurrence = detail.scheduleOccurrences.find((item) => item.scheduleId === created.id);
    assert.equal(occurrence.outcome, "queued");
    assert.equal(occurrence.attempt, 1);
    assert.equal(occurrence.requestId, `${occurrence.messageId}:1`);
    assert.equal(occurrence.deliveryStatus, "completed");
    assert.equal(detail.agents.filter((agent) => agent.kind === "orchestrator").length, 1);
    assert.equal(detail.agents.find((agent) => agent.kind === "orchestrator").id, original.id);
    assert.equal(statSync(storePath).ino, beforeStore.ino);
    const replay = await (await fetch(`${base}/api/missions/${mission.id}/export`, { headers: { cookie } })).json();
    assert.ok(replay.outbox.some((row) => row.message_id === occurrence.messageId && row.request_id === occurrence.requestId && row.attempt === 1 && row.status === "completed"));
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
