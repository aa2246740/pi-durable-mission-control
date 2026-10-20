import fs from "node:fs";
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
  const mutatedFeatureIds = new Set();
  const addedFeatureSourceIds = new Set();
  const resolvedHandoffItemIds = new Set();

  if (Array.isArray(replacementFeatures)) {
    const prevNormalizedFeatures = featuresDoc.features.map((f, i) =>
      normalizeFeature(f, i)
    );
    const prevById = new Map(prevNormalizedFeatures.map((f) => [f.id, f]));

    const nextNormalizedFeatures = [];
    const nextIds = new Set();
    for (let i = 0; i < replacementFeatures.length; i += 1) {
      const rawF = replacementFeatures[i];
      const normF = normalizeFeature(rawF, i);
      nextNormalizedFeatures.push(normF);
      nextIds.add(normF.id);
      if (Array.isArray(rawF?.resolvesHandoffItemIds)) {
        for (const itemId of rawF.resolvesHandoffItemIds) {
          resolvedHandoffItemIds.add(String(itemId));
        }
      }
      if (!prevById.has(normF.id)) {
        addedCount += 1;
        if (rawF?.sourceFeatureId) {
          addedFeatureSourceIds.add(String(rawF.sourceFeatureId));
        }
      } else {
        const prevF = prevById.get(normF.id);
        if (JSON.stringify(prevF) !== JSON.stringify(normF)) {
          updatedCount += 1;
          mutatedFeatureIds.add(normF.id);
        }
      }
    }
    for (const prevF of prevNormalizedFeatures) {
      if (!nextIds.has(prevF.id)) {
        updatedCount += 1;
        mutatedFeatureIds.add(prevF.id);
      }
    }
    features = nextNormalizedFeatures;
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
      const beforeNormalized = normalizeFeature(features[idx], idx);
      const afterNormalized = normalizeFeature(
        { ...features[idx], ...patch },
        idx
      );
      const changed =
        JSON.stringify(beforeNormalized) !== JSON.stringify(afterNormalized);
      features[idx] = afterNormalized;
      if (changed) {
        updatedCount += 1;
        mutatedFeatureIds.add(afterNormalized.id);
      }
      if (Array.isArray(patch.resolvesHandoffItemIds)) {
        for (const itemId of patch.resolvesHandoffItemIds) {
          resolvedHandoffItemIds.add(String(itemId));
        }
      }
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
        mutatedFeatureIds.add(featureId);
      }
    }
  }

  if (Array.isArray(addFeatures) && addFeatures.length > 0) {
    for (const rawFeature of addFeatures) {
      const normalized = normalizeFeature(rawFeature, features.length);
      if (Array.isArray(rawFeature?.resolvesHandoffItemIds)) {
        for (const itemId of rawFeature.resolvesHandoffItemIds) {
          resolvedHandoffItemIds.add(String(itemId));
        }
      }
      if (rawFeature?.sourceFeatureId) {
        addedFeatureSourceIds.add(String(rawFeature.sourceFeatureId));
      }
      const existingIdx = features.findIndex((f) => f.id === normalized.id);
      if (existingIdx !== -1) {
        const beforeNormalized = normalizeFeature(
          features[existingIdx],
          existingIdx
        );
        const afterNormalized = normalizeFeature(
          { ...features[existingIdx], ...normalized },
          existingIdx
        );
        features[existingIdx] = afterNormalized;
        if (
          JSON.stringify(beforeNormalized) !== JSON.stringify(afterNormalized)
        ) {
          updatedCount += 1;
          mutatedFeatureIds.add(afterNormalized.id);
        }
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
        const beforeA = normalizeAssertion(assertions[idx], idx);
        const afterA = normalizeAssertion(
          { ...assertions[idx], ...patch },
          idx
        );
        assertions[idx] = afterA;
        if (JSON.stringify(beforeA) !== JSON.stringify(afterA)) {
          updatedCount += 1;
        }
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

  if (
    Array.isArray(state.pendingHandoffItems) &&
    state.pendingHandoffItems.length > 0
  ) {
    if (addedCount > 0) {
      if (resolvedHandoffItemIds.size > 0 || addedFeatureSourceIds.size > 0) {
        state.pendingHandoffItems = state.pendingHandoffItems.filter(
          (item) =>
            !resolvedHandoffItemIds.has(item.id) &&
            !addedFeatureSourceIds.has(item.sourceFeatureId) &&
            !mutatedFeatureIds.has(item.sourceFeatureId)
        );
      } else {
        state.pendingHandoffItems = [];
      }
      state.lastHandoffNeedsAttention = state.pendingHandoffItems.length > 0;
    } else if (
      mutatedFeatureIds.size > 0 ||
      resolvedHandoffItemIds.size > 0
    ) {
      state.pendingHandoffItems = state.pendingHandoffItems.filter(
        (item) =>
          !mutatedFeatureIds.has(item.sourceFeatureId) &&
          !resolvedHandoffItemIds.has(item.id)
      );
      state.lastHandoffNeedsAttention = state.pendingHandoffItems.length > 0;
    }
  } else if (
    addedCount > 0 ||
    mutatedFeatureIds.size > 0 ||
    resolvedHandoffItemIds.size > 0
  ) {
    state.lastHandoffNeedsAttention = false;
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
  const runId = typeof input?.runId === "string" ? input.runId.trim() : "";
  const featureId =
    typeof input?.featureId === "string" ? input.featureId.trim() : "";
  if (!runId || !featureId) {
    throw new MissionKernelError(
      "MISSING_RUN_IDENTITY",
      "EndFeatureRun requires both runId and featureId"
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

  if (runId !== state.activeWorker.runId) {
    throw new MissionKernelError(
      "STALE_WORKER_RUN",
      `Worker runId mismatch: expected ${state.activeWorker.runId}, got ${runId}`
    );
  }

  if (featureId !== state.activeWorker.featureId) {
    throw new MissionKernelError(
      "STALE_WORKER_RUN",
      `Active worker is assigned to ${state.activeWorker.featureId}, not ${featureId}`
    );
  }

  const targetFeatureId = featureId;

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
  const isVal = isValidatorFeature(feature);
  const milestoneAssertions = (state.assertions || []).filter(
    (a) => a.milestoneId === feature.milestoneId
  );

  const rawAssertionResults =
    input.assertionResults || handoff.assertionResults;
  const assertionResults =
    rawAssertionResults && typeof rawAssertionResults === "object"
      ? rawAssertionResults
      : {};

  let hasMissingValidatorAssertions = false;
  if (isVal && milestoneAssertions.length > 0) {
    for (const mAssertion of milestoneAssertions) {
      const rawVal = assertionResults[mAssertion.id];
      const explicitStatus =
        typeof rawVal === "string" ? rawVal : rawVal?.status;
      if (explicitStatus !== "passed" && explicitStatus !== "failed") {
        hasMissingValidatorAssertions = true;
      }
    }
  }

  const hasFailedAssertions = Object.values(assertionResults).some(
    (v) => v === "failed" || v?.status === "failed"
  );

  feature.lastHandoff = {
    ...handoff,
    runId: state.activeWorker.runId,
    whatWasImplemented,
    successState,
    validatorsPassed:
      Boolean(input.validatorsPassed) &&
      !hasFailedAssertions &&
      !hasMissingValidatorAssertions,
    completedAt: nowIso,
  };

  if (Object.keys(assertionResults).length > 0 || isVal) {
    const stageKey =
      inferFeatureKind(feature) === "scrutiny" ? "scrutiny" : "user_testing";
    state.assertions = (state.assertions || []).map((assertion) => {
      const rawVal = assertionResults[assertion.id];
      const explicitStatus =
        typeof rawVal === "string" ? rawVal : rawVal?.status;
      if (
        explicitStatus &&
        ASSERTION_STATUSES.includes(explicitStatus) &&
        explicitStatus !== "pending"
      ) {
        const stageResults = {
          ...(assertion.stageResults &&
          typeof assertion.stageResults === "object"
            ? assertion.stageResults
            : {}),
        };
        if (isVal) {
          stageResults[stageKey] = explicitStatus;
        }
        const anyStageFailed = Object.values(stageResults).includes("failed");
        const nextStatus =
          explicitStatus === "failed" || anyStageFailed
            ? "failed"
            : explicitStatus;
        return {
          ...assertion,
          status: nextStatus,
          ...(Object.keys(stageResults).length > 0 ? { stageResults } : {}),
        };
      }
      return assertion;
    });
  }

  const validatorFailed =
    isVal &&
    (hasFailedAssertions ||
      hasMissingValidatorAssertions ||
      input.validatorsPassed === false);

  if (successState === "success") {
    feature.status = validatorFailed ? "failed" : "completed";
  } else {
    feature.status = "pending";
  }

  if (feature.daemonStatus || state.activeWorker?.daemonStatus) {
    feature.daemonStatus = "stopped";
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

  if (hasMissingValidatorAssertions) {
    pendingItems.push({
      id: `${feature.id}:missing_assertion_results`,
      type: "validator_failure",
      sourceFeatureId: feature.id,
      summary: `Validator ${feature.id} omitted required assertionResults for milestone ${feature.milestoneId}`,
    });
  }

  if (
    hasFailedAssertions ||
    (isVal && input.validatorsPassed === false)
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
    hasMissingValidatorAssertions ||
    state.pendingHandoffItems.length > 0;

  const shouldReturnToOrchestrator =
    successState !== "success" ||
    input.returnToOrchestrator === true ||
    hasAttentionItems;

  const completedWorker = state.activeWorker;
  const workerNumber = completedWorker.workerNumber ?? 1;

  const workerPidToTerminate =
    completedWorker?.workerPid ?? feature?.workerPid;
  if (
    workerPidToTerminate &&
    typeof workerPidToTerminate === "number" &&
    workerPidToTerminate > 0 &&
    workerPidToTerminate !== process.pid
  ) {
    try {
      process.kill(workerPidToTerminate, "SIGTERM");
    } catch {
      // Ignore if process already exited
    }
  }
  const daemonStateFileToRemove =
    completedWorker?.daemonStateFile ?? feature?.daemonStateFile;
  if (
    daemonStateFileToRemove &&
    typeof daemonStateFileToRemove === "string"
  ) {
    try {
      if (fs.existsSync(daemonStateFileToRemove)) {
        fs.unlinkSync(daemonStateFileToRemove);
      }
    } catch {
      // Ignore if file already removed
    }
  }

  if (Array.isArray(state.sessions)) {
    state.sessions = state.sessions.map((s) =>
      s.runId === completedWorker.runId
        ? {
            ...s,
            status:
              successState === "success" &&
              !hasFailedAssertions &&
              !hasMissingValidatorAssertions
                ? "completed"
                : "failed",
            ...(s.daemonStatus || completedWorker?.daemonStatus
              ? { daemonStatus: "stopped" }
              : {}),
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

  if (!shouldReturnToOrchestrator) {
    const postState = loadState(missionDir);
    const postFeaturesDoc = loadFeaturesDoc(missionDir);
    if (
      postFeaturesDoc.features.length > 0 &&
      postFeaturesDoc.features.every(
        (f) => f.status === "completed" || f.status === "cancelled"
      ) &&
      !postState.activeWorker &&
      !postState.lastHandoffNeedsAttention
    ) {
      const hasValidatorFeatures = postFeaturesDoc.features.some((f) =>
        isValidatorFeature(f)
      );
      const hasFailedValidator = postFeaturesDoc.features.some(
        (f) => isValidatorFeature(f) && f.status === "failed"
      );
      const hasFailedAssertion = (postState.assertions || []).some(
        (a) =>
          a.status === "failed" ||
          (hasValidatorFeatures && a.status !== "passed")
      );
      if (
        !hasFailedAssertion &&
        !hasFailedValidator &&
        postState.status !== "completed"
      ) {
        const finishIso = new Date().toISOString();
        if (postState.lastStartedAt) {
          const startedMs = Date.parse(postState.lastStartedAt);
          const endMs = Date.parse(finishIso);
          if (!Number.isNaN(startedMs) && endMs > startedMs) {
            postState.elapsedMs =
              (postState.elapsedMs || 0) + (endMs - startedMs);
          }
        }
        postState.lastStartedAt = null;
        postState.status = "completed";
        postState.revision = (postState.revision || 1) + 1;
        saveState(missionDir, postState);

        appendProgressLog(missionDir, {
          timestamp: finishIso,
          type: "mission_completed",
          message: "Mission completed",
          featureId: null,
          workerNumber: null,
        });
      }
    }
  }

  return {
    shouldReturnToOrchestrator,
    feature: featuresDoc.features[featureIdx],
    state: loadState(missionDir),
  };
}
