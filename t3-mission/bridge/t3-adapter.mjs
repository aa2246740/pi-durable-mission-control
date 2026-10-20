import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

export const VALID_DELEGATE_ROLES = new Set([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general"
]);

export const ROLE_BY_MISSION_KIND = {
  worker: "implementation",
  implementation: "implementation",
  validator: "review",
  scrutiny: "review",
  review: "review",
  "user-testing": "test",
  user_testing: "test",
  test: "test",
  explorer: "research",
  research: "research",
  design: "design",
  general: "general"
};

export const EFFORT_LEVEL_TO_STRING = {
  1: "minimal",
  2: "low",
  3: "medium",
  4: "high",
  5: "max"
};

export const VALID_CODEX_REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
]);

function extractNumericEffort(value) {
  if (typeof value === "number" && Number.isInteger(value) && EFFORT_LEVEL_TO_STRING[value]) {
    return value;
  }
  if (typeof value === "string" && /^[1-5]$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/**
 * Normalize a model slot configuration from `.mission/model-settings.json`
 * into the `target: { providerInstanceId, model, options }` shape required by
 * T3 Code Orchestration V2 `delegate_task` (VAL-BRIDGE-001).
 *
 * Provider-specific mapping rules:
 * - `codex`: puts reasoning strength into `options.reasoningEffort`
 *   (`"minimal" | "low" | "medium" | "high" | "xhigh" | "max"`)
 * - `antigravity`: directly uses the corresponding `model` ID
 *   (e.g. `"gemini-4-argon-high"`, `"claude-opus-5-5-high"`)
 * - `acpRegistry_factory_droid`: puts reasoning strength into
 *   `options.reasoning_effort` and sets `options.autonomy_level: "auto-high"`
 * - `pi`: puts thinking strength into `options.thinking`
 *
 * @param {Record<string, unknown> | null | undefined} slotConfig
 * @returns {{ providerInstanceId: string, model: string, options: Record<string, unknown> }}
 */
export function normalizeTargetFromSlot(slotConfig) {
  if (!slotConfig || typeof slotConfig !== "object") {
    throw new TypeError("slotConfig must be a non-null object");
  }

  const rawProvider =
    slotConfig.providerInstanceId ??
    slotConfig.provider ??
    slotConfig.providerId ??
    "";
  const providerInstanceId = String(rawProvider).trim();
  if (!providerInstanceId) {
    throw new Error("slotConfig.providerInstanceId is required");
  }

  const rawModel = slotConfig.model ?? slotConfig.modelId ?? "";
  const model = String(rawModel).trim();
  if (!model) {
    throw new Error("slotConfig.model is required");
  }

  const rawOptions =
    slotConfig.options && typeof slotConfig.options === "object" && !Array.isArray(slotConfig.options)
      ? { ...slotConfig.options }
      : {};

  const topNumericEffort = extractNumericEffort(slotConfig.effort);
  const optionsNumericEffort = extractNumericEffort(rawOptions.effort);
  const numericEffort = topNumericEffort ?? optionsNumericEffort;

  const explicitReasoningRaw =
    slotConfig.reasoningEffort ??
    slotConfig.reasoning_effort ??
    slotConfig.thinking ??
    rawOptions.reasoningEffort ??
    rawOptions.reasoning_effort ??
    rawOptions.thinking;
  const explicitReasoning =
    explicitReasoningRaw !== undefined && explicitReasoningRaw !== null
      ? String(explicitReasoningRaw).trim()
      : "";

  let effortValue;
  if (typeof numericEffort === "number" && EFFORT_LEVEL_TO_STRING[numericEffort]) {
    if (numericEffort === 5 && explicitReasoning.toLowerCase() === "xhigh") {
      effortValue = "xhigh";
    } else {
      effortValue = EFFORT_LEVEL_TO_STRING[numericEffort];
    }
  } else {
    const rawFallbackEffort =
      explicitReasoning ||
      (slotConfig.effort !== undefined && slotConfig.effort !== null
        ? String(slotConfig.effort).trim()
        : "") ||
      (rawOptions.effort !== undefined && rawOptions.effort !== null
        ? String(rawOptions.effort).trim()
        : "");
    effortValue = rawFallbackEffort || undefined;
  }

  const options = {};

  if (providerInstanceId === "codex") {
    for (const [key, val] of Object.entries(rawOptions)) {
      if (
        key !== "effort" &&
        key !== "reasoningEffort" &&
        key !== "reasoning_effort" &&
        key !== "thinking" &&
        val !== undefined
      ) {
        options[key] = val;
      }
    }
    if (effortValue !== undefined && effortValue !== null && String(effortValue).trim() !== "") {
      const normalizedEffort = String(effortValue).trim().toLowerCase();
      options.reasoningEffort = VALID_CODEX_REASONING_EFFORTS.has(normalizedEffort)
        ? normalizedEffort
        : String(effortValue).trim();
    }
  } else if (providerInstanceId === "antigravity") {
    for (const [key, val] of Object.entries(rawOptions)) {
      if (
        key !== "effort" &&
        key !== "reasoningEffort" &&
        key !== "reasoning_effort" &&
        key !== "thinking" &&
        val !== undefined
      ) {
        options[key] = val;
      }
    }
  } else if (providerInstanceId === "acpRegistry_factory_droid") {
    for (const [key, val] of Object.entries(rawOptions)) {
      if (
        key !== "effort" &&
        key !== "reasoningEffort" &&
        key !== "reasoning_effort" &&
        key !== "thinking" &&
        val !== undefined
      ) {
        options[key] = val;
      }
    }
    if (effortValue !== undefined && effortValue !== null && String(effortValue).trim() !== "") {
      options.reasoning_effort = String(effortValue).trim();
    }
    const autonomyLevel =
      slotConfig.autonomy_level ??
      slotConfig.autonomyLevel ??
      rawOptions.autonomy_level ??
      rawOptions.autonomyLevel ??
      "auto-high";
    options.autonomy_level = String(autonomyLevel).trim() || "auto-high";
  } else if (providerInstanceId === "pi") {
    for (const [key, val] of Object.entries(rawOptions)) {
      if (
        key !== "effort" &&
        key !== "reasoningEffort" &&
        key !== "reasoning_effort" &&
        key !== "thinking" &&
        val !== undefined
      ) {
        options[key] = val;
      }
    }
    if (effortValue !== undefined && effortValue !== null && String(effortValue).trim() !== "") {
      options.thinking = String(effortValue).trim();
    }
  } else {
    for (const [key, val] of Object.entries(rawOptions)) {
      if (val !== undefined) {
        options[key] = val;
      }
    }
    if (effortValue !== undefined && effortValue !== null && String(effortValue).trim() !== "") {
      options.effort = String(effortValue).trim();
    }
  }

  return {
    providerInstanceId,
    model,
    options
  };
}

/**
 * Resolve a normalized T3 target from `.mission/model-settings.json` for a given role/slot.
 *
 * @param {Record<string, unknown>} modelSettings
 * @param {string} [roleOrSlot="worker"]
 * @returns {{ providerInstanceId: string, model: string, options: Record<string, unknown> }}
 */
export function resolveTargetFromModelSettings(modelSettings, roleOrSlot = "worker") {
  if (!modelSettings || typeof modelSettings !== "object") {
    throw new TypeError("modelSettings must be a non-null object");
  }
  const slots =
    modelSettings.slots && typeof modelSettings.slots === "object"
      ? modelSettings.slots
      : modelSettings;

  const normalizedKey = String(roleOrSlot || "worker").toLowerCase().trim();
  let slotKey = normalizedKey;
  if (
    normalizedKey === "implementation" ||
    normalizedKey === "worker"
  ) {
    slotKey = "worker";
  } else if (
    normalizedKey === "review" ||
    normalizedKey === "test" ||
    normalizedKey === "scrutiny" ||
    normalizedKey === "user-testing" ||
    normalizedKey === "user_testing" ||
    normalizedKey === "validator"
  ) {
    slotKey = slots[normalizedKey] ? normalizedKey : "validator";
  } else if (normalizedKey === "orchestrator" || normalizedKey === "research" || normalizedKey === "explorer") {
    slotKey = slots[normalizedKey] ? normalizedKey : (slots.worker ? "worker" : "orchestrator");
  }

  const slotConfig = slots[slotKey] ?? slots.worker ?? slots.validator ?? slots.orchestrator;
  if (!slotConfig) {
    throw new Error(`No model slot configuration found for role "${roleOrSlot}"`);
  }
  return normalizeTargetFromSlot(slotConfig);
}

/**
 * Parse stdout returned from `acp-mcp-call` or an MCP tool response.
 *
 * @param {unknown} rawOutput
 * @returns {any}
 */
export function parseT3ToolOutput(rawOutput) {
  if (rawOutput === null || rawOutput === undefined) {
    return {};
  }
  if (typeof rawOutput === "object") {
    if (
      Array.isArray(rawOutput.content) &&
      rawOutput.content.length === 1 &&
      rawOutput.content[0]?.type === "text" &&
      typeof rawOutput.content[0]?.text === "string"
    ) {
      try {
        const parsedInner = JSON.parse(rawOutput.content[0].text);
        if (parsedInner && typeof parsedInner === "object") {
          return parsedInner;
        }
      } catch {
        // Keep raw object if inner text is not JSON
      }
    }
    return rawOutput;
  }
  const text = String(rawOutput).trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parseT3ToolOutput(parsed);
  } catch {
    return { rawOutput: text };
  }
}

/**
 * Resolve execution context (`env`, `transportClient`, `execFile`) from flexible argument shapes.
 *
 * @param {unknown} envOrOptions
 */
function resolveCallContext(envOrOptions) {
  if (typeof envOrOptions === "function") {
    return {
      env: process.env,
      transportClient: envOrOptions,
      execFileImpl: execFileAsync
    };
  }
  if (!envOrOptions || typeof envOrOptions !== "object") {
    return {
      env: process.env,
      transportClient: null,
      execFileImpl: execFileAsync
    };
  }

  const hasWrapperKeys =
    "transportClient" in envOrOptions ||
    "execFile" in envOrOptions ||
    "execFileImpl" in envOrOptions ||
    ("env" in envOrOptions && typeof envOrOptions.env === "object");

  const env = hasWrapperKeys
    ? (envOrOptions.env ?? process.env)
    : envOrOptions;

  const transportClient =
    envOrOptions.transportClient ??
    (typeof envOrOptions.callTool === "function" || typeof envOrOptions.call === "function"
      ? envOrOptions
      : null);

  const rawExecFile = envOrOptions.execFileImpl ?? envOrOptions.execFile ?? null;
  let execFileImpl = execFileAsync;
  if (typeof rawExecFile === "function") {
    execFileImpl = async (file, args, opts) => {
      if (rawExecFile.length >= 4) {
        return await new Promise((resolve, reject) => {
          rawExecFile(file, args, opts, (err, stdout, stderr) => {
            if (err) {
              reject(err);
              return;
            }
            resolve({ stdout, stderr });
          });
        });
      }
      const res = await rawExecFile(file, args, opts);
      if (typeof res === "string") {
        return { stdout: res, stderr: "" };
      }
      return res ?? { stdout: "", stderr: "" };
    };
  }

  return {
    env,
    transportClient,
    execFileImpl,
    cwd: envOrOptions.cwd,
    timeoutMs: envOrOptions.timeoutMs
  };
}

/**
 * Call a T3 Code MCP tool via injected `transportClient` or the official
 * `T3_ACP_MCP_NODE` / `T3_ACP_MCP_ENTRYPOINT` `acp-mcp-call` bridge using
 * `execFile` argument arrays (never shell string interpolation).
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} [args={}]
 * @param {Record<string, unknown> | Function} [envOrOptions=process.env]
 * @returns {Promise<any>}
 */
export async function callT3McpTool(toolName, args = {}, envOrOptions = process.env) {
  if (!toolName || typeof toolName !== "string") {
    throw new TypeError("toolName must be a non-empty string");
  }
  const payload = args && typeof args === "object" ? args : {};
  const { env, transportClient, execFileImpl, cwd, timeoutMs } = resolveCallContext(envOrOptions);

  if (transportClient) {
    if (typeof transportClient === "function") {
      const result = await transportClient(toolName, payload, env);
      return parseT3ToolOutput(result);
    }
    if (typeof transportClient.callTool === "function") {
      const result = await transportClient.callTool(toolName, payload, env);
      return parseT3ToolOutput(result);
    }
    if (typeof transportClient.call === "function") {
      const result = await transportClient.call(toolName, payload, env);
      return parseT3ToolOutput(result);
    }
    if (typeof transportClient[toolName] === "function") {
      const result = await transportClient[toolName](payload, env);
      return parseT3ToolOutput(result);
    }
  }

  const nodeBin = env?.T3_ACP_MCP_NODE ? String(env.T3_ACP_MCP_NODE).trim() : "";
  if (!nodeBin) {
    throw new Error(
      `Cannot call T3 MCP tool "${toolName}": T3_ACP_MCP_NODE is not set in env and no transportClient was provided.`
    );
  }

  const entrypoint = env?.T3_ACP_MCP_ENTRYPOINT ? String(env.T3_ACP_MCP_ENTRYPOINT).trim() : "";
  const serializedArgs = JSON.stringify(payload);
  const cliArgs = entrypoint
    ? [entrypoint, "acp-mcp-call", toolName, serializedArgs]
    : ["acp-mcp-call", toolName, serializedArgs];

  const execEnv = {
    ...env,
    ELECTRON_RUN_AS_NODE: "1"
  };

  const execOptions = {
    env: execEnv,
    maxBuffer: 16 * 1024 * 1024
  };
  if (cwd) {
    execOptions.cwd = cwd;
  }
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    execOptions.timeout = timeoutMs;
  }

  const { stdout } = await execFileImpl(nodeBin, cliArgs, execOptions);
  return parseT3ToolOutput(stdout);
}

