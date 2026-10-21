import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import vm from "node:vm";
import cp, { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createMissionHudServer,
  BUILTIN_MODEL_CATALOG,
  doesModelSupportEffort,
  normalizeHudModelSettings,
} from "../hud/server.mjs";

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

  // Fixed-tier model selection (V7-R2-F01): switching to gemini-4-argon-high omits top-level effort and reasoningEffort keys in .mission/model-settings.json
  const fixedSwitchRes = await fetch(`${hud.url}/api/mission/model-slots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      slot: "validator",
      model: "gemini-4-argon-high",
      providerInstanceId: "antigravity",
    }),
  });
  assert.equal(fixedSwitchRes.status, 200);
  const diskSettingsFixed = JSON.parse(
    fs.readFileSync(path.join(dotMission, "model-settings.json"), "utf8")
  );
  const updatedSlot = diskSettingsFixed.validator;
  assert.equal(updatedSlot.model, "gemini-4-argon-high");
  assert.equal(updatedSlot.supportsEffort, false);
  assert.equal(!("effort" in updatedSlot), true);
  assert.equal(!("reasoningEffort" in updatedSlot), true);
  assert.equal(!("effort" in updatedSlot.options), true);
  assert.equal(!("reasoningEffort" in updatedSlot.options), true);
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
  // --- P14: Default HUD approve selects first pending feature with real runtime subprocess metadata ---
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

  assert.equal(srv14.executionHooksConfigured, true);
  assert.ok(srv14.dispatchAdapter);

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
  assert.equal(afterApproveState.activeWorker.dispatchPending, undefined);
  assert.match(afterApproveState.activeWorker.taskId, /^node:delegated-task:/);
  assert.match(afterApproveState.activeWorker.childThreadId, /^thread:delegated-task:/);
  assert.ok(afterApproveState.activeWorker.childRunId);
  assert.equal(afterApproveState.activeWorker.worktreePath, p14Dir);
  assert.equal(afterApproveState.activeWorker.runtimeTransport, "bridge-cli-subprocess");
  assert.equal(typeof afterApproveState.activeWorker.workerPid, "number");
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

test("Round 3, Round 4 & Round 5 Scrutiny Fixes (P22, P23, R4-approval-explicit-runtime-rejection, R4-default-runtime-lifecycle, F03-accepted-false): Runtime adapter wiring, explicit rejection on approve, and default runtime subprocess execution", async (t) => {
  // --- P22: dispatchAdapter pauseWorker / pauseMission / resumeWorker wired and rollback on error ---
  const p22Dir = createTempMissionWorkspace();
  execFileSync("git", ["init", "-q", p22Dir]);
  execFileSync("git", ["-C", p22Dir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", p22Dir, "config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(p22Dir, ".gitignore"), ".mission/\n");
  fs.writeFileSync(path.join(p22Dir, "file.txt"), "baseline\n");
  execFileSync("git", ["-C", p22Dir, "add", "."]);
  execFileSync("git", ["-C", p22Dir, "commit", "-qm", "fixture"]);

  const p22DotMission = path.join(p22Dir, ".mission");
  fs.mkdirSync(p22DotMission, { recursive: true });
  fs.writeFileSync(
    path.join(p22DotMission, "state.json"),
    JSON.stringify(
      {
        missionId: "mission-p22",
        title: "P22 Runtime Adapter Wiring",
        repoPath: p22Dir,
        status: "running",
        planAccepted: true,
        revision: 2,
        elapsedMs: 0,
        lastStartedAt: new Date().toISOString(),
        milestones: [{ id: "m1", title: "Milestone one", ordinal: 1 }],
        assertions: [],
        activeWorker: {
          runId: "run-p22",
          workerNumber: 1,
          featureId: "f1",
          featureTitle: "First",
          milestoneId: "m1",
          status: "running",
          taskId: "runtime-task",
          childThreadId: "runtime-child",
          worktreePath: p22Dir,
        },
        sessions: [
          {
            runId: "run-p22",
            workerNumber: 1,
            featureId: "f1",
            featureTitle: "First",
            milestoneId: "m1",
            status: "running",
            taskId: "runtime-task",
            childThreadId: "runtime-child",
            worktreePath: p22Dir,
          },
        ],
      },
      null,
      2
    ) + "\n"
  );

  const calls = [];
  const dispatchAdapter = {
    startMissionRun: async () => {
      calls.push("startMissionRun");
    },
    runFeature: async () => {
      calls.push("runFeature");
    },
    pauseMission: async () => {
      calls.push("pauseMission");
      throw new Error("Runtime pause unavailable");
    },
    pauseWorker: async () => {
      calls.push("pauseWorker");
      throw new Error("Runtime pause unavailable");
    },
    resumeWorker: async () => {
      calls.push("resumeWorker");
      throw new Error("Runtime resume unavailable");
    },
  };

  // Re-write state as running after server init (since server startup reconciles stale running state)
  const srv22 = await createMissionHudServer({
    missionDir: p22Dir,
    port: 0,
    dispatchAdapter,
  });
  t.after(async () => {
    await srv22.close();
    fs.rmSync(p22Dir, { recursive: true, force: true });
  });

  const runningState = JSON.parse(
    fs.readFileSync(path.join(p22DotMission, "state.json"), "utf8")
  );
  runningState.status = "running";
  runningState.activeWorker.status = "running";
  fs.writeFileSync(
    path.join(p22DotMission, "state.json"),
    JSON.stringify(runningState, null, 2) + "\n"
  );

  const pauseRes = await fetch(`${srv22.url}/api/mission/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(pauseRes.status, 500);
  assert.ok(calls.includes("pauseWorker"), "Expected pauseWorker to be invoked");
  const stateAfterFailedPause = JSON.parse(
    fs.readFileSync(path.join(p22DotMission, "state.json"), "utf8")
  );
  assert.equal(stateAfterFailedPause.status, "running");

  // Set state to paused and test resumeWorker failure
  runningState.status = "paused";
  runningState.activeWorker.status = "paused";
  fs.writeFileSync(
    path.join(p22DotMission, "state.json"),
    JSON.stringify(runningState, null, 2) + "\n"
  );

  const resumeRes = await fetch(`${srv22.url}/api/mission/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(resumeRes.status, 500);
  assert.ok(calls.includes("resumeWorker"), "Expected resumeWorker to be invoked");
  const stateAfterFailedResume = JSON.parse(
    fs.readFileSync(path.join(p22DotMission, "state.json"), "utf8")
  );
  assert.equal(stateAfterFailedResume.status, "paused");

  // --- P23: Across all 4 routes (approve, model-slots, pause, resume), onCommand runs BEFORE disk writes ---
  for (const route of ["approve", "model-slots", "pause", "resume"]) {
    const p23Dir = createTempMissionWorkspace();
    execFileSync("git", ["init", "-q", p23Dir]);
    execFileSync("git", ["-C", p23Dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", p23Dir, "config", "user.email", "test@example.invalid"]);
    fs.writeFileSync(path.join(p23Dir, ".gitignore"), ".mission/\n");
    fs.writeFileSync(path.join(p23Dir, "file.txt"), "baseline\n");
    execFileSync("git", ["-C", p23Dir, "add", "."]);
    execFileSync("git", ["-C", p23Dir, "commit", "-qm", "fixture"]);

    const dotM = path.join(p23Dir, ".mission");
    fs.mkdirSync(dotM, { recursive: true });

    const initialStatus =
      route === "approve"
        ? "awaiting_input"
        : route === "resume"
          ? "paused"
          : "running";

    fs.writeFileSync(
      path.join(dotM, "state.json"),
      JSON.stringify(
        {
          missionId: `mission-p23-${route}`,
          title: `P23 ${route}`,
          repoPath: p23Dir,
          status: initialStatus,
          planAccepted: route !== "approve",
          revision: 1,
          elapsedMs: 0,
          lastStartedAt: initialStatus === "running" ? new Date().toISOString() : null,
          milestones: [{ id: "m1", title: "M1", ordinal: 1 }],
          assertions: [],
          activeWorker:
            route === "approve"
              ? null
              : {
                  runId: "run-p23",
                  workerNumber: 1,
                  featureId: "f1",
                  featureTitle: "First",
                  milestoneId: "m1",
                  status: initialStatus === "paused" ? "paused" : "running",
                  taskId: "t1",
                  childThreadId: "c1",
                  worktreePath: p23Dir,
                },
          sessions: [],
        },
        null,
        2
      ) + "\n"
    );
    fs.writeFileSync(
      path.join(dotM, "features.json"),
      JSON.stringify(
        {
          features: [
            {
              id: "f1",
              title: "First",
              milestoneId: "m1",
              status: route === "approve" ? "pending" : "running",
              attempts: route === "approve" ? 0 : 1,
            },
          ],
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );
    fs.writeFileSync(
      path.join(dotM, "model-settings.json"),
      JSON.stringify({ validator: { model: "grok-4.7", effort: 3 } }, null, 2) + "\n"
    );
    fs.writeFileSync(
      path.join(dotM, "progress_log.jsonl"),
      JSON.stringify({ seq: 1, timestamp: new Date().toISOString(), type: "init", message: "init" }) +
        "\n"
    );

    const snap = () => ({
      state: fs.readFileSync(path.join(dotM, "state.json"), "utf8"),
      features: fs.readFileSync(path.join(dotM, "features.json"), "utf8"),
      modelSettings: fs.readFileSync(path.join(dotM, "model-settings.json"), "utf8"),
      progressLog: fs.readFileSync(path.join(dotM, "progress_log.jsonl"), "utf8"),
    });

    let before;
    let during = null;
    const srv23 = await createMissionHudServer({
      missionDir: p23Dir,
      port: 0,
      onCommand: async ({ type }) => {
        const currentState = JSON.parse(
          fs.readFileSync(path.join(dotM, "state.json"), "utf8")
        );
        during = {
          type,
          diskStatus: currentState.status,
          diskAlreadyChanged: JSON.stringify(snap()) !== JSON.stringify(before),
        };
        throw new Error(`Independent ${route} hook rejection`);
      },
    });

    // If route is pause or model-slots, restore running state after startup reconciliation
    if (initialStatus === "running") {
      const st = JSON.parse(fs.readFileSync(path.join(dotM, "state.json"), "utf8"));
      st.status = "running";
      if (st.activeWorker) st.activeWorker.status = "running";
      fs.writeFileSync(path.join(dotM, "state.json"), JSON.stringify(st, null, 2) + "\n");
    }

    before = snap();
    const res = await fetch(`${srv23.url}/api/mission/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        route === "model-slots" ? { slot: "validator", effort: 2 } : {}
      ),
    });
    assert.equal(res.status, 500, `Expected 500 for ${route}`);
    const after = snap();

    assert.ok(during, `Expected onCommand to run for ${route}`);
    assert.equal(during.type, route);
    assert.equal(
      during.diskAlreadyChanged,
      false,
      `Expected diskAlreadyChanged === false during onCommand for ${route}`
    );
    assert.deepEqual(after, before, `Expected disk files unchanged after failed ${route}`);

    await srv23.close();
    fs.rmSync(p23Dir, { recursive: true, force: true });
  }

  // --- R4-approval-explicit-runtime-rejection: Explicit ok:false from runFeature or startMissionRun rejects with 409 ---
  for (const methodKey of ["runFeature", "startMissionRun"]) {
    const r4ApproveDir = createTempMissionWorkspace();
    const r4DotM = path.join(r4ApproveDir, ".mission");
    fs.mkdirSync(r4DotM, { recursive: true });
    fs.writeFileSync(
      path.join(r4DotM, "state.json"),
      JSON.stringify(
        {
          missionId: `mission-r4-reject-${methodKey}`,
          title: "R4 Approval Rejection",
          repoPath: r4ApproveDir,
          status: "awaiting_input",
          planAccepted: false,
          revision: 1,
          elapsedMs: 0,
          lastStartedAt: null,
          milestones: [{ id: "m1", title: "M1", ordinal: 1 }],
          assertions: [],
          activeWorker: null,
          sessions: [],
        },
        null,
        2
      ) + "\n"
    );
    fs.writeFileSync(
      path.join(r4DotM, "features.json"),
      JSON.stringify(
        {
          features: [
            { id: "f1", title: "First", milestoneId: "m1", status: "pending", attempts: 0 },
          ],
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );
    fs.writeFileSync(
      path.join(r4DotM, "model-settings.json"),
      JSON.stringify({ validator: { model: "grok-4.7", effort: 3 } }, null, 2) + "\n"
    );
    fs.writeFileSync(
      path.join(r4DotM, "progress_log.jsonl"),
      JSON.stringify({ seq: 1, timestamp: new Date().toISOString(), type: "init", message: "init" }) +
        "\n"
    );

    const snapFiles = () => ({
      state: fs.readFileSync(path.join(r4DotM, "state.json"), "utf8"),
      features: fs.readFileSync(path.join(r4DotM, "features.json"), "utf8"),
      modelSettings: fs.readFileSync(path.join(r4DotM, "model-settings.json"), "utf8"),
      progressLog: fs.readFileSync(path.join(r4DotM, "progress_log.jsonl"), "utf8"),
    });
    const beforeFiles = snapFiles();

    const customAdapter = {
      [methodKey]: async () => ({
        ok: false,
        error: "Runtime explicitly refused approval dispatch",
      }),
    };

    const srvReject = await createMissionHudServer({
      missionDir: r4ApproveDir,
      port: 0,
      dispatchAdapter: customAdapter,
    });
    const rejectRes = await fetch(`${srvReject.url}/api/mission/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(rejectRes.status, 409, `Expected 409 when ${methodKey} returns ok:false`);
    const rejectBody = await rejectRes.json();
    assert.equal(rejectBody.ok, false);
    assert.match(rejectBody.error, /Runtime explicitly refused approval dispatch/);
    assert.deepEqual(snapFiles(), beforeFiles, `Expected disk unchanged when ${methodKey} rejects`);

    const stateOnDisk = JSON.parse(fs.readFileSync(path.join(r4DotM, "state.json"), "utf8"));
    assert.equal(stateOnDisk.planAccepted, false);
    assert.equal(stateOnDisk.status, "awaiting_input");

    await srvReject.close();
    fs.rmSync(r4ApproveDir, { recursive: true, force: true });
  }

  // --- R4-default-runtime-lifecycle: Default runtime invokes subprocess via cp.execFile across approve/pause/resume ---
  const r4DefaultDir = createTempMissionWorkspace();
  execFileSync("git", ["init", "-q", r4DefaultDir]);
  execFileSync("git", ["-C", r4DefaultDir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", r4DefaultDir, "config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(r4DefaultDir, ".gitignore"), ".mission/\n");
  fs.writeFileSync(path.join(r4DefaultDir, "file.txt"), "baseline\n");
  execFileSync("git", ["-C", r4DefaultDir, "add", "."]);
  execFileSync("git", ["-C", r4DefaultDir, "commit", "-qm", "fixture"]);

  const r4DefaultDotM = path.join(r4DefaultDir, ".mission");
  fs.mkdirSync(r4DefaultDotM, { recursive: true });
  fs.writeFileSync(
    path.join(r4DefaultDotM, "state.json"),
    JSON.stringify(
      {
        missionId: "mission-r4-default",
        title: "R4 Default Lifecycle",
        repoPath: r4DefaultDir,
        status: "awaiting_input",
        planAccepted: false,
        revision: 1,
        elapsedMs: 0,
        lastStartedAt: null,
        milestones: [{ id: "m1", title: "M1", ordinal: 1 }],
        assertions: [],
        activeWorker: null,
        sessions: [],
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(
    path.join(r4DefaultDotM, "features.json"),
    JSON.stringify(
      {
        features: [
          { id: "f1", title: "First", milestoneId: "m1", status: "pending", attempts: 0 },
        ],
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );

  const nonGitProcessCalls = [];
  const origExecFile = cp.execFile;
  cp.execFile = function (...args) {
    const file = String(args[0] || "");
    if (!file.endsWith("git")) {
      nonGitProcessCalls.push({ file, argv: args[1] });
    }
    return origExecFile.apply(this, args);
  };

  const srvDefault = await createMissionHudServer({ missionDir: r4DefaultDir, port: 0 });
  try {
    const appRes = await fetch(`${srvDefault.url}/api/mission/approve`, { method: "POST" });
    assert.equal(appRes.status, 200);
    const pauseDefRes = await fetch(`${srvDefault.url}/api/mission/pause`, { method: "POST" });
    assert.equal(pauseDefRes.status, 200);
    const resDefRes = await fetch(`${srvDefault.url}/api/mission/resume`, { method: "POST" });
    assert.equal(resDefRes.status, 200);

    assert.ok(
      nonGitProcessCalls.length >= 4,
      `Expected default runtime subprocess calls for approve/pause/resume, got ${nonGitProcessCalls.length}`
    );
    const cliCommands = nonGitProcessCalls.map((call) => call.argv[1]);
    assert.deepEqual(cliCommands, [
      "DispatchWorkerRuntime",
      "PauseWorkerRuntime",
      "PauseMissionRuntime",
      "ResumeWorkerRuntime",
    ]);
    for (const call of nonGitProcessCalls) {
      assert.ok(
        String(call.argv[0]).endsWith("bridge/cli.mjs"),
        `Expected bridge/cli.mjs entrypoint, got ${call.argv[0]}`
      );
      assert.notEqual(call.argv[0], "-e");
    }
  } finally {
    cp.execFile = origExecFile;
    await srvDefault.close();
    fs.rmSync(r4DefaultDir, { recursive: true, force: true });
  }

  // --- F03-accepted-false: { accepted: false, error: "Rejected" } from runFeature or startMissionRun rejects with 409 ---
  for (const methodKey of ["runFeature", "startMissionRun"]) {
    const r5ApproveDir = createTempMissionWorkspace();
    const r5DotM = path.join(r5ApproveDir, ".mission");
    fs.mkdirSync(r5DotM, { recursive: true });
    fs.writeFileSync(
      path.join(r5DotM, "state.json"),
      JSON.stringify(
        {
          missionId: `mission-r5-accepted-false-${methodKey}`,
          title: "R5 Accepted False Rejection",
          repoPath: r5ApproveDir,
          status: "awaiting_input",
          planAccepted: false,
          revision: 1,
          elapsedMs: 0,
          lastStartedAt: null,
          milestones: [{ id: "m1", title: "M1", ordinal: 1 }],
          assertions: [],
          activeWorker: null,
          sessions: [],
        },
        null,
        2
      ) + "\n"
    );
    fs.writeFileSync(
      path.join(r5DotM, "features.json"),
      JSON.stringify(
        {
          features: [
            { id: "f1", title: "First", milestoneId: "m1", status: "pending", attempts: 0 },
          ],
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );
    fs.writeFileSync(
      path.join(r5DotM, "model-settings.json"),
      JSON.stringify({ validator: { model: "grok-4.7", effort: 3 } }, null, 2) + "\n"
    );
    fs.writeFileSync(
      path.join(r5DotM, "progress_log.jsonl"),
      JSON.stringify({ seq: 1, timestamp: new Date().toISOString(), type: "init", message: "init" }) +
        "\n"
    );

    const snapFiles = () => ({
      state: fs.readFileSync(path.join(r5DotM, "state.json"), "utf8"),
      features: fs.readFileSync(path.join(r5DotM, "features.json"), "utf8"),
      modelSettings: fs.readFileSync(path.join(r5DotM, "model-settings.json"), "utf8"),
      progressLog: fs.readFileSync(path.join(r5DotM, "progress_log.jsonl"), "utf8"),
    });
    const beforeFiles = snapFiles();

    const customAdapter = {
      [methodKey]: async () => ({
        accepted: false,
        error: "Rejected",
      }),
    };

    const srvReject = await createMissionHudServer({
      missionDir: r5ApproveDir,
      port: 0,
      runtimeAdapter: customAdapter,
    });
    const rejectRes = await fetch(`${srvReject.url}/api/mission/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(rejectRes.status, 409, `Expected 409 when ${methodKey} returns accepted:false`);
    const rejectBody = await rejectRes.json();
    assert.equal(rejectBody.ok, false);
    assert.equal(rejectBody.code, "APPROVAL_DISPATCH_REJECTED");
    assert.equal(rejectBody.error, "Rejected");
    assert.deepEqual(snapFiles(), beforeFiles, `Expected disk unchanged when ${methodKey} returns accepted:false`);

    const stateOnDisk = JSON.parse(fs.readFileSync(path.join(r5DotM, "state.json"), "utf8"));
    assert.equal(stateOnDisk.planAccepted, false);
    assert.equal(stateOnDisk.status, "awaiting_input");

    await srvReject.close();
    fs.rmSync(r5ApproveDir, { recursive: true, force: true });
  }

  // --- R5-daemon-metadata-persistence: daemonStateFile and daemonStatus persisted across approve, pause, and resume ---
  const r5DaemonDir = createTempMissionWorkspace();
  execFileSync("git", ["init", "-q", r5DaemonDir]);
  execFileSync("git", ["-C", r5DaemonDir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", r5DaemonDir, "config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(r5DaemonDir, ".gitignore"), ".mission/\n");
  fs.writeFileSync(path.join(r5DaemonDir, "file.txt"), "baseline\n");
  execFileSync("git", ["-C", r5DaemonDir, "add", "."]);
  execFileSync("git", ["-C", r5DaemonDir, "commit", "-qm", "fixture"]);

  const r5DaemonDotM = path.join(r5DaemonDir, ".mission");
  fs.mkdirSync(r5DaemonDotM, { recursive: true });
  fs.writeFileSync(
    path.join(r5DaemonDotM, "state.json"),
    JSON.stringify(
      {
        missionId: "mission-r5-daemon",
        title: "R5 Daemon Metadata",
        repoPath: r5DaemonDir,
        status: "awaiting_input",
        planAccepted: false,
        revision: 1,
        elapsedMs: 0,
        lastStartedAt: null,
        milestones: [{ id: "m1", title: "M1", ordinal: 1 }],
        assertions: [],
        activeWorker: null,
        sessions: [],
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(
    path.join(r5DaemonDotM, "features.json"),
    JSON.stringify(
      {
        features: [
          { id: "f1", title: "First", milestoneId: "m1", status: "pending", attempts: 0 },
        ],
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );

  const daemonStateFilePath = path.join(r5DaemonDotM, "worker-daemon-state.json");
  const srvDaemon = await createMissionHudServer({
    missionDir: r5DaemonDir,
    port: 0,
    runtimeAdapter: {
      runFeature: async () => ({
        ok: true,
        dispatched: true,
        daemonStateFile: daemonStateFilePath,
        daemonStatus: "running",
      }),
      pauseWorker: async () => ({
        ok: true,
        paused: true,
        daemonStatus: "paused",
      }),
      resumeWorker: async () => ({
        ok: true,
        resumed: true,
        daemonStatus: "resumed",
      }),
    },
  });

  try {
    const appRes = await fetch(`${srvDaemon.url}/api/mission/approve`, { method: "POST" });
    assert.equal(appRes.status, 200);
    const appState = JSON.parse(fs.readFileSync(path.join(r5DaemonDotM, "state.json"), "utf8"));
    assert.equal(appState.activeWorker.daemonStateFile, daemonStateFilePath);
    assert.equal(appState.activeWorker.daemonStatus, "running");

    const pauseRes = await fetch(`${srvDaemon.url}/api/mission/pause`, { method: "POST" });
    assert.equal(pauseRes.status, 200);
    const pausedState = JSON.parse(fs.readFileSync(path.join(r5DaemonDotM, "state.json"), "utf8"));
    assert.equal(pausedState.activeWorker.daemonStatus, "paused");

    const resumeRes = await fetch(`${srvDaemon.url}/api/mission/resume`, { method: "POST" });
    assert.equal(resumeRes.status, 200);
    const resumedState = JSON.parse(fs.readFileSync(path.join(r5DaemonDotM, "state.json"), "utf8"));
    assert.equal(resumedState.activeWorker.daemonStatus, "resumed");
  } finally {
    await srvDaemon.close();
    fs.rmSync(r5DaemonDir, { recursive: true, force: true });
  }
});

test("Round 6 Scrutiny Fix (F03-dead-worker-control-success): Killing default HUD runtime daemon causes POST /api/mission/pause and POST /api/mission/resume to return HTTP 409 and preserve all 4 .mission/* files", async (t) => {
  const r6Dir = createTempMissionWorkspace();
  execFileSync("git", ["init", "-q", r6Dir]);
  execFileSync("git", ["-C", r6Dir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", r6Dir, "config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(r6Dir, ".gitignore"), ".mission/\n");
  fs.writeFileSync(path.join(r6Dir, "file.txt"), "baseline\n");
  execFileSync("git", ["-C", r6Dir, "add", "."]);
  execFileSync("git", ["-C", r6Dir, "commit", "-qm", "fixture"]);

  const r6DotM = path.join(r6Dir, ".mission");
  fs.mkdirSync(r6DotM, { recursive: true });
  fs.writeFileSync(
    path.join(r6DotM, "state.json"),
    JSON.stringify(
      {
        missionId: "mission-r6-dead-worker",
        title: "R6 Dead Worker Control",
        repoPath: r6Dir,
        status: "awaiting_input",
        planAccepted: false,
        revision: 1,
        elapsedMs: 0,
        lastStartedAt: null,
        milestones: [{ id: "m1", title: "M1", ordinal: 1 }],
        assertions: [],
        activeWorker: null,
        sessions: [],
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(
    path.join(r6DotM, "features.json"),
    JSON.stringify(
      {
        features: [
          { id: "f1", title: "First", milestoneId: "m1", status: "pending", attempts: 0 },
        ],
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
  fs.writeFileSync(
    path.join(r6DotM, "model-settings.json"),
    JSON.stringify({ validator: { model: "grok-4.7", effort: 3 } }, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(r6DotM, "progress_log.jsonl"),
    JSON.stringify({ seq: 1, timestamp: new Date().toISOString(), type: "init", message: "init" }) +
      "\n"
  );

  const snapFourFiles = () => ({
    state: fs.readFileSync(path.join(r6DotM, "state.json"), "utf8"),
    features: fs.readFileSync(path.join(r6DotM, "features.json"), "utf8"),
    modelSettings: fs.readFileSync(path.join(r6DotM, "model-settings.json"), "utf8"),
    progressLog: fs.readFileSync(path.join(r6DotM, "progress_log.jsonl"), "utf8"),
  });

  const srv = await createMissionHudServer({ missionDir: r6Dir, port: 0 });
  t.after(async () => {
    await srv.close();
    fs.rmSync(r6Dir, { recursive: true, force: true });
  });

  // 1. Approve mission to launch real local worker daemon
  const appRes = await fetch(`${srv.url}/api/mission/approve`, { method: "POST" });
  assert.equal(appRes.status, 200);
  const runningState = JSON.parse(fs.readFileSync(path.join(r6DotM, "state.json"), "utf8"));
  const workerPid = runningState.activeWorker.workerPid;
  const daemonStateFile = runningState.activeWorker.daemonStateFile;
  assert.equal(typeof workerPid, "number");
  assert.equal(typeof daemonStateFile, "string");

  // Kill the active worker daemon and remove its daemonStateFile while running
  try {
    process.kill(workerPid, "SIGKILL");
  } catch {}
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(workerPid, 0);
      await new Promise((r) => setTimeout(r, 15));
    } catch {
      break;
    }
  }
  if (fs.existsSync(daemonStateFile)) {
    fs.unlinkSync(daemonStateFile);
  }

  const beforePauseFiles = snapFourFiles();
  const deadPauseRes = await fetch(`${srv.url}/api/mission/pause`, { method: "POST" });
  assert.equal(deadPauseRes.status, 409, "Expected HTTP 409 when pausing dead worker");
  const deadPauseBody = await deadPauseRes.json();
  assert.equal(deadPauseBody.ok, false);
  assert.equal(deadPauseBody.code, "WORKER_NOT_ALIVE");
  assert.deepEqual(
    snapFourFiles(),
    beforePauseFiles,
    "Expected all 4 .mission/* files unchanged after rejected pause"
  );

  // 2. Transition state on disk to paused (as if previously paused before daemon died) and verify POST /api/mission/resume also rejects with 409 and preserves all 4 .mission/* files
  const pausedState = structuredClone(runningState);
  pausedState.status = "paused";
  pausedState.activeWorker.status = "paused";
  fs.writeFileSync(path.join(r6DotM, "state.json"), JSON.stringify(pausedState, null, 2) + "\n");

  const beforeResumeFiles = snapFourFiles();
  const deadResumeRes = await fetch(`${srv.url}/api/mission/resume`, { method: "POST" });
  assert.equal(deadResumeRes.status, 409, "Expected HTTP 409 when resuming dead worker");
  const deadResumeBody = await deadResumeRes.json();
  assert.equal(deadResumeBody.ok, false);
  assert.equal(deadResumeBody.code, "WORKER_NOT_ALIVE");
  assert.deepEqual(
    snapFourFiles(),
    beforeResumeFiles,
    "Expected all 4 .mission/* files unchanged after rejected resume"
  );
});

test("Round 7 E2E Browser Contract Fixes (UI-STATUS-LABEL, UI-APPROVE-ID, RESUME-ERROR-CODE, ASSERTIONS-NOT-RENDERED)", async (t) => {
  // 1. Verify index.html static markup has #status-strip-label = AWAITING INPUT and #assertions-section / #assertions-list
  const indexHtmlPath = path.resolve(__dirname, "../hud/public/index.html");
  const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
  assert.match(indexHtml, /id="status-strip-label">AWAITING INPUT<\/span>/);
  assert.match(indexHtml, /id="assertions-section"/);
  assert.match(indexHtml, /id="assertions-count">0\/0<\/span>/);
  assert.match(indexHtml, /id="assertions-list"/);

  // 2. Verify app.js DOM rendering for UI-STATUS-LABEL, UI-APPROVE-ID (#btn-approve), and ASSERTIONS-NOT-RENDERED (#assertions-list)
  const appSrc = fs
    .readFileSync(APP_JS_PATH, "utf8")
    .replace("export function applySnapshot", "function applySnapshot")
    .replace(/initHud\(\);\s*$/, "");

  const elements = new Map();
  let approvedTriggeredCount = 0;

  function makeEl(id) {
    const el = {
      id,
      textContent: "",
      innerHTML: "",
      dataset: {},
      style: {},
      value: "",
      listeners: {},
      classList: {
        classes: new Set(),
        add(c) {
          this.classes.add(c);
        },
        remove(c) {
          this.classes.delete(c);
        },
        toggle(c, force) {
          if (force === undefined) {
            if (this.classes.has(c)) this.classes.delete(c);
            else this.classes.add(c);
          } else if (force) {
            this.classes.add(c);
          } else {
            this.classes.delete(c);
          }
        },
        contains(c) {
          return this.classes.has(c);
        },
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      querySelector(sel) {
        if (sel === "#btn-approve" && this.innerHTML.includes('id="btn-approve"')) {
          if (!this._btnApprove) {
            this._btnApprove = makeEl("btn-approve");
          }
          return this._btnApprove;
        }
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    return el;
  }

  for (const id of [
    "status-strip",
    "status-strip-label",
    "status-strip-subtext",
    "strip-approve-btn",
    "btn-pause",
    "btn-resume",
    "onboarding-card",
    "plan-approval-card",
    "session-handoff-view",
    "orchestrator-stream",
    "pipeline-text",
    "composer-status-msg",
    "toolbar-orchestrator-model",
    "features-count",
    "features-list",
    "assertions-count",
    "assertions-list",
    "progress-log-count",
    "progress-log-list",
  ]) {
    elements.set(id, makeEl(id));
  }

  const vmCtx = vm.createContext({
    document: {
      getElementById: (id) => elements.get(id) || null,
    },
    fetch: async (url) => {
      if (url === "/api/mission/approve") {
        approvedTriggeredCount += 1;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    },
  });

  vm.runInContext(appSrc, vmCtx);

  // Verify getStatusBannerText returns "AWAITING INPUT" regardless of planAccepted when status === "awaiting_input"
  assert.equal(
    vm.runInContext('getStatusBannerText({ status: "awaiting_input", planAccepted: false })', vmCtx),
    "AWAITING INPUT"
  );
  assert.equal(
    vm.runInContext('getStatusBannerText({ status: "awaiting_input", planAccepted: true })', vmCtx),
    "AWAITING INPUT"
  );

  // Apply snapshot and inspect rendered DOM elements
  const testSnapshot = {
    initialized: true,
    state: {
      status: "awaiting_input",
      planAccepted: false,
      revision: 1,
      title: "Test Mission",
      milestones: [{ id: "m1", title: "M1" }],
      assertions: [
        { id: "VAL-HUD-001", description: "Live SSE stream", status: "passed" },
        { id: "VAL-HUD-002", description: "Approve mission button", status: "pending" },
        { id: "VAL-HUD-003", description: "Model slot switch", status: "failed" },
      ],
    },
    features: [{ id: "f1", title: "Feature 1", milestoneId: "m1", status: "completed" }],
    progressLog: [],
    modelSettings: {},
    catalog: [],
  };

  vmCtx.testSnapshot = testSnapshot;
  vm.runInContext("applySnapshot(testSnapshot)", vmCtx);

  assert.equal(elements.get("status-strip-label").textContent, "AWAITING INPUT");

  const approvalCard = elements.get("plan-approval-card");
  assert.match(approvalCard.innerHTML, /id="btn-approve"/);
  assert.match(approvalCard.innerHTML, /data-testid="btn-approve-mission"/);
  assert.match(approvalCard.innerHTML, /data-action="approve"/);
  assert.ok(approvalCard._btnApprove?.listeners?.click, "Expected click listener on #btn-approve");
  await approvalCard._btnApprove.listeners.click();
  assert.equal(approvedTriggeredCount, 1, "Clicking #btn-approve should trigger triggerApprove()");

  assert.equal(elements.get("assertions-count").textContent, "1/3");
  const assertionsHtml = elements.get("assertions-list").innerHTML;
  assert.match(assertionsHtml, /data-assertion-id="VAL-HUD-001"/);
  assert.match(assertionsHtml, /data-assertion-status="passed"/);
  assert.match(assertionsHtml, /data-assertion-id="VAL-HUD-002"/);
  assert.match(assertionsHtml, /data-assertion-status="pending"/);
  assert.match(assertionsHtml, /data-assertion-id="VAL-HUD-003"/);
  assert.match(assertionsHtml, /data-assertion-status="failed"/);

  // 3. Verify RESUME-ERROR-CODE: Unresolved git merge conflicts return code="GIT_RESUME_BLOCKED" and reasonCode="RESUME_BLOCKED_BY_CONFLICTS"
  const conflictDir = createTempMissionWorkspace();
  execFileSync("git", ["init", "-q", "-b", "main", conflictDir]);
  execFileSync("git", ["-C", conflictDir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", conflictDir, "config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(conflictDir, ".gitignore"), ".mission/\n");
  fs.writeFileSync(path.join(conflictDir, "shared.txt"), "base line\n");
  execFileSync("git", ["-C", conflictDir, "add", "."]);
  execFileSync("git", ["-C", conflictDir, "commit", "-qm", "base"]);

  execFileSync("git", ["-C", conflictDir, "checkout", "-qb", "feature-branch"]);
  fs.writeFileSync(path.join(conflictDir, "shared.txt"), "feature change\n");
  execFileSync("git", ["-C", conflictDir, "commit", "-qam", "feature commit"]);

  execFileSync("git", ["-C", conflictDir, "checkout", "-q", "main"]);
  fs.writeFileSync(path.join(conflictDir, "shared.txt"), "main conflicting change\n");
  execFileSync("git", ["-C", conflictDir, "commit", "-qam", "main commit"]);

  assert.throws(() => {
    execFileSync("git", ["-C", conflictDir, "merge", "feature-branch"]);
  });

  const dotM = path.join(conflictDir, ".mission");
  fs.mkdirSync(dotM, { recursive: true });
  fs.writeFileSync(
    path.join(dotM, "state.json"),
    JSON.stringify(
      {
        missionId: "mission-conflict-test",
        title: "Conflict Resume Test",
        repoPath: conflictDir,
        status: "paused",
        planAccepted: true,
        revision: 2,
        activeWorker: {
          runId: "run-conflict-1",
          workerNumber: 1,
          featureId: "f-conflict",
          featureTitle: "Conflict feature",
          status: "paused",
          worktreePath: conflictDir,
        },
        sessions: [],
      },
      null,
      2
    ) + "\n"
  );

  const conflictHud = await createMissionHudServer({ missionDir: conflictDir, port: 0 });
  t.after(async () => {
    await conflictHud.close();
    fs.rmSync(conflictDir, { recursive: true, force: true });
  });

  const conflictRes = await fetch(`${conflictHud.url}/api/mission/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(conflictRes.status, 409);
  const conflictBody = await conflictRes.json();
  assert.equal(conflictBody.ok, false);
  assert.equal(conflictBody.code, "GIT_RESUME_BLOCKED");
  assert.equal(conflictBody.reasonCode, "RESUME_BLOCKED_BY_CONFLICTS");
  assert.equal(conflictBody.error, "Unresolved git merge conflicts in working tree");
  assert.equal(conflictBody.gitCheck.hasConflicts, true);
  assert.equal(conflictBody.gitCheck.canResume, false);
});

test("HUD Effort Capability Fix (t3m-m1-w3-hud-effort-cap-fix-v1): Fixed-tier / antigravity models hide effort bars and strip effort options", async () => {
  // 1. Verify BUILTIN_MODEL_CATALOG effort metadata and doesModelSupportEffort helper
  const geminiEntry = BUILTIN_MODEL_CATALOG.find((m) => m.id === "gemini-4-argon-high");
  assert.ok(geminiEntry);
  assert.equal(geminiEntry.supportsEffort, false);
  assert.deepEqual(geminiEntry.effortLevels, []);
  assert.equal(geminiEntry.effort, null);
  assert.equal(geminiEntry.reasoningEffort, null);

  const astraEntry = BUILTIN_MODEL_CATALOG.find((m) => m.id === "gpt-6-astra-high");
  assert.ok(astraEntry);
  assert.equal(astraEntry.supportsEffort, false);
  assert.deepEqual(astraEntry.effortLevels, []);
  assert.equal(astraEntry.effort, null);
  assert.equal(astraEntry.reasoningEffort, null);

  const opusEntry = BUILTIN_MODEL_CATALOG.find((m) => m.id === "claude-opus-5-5");
  assert.equal(opusEntry.supportsEffort, true);
  assert.deepEqual(opusEntry.effortLevels, ["low", "medium", "high", "xhigh", "max"]);

  assert.equal(doesModelSupportEffort("gemini-4-argon-high"), false);
  assert.equal(doesModelSupportEffort({ model: "custom-model", providerInstanceId: "antigravity" }), false);
  assert.equal(doesModelSupportEffort({ model: "custom-model-high", providerInstanceId: "openai" }), false);
  assert.equal(doesModelSupportEffort("gpt-6.1-sol"), true);
  assert.equal(doesModelSupportEffort("claude-opus-5-5"), true);

  // 2. Verify normalizeHudModelSettings strips effort/reasoningEffort for gemini-4-argon-high (antigravity)
  const normalized = normalizeHudModelSettings({
    orchestrator: {
      model: "gemini-4-argon-high",
      providerInstanceId: "antigravity",
      effort: 4,
      reasoningEffort: "high",
      options: { effort: 4, reasoningEffort: "high" },
    },
    worker: "gpt-6.1-sol",
    validator: "claude-opus-5-5",
  });

  assert.equal(normalized.orchestrator.model, "gemini-4-argon-high");
  assert.equal(normalized.orchestrator.providerInstanceId, "antigravity");
  assert.equal(normalized.orchestrator.supportsEffort, false);
  assert.deepEqual(normalized.orchestrator.effortLevels, []);
  assert.equal("effort" in normalized.orchestrator, false);
  assert.equal("reasoningEffort" in normalized.orchestrator, false);
  assert.equal(Object.hasOwn(normalized.orchestrator, "effort"), false);
  assert.equal(Object.hasOwn(normalized.orchestrator, "reasoningEffort"), false);
  assert.equal("effort" in normalized.orchestrator.options, false);
  assert.equal("reasoningEffort" in normalized.orchestrator.options, false);
  assert.deepEqual(normalized.orchestrator.options, {});

  const normalizedString = normalizeHudModelSettings({
    orchestrator: "gemini-4-argon-high",
  });
  assert.equal(normalizedString.orchestrator.supportsEffort, false);
  assert.equal("effort" in normalizedString.orchestrator, false);
  assert.equal("reasoningEffort" in normalizedString.orchestrator, false);
  assert.deepEqual(normalizedString.orchestrator.options, {});

  assert.equal(normalized.worker.model, "gpt-6.1-sol");
  assert.equal(normalized.worker.supportsEffort, true);
  assert.equal(normalized.worker.effort, 4);
  assert.equal(normalized.worker.reasoningEffort, "high");
  assert.equal(normalized.worker.options.effort, 4);
  assert.equal(normalized.worker.options.reasoningEffort, "high");

  assert.equal(normalized.validator.model, "claude-opus-5-5");
  assert.equal(normalized.validator.supportsEffort, true);
  assert.equal(normalized.validator.effort, 5);
  assert.equal(normalized.validator.reasoningEffort, "max");

  // 3. Verify HUD DOM hides #effort-bars-<slot> for gemini-4-argon-high and shows interactive bars for gpt-6.1-sol / claude-opus-5-5
  const appSrc = fs
    .readFileSync(APP_JS_PATH, "utf8")
    .replace("export function applySnapshot", "function applySnapshot")
    .replace(/initHud\(\);\s*$/, "");

  const elements = new Map();
  const slotUpdates = [];

  function makeDomEl(id) {
    const attrs = new Map();
    const el = {
      id,
      textContent: "",
      innerHTML: "",
      dataset: {},
      style: {},
      value: "",
      listeners: {},
      _buttons: [],
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      classList: {
        classes: new Set(),
        add(c) {
          this.classes.add(c);
        },
        remove(c) {
          this.classes.delete(c);
        },
        toggle(c, force) {
          if (force === undefined) {
            if (this.classes.has(c)) this.classes.delete(c);
            else this.classes.add(c);
          } else if (force) {
            this.classes.add(c);
          } else {
            this.classes.delete(c);
          }
        },
        contains(c) {
          return this.classes.has(c);
        },
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      querySelector() {
        return null;
      },
      querySelectorAll(sel) {
        if (sel === ".effort-bar-btn") {
          const matches = [
            ...this.innerHTML.matchAll(
              /<button[^>]*class="effort-bar-btn[^"]*"[^>]*data-slot="([^"]+)"[^>]*data-effort="(\d+)"[^>]*>/g
            ),
          ];
          this._buttons = matches.map((m) => {
            const btn = makeDomEl(`btn-${m[1]}-${m[2]}`);
            btn.dataset = { slot: m[1], effort: m[2] };
            return btn;
          });
          return this._buttons;
        }
        return [];
      },
    };
    return el;
  }

  for (const slot of ["orchestrator", "worker", "validator"]) {
    elements.set(`model-select-${slot}`, makeDomEl(`model-select-${slot}`));
    elements.set(`effort-bars-${slot}`, makeDomEl(`effort-bars-${slot}`));
  }

  const vmCtx = vm.createContext({
    document: {
      getElementById: (id) => elements.get(id) || null,
    },
    fetch: async (url, opts) => {
      if (url === "/api/mission/model-slots" && opts?.body) {
        slotUpdates.push(JSON.parse(opts.body));
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    },
  });

  vm.runInContext(appSrc, vmCtx);

  vmCtx.snapshot = {
    initialized: true,
    state: { status: "running", planAccepted: true, revision: 1, milestones: [], assertions: [] },
    features: [],
    progressLog: [],
    modelSettings: normalized,
    catalog: BUILTIN_MODEL_CATALOG,
  };
  vm.runInContext("applySnapshot(snapshot)", vmCtx);

  // Orchestrator has gemini-4-argon-high -> hidden and 0 effort buttons
  const orchBars = elements.get("effort-bars-orchestrator");
  assert.equal(orchBars.classList.contains("hidden"), true);
  assert.equal(orchBars.style.display, "none");
  assert.equal(orchBars.getAttribute("aria-hidden"), "true");
  assert.equal(orchBars.innerHTML, "");
  assert.equal(orchBars.querySelectorAll(".effort-bar-btn").length, 0);

  const orchSelectHtml = elements.get("model-select-orchestrator").innerHTML;
  assert.match(orchSelectHtml, /value="gemini-4-argon-high"[\s\S]*?data-supports-effort="false"/);
  assert.match(orchSelectHtml, /value="claude-opus-5-5"[\s\S]*?data-supports-effort="true"/);

  // Worker has gpt-6.1-sol -> visible and 5 interactive effort buttons
  const workerBars = elements.get("effort-bars-worker");
  assert.equal(workerBars.classList.contains("hidden"), false);
  assert.equal(workerBars.style.display, "");
  assert.equal(workerBars.getAttribute("aria-hidden"), null);
  assert.equal(workerBars._buttons.length, 5);
  assert.match(workerBars.innerHTML, /title="Reasoning Effort: high \(4\/5\)"/);

  // Validator has claude-opus-5-5 -> visible and 5 interactive effort buttons
  const validatorBars = elements.get("effort-bars-validator");
  assert.equal(validatorBars.classList.contains("hidden"), false);
  assert.equal(validatorBars.style.display, "");
  assert.equal(validatorBars.getAttribute("aria-hidden"), null);
  assert.equal(validatorBars._buttons.length, 5);
  assert.match(validatorBars.innerHTML, /title="Reasoning Effort: max \(5\/5\)"/);

  // Clicking bar #3 on worker triggers POST /api/mission/model-slots with effort: 3
  await workerBars._buttons[2].listeners.click();
  assert.equal(slotUpdates.length, 1);
  assert.equal(slotUpdates[0].slot, "worker");
  assert.equal(slotUpdates[0].model, "gpt-6.1-sol");
  assert.equal(slotUpdates[0].effort, 3);
});

test("Validator #7 Fixes (V7-F01, V7-F05, V7-F06): UNINITIALIZED status label, caught postAction errors without unhandled rejection, and dual #session-list/#sessions-list + #session-inspector/#session-handoff-view selectors", async () => {
  // 1. V7-F06: Verify index.html contains both #session-list and #sessions-list, and both #session-inspector and #session-handoff-view
  const indexHtmlPath = path.resolve(__dirname, "../hud/public/index.html");
  const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
  assert.match(indexHtml, /id="session-list"[\s\S]*?id="sessions-list"/);
  assert.match(indexHtml, /id="session-inspector"[\s\S]*?id="session-handoff-view"/);

  // 2. V7-F01, V7-F05, V7-F06 in app.js DOM execution
  const appSrc = fs
    .readFileSync(APP_JS_PATH, "utf8")
    .replace("export function applySnapshot", "function applySnapshot")
    .replace(/initHud\(\);\s*$/, "");

  const elements = new Map();
  function makeEl(id) {
    const el = {
      id,
      textContent: "",
      innerHTML: "",
      dataset: {},
      style: {},
      value: "",
      listeners: {},
      classList: {
        classes: new Set(["hidden"]),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (this.classes.has(c)) this.classes.delete(c);
            else this.classes.add(c);
          } else if (force) {
            this.classes.add(c);
          } else {
            this.classes.delete(c);
          }
        },
        contains(c) { return this.classes.has(c); }
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; }
    };
    return el;
  }

  for (const id of [
    "status-strip",
    "status-strip-label",
    "status-strip-subtext",
    "strip-approve-btn",
    "btn-pause",
    "btn-resume",
    "sessions-list",
    "sessions-count",
    "onboarding-card",
    "plan-approval-card",
    "session-inspector",
    "session-handoff-view",
    "orchestrator-stream",
    "resume-diagnostic-card",
    "pipeline-text",
    "composer-status-msg",
    "toolbar-orchestrator-model",
    "model-save-status",
    "features-count",
    "features-list",
    "assertions-count",
    "assertions-list",
    "progress-log-count",
    "progress-log-list"
  ]) {
    elements.set(id, makeEl(id));
  }

  const vmCtx = vm.createContext({
    document: {
      getElementById: (id) => elements.get(id) || null
    },
    fetch: async (url) => {
      if (url === "/api/mission/resume") {
        return {
          ok: false,
          status: 409,
          text: async () => JSON.stringify({
            ok: false,
            code: "GIT_RESUME_BLOCKED",
            reasonCode: "RESUME_BLOCKED_BY_CONFLICTS",
            error: "Unresolved git merge conflicts in working tree"
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      };
    }
  });

  vm.runInContext(appSrc, vmCtx);
  vm.runInContext("bindStaticListeners()", vmCtx);

  // V7-F01: When snapshot.initialized === false, #status-strip-label is UNINITIALIZED
  vmCtx.uninitSnapshot = {
    initialized: false,
    state: { status: "planning", planAccepted: false, revision: 0 },
    features: [],
    progressLog: [],
    modelSettings: {},
    catalog: []
  };
  vm.runInContext("applySnapshot(uninitSnapshot)", vmCtx);
  assert.equal(elements.get("status-strip-label").textContent, "UNINITIALIZED");

  // When snapshot.initialized === true and status === "planning", #status-strip-label remains PLANNING
  vmCtx.planningSnapshot = {
    initialized: true,
    state: {
      status: "planning",
      planAccepted: false,
      revision: 1,
      sessions: [
        {
          sessionId: "worker-1",
          runId: "run-1",
          workerNumber: 1,
          role: "Worker",
          milestoneId: "m1",
          featureId: "f1",
          title: "Feature 1",
          status: "completed"
        }
      ]
    },
    features: [{ id: "f1", title: "Feature 1", milestoneId: "m1", status: "completed" }],
    progressLog: [],
    modelSettings: {},
    catalog: []
  };
  vm.runInContext("applySnapshot(planningSnapshot)", vmCtx);
  assert.equal(elements.get("status-strip-label").textContent, "PLANNING");

  // V7-F06: Selecting a non-orchestrator session unhides both #session-inspector and #session-handoff-view
  vm.runInContext(`hudState.selectedSessionId = "worker-1"; renderCenterColumn(hudState.snapshot);`, vmCtx);
  assert.equal(elements.get("session-inspector").classList.contains("hidden"), false);
  assert.equal(elements.get("session-handoff-view").classList.contains("hidden"), false);

  // V7-F05: Clicking #btn-resume when server returns HTTP 409 does NOT reject / throw uncaught error, and records hudState.lastActionError
  const resumeBtn = elements.get("btn-resume");
  assert.equal(typeof resumeBtn.listeners.click, "function");
  await assert.doesNotReject(async () => {
    await resumeBtn.listeners.click();
  });
  const lastErr = vm.runInContext("hudState.lastActionError", vmCtx);
  assert.match(lastErr, /HTTP 409/);
  assert.match(lastErr, /RESUME_BLOCKED_BY_CONFLICTS/);
});

test("First-Principles T3-Native HUD Redesign: No fake composer/toolbar/fallbacks, full >8 features & >8 assertions without truncation, and model_slots_updated spam filtering", async () => {
  const indexHtmlPath = path.resolve(__dirname, "../hud/public/index.html");
  const stylesCssPath = path.resolve(__dirname, "../hud/public/styles.css");
  const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
  const stylesCss = fs.readFileSync(stylesCssPath, "utf8");
  const appRaw = fs.readFileSync(APP_JS_PATH, "utf8");

  // 1. Verify absence of fake standalone chat composer, toolbar chips, fake metric widths, and hardcoded fallback strings
  for (const banned of [
    "Pause to send messages",
    "Connectors (1)",
    "Autonomy",
    "Wu David",
    "Back to App",
    "Open SlideStudio",
    "Milestone 1: Intake",
    "Milestone 2: Materials In Run",
    "M2 material test gaps",
    "m2-material-test-gaps",
  ]) {
    assert.equal(
      indexHtml.includes(banned),
      false,
      `index.html must not contain fake/hardcoded string: ${banned}`
    );
    assert.equal(
      appRaw.includes(banned),
      false,
      `app.js must not contain fake/hardcoded string: ${banned}`
    );
  }
  assert.equal(stylesCss.includes("width: 65%"), false, "styles.css must not hardcode 65% bar width");
  assert.equal(appRaw.includes(".slice(0, 8)"), false, "app.js must not truncate features or assertions to .slice(0, 8)");

  // 2. Verify DOM rendering of >8 features (with linked VAL-* pills) and >8 assertions without truncation, plus model_slots_updated spam filtering
  const appSrc = appRaw
    .replace("export function applySnapshot", "function applySnapshot")
    .replace(/initHud\(\);\s*$/, "");

  const elements = new Map();
  function makeEl(id) {
    return {
      id,
      textContent: "",
      innerHTML: "",
      dataset: {},
      style: {},
      value: "",
      listeners: {},
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (this.classes.has(c)) this.classes.delete(c);
            else this.classes.add(c);
          } else if (force) {
            this.classes.add(c);
          } else {
            this.classes.delete(c);
          }
        },
        contains(c) { return this.classes.has(c); },
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
  }

  for (const id of [
    "mission-repo-path",
    "mission-title",
    "metric-time",
    "metric-progress",
    "metric-progress-bar",
    "metric-contract",
    "metric-contract-bar",
    "status-strip",
    "status-strip-label",
    "status-strip-subtext",
    "strip-approve-btn",
    "btn-pause",
    "btn-resume",
    "milestone-stepper-track",
    "pipeline-text",
    "sessions-list",
    "sessions-count",
    "onboarding-card",
    "plan-approval-card",
    "session-inspector",
    "session-handoff-view",
    "orchestrator-stream",
    "resume-diagnostic-card",
    "features-count",
    "features-list",
    "assertions-count",
    "assertions-list",
    "progress-log-count",
    "progress-log-list",
  ]) {
    elements.set(id, makeEl(id));
  }

  const vmCtx = vm.createContext({
    document: {
      getElementById: (id) => elements.get(id) || null,
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
  });

  vm.runInContext(appSrc, vmCtx);

  const twelveFeatures = Array.from({ length: 12 }, (_, i) => ({
    id: `f-${i + 1}`,
    title: `Feature Item #${i + 1}`,
    milestoneId: i < 6 ? "m1" : "m2",
    status: i < 3 ? "completed" : i === 3 ? "running" : "pending",
    kind: "implementation",
    fulfills: [`VAL-M-${String(i + 1).padStart(3, "0")}`],
  }));

  const twelveAssertions = Array.from({ length: 12 }, (_, i) => ({
    id: `VAL-M-${String(i + 1).padStart(3, "0")}`,
    milestoneId: i < 6 ? "m1" : "m2",
    description: `Assertion requirement #${i + 1}`,
    status: i < 3 ? "passed" : "pending",
  }));

  const spammyLogs = [
    { seq: 1, timestamp: new Date().toISOString(), type: "plan_proposed", message: "Proposed mission plan" },
    { seq: 2, timestamp: new Date().toISOString(), type: "model_slots_updated", message: "Model slots updated: validator=gpt-6.1-sol (low/2)" },
    { seq: 3, timestamp: new Date().toISOString(), type: "model_slots_updated", message: "Model slots updated: validator=gpt-6.1-sol (medium/3)" },
    { seq: 4, timestamp: new Date().toISOString(), type: "model_slots_updated", message: "Model slots updated: validator=gpt-6.1-sol (high/4)" },
    { seq: 5, timestamp: new Date().toISOString(), type: "model_slots_updated", message: "Model slots updated: validator=gpt-6.1-sol (max/5)" },
  ];

  vmCtx.largeSnapshot = {
    initialized: true,
    state: {
      status: "awaiting_input",
      planAccepted: false,
      revision: 5,
      title: "12-Feature Precision Mission",
      milestones: [
        { id: "m1", title: "Core Architecture", ordinal: 1 },
        { id: "m2", title: "Validation Matrix", ordinal: 2 },
      ],
      assertions: twelveAssertions,
    },
    features: twelveFeatures,
    progressLog: spammyLogs,
    modelSettings: {},
    catalog: [],
  };

  vm.runInContext("applySnapshot(largeSnapshot)", vmCtx);

  // All 12 features and all 12 assertions must be rendered in full
  const featuresHtml = elements.get("features-list").innerHTML;
  const assertionsHtml = elements.get("assertions-list").innerHTML;
  for (let i = 1; i <= 12; i++) {
    const valId = `VAL-M-${String(i).padStart(3, "0")}`;
    assert.match(featuresHtml, new RegExp(`data-feature-id="f-${i}"`), `Missing feature f-${i}`);
    assert.match(featuresHtml, new RegExp(valId), `Feature row f-${i} should render linked ${valId} pill`);
    assert.match(assertionsHtml, new RegExp(`data-assertion-id="${valId}"`), `Missing assertion ${valId}`);
  }

  // Verify #orchestrator-stream does NOT contain model_slots_updated spam
  const streamHtml = elements.get("orchestrator-stream").innerHTML;
  assert.equal(
    streamHtml.includes("model_slots_updated"),
    false,
    "#orchestrator-stream must filter out model_slots_updated spam"
  );

  // Verify #progress-log-list coalesces the 4 consecutive model_slots_updated entries into 1
  assert.equal(elements.get("progress-log-count").textContent, "2");
  const logHtml = elements.get("progress-log-list").innerHTML;
  assert.match(logHtml, /max\/5/);
  assert.equal(logHtml.includes("low/2"), false, "Earlier consecutive model_slots_updated entries should be coalesced");
});

test("Validator #8 Visual Polish Fixes (HUD-V8-001, HUD-V8-002, HUD-V8-003, HUD-V8-004): formatted 409 error without raw JSON dump, cleared stale resume diagnostic on running/completed, WCAG AA contrast tokens, and contextual pause/resume button disabled states", async () => {
  const stylesCssPath = path.resolve(__dirname, "../hud/public/styles.css");
  const stylesCss = fs.readFileSync(stylesCssPath, "utf8");
  const appRaw = fs.readFileSync(APP_JS_PATH, "utf8");

  // HUD-V8-003: Verify WCAG AA (>= 4.5:1) semantic color tokens in styles.css
  assert.match(stylesCss, /--text-muted:\s*#475569/i);
  assert.match(stylesCss, /--status-running-fg:\s*#1d4ed8/i);
  assert.match(stylesCss, /--status-amber-fg:\s*#b45309/i);
  assert.match(stylesCss, /--status-emerald-fg:\s*#166534/i);
  assert.match(stylesCss, /--status-rose-fg:\s*#b91c1c/i);
  assert.match(stylesCss, /--status-slate-fg:\s*#475569/i);
  assert.equal(stylesCss.includes("#16a34a"), false, "Low-contrast #16a34a must not be used in styles.css");

  const appSrc = appRaw
    .replace("export function applySnapshot", "function applySnapshot")
    .replace(/initHud\(\);\s*$/, "");

  const elements = new Map();
  function makeEl(id) {
    return {
      id,
      textContent: "",
      innerHTML: "",
      disabled: false,
      dataset: {},
      style: {},
      value: "",
      listeners: {},
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (this.classes.has(c)) this.classes.delete(c);
            else this.classes.add(c);
          } else if (force) {
            this.classes.add(c);
          } else {
            this.classes.delete(c);
          }
        },
        contains(c) { return this.classes.has(c); },
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
  }

  for (const id of [
    "mission-repo-path",
    "mission-title",
    "metric-time",
    "metric-progress",
    "metric-progress-bar",
    "metric-contract",
    "metric-contract-bar",
    "status-strip",
    "status-strip-label",
    "status-strip-subtext",
    "strip-approve-btn",
    "btn-pause",
    "btn-resume",
    "milestone-stepper-track",
    "pipeline-text",
    "sessions-list",
    "sessions-count",
    "onboarding-card",
    "plan-approval-card",
    "session-inspector",
    "session-handoff-view",
    "orchestrator-stream",
    "resume-diagnostic-card",
    "features-count",
    "features-list",
    "assertions-count",
    "assertions-list",
    "progress-log-count",
    "progress-log-list",
  ]) {
    elements.set(id, makeEl(id));
  }

  const hugeSnapshotPayload = {
    initialized: true,
    state: {
      status: "paused",
      revision: 12,
      lastResumeDiagnostic: "Resume blocked (RESUME_BLOCKED_BY_CONFLICTS): Git repository has unresolved merge conflicts (README.md). Resolve all conflicts before resuming.",
      milestones: Array.from({ length: 4 }, (_, i) => ({ id: `m${i + 1}`, title: `Milestone ${i + 1}` })),
    },
    features: Array.from({ length: 20 }, (_, i) => ({
      id: `f${String(i + 1).padStart(2, "0")}`,
      title: `Feature ${i + 1} with long payload padding`,
      status: "pending",
    })),
  };

  const vmCtx = vm.createContext({
    document: {
      getElementById: (id) => elements.get(id) || null,
    },
    fetch: async (url) => {
      if (url === "/api/mission/resume") {
        return {
          ok: false,
          status: 409,
          text: async () =>
            JSON.stringify({
              ok: false,
              error: "Resume blocked (RESUME_BLOCKED_BY_CONFLICTS): Git repository has unresolved merge conflicts (README.md). Resolve all conflicts before resuming.",
              code: "GIT_RESUME_BLOCKED",
              reasonCode: "RESUME_BLOCKED_BY_CONFLICTS",
              diagnostic: "Resume blocked (RESUME_BLOCKED_BY_CONFLICTS): Git repository has unresolved merge conflicts (README.md). Resolve all conflicts before resuming.",
              gitCheck: {
                ok: false,
                canResume: false,
                status: "conflicted",
                reasonCode: "RESUME_BLOCKED_BY_CONFLICTS",
                summary: "Git repository has unresolved merge conflicts (README.md). Resolve all conflicts before resuming.",
              },
              snapshot: hugeSnapshotPayload,
              state: hugeSnapshotPayload.state,
            }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });

  vm.runInContext(appSrc, vmCtx);
  vm.runInContext("bindStaticListeners()", vmCtx);

  // HUD-V8-004: Verify contextual disabled state across lifecycle phases
  // 1) uninitialized -> both disabled
  vmCtx.snapUninit = {
    initialized: false,
    state: { status: "uninitialized", planAccepted: false, revision: 0 },
    features: [],
    progressLog: [],
  };
  vm.runInContext("applySnapshot(snapUninit)", vmCtx);
  assert.equal(elements.get("btn-pause").disabled, true);
  assert.equal(elements.get("btn-resume").disabled, true);

  // 2) awaiting_input (!planAccepted) -> both disabled
  vmCtx.snapAwaiting = {
    initialized: true,
    state: { status: "awaiting_input", planAccepted: false, revision: 1 },
    features: [],
    progressLog: [],
  };
  vm.runInContext("applySnapshot(snapAwaiting)", vmCtx);
  assert.equal(elements.get("btn-pause").disabled, true);
  assert.equal(elements.get("btn-resume").disabled, true);

  // 3) running -> pause enabled, resume disabled
  vmCtx.snapRunning = {
    initialized: true,
    state: {
      status: "running",
      planAccepted: true,
      revision: 2,
      activeWorker: { featureId: "f01", title: "Feature 1", workerNumber: 1, status: "running" },
    },
    features: [{ id: "f01", title: "Feature 1", status: "running" }],
    progressLog: [],
  };
  vm.runInContext("applySnapshot(snapRunning)", vmCtx);
  assert.equal(elements.get("btn-pause").disabled, false);
  assert.equal(elements.get("btn-resume").disabled, true);

  // 4) paused -> pause disabled, resume enabled
  vmCtx.snapPaused = {
    initialized: true,
    state: {
      status: "paused",
      planAccepted: true,
      revision: 3,
      lastResumeDiagnostic: "The mission was paused one minute after the f01 worker started. Resume f01.",
      activeWorker: { featureId: "f01", title: "Feature 1", workerNumber: 1, status: "paused" },
    },
    features: [{ id: "f01", title: "Feature 1", status: "paused" }],
    progressLog: [],
  };
  vm.runInContext("applySnapshot(snapPaused)", vmCtx);
  assert.equal(elements.get("btn-pause").disabled, true);
  assert.equal(elements.get("btn-resume").disabled, false);

  // HUD-V8-001: Triggering 409 conflict on /api/mission/resume formats concise message without raw JSON dump and preserves Revision #3 in #status-strip-subtext
  await elements.get("btn-resume").listeners.click();
  const formattedErr = vm.runInContext("hudState.lastActionError", vmCtx);
  assert.ok(formattedErr.length <= 240, `Expected error <= 240 chars, got ${formattedErr.length}`);
  assert.equal(formattedErr.includes(`"snapshot"`), false, "Must never dump raw snapshot JSON");
  assert.equal(formattedErr.includes("{"), false, "Must never dump raw JSON braces");
  assert.match(formattedErr, /GIT_RESUME_BLOCKED/);
  assert.match(formattedErr, /RESUME_BLOCKED_BY_CONFLICTS/);
  assert.match(elements.get("status-strip-subtext").textContent, /^Revision #3 · /);
  assert.equal(elements.get("resume-diagnostic-card").innerHTML.includes(`"snapshot"`), false);

  // HUD-V8-002: Transitioning to running on subsequent worker clears lastActionError and does not show stale f01 lastResumeDiagnostic
  vmCtx.snapRunningNext = {
    initialized: true,
    state: {
      status: "running",
      planAccepted: true,
      revision: 4,
      lastResumeDiagnostic: "The mission was paused one minute after the f01 worker started. Resume f01.",
      activeWorker: { featureId: "f02", title: "Feature 2", workerNumber: 2, status: "running" },
    },
    features: [
      { id: "f01", title: "Feature 1", status: "completed" },
      { id: "f02", title: "Feature 2", status: "running" },
    ],
    progressLog: [],
  };
  vm.runInContext("applySnapshot(snapRunningNext)", vmCtx);
  assert.equal(vm.runInContext("hudState.lastActionError", vmCtx), null);
  assert.equal(
    elements.get("orchestrator-stream").innerHTML.includes("The mission was paused one minute"),
    false,
    "Running state on f02 must not display stale f01 lastResumeDiagnostic"
  );
  assert.match(elements.get("orchestrator-stream").innerHTML, /Worker #2 \(Feature 2\) is currently running\./);

  // HUD-V8-002 & HUD-V8-004: Transitioning to completed with stale lastResumeDiagnostic shows clean completion message and disables both pause and resume buttons
  vmCtx.snapCompleted = {
    initialized: true,
    state: {
      status: "completed",
      planAccepted: true,
      revision: 5,
      lastResumeDiagnostic: "The mission was paused one minute after the f01 worker started. Resume f01.",
      activeWorker: null,
    },
    features: [
      { id: "f01", title: "Feature 1", status: "completed" },
      { id: "f02", title: "Feature 2", status: "completed" },
    ],
    progressLog: [],
  };
  vm.runInContext("applySnapshot(snapCompleted)", vmCtx);
  assert.equal(elements.get("btn-pause").disabled, true);
  assert.equal(elements.get("btn-resume").disabled, true);
  const completedStreamHtml = elements.get("orchestrator-stream").innerHTML;
  assert.match(
    completedStreamHtml,
    /All milestones, features, and validation assertions completed\./
  );
  assert.equal(
    completedStreamHtml.includes("The mission was paused one minute"),
    false,
    "Completed mission must not display stale lastResumeDiagnostic"
  );
});
