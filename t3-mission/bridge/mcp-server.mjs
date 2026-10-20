import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  checkGitTreeBeforeResume,
  createT3Adapter,
  delegateMissionTask,
  normalizeTargetFromSlot,
  resolveTargetFromModelSettings,
  resumeWorker,
  settleCompletedMilestoneThreads
} from "./t3-adapter.mjs";

export const MISSION_TOOL_NAMES = [
  "ProposeMission",
  "ApproveMissionPlan",
  "StartMissionRun",
  "DismissHandoffItems",
  "EndFeatureRun",
  "UpdateMissionFeatures",
  "CheckMissionStateBeforeResuming"
];

export const MISSION_TOOLS = [
  {
    name: "ProposeMission",
    description:
      "Propose a new Mission plan with milestones, features, validation contract assertions (VAL-*), and 3-role model settings (orchestrator, worker, validator). Requires explicit user approval before execution.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        missionId: { type: "string" },
        title: { type: "string" },
        goal: { type: "string" },
        milestones: { type: "array", items: { type: "object" } },
        features: { type: "array", items: { type: "object" } },
        assertions: { type: "array", items: { type: "object" } },
        modelSettings: { type: "object" }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "ApproveMissionPlan",
    description:
      "Record explicit user approval of the proposed Mission plan in the Mission HUD, unlocking StartMissionRun.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        modelSettings: { type: "object" },
        approvedBy: { type: "string" }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "StartMissionRun",
    description:
      "Start or resume the Mission execution loop. When resuming from a paused state with an activeWorker, checks the Git tree and wakes up the original childThreadId via t3_thread_send; otherwise dispatches the next pending feature via delegate_task.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        repoPath: { type: "string" },
        worktreePath: { type: "string" },
        restartFeature: { type: "boolean" }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "DismissHandoffItems",
    description:
      "Dismiss or acknowledge worker handoff attention items (discovered issues or left-undone items) with explicit justifications.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        dismissals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              itemId: { type: "string" },
              type: { type: "string" },
              reason: { type: "string" }
            }
          }
        }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "EndFeatureRun",
    description:
      "Complete an active Worker or Validator run with a structured handoff, updating feature status, validation assertions, and milestone validation injection.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        runId: { type: "string" },
        featureId: { type: "string" },
        successState: { type: "string", enum: ["success", "failure", "partial"] },
        validatorsPassed: { type: "boolean" },
        returnToOrchestrator: { type: "boolean" },
        assertionResults: { type: "object" },
        handoff: { type: "object" }
      },
      required: ["missionDir", "handoff"]
    }
  },
  {
    name: "UpdateMissionFeatures",
    description:
      "Add, update, or reorder features, milestones, or validation assertions in .mission/features.json and .mission/state.json.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        features: { type: "array", items: { type: "object" } },
        addFeatures: { type: "array", items: { type: "object" } },
        updateFeatures: { type: "array", items: { type: "object" } },
        milestones: { type: "array", items: { type: "object" } },
        assertions: { type: "array", items: { type: "object" } }
      },
      required: ["missionDir"]
    }
  },
  {
    name: "CheckMissionStateBeforeResuming",
    description:
      "Inspect .mission/state.json and check the Git working tree before resuming an interrupted or paused Mission.",
    inputSchema: {
      type: "object",
      properties: {
        missionDir: { type: "string", description: "Path to the project or .mission directory" },
        repoPath: { type: "string" },
        worktreePath: { type: "string" }
      },
      required: ["missionDir"]
    }
  }
];

const TOOL_CAMEL_MAP = {
  ProposeMission: "proposeMission",
  ApproveMissionPlan: "approveMissionPlan",
  StartMissionRun: "startMissionRun",
  DismissHandoffItems: "dismissHandoffItems",
  EndFeatureRun: "endFeatureRun",
  UpdateMissionFeatures: "updateMissionFeatures",
  CheckMissionStateBeforeResuming: "checkMissionStateBeforeResuming"
};

const CANONICAL_TOOL_BY_LOWER = new Map();
for (const name of MISSION_TOOL_NAMES) {
  CANONICAL_TOOL_BY_LOWER.set(name.toLowerCase(), name);
  const camel = TOOL_CAMEL_MAP[name];
  CANONICAL_TOOL_BY_LOWER.set(camel.toLowerCase(), name);
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  CANONICAL_TOOL_BY_LOWER.set(kebab, name);
}

