import {
  createRunId,
  inferFeatureKind,
  isValidatorFeature,
  MissionKernelError,
  normalizeFeature,
} from "./schema.mjs";
import {
  appendProgressLog,
  loadFeaturesDoc,
  loadModelSettings,
  loadState,
  saveFeaturesDoc,
  saveState,
} from "./store.mjs";
import {
  checkMilestoneCompletionAndInjectValidation,
  endFeatureRun,
} from "./tools.mjs";

export function resolveFeatureSlot(feature, modelSettings) {
  const validator = isValidatorFeature(feature);
  const slotName = validator ? "validator" : "worker";
  const slotConfig = validator
    ? modelSettings.validator
    : modelSettings.worker;
  return {
    slotName,
    slotConfig: {
      slot: slotName,
      ...slotConfig,
    },
  };
}

export async function startMissionRun(
  missionDir,
  options = {},
  dispatchAdapter = {}
) {
  let state = loadState(missionDir);

  if (state.planAccepted !== true) {
    throw new MissionKernelError(
      "PLAN_ACCEPTANCE_REQUIRED",
      "Mission plan must be approved before starting a mission run"
    );
  }

  if (state.lastHandoffNeedsAttention === true) {
    throw new MissionKernelError(
      "HANDOFF_ATTENTION_REQUIRED",
      "Previous worker handoff requires orchestrator attention (updateMissionFeatures or dismissHandoffItems) before continuing"
    );
  }

  const wasPaused = state.status === "paused";
  const pausedActiveWorker =
    wasPaused &&
    state.activeWorker &&
    state.activeWorker.status === "paused" &&
    options?.restartFeature !== true
      ? { ...state.activeWorker }
      : null;

  const nowIso = new Date().toISOString();
  state.status = "running";
  state.lastStartedAt = nowIso;
  state.revision = (state.revision || 1) + 1;
  saveState(missionDir, state);

  // Resume interrupted worker first if recovering from paused state
  if (pausedActiveWorker) {
    const workerNumber = pausedActiveWorker.workerNumber ?? 1;
    const featureTitle =
      pausedActiveWorker.featureTitle ||
      pausedActiveWorker.title ||
      pausedActiveWorker.featureId;

    state.activeWorker = {
      ...pausedActiveWorker,
      status: "running",
      resumedAt: nowIso,
    };

    if (Array.isArray(state.sessions)) {
      state.sessions = state.sessions.map((s) =>
        s.runId === pausedActiveWorker.runId
          ? { ...s, status: "running", resumedAt: nowIso }
          : s
      );
    }
    saveState(missionDir, state);

    const featuresDoc = loadFeaturesDoc(missionDir);
    const fIdx = featuresDoc.features.findIndex(
      (f) => f.id === pausedActiveWorker.featureId
    );
    if (fIdx !== -1 && featuresDoc.features[fIdx].status !== "running") {
      featuresDoc.features[fIdx].status = "running";
      saveFeaturesDoc(missionDir, featuresDoc);
    }

    appendProgressLog(missionDir, {
      timestamp: nowIso,
      type: "mission_resumed",
      message: "Mission resumed",
      featureId: pausedActiveWorker.featureId,
      workerNumber,
    });

    appendProgressLog(missionDir, {
      timestamp: nowIso,
      type: "run_started",
      message: `Run started: Resume ${featureTitle}`,
      featureId: pausedActiveWorker.featureId,
      workerNumber,
    });

    if (typeof dispatchAdapter?.resumeWorker === "function") {
      const resumeResult = await dispatchAdapter.resumeWorker(
        state.activeWorker,
        options,
        loadState(missionDir)
      );

      // If the adapter returned a handoff payload instead of calling endFeatureRun directly
      const refreshedState = loadState(missionDir);
      if (refreshedState.activeWorker && resumeResult && resumeResult.handoff) {
        const endOutcome = endFeatureRun(missionDir, {
          runId: state.activeWorker.runId,
          featureId: state.activeWorker.featureId,
          ...resumeResult,
        });
        if (endOutcome.shouldReturnToOrchestrator) {
          return loadState(missionDir);
        }
      } else if (
        refreshedState.status === "orchestrator_turn" ||
        refreshedState.status === "paused" ||
        refreshedState.lastHandoffNeedsAttention
      ) {
        return refreshedState;
      }
    }
  } else if (wasPaused && state.activeWorker && options?.restartFeature === true) {
    // Reset paused activeWorker so the feature runs fresh
    const oldFeatureId = state.activeWorker.featureId;
    state.activeWorker = null;
    saveState(missionDir, state);
    const featuresDoc = loadFeaturesDoc(missionDir);
    const fIdx = featuresDoc.features.findIndex((f) => f.id === oldFeatureId);
    if (fIdx !== -1 && featuresDoc.features[fIdx].status === "running") {
      featuresDoc.features[fIdx].status = "pending";
      saveFeaturesDoc(missionDir, featuresDoc);
    }
  }

  // Serial feature loop
  while (true) {
    // Check if any milestone just finished its implementation/repair features and needs validators
    checkMilestoneCompletionAndInjectValidation(missionDir);

    state = loadState(missionDir);
    if (
      state.status === "paused" ||
      state.status === "orchestrator_turn" ||
      state.lastHandoffNeedsAttention
    ) {
      return state;
    }

    const featuresDoc = loadFeaturesDoc(missionDir);
    const modelSettings = loadModelSettings(missionDir);

    const nextIdx = featuresDoc.features.findIndex(
      (f) => f.status === "pending"
    );

    if (nextIdx === -1) {
      const anyRunning = featuresDoc.features.some(
        (f) => f.status === "running"
      );
      if (!anyRunning) {
        const finishIso = new Date().toISOString();
        if (state.lastStartedAt) {
          const startedMs = Date.parse(state.lastStartedAt);
          const endMs = Date.parse(finishIso);
          if (!Number.isNaN(startedMs) && endMs > startedMs) {
            state.elapsedMs = (state.elapsedMs || 0) + (endMs - startedMs);
          }
        }
        state.lastStartedAt = null;
        state.status = "completed";
        state.activeWorker = null;
        state.revision = (state.revision || 1) + 1;
        saveState(missionDir, state);

        appendProgressLog(missionDir, {
          timestamp: finishIso,
          type: "mission_completed",
          message: "Mission completed",
          featureId: null,
          workerNumber: null,
        });
      }
      return loadState(missionDir);
    }

    const candidate = featuresDoc.features[nextIdx];
    const maxAttempts =
      typeof candidate.maxAttempts === "number" ? candidate.maxAttempts : 5;
    const currentAttempts =
      typeof candidate.attempts === "number" ? candidate.attempts : 0;

    if (currentAttempts >= maxAttempts) {
      const pauseIso = new Date().toISOString();
      state.status = "paused";
      state.lastStartedAt = null;
      state.revision = (state.revision || 1) + 1;
      saveState(missionDir, state);

      appendProgressLog(missionDir, {
        timestamp: pauseIso,
        type: "max_attempts_exceeded",
        message: `Feature ${candidate.id} reached maxAttempts (${maxAttempts}); mission paused awaiting bonus attempts grant`,
        featureId: candidate.id,
        workerNumber: null,
      });

      return loadState(missionDir);
    }

    const nextAttempt = currentAttempts + 1;
    const workerNumber = (Array.isArray(state.sessions) ? state.sessions.length : 0) + 1;
    const runId = createRunId();
    const startIso = new Date().toISOString();
    const { slotName, slotConfig } = resolveFeatureSlot(
      candidate,
      modelSettings
    );

    candidate.status = "running";
    candidate.attempts = nextAttempt;
    featuresDoc.features[nextIdx] = normalizeFeature(candidate, nextIdx);
    saveFeaturesDoc(missionDir, {
      ...featuresDoc,
      updatedAt: startIso,
    });

    const activeWorker = {
      runId,
      workerNumber,
      featureId: candidate.id,
      featureTitle: candidate.title,
      milestoneId: candidate.milestoneId,
      kind: inferFeatureKind(candidate),
      skillName: candidate.skillName,
      slot: slotName,
      providerInstanceId: slotConfig.providerInstanceId,
      model: slotConfig.model,
      options: slotConfig.options || {},
      status: "running",
      attempt: nextAttempt,
      startedAt: startIso,
    };

    state.activeWorker = activeWorker;
    state.status = "running";
    state.sessions = [
      ...(Array.isArray(state.sessions) ? state.sessions : []),
      { ...activeWorker },
    ];
    state.revision = (state.revision || 1) + 1;
    saveState(missionDir, state);

    appendProgressLog(missionDir, {
      timestamp: startIso,
      type: "run_started",
      message: `Worker #${workerNumber} started ${candidate.id}: ${candidate.title}`,
      featureId: candidate.id,
      workerNumber,
    });

    if (typeof dispatchAdapter?.runFeature !== "function") {
      return loadState(missionDir);
    }

    const dispatchResult = await dispatchAdapter.runFeature(
      featuresDoc.features[nextIdx],
      slotConfig,
      loadState(missionDir)
    );

    const postRunState = loadState(missionDir);

    // If dispatchAdapter.runFeature didn't call endFeatureRun itself, and returned a handoff object, handle it
    if (
      postRunState.activeWorker &&
      postRunState.activeWorker.runId === runId &&
      dispatchResult &&
      typeof dispatchResult === "object" &&
      dispatchResult.handoff
    ) {
      const outcome = endFeatureRun(missionDir, {
        runId,
        featureId: candidate.id,
        ...dispatchResult,
      });
      if (outcome.shouldReturnToOrchestrator) {
        return loadState(missionDir);
      }
      continue;
    }

    // If dispatchAdapter called endFeatureRun directly, check state transition
    if (
      postRunState.status === "orchestrator_turn" ||
      postRunState.status === "paused" ||
      postRunState.lastHandoffNeedsAttention
    ) {
      return postRunState;
    }

    // If worker is still active (e.g. async or paused mid-flight), stop loop
    if (postRunState.activeWorker) {
      return postRunState;
    }
  }
}