/**
 * Normalize milestone tag into `[M1]` format.
 *
 * @param {string | number | undefined} milestone
 * @returns {string}
 */
export function formatMilestoneBadge(milestone) {
  if (milestone === undefined || milestone === null || milestone === "") {
    return "[M1]";
  }
  const raw = String(milestone).trim();
  if (/^\[M\d+[A-Za-z0-9_-]*\]$/i.test(raw)) {
    return raw.toUpperCase();
  }
  if (/^M\d+[A-Za-z0-9_-]*$/i.test(raw)) {
    return `[${raw.toUpperCase()}]`;
  }
  const match = raw.match(/(\d+)/);
  if (match) {
    return `[M${match[1]}]`;
  }
  return `[${raw.toUpperCase()}]`;
}

/**
 * Build a standardized T3 Mission task title such as:
 * - `[M1] Worker #3: Hub attachment UI`
 * - `[M1] Validator #5: Scrutiny intake`
 *
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function buildMissionTaskTitle(params = {}) {
  if (typeof params.title === "string" && /^\[M[^\]]+\]\s+(Worker|Validator|Explorer)\s+#\d+:/i.test(params.title.trim())) {
    return params.title.trim();
  }

  const badge = formatMilestoneBadge(params.milestoneId ?? params.milestone ?? params.milestoneNumber ?? 1);
  const roleInput = String(params.kind ?? params.role ?? "worker").toLowerCase().trim();

  let actorLabel = "Worker";
  if (
    roleInput === "validator" ||
    roleInput === "review" ||
    roleInput === "scrutiny" ||
    roleInput === "test" ||
    roleInput === "user-testing" ||
    roleInput === "user_testing"
  ) {
    actorLabel = "Validator";
  } else if (roleInput === "explorer" || roleInput === "research") {
    actorLabel = "Explorer";
  }

  const rawIndex =
    params.workerNumber ??
    params.validatorNumber ??
    params.sequenceNumber ??
    params.index ??
    1;
  const numMatch = String(rawIndex).match(/(\d+)/);
  const numberLabel = numMatch ? numMatch[1] : "1";

  const subject = String(
    params.title ??
      params.featureTitle ??
      params.featureName ??
      params.featureId ??
      (actorLabel === "Validator" ? "Scrutiny intake" : "Feature implementation")
  ).trim();

  return `${badge} ${actorLabel} #${numberLabel}: ${subject}`;
}

/**
 * Normalize mission task role into T3 `delegate_task` allowed role enum.
 *
 * @param {string | undefined} roleOrKind
 * @returns {"implementation" | "research" | "review" | "design" | "test" | "general"}
 */