/**
 * Resolve any tool alias (`ProposeMission`, `proposeMission`, `propose-mission`) to its canonical tool name.
 *
 * @param {string} rawName
 * @returns {string | null}
 */
export function resolveCanonicalToolName(rawName) {
  if (!rawName || typeof rawName !== "string") {
    return null;
  }
  return CANONICAL_TOOL_BY_LOWER.get(rawName.trim().toLowerCase()) ?? null;
}

/**
 * Resolve `.mission` storage directory for fallback persistence when `../kernel/index.mjs` is not yet merged.
 *
 * @param {string} missionDir
 */
function resolveFallbackBaseDir(missionDir) {
  const abs = path.resolve(String(missionDir || process.cwd()));
  if (path.basename(abs) === ".mission") {
    return abs;
  }
  if (
    fs.existsSync(path.join(abs, "state.json")) ||
    fs.existsSync(path.join(abs, "features.json")) ||
    fs.existsSync(path.join(abs, "model-settings.json"))
  ) {
    return abs;
  }
  return path.join(abs, ".mission");
}

function readJsonFileSafe(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFileSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpFile, filePath);
}

function appendFallbackLog(baseDir, entry) {
  fs.mkdirSync(baseDir, { recursive: true });
  const logPath = path.join(baseDir, "progress_log.jsonl");
  const record = {
    timestamp: new Date().toISOString(),
    ...entry
  };
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

const DEFAULT_FALLBACK_MODEL_SETTINGS = {
  orchestrator: {
    providerInstanceId: "claude-agent-acp",
    model: "claude-opus-4-6",
    options: { effort: "max" }
  },
  worker: {
    providerInstanceId: "codex",
    model: "gpt-5.4",
    options: { reasoningEffort: "xhigh" }
  },
  validator: {
    providerInstanceId: "codex",
    model: "gpt-6-1-sol",
    options: { reasoningEffort: "high" }
  },
  skipScrutiny: false,
  skipUserTesting: false
};

/**
 * Create the built-in durable fallback kernel used when `../kernel/index.mjs` is not yet merged
 * in an isolated worktree.
 */
export function createFallbackKernel() {
  return {
    __isFallbackKernel: true,

    proposeMission(missionDir, input = {}) {
      const baseDir = resolveFallbackBaseDir(missionDir);
      fs.mkdirSync(baseDir, { recursive: true });
      const nowIso = new Date().toISOString();

      const milestones = Array.isArray(input.milestones)
        ? input.milestones
        : [{ id: "M1", title: "Milestone 1" }];
      const features = Array.isArray(input.features)
        ? input.features.map((f, idx) => ({
            id: f.id || `feature-${idx + 1}`,
            milestoneId: f.milestoneId || milestones[0]?.id || "M1",
            title: f.title || f.id || `Feature ${idx + 1}`,
            description: f.description || "",
            kind: f.kind || "implementation",
            status: f.status || "pending",
            attempts: f.attempts ?? 0,
            maxAttempts: f.maxAttempts ?? 5,
            fulfills: Array.isArray(f.fulfills) ? f.fulfills : [],
            lastHandoff: f.lastHandoff ?? null
          }))
        : [];
      const assertions = Array.isArray(input.assertions)
        ? input.assertions.map((a, idx) => ({
            id: a.id || `VAL-${idx + 1}`,
            milestoneId: a.milestoneId || milestones[0]?.id || "M1",
            description: a.description || a.title || "",
            status: a.status || "pending"
          }))
        : [];

      const modelSettings = {
        ...DEFAULT_FALLBACK_MODEL_SETTINGS,
        ...(input.modelSettings || {})
      };

      const state = {
        missionId: input.missionId || `m_${crypto.randomBytes(6).toString("hex")}`,
        title: input.title || "T3 Mission",
        goal: input.goal || input.summary || "",
        status: "awaiting_input",
        planAccepted: false,
        milestones,
        assertions,
        activeWorker: null,
        sessions: [],
        milestoneValidationTriggered: {},
        lastHandoffNeedsAttention: false,
        revision: 1,
        createdAt: nowIso,
        updatedAt: nowIso
      };

      writeJsonFileSafe(path.join(baseDir, "state.json"), state);
      writeJsonFileSafe(path.join(baseDir, "features.json"), {
        features,
        updatedAt: nowIso
      });
      writeJsonFileSafe(path.join(baseDir, "model-settings.json"), modelSettings);
      appendFallbackLog(baseDir, {
        type: "propose_mission",
        message: "ProposeMission submitted",
        featureId: null,
        workerNumber: null
      });

      return { state, features, modelSettings };
    },

    approveMissionPlan(missionDir, input = {}) {
      const baseDir = resolveFallbackBaseDir(missionDir);
      const statePath = path.join(baseDir, "state.json");
      const state = readJsonFileSafe(statePath, {
        missionId: `m_${crypto.randomBytes(6).toString("hex")}`,
        title: "T3 Mission",
        status: "awaiting_input",
        planAccepted: false,
        milestones: [{ id: "M1", title: "Milestone 1" }],
        assertions: [],
        activeWorker: null,
        sessions: [],
        revision: 1
      });

      if (input.modelSettings && typeof input.modelSettings === "object") {
        const currentSettings = readJsonFileSafe(
          path.join(baseDir, "model-settings.json"),
          DEFAULT_FALLBACK_MODEL_SETTINGS
        );
        writeJsonFileSafe(path.join(baseDir, "model-settings.json"), {
          ...currentSettings,
          ...input.modelSettings
        });
      }

      state.planAccepted = true;
      state.status = "orchestrator_turn";
      state.revision = (state.revision || 1) + 1;
      state.updatedAt = new Date().toISOString();
      writeJsonFileSafe(statePath, state);
      appendFallbackLog(baseDir, {
        type: "plan_approved",
        message: "Mission plan approved",
        featureId: null,
        workerNumber: null
      });
      return state;
    },

    async startMissionRun(missionDir, options = {}, dispatchAdapter = {}) {
      const baseDir = resolveFallbackBaseDir(missionDir);
      const statePath = path.join(baseDir, "state.json");
      const featuresPath = path.join(baseDir, "features.json");
      const modelSettingsPath = path.join(baseDir, "model-settings.json");

      const state = readJsonFileSafe(statePath, null);
      if (!state) {
        throw new Error(`Mission state not found in ${baseDir}`);
      }
      if (state.planAccepted !== true) {
        throw new Error("PLAN_ACCEPTANCE_REQUIRED: Mission plan must be approved before starting a mission run");
      }

      const featuresDoc = readJsonFileSafe(featuresPath, { features: [] });
      const modelSettings = readJsonFileSafe(modelSettingsPath, DEFAULT_FALLBACK_MODEL_SETTINGS);
      const nowIso = new Date().toISOString();

      const wasPaused = state.status === "paused";
      if (wasPaused && state.activeWorker && options?.restartFeature !== true) {
        state.status = "running";
        state.activeWorker = {
          ...state.activeWorker,
          status: "running",
          resumedAt: nowIso
        };
        state.revision = (state.revision || 1) + 1;
        writeJsonFileSafe(statePath, state);

        let resumeInfo = null;
        if (typeof dispatchAdapter?.resumeWorker === "function") {
          resumeInfo = await dispatchAdapter.resumeWorker(state.activeWorker, options, state);
        }
        return {
          ...state,
          resumed: true,
          resumeResult: resumeInfo
        };
      }

      const nextFeature = featuresDoc.features.find((f) => f.status === "pending");
      if (!nextFeature) {
        state.status = "completed";
        state.activeWorker = null;
        state.revision = (state.revision || 1) + 1;
        writeJsonFileSafe(statePath, state);
        return state;
      }

      nextFeature.status = "running";
      nextFeature.attempts = (nextFeature.attempts || 0) + 1;
      writeJsonFileSafe(featuresPath, {
        ...featuresDoc,
        updatedAt: nowIso
      });

      const isValidator =
        nextFeature.kind === "scrutiny" ||
        nextFeature.kind === "user_testing" ||
        nextFeature.kind === "user-testing" ||
        nextFeature.kind === "validator" ||
        nextFeature.kind === "review" ||
        nextFeature.kind === "test";
      const slotName = isValidator ? "validator" : "worker";
      const slotConfig = modelSettings[slotName] || DEFAULT_FALLBACK_MODEL_SETTINGS[slotName];
      const workerNumber = (Array.isArray(state.sessions) ? state.sessions.length : 0) + 1;

      const activeWorker = {
        runId: `run_${crypto.randomBytes(6).toString("hex")}`,
        workerNumber,
        featureId: nextFeature.id,
        featureTitle: nextFeature.title,
        milestoneId: nextFeature.milestoneId || "M1",
        kind: nextFeature.kind || "implementation",
        slot: slotName,
        providerInstanceId: slotConfig.providerInstanceId,
        model: slotConfig.model,
        options: slotConfig.options || {},
        status: "running",
        attempt: nextFeature.attempts,
        startedAt: nowIso
      };

      state.status = "running";
      state.activeWorker = activeWorker;
      state.sessions = [...(Array.isArray(state.sessions) ? state.sessions : []), { ...activeWorker }];
      state.revision = (state.revision || 1) + 1;
      writeJsonFileSafe(statePath, state);

      let dispatchResult = null;
      if (typeof dispatchAdapter?.runFeature === "function") {
        dispatchResult = await dispatchAdapter.runFeature(nextFeature, slotConfig, state);
        if (dispatchResult?.childThreadId || dispatchResult?.taskId) {
          state.activeWorker = {
            ...state.activeWorker,
            childThreadId: dispatchResult.childThreadId ?? state.activeWorker.childThreadId,
            taskId: dispatchResult.taskId ?? state.activeWorker.taskId
          };
          writeJsonFileSafe(statePath, state);
        }
      }

      return {
        ...state,
        dispatchResult
      };
    },

    dismissHandoffItems(missionDir, input = {}) {
      const baseDir = resolveFallbackBaseDir(missionDir);
      const statePath = path.join(baseDir, "state.json");
      const state = readJsonFileSafe(statePath, {});
      state.lastHandoffNeedsAttention = false;
      state.dismissals = [
        ...(Array.isArray(state.dismissals) ? state.dismissals : []),
        ...(Array.isArray(input.dismissals) ? input.dismissals : [])
      ];
      state.revision = (state.revision || 1) + 1;
      writeJsonFileSafe(statePath, state);
      return state;
    },

    endFeatureRun(missionDir, input = {}) {
      const baseDir = resolveFallbackBaseDir(missionDir);
      const statePath = path.join(baseDir, "state.json");
      const featuresPath = path.join(baseDir, "features.json");
      const state = readJsonFileSafe(statePath, {});
      const featuresDoc = readJsonFileSafe(featuresPath, { features: [] });
      const targetFeatureId = input.featureId || state.activeWorker?.featureId;
      const nowIso = new Date().toISOString();
      const successState = input.successState || "success";

      const featureIdx = featuresDoc.features.findIndex((f) => f.id === targetFeatureId);
      if (featureIdx !== -1) {
        featuresDoc.features[featureIdx].status = successState === "success" ? "completed" : "pending";
        featuresDoc.features[featureIdx].lastHandoff = {
          ...(input.handoff || {}),
          successState,
          validatorsPassed: Boolean(input.validatorsPassed ?? true),
          completedAt: nowIso
        };
      }

      state.activeWorker = null;
      state.lastHandoffAt = nowIso;
      state.revision = (state.revision || 1) + 1;
      const shouldReturnToOrchestrator =
        successState !== "success" ||
        input.returnToOrchestrator === true ||
        (Array.isArray(input.handoff?.discoveredIssues) && input.handoff.discoveredIssues.length > 0);
      if (shouldReturnToOrchestrator) {
        state.status = "orchestrator_turn";
      }

      writeJsonFileSafe(statePath, state);
      writeJsonFileSafe(featuresPath, { ...featuresDoc, updatedAt: nowIso });
      return {
        shouldReturnToOrchestrator,
        feature: featureIdx !== -1 ? featuresDoc.features[featureIdx] : null,
        state
      };
    },

    updateMissionFeatures(missionDir, input = {}) {
      const baseDir = resolveFallbackBaseDir(missionDir);
      const statePath = path.join(baseDir, "state.json");
      const featuresPath = path.join(baseDir, "features.json");
      const state = readJsonFileSafe(statePath, {});
      const featuresDoc = readJsonFileSafe(featuresPath, { features: [] });
      const nowIso = new Date().toISOString();

      if (Array.isArray(input.features)) {
        featuresDoc.features = input.features;
      } else {
        if (Array.isArray(input.addFeatures)) {
          featuresDoc.features.push(...input.addFeatures);
        }
        if (Array.isArray(input.updateFeatures)) {
          for (const patch of input.updateFeatures) {
            const idx = featuresDoc.features.findIndex((f) => f.id === patch.id);
            if (idx !== -1) {
              featuresDoc.features[idx] = { ...featuresDoc.features[idx], ...patch };
            }
          }
        }
      }

      state.lastHandoffNeedsAttention = false;
      state.revision = (state.revision || 1) + 1;
      writeJsonFileSafe(statePath, state);
      writeJsonFileSafe(featuresPath, { ...featuresDoc, updatedAt: nowIso });
      return {
        state,
        features: featuresDoc.features
      };
    },

    tryLoadState(missionDir) {
      const baseDir = resolveFallbackBaseDir(missionDir);
      return readJsonFileSafe(path.join(baseDir, "state.json"), null);
    },

    reconcileMissionOnLoad(missionDir) {
      const baseDir = resolveFallbackBaseDir(missionDir);
      const statePath = path.join(baseDir, "state.json");
      const state = readJsonFileSafe(statePath, null);
      if (!state) {
        return null;
      }
      if (state.status === "running" || state.status === "initializing" || state.status === "orchestrator_turn") {
        const nowIso = new Date().toISOString();
        state.status = "paused";
        if (state.activeWorker && state.activeWorker.status === "running") {
          state.activeWorker = {
            ...state.activeWorker,
            status: "paused",
            pausedAt: nowIso
          };
        }
        state.revision = (state.revision || 1) + 1;
        writeJsonFileSafe(statePath, state);
      }
      return state;
    }
  };
}

/**
 * Dynamically import `../kernel/index.mjs` if available; otherwise return the fallback kernel.
 *
 * @param {Record<string, unknown>} [options={}]
 */
export async function resolveMissionKernel(options = {}) {
  if (options.kernel && typeof options.kernel === "object") {
    return options.kernel;
  }
  try {
    const kernelUrl = new URL("../kernel/index.mjs", import.meta.url);
    if (fs.existsSync(fileURLToPath(kernelUrl))) {
      return await import(kernelUrl.href);
    }
  } catch {
    // Fall back to built-in durable kernel when ../kernel/index.mjs is not yet merged
  }
  return createFallbackKernel();
}

/**
 * Helper to call a function on either the real kernel (`(missionDir, payload, adapter)`)
 * or a mock kernel (`(payload)` or `(missionDir, payload)`).
 */
async function invokeKernelFunction(kernel, fn, missionDir, payload, extraArg) {
  const isStandardKernel =
    Boolean(kernel.__isFallbackKernel) ||
    typeof kernel.resolveMissionBaseDir === "function";

  if (isStandardKernel) {
    return await fn.call(kernel, missionDir, payload, extraArg);
  }

  // Inspect parameter signature for mock kernels
  const fnSource = Function.prototype.toString.call(fn).trim();
  const paramMatch = fnSource.match(/^(?:async\s+)?(?:function\s*[^(]*\(([^)]*)\)|\(([^)]*)\)\s*=>|([A-Za-z0-9_$]+)\s*=>)/);
  const rawParams = (paramMatch?.[1] ?? paramMatch?.[2] ?? paramMatch?.[3] ?? "").trim();
  const paramList = rawParams
    ? rawParams.split(",").map((p) => p.trim()).filter(Boolean)
    : [];

  const firstParam = paramList[0] || "";
  const expectsMissionDirFirst =
    /^(missionDir|dir|baseDir|projectDir)\b/i.test(firstParam) ||
    (paramList.length >= 2 && !firstParam.startsWith("{") && !/^(args|input|payload|params|opts|options)\b/i.test(firstParam));

  if (expectsMissionDirFirst) {
    return await fn.call(kernel, missionDir, payload, extraArg);
  }
  return await fn.call(kernel, payload, missionDir, extraArg);
}

