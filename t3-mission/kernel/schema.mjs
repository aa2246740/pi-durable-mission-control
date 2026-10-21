import crypto from "node:crypto";

export const MISSION_STATUSES = [
  "planning",
  "initializing",
  "awaiting_input",
  "running",
  "orchestrator_turn",
  "paused",
  "completed",
];

export const FEATURE_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
];

export const FEATURE_KINDS = [
  "implementation",
  "scrutiny",
  "user_testing",
  "repair",
  "explorer",
];

export const DISMISSAL_TYPES = [
  "discovered_issue",
  "critical_context",
  "incomplete_work",
  "non_interactive_check",
  "validator_failure",
];

export const ASSERTION_STATUSES = ["pending", "passed", "failed"];

export const EFFORT_LEVEL_TO_REASONING = {
  1: "minimal",
  2: "low",
  3: "medium",
  4: "high",
  5: "max",
};

export const REASONING_TO_EFFORT_LEVEL = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 5,
};

export const DEFAULT_MODEL_SETTINGS = {
  orchestrator: {
    providerInstanceId: "antigravity",
    model: "gemini-4-argon-high",
    options: {},
  },
  worker: {
    providerInstanceId: "antigravity",
    model: "gemini-4-argon-high",
    options: {},
  },
  validator: {
    providerInstanceId: "codex",
    model: "gpt-6.1-sol",
    options: { reasoningEffort: "high" },
  },
  skipScrutiny: false,
  skipUserTesting: false,
};

export class MissionKernelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MissionKernelError";
    this.code = code;
    this.details = details;
    if (details && typeof details === "object" && details.reasonCode) {
      this.reasonCode = details.reasonCode;
    } else if (code === "PLAN_ACCEPTANCE_REQUIRED") {
      this.reasonCode = "PLAN_NOT_ACCEPTED";
    } else if (code === "HANDOFF_ATTENTION_REQUIRED") {
      this.reasonCode = "HANDOFF_GATE_BLOCKED";
    }
  }
}

export function createMissionId() {
  return `mission-${crypto.randomUUID().slice(0, 8)}`;
}

export function createRunId() {
  return `run-${crypto.randomUUID().slice(0, 8)}`;
}

function parseEffortLevel(rawEffort) {
  if (typeof rawEffort === "number" && Number.isFinite(rawEffort)) {
    return Math.max(1, Math.min(5, Math.round(rawEffort)));
  }
  if (typeof rawEffort === "string" && rawEffort.trim()) {
    const trimmed = rawEffort.trim().toLowerCase();
    const num = Number(trimmed);
    if (Number.isFinite(num) && num >= 1 && num <= 5) {
      return Math.round(num);
    }
    if (REASONING_TO_EFFORT_LEVEL[trimmed]) {
      return REASONING_TO_EFFORT_LEVEL[trimmed];
    }
  }
  return null;
}

function doesSlotSupportEffort(providerInstanceId, model, safeRaw = {}, safeBase = {}) {
  if (safeRaw.supportsEffort === false) return false;
  if (safeRaw.supportsEffort === true) return true;
  if (
    safeRaw.supportsEffort === undefined &&
    safeBase.supportsEffort === false &&
    (!safeRaw.model || safeRaw.model === safeBase.model)
  ) {
    return false;
  }
  if (String(providerInstanceId || "").trim().toLowerCase() === "antigravity") {
    return false;
  }
  if (/-(low|medium|high)$/i.test(String(model || "").trim())) {
    return false;
  }
  return true;
}

export function normalizeSlotConfig(raw = {}, base = {}) {
  const safeRaw =
    typeof raw === "string" && raw.trim()
      ? { model: raw.trim() }
      : raw && typeof raw === "object"
        ? raw
        : {};
  const safeBase = base && typeof base === "object" ? base : {};

  const providerInstanceId =
    safeRaw.providerInstanceId ??
    safeBase.providerInstanceId ??
    "antigravity";
  const model = safeRaw.model ?? safeBase.model ?? "gemini-4-argon-high";

  const baseOptions =
    safeBase.options && typeof safeBase.options === "object"
      ? { ...safeBase.options }
      : {};
  const rawOptions =
    safeRaw.options && typeof safeRaw.options === "object"
      ? { ...safeRaw.options }
      : {};

  const options = {
    ...baseOptions,
    ...rawOptions,
  };

  if (!doesSlotSupportEffort(providerInstanceId, model, safeRaw, safeBase)) {
    delete options.effort;
    delete options.reasoningEffort;
    delete options.reasoning_effort;
    delete options.thinking;
    return {
      providerInstanceId,
      model,
      options,
    };
  }

  const rawEffortVal = safeRaw.effort ?? rawOptions.effort;
  const rawReasoningVal =
    safeRaw.reasoningEffort ?? rawOptions.reasoningEffort;

  const parsedLevel = parseEffortLevel(rawEffortVal);
  if (parsedLevel !== null) {
    const mappedReasoning = EFFORT_LEVEL_TO_REASONING[parsedLevel];
    const normRawReasoning =
      typeof rawReasoningVal === "string" && rawReasoningVal.trim()
        ? rawReasoningVal.trim().toLowerCase()
        : null;
    const rawReasoningLevel = normRawReasoning
      ? REASONING_TO_EFFORT_LEVEL[normRawReasoning] ?? null
      : null;

    options.effort = parsedLevel;
    if (normRawReasoning && rawReasoningLevel === parsedLevel) {
      options.reasoningEffort = normRawReasoning;
    } else {
      options.reasoningEffort = mappedReasoning;
    }
  } else if (
    typeof rawReasoningVal === "string" &&
    rawReasoningVal.trim() !== ""
  ) {
    const normRawReasoning = rawReasoningVal.trim().toLowerCase();
    options.reasoningEffort = normRawReasoning;
    if (
      options.effort !== undefined &&
      REASONING_TO_EFFORT_LEVEL[normRawReasoning]
    ) {
      options.effort = REASONING_TO_EFFORT_LEVEL[normRawReasoning];
    }
  }

  return {
    providerInstanceId,
    model,
    options,
  };
}