export function normalizeDelegateRole(roleOrKind) {
  const key = String(roleOrKind || "implementation").toLowerCase().trim();
  if (ROLE_BY_MISSION_KIND[key]) {
    return ROLE_BY_MISSION_KIND[key];
  }
  if (VALID_DELEGATE_ROLES.has(key)) {
    return /** @type {any} */ (key);
  }
  return "implementation";
}

/**
 * Generate a stable idempotent `clientRequestId` for `delegate_task`.
 *
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function buildStableClientRequestId(params = {}) {
  if (typeof params.clientRequestId === "string" && params.clientRequestId.trim()) {
    return params.clientRequestId.trim();
  }
  const missionPart = String(params.missionId ?? "mission").trim();
  const milestonePart = String(params.milestoneId ?? params.milestone ?? "m1").trim().toLowerCase();
  const rolePart = normalizeDelegateRole(/** @type {string} */ (params.role ?? params.kind ?? "implementation"));
  const featurePart = String(
    params.featureId ?? params.validatorKind ?? params.workerNumber ?? params.index ?? "task-1"
  )
    .trim()
    .replace(/\s+/g, "-");
  const roundPart = Number(params.round ?? params.attempt ?? 1) || 1;
  return `t3m:${missionPart}:${milestonePart}:${featurePart}:${rolePart}:r${roundPart}`;
}

