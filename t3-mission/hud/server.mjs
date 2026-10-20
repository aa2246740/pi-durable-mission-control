import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

export const BUILTIN_MODEL_CATALOG = [
  {
    id: "claude-opus-5-5",
    model: "claude-opus-5-5",
    label: "Claude Code · Opus 5.5",
    displayName: "Claude Code · Opus 5.5 (claude-opus-5-5)",
    providerInstanceId: "claude-code",
    effort: 5,
    reasoningEffort: "max",
    slots: ["orchestrator", "worker", "validator"],
  },
  {
    id: "gemini-4-argon-high",
    model: "gemini-4-argon-high",
    label: "Gemini 4 Argon (High)",
    displayName: "Gemini 4 Argon (High)",
    providerInstanceId: "antigravity",
    effort: 4,
    reasoningEffort: "high",
    slots: ["orchestrator", "worker", "validator"],
  },
  {
    id: "gpt-6.1-sol",
    model: "gpt-6.1-sol",
    label: "Codex · GPT-6.1-Sol (Max/High)",
    displayName: "Codex · GPT-6.1-Sol (Max/High)",
    providerInstanceId: "codex",
    effort: 4,
    reasoningEffort: "high",
    slots: ["orchestrator", "worker", "validator"],
  },
  {
    id: "swe-2-max",
    model: "swe-2-max",
    label: "CPA swe-2 Max",
    displayName: "CPA swe-2 Max",
    providerInstanceId: "cpa",
    effort: 5,
    reasoningEffort: "max",
    slots: ["orchestrator", "worker", "validator"],
  },
  {
    id: "grok-4.7",
    model: "grok-4.7",
    label: "CPA grok-4.7",
    displayName: "CPA grok-4.7",
    providerInstanceId: "cpa",
    effort: 3,
    reasoningEffort: "medium",
    slots: ["orchestrator", "worker", "validator"],
  },
  {
    id: "gpt-6-astra-high",
    model: "gpt-6-astra-high",
    label: "GPT-6-Astra (High)",
    displayName: "GPT-6-Astra (High)",
    providerInstanceId: "openai",
    effort: 4,
    reasoningEffort: "high",
    slots: ["orchestrator", "worker", "validator"],
  },
];

const EFFORT_LEVEL_TO_NAME = {
  1: "minimal",
  2: "low",
  3: "medium",
  4: "high",
  5: "max",
};

const EFFORT_NAME_TO_LEVEL = {
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 5,
};

export function effortToReasoningEffort(effort, fallback = "high") {
  const num = Number(effort);
  if (Number.isFinite(num)) {
    const clamped = Math.max(1, Math.min(5, Math.round(num)));
    return EFFORT_LEVEL_TO_NAME[clamped] || fallback;
  }
  if (typeof effort === "string" && effort.trim()) {
    const key = effort.trim().toLowerCase();
    if (EFFORT_NAME_TO_LEVEL[key]) {
      return EFFORT_LEVEL_TO_NAME[EFFORT_NAME_TO_LEVEL[key]] || key;
    }
  }
  return fallback;
}

export const DEFAULT_HUD_MODEL_SETTINGS = {
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

function findCatalogEntry(modelOrLabel) {
  if (!modelOrLabel) return null;
  const needle = String(modelOrLabel).trim().toLowerCase();
  return (
    BUILTIN_MODEL_CATALOG.find(
      (item) =>
        item.id.toLowerCase() === needle ||
        item.model.toLowerCase() === needle ||
        item.label.toLowerCase() === needle ||
        item.displayName.toLowerCase() === needle
    ) || null
  );
}

function normalizeEffortPair(rawEffort, rawReasoningEffort, fallbackLevel = 4) {
  let level = null;
  const hasExplicitEffort =
    (typeof rawEffort === "number" && Number.isFinite(rawEffort)) ||
    (typeof rawEffort === "string" && rawEffort.trim().length > 0);
  const hasExplicitReasoning =
    typeof rawReasoningEffort === "string" && rawReasoningEffort.trim().length > 0;

  if (typeof rawEffort === "number" && Number.isFinite(rawEffort)) {
    level = Math.max(1, Math.min(5, Math.round(rawEffort)));
  } else if (typeof rawEffort === "string" && rawEffort.trim()) {
    const parsed = Number(rawEffort);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 5) {
      level = Math.round(parsed);
    } else if (EFFORT_NAME_TO_LEVEL[rawEffort.trim().toLowerCase()]) {
      level = EFFORT_NAME_TO_LEVEL[rawEffort.trim().toLowerCase()];
    }
  }
  if (level === null && hasExplicitReasoning) {
    const key = rawReasoningEffort.trim().toLowerCase();
    if (EFFORT_NAME_TO_LEVEL[key]) {
      level = EFFORT_NAME_TO_LEVEL[key];
    }
  }
  if (level === null) {
    level = Math.max(1, Math.min(5, fallbackLevel));
  }

  let reasoningEffort;
  if (hasExplicitEffort && !hasExplicitReasoning) {
    reasoningEffort = EFFORT_LEVEL_TO_NAME[level] || "high";
  } else if (hasExplicitReasoning) {
    reasoningEffort = rawReasoningEffort.trim().toLowerCase();
  } else {
    reasoningEffort = EFFORT_LEVEL_TO_NAME[level] || "high";
  }
  return { effort: level, reasoningEffort };
}

function normalizeSlotConfig(rawSlot, fallbackSlot) {
  const base = fallbackSlot || DEFAULT_HUD_MODEL_SETTINGS.orchestrator;
  if (typeof rawSlot === "string") {
    const entry = findCatalogEntry(rawSlot);
    const { effort, reasoningEffort } = normalizeEffortPair(
      entry?.effort,
      entry?.reasoningEffort,
      base.effort || 4
    );
    return {
      providerInstanceId: entry?.providerInstanceId || base.providerInstanceId || "codex",
      model: entry?.model || rawSlot,
      label: entry?.label || rawSlot,
      effort,
      reasoningEffort,
      options: {
        ...(base.options || {}),
        reasoningEffort,
        effort,
      },
    };
  }

  if (!rawSlot || typeof rawSlot !== "object") {
    return structuredClone(base);
  }

  const candidateModel = rawSlot.model || rawSlot.id || rawSlot.label || base.model;
  const entry = findCatalogEntry(candidateModel);

  const explicitEffort =
    rawSlot.effort !== undefined ? rawSlot.effort : rawSlot.options?.effort;
  const explicitReasoning =
    rawSlot.effort !== undefined && rawSlot.reasoningEffort === undefined
      ? undefined
      : rawSlot.reasoningEffort !== undefined
        ? rawSlot.reasoningEffort
        : rawSlot.options?.reasoningEffort !== undefined
          ? rawSlot.options.reasoningEffort
          : entry?.reasoningEffort;

  const { effort, reasoningEffort } = normalizeEffortPair(
    explicitEffort,
    explicitReasoning,
    entry?.effort ?? base.effort ?? 4
  );

  return {
    providerInstanceId:
      rawSlot.providerInstanceId ||
      entry?.providerInstanceId ||
      base.providerInstanceId ||
      "codex",
    model: entry?.model || String(candidateModel),
    label: rawSlot.label || entry?.label || String(candidateModel),
    effort,
    reasoningEffort,
    options: {
      ...(base.options || {}),
      ...(rawSlot.options || {}),
      reasoningEffort,
      effort,
    },
  };
}