export function normalizeModelSettings(
  partial = {},
  base = DEFAULT_MODEL_SETTINGS
) {
  const source =
    partial?.slots && typeof partial.slots === "object"
      ? { ...partial, ...partial.slots }
      : partial || {};
  const baseSource =
    base?.slots && typeof base.slots === "object"
      ? { ...base, ...base.slots }
      : base || DEFAULT_MODEL_SETTINGS;

  return {
    orchestrator: normalizeSlotConfig(
      source.orchestrator,
      baseSource.orchestrator || DEFAULT_MODEL_SETTINGS.orchestrator
    ),
    worker: normalizeSlotConfig(
      source.worker,
      baseSource.worker || DEFAULT_MODEL_SETTINGS.worker
    ),
    validator: normalizeSlotConfig(
      source.validator,
      baseSource.validator || DEFAULT_MODEL_SETTINGS.validator
    ),
    skipScrutiny:
      typeof source.skipScrutiny === "boolean"
        ? source.skipScrutiny
        : Boolean(baseSource.skipScrutiny),
    skipUserTesting:
      typeof source.skipUserTesting === "boolean"
        ? source.skipUserTesting
        : Boolean(baseSource.skipUserTesting),
  };
}

export function normalizeMilestone(milestone, index = 0) {
  if (!milestone || typeof milestone !== "object") {
    throw new MissionKernelError(
      "INVALID_MILESTONE",
      `Invalid milestone at index ${index}`
    );
  }
  const id = String(milestone.id || `m${index + 1}`).trim();
  const title = String(milestone.title || `Milestone ${index + 1}`).trim();
  const ordinal =
    typeof milestone.ordinal === "number" ? milestone.ordinal : index + 1;
  return {
    ...milestone,
    id,
    title,
    ordinal,
  };
}

export function inferFeatureKind(feature) {
  if (feature.kind === "user-testing") {
    return "user_testing";
  }
  if (feature.kind && FEATURE_KINDS.includes(feature.kind)) {
    return feature.kind;
  }
  const skill = String(feature.skillName || "").toLowerCase();
  const id = String(feature.id || "").toLowerCase();
  if (skill.includes("scrutiny") || id.startsWith("scrutiny-validator")) {
    return "scrutiny";
  }
  if (
    skill.includes("user-testing") ||
    skill.includes("user_testing") ||
    id.startsWith("user-testing-validator")
  ) {
    return "user_testing";
  }
  if (skill.includes("repair")) {
    return "repair";
  }
  if (skill.includes("explorer") || id.startsWith("explorer-")) {
    return "explorer";
  }
  return "implementation";
}

export function normalizeFeature(feature, index = 0) {
  if (!feature || typeof feature !== "object") {
    throw new MissionKernelError(
      "INVALID_FEATURE",
      `Invalid feature at index ${index}`
    );
  }
  const id = String(feature.id || `f${index + 1}`).trim();
  const milestoneId = String(feature.milestoneId || "m1").trim();
  const title = String(feature.title || id).trim();
  const description = String(feature.description || "").trim();
  const kind = inferFeatureKind(feature);
  let defaultSkill = "worker-implementation";
  if (kind === "scrutiny") {
    defaultSkill = `scrutiny-validator-${milestoneId}`;
  } else if (kind === "user_testing") {
    defaultSkill = `user-testing-validator-${milestoneId}`;
  }
  const skillName = String(feature.skillName || defaultSkill).trim();
  const fulfills = Array.isArray(feature.fulfills)
    ? feature.fulfills.map((x) => String(x))
    : [];
  const status = FEATURE_STATUSES.includes(feature.status)
    ? feature.status
    : "pending";
  const attempts =
    typeof feature.attempts === "number" && feature.attempts >= 0
      ? feature.attempts
      : 0;
  const maxAttempts =
    typeof feature.maxAttempts === "number" && feature.maxAttempts > 0
      ? feature.maxAttempts
      : 5;
  const lastHandoff = feature.lastHandoff ?? null;

  return {
    ...feature,
    id,
    milestoneId,
    title,
    description,
    kind,
    skillName,
    fulfills,
    status,
    attempts,
    maxAttempts,
    lastHandoff,
  };
}