/**
 * Query live provider and model capabilities via `orchestrator_capabilities`.
 *
 * @param {Record<string, unknown> | Function} [envOrOptions=process.env]
 * @returns {Promise<any>}
 */
export async function getOrchestratorCapabilities(envOrOptions = process.env) {
  return await callT3McpTool("orchestrator_capabilities", {}, envOrOptions);
}

/**
 * Delegate a Worker, Validator, or Explorer task to T3 Orchestration V2 via `delegate_task`.
 *
 * @param {Record<string, unknown>} params
 * @param {Record<string, unknown> | Function} [envOrOptions=process.env]
 * @returns {Promise<any>}
 */
export async function delegateMissionTask(params, envOrOptions = process.env) {
  if (!params || typeof params !== "object") {
    throw new TypeError("delegateMissionTask requires a params object");
  }

  const role = normalizeDelegateRole(/** @type {string} */ (params.role ?? params.kind ?? "implementation"));
  const title = buildMissionTaskTitle(params);
  const clientRequestId = buildStableClientRequestId(params);
  const isolation = params.isolation === undefined ? "worktree" : params.isolation;
  const mode = params.mode ?? "async";
  const taskPrompt = String(params.task ?? params.prompt ?? params.instructions ?? title).trim();

  if (!taskPrompt) {
    throw new Error("delegateMissionTask requires a non-empty task prompt");
  }

  let target = null;
  if (params.target && typeof params.target === "object") {
    target = normalizeTargetFromSlot(/** @type {Record<string, unknown>} */ (params.target));
  } else if (params.slot && typeof params.slot === "object") {
    target = normalizeTargetFromSlot(/** @type {Record<string, unknown>} */ (params.slot));
  } else if (params.slotConfig && typeof params.slotConfig === "object") {
    target = normalizeTargetFromSlot(/** @type {Record<string, unknown>} */ (params.slotConfig));
  } else if (params.modelSettings && typeof params.modelSettings === "object") {
    target = resolveTargetFromModelSettings(
      /** @type {Record<string, unknown>} */ (params.modelSettings),
      String(params.kind ?? role)
    );
  }

  const delegateArgs = {
    title,
    task: taskPrompt,
    role,
    isolation,
    mode,
    clientRequestId
  };

  if (target) {
    delegateArgs.target = target;
  }
  if (params.runtimeMode) {
    delegateArgs.runtimeMode = params.runtimeMode;
  }
  if (params.interactionMode) {
    delegateArgs.interactionMode = params.interactionMode;
  }
  if (typeof params.timeoutMs === "number") {
    delegateArgs.timeoutMs = params.timeoutMs;
  }

  const response = await callT3McpTool("delegate_task", delegateArgs, envOrOptions);
  return {
    ...response,
    taskId: response?.taskId ?? null,
    childThreadId: response?.childThreadId ?? response?.threadId ?? null,
    childRunId: response?.childRunId ?? response?.runId ?? null,
    worktreePath: response?.worktreePath ?? null,
    response,
    request: delegateArgs,
    title,
    role,
    isolation,
    clientRequestId,
    target
  };
}

