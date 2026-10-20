import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  proposeMission,
  approveMissionPlan,
  rejectMissionPlan,
  dismissHandoffItems,
  updateMissionFeatures,
  endFeatureRun,
  checkMilestoneCompletionAndInjectValidation,
  startMissionRun,
  reconcileMissionOnLoad,
  loadState,
  loadFeaturesDoc,
  loadModelSettings,
  normalizeSlotConfig,
  readProgressLog,
  saveState,
  getMissionPaths,
  isValidatorFeature,
} from "../kernel/index.mjs";

function makeTempProjectDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-mission-kernel-test-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const VALID_SUMMARY_50 =
  "Implemented the complete feature according to specification with full atomic persistence and unit tests.";

test("VAL-KERNEL-001: proposeMission initializes 4 files, enforces planAccepted hard gate before startMissionRun, and handles approve/reject", async (t) => {
  const projectDir = makeTempProjectDir(t);

  const proposed = proposeMission(projectDir, {
    title: "T3 Mission Kernel Parity",
    repoPath: projectDir,
    milestones: [{ id: "m1", title: "Milestone 1: Intake", ordinal: 1 }],
    assertions: [
      {
        id: "VAL-001",
        description: "Plan acceptance gate works",
        milestoneId: "m1",
        status: "pending",
      },
    ],
    features: [
      {
        id: "f1",
        milestoneId: "m1",
        title: "Intake foundation",
        description: "Set up mission intake",
        kind: "implementation",
        skillName: "worker-implementation",
        fulfills: ["VAL-001"],
      },
    ],
  });

  const paths = getMissionPaths(projectDir);
  assert.equal(fs.existsSync(paths.statePath), true);
  assert.equal(fs.existsSync(paths.featuresPath), true);
  assert.equal(fs.existsSync(paths.modelSettingsPath), true);
  assert.equal(fs.existsSync(paths.progressLogPath), true);

  assert.equal(proposed.state.status, "awaiting_input");
  assert.equal(proposed.state.planAccepted, false);
  assert.deepEqual(proposed.state.pendingHandoffItems, []);
  assert.equal(proposed.modelSettings.validator.model, "gpt-6.1-sol");

  const logsAfterPropose = readProgressLog(projectDir);
  assert.equal(logsAfterPropose.length, 1);
  assert.equal(logsAfterPropose[0].message, "ProposeMission submitted");

  // Calling startMissionRun before planAccepted === true MUST throw PLAN_ACCEPTANCE_REQUIRED
  await assert.rejects(
    () => startMissionRun(projectDir, {}, {}),
    (err) => {
      assert.equal(err.code, "PLAN_ACCEPTANCE_REQUIRED");
      return true;
    }
  );

  // Rejecting plan keeps planAccepted = false and transitions to planning
  const rejected = rejectMissionPlan(projectDir, "Add more milestones");
  assert.equal(rejected.planAccepted, false);
  assert.equal(rejected.status, "planning");

  await assert.rejects(
    () => startMissionRun(projectDir, {}, {}),
    (err) => {
      assert.equal(err.code, "PLAN_ACCEPTANCE_REQUIRED");
      return true;
    }
  );

  // Approving plan sets planAccepted = true and status = orchestrator_turn
  const approved = approveMissionPlan(projectDir);
  assert.equal(approved.planAccepted, true);
  assert.equal(approved.status, "orchestrator_turn");

  const logsAfterApprove = readProgressLog(projectDir);
  assert.equal(
    logsAfterApprove.some((l) => l.message === "Mission plan approved"),
    true
  );
});

