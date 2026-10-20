import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMissionHudServer } from "../hud/server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_MJS_PATH = path.resolve(__dirname, "../hud/server.mjs");
const APP_JS_PATH = path.resolve(__dirname, "../hud/public/app.js");

function createTempMissionWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t3-mission-hud-test-"));
}

function writeMissionFixture(workspaceDir) {
  const dotMission = path.join(workspaceDir, ".mission");
  fs.mkdirSync(dotMission, { recursive: true });

  const state = {
    missionId: "mission-openslide-001",
    title: "Open SlideStudio 参考材料附件：图片 / PPTX 模板 / 数据表 / PDF / Word",
    repoPath: "/Volumes/Workspace/openslide-studio-agentready",
    status: "awaiting_input",
    revision: 1,
    elapsedMs: 71961000,
    lastStartedAt: null,
    planAccepted: false,
    milestones: [
      { id: "m1", title: "Milestone 1: Intake", ordinal: 1 },
      { id: "m2", title: "Milestone 2: Materials In Run", ordinal: 2 },
    ],
    assertions: [
      {
        id: "VAL-HUD-001",
        description: "HUD HTTP + SSE live snapshot streaming",
        milestoneId: "m1",
        status: "passed",
      },
      {
        id: "VAL-HUD-002",
        description: "Plan approval card transitions mission to running",
        milestoneId: "m1",
        status: "pending",
      },
      {
        id: "VAL-HUD-003",
        description: "Model 3-slot hot switch persists to model-settings.json",
        milestoneId: "m2",
        status: "pending",
      },
      {
        id: "VAL-HUD-004",
        description: "Pause and resume Worker #28 closed loop",
        milestoneId: "m2",
        status: "pending",
      },
    ],
    activeWorker: {
      runId: "run-w28",
      sessionId: "worker-28",
      workerNumber: 28,
      role: "Worker",
      milestoneId: "m2",
      featureId: "m2-material-test-gaps",
      featureTitle: "M2 material test gaps",
      status: "running",
      childThreadId: "0199f2c0-7b1d-7000-8000-000000000028",
    },
    sessions: [
      {
        sessionId: "worker-1",
        runId: "run-w1",
        workerNumber: 1,
        role: "Worker",
        milestoneId: "m1",
        featureId: "intake-foundation",
        title: "Intake foundation",
        status: "completed",
        childThreadId: "0199f2c0-7b1d-7000-8000-000000000001",
        salientSummary: "Implemented intake foundation and file router.",
        whatWasImplemented:
          "Built core attachment intake pipeline supporting images, PPTX, XLSX, PDF, and DOCX.",
        commandsRun: ["node --test test/intake.test.mjs"],
        discoveredIssues: [],
      },
      {
        sessionId: "validator-27",
        runId: "run-v27",
        workerNumber: 27,
        role: "Validator",
        milestoneId: "m2",
        featureId: "user-testing-validator-m2",
        title: "User testing validator materials in run",
        status: "completed",
        childThreadId: "0199f2c0-7b1d-7000-8000-000000000027",
        salientSummary: "M2 user testing passed 27 of 36 assertions.",
        whatWasImplemented:
          "Executed browser user testing across M2 material attachment flows.",
        commandsRun: ["npx playwright test"],
        discoveredIssues: ["First capability check in real run said can't see images"],
      },
      {
        sessionId: "worker-28",
        runId: "run-w28",
        workerNumber: 28,
        role: "Worker",
        milestoneId: "m2",
        featureId: "m2-material-test-gaps",
        title: "M2 material test gaps",
        status: "running",
        childThreadId: "0199f2c0-7b1d-7000-8000-000000000028",
      },
    ],
  };

  const featuresDoc = {
    features: [
      {
        id: "intake-foundation",
        milestoneId: "m1",
        title: "Intake foundation",
        status: "completed",
        kind: "implementation",
        fulfills: ["VAL-HUD-001"],
      },
      {
        id: "intake-office-parsers",
        milestoneId: "m1",
        title: "Intake office parsers",
        status: "completed",
        kind: "implementation",
        fulfills: ["VAL-HUD-002"],
      },
      {
        id: "m2-material-test-gaps",
        milestoneId: "m2",
        title: "M2 material test gaps",
        status: "running",
        kind: "implementation",
        fulfills: ["VAL-HUD-003", "VAL-HUD-004"],
      },
    ],
    updatedAt: new Date().toISOString(),
  };

  const modelSettings = {
    orchestrator: {
      providerInstanceId: "claude-code",
      model: "claude-opus-5-5",
      label: "Claude Code · Opus 5.5",
      effort: 5,
      reasoningEffort: "max",
      options: { reasoningEffort: "max", effort: 5 },
    },
    worker: {
      providerInstanceId: "cpa",
      model: "swe-2-max",
      label: "CPA swe-2 Max",
      effort: 5,
      reasoningEffort: "max",
      options: { reasoningEffort: "max", effort: 5 },
    },
    validator: {
      providerInstanceId: "cpa",
      model: "grok-4.7",
      label: "CPA grok-4.7",
      effort: 3,
      reasoningEffort: "medium",
      options: { reasoningEffort: "medium", effort: 3 },
    },
    skipScrutiny: false,
    skipUserTesting: false,
  };

  const initialLogs = [
    {
      seq: 1,
      timestamp: new Date(Date.now() - 120000).toISOString(),
      type: "validator_completed",
      message: "Validator #27 completed User testing validator materials in run",
      workerNumber: 27,
    },
    {
      seq: 2,
      timestamp: new Date(Date.now() - 60000).toISOString(),
      type: "worker_selected",
      message: "Worker #28 selected M2 material test gaps",
      featureId: "m2-material-test-gaps",
      workerNumber: 28,
    },
    {
      seq: 3,
      timestamp: new Date(Date.now() - 55000).toISOString(),
      type: "worker_started",
      message: "Worker #28 started M2 material test gaps",
      featureId: "m2-material-test-gaps",
      workerNumber: 28,
    },
  ];

  fs.writeFileSync(path.join(dotMission, "state.json"), JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync(
    path.join(dotMission, "features.json"),
    JSON.stringify(featuresDoc, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(dotMission, "model-settings.json"),
    JSON.stringify(modelSettings, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(dotMission, "progress_log.jsonl"),
    initialLogs.map((l) => JSON.stringify(l)).join("\n") + "\n"
  );

  return { dotMission, state, featuresDoc, modelSettings };
}

function subscribeSseEvents(url, { lastEventId, count = 1, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const headers = {};
    if (lastEventId !== undefined) {
      headers["Last-Event-ID"] = String(lastEventId);
    }
    const req = http.get(url, { headers }, (res) => {
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const lines = block.split("\n").filter((l) => l && !l.startsWith(":"));
          if (lines.length === 0) continue;
          let id = null;
          let event = "message";
          let dataRaw = "";
          for (const line of lines) {
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataRaw += line.slice(5).trim();
          }
          if (dataRaw) {
            events.push({
              id,
              event,
              data: JSON.parse(dataRaw),
            });
            if (events.length >= count) {
              req.destroy();
              clearTimeout(timer);
              resolve(events);
              return;
            }
          }
        }
      });
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Timed out waiting for ${count} SSE events (got ${events.length})`));
    }, timeoutMs);

    req.on("error", (err) => {
      if (events.length >= count) return;
      clearTimeout(timer);
      reject(err);
    });
  });
}

test("VAL-HUD-001: Uninitialized .mission directory returns clear onboarding state, catalog, and static assets", async (t) => {
  const workspaceDir = createTempMissionWorkspace();
  const hud = await createMissionHudServer({ missionDir: workspaceDir, port: 0 });
  t.after(async () => {
    await hud.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  // Verify static assets load properly
  for (const [route, expectedMime, expectedSnippet] of [
    ["/", "text/html", "T3 Mission Control HUD"],
    ["/index.html", "text/html", "hud-workspace"],
    ["/styles.css", "text/css", "#fbfbfa"],
    ["/app.js", "application/javascript", "/api/mission/stream"],
  ]) {
    const res = await fetch(`${hud.url}${route}`);
    assert.equal(res.status, 200, `Expected 200 for ${route}`);
    assert.match(res.headers.get("content-type") || "", new RegExp(expectedMime));
    const text = await res.text();
    assert.ok(text.includes(expectedSnippet), `Expected ${route} to include ${expectedSnippet}`);
  }

  // Verify uninitialized state snapshot
  const stateRes = await fetch(`${hud.url}/api/mission/state`);
  assert.equal(stateRes.status, 200);
  const snapshot = await stateRes.json();
  assert.equal(snapshot.initialized, false);
  assert.equal(snapshot.state.planAccepted, false);
  assert.ok(snapshot.state.onboarding?.headline);
  assert.ok(Array.isArray(snapshot.catalog));
  assert.ok(snapshot.catalog.length >= 6);

  const catalogLabels = snapshot.catalog.map((c) => c.label);
  assert.ok(catalogLabels.includes("Claude Code · Opus 5.5"));
  assert.ok(catalogLabels.includes("Gemini 4 Argon (High)"));
  assert.ok(catalogLabels.includes("Codex · GPT-6.1-Sol (Max/High)"));
  assert.ok(catalogLabels.includes("CPA swe-2 Max"));
  assert.ok(catalogLabels.includes("CPA grok-4.7"));
  assert.ok(catalogLabels.includes("GPT-6-Astra (High)"));
});

test("VAL-HUD-001: SSE /api/mission/stream supports Last-Event-ID and broadcasts live .mission file changes", async (t) => {
  const workspaceDir = createTempMissionWorkspace();
  const { dotMission } = writeMissionFixture(workspaceDir);
  const hud = await createMissionHudServer({ missionDir: workspaceDir, port: 0 });
  t.after(async () => {
    await hud.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  // 1. Receive initial SSE snapshot with Last-Event-ID
  const initialEvents = await subscribeSseEvents(`${hud.url}/api/mission/stream`, {
    lastEventId: "42",
    count: 1,
  });
  assert.equal(initialEvents.length, 1);
  assert.equal(initialEvents[0].event, "mission_snapshot");
  assert.equal(initialEvents[0].data.lastEventId, "42");
  assert.equal(initialEvents[0].data.state.missionId, "mission-openslide-001");
  assert.equal(initialEvents[0].data.features.length, 3);

  // 2. Listen for 2 events (initial + live fs change) and mutate state.json on disk
  const twoEventsPromise = subscribeSseEvents(`${hud.url}/api/mission/stream`, {
    count: 2,
    timeoutMs: 4000,
  });

  setTimeout(() => {
    const stateFile = path.join(dotMission, "state.json");
    const current = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    current.revision += 1;
    current.title = "Updated Title via Disk Write";
    fs.writeFileSync(stateFile, JSON.stringify(current, null, 2) + "\n");
  }, 120);

  const twoEvents = await twoEventsPromise;
  assert.equal(twoEvents.length, 2);
  assert.equal(twoEvents[1].event, "mission_snapshot");
  assert.equal(twoEvents[1].data.state.title, "Updated Title via Disk Write");
});

test("VAL-HUD-002: POST /api/mission/approve sets planAccepted=true, status='running', increments revision, and writes progress_log.jsonl", async (t) => {
  const workspaceDir = createTempMissionWorkspace();
  const { dotMission } = writeMissionFixture(workspaceDir);
  const commandsReceived = [];
  const hud = await createMissionHudServer({
    missionDir: workspaceDir,
    port: 0,
    onCommand: (cmd) => commandsReceived.push(cmd),
  });
  t.after(async () => {
    await hud.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  const res = await fetch(`${hud.url}/api/mission/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approvedBy: "operator" }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.state.planAccepted, true);
  assert.equal(data.state.status, "running");
  assert.equal(data.state.revision, 2);

  // Verify persisted state.json on disk
  const persistedState = JSON.parse(
    fs.readFileSync(path.join(dotMission, "state.json"), "utf8")
  );
  assert.equal(persistedState.planAccepted, true);
  assert.equal(persistedState.status, "running");
  assert.equal(persistedState.revision, 2);

  // Verify progress_log.jsonl has plan_approved entry
  const logLines = fs
    .readFileSync(path.join(dotMission, "progress_log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const lastLog = logLines.at(-1);
  assert.equal(lastLog.type, "plan_approved");
  assert.match(lastLog.message, /approved/i);
  assert.equal(commandsReceived.length, 1);
  assert.equal(commandsReceived[0].type, "approve");
});

test("VAL-HUD-003: POST /api/mission/model-slots hot-swaps Validator model from grok-4.7 to gpt-6.1-sol and persists .mission/model-settings.json", async (t) => {
  const workspaceDir = createTempMissionWorkspace();
  const { dotMission } = writeMissionFixture(workspaceDir);
  const hud = await createMissionHudServer({ missionDir: workspaceDir, port: 0 });
  t.after(async () => {
    await hud.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  // Initial check: validator is grok-4.7
  const beforeRes = await fetch(`${hud.url}/api/mission/state`);
  const beforeSnap = await beforeRes.json();
  assert.equal(beforeSnap.modelSettings.validator.model, "grok-4.7");

  // Hot-switch Validator to gpt-6.1-sol with effort 4 (high)
  const switchRes = await fetch(`${hud.url}/api/mission/model-slots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slot: "validator",
      model: "gpt-6.1-sol",
      providerInstanceId: "codex",
      effort: 4,
      reasoningEffort: "high",
    }),
  });
  assert.equal(switchRes.status, 200);
  const switchData = await switchRes.json();
  assert.equal(switchData.ok, true);
  assert.equal(switchData.modelSettings.validator.model, "gpt-6.1-sol");
  assert.equal(switchData.modelSettings.validator.effort, 4);
  assert.equal(switchData.modelSettings.validator.reasoningEffort, "high");

  // Verify persisted .mission/model-settings.json on disk
  const diskSettings = JSON.parse(
    fs.readFileSync(path.join(dotMission, "model-settings.json"), "utf8")
  );
  assert.equal(diskSettings.validator.model, "gpt-6.1-sol");
  assert.equal(diskSettings.validator.providerInstanceId, "codex");
  assert.equal(diskSettings.validator.effort, 4);
  assert.equal(diskSettings.validator.options.reasoningEffort, "high");

  // Effort-only updates (F09 & I-02): effort=1 -> "minimal", effort=2 -> "low"
  const effortOnlyWorkerRes = await fetch(`${hud.url}/api/mission/model-slots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slot: "worker",
      model: "gpt-6.1-sol",
      effort: 1,
    }),
  });
  assert.equal(effortOnlyWorkerRes.status, 200);
  const effortOnlyWorkerData = await effortOnlyWorkerRes.json();
  assert.equal(effortOnlyWorkerData.modelSettings.worker.effort, 1);
  assert.equal(effortOnlyWorkerData.modelSettings.worker.reasoningEffort, "minimal");
  assert.equal(effortOnlyWorkerData.modelSettings.worker.options.reasoningEffort, "minimal");

  const effortOnlyValidatorRes = await fetch(`${hud.url}/api/mission/model-slots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slot: "validator",
      model: "gpt-6.1-sol",
      providerInstanceId: "codex",
      effort: 2,
    }),
  });
  assert.equal(effortOnlyValidatorRes.status, 200);
  const effortOnlyValidatorData = await effortOnlyValidatorRes.json();
  assert.equal(effortOnlyValidatorData.modelSettings.validator.effort, 2);
  assert.equal(effortOnlyValidatorData.modelSettings.validator.reasoningEffort, "low");
  assert.equal(effortOnlyValidatorData.modelSettings.validator.options.reasoningEffort, "low");

  const diskSettingsAfter = JSON.parse(
    fs.readFileSync(path.join(dotMission, "model-settings.json"), "utf8")
  );
  assert.equal(diskSettingsAfter.worker.options.reasoningEffort, "minimal");
  assert.equal(diskSettingsAfter.validator.options.reasoningEffort, "low");

  // Verify state revision incremented and progress_log.jsonl recorded the change
  const diskState = JSON.parse(fs.readFileSync(path.join(dotMission, "state.json"), "utf8"));
  assert.equal(diskState.revision, 4);

  const logLines = fs
    .readFileSync(path.join(dotMission, "progress_log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const lastLog = logLines.at(-1);
  assert.equal(lastLog.type, "model_slots_updated");
  assert.match(lastLog.message, /gpt-6\.1-sol/);
});

test("VAL-HUD-004: POST /api/mission/pause and POST /api/mission/resume reproduce Worker #28 pause & resume closed loop", async (t) => {
  const workspaceDir = createTempMissionWorkspace();
  const { dotMission } = writeMissionFixture(workspaceDir);
  const hud = await createMissionHudServer({ missionDir: workspaceDir, port: 0 });
  t.after(async () => {
    await hud.close();
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  // Unapproved resume must be rejected (F03)
  const unapprovedRes = await fetch(`${hud.url}/api/mission/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(unapprovedRes.status, 409);
  const unapprovedData = await unapprovedRes.json();
  assert.equal(unapprovedData.code, "PLAN_ACCEPTANCE_REQUIRED");

  // First approve plan so mission is running with Worker #28 active
  await fetch(`${hud.url}/api/mission/approve`, { method: "POST" });

  // 1. Pause mission while Worker #28 is running
  const pauseRes = await fetch(`${hud.url}/api/mission/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(pauseRes.status, 200);
  const pauseData = await pauseRes.json();
  assert.equal(pauseData.ok, true);
  assert.equal(pauseData.state.status, "paused");
  assert.equal(pauseData.state.activeWorker.status, "paused");
  assert.equal(pauseData.state.activeWorker.workerNumber, 28);

  // 2. Resume mission -> simulates [resume the mission], logs preflight diagnostic, wakes Worker #28
  const resumeRes = await fetch(`${hud.url}/api/mission/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(resumeRes.status, 200);
  const resumeData = await resumeRes.json();
  assert.equal(resumeData.ok, true);
  assert.equal(resumeData.trigger, "[resume the mission]");
  assert.match(
    resumeData.diagnostic,
    /The mission was paused .* m2-material-test-gaps .* code tree has no uncommitted changes, so I'm resuming that worker\./
  );
  assert.equal(resumeData.state.status, "running");
  assert.equal(resumeData.state.activeWorker.status, "running");
  assert.equal(resumeData.state.activeWorker.resumePending, true);

  // 3. Verify complete progress_log.jsonl sequence:
  // Worker #28 paused -> Mission paused -> Mission resumed -> Run started: Resume ...
  const logLines = fs
    .readFileSync(path.join(dotMission, "progress_log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  const messages = logLines.map((l) => l.message);
  const idxWorkerPaused = messages.findIndex((m) =>
    m.includes("Worker #28 paused M2 material test gaps")
  );
  const idxMissionPaused = messages.findIndex(
    (m, i) => i > idxWorkerPaused && m === "Mission paused"
  );
  const idxMissionResumed = messages.findIndex(
    (m, i) => i > idxMissionPaused && m === "Mission resumed"
  );
  const idxRunStarted = messages.findIndex(
    (m, i) => i > idxMissionResumed && m.startsWith("Run started: Resume")
  );

  assert.ok(idxWorkerPaused !== -1, "Expected Worker #28 paused log entry");
  assert.ok(idxMissionPaused > idxWorkerPaused, "Expected Mission paused after Worker #28 paused");
  assert.ok(idxMissionResumed > idxMissionPaused, "Expected Mission resumed after Mission paused");
  assert.ok(idxRunStarted > idxMissionResumed, "Expected Run started: Resume after Mission resumed");
});

test("I-04, I-07, I-03, F11, F04: Startup reconciliation, real Git dirty diagnostic, Validator role synthesis, and CLI startup", async (t) => {
  // 1. I-04 & I-07: Real Git repo with stale running state and dirty working tree on resume
  const gitRepoDir = createTempMissionWorkspace();
  execFileSync("git", ["init", "-q"], { cwd: gitRepoDir });
  fs.writeFileSync(path.join(gitRepoDir, ".gitignore"), ".mission/\n");
  fs.writeFileSync(path.join(gitRepoDir, "README.md"), "Initial repo\n");
  execFileSync("git", ["add", "."], { cwd: gitRepoDir });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"],
    { cwd: gitRepoDir }
  );

  const dotMission = path.join(gitRepoDir, ".mission");
  fs.mkdirSync(dotMission, { recursive: true });
  const staleRunningState = {
    missionId: "mission-reconcile",
    title: "Stale Running Mission",
    repoPath: gitRepoDir,
    status: "running",
    planAccepted: true,
    revision: 2,
    elapsedMs: 1000,
    lastStartedAt: new Date(Date.now() - 2000).toISOString(),
    milestones: [{ id: "m1", title: "M1", ordinal: 1 }],
    assertions: [],
    activeWorker: {
      runId: "run:restart",
      workerNumber: 1,
      featureId: "f1",
      featureTitle: "First feature",
      milestoneId: "m1",
      status: "running",
      childThreadId: "thread:123",
      taskId: "task:123",
      worktreePath: gitRepoDir,
    },
    sessions: [
      {
        runId: "run:restart",
        workerNumber: 1,
        featureId: "f1",
        featureTitle: "First feature",
        milestoneId: "m1",
        status: "running",
        childThreadId: "thread:123",
        taskId: "task:123",
        worktreePath: gitRepoDir,
      },
    ],
  };
  fs.writeFileSync(
    path.join(dotMission, "state.json"),
    JSON.stringify(staleRunningState, null, 2) + "\n"
  );

  const hud = await createMissionHudServer({ missionDir: dotMission, port: 0 });
  t.after(async () => {
    await hud.close();
    fs.rmSync(gitRepoDir, { recursive: true, force: true });
  });

  // Verify I-04: Startup reconciled running state to paused
  const stateRes = await fetch(`${hud.url}/api/mission/state`);
  const snap = await stateRes.json();
  assert.equal(snap.state.status, "paused");
  assert.equal(snap.state.activeWorker.status, "paused");
  assert.ok(snap.state.elapsedMs >= 2000);

  // Dirty tracked file in gitRepoDir and test I-07 resume diagnostic
  fs.appendFileSync(path.join(gitRepoDir, "README.md"), "uncommitted change\n");
  const dirtyResumeRes = await fetch(`${hud.url}/api/mission/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(dirtyResumeRes.status, 200);
  const dirtyResumeData = await dirtyResumeRes.json();
  assert.ok(
    !dirtyResumeData.diagnostic.includes("no uncommitted changes"),
    `Expected dirty diagnostic, got: ${dirtyResumeData.diagnostic}`
  );
  assert.match(dirtyResumeData.diagnostic, /has uncommitted changes \(README\.md\)/);
  assert.equal(dirtyResumeData.state.activeWorker.resumePending, true);

  // 2. I-03 & F11: Frontend synthesizeSessions preserves Validator role for scrutiny/user-testing and avoids fabricating handoffs
  const appSrc = fs
    .readFileSync(APP_JS_PATH, "utf8")
    .replace("export function applySnapshot", "function applySnapshot")
    .replace(/initHud\(\);\s*$/, "");
  const vmCtx = vm.createContext({});
  vm.runInContext(appSrc, vmCtx);
  vmCtx.testState = {
    status: "running",
    activeWorker: {
      runId: "validator-run-4",
      workerNumber: 4,
      kind: "scrutiny",
      slot: "validator",
      featureId: "scrutiny-validator-m1",
      featureTitle: "Scrutiny validation for Milestone one",
      milestoneId: "m1",
      status: "running",
    },
    sessions: [
      {
        runId: "validator-run-4",
        workerNumber: 4,
        kind: "scrutiny",
        slot: "validator",
        featureId: "scrutiny-validator-m1",
        featureTitle: "Scrutiny validation for Milestone one",
        milestoneId: "m1",
        status: "running",
      },
    ],
  };
  const synthesized = JSON.parse(
    vm.runInContext(
      "JSON.stringify(synthesizeSessions(testState, [{ id: 'scrutiny-validator-m1', title: 'Scrutiny validation for Milestone one', status: 'running', kind: 'scrutiny', milestoneId: 'm1' }]))",
      vmCtx
    )
  );
  assert.equal(synthesized.length, 1);
  assert.equal(synthesized[0].role, "Validator");
  assert.match(synthesized[0].label, /^Validator #4: Scrutiny validation/);
  assert.deepEqual(synthesized[0].handoff.commandsRun, []);
  assert.equal(synthesized[0].handoff.whatWasImplemented, "No handoff recorded yet.");
  assert.equal(synthesized[0].childThreadId, null);

  // 3. F04: Standalone CLI execution starts server, creates .mission, outputs listening JSON, and serves HTTP
  const cliTempDir = createTempMissionWorkspace();
  let cliPid = null;
  t.after(() => {
    if (cliPid) {
      try {
        process.kill(cliPid, "SIGTERM");
      } catch {}
    }
    fs.rmSync(cliTempDir, { recursive: true, force: true });
  });
  const cliMissionDir = path.join(cliTempDir, ".mission");
  const cliStdout = execFileSync(
    process.execPath,
    [SERVER_MJS_PATH, "--mission-dir", cliMissionDir, "--port", "0"],
    { cwd: cliTempDir, timeout: 3000, encoding: "utf8" }
  );
  assert.ok(fs.existsSync(cliMissionDir), "CLI should create .mission directory");
  const cliInfo = JSON.parse(cliStdout.trim());
  cliPid = cliInfo.pid;
  assert.equal(cliInfo.ok, true);
  assert.ok(cliInfo.url.startsWith("http://127.0.0.1:"));

  const cliHttpRes = await fetch(`${cliInfo.url}/api/mission/state`);
  assert.equal(cliHttpRes.status, 200);
  const cliSnap = await cliHttpRes.json();
  assert.equal(cliSnap.initialized, false);
});

test("Round 2 Scrutiny Fixes (P14, P15, P16, P18, P20): Default approve feature selection, onCommand rollback, missing worktree preflight, retry session handoff isolation, and symlink CLI guard", async (t) => {
  // --- P14: Default HUD approve selects first pending feature with dispatchPending=true ---
  const p14Dir = createTempMissionWorkspace();
  execFileSync("git", ["init", "-q", p14Dir]);
  execFileSync("git", ["-C", p14Dir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", p14Dir, "config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(p14Dir, ".gitignore"), ".mission/\n");
  fs.writeFileSync(path.join(p14Dir, "file.txt"), "baseline\n");
  execFileSync("git", ["-C", p14Dir, "add", "."]);
  execFileSync("git", ["-C", p14Dir, "commit", "-qm", "fixture"]);

  const p14DotMission = path.join(p14Dir, ".mission");
  fs.mkdirSync(p14DotMission, { recursive: true });
  fs.writeFileSync(
    path.join(p14DotMission, "state.json"),
    JSON.stringify(
      {
        missionId: "mission-p14",
        title: "P14 Default Approve",
        repoPath: p14Dir,
        status: "awaiting_input",
        planAccepted: false,
        revision: 1,
        elapsedMs: 0,
        lastStartedAt: null,
        milestones: [{ id: "m1", title: "Milestone one", ordinal: 1 }],
        assertions: [{ id: "VAL-1", milestoneId: "m1", status: "pending" }],
        activeWorker: null,
        sessions: [],
        pendingHandoffItems: [],
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(
    path.join(p14DotMission, "features.json"),
    JSON.stringify(
      {
        features: [
          { id: "f1", title: "First", milestoneId: "m1", status: "pending", attempts: 0 },
          { id: "f2", title: "Second", milestoneId: "m1", status: "pending", attempts: 0 },
        ],
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );

  const srv14 = await createMissionHudServer({ missionDir: p14Dir, port: 0 });
  t.after(async () => {
    await srv14.close();
    fs.rmSync(p14Dir, { recursive: true, force: true });
  });

  const approveRes = await fetch(`${srv14.url}/api/mission/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(approveRes.status, 200);
  const afterApproveState = JSON.parse(
    fs.readFileSync(path.join(p14DotMission, "state.json"), "utf8")
  );
  const afterApproveFeatures = JSON.parse(
    fs.readFileSync(path.join(p14DotMission, "features.json"), "utf8")
  ).features;
  const afterApproveLogs = fs
    .readFileSync(path.join(p14DotMission, "progress_log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  assert.equal(afterApproveState.status, "running");
  assert.equal(afterApproveState.planAccepted, true);
  assert.ok(afterApproveState.activeWorker, "Expected activeWorker to be selected on approve");
  assert.equal(afterApproveState.activeWorker.featureId, "f1");
  assert.equal(afterApproveState.activeWorker.status, "running");
  assert.equal(afterApproveState.activeWorker.dispatchPending, true);
  assert.deepEqual(
    afterApproveFeatures.map((f) => f.status),
    ["running", "pending"]
  );
  assert.equal(afterApproveFeatures[0].attempts, 1);
  assert.deepEqual(
    afterApproveLogs.map((l) => l.type),
    ["plan_approved", "worker_selected", "worker_started"]
  );

  // --- P15: onCommand throwing error rolls back disk state to paused ---
  await fetch(`${srv14.url}/api/mission/pause`, { method: "POST" });
  const srv15 = await createMissionHudServer({
    missionDir: p14Dir,
    port: 0,
    onCommand: async ({ type }) => {
      if (type === "resume") {
        throw new Error("Independent runtime wake failure");
      }
    },
  });
  t.after(async () => {
    await srv15.close();
  });

  const failResumeRes = await fetch(`${srv15.url}/api/mission/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(failResumeRes.status, 500);
  const failResumeBody = await failResumeRes.json();
  assert.match(failResumeBody.error, /Independent runtime wake failure/);

  const diskStateAfterFail = JSON.parse(
    fs.readFileSync(path.join(p14DotMission, "state.json"), "utf8")
  );
  assert.equal(diskStateAfterFail.status, "paused");
  assert.equal(diskStateAfterFail.activeWorker.status, "paused");
  assert.equal(diskStateAfterFail.activeWorker.resumePending, undefined);

  // --- P16: Missing activeWorker.worktreePath fails closed with 409 ---
  const p16Dir = createTempMissionWorkspace();
  const p16DotMission = path.join(p16Dir, ".mission");
  fs.mkdirSync(p16DotMission, { recursive: true });
  fs.writeFileSync(
    path.join(p16DotMission, "state.json"),
    JSON.stringify(
      {
        missionId: "mission-p16",
        title: "P16 Missing Worktree",
        repoPath: p16Dir,
        status: "paused",
        planAccepted: true,
        revision: 2,
        activeWorker: {
          runId: "run-missing-wt",
          workerNumber: 1,
          featureId: "f1",
          featureTitle: "First",
          status: "paused",
          taskId: "t",
          childThreadId: "c",
          worktreePath: path.join(p16Dir, "does-not-exist"),
        },
        sessions: [],
      },
      null,
      2
    ) + "\n"
  );

  const srv16 = await createMissionHudServer({ missionDir: p16Dir, port: 0 });
  t.after(async () => {
    await srv16.close();
    fs.rmSync(p16Dir, { recursive: true, force: true });
  });

  const missingWtRes = await fetch(`${srv16.url}/api/mission/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(missingWtRes.status, 409);
  const missingWtData = await missingWtRes.json();
  assert.equal(missingWtData.code, "RESUME_BLOCKED_BY_GIT_ERROR");
  assert.equal(missingWtData.gitCheck.canResume, false);
  assert.equal(missingWtData.gitCheck.isGitRepo, false);
  assert.equal(missingWtData.gitCheck.clean, false);
  const p16DiskState = JSON.parse(
    fs.readFileSync(path.join(p16DotMission, "state.json"), "utf8")
  );
  assert.equal(p16DiskState.status, "paused");

  // --- P18: Running retry session must NOT inherit previous attempt's handoff or commands ---
  const appSrc = fs
    .readFileSync(APP_JS_PATH, "utf8")
    .replace("export function applySnapshot", "function applySnapshot")
    .replace(/initHud\(\);\s*$/, "");
  const vmCtx = vm.createContext({});
  vm.runInContext(appSrc, vmCtx);
  vmCtx.retryState = {
    status: "running",
    activeWorker: {
      runId: "run-attempt-2",
      workerNumber: 2,
      role: "Worker",
      featureId: "retry",
      featureTitle: "Retry feature",
      milestoneId: "m1",
      status: "running",
      taskId: "new-task",
      childThreadId: "new-thread",
    },
    sessions: [
      {
        runId: "run-attempt-1",
        workerNumber: 1,
        role: "Worker",
        featureId: "retry",
        featureTitle: "Retry feature",
        milestoneId: "m1",
        status: "completed",
        taskId: "old-task",
        childThreadId: "old-thread",
        handoff: {
          whatWasImplemented:
            "OLD RUN SUMMARY: this handoff belongs only to the failed first attempt and must not appear as current progress.",
          commandsRun: ["old-attempt-only"],
          discoveredIssues: [],
        },
      },
      {
        runId: "run-attempt-2",
        workerNumber: 2,
        role: "Worker",
        featureId: "retry",
        featureTitle: "Retry feature",
        milestoneId: "m1",
        status: "running",
        taskId: "new-task",
        childThreadId: "new-thread",
      },
    ],
  };
  vmCtx.retryFeatures = [
    {
      id: "retry",
      milestoneId: "m1",
      title: "Retry feature",
      status: "running",
      attempts: 2,
      taskId: "new-task",
      childThreadId: "new-thread",
      lastHandoff: {
        whatWasImplemented:
          "OLD RUN SUMMARY: this handoff belongs only to the failed first attempt and must not appear as current progress.",
        commandsRun: ["old-attempt-only"],
        discoveredIssues: [],
      },
    },
  ];
  const p18Sessions = JSON.parse(
    vm.runInContext("JSON.stringify(synthesizeSessions(retryState, retryFeatures))", vmCtx)
  );
  const oldSession = p18Sessions.find((s) => s.runId === "run-attempt-1");
  const runningSession = p18Sessions.find((s) => s.runId === "run-attempt-2");
  assert.ok(oldSession);
  assert.ok(runningSession);
  assert.equal(
    oldSession.handoff.whatWasImplemented,
    "OLD RUN SUMMARY: this handoff belongs only to the failed first attempt and must not appear as current progress."
  );
  assert.deepEqual(oldSession.handoff.commandsRun, ["old-attempt-only"]);
  assert.equal(runningSession.handoff.whatWasImplemented, "No handoff recorded yet.");
  assert.deepEqual(runningSession.handoff.commandsRun, []);
  assert.equal(runningSession.childThreadId, "new-thread");

  // --- P20: Symlinked CLI path executes main guard and starts server ---
  const p20Dir = createTempMissionWorkspace();
  const symlinkDir = path.join(p20Dir, "symlink-parent");
  fs.symlinkSync(path.dirname(SERVER_MJS_PATH), symlinkDir);
  const symlinkedServerMjs = path.join(symlinkDir, "server.mjs");
  const p20MissionDir = path.join(p20Dir, ".mission");
  let p20Pid = null;
  t.after(() => {
    if (p20Pid) {
      try {
        process.kill(p20Pid, "SIGTERM");
      } catch {}
    }
    fs.rmSync(p20Dir, { recursive: true, force: true });
  });

  const p20Stdout = execFileSync(
    process.execPath,
    [symlinkedServerMjs, "--mission-dir", p20MissionDir, "--port", "0"],
    { cwd: p20Dir, timeout: 4000, encoding: "utf8" }
  );
  const p20Info = JSON.parse(p20Stdout.trim().split("\n")[0]);
  p20Pid = p20Info.pid;
  assert.equal(p20Info.ok, true);
  const p20Res = await fetch(`${p20Info.url}/api/mission/state`);
  assert.equal(p20Res.status, 200);
});