/**
 * Dispatch a feature from the Mission Kernel runner (`dispatchAdapter.runFeature`).
 *
 * @param {Record<string, unknown>} feature
 * @param {Record<string, unknown>} slotConfig
 * @param {Record<string, unknown>} [missionState={}]
 * @param {Record<string, unknown> | Function} [envOrOptions=process.env]
 */
export async function runFeature(feature, slotConfig, missionState = {}, envOrOptions = process.env) {
  const activeWorker = missionState?.activeWorker || {};
  const workerNumber = activeWorker.workerNumber ?? feature.workerNumber ?? 1;
  const attempt = activeWorker.attempt ?? feature.attempts ?? 1;
  const runId = activeWorker.runId ?? feature.runId ?? null;
  const featureId = feature.id ?? activeWorker.featureId ?? null;
  const baseTask =
    feature.prompt ||
    feature.description ||
    `Implement feature ${feature.id}: ${feature.title}`;
  const identityParts = [
    runId ? `runId="${runId}"` : null,
    featureId ? `featureId="${featureId}"` : null
  ].filter(Boolean);
  const task =
    identityParts.length > 0
      ? `${baseTask}\n\n[Mission Run Identity: ${identityParts.join(", ")}]`
      : baseTask;

  const delegation = await delegateMissionTask(
    {
      missionId: missionState?.missionId ?? "mission",
      milestoneId: feature.milestoneId ?? activeWorker.milestoneId ?? "M1",
      runId,
      featureId,
      featureTitle: feature.title ?? activeWorker.featureTitle,
      kind: feature.kind ?? activeWorker.kind ?? "worker",
      workerNumber,
      attempt,
      slot: slotConfig,
      task
    },
    envOrOptions
  );
  const response = delegation?.response ?? delegation;
  return {
    ...delegation,
    taskId: response?.taskId ?? delegation.taskId ?? null,
    childThreadId: response?.childThreadId ?? delegation.childThreadId ?? null,
    childRunId: response?.childRunId ?? delegation.childRunId ?? null,
    worktreePath: response?.worktreePath ?? delegation.worktreePath ?? null
  };
}