test("VAL-KERNEL-002 & VAL-KERNEL-003: endFeatureRun validation, auto-continue vs return-to-orchestrator, and handoff attention gate (DismissHandoffItems & updateMissionFeatures)", async (t) => {
  const projectDir = makeTempProjectDir(t);

  proposeMission(projectDir, {
    title: "Handoff Gate Test",
    repoPath: projectDir,
    milestones: [{ id: "m1", title: "Milestone 1", ordinal: 1 }],
    assertions: [{ id: "VAL-001", description: "Gate check", milestoneId: "m1" }],
    features: [
      { id: "f1", milestoneId: "m1", title: "Feature 1", fulfills: ["VAL-001"] },
      { id: "f2", milestoneId: "m1", title: "Feature 2", fulfills: ["VAL-001"] },
      { id: "f3", milestoneId: "m1", title: "Feature 3", fulfills: ["VAL-001"] },
    ],
    modelSettings: {
      skipScrutiny: true,
      skipUserTesting: true,
    },
  });
  approveMissionPlan(projectDir);

  const executedFeatures = [];

  // Run where f1 succeeds cleanly (auto-continues to f2), and f2 reports a discoveredIssue
  const stateAfterRun1 = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature(feature, slotConfig, currentState) {
        executedFeatures.push({ id: feature.id, slot: slotConfig.slot });

        // Test stale worker protection & short summary validation on f1
        if (feature.id === "f1") {
          assert.throws(
            () =>
              endFeatureRun(projectDir, {
                runId: "run-wrong-id",
                featureId: "f1",
                successState: "success",
                validatorsPassed: true,
                handoff: { whatWasImplemented: VALID_SUMMARY_50 },
              }),
            (err) => err.code === "STALE_WORKER_RUN"
          );

          assert.throws(
            () =>
              endFeatureRun(projectDir, {
                runId: currentState.activeWorker.runId,
                featureId: "f1",
                successState: "success",
                validatorsPassed: true,
                handoff: { whatWasImplemented: "Too short summary" },
              }),
            (err) => err.code === "INVALID_HANDOFF_IMPLEMENTATION_SUMMARY"
          );

          assert.throws(
            () =>
              endFeatureRun(projectDir, {
                runId: currentState.activeWorker.runId,
                featureId: "f1",
                successState: "success",
                validatorsPassed: false,
                handoff: { whatWasImplemented: VALID_SUMMARY_50 },
              }),
            (err) => err.code === "VALIDATORS_NOT_PASSED"
          );

          const res = endFeatureRun(projectDir, {
            runId: currentState.activeWorker.runId,
            featureId: "f1",
            successState: "success",
            validatorsPassed: true,
            handoff: {
              whatWasImplemented: VALID_SUMMARY_50,
              whatWasLeftUndone: "none",
              discoveredIssues: [],
            },
          });
          assert.equal(res.shouldReturnToOrchestrator, false);
          return;
        }

        if (feature.id === "f2") {
          const res = endFeatureRun(projectDir, {
            runId: currentState.activeWorker.runId,
            featureId: "f2",
            successState: "success",
            validatorsPassed: true,
            handoff: {
              whatWasImplemented: VALID_SUMMARY_50,
              whatWasLeftUndone: "",
              discoveredIssues: [
                {
                  type: "discovered_issue",
                  summary: "Edge case in parser when input is empty",
                },
              ],
            },
          });
          assert.equal(res.shouldReturnToOrchestrator, true);
        }
      },
    }
  );

  // f1 auto-continued to f2, then f2 stopped and returned to orchestrator before f3
  assert.deepEqual(
    executedFeatures.map((x) => x.id),
    ["f1", "f2"]
  );
  assert.equal(stateAfterRun1.status, "orchestrator_turn");
  assert.equal(stateAfterRun1.lastHandoffNeedsAttention, true);

  // Trying to startMissionRun while lastHandoffNeedsAttention === true throws HANDOFF_ATTENTION_REQUIRED
  await assert.rejects(
    () => startMissionRun(projectDir, {}, {}),
    (err) => err.code === "HANDOFF_ATTENTION_REQUIRED"
  );

  // DismissHandoffItems with justification < 20 chars throws INVALID_JUSTIFICATION
  assert.throws(
    () =>
      dismissHandoffItems(projectDir, {
        dismissals: [
          {
            type: "discovered_issue",
            sourceFeatureId: "f2",
            summary: "Edge case in parser",
            justification: "Too short",
          },
        ],
      }),
    (err) => err.code === "INVALID_JUSTIFICATION"
  );

  // DismissHandoffItems with >= 20 chars justification clears lastHandoffNeedsAttention and logs
  const dismissResult = dismissHandoffItems(projectDir, {
    dismissals: [
      {
        type: "discovered_issue",
        sourceFeatureId: "f2",
        summary: "Edge case in parser",
        justification:
          "Covered by f3 implementation which adds full empty-input guards.",
      },
    ],
  });
  assert.equal(dismissResult.state.lastHandoffNeedsAttention, false);

  const logs = readProgressLog(projectDir);
  const dismissLog = logs.find((l) => l.type === "handoff_items_dismissed");
  assert.ok(dismissLog);
  assert.equal(dismissLog.message, "Handoff items dismissed");

  // Now f3 can run and complete the mission
  const finalState = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature(feature, _slotConfig, currentState) {
        executedFeatures.push({ id: feature.id });
        endFeatureRun(projectDir, {
          runId: currentState.activeWorker.runId,
          featureId: feature.id,
          successState: "success",
          validatorsPassed: true,
          handoff: {
            whatWasImplemented: VALID_SUMMARY_50,
            whatWasLeftUndone: "\u65e0",
          },
        });
      },
    }
  );

  assert.equal(finalState.status, "completed");
  assert.deepEqual(
    executedFeatures.map((x) => x.id),
    ["f1", "f2", "f3"]
  );
});

test("VAL-KERNEL-004: Milestone completion automatically injects scrutiny-validator and user-testing-validator in order at head of pending queue", async (t) => {
  const projectDir = makeTempProjectDir(t);

  proposeMission(projectDir, {
    title: "Milestone Validator Injection",
    repoPath: projectDir,
    milestones: [
      { id: "m1", title: "Milestone 1: Core", ordinal: 1 },
      { id: "m2", title: "Milestone 2: UI", ordinal: 2 },
    ],
    assertions: [
      { id: "VAL-M1-001", description: "M1 works", milestoneId: "m1" },
      { id: "VAL-M2-001", description: "M2 works", milestoneId: "m2" },
    ],
    features: [
      {
        id: "m1-f1",
        milestoneId: "m1",
        title: "M1 Feature 1",
        kind: "implementation",
        fulfills: ["VAL-M1-001"],
      },
      {
        id: "m2-f1",
        milestoneId: "m2",
        title: "M2 Feature 1",
        kind: "implementation",
        fulfills: ["VAL-M2-001"],
      },
    ],
  });
  approveMissionPlan(projectDir);

  const runOrder = [];

  const completedState = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature(feature, slotConfig, currentState) {
        runOrder.push({
          id: feature.id,
          kind: feature.kind,
          slot: slotConfig.slot,
          model: slotConfig.model,
        });
        const assertionResults = isValidatorFeature(feature)
          ? Object.fromEntries(
              currentState.assertions
                .filter((a) => a.milestoneId === feature.milestoneId)
                .map((a) => [a.id, "passed"])
            )
          : undefined;
        endFeatureRun(projectDir, {
          runId: currentState.activeWorker.runId,
          featureId: feature.id,
          successState: "success",
          validatorsPassed: true,
          ...(assertionResults ? { assertionResults } : {}),
          handoff: {
            whatWasImplemented: VALID_SUMMARY_50,
          },
        });
      },
    }
  );

  assert.equal(completedState.status, "completed");
  assert.deepEqual(
    runOrder.map((r) => r.id),
    [
      "m1-f1",
      "scrutiny-validator-m1",
      "user-testing-validator-m1",
      "m2-f1",
      "scrutiny-validator-m2",
      "user-testing-validator-m2",
    ]
  );

  // Verify slot routing: implementation uses worker slot, validators use validator slot (gpt-6.1-sol)
  assert.equal(runOrder[0].slot, "worker");
  assert.equal(runOrder[1].slot, "validator");
  assert.equal(runOrder[1].model, "gpt-6.1-sol");
  assert.equal(runOrder[2].slot, "validator");
  assert.equal(runOrder[2].model, "gpt-6.1-sol");

  // Verify assertions were marked as passed by validators
  assert.equal(
    completedState.assertions.every((a) => a.status === "passed"),
    true
  );

  // Verify milestoneValidationTriggered recorded both milestones
  assert.equal(completedState.milestoneValidationTriggered.m1, true);
  assert.equal(completedState.milestoneValidationTriggered.m2, true);
});

