import {
  ASSERTION_STATUSES,
  createInitialState,
  inferFeatureKind,
  isNonEmptyLeftUndone,
  isValidatorFeature,
  MissionKernelError,
  normalizeAssertion,
  normalizeFeature,
  normalizeMilestone,
  normalizeModelSettings,
  validateDismissals,
} from "./schema.mjs";
import {
  appendProgressLog,
  ensureMissionDir,
  getMissionPaths,
  loadFeaturesDoc,
  loadModelSettings,
  loadState,
  saveFeaturesDoc,
  saveModelSettings,
  saveState,
  tryLoadState,
  writeFileAtomicSync,
} from "./store.mjs";

export function proposeMission(missionDir, input = {}) {
  const paths = ensureMissionDir(missionDir);
  const existingState = tryLoadState(missionDir);
  const existingSettings = loadModelSettings(missionDir);

  const state = createInitialState(
    {
      ...input,
      status: "awaiting_input",
      planAccepted: false,
    },
    existingState
  );

  const features = Array.isArray(input.features)
    ? input.features.map((f, i) => normalizeFeature(f, i))
    : [];

  const modelSettings = normalizeModelSettings(
    input.modelSettings || {},
    existingSettings
  );

  saveState(missionDir, state);
  const featuresDoc = saveFeaturesDoc(missionDir, {
    features,
    updatedAt: new Date().toISOString(),
  });
  saveModelSettings(missionDir, modelSettings);

  // Initialize progress_log.jsonl if it does not exist yet
  if (!existingState) {
    writeFileAtomicSync(paths.progressLogPath, "");
  }

  appendProgressLog(missionDir, {
    type: "propose_mission",
    message: "ProposeMission submitted",
    featureId: null,
    workerNumber: null,
  });

  return {
    state,
    features: featuresDoc.features,
    modelSettings,
  };
}

export function approveMissionPlan(missionDir) {
  const state = loadState(missionDir);
  state.planAccepted = true;
  state.status = "orchestrator_turn";
  state.revision = (state.revision || 1) + 1;
  saveState(missionDir, state);

  appendProgressLog(missionDir, {
    type: "plan_approved",
    message: "Mission plan approved",
    featureId: null,
    workerNumber: null,
  });

  return {
    ...state,
    state,
  };
}

export function rejectMissionPlan(missionDir, feedback = "") {
  const state = loadState(missionDir);
  state.planAccepted = false;
  state.status = "planning";
  state.revision = (state.revision || 1) + 1;
  if (feedback) {
    state.lastPlanFeedback = String(feedback);
  }
  saveState(missionDir, state);

  appendProgressLog(missionDir, {
    type: "plan_rejected",
    message: feedback
      ? `Mission plan rejected: ${feedback}`
      : "Mission plan rejected",
    featureId: null,
    workerNumber: null,
  });

  return state;
}

function doesDismissalMatchPending(pending, dismissal) {
  if (!pending || typeof pending !== "object") return false;
  if (pending.sourceFeatureId !== dismissal.sourceFeatureId) return false;
  if (pending.type !== dismissal.type) return false;
  const pendingSummary = String(pending.summary || "");
  const dismissalSummary = String(dismissal.summary || "");
  return (
    (pendingSummary &&
      dismissalSummary &&
      pendingSummary.includes(dismissalSummary)) ||
    (pendingSummary &&
      dismissalSummary &&
      dismissalSummary.includes(pendingSummary)) ||
    (dismissal.itemId && pending.id === dismissal.itemId) ||
    pending.id === dismissalSummary ||
    pendingSummary === dismissalSummary
  );
}