const CONFLICT_STATUS_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * Inspect the Git working tree before resuming a paused mission worker (VAL-BRIDGE-002).
 *
 * @param {string} targetPath
 * @param {Record<string, unknown>} [options={}]
 * @returns {Promise<{
 *   path: string,
 *   isGitRepo: boolean,
 *   branch: string | null,
 *   clean: boolean,
 *   hasConflicts: boolean,
 *   hasUncommittedChanges: boolean,
 *   conflictedFiles: string[],
 *   modifiedFiles: string[],
 *   statusLines: string[],
 *   canResume: boolean,
 *   error?: string,
 *   summary: string
 * }>}
 */
export async function checkGitTreeBeforeResume(targetPath, options = {}) {
  const resolvedPath = path.resolve(String(targetPath || process.cwd()));
  const featureLabel = options.featureId
    ? `feature "${options.featureId}"`
    : options.workerTitle
      ? `"${options.workerTitle}"`
      : "an active worker";

  const { execFileImpl } = resolveCallContext(options);

  try {
    const { stdout: statusStdout } = await execFileImpl(
      "git",
      ["-C", resolvedPath, "status", "--porcelain"],
      { maxBuffer: 4 * 1024 * 1024 }
    );

    let branch = null;
    try {
      const { stdout: branchStdout } = await execFileImpl(
        "git",
        ["-C", resolvedPath, "rev-parse", "--abbrev-ref", "HEAD"],
        { maxBuffer: 1024 * 1024 }
      );
      branch = String(branchStdout || "").trim() || null;
    } catch {
      branch = null;
    }

    const rawLines = String(statusStdout || "")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);

    const conflictedFiles = [];
    const modifiedFiles = [];

    for (const line of rawLines) {
      const code = line.slice(0, 2);
      const filePath = line.slice(3).trim();
      if (CONFLICT_STATUS_CODES.has(code) || code.includes("U")) {
        conflictedFiles.push(filePath);
      } else {
        modifiedFiles.push(filePath);
      }
    }

    const hasConflicts = conflictedFiles.length > 0;
    const hasUncommittedChanges = rawLines.length > 0;
    const clean = !hasUncommittedChanges && !hasConflicts;
    const canResume = !hasConflicts;

    let summary;
    if (hasConflicts) {
      summary = `The mission was paused on ${featureLabel}, and the code tree has unresolved merge conflicts (${conflictedFiles.join(", ")}), so automatic resume is blocked until conflicts are resolved.`;
    } else if (clean) {
      summary = `The mission was paused on ${featureLabel}, and the code tree has no uncommitted changes, so I'm resuming that worker.`;
    } else {
      summary = `The mission was paused on ${featureLabel}, and the code tree has ${modifiedFiles.length} uncommitted change(s) with no merge conflicts, so I'm resuming that worker.`;
    }

    return {
      path: resolvedPath,
      isGitRepo: true,
      branch,
      clean,
      hasConflicts,
      hasUncommittedChanges,
      conflictedFiles,
      modifiedFiles,
      statusLines: rawLines,
      canResume,
      summary
    };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    return {
      path: resolvedPath,
      isGitRepo: false,
      branch: null,
      clean: false,
      hasConflicts: false,
      hasUncommittedChanges: false,
      conflictedFiles: [],
      modifiedFiles: [],
      statusLines: [],
      canResume: false,
      error: errMessage,
      summary: `Cannot resume mission: Git inspection failed (${errMessage}).`
    };
  }
}