/**
 * Execute one of the 7 Mission tools (`VAL-BRIDGE-003`).
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} [rawArgs={}]
 * @param {Record<string, unknown>} [context={}]
 */
export async function callMissionTool(toolName, rawArgs = {}, context = {}) {
  const canonicalName = resolveCanonicalToolName(toolName);
  if (!canonicalName) {
    const err = new Error(`Unknown mission tool: "${toolName}"`);
    /** @type {any} */ (err).code = -32601;
    throw err;
  }

  const args = rawArgs && typeof rawArgs === "object" ? { ...rawArgs } : {};
  const missionDir = String(
    args.missionDir ?? context.missionDir ?? process.cwd()
  ).trim();
  args.missionDir = missionDir;

  const kernel = await resolveMissionKernel(context);
  const adapter =
    context.adapter ??
    createT3Adapter({
      env: context.env ?? process.env,
      transportClient: context.transportClient,
      execFileImpl: context.execFileImpl
    });

  if (canonicalName === "CheckMissionStateBeforeResuming") {
    const customFn =
      kernel.CheckMissionStateBeforeResuming ??
      kernel.checkMissionStateBeforeResuming;

    let missionState = null;
    if (typeof customFn === "function") {
      const customResult = await invokeKernelFunction(kernel, customFn, missionDir, args, adapter);
      if (customResult && typeof customResult === "object" && customResult.gitCheck) {
        return customResult;
      }
      missionState = customResult?.state ?? customResult;
    } else if (typeof kernel.reconcileMissionOnLoad === "function") {
      missionState =
        args.reconcile === false && typeof kernel.tryLoadState === "function"
          ? kernel.tryLoadState(missionDir)
          : kernel.reconcileMissionOnLoad(missionDir);
    } else if (typeof kernel.tryLoadState === "function") {
      missionState = kernel.tryLoadState(missionDir);
    } else {
      missionState = createFallbackKernel().tryLoadState(missionDir);
    }

    const activeWorker = missionState?.activeWorker ?? null;
    const targetTreePath =
      args.worktreePath ??
      activeWorker?.worktreePath ??
      args.repoPath ??
      missionState?.worktreePath ??
      missionState?.repoPath ??
      missionDir;

    const gitCheck = await adapter.checkGitTreeBeforeResume(String(targetTreePath), {
      featureId: activeWorker?.featureId ?? missionState?.currentFeatureId ?? null,
      workerTitle: activeWorker?.featureTitle ?? activeWorker?.title ?? null
    });

    const hasInterruptedWorker = Boolean(
      activeWorker &&
        (missionState?.status === "paused" ||
          activeWorker.status === "paused" ||
          activeWorker.status === "running")
    );
    const childThreadId = activeWorker?.childThreadId ?? activeWorker?.threadId ?? null;

    return {
      ok: true,
      tool: "CheckMissionStateBeforeResuming",
      missionDir,
      status: missionState?.status ?? "not_found",
      state: missionState,
      activeWorker,
      hasInterruptedWorker,
      shouldResumeExistingThread: Boolean(hasInterruptedWorker && childThreadId),
      childThreadId,
      canResume: Boolean(gitCheck.canResume),
      gitCheck,
      summary: gitCheck.summary
    };
  }

  const camelName = TOOL_CAMEL_MAP[canonicalName];
  const fn = kernel[canonicalName] ?? kernel[camelName];
  if (typeof fn !== "function") {
    const fallback = createFallbackKernel();
    const fallbackFn = fallback[canonicalName] ?? fallback[camelName];
    if (typeof fallbackFn !== "function") {
      throw new Error(`Kernel does not implement tool "${canonicalName}"`);
    }
    return await fallbackFn.call(fallback, missionDir, args, {});
  }

  if (canonicalName === "StartMissionRun") {
    const hasLiveT3Transport = Boolean(
      args.dispatchAdapter ||
        context.dispatchAdapter ||
        context.adapter ||
        context.transportClient ||
        context.kernel ||
        (context.env ?? process.env)?.T3_ACP_MCP_NODE
    );
    const dispatchAdapter =
      args.dispatchAdapter ??
      context.dispatchAdapter ??
      (hasLiveT3Transport ? adapter : {});
    return await invokeKernelFunction(kernel, fn, missionDir, args, dispatchAdapter);
  }

  return await invokeKernelFunction(kernel, fn, missionDir, args, adapter);
}