export function normalizeHudModelSettings(partial = {}, base = DEFAULT_HUD_MODEL_SETTINGS) {
  return {
    orchestrator: normalizeSlotConfig(partial?.orchestrator, base.orchestrator),
    worker: normalizeSlotConfig(partial?.worker, base.worker),
    validator: normalizeSlotConfig(partial?.validator, base.validator),
    skipScrutiny:
      typeof partial?.skipScrutiny === "boolean"
        ? partial.skipScrutiny
        : Boolean(base?.skipScrutiny),
    skipUserTesting:
      typeof partial?.skipUserTesting === "boolean"
        ? partial.skipUserTesting
        : Boolean(base?.skipUserTesting),
  };
}

export function resolveMissionPaths(missionDir) {
  if (!missionDir || typeof missionDir !== "string") {
    throw new Error("missionDir must be a non-empty string path");
  }
  const abs = path.resolve(missionDir);
  let dotMissionDir;
  let repoDir;
  if (path.basename(abs) === ".mission") {
    dotMissionDir = abs;
    repoDir = path.dirname(abs);
  } else {
    const candidateDot = path.join(abs, ".mission");
    const hasDirectFiles =
      fs.existsSync(path.join(abs, "state.json")) ||
      fs.existsSync(path.join(abs, "features.json")) ||
      fs.existsSync(path.join(abs, "model-settings.json")) ||
      fs.existsSync(path.join(abs, "progress_log.jsonl"));
    if (fs.existsSync(candidateDot)) {
      dotMissionDir = candidateDot;
      repoDir = abs;
    } else if (hasDirectFiles) {
      dotMissionDir = abs;
      repoDir = path.dirname(abs);
    } else {
      dotMissionDir = candidateDot;
      repoDir = abs;
    }
  }
  return {
    repoDir,
    dotMissionDir,
    statePath: path.join(dotMissionDir, "state.json"),
    featuresPath: path.join(dotMissionDir, "features.json"),
    modelSettingsPath: path.join(dotMissionDir, "model-settings.json"),
    progressLogPath: path.join(dotMissionDir, "progress_log.jsonl"),
  };
}

function writeFileAtomicSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto
      .randomBytes(4)
      .toString("hex")}.tmp`
  );
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function writeJsonAtomicSync(filePath, data) {
  writeFileAtomicSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function safeReadJsonSync(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readProgressLogSync(progressLogPath) {
  try {
    if (!fs.existsSync(progressLogPath)) return [];
    const raw = fs.readFileSync(progressLogPath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, idx) => {
        try {
          const parsed = JSON.parse(line);
          return {
            seq: typeof parsed.seq === "number" ? parsed.seq : idx + 1,
            timestamp: parsed.timestamp || new Date().toISOString(),
            type: parsed.type || "info",
            message: parsed.message || String(line),
            ...parsed,
          };
        } catch {
          return {
            seq: idx + 1,
            timestamp: new Date().toISOString(),
            type: "info",
            message: line,
          };
        }
      });
  } catch {
    return [];
  }
}

function buildProgressLogEntries(existingLogs, entriesToAppend) {
  const baseSeq =
    existingLogs.length > 0
      ? Math.max(...existingLogs.map((e) => (typeof e.seq === "number" ? e.seq : 0)))
      : 0;
  return entriesToAppend.map((entryInput, idx) => {
    const entry = {
      seq: baseSeq + idx + 1,
      timestamp: entryInput.timestamp || new Date().toISOString(),
      type: String(entryInput.type || "info"),
      message: String(entryInput.message || ""),
    };
    if (entryInput.featureId !== undefined) entry.featureId = entryInput.featureId;
    if (entryInput.workerNumber !== undefined) entry.workerNumber = entryInput.workerNumber;
    if (entryInput.milestoneId !== undefined) entry.milestoneId = entryInput.milestoneId;
    if (entryInput.details !== undefined) entry.details = entryInput.details;
    return entry;
  });
}

function writeProgressLogEntriesSync(progressLogPath, entriesToWrite) {
  const entries = readProgressLogSync(progressLogPath);
  const content =
    [...entries, ...entriesToWrite].map((item) => JSON.stringify(item)).join("\n") + "\n";
  writeFileAtomicSync(progressLogPath, content);
  return entriesToWrite;
}

function appendProgressLogSync(progressLogPath, entryInput) {
  const entries = readProgressLogSync(progressLogPath);
  const [entry] = buildProgressLogEntries(entries, [entryInput]);
  const content =
    [...entries, entry].map((item) => JSON.stringify(item)).join("\n") + "\n";
  writeFileAtomicSync(progressLogPath, content);
  return entry;
}

function createDefaultHudRuntimeAdapter(paths) {
  return {
    isDefaultHudRuntime: true,
    async runFeature(feature, slotConfig, state) {
      const runId =
        state?.activeWorker?.runId ||
        slotConfig?.runId ||
        feature?.runId ||
        `run-${crypto.randomUUID().slice(0, 8)}`;
      const fid = feature?.id || state?.activeWorker?.featureId || "feature";
      return {
        taskId: `hud-task-${fid}-${runId}`,
        childThreadId: `hud-thread-${fid}-${runId}`,
        childRunId: runId,
        worktreePath: state?.repoPath || paths.repoDir,
        delegatedBy: "hud-default-runtime",
        dispatchPending: true,
      };
    },
    async pauseWorker(worker, _state) {
      return {
        ok: true,
        paused: true,
        taskId: worker?.taskId || null,
        childThreadId: worker?.childThreadId || null,
      };
    },
    async pauseMission(_state) {
      return { ok: true, status: "paused" };
    },
    async resumeWorker(worker, payload, _state) {
      return {
        ok: true,
        resumed: true,
        taskId: worker?.taskId || null,
        childThreadId: worker?.childThreadId || null,
        trigger: payload?.trigger || "[resume the mission]",
      };
    },
  };
}

function buildUninitializedState(repoDir) {
  return {
    initialized: false,
    missionId: "mission-uninitialized",
    title: "Waiting for Mission Initialization",
    repoPath: repoDir,
    status: "planning",
    revision: 0,
    elapsedMs: 0,
    lastStartedAt: null,
    planAccepted: false,
    onboarding: {
      ready: false,
      headline: "Mission directory (.mission/) is not initialized yet",
      instructions:
        "Propose a mission plan to initialize .mission/state.json, or click Approve & Start Mission once your Validation Contract and features are ready.",
    },
    milestones: [
      { id: "m1", title: "Milestone 1: Intake", ordinal: 1 },
      { id: "m2", title: "Milestone 2: Materials In Run", ordinal: 2 },
    ],
    assertions: [],
    activeWorker: null,
    sessions: [],
    lastHandoffNeedsAttention: false,
    lastHandoffSummary: null,
    lastHandoffAt: null,
    milestoneValidationTriggered: {},
  };
}

function inspectGitTreeForResume(candidateDir, featureId, { activeWorkerWorktreePath } = {}) {
  if (
    typeof activeWorkerWorktreePath === "string" &&
    activeWorkerWorktreePath.trim().length > 0 &&
    !fs.existsSync(activeWorkerWorktreePath)
  ) {
    const summary = `Cannot resume mission: worktree path "${activeWorkerWorktreePath}" does not exist.`;
    return {
      path: activeWorkerWorktreePath,
      isGitRepo: false,
      clean: false,
      canResume: false,
      hasConflicts: false,
      hasUncommittedChanges: false,
      modifiedFiles: [],
      conflictedFiles: [],
      error: "Active worker worktree path does not exist",
      summary,
      diagnostic: summary,
    };
  }

  if (!candidateDir || !fs.existsSync(candidateDir)) {
    const diagnostic = `The mission was paused one minute after the ${featureId} worker started, and the code tree has no uncommitted changes, so I'm resuming that worker.`;
    return {
      path: candidateDir || null,
      isGitRepo: false,
      clean: true,
      canResume: true,
      hasConflicts: false,
      hasUncommittedChanges: false,
      modifiedFiles: [],
      conflictedFiles: [],
      summary: diagnostic,
      diagnostic,
    };
  }

  const dotGitPath = path.join(candidateDir, ".git");
  if (!fs.existsSync(dotGitPath)) {
    const diagnostic = `The mission was paused one minute after the ${featureId} worker started, and the code tree has no uncommitted changes, so I'm resuming that worker.`;
    return {
      path: candidateDir,
      isGitRepo: false,
      clean: true,
      canResume: true,
      hasConflicts: false,
      hasUncommittedChanges: false,
      modifiedFiles: [],
      conflictedFiles: [],
      summary: diagnostic,
      diagnostic,
    };
  }

  try {
    const rawStatus = execFileSync(
      "git",
      ["--no-optional-locks", "-C", candidateDir, "status", "--porcelain"],
      { encoding: "utf8" }
    );
    const statusLines = rawStatus
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const conflictLines = statusLines.filter((line) =>
      /^(UU|AA|DD|AU|UA|DU|UD)/.test(line.slice(0, 2))
    );
    if (conflictLines.length > 0) {
      const conflictedFiles = conflictLines
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
      const diagnostic = `The mission was paused on ${featureId}, and the code tree has unresolved git merge conflicts (${conflictedFiles.join(", ")}), so resume is blocked.`;
      return {
        path: candidateDir,
        isGitRepo: true,
        clean: false,
        canResume: false,
        hasConflicts: true,
        hasUncommittedChanges: true,
        modifiedFiles: conflictedFiles,
        conflictedFiles,
        summary: diagnostic,
        diagnostic,
      };
    }

    if (statusLines.length > 0) {
      const modifiedFiles = statusLines
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
      const diagnostic = `The mission was paused one minute after the ${featureId} worker started, and the code tree has uncommitted changes (${modifiedFiles.join(", ")}), so I'm resuming that worker.`;
      return {
        path: candidateDir,
        isGitRepo: true,
        clean: false,
        canResume: true,
        hasConflicts: false,
        hasUncommittedChanges: true,
        modifiedFiles,
        conflictedFiles: [],
        summary: diagnostic,
        diagnostic,
      };
    }

    const diagnostic = `The mission was paused one minute after the ${featureId} worker started, and the code tree has no uncommitted changes, so I'm resuming that worker.`;
    return {
      path: candidateDir,
      isGitRepo: true,
      clean: true,
      canResume: true,
      hasConflicts: false,
      hasUncommittedChanges: false,
      modifiedFiles: [],
      conflictedFiles: [],
      summary: diagnostic,
      diagnostic,
    };
  } catch (err) {
    const errMsg = err?.message || "Git status check failed";
    const diagnostic = `Failed to inspect git working tree at ${candidateDir}: ${errMsg}`;
    return {
      path: candidateDir,
      isGitRepo: false,
      clean: false,
      canResume: false,
      hasConflicts: false,
      hasUncommittedChanges: false,
      error: errMsg,
      modifiedFiles: [],
      conflictedFiles: [],
      summary: diagnostic,
      diagnostic,
    };
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

export function createMissionHudServer({
  missionDir,
  port = 0,
  host = "127.0.0.1",
  onCommand,
  dispatchAdapter,
  runtimeAdapter,
} = {}) {
  const paths = resolveMissionPaths(missionDir || process.cwd());
  const hasCustomAdapter = Boolean(dispatchAdapter || runtimeAdapter);
  const effectiveAdapter =
    dispatchAdapter || runtimeAdapter || createDefaultHudRuntimeAdapter(paths);
  const sseClients = new Set();
  let sseEventSeq = 1;
  let fsWatcher = null;
  let parentWatcher = null;
  let pollInterval = null;
  let lastDiskSignature = "";
  let closed = false;

  function reconcileStaleRunningStateOnStartup() {
    const rawState = safeReadJsonSync(paths.statePath, null);
    if (!rawState || rawState.status !== "running" || rawState.planAccepted !== true) {
      return;
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const updatedState = structuredClone(rawState);

    if (updatedState.lastStartedAt) {
      const startedMs = Date.parse(updatedState.lastStartedAt);
      if (!Number.isNaN(startedMs) && nowMs > startedMs) {
        updatedState.elapsedMs = (updatedState.elapsedMs || 0) + (nowMs - startedMs);
      }
    }
    updatedState.lastStartedAt = null;
    updatedState.status = "paused";
    updatedState.pausedAt = nowIso;
    updatedState.revision =
      (typeof updatedState.revision === "number" ? updatedState.revision : 1) + 1;

    let pausedWorker = null;
    if (updatedState.activeWorker && updatedState.activeWorker.status === "running") {
      updatedState.activeWorker = {
        ...updatedState.activeWorker,
        status: "paused",
        pausedAt: nowIso,
      };
      pausedWorker = updatedState.activeWorker;

      if (Array.isArray(updatedState.sessions)) {
        updatedState.sessions = updatedState.sessions.map((s) =>
          s.runId === pausedWorker.runId ||
          (pausedWorker.sessionId && s.sessionId === pausedWorker.sessionId) ||
          (pausedWorker.workerNumber && s.workerNumber === pausedWorker.workerNumber) ||
          (pausedWorker.featureId && s.featureId === pausedWorker.featureId)
            ? { ...s, status: "paused", pausedAt: nowIso }
            : s
        );
      }
    }

    writeJsonAtomicSync(paths.statePath, updatedState);

    if (pausedWorker) {
      const workerNumber = pausedWorker.workerNumber ?? 1;
      const featureTitle =
        pausedWorker.featureTitle ||
        pausedWorker.title ||
        pausedWorker.featureId ||
        "feature";
      appendProgressLogSync(paths.progressLogPath, {
        timestamp: nowIso,
        type: "worker_paused",
        message: `Worker #${workerNumber} paused ${featureTitle}`,
        featureId: pausedWorker.featureId ?? null,
        workerNumber,
      });
    }

    appendProgressLogSync(paths.progressLogPath, {
      timestamp: nowIso,
      type: "mission_paused",
      message: "Mission paused",
      featureId: pausedWorker ? pausedWorker.featureId ?? null : null,
      workerNumber: pausedWorker ? pausedWorker.workerNumber ?? 1 : null,
    });
  }

  reconcileStaleRunningStateOnStartup();

  function buildInMemorySnapshot({ state: rawState, features: rawFeatures, modelSettings: rawModelSettings, progressLog }) {
    const initialized = rawState !== null && rawState !== undefined;
    const state = initialized
      ? {
          initialized: true,
          missionId: rawState.missionId || "mission-active",
          title: rawState.title || "T3 Mission Control",
          repoPath: rawState.repoPath || paths.repoDir,
          status: rawState.status || "awaiting_input",
          revision: typeof rawState.revision === "number" ? rawState.revision : 1,
          elapsedMs: typeof rawState.elapsedMs === "number" ? rawState.elapsedMs : 0,
          lastStartedAt: rawState.lastStartedAt ?? null,
          planAccepted: Boolean(rawState.planAccepted),
          milestones: Array.isArray(rawState.milestones) ? rawState.milestones : [],
          assertions: Array.isArray(rawState.assertions) ? rawState.assertions : [],
          activeWorker: rawState.activeWorker ?? null,
          sessions: Array.isArray(rawState.sessions) ? rawState.sessions : [],
          lastHandoffNeedsAttention: Boolean(rawState.lastHandoffNeedsAttention),
          lastHandoffSummary: rawState.lastHandoffSummary ?? null,
          lastHandoffAt: rawState.lastHandoffAt ?? null,
          milestoneValidationTriggered:
            rawState.milestoneValidationTriggered &&
            typeof rawState.milestoneValidationTriggered === "object"
              ? rawState.milestoneValidationTriggered
              : {},
          ...rawState,
        }
      : buildUninitializedState(paths.repoDir);

    const featuresList = Array.isArray(rawFeatures)
      ? rawFeatures
      : Array.isArray(rawFeatures?.features)
        ? rawFeatures.features
        : [];

    const modelSettings = normalizeHudModelSettings(
      rawModelSettings || {},
      DEFAULT_HUD_MODEL_SETTINGS
    );

    return {
      initialized,
      executionHooksConfigured: true,
      state,
      features: featuresList,
      modelSettings,
      progressLog: Array.isArray(progressLog) ? progressLog : [],
      catalog: BUILTIN_MODEL_CATALOG,
    };
  }

  function loadSnapshot() {
    const rawState = safeReadJsonSync(paths.statePath, null);
    const rawFeatures = safeReadJsonSync(paths.featuresPath, null);
    const rawModelSettings = safeReadJsonSync(paths.modelSettingsPath, null);
    const progressLog = readProgressLogSync(paths.progressLogPath);

    return buildInMemorySnapshot({
      state: rawState,
      features: rawFeatures,
      modelSettings: rawModelSettings,
      progressLog,
    });
  }

  function computeDiskSignature() {
    const targets = [
      paths.statePath,
      paths.featuresPath,
      paths.modelSettingsPath,
      paths.progressLogPath,
    ];
    return targets
      .map((p) => {
        try {
          const st = fs.statSync(p);
          return `${st.mtimeMs}:${st.size}`;
        } catch {
          return "0:0";
        }
      })
      .join("|");
  }

  function captureDiskBackup() {
    const targets = [
      paths.statePath,
      paths.featuresPath,
      paths.modelSettingsPath,
      paths.progressLogPath,
    ];
    return targets.map((filePath) => {
      try {
        if (fs.existsSync(filePath)) {
          return {
            filePath,
            exists: true,
            content: fs.readFileSync(filePath, "utf8"),
          };
        }
      } catch {}
      return { filePath, exists: false, content: null };
    });
  }

  function restoreDiskBackup(backup) {
    for (const item of backup) {
      try {
        if (item.exists && item.content !== null) {
          writeFileAtomicSync(item.filePath, item.content);
        } else if (!item.exists && fs.existsSync(item.filePath)) {
          fs.unlinkSync(item.filePath);
        }
      } catch {}
    }
    lastDiskSignature = computeDiskSignature();
  }

  function writeSseEvent(res, eventName, data, id) {
    const eventId = id ?? sseEventSeq++;
    const serialized = JSON.stringify(data);
    res.write(`id: ${eventId}\nevent: ${eventName}\ndata: ${serialized}\n\n`);
  }

  function broadcastSnapshot(reason = "update") {
    if (closed) return null;
    const snapshot = loadSnapshot();
    lastDiskSignature = computeDiskSignature();
    const eventId = sseEventSeq++;
    const payload = {
      ...snapshot,
      eventId,
      reason,
      emittedAt: new Date().toISOString(),
    };
    for (const client of sseClients) {
      try {
        writeSseEvent(client, "mission_snapshot", payload, eventId);
      } catch {
        sseClients.delete(client);
      }
    }
    return payload;
  }

  function setupWatchers() {
    lastDiskSignature = computeDiskSignature();

    const checkAndBroadcast = () => {
      if (closed) return;
      const sig = computeDiskSignature();
      if (sig !== lastDiskSignature) {
        lastDiskSignature = sig;
        broadcastSnapshot("fs_change");
      }
    };

    const attachDotMissionWatch = () => {
      if (fsWatcher || closed) return;
      if (fs.existsSync(paths.dotMissionDir)) {
        try {
          fsWatcher = fs.watch(paths.dotMissionDir, () => {
            checkAndBroadcast();
          });
          fsWatcher.on("error", () => {
            try {
              fsWatcher?.close();
            } catch {}
            fsWatcher = null;
          });
        } catch {
          fsWatcher = null;
        }
      }
    };

    attachDotMissionWatch();

    if (fs.existsSync(paths.repoDir)) {
      try {
        parentWatcher = fs.watch(paths.repoDir, (_eventType, filename) => {
          if (!filename || filename === ".mission" || String(filename).startsWith(".mission")) {
            attachDotMissionWatch();
            checkAndBroadcast();
          }
        });
        parentWatcher.on("error", () => {});
      } catch {
        parentWatcher = null;
      }
    }

    pollInterval = setInterval(() => {
      attachDotMissionWatch();
      checkAndBroadcast();
    }, 150);
    if (typeof pollInterval.unref === "function") {
      pollInterval.unref();
    }
  }

  async function notifyCommand(type, payload, snapshot) {
    if (typeof onCommand === "function") {
      await onCommand({ type, payload, snapshot });
    }
  }

  async function handleApprove(req, res) {
    const body = await readJsonBody(req);
    const backup = captureDiskBackup();
    const nowIso = new Date().toISOString();
    const existing = safeReadJsonSync(paths.statePath, null) || buildUninitializedState(paths.repoDir);
    const rawFeatures = safeReadJsonSync(paths.featuresPath, null);
    const featuresList = Array.isArray(rawFeatures)
      ? structuredClone(rawFeatures)
      : Array.isArray(rawFeatures?.features)
        ? structuredClone(rawFeatures.features)
        : [];
    const modelSettings = normalizeHudModelSettings(
      safeReadJsonSync(paths.modelSettingsPath, {}) || {},
      DEFAULT_HUD_MODEL_SETTINGS
    );
    const existingLogs = readProgressLogSync(paths.progressLogPath);

    const hasActiveWorker = Boolean(existing.activeWorker);
    const pendingFeatureIdx = !hasActiveWorker
      ? featuresList.findIndex((f) => (f.status || "pending") === "pending")
      : -1;

    const nextStatus =
      body.status ||
      (hasActiveWorker || pendingFeatureIdx !== -1 ? "running" : "orchestrator_turn");

    const updatedState = {
      ...existing,
      initialized: true,
      planAccepted: true,
      status: nextStatus,
      revision: (typeof existing.revision === "number" ? existing.revision : 0) + 1,
      lastStartedAt:
        nextStatus === "running" ? existing.lastStartedAt || nowIso : existing.lastStartedAt ?? null,
      approvedAt: nowIso,
    };

    if (hasActiveWorker && updatedState.activeWorker) {
      updatedState.activeWorker = {
        ...updatedState.activeWorker,
        status: "running",
      };
    }

    let selectedFeature = null;
    let selectedWorkerEntry = null;
    if (pendingFeatureIdx !== -1) {
      const f = featuresList[pendingFeatureIdx];
      const nextAttempt = (typeof f.attempts === "number" ? f.attempts : 0) + 1;
      const workerNumber =
        (Array.isArray(existing.sessions) ? existing.sessions.length : 0) + 1;
      const runId = f.runId || `run-${crypto.randomUUID().slice(0, 8)}`;
      const rawKind = String(f.kind || "").toLowerCase();
      const rawId = String(f.id || "").toLowerCase();
      const rawSkill = String(f.skillName || "").toLowerCase();
      const isValidator =
        rawKind === "scrutiny" ||
        rawKind === "user_testing" ||
        rawKind === "user-testing" ||
        rawId.startsWith("scrutiny-validator") ||
        rawId.startsWith("user-testing-validator") ||
        rawSkill.includes("scrutiny") ||
        rawSkill.includes("user-testing") ||
        rawSkill.includes("user_testing");
      const kind =
        rawKind === "user-testing"
          ? "user_testing"
          : f.kind || (isValidator ? "scrutiny" : "implementation");
      const role = isValidator ? "Validator" : kind === "explorer" ? "Explorer" : "Worker";
      const slotName = isValidator ? "validator" : "worker";
      const slotCfg = modelSettings[slotName] || DEFAULT_HUD_MODEL_SETTINGS[slotName];

      featuresList[pendingFeatureIdx] = {
        ...f,
        status: "running",
        attempts: nextAttempt,
      };
      selectedFeature = featuresList[pendingFeatureIdx];

      selectedWorkerEntry = {
        runId,
        sessionId: f.sessionId || `${slotName}-${workerNumber}`,
        workerNumber,
        role,
        featureId: f.id,
        featureTitle: f.title || f.id,
        milestoneId: f.milestoneId || "m1",
        kind,
        skillName:
          f.skillName ||
          (isValidator
            ? `${kind}-validator-${f.milestoneId || "m1"}`
            : "worker-implementation"),
        slot: slotName,
        providerInstanceId: slotCfg.providerInstanceId,
        model: slotCfg.model,
        options: slotCfg.options || {},
        status: "running",
        dispatchPending: true,
        attempt: nextAttempt,
        startedAt: nowIso,
      };

      updatedState.activeWorker = selectedWorkerEntry;
      updatedState.sessions = [
        ...(Array.isArray(existing.sessions) ? existing.sessions : []),
        { ...selectedWorkerEntry },
      ];
    }

    delete updatedState.onboarding;

    const entriesToAppend = [
      {
        timestamp: nowIso,
        type: "plan_approved",
        message: body.message || "Mission plan approved and started",
        featureId: null,
        workerNumber: null,
      },
    ];

    if (selectedWorkerEntry) {
      entriesToAppend.push(
        {
          timestamp: nowIso,
          type: "worker_selected",
          message: `${selectedWorkerEntry.role} #${selectedWorkerEntry.workerNumber} selected ${selectedWorkerEntry.featureTitle}`,
          featureId: selectedWorkerEntry.featureId,
          workerNumber: selectedWorkerEntry.workerNumber,
        },
        {
          timestamp: nowIso,
          type: "worker_started",
          message: `${selectedWorkerEntry.role} #${selectedWorkerEntry.workerNumber} started ${selectedWorkerEntry.featureTitle}`,
          featureId: selectedWorkerEntry.featureId,
          workerNumber: selectedWorkerEntry.workerNumber,
        }
      );
    }

    const logEntries = buildProgressLogEntries(existingLogs, entriesToAppend);
    const logEntry = logEntries[0];

    try {
      const preBroadcastSnapshot = buildInMemorySnapshot({
        state: updatedState,
        features: featuresList,
        modelSettings,
        progressLog: [...existingLogs, ...logEntries],
      });

      await notifyCommand("approve", { body, logEntry, logEntries }, preBroadcastSnapshot);

      if (selectedFeature && selectedWorkerEntry) {
        if (typeof effectiveAdapter.runFeature === "function") {
          const runRes = await effectiveAdapter.runFeature(
            selectedFeature,
            selectedWorkerEntry,
            updatedState
          );
          if (runRes && typeof runRes === "object") {
            const lastSession =
              Array.isArray(updatedState.sessions) && updatedState.sessions.length > 0
                ? updatedState.sessions[updatedState.sessions.length - 1]
                : null;
            for (const key of [
              "taskId",
              "childThreadId",
              "childRunId",
              "worktreePath",
              "delegatedBy",
            ]) {
              if (runRes[key] !== undefined) {
                selectedWorkerEntry[key] = runRes[key];
                updatedState.activeWorker[key] = runRes[key];
                if (lastSession) lastSession[key] = runRes[key];
                featuresList[pendingFeatureIdx][key] = runRes[key];
              }
            }
            if (runRes.dispatchPending !== undefined) {
              selectedWorkerEntry.dispatchPending = Boolean(runRes.dispatchPending);
              updatedState.activeWorker.dispatchPending = Boolean(runRes.dispatchPending);
              if (lastSession) lastSession.dispatchPending = Boolean(runRes.dispatchPending);
            } else if (hasCustomAdapter && runRes.dispatchPending === undefined) {
              delete selectedWorkerEntry.dispatchPending;
              delete updatedState.activeWorker.dispatchPending;
              if (lastSession) delete lastSession.dispatchPending;
            }
          }
        }
        if (hasCustomAdapter && typeof effectiveAdapter.startMissionRun === "function") {
          await effectiveAdapter.startMissionRun(
            paths.dotMissionDir,
            { feature: selectedFeature, state: updatedState },
            effectiveAdapter
          );
        }
      } else if (
        !hasActiveWorker &&
        hasCustomAdapter &&
        typeof effectiveAdapter.startMissionRun === "function"
      ) {
        await effectiveAdapter.startMissionRun(
          paths.dotMissionDir,
          { feature: null, state: updatedState },
          effectiveAdapter
        );
      }

      if (selectedFeature) {
        const nextFeaturesDoc = Array.isArray(rawFeatures)
          ? { features: featuresList, updatedAt: nowIso }
          : {
              ...(rawFeatures && typeof rawFeatures === "object" ? rawFeatures : {}),
              features: featuresList,
              updatedAt: nowIso,
            };
        writeJsonAtomicSync(paths.featuresPath, nextFeaturesDoc);
      }

      writeJsonAtomicSync(paths.statePath, updatedState);
      writeProgressLogEntriesSync(paths.progressLogPath, logEntries);

      lastDiskSignature = computeDiskSignature();
      const snapshot = broadcastSnapshot("plan_approved");
      sendJson(res, 200, {
        ok: true,
        state: snapshot ? snapshot.state : updatedState,
        logEntry,
        logEntries,
        snapshot,
      });
    } catch (err) {
      restoreDiskBackup(backup);
      throw err;
    }
  }

  async function handleModelSlots(req, res) {
    const body = await readJsonBody(req);
    const backup = captureDiskBackup();
    const nowIso = new Date().toISOString();

    const currentSettings = normalizeHudModelSettings(
      safeReadJsonSync(paths.modelSettingsPath, {}) || {},
      DEFAULT_HUD_MODEL_SETTINGS
    );
    const rawFeatures = safeReadJsonSync(paths.featuresPath, null);
    const existingLogs = readProgressLogSync(paths.progressLogPath);

    const buildSlotPatch = (prevSlot, incomingRaw) => {
      if (typeof incomingRaw === "string") {
        return incomingRaw;
      }
      if (!incomingRaw || typeof incomingRaw !== "object") {
        return prevSlot;
      }
      const incoming =
        typeof incomingRaw.config === "object" && incomingRaw.config
          ? { ...incomingRaw.config, ...incomingRaw }
          : incomingRaw;

      const hasEffort =
        incoming.effort !== undefined || incoming.options?.effort !== undefined;
      const hasReasoning =
        incoming.reasoningEffort !== undefined ||
        incoming.options?.reasoningEffort !== undefined;

      const rawEffortVal =
        incoming.effort !== undefined ? incoming.effort : incoming.options?.effort;
      const derivedReasoning =
        hasEffort && !hasReasoning
          ? effortToReasoningEffort(rawEffortVal, prevSlot?.reasoningEffort || "high")
          : incoming.reasoningEffort ?? incoming.options?.reasoningEffort;

      const nextOptions = {
        ...(prevSlot?.options || {}),
        ...(incoming.options || {}),
      };
      if (hasEffort) {
        const numericEffort = Math.max(1, Math.min(5, Math.round(Number(rawEffortVal) || 4)));
        nextOptions.effort = numericEffort;
        if (!hasReasoning) {
          nextOptions.reasoningEffort = derivedReasoning;
        }
      }
      if (hasReasoning && derivedReasoning) {
        nextOptions.reasoningEffort = String(derivedReasoning).trim().toLowerCase();
      }

      const merged = {
        ...prevSlot,
        ...(incoming.model !== undefined ? { model: incoming.model } : {}),
        ...(incoming.providerInstanceId !== undefined
          ? { providerInstanceId: incoming.providerInstanceId }
          : {}),
        ...(incoming.label !== undefined ? { label: incoming.label } : {}),
        ...(hasEffort ? { effort: nextOptions.effort } : {}),
        ...(derivedReasoning !== undefined ? { reasoningEffort: derivedReasoning } : {}),
        options: nextOptions,
      };
      if (hasEffort && !hasReasoning) {
        merged.reasoningEffort = derivedReasoning;
      }
      return merged;
    };

    const patch = {};
    const slotKey = body.slot || body.role;
    if (slotKey && ["orchestrator", "worker", "validator"].includes(slotKey)) {
      patch[slotKey] = buildSlotPatch(currentSettings[slotKey], body);
    }

    const container = body.modelSettings || body.slots || body;
    for (const role of ["orchestrator", "worker", "validator"]) {
      if (container && container[role] !== undefined && role !== slotKey) {
        patch[role] = buildSlotPatch(currentSettings[role], container[role]);
      }
    }
    if (typeof container?.skipScrutiny === "boolean") {
      patch.skipScrutiny = container.skipScrutiny;
    }
    if (typeof container?.skipUserTesting === "boolean") {
      patch.skipUserTesting = container.skipUserTesting;
    }

    const updatedSettings = normalizeHudModelSettings(patch, currentSettings);
    const existingState =
      safeReadJsonSync(paths.statePath, null) || buildUninitializedState(paths.repoDir);
    const updatedState = {
      ...existingState,
      initialized: true,
      revision: (typeof existingState.revision === "number" ? existingState.revision : 0) + 1,
    };

    const changedRoles = Object.keys(patch).filter((k) =>
      ["orchestrator", "worker", "validator"].includes(k)
    );
    const summaryParts = (changedRoles.length ? changedRoles : ["validator"]).map(
      (role) =>
        `${role}=${updatedSettings[role].model} (${updatedSettings[role].reasoningEffort}/${updatedSettings[role].effort})`
    );

    const logEntries = buildProgressLogEntries(existingLogs, [
      {
        timestamp: nowIso,
        type: "model_slots_updated",
        message: `Model slots updated: ${summaryParts.join(", ")}`,
        details: { updatedSettings, changedRoles },
      },
    ]);
    const logEntry = logEntries[0];

    try {
      const preBroadcastSnapshot = buildInMemorySnapshot({
        state: updatedState,
        features: rawFeatures,
        modelSettings: updatedSettings,
        progressLog: [...existingLogs, ...logEntries],
      });

      await notifyCommand("model-slots", { body, updatedSettings, logEntry }, preBroadcastSnapshot);

      writeJsonAtomicSync(paths.modelSettingsPath, updatedSettings);
      writeJsonAtomicSync(paths.statePath, updatedState);
      writeProgressLogEntriesSync(paths.progressLogPath, logEntries);

      lastDiskSignature = computeDiskSignature();
      const snapshot = broadcastSnapshot("model_slots_updated");
      sendJson(res, 200, {
        ok: true,
        modelSettings: updatedSettings,
        state: updatedState,
        logEntry,
        snapshot,
      });
    } catch (err) {
      restoreDiskBackup(backup);
      throw err;
    }
  }

  async function handlePause(req, res) {
    const body = await readJsonBody(req);
    const backup = captureDiskBackup();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const existingState =
      safeReadJsonSync(paths.statePath, null) || buildUninitializedState(paths.repoDir);
    const rawFeatures = safeReadJsonSync(paths.featuresPath, null);
    const rawModelSettings = safeReadJsonSync(paths.modelSettingsPath, null);
    const existingLogs = readProgressLogSync(paths.progressLogPath);

    const updatedState = structuredClone(existingState);
    updatedState.initialized = true;

    if (updatedState.lastStartedAt) {
      const startedMs = Date.parse(updatedState.lastStartedAt);
      if (!Number.isNaN(startedMs) && nowMs > startedMs) {
        updatedState.elapsedMs = (updatedState.elapsedMs || 0) + (nowMs - startedMs);
      }
    }
    updatedState.lastStartedAt = null;
    updatedState.status = "paused";
    updatedState.pausedAt = nowIso;
    updatedState.revision =
      (typeof updatedState.revision === "number" ? updatedState.revision : 0) + 1;

    const entriesToAppend = [];
    if (updatedState.activeWorker) {
      const workerNumber = updatedState.activeWorker.workerNumber ?? 28;
      const featureTitle =
        updatedState.activeWorker.featureTitle ||
        updatedState.activeWorker.title ||
        updatedState.activeWorker.featureId ||
        "M2 material test gaps";
      updatedState.activeWorker = {
        ...updatedState.activeWorker,
        status: "paused",
        pausedAt: nowIso,
      };

      if (Array.isArray(updatedState.sessions)) {
        updatedState.sessions = updatedState.sessions.map((s) =>
          s.runId === updatedState.activeWorker.runId ||
          s.workerNumber === workerNumber ||
          (updatedState.activeWorker.featureId &&
            s.featureId === updatedState.activeWorker.featureId)
            ? { ...s, status: "paused", pausedAt: nowIso }
            : s
        );
      }

      entriesToAppend.push({
        timestamp: nowIso,
        type: "worker_paused",
        message: `Worker #${workerNumber} paused ${featureTitle}`,
        featureId: updatedState.activeWorker.featureId ?? null,
        workerNumber,
      });
    }

    entriesToAppend.push({
      timestamp: nowIso,
      type: "mission_paused",
      message: "Mission paused",
      featureId: updatedState.activeWorker?.featureId ?? null,
      workerNumber: updatedState.activeWorker?.workerNumber ?? null,
    });

    const logEntries = buildProgressLogEntries(existingLogs, entriesToAppend);

    try {
      const preBroadcastSnapshot = buildInMemorySnapshot({
        state: updatedState,
        features: rawFeatures,
        modelSettings: rawModelSettings,
        progressLog: [...existingLogs, ...logEntries],
      });

      await notifyCommand("pause", { body, logEntries }, preBroadcastSnapshot);

      if (existingState.activeWorker && typeof effectiveAdapter.pauseWorker === "function") {
        const pwRes = await effectiveAdapter.pauseWorker(existingState.activeWorker, existingState);
        if (pwRes && (pwRes.paused === false || pwRes.ok === false)) {
          throw new Error(pwRes.error || "Runtime pauseWorker rejected");
        }
      }

      if (typeof effectiveAdapter.pauseMission === "function") {
        const pmRes = await effectiveAdapter.pauseMission(existingState);
        if (pmRes && (pmRes.paused === false || pmRes.ok === false)) {
          throw new Error(pmRes.error || "Runtime pauseMission rejected");
        }
      }

      writeProgressLogEntriesSync(paths.progressLogPath, logEntries);
      writeJsonAtomicSync(paths.statePath, updatedState);
      lastDiskSignature = computeDiskSignature();
      const snapshot = broadcastSnapshot("mission_paused");
      sendJson(res, 200, {
        ok: true,
        state: snapshot ? snapshot.state : updatedState,
        logEntries,
        snapshot,
      });
    } catch (err) {
      restoreDiskBackup(backup);
      throw err;
    }
  }

  async function handleResume(req, res) {
    const body = await readJsonBody(req);
    const nowIso = new Date().toISOString();

    const existingState = safeReadJsonSync(paths.statePath, null);
    if (!existingState || existingState.planAccepted !== true) {
      const stateFallback = existingState || buildUninitializedState(paths.repoDir);
      sendJson(res, 409, {
        ok: false,
        code: "PLAN_ACCEPTANCE_REQUIRED",
        error: "Cannot resume mission before plan is accepted",
        state: stateFallback,
      });
      return;
    }

    if (
      existingState.status !== "paused" &&
      existingState.activeWorker?.status !== "paused"
    ) {
      sendJson(res, 409, {
        ok: false,
        code: "MISSION_NOT_PAUSED",
        error: "Mission is not in a paused state",
        state: existingState,
      });
      return;
    }

    if (existingState.lastHandoffNeedsAttention === true) {
      sendJson(res, 409, {
        ok: false,
        code: "HANDOFF_ATTENTION_REQUIRED",
        error: "Cannot resume mission while handoff items require orchestrator attention",
        state: existingState,
      });
      return;
    }

    let workerNumber = null;
    let featureId = "m2-material-test-gaps";
    let featureTitle = "M2 material test gaps";

    if (existingState.activeWorker) {
      workerNumber = existingState.activeWorker.workerNumber ?? 28;
      featureId =
        existingState.activeWorker.featureId ||
        existingState.activeWorker.id ||
        "m2-material-test-gaps";
      featureTitle =
        existingState.activeWorker.featureTitle ||
        existingState.activeWorker.title ||
        featureId;
    }

    const activeWorkerWorktreePath = existingState.activeWorker?.worktreePath || null;
    const candidateDir =
      activeWorkerWorktreePath ||
      existingState.repoPath ||
      paths.repoDir;
    const gitCheck = inspectGitTreeForResume(candidateDir, featureId, {
      activeWorkerWorktreePath,
    });

    if (!gitCheck.canResume) {
      sendJson(res, 409, {
        ok: false,
        code: gitCheck.hasConflicts
          ? "RESUME_BLOCKED_BY_CONFLICTS"
          : "RESUME_BLOCKED_BY_GIT_ERROR",
        error: gitCheck.hasConflicts
          ? "Unresolved git merge conflicts in working tree"
          : gitCheck.error || gitCheck.summary || "Git preflight check failed",
        diagnostic: gitCheck.summary || gitCheck.diagnostic,
        gitCheck,
        state: existingState,
      });
      return;
    }

    const diagnostic = body.diagnostic || gitCheck.diagnostic;
    const rawFeatures = safeReadJsonSync(paths.featuresPath, null);
    const rawModelSettings = safeReadJsonSync(paths.modelSettingsPath, null);
    const existingLogs = readProgressLogSync(paths.progressLogPath);

    const updatedState = structuredClone(existingState);
    updatedState.initialized = true;
    updatedState.status = "running";
    updatedState.lastStartedAt = nowIso;
    updatedState.resumedAt = nowIso;
    updatedState.revision =
      (typeof updatedState.revision === "number" ? updatedState.revision : 0) + 1;

    if (updatedState.activeWorker) {
      updatedState.activeWorker = {
        ...updatedState.activeWorker,
        status: "running",
        resumePending: true,
        resumedAt: nowIso,
      };
      delete updatedState.activeWorker.pausedAt;

      if (Array.isArray(updatedState.sessions)) {
        updatedState.sessions = updatedState.sessions.map((s) =>
          s.runId === updatedState.activeWorker.runId ||
          s.workerNumber === workerNumber ||
          (featureId && s.featureId === featureId)
            ? { ...s, status: "running", resumePending: true, resumedAt: nowIso }
            : s
        );
      }
    }

    updatedState.lastResumeTrigger = "[resume the mission]";
    updatedState.lastResumeDiagnostic = diagnostic;

    const resumeSummary =
      body.resumeSummary ||
      (updatedState.activeWorker
        ? `Resume M2 fixes: ${featureId} (${featureTitle})`
        : "Resume mission execution");

    const entriesToAppend = [
      {
        timestamp: nowIso,
        type: "mission_resumed",
        message: "Mission resumed",
        featureId: updatedState.activeWorker ? featureId : null,
        workerNumber,
        details: {
          trigger: "[resume the mission]",
          diagnostic,
          gitCheck,
        },
      },
      {
        timestamp: nowIso,
        type: "run_started",
        message: `Run started: ${resumeSummary}`,
        featureId: updatedState.activeWorker ? featureId : null,
        workerNumber,
        details: {
          trigger: "[resume the mission]",
          diagnostic,
        },
      },
    ];

    const logEntries = buildProgressLogEntries(existingLogs, entriesToAppend);
    const backup = captureDiskBackup();

    try {
      const preBroadcastSnapshot = buildInMemorySnapshot({
        state: updatedState,
        features: rawFeatures,
        modelSettings: rawModelSettings,
        progressLog: [...existingLogs, ...logEntries],
      });

      await notifyCommand(
        "resume",
        {
          body,
          trigger: "[resume the mission]",
          diagnostic,
          gitCheck,
          logEntries,
        },
        preBroadcastSnapshot
      );

      if (existingState.activeWorker && typeof effectiveAdapter.resumeWorker === "function") {
        const rwRes = await effectiveAdapter.resumeWorker(
          existingState.activeWorker,
          { trigger: "[resume the mission]", diagnostic, gitCheck, body },
          existingState
        );
        if (
          rwRes &&
          (rwRes.resumed === false || rwRes.canResume === false || rwRes.ok === false)
        ) {
          restoreDiskBackup(backup);
          sendJson(res, 409, {
            ok: false,
            code: "RESUME_BLOCKED_BY_RUNTIME",
            error: rwRes.error || "Runtime resumeWorker rejected resume",
            state: existingState,
          });
          return;
        }
      } else if (typeof effectiveAdapter.startMissionRun === "function") {
        const smRes = await effectiveAdapter.startMissionRun(
          paths.dotMissionDir,
          { trigger: "[resume the mission]", diagnostic, gitCheck, body },
          effectiveAdapter
        );
        if (
          smRes &&
          (smRes.resumed === false || smRes.canResume === false || smRes.ok === false)
        ) {
          restoreDiskBackup(backup);
          sendJson(res, 409, {
            ok: false,
            code: "RESUME_BLOCKED_BY_RUNTIME",
            error: smRes.error || "Runtime startMissionRun rejected resume",
            state: existingState,
          });
          return;
        }
      }

      writeProgressLogEntriesSync(paths.progressLogPath, logEntries);
      writeJsonAtomicSync(paths.statePath, updatedState);
      lastDiskSignature = computeDiskSignature();
      const snapshot = broadcastSnapshot("mission_resumed");
      sendJson(res, 200, {
        ok: true,
        trigger: "[resume the mission]",
        diagnostic,
        gitCheck,
        state: snapshot ? snapshot.state : updatedState,
        logEntries,
        snapshot,
      });
    } catch (err) {
      restoreDiskBackup(backup);
      throw err;
    }
  }

  function serveStaticAsset(res, filename, contentType) {
    const filePath = path.join(PUBLIC_DIR, filename);
    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { error: `Static asset not found: ${filename}` });
      return;
    }
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(content);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = urlObj.pathname;
      const method = (req.method || "GET").toUpperCase();

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
        });
        res.end();
        return;
      }

      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        serveStaticAsset(res, "index.html", "text/html; charset=utf-8");
        return;
      }

      if (method === "GET" && (pathname === "/styles.css" || pathname === "/style.css")) {
        serveStaticAsset(res, "styles.css", "text/css; charset=utf-8");
        return;
      }

      if (method === "GET" && pathname === "/app.js") {
        serveStaticAsset(res, "app.js", "application/javascript; charset=utf-8");
        return;
      }

      if (method === "GET" && pathname === "/api/mission/state") {
        const snapshot = loadSnapshot();
        sendJson(res, 200, snapshot);
        return;
      }

      if (method === "GET" && pathname === "/api/mission/stream") {
        const lastEventIdHeader =
          req.headers["last-event-id"] || urlObj.searchParams.get("lastEventId") || null;

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Access-Control-Allow-Origin": "*",
        });

        res.write(": connected\n\n");
        sseClients.add(res);

        const initialSnapshot = loadSnapshot();
        const eventId = sseEventSeq++;
        writeSseEvent(
          res,
          "mission_snapshot",
          {
            ...initialSnapshot,
            eventId,
            lastEventId: lastEventIdHeader ? String(lastEventIdHeader) : null,
            reason: "initial",
            emittedAt: new Date().toISOString(),
          },
          eventId
        );

        req.on("close", () => {
          sseClients.delete(res);
        });
        return;
      }

      if (method === "POST" && pathname === "/api/mission/approve") {
        await handleApprove(req, res);
        return;
      }

      if (method === "POST" && pathname === "/api/mission/model-slots") {
        await handleModelSlots(req, res);
        return;
      }

      if (method === "POST" && pathname === "/api/mission/pause") {
        await handlePause(req, res);
        return;
      }

      if (method === "POST" && pathname === "/api/mission/resume") {
        await handleResume(req, res);
        return;
      }

      sendJson(res, 404, { error: `Route not found: ${method} ${pathname}` });
    } catch (err) {
      sendJson(res, 500, {
        error: err?.message || "Internal server error",
      });
    }
  });

  setupWatchers();

  let listenPromise = null;
  function ensureListening() {
    if (listenPromise) return listenPromise;
    listenPromise = new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(api);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    return listenPromise;
  }

  async function closeServer() {
    if (closed) return;
    closed = true;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (fsWatcher) {
      try {
        fsWatcher.close();
      } catch {}
      fsWatcher = null;
    }
    if (parentWatcher) {
      try {
        parentWatcher.close();
      } catch {}
      parentWatcher = null;
    }
    for (const client of sseClients) {
      try {
        client.end();
      } catch {}
    }
    sseClients.clear();
    if (server.listening) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }

  const api = {
    server,
    missionDir: paths.repoDir,
    dotMissionDir: paths.dotMissionDir,
    paths,
    executionHooksConfigured: true,
    dispatchAdapter: effectiveAdapter,
    runtimeAdapter: effectiveAdapter,
    get port() {
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : port;
    },
    get url() {
      return `http://${host}:${this.port}`;
    },
    address() {
      return server.address();
    },
    getSnapshot: loadSnapshot,
    broadcastSnapshot,
    start: () => ensureListening(),
    listen: () => ensureListening(),
    close: closeServer,
    stop: closeServer,
  };

  // Start listening immediately and allow both `await createMissionHudServer(...)`
  // and `const s = createMissionHudServer(...); await s.start();`
  const ready = ensureListening();
  api.ready = ready;

  const thenable = Object.create(api);
  Object.defineProperty(thenable, "then", {
    value(onFulfilled, onRejected) {
      return ready.then(onFulfilled, onRejected);
    },
    configurable: true,
    enumerable: false,
  });

  return thenable;
}