/**
 * Resume an interrupted/paused Worker without losing conversation context (VAL-BRIDGE-002).
 *
 * 1. Runs `checkGitTreeBeforeResume(worktreePath || repoPath)` to verify workspace state.
 * 2. If `!preflight.canResume || preflight.hasConflicts`, fails closed without dispatching.
 * 3. If `activeWorker.childThreadId` exists, calls `t3_thread_send({ threadId: activeWorker.childThreadId, message })`
 *    to wake up the original worker thread instead of spawning a duplicate worker.
 * 4. Falls back to `delegateMissionTask` only if no `childThreadId` exists.
 *
 * @param {Record<string, unknown>} params
 * @param {Record<string, unknown> | Function} [envOrOptions=process.env]
 * @param {Record<string, unknown>} [maybeMissionState]
 */
export async function resumeWorker(params, envOrOptions = process.env, maybeMissionState = undefined) {
  if (!params || typeof params !== "object") {
    throw new TypeError("resumeWorker requires a params object");
  }

  const missionState =
    maybeMissionState ??
    (params.missionState && typeof params.missionState === "object" ? params.missionState : undefined);

  const activeWorker =
    (params.activeWorker && typeof params.activeWorker === "object"
      ? params.activeWorker
      : missionState?.activeWorker && typeof missionState.activeWorker === "object"
        ? missionState.activeWorker
        : params) || {};

  const targetWorktreePath =
    params.worktreePath ??
    activeWorker.worktreePath ??
    (typeof envOrOptions === "object" && envOrOptions ? envOrOptions.worktreePath ?? envOrOptions.repoPath : undefined) ??
    params.repoPath ??
    missionState?.worktreePath ??
    missionState?.repoPath ??
    process.cwd();

  const featureId =
    params.featureId ??
    activeWorker.featureId ??
    missionState?.currentFeatureId ??
    null;

  const preflight =
    params.preflight && typeof params.preflight === "object"
      ? params.preflight
      : params.gitCheck && typeof params.gitCheck === "object"
        ? params.gitCheck
        : await checkGitTreeBeforeResume(String(targetWorktreePath), {
            ...(typeof envOrOptions === "object" ? envOrOptions : {}),
            featureId,
            workerTitle: activeWorker.featureTitle ?? activeWorker.title
          });

  if ((!preflight.canResume || preflight.hasConflicts) && params.allowConflicts !== true) {
    const blockedStatus = preflight.hasConflicts ? "blocked_by_conflicts" : "blocked_by_git_error";
    return {
      resumed: false,
      canResume: false,
      status: blockedStatus,
      action: blockedStatus,
      reason: preflight.summary,
      preflight,
      gitCheck: preflight,
      summary: preflight.summary,
      threadId: activeWorker.childThreadId ?? activeWorker.threadId ?? null,
      childThreadId: activeWorker.childThreadId ?? activeWorker.threadId ?? null,
      taskId: activeWorker.taskId ?? null,
      childRunId: activeWorker.childRunId ?? null,
      worktreePath: preflight.path ?? String(targetWorktreePath)
    };
  }

  const childThreadId = String(
    activeWorker.childThreadId ?? activeWorker.threadId ?? params.childThreadId ?? params.threadId ?? ""
  ).trim();

  const defaultResumeMessage = [
    "[resume the mission]",
    preflight.summary,
    featureId ? `Continue implementing feature "${featureId}" and complete verification.` : "Continue the interrupted worker task and complete verification."
  ].join("\n\n");

  const message = String(params.message ?? params.prompt ?? defaultResumeMessage).trim();

  if (childThreadId) {
    const clientRequestId =
      params.clientRequestId ??
      `t3m:resume:${params.missionId ?? missionState?.missionId ?? "mission"}:${featureId ?? "worker"}:${childThreadId}`;

    const sendArgs = {
      threadId: childThreadId,
      message,
      mode: params.mode ?? "auto",
      clientRequestId
    };

    const response = await callT3McpTool("t3_thread_send", sendArgs, envOrOptions);
    return {
      resumed: true,
      canResume: true,
      status: "running",
      action: "t3_thread_send",
      threadId: childThreadId,
      childThreadId,
      taskId: response?.taskId ?? activeWorker.taskId ?? null,
      childRunId: response?.childRunId ?? activeWorker.childRunId ?? null,
      worktreePath: preflight.path ?? String(targetWorktreePath),
      preflight,
      gitCheck: preflight,
      summary: preflight.summary,
      request: sendArgs,
      response
    };
  }

  // Fallback if activeWorker had no childThreadId recorded yet
  const delegated = await delegateMissionTask(
    {
      ...activeWorker,
      ...params,
      featureId: featureId ?? "feature-resume",
      task: message
    },
    envOrOptions
  );

  return {
    resumed: true,
    canResume: true,
    status: "running",
    action: "delegate_task",
    threadId: delegated.childThreadId ?? null,
    childThreadId: delegated.childThreadId ?? null,
    taskId: delegated.taskId ?? activeWorker.taskId ?? null,
    childRunId: delegated.childRunId ?? activeWorker.childRunId ?? null,
    worktreePath: delegated.worktreePath ?? preflight.path ?? String(targetWorktreePath),
    preflight,
    gitCheck: preflight,
    summary: preflight.summary,
    response: delegated
  };
}