test("VAL-KERNEL-005: reconcileMissionOnLoad reconciles crashed running state to paused, accumulates elapsedMs, and startMissionRun seamlessly resumes paused activeWorker", async (t) => {
  const projectDir = makeTempProjectDir(t);

  proposeMission(projectDir, {
    title: "Crash Recovery & Resume",
    repoPath: projectDir,
    milestones: [{ id: "m1", title: "Milestone 1", ordinal: 1 }],
    assertions: [{ id: "VAL-001", description: "Resume works", milestoneId: "m1" }],
    features: [
      { id: "f1", milestoneId: "m1", title: "Long running feature", fulfills: ["VAL-001"] },
    ],
    modelSettings: {
      skipScrutiny: true,
      skipUserTesting: true,
    },
  });
  approveMissionPlan(projectDir);

  // Start mission run and simulate abrupt client shutdown mid-feature (do not call endFeatureRun)
  await startMissionRun(
    projectDir,
    {},
    {
      async runFeature() {
        // Simulate running for 5 seconds before crash by backdating lastStartedAt
        const st = loadState(projectDir);
        st.lastStartedAt = new Date(Date.now() - 5000).toISOString();
        saveState(projectDir, st);
      },
    }
  );

  const preCrashState = loadState(projectDir);
  assert.equal(preCrashState.status, "running");
  assert.equal(preCrashState.activeWorker.status, "running");
  assert.equal(preCrashState.activeWorker.featureId, "f1");

  // Reopen & call reconcileMissionOnLoad (simulating Droid B+163476206 startup reconciliation)
  const reconciled = reconcileMissionOnLoad(projectDir);
  assert.equal(reconciled.status, "paused");
  assert.equal(reconciled.activeWorker.status, "paused");
  assert.equal(reconciled.lastStartedAt, null);
  assert.ok(reconciled.elapsedMs >= 4500);

  const logsAfterReconcile = readProgressLog(projectDir);
  assert.equal(
    logsAfterReconcile.some(
      (l) => l.message === "Worker #1 paused Long running feature"
    ),
    true
  );
  assert.equal(
    logsAfterReconcile.some((l) => l.message === "Mission paused"),
    true
  );

  // Resume run: should invoke dispatchAdapter.resumeWorker on Worker #1 without incrementing attempts
  let resumedWorkerInfo = null;
  let freshRunCalled = false;

  const postResumeState = await startMissionRun(
    projectDir,
    { resumePrompt: "Continue from checkpoint" },
    {
      async resumeWorker(activeWorker) {
        resumedWorkerInfo = activeWorker;
        endFeatureRun(projectDir, {
          runId: activeWorker.runId,
          featureId: activeWorker.featureId,
          successState: "success",
          validatorsPassed: true,
          handoff: {
            whatWasImplemented: VALID_SUMMARY_50,
          },
        });
      },
      async runFeature() {
        freshRunCalled = true;
      },
    }
  );

  assert.ok(resumedWorkerInfo);
  assert.equal(resumedWorkerInfo.featureId, "f1");
  assert.equal(resumedWorkerInfo.workerNumber, 1);
  assert.equal(freshRunCalled, false);
  assert.equal(postResumeState.status, "completed");

  const featuresDoc = loadFeaturesDoc(projectDir);
  assert.equal(featuresDoc.features[0].attempts, 1);
  assert.equal(featuresDoc.features[0].status, "completed");

  const logsAfterResume = readProgressLog(projectDir);
  assert.equal(
    logsAfterResume.some((l) => l.message === "Mission resumed"),
    true
  );
  assert.equal(
    logsAfterResume.some(
      (l) => l.message === "Run started: Resume Long running feature"
    ),
    true
  );
});

test("Dynamic repair feature expansion (18/24 -> 18/27) via updateMissionFeatures clears handoff gate and continues execution", async (t) => {
  const projectDir = makeTempProjectDir(t);

  // Build 24 initial features (17 already completed, f18..f24 pending)
  const initialFeatures = [];
  for (let i = 1; i <= 24; i++) {
    initialFeatures.push({
      id: `f${i}`,
      milestoneId: "m1",
      title: `Feature ${i}`,
      kind: "implementation",
      status: i <= 17 ? "completed" : "pending",
    });
  }

  proposeMission(projectDir, {
    title: "Dynamic 18/24 to 18/27 Expansion",
    repoPath: projectDir,
    milestones: [{ id: "m1", title: "Milestone 1", ordinal: 1 }],
    assertions: [{ id: "VAL-001", description: "Full parity", milestoneId: "m1" }],
    features: initialFeatures,
  });
  approveMissionPlan(projectDir);

  // Run f18 which completes (making 18/24 completed), but reports 3 gaps left undone -> triggers handoff attention gate
  const stateAt18 = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature(feature, _slot, currentState) {
        if (feature.id === "f18") {
          endFeatureRun(projectDir, {
            runId: currentState.activeWorker.runId,
            featureId: "f18",
            successState: "success",
            validatorsPassed: true,
            handoff: {
              whatWasImplemented: VALID_SUMMARY_50,
              whatWasLeftUndone: "3 edge cases found during scrutiny that need repair features",
              discoveredIssues: [
                { summary: "Gap 1" },
                { summary: "Gap 2" },
                { summary: "Gap 3" },
              ],
            },
          });
        }
      },
    }
  );

  const docAt18 = loadFeaturesDoc(projectDir);
  assert.equal(
    docAt18.features.filter((f) => f.status === "completed").length,
    18
  );
  assert.equal(docAt18.features.length, 24);
  assert.equal(stateAt18.status, "orchestrator_turn");
  assert.equal(stateAt18.lastHandoffNeedsAttention, true);
  assert.equal(stateAt18.pendingHandoffItems.length, 3);

  // Orchestrator dynamically appends 3 repair features (18/24 -> 18/27)
  const updated = updateMissionFeatures(projectDir, {
    addFeatures: [
      {
        id: "f25-repair-1",
        milestoneId: "m1",
        title: "Repair Gap 1",
        kind: "repair",
        status: "pending",
      },
      {
        id: "f26-repair-2",
        milestoneId: "m1",
        title: "Repair Gap 2",
        kind: "repair",
        status: "pending",
      },
      {
        id: "f27-repair-3",
        milestoneId: "m1",
        title: "Repair Gap 3",
        kind: "repair",
        status: "pending",
      },
    ],
  });

  assert.equal(
    updated.features.filter((f) => f.status === "completed").length,
    18
  );
  assert.equal(updated.features.length, 27);
  // Updating features automatically releases the handoff attention gate!
  assert.equal(updated.state.lastHandoffNeedsAttention, false);
  assert.deepEqual(updated.state.pendingHandoffItems, []);
});

