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

export function extractDelegationIdentity(result) {
  if (!result || typeof result !== "object") {
    return {};
  }
  const sources = [result, result.delegation, result.response].filter(
    (s) => s && typeof s === "object"
  );
  const identity = {};
  for (const key of ["taskId", "childThreadId", "childRunId", "worktreePath"]) {
    for (const src of sources) {
      if (typeof src[key] === "string" && src[key].trim()) {
        identity[key] = src[key].trim();
        break;
      }
    }
  }
  if (!identity.childThreadId) {
    for (const src of sources) {
      if (typeof src.threadId === "string" && src.threadId.trim()) {
        identity.childThreadId = src.threadId.trim();
        break;
      }
    }
  }
  return identity;
}

export async function dispatchFeatureToWorker(
  missionDir,
  candidate,
  featureIdx,
  modelSettings,
  dispatchAdapter = {}
) {
  let state = loadState(missionDir);
  let featuresDoc = loadFeaturesDoc(missionDir);

  const currentAttempts =
    typeof candidate.attempts === "number" ? candidate.attempts : 0;
  const nextAttempt = currentAttempts + 1;
  const workerNumber =
    (Array.isArray(state.sessions) ? state.sessions.length : 0) + 1;
  const runId = createRunId();
  const startIso = new Date().toISOString();
  const isValidator = isValidatorFeature(candidate);
  const kind = inferFeatureKind(candidate);
  const role = isValidator
    ? "Validator"
    : candidate.kind === "explorer" || kind === "explorer"
      ? "Explorer"
      : "Worker";
  const { slotName, slotConfig } = resolveFeatureSlot(candidate, modelSettings);
  const hasRunFeature = typeof dispatchAdapter?.runFeature === "function";

  candidate.status = "running";
  candidate.attempts = nextAttempt;
  featuresDoc.features[featureIdx] = normalizeFeature(candidate, featureIdx);
  saveFeaturesDoc(missionDir, {
    ...featuresDoc,
    updatedAt: startIso,
  });

  const workerEntry = {
    runId,
    workerNumber,
    role,
    featureId: candidate.id,
    featureTitle: candidate.title,
    milestoneId: candidate.milestoneId,
    kind,
    skillName: candidate.skillName,
    slot: slotName,
    providerInstanceId: slotConfig.providerInstanceId,
    model: slotConfig.model,
    options: slotConfig.options || {},
    status: "running",
    attempt: nextAttempt,
    startedAt: startIso,
    handoff: null,
    ...(!hasRunFeature ? { dispatchPending: true } : {}),
  };

  state.activeWorker = workerEntry;
  state.status = "running";
  state.sessions = [
    ...(Array.isArray(state.sessions) ? state.sessions : []),
    { ...workerEntry },
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

  if (!hasRunFeature) {
    return loadState(missionDir);
  }

  const result = await dispatchAdapter.runFeature(
    featuresDoc.features[featureIdx],
    slotConfig,
    loadState(missionDir)
  );

  const identity = extractDelegationIdentity(result);
  state = loadState(missionDir);
  featuresDoc = loadFeaturesDoc(missionDir);

  if (Object.keys(identity).length > 0) {
    if (state.activeWorker && state.activeWorker.runId === runId) {
      state.activeWorker = {
        ...state.activeWorker,
        ...identity,
      };
    }
    if (Array.isArray(state.sessions)) {
      state.sessions = state.sessions.map((s) =>
        s.runId === runId ? { ...s, ...identity } : s
      );
    }
    const fIdx = featuresDoc.features.findIndex((f) => f.id === candidate.id);
    if (fIdx !== -1) {
      const featureIdentity = {};
      if (identity.taskId) featureIdentity.taskId = identity.taskId;
      if (identity.childThreadId)
        featureIdentity.childThreadId = identity.childThreadId;
      if (identity.worktreePath)
        featureIdentity.worktreePath = identity.worktreePath;
      if (identity.childRunId) featureIdentity.childRunId = identity.childRunId;
      featuresDoc.features[fIdx] = {
        ...featuresDoc.features[fIdx],
        ...featureIdentity,
      };
    }
    saveState(missionDir, state);
    saveFeaturesDoc(missionDir, {
      ...featuresDoc,
      updatedAt: new Date().toISOString(),
    });
  }

  // If dispatchAdapter.runFeature didn't call endFeatureRun itself, and returned a handoff object, handle it
  if (
    state.activeWorker &&
    state.activeWorker.runId === runId &&
    result &&
    typeof result === "object" &&
    result.handoff
  ) {
    endFeatureRun(missionDir, {
      runId,
      featureId: candidate.id,
      ...result,
    });
  }

  return loadState(missionDir);
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

  const needsResume =
    state.status === "paused" ||
    state.activeWorker?.status === "paused" ||
    state.activeWorker?.resumePending === true;

  // Already-running guard (F02 serialStart) + F03 dispatchPending / default runtime handoff
  if (
    !needsResume &&
    state.status === "running" &&
    state.activeWorker &&
    state.activeWorker.status === "running"
  ) {
    if (
      (state.activeWorker.dispatchPending === true ||
        state.activeWorker.delegatedBy === "hud-default-runtime" ||
        state.activeWorker.runtimeTransport === "bridge-cli-subprocess") &&
      typeof dispatchAdapter?.runFeature === "function"
    ) {
      const pendingRunId = state.activeWorker.runId;
      const pendingFeatureId = state.activeWorker.featureId;
      delete state.activeWorker.dispatchPending;
      delete state.activeWorker.delegatedBy;
      delete state.activeWorker.runtimeTransport;
      if (Array.isArray(state.sessions)) {
        state.sessions = state.sessions.map((s) => {
          if (s.runId === pendingRunId) {
            const copy = { ...s };
            delete copy.dispatchPending;
            delete copy.delegatedBy;
            delete copy.runtimeTransport;
            return copy;
          }
          return s;
        });
      }
      saveState(missionDir, state);

      const featuresDoc = loadFeaturesDoc(missionDir);
      const modelSettings = loadModelSettings(missionDir);
      const fIdx = featuresDoc.features.findIndex(
        (f) => f.id === pendingFeatureId
      );
      const feature =
        fIdx !== -1
          ? featuresDoc.features[fIdx]
          : {
              id: pendingFeatureId,
              title: state.activeWorker.featureTitle || pendingFeatureId,
              milestoneId: state.activeWorker.milestoneId || "m1",
              kind: state.activeWorker.kind || "implementation",
              skillName:
                state.activeWorker.skillName || "worker-implementation",
            };
      const { slotConfig } = resolveFeatureSlot(feature, modelSettings);

      const result = await dispatchAdapter.runFeature(
        feature,
        slotConfig,
        loadState(missionDir)
      );

      const identity = extractDelegationIdentity(result);
      state = loadState(missionDir);
      const updatedFeaturesDoc = loadFeaturesDoc(missionDir);

      if (Object.keys(identity).length > 0) {
        if (state.activeWorker && state.activeWorker.runId === pendingRunId) {
          state.activeWorker = {
            ...state.activeWorker,
            ...identity,
          };
          delete state.activeWorker.dispatchPending;
          delete state.activeWorker.delegatedBy;
          delete state.activeWorker.runtimeTransport;
        }
        if (Array.isArray(state.sessions)) {
          state.sessions = state.sessions.map((s) => {
            if (s.runId === pendingRunId) {
              const copy = { ...s, ...identity };
              delete copy.dispatchPending;
              delete copy.delegatedBy;
              delete copy.runtimeTransport;
              return copy;
            }
            return s;
          });
        }
        const idx = updatedFeaturesDoc.features.findIndex(
          (f) => f.id === pendingFeatureId
        );
        if (idx !== -1) {
          const featureIdentity = {};
          if (identity.taskId) featureIdentity.taskId = identity.taskId;
          if (identity.childThreadId)
            featureIdentity.childThreadId = identity.childThreadId;
          if (identity.worktreePath)
            featureIdentity.worktreePath = identity.worktreePath;
          if (identity.childRunId)
            featureIdentity.childRunId = identity.childRunId;
          updatedFeaturesDoc.features[idx] = {
            ...updatedFeaturesDoc.features[idx],
            ...featureIdentity,
          };
        }
        saveState(missionDir, state);
        saveFeaturesDoc(missionDir, {
          ...updatedFeaturesDoc,
          updatedAt: new Date().toISOString(),
        });
      }

      if (
        state.activeWorker &&
        state.activeWorker.runId === pendingRunId &&
        result &&
        typeof result === "object" &&
        result.handoff
      ) {
        endFeatureRun(missionDir, {
          runId: pendingRunId,
          featureId: pendingFeatureId,
          ...result,
        });
      }

      state = loadState(missionDir);
      if (
        state.status === "orchestrator_turn" ||
        state.status === "paused" ||
        state.lastHandoffNeedsAttention ||
        (state.activeWorker && state.activeWorker.status === "running") ||
        state.activeWorker
      ) {
        return state;
      }
    } else {
      return state;
    }
  }

  // Resume interrupted worker first if recovering from paused state
  if (needsResume && state.activeWorker && !options?.restartFeature) {
    const pausedActiveWorker = { ...state.activeWorker };
    const workerNumber = pausedActiveWorker.workerNumber ?? 1;
    const featureTitle =
      pausedActiveWorker.featureTitle ||
      pausedActiveWorker.title ||
      pausedActiveWorker.featureId;

    let resumeResult = null;
    if (typeof dispatchAdapter?.resumeWorker === "function") {
      resumeResult = await dispatchAdapter.resumeWorker(
        state.activeWorker,
        options,
        loadState(missionDir)
      );

      if (
        resumeResult &&
        (resumeResult.resumed === false ||
          resumeResult.canResume === false ||
          resumeResult.status === "blocked_by_conflicts" ||
          resumeResult.action === "blocked_by_conflicts")
      ) {
        state = loadState(missionDir);
        state.status = "paused";
        if (state.activeWorker) {
          state.activeWorker = {
            ...state.activeWorker,
            status: "paused",
          };
          delete state.activeWorker.resumePending;
        }
        if (Array.isArray(state.sessions)) {
          state.sessions = state.sessions.map((s) =>
            s.runId === pausedActiveWorker.runId
              ? { ...s, status: "paused" }
              : s
          );
        }
        saveState(missionDir, state);
        return state;
      }
    }

    const nowIso = new Date().toISOString();
    const identity = extractDelegationIdentity(resumeResult);
    state = loadState(missionDir);

    const workerStillActive = Boolean(
      state.activeWorker && state.activeWorker.runId === pausedActiveWorker.runId
    );

    if (workerStillActive) {
      state.status = "running";
      state.lastStartedAt = nowIso;
      state.revision = (state.revision || 1) + 1;
      state.activeWorker = {
        ...state.activeWorker,
        ...identity,
        status: "running",
        resumedAt: nowIso,
      };
      delete state.activeWorker.resumePending;

      if (Array.isArray(state.sessions)) {
        state.sessions = state.sessions.map((s) =>
          s.runId === pausedActiveWorker.runId
            ? { ...s, ...identity, status: "running", resumedAt: nowIso }
            : s
        );
      }
      saveState(missionDir, state);

      const featuresDoc = loadFeaturesDoc(missionDir);
      const fIdx = featuresDoc.features.findIndex(
        (f) => f.id === pausedActiveWorker.featureId
      );
      if (fIdx !== -1) {
        const featureIdentity = {};
        if (identity.taskId) featureIdentity.taskId = identity.taskId;
        if (identity.childThreadId)
          featureIdentity.childThreadId = identity.childThreadId;
        if (identity.worktreePath)
          featureIdentity.worktreePath = identity.worktreePath;
        if (identity.childRunId)
          featureIdentity.childRunId = identity.childRunId;

        featuresDoc.features[fIdx] = {
          ...featuresDoc.features[fIdx],
          ...featureIdentity,
          status: "running",
        };
        saveFeaturesDoc(missionDir, featuresDoc);
      }
    } else {
      if (state.status === "paused") {
        state.status = "running";
        state.lastStartedAt = nowIso;
        state.revision = (state.revision || 1) + 1;
      }
      if (Object.keys(identity).length > 0 && Array.isArray(state.sessions)) {
        state.sessions = state.sessions.map((s) =>
          s.runId === pausedActiveWorker.runId ? { ...s, ...identity } : s
        );
      }
      saveState(missionDir, state);
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
      type: "worker_resumed",
      message: `Run started: Resume ${featureTitle}`,
      featureId: pausedActiveWorker.featureId,
      workerNumber,
    });

    if (resumeResult && resumeResult.handoff) {
      const currentAfterResume = loadState(missionDir);
      if (currentAfterResume.activeWorker) {
        const endOutcome = endFeatureRun(missionDir, {
          runId: pausedActiveWorker.runId,
          featureId: pausedActiveWorker.featureId,
          ...resumeResult,
        });
        if (endOutcome.shouldReturnToOrchestrator) {
          return loadState(missionDir);
        }
      }
    }

    const postResumeState = loadState(missionDir);
    if (
      (!resumeResult || !resumeResult.handoff) &&
      postResumeState.activeWorker?.status === "running"
    ) {
      return postResumeState;
    }

    if (
      postResumeState.status === "orchestrator_turn" ||
      postResumeState.status === "paused" ||
      postResumeState.lastHandoffNeedsAttention
    ) {
      return postResumeState;
    }
  } else if (needsResume && state.activeWorker && options?.restartFeature === true) {
    const nowIso = new Date().toISOString();
    const oldFeatureId = state.activeWorker.featureId;
    state.activeWorker = null;
    state.status = "running";
    state.lastStartedAt = nowIso;
    state.revision = (state.revision || 1) + 1;
    saveState(missionDir, state);

    const featuresDoc = loadFeaturesDoc(missionDir);
    const fIdx = featuresDoc.features.findIndex((f) => f.id === oldFeatureId);
    if (fIdx !== -1 && featuresDoc.features[fIdx].status === "running") {
      featuresDoc.features[fIdx].status = "pending";
      saveFeaturesDoc(missionDir, featuresDoc);
    }
  } else if (state.status !== "running") {
    const nowIso = new Date().toISOString();
    state.status = "running";
    state.lastStartedAt = nowIso;
    state.revision = (state.revision || 1) + 1;
    saveState(missionDir, state);
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
      const anyRunning =
        featuresDoc.features.some((f) => f.status === "running") ||
        Boolean(state.activeWorker && state.activeWorker.status === "running");

      if (!anyRunning) {
        const hasValidatorFeatures = featuresDoc.features.some((f) =>
          isValidatorFeature(f)
        );
        const hasFailedValidator = featuresDoc.features.some(
          (f) => isValidatorFeature(f) && f.status === "failed"
        );
        const hasFailedAssertion = (state.assertions || []).some(
          (a) =>
            a.status === "failed" ||
            (hasValidatorFeatures && a.status !== "passed")
        );
        if (hasFailedAssertion || hasFailedValidator) {
          state.status = "orchestrator_turn";
          state.lastHandoffNeedsAttention = true;
          if (
            !Array.isArray(state.pendingHandoffItems) ||
            state.pendingHandoffItems.length === 0
          ) {
            state.pendingHandoffItems = [
              {
                id: "mission:validator_failure",
                type: "validator_failure",
                sourceFeatureId: "validator",
                summary: "Validator or assertion failure",
              },
            ];
          }
          state.activeWorker = null;
          state.revision = (state.revision || 1) + 1;
          saveState(missionDir, state);
          return loadState(missionDir);
        }

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

    await dispatchFeatureToWorker(
      missionDir,
      candidate,
      nextIdx,
      modelSettings,
      dispatchAdapter
    );

    state = loadState(missionDir);

    if (
      state.status === "orchestrator_turn" ||
      state.status === "paused" ||
      state.lastHandoffNeedsAttention
    ) {
      return state;
    }

    // If worker is still active (e.g. async worker launched via delegate_task), return immediately
    if (state.activeWorker && state.activeWorker.status === "running") {
      return state;
    }

    if (state.activeWorker) {
      return state;
    }
  }
}