/**
 * Handle a single JSON-RPC 2.0 request or notification object (`VAL-BRIDGE-003`).
 *
 * @param {Record<string, unknown>} message
 * @param {Record<string, unknown>} [context={}]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function handleJsonRpcMessage(message, context = {}) {
  if (!message || typeof message !== "object") {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Invalid Request"
      }
    };
  }

  const { id, method, params } = message;
  const isNotification = id === undefined;

  try {
    if (method === "notifications/initialized" || method === "initialized") {
      return null;
    }

    if (method === "initialize") {
      const protocolVersion =
        params && typeof params === "object" && typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : "2024-11-05";
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion,
          capabilities: {
            tools: {
              listChanged: false
            }
          },
          serverInfo: {
            name: "t3-mission-mcp-server",
            version: "1.0.0"
          }
        }
      };
    }

    if (method === "ping") {
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {}
      };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          tools: MISSION_TOOLS
        }
      };
    }

    if (method === "tools/call") {
      const rawToolName = params && typeof params === "object" ? params.name : undefined;
      const rawToolArgs =
        params && typeof params === "object" && params.arguments && typeof params.arguments === "object"
          ? params.arguments
          : {};

      const canonical = resolveCanonicalToolName(String(rawToolName || ""));
      if (!canonical) {
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          error: {
            code: -32602,
            message: `Unknown tool: ${String(rawToolName || "")}`
          }
        };
      }

      const toolResult = await callMissionTool(canonical, rawToolArgs, context);
      const serialized = JSON.stringify(toolResult);
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          content: [
            {
              type: "text",
              text: serialized
            }
          ],
          structuredContent: toolResult,
          isError: false
        }
      };
    }

    if (isNotification) {
      return null;
    }

    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code: -32601,
        message: `Method not found: ${String(method)}`
      }
    };
  } catch (error) {
    if (isNotification) {
      return null;
    }
    const errMessage = error instanceof Error ? error.message : String(error);
    const errCode =
      error && typeof error === "object" && typeof /** @type {any} */ (error).code === "number"
        ? /** @type {any} */ (error).code
        : -32000;

    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code: errCode,
        message: errMessage,
        data:
          error && typeof error === "object" && "code" in error
            ? { kernelCode: /** @type {any} */ (error).code }
            : undefined
      }
    };
  }
}

