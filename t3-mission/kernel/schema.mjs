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
  "cancelled",
];

export const FEATURE_KINDS = [
  "implementation",
  "scrutiny",
  "user_testing",
  "repair",
];

export const DISMISSAL_TYPES = [
  "discovered_issue",
  "critical_context",
  "incomplete_work",
];

export const ASSERTION_STATUSES = ["pending", "passed", "failed"];

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
  }
}

export function createMissionId() {
  return `mission-${crypto.randomUUID().slice(0, 8)}`;
}

export function createRunId() {
  return `run-${crypto.randomUUID().slice(0, 8)}`;
}

export function normalizeModelSettings(partial = {}, base = DEFAULT_MODEL_SETTINGS) {
  return {
    orchestrator: {
      providerInstanceId:
        partial?.orchestrator?.providerInstanceId ??
        base.orchestrator.providerInstanceId,
      model: partial?.orchestrator?.model ?? base.orchestrator.model,
      options: {
        ...(base.orchestrator.options || {}),
        ...(partial?.orchestrator?.options || {}),
      },
    },
    worker: {
      providerInstanceId:
        partial?.worker?.providerInstanceId ?? base.worker.providerInstanceId,
      model: partial?.worker?.model ?? base.worker.model,
      options: {
        ...(base.worker.options || {}),
        ...(partial?.worker?.options || {}),
      },
    },
    validator: {
      providerInstanceId:
        partial?.validator?.providerInstanceId ??
        base.validator.providerInstanceId,
      model: partial?.validator?.model ?? base.validator.model,
      options: {
        ...(base.validator.options || {}),
        ...(partial?.validator?.options || {}),
      },
    },
    skipScrutiny:
      typeof partial?.skipScrutiny === "boolean"
        ? partial.skipScrutiny
        : Boolean(base.skipScrutiny),
    skipUserTesting:
      typeof partial?.skipUserTesting === "boolean"
        ? partial.skipUserTesting
        : Boolean(base.skipUserTesting),
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
  if (feature.kind && FEATURE_KINDS.includes(feature.kind)) {
    return feature.kind;
  }
  const skill = String(feature.skillName || "").toLowerCase();
  const id = String(feature.id || "").toLowerCase();
  if (skill.includes("scrutiny") || id.startsWith("scrutiny-validator")) {
    return "scrutiny";
  }
  if (skill.includes("user-testing") || id.startsWith("user-testing-validator")) {
    return "user_testing";
  }
  if (skill.includes("repair")) {
    return "repair";
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

  return {
    ...assertion,
    id,
    description,
    milestoneId,
    status,
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
    const summary = String(item.summary || "").trim();
    if (!summary) {
      throw new MissionKernelError(
        "INVALID_DISMISSAL_SUMMARY",
        `Dismissal at index ${idx} requires summary`
      );
    }
    const justification = String(item.justification || "").trim();
    if (justification.length < 20) {
      throw new MissionKernelError(
        "INVALID_JUSTIFICATION",
        `Dismissal justification at index ${idx} must be at least 20 characters (got ${justification.length})`
      );
    }
    return {
      type: item.type,
      sourceFeatureId,
      summary,
      justification,
    };
  });
}

export function isNonEmptyLeftUndone(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (lower === "none" || lower === "n/a" || lower === "nil" || trimmed === "无" || trimmed === "没有") {
    return false;
  }
  return true;
}

export function isValidatorFeature(feature) {
  if (!feature) return false;
  const kind = inferFeatureKind(feature);
  return kind === "scrutiny" || kind === "user_testing";
}
