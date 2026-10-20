import test from "node:test";
import assert from "node:assert/strict";
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
  readProgressLog,
  saveState,
  getMissionPaths,
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
            whatWasLeftUndone: "无",
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