export function normalizeAssertion(assertion, index = 0) {
  if (!assertion || typeof assertion !== "object") {
    throw new MissionKernelError(
      "INVALID_ASSERTION",
      `Invalid assertion at index ${index}`
    );
  }
  const id = String(
    assertion.id || `VAL-${String(index + 1).padStart(3, "0")}`
  ).trim();
  const description = String(assertion.description || "").trim();
  const milestoneId = String(assertion.milestoneId || "m1").trim();
  const status = ASSERTION_STATUSES.includes(assertion.status)
    ? assertion.status
    : "pending";
  const stageResults =
    assertion.stageResults && typeof assertion.stageResults === "object"
      ? { ...assertion.stageResults }
      : undefined;

  return {
    ...assertion,
    id,
    description,
    milestoneId,
    status,
    ...(stageResults ? { stageResults } : {}),
  };
}

export function createInitialState(input = {}, existingState = null) {
  const milestones = Array.isArray(input.milestones)
    ? input.milestones.map((m, i) => normalizeMilestone(m, i))
    : existingState?.milestones ?? [];
  const assertions = Array.isArray(input.assertions)
    ? input.assertions.map((a, i) => normalizeAssertion(a, i))
    : existingState?.assertions ?? [];

  return {
    missionId: input.missionId || existingState?.missionId || createMissionId(),
    title: String(input.title || existingState?.title || "Untitled Mission"),
    repoPath: String(input.repoPath || existingState?.repoPath || process.cwd()),
    status: input.status || "awaiting_input",
    revision:
      typeof existingState?.revision === "number"
        ? existingState.revision + 1
        : 1,
    elapsedMs:
      typeof existingState?.elapsedMs === "number" ? existingState.elapsedMs : 0,
    lastStartedAt: null,
    planAccepted: Boolean(input.planAccepted ?? false),
    milestones,
    assertions,
    activeWorker: existingState?.activeWorker ?? null,
    sessions: Array.isArray(existingState?.sessions)
      ? existingState.sessions
      : [],
    pendingHandoffItems: Array.isArray(input.pendingHandoffItems)
      ? input.pendingHandoffItems
      : [],
    lastHandoffNeedsAttention: false,
    lastHandoffSummary: null,
    lastHandoffAt: null,
    milestoneValidationTriggered:
      existingState?.milestoneValidationTriggered &&
      typeof existingState.milestoneValidationTriggered === "object"
        ? { ...existingState.milestoneValidationTriggered }
        : {},
  };
}

export function validateDismissals(dismissals) {
  if (!Array.isArray(dismissals) || dismissals.length === 0) {
    throw new MissionKernelError(
      "INVALID_DISMISSALS",
      "Dismissals must be a non-empty array"
    );
  }
  return dismissals.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new MissionKernelError(
        "INVALID_DISMISSAL_ITEM",
        `Dismissal at index ${idx} must be an object`
      );
    }
    if (!DISMISSAL_TYPES.includes(item.type)) {
      throw new MissionKernelError(
        "INVALID_DISMISSAL_TYPE",
        `Dismissal at index ${idx} has invalid type "${item.type}". Expected one of: ${DISMISSAL_TYPES.join(", ")}`
      );
    }
    const sourceFeatureId = String(item.sourceFeatureId || "").trim();
    if (!sourceFeatureId) {
      throw new MissionKernelError(
        "INVALID_DISMISSAL_SOURCE",
        `Dismissal at index ${idx} requires sourceFeatureId`
      );
    }
    const itemId =
      typeof item.itemId === "string" && item.itemId.trim()
        ? item.itemId.trim()
        : undefined;
    const summary = String(item.summary || item.itemId || "").trim();
    if (!summary) {
      throw new MissionKernelError(
        "INVALID_DISMISSAL_SUMMARY",
        `Dismissal at index ${idx} requires summary`
      );
    }
    const justification = String(
      item.justification ?? item.reason ?? ""
    ).trim();
    if (justification.length < 20) {
      throw new MissionKernelError(
        "INVALID_JUSTIFICATION",
        `Dismissal justification at index ${idx} must be at least 20 characters (got ${justification.length})`
      );
    }
    const normalized = {
      type: item.type,
      sourceFeatureId,
      summary,
      justification,
    };
    if (itemId) {
      normalized.itemId = itemId;
    }
    return normalized;
  });
}

export function isNonEmptyLeftUndone(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (
    lower === "none" ||
    lower === "n/a" ||
    lower === "nil" ||
    trimmed === "无" ||
    trimmed === "没有"
  ) {
    return false;
  }
  return true;
}

export function isValidatorFeature(feature) {
  if (!feature) return false;
  const kind = inferFeatureKind(feature);
  return (
    kind === "scrutiny" ||
    kind === "user_testing" ||
    feature.kind === "user-testing"
  );
}