function parseCliArgs(argv) {
  let missionDir = process.cwd();
  let port = 4319;
  let portExplicit = false;
  let host = "127.0.0.1";
  let foreground = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--mission-dir" || arg === "--missionDir") && argv[i + 1]) {
      missionDir = argv[++i];
    } else if (arg.startsWith("--mission-dir=")) {
      missionDir = arg.slice("--mission-dir=".length);
    } else if (arg === "--port" && argv[i + 1]) {
      port = Number(argv[++i]);
      portExplicit = true;
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
      portExplicit = true;
    } else if (arg === "--host" && argv[i + 1]) {
      host = argv[++i];
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--foreground") {
      foreground = true;
    }
  }

  return { missionDir, port, portExplicit, host, foreground };
}

async function runCli() {
  const { missionDir, port, portExplicit, host, foreground } = parseCliArgs(
    process.argv.slice(2)
  );
  const paths = resolveMissionPaths(missionDir);
  fs.mkdirSync(paths.dotMissionDir, { recursive: true });

  if (!foreground) {
    const child = spawn(
      process.execPath,
      [__filename, ...process.argv.slice(2), "--foreground"],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    const startupLine = await new Promise((resolve, reject) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      const timer = setTimeout(() => {
        reject(new Error(`Timed out starting HUD server: ${stderrBuf}`));
      }, 4000);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk;
        const newlineIdx = stdoutBuf.indexOf("\n");
        if (newlineIdx !== -1) {
          clearTimeout(timer);
          resolve(stdoutBuf.slice(0, newlineIdx).trim());
        }
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk;
      });

      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.once("exit", (code) => {
        clearTimeout(timer);
        if (stdoutBuf.trim()) {
          resolve(stdoutBuf.trim().split(/\r?\n/)[0]);
        } else {
          reject(new Error(`HUD background server exited with code ${code}: ${stderrBuf}`));
        }
      });
    });

    try {
      fs.writeFileSync(path.join(paths.dotMissionDir, "hud.pid"), `${child.pid}\n`, "utf8");
    } catch {}

    process.stdout.write(`${startupLine}\n`);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    return;
  }

  let srv;
  try {
    srv = await createMissionHudServer({ missionDir, port, host });
  } catch (err) {
    if (err && err.code === "EADDRINUSE" && !portExplicit) {
      srv = await createMissionHudServer({ missionDir, port: 0, host });
    } else {
      throw err;
    }
  }

  const info = {
    ok: true,
    url: srv.url,
    port: srv.port,
    host,
    missionDir: srv.missionDir,
    dotMissionDir: srv.dotMissionDir,
    pid: process.pid,
  };
  process.stdout.write(`${JSON.stringify(info)}\n`);

  const shutdown = async () => {
    clearInterval(dirCheckTimer);
    await srv.close();
    process.exit(0);
  };

  const dirCheckTimer = setInterval(() => {
    if (!fs.existsSync(paths.dotMissionDir)) {
      shutdown();
    }
  }, 200);
  if (typeof dirCheckTimer.unref === "function") {
    dirCheckTimer.unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function resolveRealOrAbsPath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

if (
  process.argv[1] &&
  resolveRealOrAbsPath(process.argv[1]) === resolveRealOrAbsPath(__filename)
) {
  runCli().catch((err) => {
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`);
    process.exit(1);
  });
}