export function dismissHandoffItems(missionDir, { dismissals } = {}) {
  const validated = validateDismissals(dismissals);
  const state = loadState(missionDir);
  const featuresDoc = loadFeaturesDoc(missionDir);

  if (
    Array.isArray(state.pendingHandoffItems) &&
    state.pendingHandoffItems.length > 0
  ) {
    for (const dismissal of validated) {
      const matched = state.pendingHandoffItems.some((pending) =>
        doesDismissalMatchPending(pending, dismissal)
      );
      if (!matched) {
        throw new MissionKernelError(
          "UNKNOWN_HANDOFF_ITEM",
          `Dismissal for feature "${dismissal.sourceFeatureId}" (${dismissal.type}: "${dismissal.summary}") does not match any pending handoff item`
        );
      }
    }

    state.pendingHandoffItems = state.pendingHandoffItems.filter(
      (pending) =>
        !validated.some((dismissal) =>
          doesDismissalMatchPending(pending, dismissal)
        )
    );
    state.lastHandoffNeedsAttention = state.pendingHandoffItems.length > 0;
  } else {
    for (const dismissal of validated) {
      const feature = featuresDoc.features.find(
        (f) => f.id === dismissal.sourceFeatureId
      );
      if (!feature || !feature.lastHandoff) {
        throw new MissionKernelError(
          "UNKNOWN_HANDOFF_ITEM",
          `Dismissal for feature "${dismissal.sourceFeatureId}" does not match any pending handoff item`
        );
      }
    }
    state.pendingHandoffItems = [];
    state.lastHandoffNeedsAttention = false;
  }

  state.revision = (state.revision || 1) + 1;
  state.lastDismissedHandoffItems = validated;
  saveState(missionDir, state);

  appendProgressLog(missionDir, {
    type: "handoff_items_dismissed",
    message: "Handoff items dismissed",
    featureId: validated[0]?.sourceFeatureId ?? null,
    workerNumber: null,
    details: { dismissals: validated },
  });

  return {
    state,
    dismissals: validated,
  };
}

export function updateMissionFeatures(
  missionDir,
  {
    features: replacementFeatures,
    addFeatures = [],
    updateFeatures = [],
    milestones: replacementMilestones,
    assertions: replacementAssertions,
    updateAssertions = [],
    modelSettings,
    bonusAttempts = {},
  } = {}
) {
  const state = loadState(missionDir);
  const featuresDoc = loadFeaturesDoc(missionDir);
  let features = [...featuresDoc.features];

  let addedCount = 0;
  let updatedCount = 0;
  let replacedCount = 0;

  if (Array.isArray(replacementFeatures)) {
    features = replacementFeatures.map((f, i) => normalizeFeature(f, i));
    replacedCount += replacementFeatures.length || 1;
  }

  if (Array.isArray(updateFeatures) && updateFeatures.length > 0) {
    for (const patch of updateFeatures) {
      const patchId = patch?.id ? String(patch.id).trim() : "";
      if (!patchId) {
        throw new MissionKernelError(
          "UNKNOWN_FEATURE_ID",
          "Feature update patch requires a valid id"
        );
      }
      const idx = features.findIndex((f) => f.id === patchId);
      if (idx === -1) {
        throw new MissionKernelError(
          "UNKNOWN_FEATURE_ID",
          `Feature "${patchId}" not found`
        );
      }
      features[idx] = normalizeFeature({ ...features[idx], ...patch }, idx);
      updatedCount += 1;
    }
  }

  if (bonusAttempts && typeof bonusAttempts === "object") {
    for (const [featureId, extra] of Object.entries(bonusAttempts)) {
      const idx = features.findIndex((f) => f.id === featureId);
      if (idx === -1) {
        throw new MissionKernelError(
          "UNKNOWN_FEATURE_ID",
          `Feature "${featureId}" not found`
        );
      }
      if (typeof extra === "number" && extra > 0) {
        features[idx] = normalizeFeature(
          {
            ...features[idx],
            maxAttempts: (features[idx].maxAttempts || 5) + extra,
          },
          idx
        );
        updatedCount += 1;
      }
    }
  }

  if (Array.isArray(addFeatures) && addFeatures.length > 0) {
    for (const rawFeature of addFeatures) {
      const normalized = normalizeFeature(rawFeature, features.length);
      const existingIdx = features.findIndex((f) => f.id === normalized.id);
      if (existingIdx !== -1) {
        features[existingIdx] = normalizeFeature(
          { ...features[existingIdx], ...normalized },
          existingIdx
        );
        updatedCount += 1;
      } else {
        features.push(normalized);
        addedCount += 1;
      }
    }
  }

  if (Array.isArray(replacementMilestones)) {
    state.milestones = replacementMilestones.map((m, i) =>
      normalizeMilestone(m, i)
    );
    replacedCount += replacementMilestones.length || 1;
  }

  if (Array.isArray(replacementAssertions)) {
    state.assertions = replacementAssertions.map((a, i) =>
      normalizeAssertion(a, i)
    );
    replacedCount += replacementAssertions.length || 1;
  }

  if (Array.isArray(updateAssertions) && updateAssertions.length > 0) {
    const assertions = Array.isArray(state.assertions)
      ? [...state.assertions]
      : [];
    for (const patch of updateAssertions) {
      if (!patch || !patch.id) continue;
      const idx = assertions.findIndex((a) => a.id === patch.id);
      if (idx !== -1) {
        assertions[idx] = normalizeAssertion(
          { ...assertions[idx], ...patch },
          idx
        );
        updatedCount += 1;
      } else {
        assertions.push(normalizeAssertion(patch, assertions.length));
        addedCount += 1;
      }
    }
    state.assertions = assertions;
  }

  let updatedModelSettings = null;
  if (modelSettings && typeof modelSettings === "object") {
    const currentSettings = loadModelSettings(missionDir);
    updatedModelSettings = saveModelSettings(
      missionDir,
      normalizeModelSettings(modelSettings, currentSettings)
    );
  }

  const nowIso = new Date().toISOString();
  const savedDoc = saveFeaturesDoc(missionDir, {
    ...featuresDoc,
    features,
    updatedAt: nowIso,
  });

  if (addedCount > 0 || updatedCount > 0 || replacedCount > 0) {
    state.lastHandoffNeedsAttention = false;
    state.pendingHandoffItems = [];
  }
  state.revision = (state.revision || 1) + 1;
  saveState(missionDir, state);

  appendProgressLog(missionDir, {
    timestamp: nowIso,
    type: "features_updated",
    message: `Mission features updated (${savedDoc.features.filter((f) => f.status === "completed").length}/${savedDoc.features.length} completed)`,
    featureId:
      addFeatures[0]?.id ??
      updateFeatures[0]?.id ??
      replacementFeatures?.[0]?.id ??
      null,
    workerNumber: null,
  });

  return {
    state,
    features: savedDoc.features,
    updatedAt: savedDoc.updatedAt,
    modelSettings: updatedModelSettings || loadModelSettings(missionDir),
  };
}

