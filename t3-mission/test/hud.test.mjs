import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createMissionHudServer } from "../hud/server.mjs";

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

  // Verify state revision incremented and progress_log.jsonl recorded the change
  const diskState = JSON.parse(fs.readFileSync(path.join(dotMission, "state.json"), "utf8"));
  assert.equal(diskState.revision, 2);

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