test("Max attempts enforcement and partial/failure retry behavior", async (t) => {
  const projectDir = makeTempProjectDir(t);

  proposeMission(projectDir, {
    title: "Max Attempts & Retry",
    repoPath: projectDir,
    milestones: [{ id: "m1", title: "Milestone 1", ordinal: 1 }],
    assertions: [{ id: "VAL-001", description: "Retry check", milestoneId: "m1" }],
    features: [
      {
        id: "f1",
        milestoneId: "m1",
        title: "Flaky Feature",
        maxAttempts: 2,
      },
    ],
    modelSettings: {
      skipScrutiny: true,
      skipUserTesting: true,
    },
  });
  approveMissionPlan(projectDir);

  // Attempt 1: partial -> resets feature to pending and returns to orchestrator
  const s1 = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature(feature, _slot, currentState) {
        endFeatureRun(projectDir, {
          runId: currentState.activeWorker.runId,
          featureId: feature.id,
          successState: "partial",
          validatorsPassed: false,
          handoff: {
            whatWasImplemented: VALID_SUMMARY_50,
          },
        });
      },
    }
  );
  assert.equal(s1.status, "orchestrator_turn");
  assert.equal(loadFeaturesDoc(projectDir).features[0].attempts, 1);
  assert.equal(loadFeaturesDoc(projectDir).features[0].status, "pending");

  // Attempt 2: failure -> resets feature to pending and returns to orchestrator
  const s2 = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature(feature, _slot, currentState) {
        endFeatureRun(projectDir, {
          runId: currentState.activeWorker.runId,
          featureId: feature.id,
          successState: "failure",
          validatorsPassed: false,
          handoff: {
            whatWasImplemented: VALID_SUMMARY_50,
          },
        });
      },
    }
  );
  assert.equal(s2.status, "orchestrator_turn");
  assert.equal(loadFeaturesDoc(projectDir).features[0].attempts, 2);

  // Attempt 3: exceeds maxAttempts (2) -> pauses mission awaiting bonus attempts grant
  const s3 = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature() {
        assert.fail("Should not run feature when maxAttempts is reached");
      },
    }
  );
  assert.equal(s3.status, "paused");

  // Grant bonus attempt via updateMissionFeatures and complete
  updateMissionFeatures(projectDir, {
    bonusAttempts: { f1: 2 },
  });

  const s4 = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature(feature, _slot, currentState) {
        endFeatureRun(projectDir, {
          runId: currentState.activeWorker.runId,
          featureId: feature.id,
          successState: "success",
          validatorsPassed: true,
          handoff: {
            whatWasImplemented: VALID_SUMMARY_50,
          },
        });
      },
    }
  );
  assert.equal(s4.status, "completed");
  assert.equal(loadFeaturesDoc(projectDir).features[0].attempts, 3);
});

test("F01 & F02: async delegation identity persistence, role assignment, serial concurrency guard, and blocked/async resume", async (t) => {
  const projectDir = makeTempProjectDir(t);

  proposeMission(projectDir, {
    title: "Async Delegation & Serial Guard",
    repoPath: projectDir,
    milestones: [{ id: "m1", title: "Milestone 1", ordinal: 1 }],
    assertions: [{ id: "VAL-1", description: "Async serial check", milestoneId: "m1" }],
    features: [
      { id: "f1", milestoneId: "m1", title: "Feature 1", kind: "implementation" },
      { id: "f2", milestoneId: "m1", title: "Feature 2", kind: "explorer" },
    ],
    modelSettings: {
      skipScrutiny: true,
      skipUserTesting: true,
    },
  });
  approveMissionPlan(projectDir);

  let runCalls = 0;
  const adapter = {
    async runFeature(feature) {
      runCalls += 1;
      return {
        taskId: `task-${feature.id}-${runCalls}`,
        childThreadId: `thread-${feature.id}-${runCalls}`,
        childRunId: `crun-${feature.id}-${runCalls}`,
        worktreePath: `/tmp/worktree-${feature.id}`,
      };
    },
  };

  // First startMissionRun dispatches f1 asynchronously and returns immediately while f1 is running
  const s1 = await startMissionRun(projectDir, {}, adapter);
  assert.equal(runCalls, 1);
  assert.equal(s1.status, "running");
  assert.equal(s1.activeWorker.featureId, "f1");
  assert.equal(s1.activeWorker.role, "Worker");
  assert.equal(s1.activeWorker.taskId, "task-f1-1");
  assert.equal(s1.activeWorker.childThreadId, "thread-f1-1");
  assert.equal(s1.activeWorker.childRunId, "crun-f1-1");
  assert.equal(s1.activeWorker.worktreePath, "/tmp/worktree-f1");
  assert.equal(s1.sessions[0].taskId, "task-f1-1");
  assert.equal(s1.sessions[0].childThreadId, "thread-f1-1");
  assert.equal(s1.sessions[0].role, "Worker");

  const featuresAfterF1 = loadFeaturesDoc(projectDir).features;
  assert.equal(featuresAfterF1[0].status, "running");
  assert.equal(featuresAfterF1[0].taskId, "task-f1-1");
  assert.equal(featuresAfterF1[0].childThreadId, "thread-f1-1");
  assert.equal(featuresAfterF1[0].worktreePath, "/tmp/worktree-f1");
  assert.equal(featuresAfterF1[1].status, "pending");

  // Second startMissionRun while f1 is running MUST NOT dispatch f2 (F02 serialStart guard)
  const s2 = await startMissionRun(projectDir, {}, adapter);
  assert.equal(runCalls, 1);
  assert.equal(s2.activeWorker.featureId, "f1");
  assert.equal(loadFeaturesDoc(projectDir).features[1].status, "pending");

  // Reconcile to paused, then test blocked resume (F02 blockedResume)
  reconcileMissionOnLoad(projectDir);
  const blockedState = await startMissionRun(
    projectDir,
    {},
    {
      async resumeWorker() {
        return {
          resumed: false,
          action: "blocked_by_conflicts",
          status: "blocked_by_conflicts",
          canResume: false,
        };
      },
      async runFeature() {
        assert.fail("Must not dispatch pending feature when resume is blocked");
      },
    }
  );
  assert.equal(blockedState.status, "paused");
  assert.equal(blockedState.activeWorker.status, "paused");
  assert.equal(blockedState.activeWorker.featureId, "f1");
  assert.equal(loadFeaturesDoc(projectDir).features[1].status, "pending");

  // Now test resumePending flag (I-06) + async resume without handoff (I-05)
  const stPending = loadState(projectDir);
  stPending.status = "running";
  stPending.activeWorker.status = "running";
  stPending.activeWorker.resumePending = true;
  saveState(projectDir, stPending);

  let resumeCalled = 0;
  const asyncResumedState = await startMissionRun(
    projectDir,
    {},
    {
      async resumeWorker(activeWorker) {
        resumeCalled += 1;
        return {
          resumed: true,
          taskId: activeWorker.taskId,
          childThreadId: activeWorker.childThreadId,
          childRunId: "crun-f1-resumed",
          worktreePath: activeWorker.worktreePath,
        };
      },
      async runFeature() {
        assert.fail("Must not fall through to dispatch f2 after async resume of f1");
      },
    }
  );

  assert.equal(resumeCalled, 1);
  assert.equal(asyncResumedState.status, "running");
  assert.equal(asyncResumedState.activeWorker.featureId, "f1");
  assert.equal(asyncResumedState.activeWorker.status, "running");
  assert.equal(asyncResumedState.activeWorker.resumePending, undefined);
  assert.equal(asyncResumedState.activeWorker.childRunId, "crun-f1-resumed");
  assert.equal(loadFeaturesDoc(projectDir).features[1].status, "pending");
});