export function checkMilestoneCompletionAndInjectValidation(missionDir) {
  const state = loadState(missionDir);
  const featuresDoc = loadFeaturesDoc(missionDir);
  const modelSettings = loadModelSettings(missionDir);

  if (
    !state.milestoneValidationTriggered ||
    typeof state.milestoneValidationTriggered !== "object"
  ) {
    state.milestoneValidationTriggered = {};
  }

  const milestones = Array.isArray(state.milestones) ? state.milestones : [];
  const injectedFeatures = [];

  for (const milestone of milestones) {
    const milestoneId = milestone.id;
    if (state.milestoneValidationTriggered[milestoneId]) {
      continue;
    }

    const milestoneFeatures = featuresDoc.features.filter(
      (f) => f.milestoneId === milestoneId
    );
    const workFeatures = milestoneFeatures.filter((f) => {
      const kind = inferFeatureKind(f);
      return kind === "implementation" || kind === "repair";
    });

    if (workFeatures.length === 0) {
      continue;
    }

    const allWorkDone = workFeatures.every(
      (f) => f.status === "completed" || f.status === "cancelled"
    );

    if (!allWorkDone) {
      continue;
    }

    const milestoneAssertions = (state.assertions || [])
      .filter((a) => a.milestoneId === milestoneId)
      .map((a) => a.id);

    const toInject = [];
    const scrutinyId = `scrutiny-validator-${milestoneId}`;
    const userTestingId = `user-testing-validator-${milestoneId}`;

    if (
      !modelSettings.skipScrutiny &&
      !featuresDoc.features.some((f) => f.id === scrutinyId)
    ) {
      toInject.push(
        normalizeFeature({
          id: scrutinyId,
          milestoneId,
          title: `Scrutiny validation for ${milestone.title || milestoneId}`,
          description: `Code review and scrutiny validation for ${milestone.title || milestoneId}`,
          kind: "scrutiny",
          skillName: `scrutiny-validator-${milestoneId}`,
          fulfills: milestoneAssertions,
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          lastHandoff: null,
        })
      );
    }

    if (
      !modelSettings.skipUserTesting &&
      !featuresDoc.features.some((f) => f.id === userTestingId)
    ) {
      toInject.push(
        normalizeFeature({
          id: userTestingId,
          milestoneId,
          title: `User-testing validation for ${milestone.title || milestoneId}`,
          description: `Real user-testing and assertion verification for ${milestone.title || milestoneId}`,
          kind: "user_testing",
          skillName: `user-testing-validator-${milestoneId}`,
          fulfills: milestoneAssertions,
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          lastHandoff: null,
        })
      );
    }

    state.milestoneValidationTriggered[milestoneId] = true;

    if (toInject.length > 0) {
      // Inject at the head of the pending queue (before any remaining pending features)
      const firstPendingIdx = featuresDoc.features.findIndex(
        (f) => f.status === "pending"
      );
      if (firstPendingIdx === -1) {
        featuresDoc.features.push(...toInject);
      } else {
        featuresDoc.features.splice(firstPendingIdx, 0, ...toInject);
      }
      injectedFeatures.push(...toInject);
    }

    appendProgressLog(missionDir, {
      type: "milestone_validation_triggered",
      message: `Milestone ${milestoneId} validation triggered (${toInject.map((f) => f.id).join(", ") || "skipped"})`,
      milestoneId,
      featureId: toInject[0]?.id ?? null,
      workerNumber: null,
    });
  }

  if (
    injectedFeatures.length > 0 ||
    Object.keys(state.milestoneValidationTriggered).length > 0
  ) {
    saveState(missionDir, state);
  }
  if (injectedFeatures.length > 0) {
    saveFeaturesDoc(missionDir, {
      ...featuresDoc,
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    injectedFeatures,
    state,
    features: featuresDoc.features,
  };
}

export function endFeatureRun(missionDir, input = {}) {
  if (!input?.featureId && !input?.runId) {
    throw new MissionKernelError(
      "MISSING_RUN_IDENTITY",
      "EndFeatureRun requires featureId or runId"
    );
  }

  const state = loadState(missionDir);
  const featuresDoc = loadFeaturesDoc(missionDir);

  if (!state.activeWorker) {
    throw new MissionKernelError(
      "NO_ACTIVE_WORKER",
      "Cannot end feature run: there is no activeWorker in state"
    );
  }

  if (
    input.runId &&
    state.activeWorker.runId &&
    input.runId !== state.activeWorker.runId
  ) {
    throw new MissionKernelError(
      "STALE_WORKER_RUN",
      `Worker runId mismatch: expected ${state.activeWorker.runId}, got ${input.runId}`
    );
  }

  if (
    input.featureId &&
    state.activeWorker.featureId &&
    input.featureId !== state.activeWorker.featureId
  ) {
    throw new MissionKernelError(
      "STALE_WORKER_RUN",
      `Active worker is assigned to ${state.activeWorker.featureId}, not ${input.featureId}`
    );
  }

  const targetFeatureId = input.featureId || state.activeWorker.featureId;

  const handoff = input.handoff || {};
  const whatWasImplemented = String(handoff.whatWasImplemented || "").trim();
  if (whatWasImplemented.length < 50) {
    throw new MissionKernelError(
      "INVALID_HANDOFF_IMPLEMENTATION_SUMMARY",
      `handoff.whatWasImplemented must be at least 50 characters (got ${whatWasImplemented.length})`
    );
  }

  const successState = input.successState || "success";
  if (successState === "success" && input.validatorsPassed !== true) {
    throw new MissionKernelError(
      "VALIDATORS_NOT_PASSED",
      "When successState is 'success', validatorsPassed must be true"
    );
  }

  const featureIdx = featuresDoc.features.findIndex(
    (f) => f.id === targetFeatureId
  );
  if (featureIdx === -1) {
    throw new MissionKernelError(
      "FEATURE_NOT_FOUND",
      `Feature ${targetFeatureId} not found in features.json`
    );
  }

  const feature = featuresDoc.features[featureIdx];
  const nowIso = new Date().toISOString();

  const assertionResults =
    input.assertionResults || handoff.assertionResults || {};
  const hasFailedAssertions = Object.values(assertionResults).some(
    (v) => v === "failed" || v?.status === "failed"
  );

  feature.lastHandoff = {
    ...handoff,
    whatWasImplemented,
    successState,
    validatorsPassed: Boolean(input.validatorsPassed) && !hasFailedAssertions,
    completedAt: nowIso,
  };

  if (
    Object.keys(assertionResults).length > 0 ||
    isValidatorFeature(feature)
  ) {
    const fulfilledIds = new Set(feature.fulfills || []);
    const isVal = isValidatorFeature(feature);
    state.assertions = (state.assertions || []).map((assertion) => {
      const rawVal = assertionResults[assertion.id];
      const explicitStatus =
        typeof rawVal === "string" ? rawVal : rawVal?.status;
      if (explicitStatus && ASSERTION_STATUSES.includes(explicitStatus)) {
        return {
          ...assertion,
          status: explicitStatus,
        };
      }
      if (
        successState === "success" &&
        isVal &&
        assertion.status !== "failed" &&
        (fulfilledIds.has(assertion.id) ||
          (fulfilledIds.size === 0 &&
            assertion.milestoneId === feature.milestoneId))
      ) {
        return {
          ...assertion,
          status: "passed",
        };
      }
      return assertion;
    });
  }

  if (successState === "success") {
    feature.status = "completed";
  } else {
    feature.status = "pending";
  }

  featuresDoc.features[featureIdx] = normalizeFeature(feature, featureIdx);

  const discoveredIssues = Array.isArray(handoff.discoveredIssues)
    ? handoff.discoveredIssues
    : [];
  const nonInteractiveChecks = Array.isArray(handoff.nonInteractiveChecks)
    ? handoff.nonInteractiveChecks
    : Array.isArray(input.nonInteractiveChecks)
      ? input.nonInteractiveChecks
      : [];
  const hasDiscoveredIssues = discoveredIssues.length > 0;
  const hasNonInteractiveChecks = nonInteractiveChecks.length > 0;
  const hasLeftUndone = isNonEmptyLeftUndone(handoff.whatWasLeftUndone);

  const pendingItems = [];
  discoveredIssues.forEach((iss, idx) => {
    const id =
      (iss && typeof iss === "object" && iss.id) ||
      `${feature.id}:discovered_issue:${idx}`;
    const summary = String(
      typeof iss === "string"
        ? iss
        : iss?.summary ||
            iss?.description ||
            iss?.title ||
            (iss?.id
              ? `${iss.id} ${iss.description || ""}`
              : JSON.stringify(iss))
    ).trim();
    pendingItems.push({
      id,
      type: "discovered_issue",
      sourceFeatureId: feature.id,
      summary,
    });
  });

  nonInteractiveChecks.forEach((chk, idx) => {
    const id =
      (chk && typeof chk === "object" && chk.id) ||
      `${feature.id}:non_interactive_check:${idx}`;
    const summary = String(
      typeof chk === "string"
        ? chk
        : chk?.summary || chk?.description || chk?.title || JSON.stringify(chk)
    ).trim();
    pendingItems.push({
      id,
      type: "non_interactive_check",
      sourceFeatureId: feature.id,
      summary,
    });
  });

  if (
    hasFailedAssertions ||
    (isValidatorFeature(feature) && input.validatorsPassed === false)
  ) {
    pendingItems.push({
      id: `${feature.id}:validator_failure`,
      type: "validator_failure",
      sourceFeatureId: feature.id,
      summary: "Validator or assertion failure",
    });
  }

  if (hasLeftUndone && pendingItems.length === 0) {
    pendingItems.push({
      id: `${feature.id}:incomplete_work`,
      type: "incomplete_work",
      sourceFeatureId: feature.id,
      summary: String(handoff.whatWasLeftUndone).trim(),
    });
  }

  if (!Array.isArray(state.pendingHandoffItems)) {
    state.pendingHandoffItems = [];
  }
  for (const item of pendingItems) {
    const existingIdx = state.pendingHandoffItems.findIndex(
      (p) => p.id === item.id
    );
    if (existingIdx !== -1) {
      state.pendingHandoffItems[existingIdx] = item;
    } else {
      state.pendingHandoffItems.push(item);
    }
  }

  const hasAttentionItems =
    hasDiscoveredIssues ||
    hasNonInteractiveChecks ||
    hasLeftUndone ||
    hasFailedAssertions ||
    state.pendingHandoffItems.length > 0;

  const shouldReturnToOrchestrator =
    successState !== "success" ||
    input.returnToOrchestrator === true ||
    hasAttentionItems;

  const completedWorker = state.activeWorker;
  const workerNumber = completedWorker.workerNumber ?? 1;

  if (Array.isArray(state.sessions)) {
    state.sessions = state.sessions.map((s) =>
      s.runId === completedWorker.runId
        ? {
            ...s,
            status:
              successState === "success" && !hasFailedAssertions
                ? "completed"
                : "failed",
            endedAt: nowIso,
            handoff: feature.lastHandoff,
            lastHandoff: feature.lastHandoff,
          }
        : s
    );
  }

  state.activeWorker = null;
  state.lastHandoffAt = nowIso;
  state.lastHandoffSummary = whatWasImplemented;
  state.revision = (state.revision || 1) + 1;
  state.lastHandoffNeedsAttention = state.pendingHandoffItems.length > 0;

  if (shouldReturnToOrchestrator) {
    state.status = "orchestrator_turn";
  }

  saveState(missionDir, state);
  saveFeaturesDoc(missionDir, {
    ...featuresDoc,
    updatedAt: nowIso,
  });

  appendProgressLog(missionDir, {
    timestamp: nowIso,
    type: "feature_run_ended",
    message: `Worker #${workerNumber} ended ${feature.id} (${successState})`,
    featureId: feature.id,
    workerNumber,
  });

  if (successState === "success") {
    checkMilestoneCompletionAndInjectValidation(missionDir);
  }

  return {
    shouldReturnToOrchestrator,
    feature: featuresDoc.features[featureIdx],
    state: loadState(missionDir),
  };
}