/**
 * Create an in-memory or stream-attachable Mission MCP Server instance.
 *
 * @param {Record<string, unknown>} [context={}]
 */
export function createMissionMcpServer(context = {}) {
  return {
    tools: MISSION_TOOLS,
    toolNames: MISSION_TOOL_NAMES,
    callTool: (name, args, overrideContext) =>
      callMissionTool(name, args, { ...context, ...(overrideContext || {}) }),
    handleRequest: (message, overrideContext) =>
      handleJsonRpcMessage(message, { ...context, ...(overrideContext || {}) }),
    handleJsonRpcMessage: (message, overrideContext) =>
      handleJsonRpcMessage(message, { ...context, ...(overrideContext || {}) }),
    startStdio: (stdioOptions = {}) =>
      startStdioMcpServer({ ...context, ...stdioOptions })
  };
}

/**
 * Start the JSON-RPC 2.0 MCP Server over `stdin` / `stdout` (NDJSON lines).
 *
 * @param {Record<string, unknown>} [options={}]
 */
export function startStdioMcpServer(options = {}) {
  const input = /** @type {NodeJS.ReadableStream} */ (options.input ?? process.stdin);
  const output = /** @type {NodeJS.WritableStream} */ (options.output ?? process.stdout);

  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
    terminal: false
  });

  const pending = new Set();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed || /^Content-Length:/i.test(trimmed)) {
      return;
    }

    const task = (async () => {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const parseErr = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error"
          }
        };
        output.write(`${JSON.stringify(parseErr)}\n`);
        return;
      }

      if (Array.isArray(parsed)) {
        const responses = [];
        for (const item of parsed) {
          const res = await handleJsonRpcMessage(item, options);
          if (res !== null) {
            responses.push(res);
          }
        }
        if (responses.length > 0) {
          output.write(`${JSON.stringify(responses)}\n`);
        }
        return;
      }

      const response = await handleJsonRpcMessage(parsed, options);
      if (response !== null) {
        output.write(`${JSON.stringify(response)}\n`);
      }
    })();

    pending.add(task);
    task.finally(() => pending.delete(task));
  });

  return {
    close: async () => {
      rl.close();
      await Promise.allSettled([...pending]);
    }
  };
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  startStdioMcpServer();
}

export default {
  MISSION_TOOL_NAMES,
  MISSION_TOOLS,
  resolveCanonicalToolName,
  resolveMissionKernel,
  callMissionTool,
  handleJsonRpcMessage,
  createMissionMcpServer,
  startStdioMcpServer,
  normalizeTargetFromSlot,
  resolveTargetFromModelSettings,
  delegateMissionTask,
  checkGitTreeBeforeResume,
  resumeWorker,
  settleCompletedMilestoneThreads
};