test("F03, F07, F08, F09, F10, F11, F12: handoff attention ledger, strict dismissal/update validation, validator stageResults & missing assertionResults gate, runId attribution, and dispatchPending", async (t) => {
  const projectDir = makeTempProjectDir(t);

  proposeMission(projectDir, {
    title: "Kernel Scrutiny Fixes",
    repoPath: projectDir,
    milestones: [{ id: "m1", title: "Milestone 1", ordinal: 1 }],
    assertions: [{ id: "VAL-1", description: "Must pass validation", milestoneId: "m1" }],
    features: [
      { id: "f1", milestoneId: "m1", title: "Feature 1", fulfills: ["VAL-1"] },
      { id: "f2", milestoneId: "m1", title: "Second", fulfills: ["VAL-1"] },
    ],
    modelSettings: {
      skipUserTesting: false,
    },
  });
  approveMissionPlan(projectDir);

  // F09: normalizeSlotConfig keeps effort and reasoningEffort consistent
  const normalizedLow = normalizeSlotConfig(
    { providerInstanceId: "codex", model: "gpt-6.1-sol", effort: 2, reasoningEffort: "high" },
    { providerInstanceId: "codex", model: "gpt-6.1-sol", options: { reasoningEffort: "high" } }
  );
  assert.equal(normalizedLow.options.effort, 2);
  assert.equal(normalizedLow.options.reasoningEffort, "low");

  const normalizedMinimal = normalizeSlotConfig({
    providerInstanceId: "codex",
    model: "gpt-6.1-sol",
    effort: 1,
  });
  assert.equal(normalizedMinimal.options.effort, 1);
  assert.equal(normalizedMinimal.options.reasoningEffort, "minimal");

  // F03 (P14): Starting without runFeature sets dispatchPending=true, and subsequent startMissionRun with runFeature dispatches that worker
  await startMissionRun(projectDir);
  assert.equal(loadState(projectDir).activeWorker.dispatchPending, true);

  await startMissionRun(
    projectDir,
    {},
    {
      async runFeature() {
        return { taskId: "t1", childThreadId: "c1" };
      },
    }
  );
  const active = loadState(projectDir).activeWorker;
  assert.equal(active.dispatchPending, undefined);
  assert.equal(active.taskId, "t1");
  assert.equal(active.childThreadId, "c1");
  assert.equal(active.handoff, null);

  // F12 (P12): EndFeatureRun requires BOTH runId and featureId, and fences against stale featureId or runId
  assert.throws(
    () =>
      endFeatureRun(projectDir, {
        successState: "success",
        validatorsPassed: true,
        handoff: { whatWasImplemented: VALID_SUMMARY_50 },
      }),
    (err) => err.code === "MISSING_RUN_IDENTITY"
  );

  assert.throws(
    () =>
      endFeatureRun(projectDir, {
        featureId: "f1",
        successState: "success",
        validatorsPassed: true,
        handoff: { whatWasImplemented: VALID_SUMMARY_50 },
      }),
    (err) => err.code === "MISSING_RUN_IDENTITY"
  );

  assert.throws(
    () =>
      endFeatureRun(projectDir, {
        runId: active.runId,
        successState: "success",
        validatorsPassed: true,
        handoff: { whatWasImplemented: VALID_SUMMARY_50 },
      }),
    (err) => err.code === "MISSING_RUN_IDENTITY"
  );

  assert.throws(
    () =>
      endFeatureRun(projectDir, {
        runId: active.runId,
        featureId: "wrong-feature",
        successState: "success",
        validatorsPassed: true,
        handoff: { whatWasImplemented: VALID_SUMMARY_50 },
      }),
    (err) => err.code === "STALE_WORKER_RUN"
  );

  assert.throws(
    () =>
      endFeatureRun(projectDir, {
        runId: "wrong-run",
        featureId: "f1",
        successState: "success",
        validatorsPassed: true,
        handoff: { whatWasImplemented: VALID_SUMMARY_50 },
      }),
    (err) => err.code === "STALE_WORKER_RUN"
  );

  // Complete f1 with a discoveredIssue and a nonInteractiveCheck (F07)
  endFeatureRun(projectDir, {
    runId: active.runId,
    featureId: "f1",
    successState: "success",
    validatorsPassed: true,
    handoff: {
      whatWasImplemented: VALID_SUMMARY_50,
      discoveredIssues: [{ id: "iss-1", description: "Edge case bug" }],
      nonInteractiveChecks: [{ id: "chk-1", summary: "Verify CLI exit code" }],
    },
  });

  // F11 (P18): feature.lastHandoff includes runId
  const f1AfterEnd = loadFeaturesDoc(projectDir).features.find((f) => f.id === "f1");
  assert.equal(f1AfterEnd.lastHandoff.runId, active.runId);

  const stateWithPending = loadState(projectDir);
  assert.equal(stateWithPending.lastHandoffNeedsAttention, true);
  assert.equal(stateWithPending.pendingHandoffItems.length, 2);

  // F07: Dismissing nonexistent feature/item throws UNKNOWN_HANDOFF_ITEM and does not clear gate
  assert.throws(
    () =>
      dismissHandoffItems(projectDir, {
        dismissals: [
          {
            type: "discovered_issue",
            sourceFeatureId: "nonexistent-feature",
            summary: "nonexistent issue",
            justification: "This unrelated dismissal must be rejected by the kernel.",
          },
        ],
      }),
    (err) => err.code === "UNKNOWN_HANDOFF_ITEM"
  );
  assert.equal(loadState(projectDir).lastHandoffNeedsAttention, true);

  // F07: updateMissionFeatures with nonexistent feature ID throws UNKNOWN_FEATURE_ID and does not clear gate
  assert.throws(
    () =>
      updateMissionFeatures(projectDir, {
        updateFeatures: [{ id: "missing-id", title: "no-op" }],
      }),
    (err) => err.code === "UNKNOWN_FEATURE_ID"
  );
  assert.equal(loadState(projectDir).lastHandoffNeedsAttention, true);

  // F07: No-op updateMissionFeatures does not clear gate
  updateMissionFeatures(projectDir, {});
  assert.equal(loadState(projectDir).lastHandoffNeedsAttention, true);

  // F07: Dismissing only 1 of 2 pending items leaves the other pending and keeps gate true
  dismissHandoffItems(projectDir, {
    dismissals: [
      {
        itemId: "iss-1",
        type: "discovered_issue",
        sourceFeatureId: "f1",
        reason: "Resolved via dedicated follow-up validation check.",
      },
    ],
  });
  assert.equal(loadState(projectDir).pendingHandoffItems.length, 1);
  assert.equal(loadState(projectDir).lastHandoffNeedsAttention, true);

  // F07 (P03): Patching an unchanged or unrelated existing feature (f2 title already "Second") MUST NOT clear f1's pendingHandoffItems
  updateMissionFeatures(projectDir, {
    updateFeatures: [{ id: "f2", title: "Second" }],
  });
  assert.equal(loadState(projectDir).pendingHandoffItems.length, 1);
  assert.equal(loadState(projectDir).lastHandoffNeedsAttention, true);

  // Dismissing the second item clears pendingHandoffItems and sets lastHandoffNeedsAttention = false
  dismissHandoffItems(projectDir, {
    dismissals: [
      {
        itemId: "chk-1",
        type: "non_interactive_check",
        sourceFeatureId: "f1",
        summary: "Verify CLI exit code",
        justification: "Verified manually in CI logs with zero exit code.",
      },
    ],
  });
  assert.equal(loadState(projectDir).pendingHandoffItems.length, 0);
  assert.equal(loadState(projectDir).lastHandoffNeedsAttention, false);

  // Complete f2, then test F08 (P07): scrutiny-validator-m1 omitting assertionResults must NOT auto-pass VAL-1
  const stateAfterMissingValidatorResults = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature(feature, _slot, currentState) {
        endFeatureRun(projectDir, {
          runId: currentState.activeWorker.runId,
          featureId: feature.id,
          successState: "success",
          validatorsPassed: true,
          handoff: { whatWasImplemented: VALID_SUMMARY_50 },
        });
      },
    }
  );
  assert.equal(stateAfterMissingValidatorResults.status, "orchestrator_turn");
  assert.equal(stateAfterMissingValidatorResults.lastHandoffNeedsAttention, true);
  assert.equal(stateAfterMissingValidatorResults.assertions[0].status, "pending");
  assert.equal(
    stateAfterMissingValidatorResults.pendingHandoffItems.some(
      (i) => i.id === "scrutiny-validator-m1:missing_assertion_results"
    ),
    true
  );

  // Reset scrutiny-validator-m1 to pending via updateMissionFeatures to test F08 (P08): explicit scrutiny failure followed by user-testing pass
  updateMissionFeatures(projectDir, {
    updateFeatures: [{ id: "scrutiny-validator-m1", status: "pending" }],
  });

  const stateAtValidators = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature(feature, _slot, currentState) {
        if (feature.id === "scrutiny-validator-m1") {
          assert.equal(currentState.activeWorker.role, "Validator");
          endFeatureRun(projectDir, {
            runId: currentState.activeWorker.runId,
            featureId: feature.id,
            successState: "success",
            validatorsPassed: true,
            assertionResults: { "VAL-1": "failed" },
            handoff: { whatWasImplemented: VALID_SUMMARY_50 },
          });
        }
      },
    }
  );

  // Failed assertion must trigger orchestrator_turn and lastHandoffNeedsAttention, NOT completed
  assert.equal(stateAtValidators.status, "orchestrator_turn");
  assert.equal(stateAtValidators.lastHandoffNeedsAttention, true);
  assert.equal(stateAtValidators.assertions[0].status, "failed");
  assert.equal(stateAtValidators.assertions[0].stageResults.scrutiny, "failed");
  assert.equal(
    stateAtValidators.pendingHandoffItems.some((i) => i.type === "validator_failure"),
    true
  );

  // F08 (P08): Dismiss the validator_failure and run user-testing-validator-m1 WITH VAL-1: 'passed':
  // VAL-1 must remain 'failed' (cannot overwrite failed scrutiny stage) and mission must NOT complete
  dismissHandoffItems(projectDir, {
    dismissals: [
      {
        type: "validator_failure",
        sourceFeatureId: "scrutiny-validator-m1",
        summary: "Validator or assertion failure",
        justification: "Acknowledging scrutiny failure to inspect user-testing stage.",
      },
    ],
  });

  const stateAfterUserTesting = await startMissionRun(
    projectDir,
    {},
    {
      async runFeature(feature, _slot, currentState) {
        endFeatureRun(projectDir, {
          runId: currentState.activeWorker.runId,
          featureId: feature.id,
          successState: "success",
          validatorsPassed: true,
          assertionResults: { "VAL-1": "passed" },
          handoff: { whatWasImplemented: VALID_SUMMARY_50 },
        });
      },
    }
  );

  assert.equal(stateAfterUserTesting.assertions[0].status, "failed");
  assert.equal(stateAfterUserTesting.assertions[0].stageResults.scrutiny, "failed");
  assert.equal(stateAfterUserTesting.assertions[0].stageResults.user_testing, "passed");
  assert.equal(stateAfterUserTesting.status, "orchestrator_turn");
  assert.equal(stateAfterUserTesting.lastHandoffNeedsAttention, true);

  // F10: Bare-array features.json is normalized on load
  const paths = getMissionPaths(projectDir);
  fs.writeFileSync(
    paths.featuresPath,
    JSON.stringify([{ id: "f-bare-array", milestoneId: "m1", status: "pending" }])
  );
  const loadedBare = loadFeaturesDoc(projectDir);
  assert.equal(loadedBare.features.length, 1);
  assert.equal(loadedBare.features[0].id, "f-bare-array");
});