/**
 * Settle completed worker/validator child threads after a Milestone passes validation.
 *
 * @param {Array<string | { childThreadId?: string, threadId?: string }>} childThreadIds
 * @param {Record<string, unknown> | Function} [envOrOptions=process.env]
 */
export async function settleCompletedMilestoneThreads(childThreadIds = [], envOrOptions = process.env) {
  const list = Array.isArray(childThreadIds) ? childThreadIds : [childThreadIds];
  const uniqueIds = [];
  const seen = new Set();

  for (const item of list) {
    const rawId =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? (item.childThreadId ?? item.threadId ?? "")
          : "";
    const id = String(rawId || "").trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  const results = [];
  for (const threadId of uniqueIds) {
    const res = await callT3McpTool(
      "t3_thread_organize",
      {
        action: "settle",
        threadId
      },
      envOrOptions
    );
    results.push({ threadId, response: res });
  }

  return {
    action: "settle",
    settledThreadIds: uniqueIds,
    results
  };
}

/**
 * Create a bound T3 Orchestration V2 Adapter instance.
 *
 * @param {Record<string, unknown>} [defaultOptions={}]
 */
export function createT3Adapter(defaultOptions = {}) {
  return {
    normalizeTargetFromSlot,
    resolveTargetFromModelSettings,
    callT3McpTool: (toolName, args, opts) =>
      callT3McpTool(toolName, args, opts ?? defaultOptions),
    getOrchestratorCapabilities: (opts) =>
      getOrchestratorCapabilities(opts ?? defaultOptions),
    delegateMissionTask: (params, opts) =>
      delegateMissionTask(params, opts ?? defaultOptions),
    runFeature: (feature, slotConfig, missionState, opts) =>
      runFeature(feature, slotConfig, missionState, opts ?? defaultOptions),
    checkGitTreeBeforeResume: (worktreePath, opts) =>
      checkGitTreeBeforeResume(worktreePath, { ...defaultOptions, ...(opts || {}) }),
    resumeWorker: (params, opts, maybeState) =>
      resumeWorker(params, { ...defaultOptions, ...(typeof opts === "object" ? opts : {}) }, maybeState),
    settleCompletedMilestoneThreads: (childThreadIds, opts) =>
      settleCompletedMilestoneThreads(childThreadIds, opts ?? defaultOptions)
  };
}

export default {
  EFFORT_LEVEL_TO_STRING,
  VALID_CODEX_REASONING_EFFORTS,
  normalizeTargetFromSlot,
  resolveTargetFromModelSettings,
  callT3McpTool,
  getOrchestratorCapabilities,
  buildMissionTaskTitle,
  normalizeDelegateRole,
  buildStableClientRequestId,
  delegateMissionTask,
  runFeature,
  checkGitTreeBeforeResume,
  resumeWorker,
  settleCompletedMilestoneThreads,
  createT3Adapter
};