test("F07 (P26) & F03 default HUD runtime upgrade: full-feature replacement with unchanged/unrelated features preserves pendingHandoffItems, and startMissionRun upgrades hud-default-runtime and bridge-cli-subprocess workers", async (t) => {
  const projectDir = makeTempProjectDir(t);

  proposeMission(projectDir, {
    title: "P26 & HUD Default Runtime Upgrade",
    repoPath: projectDir,
    milestones: [{ id: "m1", title: "Milestone 1", ordinal: 1 }],
    assertions: [{ id: "VAL-1", description: "P26 check", milestoneId: "m1" }],
    features: [
      { id: "f1", milestoneId: "m1", title: "Feature 1", fulfills: ["VAL-1"] },
      { id: "f2", milestoneId: "m1", title: "Feature 2", fulfills: ["VAL-1"] },
    ],
  });
  approveMissionPlan(projectDir);

  await startMissionRun(projectDir);
  // Simulate HUD default runtime having attached default identity with delegatedBy: "hud-default-runtime"
  const stRunning = loadState(projectDir);
  const runId = stRunning.activeWorker.runId;
  delete stRunning.activeWorker.dispatchPending;
  stRunning.activeWorker.delegatedBy = "hud-default-runtime";
  stRunning.sessions = stRunning.sessions.map((s) =>
    s.runId === runId ? { ...s, delegatedBy: "hud-default-runtime" } : s
  );
  saveState(projectDir, stRunning);

  // Upgrading via startMissionRun with a real runFeature adapter replaces default identity and deletes delegatedBy
  await startMissionRun(
    projectDir,
    {},
    {
      async runFeature() {
        return {
          taskId: "upgraded-task-1",
          childThreadId: "upgraded-thread-1",
          childRunId: "upgraded-crun-1",
          worktreePath: "/tmp/upgraded-wt-1",
        };
      },
    }
  );

  const stUpgraded = loadState(projectDir);
  assert.equal(stUpgraded.activeWorker.runId, runId);
  assert.equal(stUpgraded.activeWorker.attempt, 1);
  assert.equal(loadFeaturesDoc(projectDir).features.find((f) => f.id === "f1").attempts, 1);
  assert.equal(stUpgraded.activeWorker.delegatedBy, undefined);
  assert.equal(stUpgraded.activeWorker.dispatchPending, undefined);
  assert.equal(stUpgraded.activeWorker.taskId, "upgraded-task-1");
  assert.equal(stUpgraded.activeWorker.childThreadId, "upgraded-thread-1");
  assert.equal(stUpgraded.sessions[0].delegatedBy, undefined);
  assert.equal(stUpgraded.sessions[0].taskId, "upgraded-task-1");

  // Simulate activeWorker with runtimeTransport: "bridge-cli-subprocess" (and dispatchPending: undefined)
  stUpgraded.activeWorker.runtimeTransport = "bridge-cli-subprocess";
  delete stUpgraded.activeWorker.dispatchPending;
  stUpgraded.sessions = stUpgraded.sessions.map((s) => {
    if (s.runId === runId) {
      const copy = { ...s, runtimeTransport: "bridge-cli-subprocess" };
      delete copy.dispatchPending;
      return copy;
    }
    return s;
  });
  saveState(projectDir, stUpgraded);

  await startMissionRun(
    projectDir,
    {},
    {
      async runFeature() {
        return {
          taskId: "upgraded-task-cli",
          childThreadId: "upgraded-thread-cli",
          childRunId: "upgraded-crun-cli",
          worktreePath: "/tmp/upgraded-wt-cli",
        };
      },
    }
  );

  const stCliUpgraded = loadState(projectDir);
  assert.equal(stCliUpgraded.activeWorker.runId, runId);
  assert.equal(stCliUpgraded.activeWorker.attempt, 1);
  assert.equal(stCliUpgraded.activeWorker.runtimeTransport, undefined);
  assert.equal(stCliUpgraded.activeWorker.dispatchPending, undefined);
  assert.equal(stCliUpgraded.activeWorker.delegatedBy, undefined);
  assert.equal(stCliUpgraded.activeWorker.taskId, "upgraded-task-cli");
  assert.equal(stCliUpgraded.activeWorker.childThreadId, "upgraded-thread-cli");
  assert.equal(stCliUpgraded.activeWorker.childRunId, "upgraded-crun-cli");
  assert.equal(stCliUpgraded.activeWorker.worktreePath, "/tmp/upgraded-wt-cli");
  assert.equal(stCliUpgraded.sessions[0].runtimeTransport, undefined);
  assert.equal(stCliUpgraded.sessions[0].taskId, "upgraded-task-cli");
  assert.equal(stCliUpgraded.sessions[0].childThreadId, "upgraded-thread-cli");
  const upgradedF1 = loadFeaturesDoc(projectDir).features.find((f) => f.id === "f1");
  assert.equal(upgradedF1.attempts, 1);
  assert.equal(upgradedF1.taskId, "upgraded-task-cli");
  assert.equal(upgradedF1.childThreadId, "upgraded-thread-cli");
  assert.equal(upgradedF1.childRunId, "upgraded-crun-cli");
  assert.equal(upgradedF1.worktreePath, "/tmp/upgraded-wt-cli");

  // Simulate activeWorker marked with runtimeTransport: "hud-default-runtime" and a live placeholder workerPid
  const placeholderDaemon = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const placeholderPid = placeholderDaemon.pid;
  stCliUpgraded.activeWorker.runtimeTransport = "hud-default-runtime";
  stCliUpgraded.activeWorker.workerPid = placeholderPid;
  stCliUpgraded.activeWorker.daemonStateFile = path.join(projectDir, "daemon-state.json");
  stCliUpgraded.activeWorker.daemonStatus = "running";
  delete stCliUpgraded.activeWorker.dispatchPending;
  delete stCliUpgraded.activeWorker.delegatedBy;
  stCliUpgraded.sessions = stCliUpgraded.sessions.map((s) => {
    if (s.runId === runId) {
      const copy = {
        ...s,
        runtimeTransport: "hud-default-runtime",
        workerPid: placeholderPid,
        daemonStateFile: path.join(projectDir, "daemon-state.json"),
        daemonStatus: "running",
      };
      delete copy.dispatchPending;
      delete copy.delegatedBy;
      return copy;
    }
    return s;
  });
  saveState(projectDir, stCliUpgraded);

  await startMissionRun(
    projectDir,
    {},
    {
      async runFeature() {
        return {
          taskId: "upgraded-task-hud-rt",
          childThreadId: "upgraded-thread-hud-rt",
          childRunId: "upgraded-crun-hud-rt",
          worktreePath: "/tmp/upgraded-wt-hud-rt",
        };
      },
    }
  );

  const stHudRtUpgraded = loadState(projectDir);
  assert.equal(stHudRtUpgraded.activeWorker.runId, runId);
  assert.equal(stHudRtUpgraded.activeWorker.attempt, 1);
  assert.equal(stHudRtUpgraded.activeWorker.runtimeTransport, undefined);
  assert.equal(stHudRtUpgraded.activeWorker.dispatchPending, undefined);
  assert.equal(stHudRtUpgraded.activeWorker.delegatedBy, undefined);
  assert.equal(stHudRtUpgraded.activeWorker.workerPid, undefined);
  assert.equal(stHudRtUpgraded.activeWorker.daemonStateFile, undefined);
  assert.equal(stHudRtUpgraded.activeWorker.daemonStatus, undefined);
  assert.equal(stHudRtUpgraded.activeWorker.taskId, "upgraded-task-hud-rt");
  assert.equal(stHudRtUpgraded.activeWorker.childThreadId, "upgraded-thread-hud-rt");
  assert.equal(stHudRtUpgraded.activeWorker.childRunId, "upgraded-crun-hud-rt");
  assert.equal(stHudRtUpgraded.activeWorker.worktreePath, "/tmp/upgraded-wt-hud-rt");
  assert.equal(stHudRtUpgraded.sessions[0].runtimeTransport, undefined);
  assert.equal(stHudRtUpgraded.sessions[0].workerPid, undefined);
  assert.equal(stHudRtUpgraded.sessions[0].daemonStateFile, undefined);
  assert.equal(stHudRtUpgraded.sessions[0].daemonStatus, undefined);
  assert.equal(stHudRtUpgraded.sessions[0].taskId, "upgraded-task-hud-rt");
  assert.equal(stHudRtUpgraded.sessions[0].childThreadId, "upgraded-thread-hud-rt");
  const upgradedF1HudRt = loadFeaturesDoc(projectDir).features.find((f) => f.id === "f1");
  assert.equal(upgradedF1HudRt.attempts, 1);
  assert.equal(upgradedF1HudRt.taskId, "upgraded-task-hud-rt");
  assert.equal(upgradedF1HudRt.childThreadId, "upgraded-thread-hud-rt");
  assert.equal(upgradedF1HudRt.childRunId, "upgraded-crun-hud-rt");
  assert.equal(upgradedF1HudRt.worktreePath, "/tmp/upgraded-wt-hud-rt");

  // Complete f1 with a discoveredIssue ("must-remain")
  endFeatureRun(projectDir, {
    runId,
    featureId: "f1",
    successState: "success",
    validatorsPassed: true,
    handoff: {
      whatWasImplemented: VALID_SUMMARY_50,
      discoveredIssues: [{ id: "must-remain", summary: "Unresolved real defect" }],
    },
  });

  assert.equal(loadState(projectDir).pendingHandoffItems.length, 1);
  assert.equal(loadState(projectDir).lastHandoffNeedsAttention, true);

  // P26: Calling updateMissionFeatures with identical full-feature replacement array preserves pendingHandoffItems
  const currentFeatures = loadFeaturesDoc(projectDir).features;
  updateMissionFeatures(projectDir, { features: currentFeatures });
  const afterNoOpReplace = loadState(projectDir);
  assert.equal(afterNoOpReplace.pendingHandoffItems.length, 1);
  assert.equal(afterNoOpReplace.pendingHandoffItems[0].id, "must-remain");
  assert.equal(afterNoOpReplace.lastHandoffNeedsAttention, true);

  // Calling updateMissionFeatures with full-feature replacement mutating only unrelated f2 also preserves f1's pendingHandoffItems
  const [f1, f2] = loadFeaturesDoc(projectDir).features;
  updateMissionFeatures(projectDir, {
    features: [f1, { ...f2, title: "Unrelated change" }],
  });
  const afterUnrelatedReplace = loadState(projectDir);
  assert.equal(afterUnrelatedReplace.pendingHandoffItems.length, 1);
  assert.equal(afterUnrelatedReplace.pendingHandoffItems[0].id, "must-remain");
  assert.equal(afterUnrelatedReplace.lastHandoffNeedsAttention, true);

  // Calling updateMissionFeatures with full-feature replacement appending a new repair feature clears pendingHandoffItems
  updateMissionFeatures(projectDir, {
    features: [
      ...loadFeaturesDoc(projectDir).features,
      { id: "f-repair", milestoneId: "m1" },
    ],
  });
  const afterAddReplace = loadState(projectDir);
  assert.equal(afterAddReplace.pendingHandoffItems.length, 0);
  assert.equal(afterAddReplace.lastHandoffNeedsAttention, false);
});
