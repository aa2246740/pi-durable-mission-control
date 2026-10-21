import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DISMISSAL_TYPES } from "../kernel/schema.mjs";
import {
  buildMissionTaskTitle,
  buildStableClientRequestId,
  callT3McpTool,
  checkGitTreeBeforeResume,
  createT3Adapter,
  delegateMissionTask,
  DROID_AUTONOMY_TO_T3_RUNTIME_MODE,
  EFFORT_LEVEL_TO_STRING,
  getOrchestratorCapabilities,
  mapApprovalModeToProviderAutonomy,
  normalizeTargetFromSlot,
  resolveEffectiveRuntimeMode,
  resolveTargetFromModelSettings,
  resumeWorker,
  runFeature,
  settleCompletedMilestoneThreads,
  T3_APPROVAL_TO_DROID_AUTONOMY,
  VALID_CODEX_REASONING_EFFORTS
} from "../bridge/t3-adapter.mjs";

import {
  callMissionTool,
  createBridgeDispatchAdapter,
  createMissionMcpServer,
  handleJsonRpcMessage,
  isExecutedAsMain as isMcpExecutedAsMain,
  MISSION_TOOL_NAMES,
  MISSION_TOOLS,
  startStdioMcpServer
} from "../bridge/mcp-server.mjs";

import {
  isExecutedAsMain as isCliExecutedAsMain,
  parseCliArgs,
  runCli
} from "../bridge/cli.mjs";

const execFileAsync = promisify(execFileCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../bridge/cli.mjs");
const MCP_SERVER_PATH = path.resolve(__dirname, "../bridge/mcp-server.mjs");
const SKILL_PATH = path.resolve(__dirname, "../skill/SKILL.md");

function createTempDir(prefix = "t3-mission-bridge-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// VAL-BRIDGE-001: Model Slot & Provider Option Normalization
// ============================================================================

test("VAL-BRIDGE-001: normalizeTargetFromSlot maps codex reasoningEffort correctly", () => {
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    const target = normalizeTargetFromSlot({
      providerInstanceId: "codex",
      model: "gpt-5.4",
      effort: level
    });
    assert.deepEqual(target, {
      providerInstanceId: "codex",
      model: "gpt-5.4",
      options: {
        reasoningEffort: level
      }
    });
  }

  const fromNestedOptions = normalizeTargetFromSlot({
    providerInstanceId: "codex",
    model: "gpt-6-1-sol",
    reasoningEffort: "high",
    options: {
      fastMode: true
    }
  });
  assert.deepEqual(fromNestedOptions, {
    providerInstanceId: "codex",
    model: "gpt-6-1-sol",
    options: {
      fastMode: true,
      reasoningEffort: "high"
    }
  });
});

test("F09 & I-02: normalizeTargetFromSlot maps numeric effort 1..5 to reasoningEffort even when stale reasoningEffort is present", () => {
  assert.deepEqual(EFFORT_LEVEL_TO_STRING, {
    1: "minimal",
    2: "low",
    3: "medium",
    4: "high",
    5: "max"
  });
  assert.ok(VALID_CODEX_REASONING_EFFORTS.has("minimal"));

  const expectedByLevel = [
    [1, "minimal"],
    [2, "low"],
    [3, "medium"],
    [4, "high"],
    [5, "max"]
  ];

  for (const [level, expected] of expectedByLevel) {
    // Top-level numeric effort overrides stale top-level or nested reasoningEffort
    const fromTopLevel = normalizeTargetFromSlot({
      providerInstanceId: "codex",
      model: "gpt-6.1-sol",
      effort: level,
      reasoningEffort: "high",
      options: {
        reasoningEffort: "high",
        effort: level,
        testMarker: "worker"
      }
    });
    assert.deepEqual(fromTopLevel, {
      providerInstanceId: "codex",
      model: "gpt-6.1-sol",
      options: {
        testMarker: "worker",
        reasoningEffort: expected
      }
    });

    // Kernel-reloaded slot (where only options survive) still derives from options.effort
    const fromKernelStore = normalizeTargetFromSlot({
      providerInstanceId: "codex",
      model: "gpt-6.1-sol",
      options: {
        reasoningEffort: "high",
        effort: level,
        testMarker: "worker"
      }
    });
    assert.deepEqual(fromKernelStore, {
      providerInstanceId: "codex",
      model: "gpt-6.1-sol",
      options: {
        testMarker: "worker",
        reasoningEffort: expected
      }
    });
  }

  // Effort 5 with explicit xhigh preserves xhigh
  const xhighSlot = normalizeTargetFromSlot({
    providerInstanceId: "codex",
    model: "gpt-5.4",
    effort: 5,
    reasoningEffort: "xhigh"
  });
  assert.deepEqual(xhighSlot, {
    providerInstanceId: "codex",
    model: "gpt-5.4",
    options: {
      reasoningEffort: "xhigh"
    }
  });
});

test("VAL-BRIDGE-001: normalizeTargetFromSlot maps antigravity direct model IDs", () => {
  const geminiTarget = normalizeTargetFromSlot({
    providerInstanceId: "antigravity",
    model: "gemini-4-argon-high",
    effort: "high"
  });
  assert.deepEqual(geminiTarget, {
    providerInstanceId: "antigravity",
    model: "gemini-4-argon-high",
    options: {}
  });

  const claudeTarget = normalizeTargetFromSlot({
    providerInstanceId: "antigravity",
    model: "claude-opus-5-5-high"
  });
  assert.deepEqual(claudeTarget, {
    providerInstanceId: "antigravity",
    model: "claude-opus-5-5-high",
    options: {}
  });
});

test("VAL-BRIDGE-001: normalizeTargetFromSlot maps acpRegistry_factory_droid reasoning_effort and autonomy_level", () => {
  const droidTarget = normalizeTargetFromSlot({
    providerInstanceId: "acpRegistry_factory_droid",
    model: "claude-opus-4-6",
    effort: "high"
  });
  assert.deepEqual(droidTarget, {
    providerInstanceId: "acpRegistry_factory_droid",
    model: "claude-opus-4-6",
    options: {
      reasoning_effort: "high",
      autonomy_level: "auto-high"
    }
  });

  const droidWithExplicitReasoning = normalizeTargetFromSlot({
    providerInstanceId: "acpRegistry_factory_droid",
    model: "gpt-5.4",
    reasoningEffort: "max"
  });
  assert.deepEqual(droidWithExplicitReasoning, {
    providerInstanceId: "acpRegistry_factory_droid",
    model: "gpt-5.4",
    options: {
      reasoning_effort: "max",
      autonomy_level: "auto-high"
    }
  });
});

test("VAL-BRIDGE-001: normalizeTargetFromSlot maps pi thinking option", () => {
  const piTarget = normalizeTargetFromSlot({
    providerInstanceId: "pi",
    model: "claude-sonnet-4-5",
    thinking: "high"
  });
  assert.deepEqual(piTarget, {
    providerInstanceId: "pi",
    model: "claude-sonnet-4-5",
    options: {
      thinking: "high"
    }
  });

  const piFromEffort = normalizeTargetFromSlot({
    providerInstanceId: "pi",
    model: "claude-opus-4-6",
    effort: "max"
  });
  assert.deepEqual(piFromEffort, {
    providerInstanceId: "pi",
    model: "claude-opus-4-6",
    options: {
      thinking: "max"
    }
  });
});

test("VAL-BRIDGE-001: bidirectional Droid autonomy <-> T3 runtimeMode mapping and provider-specific autonomy/effort helpers", () => {
  assert.deepEqual(T3_APPROVAL_TO_DROID_AUTONOMY, {
    plan: "spec",
    "approval-required": "normal",
    "auto-accept-edits": "auto-low",
    auto: "auto-high",
    "full-access": "auto-high"
  });

  assert.deepEqual(DROID_AUTONOMY_TO_T3_RUNTIME_MODE, {
    spec: "approval-required",
    normal: "approval-required",
    "auto-low": "auto-accept-edits",
    "auto-medium": "auto",
    "auto-high": "full-access"
  });

  // mapApprovalModeToProviderAutonomy for Factory Droid
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_factory_droid", "plan"),
    { autonomy_level: "spec" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_factory_droid", { interactionMode: "plan", runtimeMode: "auto" }),
    { autonomy_level: "spec" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_factory_droid", "approval-required"),
    { autonomy_level: "normal" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_factory_droid", { approvalMode: "approval-required" }),
    { autonomy_level: "normal" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_factory_droid", "auto-accept-edits"),
    { autonomy_level: "auto-low" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_factory_droid", { autonomy_level: "auto-medium", runtimeMode: "auto" }),
    { autonomy_level: "auto-medium" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_factory_droid", "auto"),
    { autonomy_level: "auto-high" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_factory_droid", "full-access"),
    { autonomy_level: "auto-high" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_factory_droid"),
    { autonomy_level: "auto-high" }
  );

  // mapApprovalModeToProviderAutonomy for Devin
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_devin"),
    { mode: "bypass" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_devin", "auto"),
    { mode: "bypass" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_devin", { interactionMode: "plan" }),
    { mode: "plan" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_devin", { runtimeMode: "approval-required" }),
    { mode: "ask" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_devin", { runtimeMode: "auto-accept-edits" }),
    { mode: "accept-edits" }
  );

  // mapApprovalModeToProviderAutonomy for Cursor
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_cursor"),
    { mode: "agent" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_cursor", "auto"),
    { mode: "agent" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_cursor", { interactionMode: "plan" }),
    { mode: "plan" }
  );
  assert.deepEqual(
    mapApprovalModeToProviderAutonomy("acpRegistry_cursor", { runtimeMode: "approval-required" }),
    { mode: "ask" }
  );

  // resolveEffectiveRuntimeMode hierarchy, ceiling, and providerRuntimeModes filtering
  assert.equal(resolveEffectiveRuntimeMode(), "full-access");
  assert.equal(resolveEffectiveRuntimeMode({ autonomyLevel: "spec" }), "approval-required");
  assert.equal(resolveEffectiveRuntimeMode({ autonomyLevel: "normal" }), "approval-required");
  assert.equal(resolveEffectiveRuntimeMode({ autonomyLevel: "auto-low" }), "auto-accept-edits");
  assert.equal(resolveEffectiveRuntimeMode({ autonomyLevel: "auto-medium" }), "auto");
  assert.equal(resolveEffectiveRuntimeMode({ autonomyLevel: "auto-high" }), "full-access");
  assert.equal(
    resolveEffectiveRuntimeMode({ requestedMode: "full-access", parentRuntimeMode: "auto" }),
    "auto"
  );
  assert.equal(
    resolveEffectiveRuntimeMode({
      autonomyLevel: "auto-high",
      parentRuntimeMode: "auto",
      providerRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"]
    }),
    "auto-accept-edits"
  );
  assert.equal(
    resolveEffectiveRuntimeMode({
      parentRuntimeMode: "full-access",
      providerRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"]
    }),
    "full-access"
  );
});

test("VAL-BRIDGE-001: normalizeTargetFromSlot maps acpRegistry_factory_droid, acpRegistry_devin, acpRegistry_cursor, and grok/cpa options accurately", () => {
  // Factory Droid approval/runtime/interaction mode mappings
  assert.deepEqual(
    normalizeTargetFromSlot({
      providerInstanceId: "acpRegistry_factory_droid",
      model: "claude-opus-4-6",
      effort: 4,
      runtimeMode: "approval-required"
    }),
    {
      providerInstanceId: "acpRegistry_factory_droid",
      model: "claude-opus-4-6",
      options: {
        reasoning_effort: "high",
        autonomy_level: "normal"
      }
    }
  );

  assert.deepEqual(
    normalizeTargetFromSlot({
      providerInstanceId: "acpRegistry_factory_droid",
      model: "claude-opus-4-6",
      interactionMode: "plan"
    }),
    {
      providerInstanceId: "acpRegistry_factory_droid",
      model: "claude-opus-4-6",
      options: {
        autonomy_level: "spec"
      }
    }
  );

  assert.deepEqual(
    normalizeTargetFromSlot({
      providerInstanceId: "acpRegistry_factory_droid",
      model: "claude-opus-4-6",
      runtimeMode: "auto-accept-edits"
    }),
    {
      providerInstanceId: "acpRegistry_factory_droid",
      model: "claude-opus-4-6",
      options: {
        autonomy_level: "auto-low"
      }
    }
  );

  assert.deepEqual(
    normalizeTargetFromSlot({
      providerInstanceId: "acpRegistry_factory_droid",
      model: "claude-opus-4-6",
      autonomy_level: "auto-medium"
    }),
    {
      providerInstanceId: "acpRegistry_factory_droid",
      model: "claude-opus-4-6",
      options: {
        autonomy_level: "auto-medium"
      }
    }
  );

  // Devin: mode defaults to "bypass" and effort maps to thought_level ("medium" | "high" | "max")
  for (const [inputEffort, expectedThought] of [
    ["minimal", "medium"],
    ["low", "medium"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "max"],
    ["max", "max"],
    [1, "medium"],
    [4, "high"],
    [5, "max"]
  ]) {
    assert.deepEqual(
      normalizeTargetFromSlot({
        providerInstanceId: "acpRegistry_devin",
        model: "claude-opus-4-6",
        effort: inputEffort
      }),
      {
        providerInstanceId: "acpRegistry_devin",
        model: "claude-opus-4-6",
        options: {
          mode: "bypass",
          thought_level: expectedThought
        }
      }
    );
  }

  assert.deepEqual(
    normalizeTargetFromSlot({
      providerInstanceId: "acpRegistry_devin",
      model: "claude-opus-4-6",
      runtimeMode: "auto-accept-edits",
      effort: "high"
    }),
    {
      providerInstanceId: "acpRegistry_devin",
      model: "claude-opus-4-6",
      options: {
        mode: "accept-edits",
        thought_level: "high"
      }
    }
  );

  // Cursor: mode defaults to "agent" and effort maps to reasoning_effort + effort
  const cursorMatrix = [
    ["minimal", "low", "low"],
    ["low", "low", "low"],
    ["medium", "medium", "medium"],
    ["high", "high", "high"],
    ["xhigh", "xhigh", "xhigh"],
    ["max", "xhigh", "max"],
    [1, "low", "low"],
    [4, "high", "high"],
    [5, "xhigh", "max"]
  ];
  for (const [inputEffort, expectedReasoning, expectedEffort] of cursorMatrix) {
    assert.deepEqual(
      normalizeTargetFromSlot({
        providerInstanceId: "acpRegistry_cursor",
        model: "claude-4.6-opus-max-thinking",
        effort: inputEffort
      }),
      {
        providerInstanceId: "acpRegistry_cursor",
        model: "claude-4.6-opus-max-thinking",
        options: {
          mode: "agent",
          reasoning_effort: expectedReasoning,
          effort: expectedEffort
        }
      }
    );
  }

  assert.deepEqual(
    normalizeTargetFromSlot({
      providerInstanceId: "acpRegistry_cursor",
      model: "claude-4.6-opus-max-thinking",
      interactionMode: "plan",
      effort: "high"
    }),
    {
      providerInstanceId: "acpRegistry_cursor",
      model: "claude-4.6-opus-max-thinking",
      options: {
        mode: "plan",
        reasoning_effort: "high",
        effort: "high"
      }
    }
  );

  // Grok & CPA (grok-*): reasoningEffort clamps minimal -> low and max -> xhigh
  for (const provider of ["grok", "cpa"]) {
    assert.deepEqual(
      normalizeTargetFromSlot({
        providerInstanceId: provider,
        model: "grok-4.7",
        effort: "minimal"
      }),
      {
        providerInstanceId: provider,
        model: "grok-4.7",
        options: {
          reasoningEffort: "low"
        }
      }
    );

    assert.deepEqual(
      normalizeTargetFromSlot({
        providerInstanceId: provider,
        model: "grok-4.7",
        effort: "max"
      }),
      {
        providerInstanceId: provider,
        model: "grok-4.7",
        options: {
          reasoningEffort: "xhigh"
        }
      }
    );

    assert.deepEqual(
      normalizeTargetFromSlot({
        providerInstanceId: provider,
        model: "grok-4.6",
        effort: "high"
      }),
      {
        providerInstanceId: provider,
        model: "grok-4.6",
        options: {
          reasoningEffort: "high"
        }
      }
    );
  }
});

test("VAL-BRIDGE-001: resolveTargetFromModelSettings resolves worker, validator, and orchestrator slots", () => {
  const modelSettings = {
    orchestrator: {
      providerInstanceId: "acpRegistry_factory_droid",
      model: "claude-opus-4-6",
      effort: "high"
    },
    worker: {
      providerInstanceId: "antigravity",
      model: "gemini-4-argon-high"
    },
    validator: {
      providerInstanceId: "codex",
      model: "gpt-6-1-sol",
      reasoningEffort: "high"
    }
  };

  assert.deepEqual(resolveTargetFromModelSettings(modelSettings, "implementation"), {
    providerInstanceId: "antigravity",
    model: "gemini-4-argon-high",
    options: {}
  });

  assert.deepEqual(resolveTargetFromModelSettings(modelSettings, "scrutiny"), {
    providerInstanceId: "codex",
    model: "gpt-6-1-sol",
    options: { reasoningEffort: "high" }
  });

  assert.deepEqual(resolveTargetFromModelSettings(modelSettings, "orchestrator"), {
    providerInstanceId: "acpRegistry_factory_droid",
    model: "claude-opus-4-6",
    options: {
      reasoning_effort: "high",
      autonomy_level: "auto-high"
    }
  });
});

// ============================================================================
// T3 ACP MCP Transport & delegate_task / settleCompletedMilestoneThreads
// ============================================================================

test("callT3McpTool invokes execFile with array arguments and ELECTRON_RUN_AS_NODE=1 (no shell injection)", async () => {
  const capturedCalls = [];
  const fakeExecFile = async (file, args, options) => {
    capturedCalls.push({ file, args, options });
    return {
      stdout: JSON.stringify({
        taskId: "task-99",
        childThreadId: "thread-99",
        status: "running"
      }),
      stderr: ""
    };
  };

  const dangerousPrompt = 'Implement feature; $(touch /tmp/pwned) && echo "quoted"';
  const result = await callT3McpTool(
    "delegate_task",
    { task: dangerousPrompt },
    {
      env: {
        T3_ACP_MCP_NODE: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        T3_ACP_MCP_ENTRYPOINT: "/Applications/T3 Code.app/Contents/Resources/app.asar/dist/mcp.cjs"
      },
      execFileImpl: fakeExecFile
    }
  );

  assert.equal(capturedCalls.length, 1);
  assert.equal(capturedCalls[0].file, "/Applications/T3 Code.app/Contents/MacOS/T3 Code");
  assert.deepEqual(capturedCalls[0].args, [
    "/Applications/T3 Code.app/Contents/Resources/app.asar/dist/mcp.cjs",
    "acp-mcp-call",
    "delegate_task",
    JSON.stringify({ task: dangerousPrompt })
  ]);
  assert.equal(capturedCalls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(result.taskId, "task-99");
  assert.equal(result.childThreadId, "thread-99");
});

test("delegateMissionTask formats standardized titles, roles, worktree isolation, and idempotent clientRequestId", async () => {
  const calls = [];
  const transportClient = async (toolName, args) => {
    calls.push({ toolName, args });
    return {
      taskId: `task-${calls.length}`,
      childThreadId: `thread-${calls.length}`
    };
  };

  const workerRes = await delegateMissionTask(
    {
      missionId: "m-100",
      milestoneId: "M1",
      workerNumber: 3,
      featureId: "hub-attachment-ui",
      featureTitle: "Hub attachment UI",
      kind: "worker",
      task: "Build the Hub attachment UI component",
      slot: {
        providerInstanceId: "codex",
        model: "gpt-5.4",
        effort: "xhigh"
      }
    },
    { transportClient }
  );

  assert.equal(workerRes.title, "[M1] Worker #3: Hub attachment UI");
  assert.equal(calls[0].toolName, "delegate_task");
  assert.equal(calls[0].args.title, "[M1] Worker #3: Hub attachment UI");
  assert.equal(calls[0].args.role, "implementation");
  assert.equal(calls[0].args.isolation, "worktree");
  assert.equal(
    calls[0].args.clientRequestId,
    "t3m:m-100:m1:hub-attachment-ui:implementation:r1"
  );
  assert.deepEqual(calls[0].args.target, {
    providerInstanceId: "codex",
    model: "gpt-5.4",
    options: { reasoningEffort: "xhigh" }
  });

  const validatorRes = await delegateMissionTask(
    {
      missionId: "m-100",
      milestoneId: "M1",
      validatorNumber: 5,
      featureId: "scrutiny-m1",
      featureTitle: "Scrutiny intake",
      kind: "scrutiny",
      task: "Run scrutiny code review for M1",
      slot: {
        providerInstanceId: "codex",
        model: "gpt-6-1-sol",
        reasoningEffort: "high"
      }
    },
    { transportClient }
  );

  assert.equal(validatorRes.title, "[M1] Validator #5: Scrutiny intake");
  assert.equal(calls[1].args.role, "review");
  assert.equal(calls[1].args.isolation, "worktree");
  assert.deepEqual(calls[1].args.target, {
    providerInstanceId: "codex",
    model: "gpt-6-1-sol",
    options: { reasoningEffort: "high" }
  });
});

test("F01 & I-01: runFeature and StartMissionRun propagate and persist taskId, childThreadId, childRunId, and worktreePath", async () => {
  const tempMissionDir = createTempDir("t3-f01-persist-");
  try {
    const directRes = await runFeature(
      { id: "f-direct", title: "Direct Feature", milestoneId: "m1" },
      { providerInstanceId: "antigravity", model: "gemini-4-argon-high" },
      {
        missionId: "m-direct",
        activeWorker: { runId: "run-direct-0", workerNumber: 1, attempt: 1 }
      },
      {
        transportClient: async () => ({
          taskId: "task-direct-1",
          childThreadId: "thread-direct-1",
          childRunId: "run-direct-1",
          worktreePath: "/tmp/worktree-direct-1"
        })
      }
    );
    assert.equal(directRes.taskId, "task-direct-1");
    assert.equal(directRes.childThreadId, "thread-direct-1");
    assert.equal(directRes.childRunId, "run-direct-1");
    assert.equal(directRes.worktreePath, "/tmp/worktree-direct-1");
    assert.match(directRes.request.task, /runId="run-direct-0"/);
    assert.match(directRes.request.task, /featureId="f-direct"/);

    await callMissionTool("ProposeMission", {
      missionDir: tempMissionDir,
      title: "F01 Persistence Test",
      milestones: [{ id: "m1", title: "M1" }],
      features: [{ id: "f1", milestoneId: "m1", title: "Feature 1" }],
      assertions: [{ id: "VAL-1", milestoneId: "m1", description: "Check" }]
    });
    await callMissionTool("ApproveMissionPlan", { missionDir: tempMissionDir });

    const adapter = createT3Adapter({
      transportClient: async () => ({
        taskId: "task-persisted-1",
        childThreadId: "thread-persisted-1",
        childRunId: "crun-persisted-1",
        worktreePath: "/tmp/isolated-worktree-1"
      })
    });

    const startRes = await callMissionTool(
      "StartMissionRun",
      { missionDir: tempMissionDir },
      { adapter }
    );

    assert.equal(startRes.activeWorker.taskId, "task-persisted-1");
    assert.equal(startRes.activeWorker.childThreadId, "thread-persisted-1");
    assert.equal(startRes.activeWorker.childRunId, "crun-persisted-1");
    assert.equal(startRes.activeWorker.worktreePath, "/tmp/isolated-worktree-1");

    const diskState = JSON.parse(
      fs.readFileSync(path.join(tempMissionDir, ".mission", "state.json"), "utf8")
    );
    assert.equal(diskState.activeWorker.taskId, "task-persisted-1");
    assert.equal(diskState.activeWorker.childThreadId, "thread-persisted-1");
    assert.equal(diskState.activeWorker.childRunId, "crun-persisted-1");
    assert.equal(diskState.activeWorker.worktreePath, "/tmp/isolated-worktree-1");
    assert.equal(diskState.sessions[0].taskId, "task-persisted-1");
    assert.equal(diskState.sessions[0].childThreadId, "thread-persisted-1");
    assert.equal(diskState.sessions[0].childRunId, "crun-persisted-1");
    assert.equal(diskState.sessions[0].worktreePath, "/tmp/isolated-worktree-1");
  } finally {
    fs.rmSync(tempMissionDir, { recursive: true, force: true });
  }
});

test("getOrchestratorCapabilities and settleCompletedMilestoneThreads invoke expected T3 tools", async () => {
  const calls = [];
  const adapter = createT3Adapter({
    transportClient: async (toolName, args) => {
      calls.push({ toolName, args });
      if (toolName === "orchestrator_capabilities") {
        return { providers: [{ id: "codex" }, { id: "antigravity" }] };
      }
      return { settled: true };
    }
  });

  const caps = await adapter.getOrchestratorCapabilities();
  assert.equal(caps.providers.length, 2);

  const settleRes = await adapter.settleCompletedMilestoneThreads([
    "thread-a",
    { childThreadId: "thread-b" },
    "thread-a" // duplicate should be deduped
  ]);

  assert.deepEqual(settleRes.settledThreadIds, ["thread-a", "thread-b"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], {
    toolName: "t3_thread_organize",
    args: { action: "settle", threadId: "thread-a" }
  });
  assert.deepEqual(calls[2], {
    toolName: "t3_thread_organize",
    args: { action: "settle", threadId: "thread-b" }
  });
});

// ============================================================================
// VAL-BRIDGE-002: checkGitTreeBeforeResume & resumeWorker Lossless Continuation
// ============================================================================

test("VAL-BRIDGE-002: checkGitTreeBeforeResume detects clean, dirty, and conflicted Git worktrees", async () => {
  const tempRepo = createTempDir("t3-git-check-");
  try {
    await execFileAsync("git", ["init"], { cwd: tempRepo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: tempRepo });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: tempRepo });

    fs.writeFileSync(path.join(tempRepo, "index.js"), "export const x = 1;\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: tempRepo });
    await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: tempRepo });

    // 1. Clean working tree
    const cleanCheck = await checkGitTreeBeforeResume(tempRepo, { featureId: "feat-auth" });
    assert.equal(cleanCheck.isGitRepo, true);
    assert.equal(cleanCheck.clean, true);
    assert.equal(cleanCheck.hasConflicts, false);
    assert.equal(cleanCheck.hasUncommittedChanges, false);
    assert.equal(cleanCheck.canResume, true);
    assert.match(
      cleanCheck.summary,
      /The mission was paused.*and the code tree has no uncommitted changes, so I'm resuming that worker\./
    );

    // 2. Dirty working tree (uncommitted modification, no conflicts)
    fs.writeFileSync(path.join(tempRepo, "index.js"), "export const x = 2;\n", "utf8");
    const dirtyCheck = await checkGitTreeBeforeResume(tempRepo, { featureId: "feat-auth" });
    assert.equal(dirtyCheck.clean, false);
    assert.equal(dirtyCheck.hasConflicts, false);
    assert.equal(dirtyCheck.hasUncommittedChanges, true);
    assert.equal(dirtyCheck.canResume, true);
    assert.deepEqual(dirtyCheck.modifiedFiles, ["index.js"]);

    // 3. Simulated unmerged conflict status via execFileImpl
    const conflictCheck = await checkGitTreeBeforeResume(tempRepo, {
      featureId: "feat-auth",
      execFileImpl: async (_file, args) => {
        if (args.includes("--porcelain")) {
          return { stdout: "UU src/conflict.js\n M index.js\n", stderr: "" };
        }
        return { stdout: "main\n", stderr: "" };
      }
    });
    assert.equal(conflictCheck.hasConflicts, true);
    assert.equal(conflictCheck.canResume, false);
    assert.deepEqual(conflictCheck.conflictedFiles, ["src/conflict.js"]);
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("F13 & F02: checkGitTreeBeforeResume fails closed on Git errors and resumeWorker blocks without dispatching", async () => {
  const gitFailure = await checkGitTreeBeforeResume("/missing/repository", {
    execFileImpl: async () => {
      throw new Error("permission denied");
    }
  });

  assert.equal(gitFailure.isGitRepo, false);
  assert.equal(gitFailure.clean, false);
  assert.equal(gitFailure.canResume, false);
  assert.equal(gitFailure.error, "permission denied");
  assert.equal(
    gitFailure.summary,
    "Cannot resume mission: Git inspection failed (permission denied)."
  );

  const mcpCalls = [];
  const blockedByGitError = await resumeWorker(
    {
      missionId: "m-git-err",
      worktreePath: "/missing/repository",
      activeWorker: {
        featureId: "f-git-err",
        childThreadId: "thread-git-err-1"
      }
    },
    {
      transportClient: async (toolName, args) => {
        mcpCalls.push({ toolName, args });
        return {};
      },
      execFileImpl: async () => {
        throw new Error("permission denied");
      }
    }
  );

  assert.equal(blockedByGitError.resumed, false);
  assert.equal(blockedByGitError.canResume, false);
  assert.equal(blockedByGitError.status, "blocked_by_git_error");
  assert.equal(
    blockedByGitError.reason,
    "Cannot resume mission: Git inspection failed (permission denied)."
  );
  assert.equal(blockedByGitError.preflight.canResume, false);
  assert.equal(mcpCalls.length, 0);
});

test("VAL-BRIDGE-002: resumeWorker checks Git tree first and calls t3_thread_send when activeWorker.childThreadId exists", async () => {
  const tempRepo = createTempDir("t3-resume-worker-");
  try {
    await execFileAsync("git", ["init"], { cwd: tempRepo });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: tempRepo });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: tempRepo });
    fs.writeFileSync(path.join(tempRepo, "app.mjs"), "console.log('ok');\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: tempRepo });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: tempRepo });

    const mcpCalls = [];
    const transportClient = async (toolName, args) => {
      mcpCalls.push({ toolName, args });
      return { taskId: "resumed-task-1", status: "running" };
    };

    const resumeOutcome = await resumeWorker(
      {
        missionId: "m-resume-1",
        worktreePath: tempRepo,
        activeWorker: {
          runId: "run-1",
          workerNumber: 2,
          featureId: "w2-bridge",
          featureTitle: "T3 Orchestration V2 Bridge",
          childThreadId: "thread-existing-worker-2",
          status: "paused"
        }
      },
      { transportClient }
    );

    assert.equal(resumeOutcome.resumed, true);
    assert.equal(resumeOutcome.canResume, true);
    assert.equal(resumeOutcome.status, "running");
    assert.equal(resumeOutcome.action, "t3_thread_send");
    assert.equal(resumeOutcome.threadId, "thread-existing-worker-2");
    assert.equal(resumeOutcome.gitCheck.clean, true);
    assert.match(
      resumeOutcome.summary,
      /The mission was paused.*and the code tree has no uncommitted changes, so I'm resuming that worker\./
    );

    // Must ONLY call t3_thread_send, never delegate_task
    assert.equal(mcpCalls.length, 1);
    assert.equal(mcpCalls[0].toolName, "t3_thread_send");
    assert.equal(mcpCalls[0].args.threadId, "thread-existing-worker-2");
    assert.match(mcpCalls[0].args.message, /\[resume the mission\]/);
    assert.match(
      mcpCalls[0].args.message,
      /and the code tree has no uncommitted changes, so I'm resuming that worker\./
    );
  } finally {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  }
});

test("VAL-BRIDGE-002: resumeWorker blocks resume when Git tree has unresolved merge conflicts", async () => {
  const mcpCalls = [];
  const outcome = await resumeWorker(
    {
      missionId: "m-conflict",
      worktreePath: "/tmp/conflict-tree",
      activeWorker: {
        featureId: "f-conflict",
        childThreadId: "thread-conflict-1"
      }
    },
    {
      transportClient: async (toolName, args) => {
        mcpCalls.push({ toolName, args });
        return {};
      },
      execFileImpl: async (_file, args) => {
        if (args.includes("--porcelain")) {
          return { stdout: "UU t3-mission/bridge/t3-adapter.mjs\n", stderr: "" };
        }
        return { stdout: "t3m/w2-bridge\n", stderr: "" };
      }
    }
  );

  assert.equal(outcome.resumed, false);
  assert.equal(outcome.canResume, false);
  assert.equal(outcome.status, "blocked_by_conflicts");
  assert.equal(outcome.action, "blocked_by_conflicts");
  assert.equal(outcome.gitCheck.hasConflicts, true);
  assert.equal(mcpCalls.length, 0);
});

// ============================================================================
// VAL-BRIDGE-003: MCP Server JSON-RPC 2.0 & CLI Entrypoint
// ============================================================================

test("F05, F06, F12: MCP schemas and Bridge boundary normalize dismissals, forward feature/milestone/assertion updates, and enforce both runId and featureId on EndFeatureRun", async () => {
  const dismissTool = MISSION_TOOLS.find((t) => t.name === "DismissHandoffItems");
  const itemSchema = dismissTool.inputSchema.properties.dismissals.items;
  assert.deepEqual(itemSchema.required, [
    "type",
    "sourceFeatureId",
    "summary",
    "justification"
  ]);
  assert.deepEqual(itemSchema.properties.type.enum, DISMISSAL_TYPES);
  assert.deepEqual(
    new Set(itemSchema.properties.type.enum),
    new Set([
      "discovered_issue",
      "non_interactive_check",
      "incomplete_work",
      "validator_failure",
      "critical_context"
    ])
  );
  assert.equal(itemSchema.properties.type.enum.includes("handoff_attention"), false);
  assert.equal(itemSchema.properties.justification.minLength, 20);
  assert.ok(itemSchema.properties.itemId);
  assert.ok(itemSchema.properties.reason);

  const endTool = MISSION_TOOLS.find((t) => t.name === "EndFeatureRun");
  assert.deepEqual(endTool.inputSchema.required, [
    "missionDir",
    "runId",
    "featureId",
    "handoff"
  ]);
  assert.ok(endTool.inputSchema.properties.runId);

  const updateTool = MISSION_TOOLS.find((t) => t.name === "UpdateMissionFeatures");
  for (const field of [
    "features",
    "addFeatures",
    "updateFeatures",
    "updateAssertions",
    "modelSettings",
    "bonusAttempts",
    "milestones",
    "assertions"
  ]) {
    assert.ok(
      updateTool.inputSchema.properties[field],
      `UpdateMissionFeatures schema should include ${field}`
    );
  }

  // F12: EndFeatureRun requires BOTH runId and featureId; missing either throws MISSING_RUN_IDENTITY
  const validHandoff = {
    whatWasImplemented:
      "Implemented feature with more than fifty characters of detailed summary text."
  };
  await assert.rejects(
    () =>
      callMissionTool("EndFeatureRun", {
        missionDir: "/tmp/no-identity",
        handoff: validHandoff
      }),
    (err) => {
      assert.equal(err.code, "MISSING_RUN_IDENTITY");
      return true;
    }
  );
  await assert.rejects(
    () =>
      callMissionTool("EndFeatureRun", {
        missionDir: "/tmp/no-run-id",
        featureId: "f1",
        handoff: validHandoff
      }),
    (err) => {
      assert.equal(err.code, "MISSING_RUN_IDENTITY");
      return true;
    }
  );
  await assert.rejects(
    () =>
      callMissionTool("EndFeatureRun", {
        missionDir: "/tmp/no-feature-id",
        runId: "run-1",
        handoff: validHandoff
      }),
    (err) => {
      assert.equal(err.code, "MISSING_RUN_IDENTITY");
      return true;
    }
  );

  // F05 & F06 against real kernel in a temporary mission directory
  const tempMissionDir = createTempDir("t3-f05-f06-");
  try {
    await callMissionTool("ProposeMission", {
      missionDir: tempMissionDir,
      title: "Schema Alignment Mission",
      milestones: [{ id: "m1", title: "M1" }],
      features: [
        { id: "f1", milestoneId: "m1", title: "F1" },
        { id: "f2", milestoneId: "m1", title: "F2" }
      ],
      assertions: [{ id: "VAL-1", milestoneId: "m1", description: "Initial assertion" }]
    });
    await callMissionTool("ApproveMissionPlan", { missionDir: tempMissionDir });

    // Start run and complete f1 with whatWasLeftUndone -> emits incomplete_work pending item
    const started = await callMissionTool("StartMissionRun", { missionDir: tempMissionDir });
    const activeRunId = started.activeWorker.runId;
    await callMissionTool("EndFeatureRun", {
      missionDir: tempMissionDir,
      runId: activeRunId,
      featureId: "f1",
      successState: "success",
      validatorsPassed: true,
      handoff: {
        ...validHandoff,
        whatWasLeftUndone: "Remaining edge case deferred to follow-up"
      }
    });

    // F05: Dismissing incomplete_work succeeds, while handoff_attention is rejected with INVALID_DISMISSAL_TYPE
    const dismissIncomplete = await callMissionTool("DismissHandoffItems", {
      missionDir: tempMissionDir,
      dismissals: [
        {
          type: "incomplete_work",
          sourceFeatureId: "f1",
          summary: "Remaining edge case deferred to follow-up",
          justification: "Explicitly deferred with more than twenty characters of justification."
        }
      ]
    });
    assert.equal(dismissIncomplete.state.lastHandoffNeedsAttention, false);

    await assert.rejects(
      () =>
        callMissionTool("DismissHandoffItems", {
          missionDir: tempMissionDir,
          dismissals: [
            {
              type: "handoff_attention",
              sourceFeatureId: "f1",
              summary: "Anything",
              justification: "A justification string that is longer than twenty characters."
            }
          ]
        }),
      (err) => {
        assert.equal(err.code, "INVALID_DISMISSAL_TYPE");
        return true;
      }
    );

    // Legacy aliases (itemId -> summary, reason -> justification) normalize at Bridge boundary
    let capturedDismissals = null;
    await callMissionTool(
      "DismissHandoffItems",
      {
        missionDir: tempMissionDir,
        dismissals: [
          {
            type: "discovered_issue",
            sourceFeatureId: "f1",
            itemId: "iss-legacy-1",
            reason: "This legacy reason string is at least twenty characters."
          }
        ]
      },
      {
        kernel: {
          dismissHandoffItems(_dir, payload) {
            capturedDismissals = payload.dismissals;
            return { ok: true, dismissals: payload.dismissals };
          }
        }
      }
    );
    assert.equal(capturedDismissals[0].summary, "iss-legacy-1");
    assert.equal(
      capturedDismissals[0].justification,
      "This legacy reason string is at least twenty characters."
    );

    // F06: Replacement features, milestones, assertions + bonusAttempts/updateAssertions/modelSettings
    const updateRes = await callMissionTool("UpdateMissionFeatures", {
      missionDir: tempMissionDir,
      features: [{ id: "replacement-f1", milestoneId: "m2", title: "Replacement Feature" }],
      milestones: [{ id: "m2", title: "Milestone 2" }],
      assertions: [{ id: "VAL-NEW", milestoneId: "m2", description: "New assertion" }]
    });

    assert.deepEqual(
      updateRes.features.map((f) => f.id),
      ["replacement-f1"]
    );
    assert.deepEqual(
      updateRes.state.milestones.map((m) => m.id),
      ["m2"]
    );
    assert.deepEqual(
      updateRes.state.assertions.map((a) => a.id),
      ["VAL-NEW"]
    );
  } finally {
    fs.rmSync(tempMissionDir, { recursive: true, force: true });
  }
});

test("VAL-BRIDGE-003: MCP Server handles initialize, tools/list, and tools/call for all 7 Mission tools with mock kernel", async () => {
  const invokedTools = [];
  const mockKernel = {
    proposeMission(missionDir, input) {
      invokedTools.push({ tool: "ProposeMission", missionDir, input });
      return { status: "awaiting_input", planAccepted: false, title: input.title };
    },
    approveMissionPlan(missionDir, input) {
      invokedTools.push({ tool: "ApproveMissionPlan", missionDir, input });
      return { status: "orchestrator_turn", planAccepted: true };
    },
    startMissionRun(missionDir, input, adapter) {
      invokedTools.push({
        tool: "StartMissionRun",
        missionDir,
        input,
        hasAdapter: typeof adapter?.resumeWorker === "function"
      });
      return { status: "running", activeWorker: { featureId: "f1" } };
    },
    dismissHandoffItems(missionDir, input) {
      invokedTools.push({ tool: "DismissHandoffItems", missionDir, input });
      return { status: "orchestrator_turn", lastHandoffNeedsAttention: false };
    },
    endFeatureRun(missionDir, input) {
      invokedTools.push({ tool: "EndFeatureRun", missionDir, input });
      return { shouldReturnToOrchestrator: false, status: "running" };
    },
    updateMissionFeatures(missionDir, input) {
      invokedTools.push({ tool: "UpdateMissionFeatures", missionDir, input });
      return { updated: true, count: (input.addFeatures || []).length };
    },
    reconcileMissionOnLoad(missionDir) {
      invokedTools.push({ tool: "CheckMissionStateBeforeResuming", missionDir });
      return {
        status: "paused",
        activeWorker: {
          featureId: "f1",
          featureTitle: "Feature 1",
          childThreadId: "thread-f1",
          status: "paused"
        }
      };
    }
  };

  const server = createMissionMcpServer({
    kernel: mockKernel,
    missionDir: "/tmp/mock-mission",
    execFileImpl: async (_file, args) => {
      if (args.includes("--porcelain")) {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "main\n", stderr: "" };
    }
  });

  // 1. initialize
  const initRes = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" }
  });
  assert.equal(initRes.id, 1);
  assert.equal(initRes.result.protocolVersion, "2024-11-05");
  assert.ok(initRes.result.capabilities.tools);

  // 2. tools/list
  const listRes = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list"
  });
  const listedNames = listRes.result.tools.map((t) => t.name);
  assert.deepEqual(listedNames, [
    "ProposeMission",
    "ApproveMissionPlan",
    "StartMissionRun",
    "DismissHandoffItems",
    "EndFeatureRun",
    "UpdateMissionFeatures",
    "CheckMissionStateBeforeResuming"
  ]);

  // 3. tools/call for all 7 tools
  const toolPayloads = [
    ["ProposeMission", { missionDir: "/tmp/mock-mission", title: "Demo Mission" }],
    ["ApproveMissionPlan", { missionDir: "/tmp/mock-mission" }],
    ["StartMissionRun", { missionDir: "/tmp/mock-mission" }],
    [
      "DismissHandoffItems",
      {
        missionDir: "/tmp/mock-mission",
        dismissals: [
          {
            type: "discovered_issue",
            sourceFeatureId: "f1",
            summary: "iss-1",
            justification: "Non-blocking issue with twenty plus characters."
          }
        ]
      }
    ],
    [
      "EndFeatureRun",
      {
        missionDir: "/tmp/mock-mission",
        runId: "run-1",
        featureId: "f1",
        validatorsPassed: true,
        handoff: {
          whatWasImplemented:
            "Implemented the complete T3 Orchestration V2 bridge adapter, MCP server, and CLI."
        }
      }
    ],
    [
      "UpdateMissionFeatures",
      {
        missionDir: "/tmp/mock-mission",
        addFeatures: [{ id: "f2", title: "Fix issue" }]
      }
    ],
    ["CheckMissionStateBeforeResuming", { missionDir: "/tmp/mock-mission" }]
  ];

  let reqId = 10;
  for (const [name, args] of toolPayloads) {
    const callRes = await server.handleRequest({
      jsonrpc: "2.0",
      id: reqId++,
      method: "tools/call",
      params: { name, arguments: args }
    });
    assert.equal(callRes.result.isError, false, `Tool ${name} should succeed`);
    const parsedContent = JSON.parse(callRes.result.content[0].text);
    assert.ok(parsedContent && typeof parsedContent === "object");
  }

  assert.equal(invokedTools.length, 7);
  assert.equal(invokedTools[2].hasAdapter, true);
});

test("VAL-BRIDGE-003: stdio MCP Server communicates over NDJSON streams", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];

  output.setEncoding("utf8");
  let buffer = "";
  output.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (part.trim()) {
        lines.push(JSON.parse(part));
      }
    }
  });

  const stdioServer = startStdioMcpServer({
    input,
    output,
    kernel: {
      approveMissionPlan(missionDir) {
        return { missionDir, planAccepted: true, status: "orchestrator_turn" };
      }
    }
  });

  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "ApproveMissionPlan",
        arguments: { missionDir: "/tmp/stdio-mission" }
      }
    })}\n`
  );
  input.end();

  await new Promise((resolve) => setTimeout(resolve, 60));
  await stdioServer.close();

  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[0].result.tools.length, 7);
  assert.equal(lines[1].id, 2);
  assert.equal(lines[1].result.structuredContent.planAccepted, true);
});

test("VAL-BRIDGE-003 & O01: CLI and MCP Server entrypoints execute main via both physical and symlinked paths", async () => {
  const tempMissionDir = createTempDir("t3-cli-e2e-");
  const tempSymlinkDir = createTempDir("t3-symlink-entrypoint-");
  try {
    await execFileAsync("git", ["init"], { cwd: tempMissionDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: tempMissionDir });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: tempMissionDir });
    fs.writeFileSync(path.join(tempMissionDir, ".gitignore"), ".mission/\n", "utf8");
    await execFileAsync("git", ["add", ".gitignore"], { cwd: tempMissionDir });
    await execFileAsync("git", ["commit", "-m", "initial commit"], { cwd: tempMissionDir });

    const symlinkBridgeDir = path.join(tempSymlinkDir, "bridge-link");
    fs.symlinkSync(path.dirname(CLI_PATH), symlinkBridgeDir);
    const symlinkCliPath = path.join(symlinkBridgeDir, "cli.mjs");
    const symlinkMcpPath = path.join(symlinkBridgeDir, "mcp-server.mjs");

    assert.equal(
      isCliExecutedAsMain(new URL(`file://${CLI_PATH}`).href, symlinkCliPath),
      true
    );
    assert.equal(
      isMcpExecutedAsMain(new URL(`file://${MCP_SERVER_PATH}`).href, symlinkMcpPath),
      true
    );

    // 1. ProposeMission via symlinked CLI subprocess
    const proposePayload = JSON.stringify({
      title: "CLI E2E Mission",
      repoPath: tempMissionDir,
      milestones: [{ id: "M1", title: "Core Bridge" }],
      features: [
        {
          id: "f1",
          milestoneId: "M1",
          title: "Implement Bridge",
          description: "Bridge implementation"
        }
      ],
      assertions: [
        {
          id: "VAL-BRIDGE-001",
          milestoneId: "M1",
          description: "Slot normalization"
        }
      ]
    });

    const { stdout: proposeStdout } = await execFileAsync("node", [
      symlinkCliPath,
      "ProposeMission",
      "--mission-dir",
      tempMissionDir,
      "--json",
      proposePayload
    ]);
    const proposeResult = JSON.parse(proposeStdout);
    assert.equal(proposeResult.state.planAccepted, false);
    assert.equal(proposeResult.features.length, 1);

    // 2. ApproveMissionPlan via CLI subprocess
    const { stdout: approveStdout } = await execFileAsync("node", [
      CLI_PATH,
      "ApproveMissionPlan",
      "--mission-dir",
      tempMissionDir
    ]);
    const approveResult = JSON.parse(approveStdout);
    assert.equal(approveResult.planAccepted, true);

    // 3. StartMissionRun via CLI subprocess
    const { stdout: startStdout } = await execFileAsync("node", [
      CLI_PATH,
      "StartMissionRun",
      "--mission-dir",
      tempMissionDir
    ]);
    const startResult = JSON.parse(startStdout);
    assert.equal(startResult.status, "running");
    assert.equal(startResult.activeWorker.featureId, "f1");

    // 4. CheckMissionStateBeforeResuming via CLI subprocess
    const { stdout: checkStdout } = await execFileAsync("node", [
      CLI_PATH,
      "CheckMissionStateBeforeResuming",
      "--mission-dir",
      tempMissionDir
    ]);
    const checkResult = JSON.parse(checkStdout);
    assert.equal(checkResult.ok, true);
    assert.equal(checkResult.status, "paused");
    assert.equal(checkResult.activeWorker.featureId, "f1");
    assert.equal(checkResult.canResume, true);
    assert.match(checkResult.summary, /The mission was paused/);
  } finally {
    fs.rmSync(tempMissionDir, { recursive: true, force: true });
    fs.rmSync(tempSymlinkDir, { recursive: true, force: true });
  }
});

test("CLI runtime execution subcommands: DispatchWorkerRuntime spawns controllable LocalWorkerDaemon, transitions on PauseWorkerRuntime/ResumeWorkerRuntime, and self-terminates when missionDir is removed", async () => {
  const tempMissionDir = createTempDir("t3-runtime-cli-");
  let spawnedPid = null;
  try {
    const cleanEnv = { ...process.env, T3_ACP_MCP_NODE: "" };

    // Confirm tools/list still returns exactly 7 MCP tools
    const listStdout = execFileSync(process.execPath, [CLI_PATH, "tools/list"], {
      env: cleanEnv,
      encoding: "utf8"
    });
    const listParsed = JSON.parse(listStdout);
    assert.equal(listParsed.tools.length, 7);
    assert.equal(MISSION_TOOLS.length, 7);

    // 1. DispatchWorkerRuntime spawns a live detached LocalWorkerDaemon
    const dispatchStdout = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "DispatchWorkerRuntime",
        "--mission-dir",
        tempMissionDir,
        "--json",
        JSON.stringify({
          missionId: "m-runtime-1",
          runId: "run-rt-1",
          repoPath: tempMissionDir,
          feature: { id: "f-rt-1", title: "Runtime Feature" },
          slotConfig: { providerInstanceId: "codex", model: "gpt-5.4" }
        })
      ],
      { env: cleanEnv, encoding: "utf8" }
    );
    const dispatchRes = JSON.parse(dispatchStdout);
    spawnedPid = dispatchRes.workerPid;
    assert.equal(dispatchRes.ok, true);
    assert.equal(dispatchRes.dispatched, true);
    assert.equal(dispatchRes.taskId, "node:delegated-task:m-runtime-1:f-rt-1:run-rt-1");
    assert.equal(dispatchRes.childThreadId, "thread:delegated-task:m-runtime-1:f-rt-1:run-rt-1");
    assert.equal(dispatchRes.childRunId, "run:thread:m-runtime-1:f-rt-1:run-rt-1:ordinal:1");
    assert.equal(dispatchRes.worktreePath, tempMissionDir);
    assert.equal(typeof dispatchRes.workerPid, "number");
    assert.equal(dispatchRes.daemonStatus, "running");
    assert.equal(dispatchRes.runtimeTransport, "bridge-cli-subprocess");
    assert.ok(dispatchRes.daemonStateFile.startsWith(os.tmpdir()));
    assert.equal(fs.existsSync(dispatchRes.daemonStateFile), true);
    assert.equal(fs.existsSync(path.join(tempMissionDir, ".mission")), false);

    // Verify workerPid is alive and visible in ps with tempMissionDir
    assert.doesNotThrow(() => process.kill(dispatchRes.workerPid, 0));
    const psOut = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
    assert.equal(psOut.includes(tempMissionDir), true);

    const initialDaemonState = JSON.parse(fs.readFileSync(dispatchRes.daemonStateFile, "utf8"));
    assert.equal(initialDaemonState.status, "running");
    assert.equal(initialDaemonState.pid, dispatchRes.workerPid);

    // 2. PauseWorkerRuntime signals SIGUSR1 and transitions daemon to paused
    const pauseWorkerStdout = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "PauseWorkerRuntime",
        "--mission-dir",
        tempMissionDir,
        "--json",
        JSON.stringify({
          activeWorker: {
            taskId: dispatchRes.taskId,
            childThreadId: dispatchRes.childThreadId,
            workerPid: dispatchRes.workerPid,
            daemonStateFile: dispatchRes.daemonStateFile
          }
        })
      ],
      { env: cleanEnv, encoding: "utf8" }
    );
    const pauseWorkerRes = JSON.parse(pauseWorkerStdout);
    assert.equal(pauseWorkerRes.ok, true);
    assert.equal(pauseWorkerRes.paused, true);
    assert.equal(pauseWorkerRes.taskId, dispatchRes.taskId);
    assert.equal(pauseWorkerRes.childThreadId, dispatchRes.childThreadId);
    assert.equal(pauseWorkerRes.workerPid, dispatchRes.workerPid);
    assert.equal(pauseWorkerRes.daemonStatus, "paused");
    assert.equal(typeof pauseWorkerRes.pausedByPid, "number");

    const pausedDaemonState = JSON.parse(fs.readFileSync(dispatchRes.daemonStateFile, "utf8"));
    assert.equal(pausedDaemonState.status, "paused");
    assert.equal(pausedDaemonState.pauseCount, 1);

    // 3. PauseMissionRuntime
    const pauseMissionStdout = execFileSync(
      process.execPath,
      [CLI_PATH, "PauseMissionRuntime", "--mission-dir", tempMissionDir],
      { env: cleanEnv, encoding: "utf8" }
    );
    const pauseMissionRes = JSON.parse(pauseMissionStdout);
    assert.equal(pauseMissionRes.ok, true);
    assert.equal(pauseMissionRes.paused, true);
    assert.equal(pauseMissionRes.status, "paused");
    assert.equal(typeof pauseMissionRes.pausedByPid, "number");

    // 4. ResumeWorkerRuntime (valid worktreePath) signals SIGUSR2 and transitions daemon back to running
    const resumeStdout = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "ResumeWorkerRuntime",
        "--mission-dir",
        tempMissionDir,
        "--json",
        JSON.stringify({
          activeWorker: {
            taskId: dispatchRes.taskId,
            childThreadId: dispatchRes.childThreadId,
            workerPid: dispatchRes.workerPid,
            daemonStateFile: dispatchRes.daemonStateFile,
            worktreePath: tempMissionDir
          },
          trigger: "[resume the mission]",
          diagnostic: "Tree is clean."
        })
      ],
      { env: cleanEnv, encoding: "utf8" }
    );
    const resumeRes = JSON.parse(resumeStdout);
    assert.equal(resumeRes.ok, true);
    assert.equal(resumeRes.resumed, true);
    assert.equal(resumeRes.taskId, dispatchRes.taskId);
    assert.equal(resumeRes.childThreadId, dispatchRes.childThreadId);
    assert.equal(resumeRes.workerPid, dispatchRes.workerPid);
    assert.equal(resumeRes.daemonStatus, "running");
    assert.equal(resumeRes.trigger, "[resume the mission]");
    assert.equal(typeof resumeRes.wokenByPid, "number");

    const resumedDaemonState = JSON.parse(fs.readFileSync(dispatchRes.daemonStateFile, "utf8"));
    assert.equal(resumedDaemonState.status, "running");
    assert.equal(resumedDaemonState.resumeCount, 1);

    // 5. ResumeWorkerRuntime fails with exit code 1 when worktreePath does not exist
    assert.throws(
      () => {
        execFileSync(
          process.execPath,
          [
            CLI_PATH,
            "ResumeWorkerRuntime",
            "--mission-dir",
            tempMissionDir,
            "--json",
            JSON.stringify({
              activeWorker: {
                taskId: dispatchRes.taskId,
                childThreadId: dispatchRes.childThreadId,
                worktreePath: path.join(tempMissionDir, "non-existent-worktree")
              }
            })
          ],
          { env: cleanEnv, encoding: "utf8" }
        );
      },
      (err) => {
        assert.equal(err.status, 1);
        const parsedErr = JSON.parse(err.stderr);
        assert.equal(parsedErr.ok, false);
        assert.equal(parsedErr.resumed, false);
        assert.equal(parsedErr.canResume, false);
        assert.equal(parsedErr.error, "Active worker worktree path does not exist");
        return true;
      }
    );

    // 6. Removing tempMissionDir causes LocalWorkerDaemon to self-terminate
    fs.rmSync(tempMissionDir, { recursive: true, force: true });
    let exited = false;
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(dispatchRes.workerPid, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        exited = true;
        break;
      }
    }
    assert.equal(exited, true);
    assert.equal(fs.existsSync(dispatchRes.daemonStateFile), false);
  } finally {
    if (spawnedPid) {
      try {
        process.kill(spawnedPid, "SIGTERM");
      } catch {}
    }
    fs.rmSync(tempMissionDir, { recursive: true, force: true });
  }
});

test("F03-daemon-lifetime & F03-dead-worker-control-success: PauseWorkerRuntime and ResumeWorkerRuntime fail with WORKER_NOT_ALIVE when local worker daemon is dead, and LocalWorkerDaemon exits on completed state.json session", async () => {
  const tempMissionDir = createTempDir("t3-f03-dead-worker-");
  let spawnedPid = null;
  try {
    const cleanEnv = { ...process.env, T3_ACP_MCP_NODE: "" };

    // Pre-commit state.json with activeWorker: null and empty sessions (as during POST /api/mission/approve)
    fs.writeFileSync(
      path.join(tempMissionDir, "state.json"),
      JSON.stringify({ activeWorker: null, sessions: [] }),
      "utf8"
    );

    const dispatchStdout = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "DispatchWorkerRuntime",
        "--mission-dir",
        tempMissionDir,
        "--json",
        JSON.stringify({
          missionId: "m-f03",
          runId: "run-f03-1",
          repoPath: tempMissionDir,
          feature: { id: "f-f03-1", title: "F03 Feature" }
        })
      ],
      { env: cleanEnv, encoding: "utf8" }
    );
    const dispatchRes = JSON.parse(dispatchStdout);
    spawnedPid = dispatchRes.workerPid;

    // Daemon stays alive when activeWorker is null and sessions does not yet have a completed/failed entry for runId
    await new Promise((r) => setTimeout(r, 150));
    assert.doesNotThrow(() => process.kill(dispatchRes.workerPid, 0));

    // Kill the local worker daemon process
    process.kill(dispatchRes.workerPid, "SIGKILL");
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(dispatchRes.workerPid, 0);
        await new Promise((r) => setTimeout(r, 20));
      } catch {
        break;
      }
    }

    // PauseWorkerRuntime fails with exitCode: 1 and WORKER_NOT_ALIVE when workerPid is dead
    assert.throws(
      () => {
        execFileSync(
          process.execPath,
          [
            CLI_PATH,
            "PauseWorkerRuntime",
            "--mission-dir",
            tempMissionDir,
            "--json",
            JSON.stringify({
              activeWorker: {
                taskId: dispatchRes.taskId,
                childThreadId: dispatchRes.childThreadId,
                workerPid: dispatchRes.workerPid,
                daemonStateFile: dispatchRes.daemonStateFile,
                runtimeTransport: "bridge-cli-subprocess"
              }
            })
          ],
          { env: cleanEnv, encoding: "utf8" }
        );
      },
      (err) => {
        assert.equal(err.status, 1);
        const parsedErr = JSON.parse(err.stderr);
        assert.equal(parsedErr.ok, false);
        assert.equal(parsedErr.paused, false);
        assert.equal(parsedErr.canPause, false);
        assert.equal(parsedErr.code, "WORKER_NOT_ALIVE");
        assert.equal(parsedErr.error, "Active worker daemon process is not alive");
        return true;
      }
    );

    // ResumeWorkerRuntime fails with exitCode: 1 and WORKER_NOT_ALIVE when workerPid is dead
    assert.throws(
      () => {
        execFileSync(
          process.execPath,
          [
            CLI_PATH,
            "ResumeWorkerRuntime",
            "--mission-dir",
            tempMissionDir,
            "--json",
            JSON.stringify({
              activeWorker: {
                taskId: dispatchRes.taskId,
                childThreadId: dispatchRes.childThreadId,
                workerPid: dispatchRes.workerPid,
                daemonStateFile: dispatchRes.daemonStateFile,
                worktreePath: tempMissionDir,
                runtimeTransport: "bridge-cli-subprocess"
              }
            })
          ],
          { env: cleanEnv, encoding: "utf8" }
        );
      },
      (err) => {
        assert.equal(err.status, 1);
        const parsedErr = JSON.parse(err.stderr);
        assert.equal(parsedErr.ok, false);
        assert.equal(parsedErr.resumed, false);
        assert.equal(parsedErr.canResume, false);
        assert.equal(parsedErr.code, "WORKER_NOT_ALIVE");
        assert.equal(parsedErr.error, "Active worker daemon process is not alive");
        return true;
      }
    );

    // In-memory activeWorker (without workerPid/daemonStateFile/runtimeTransport: "bridge-cli-subprocess") still succeeds
    const inMemoryPauseOut = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "PauseWorkerRuntime",
        "--mission-dir",
        tempMissionDir,
        "--json",
        JSON.stringify({
          activeWorker: {
            taskId: "in-mem-task-1",
            childThreadId: "in-mem-thread-1"
          }
        })
      ],
      { env: cleanEnv, encoding: "utf8" }
    );
    assert.equal(JSON.parse(inMemoryPauseOut).paused, true);

    const inMemoryResumeOut = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "ResumeWorkerRuntime",
        "--mission-dir",
        tempMissionDir,
        "--json",
        JSON.stringify({
          activeWorker: {
            taskId: "in-mem-task-1",
            childThreadId: "in-mem-thread-1",
            worktreePath: tempMissionDir
          }
        })
      ],
      { env: cleanEnv, encoding: "utf8" }
    );
    assert.equal(JSON.parse(inMemoryResumeOut).resumed, true);

    // Spawn a second daemon and verify it self-terminates when state.json records completed session for runId
    const dispatchStdout2 = execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "DispatchWorkerRuntime",
        "--mission-dir",
        tempMissionDir,
        "--json",
        JSON.stringify({
          missionId: "m-f03",
          runId: "run-f03-2",
          repoPath: tempMissionDir,
          feature: { id: "f-f03-2", title: "F03 Feature 2" }
        })
      ],
      { env: cleanEnv, encoding: "utf8" }
    );
    const dispatchRes2 = JSON.parse(dispatchStdout2);
    spawnedPid = dispatchRes2.workerPid;
    assert.doesNotThrow(() => process.kill(dispatchRes2.workerPid, 0));

    fs.writeFileSync(
      path.join(tempMissionDir, "state.json"),
      JSON.stringify({
        activeWorker: null,
        sessions: [{ runId: "run-f03-2", featureId: "f-f03-2", status: "completed" }]
      }),
      "utf8"
    );

    let exited2 = false;
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(dispatchRes2.workerPid, 0);
        await new Promise((r) => setTimeout(r, 25));
      } catch {
        exited2 = true;
        break;
      }
    }
    assert.equal(exited2, true);
    assert.equal(fs.existsSync(dispatchRes2.daemonStateFile), false);
  } finally {
    if (spawnedPid) {
      try {
        process.kill(spawnedPid, "SIGTERM");
      } catch {}
    }
    fs.rmSync(tempMissionDir, { recursive: true, force: true });
  }
});

test("SKILL.md contains complete YAML frontmatter and required workflow instructions", () => {
  const content = fs.readFileSync(SKILL_PATH, "utf8");
  assert.match(content, /^---\r?\nname:\s*t3-mission-mode\r?\ndescription:\s*.+\r?\n---/s);
  assert.match(content, /preview_open/);
  assert.match(content, /Explorer/);
  assert.match(content, /ProposeMission/);
  assert.match(content, /Approve/);
  assert.match(content, /StartMissionRun/);
  assert.match(content, /CheckMissionStateBeforeResuming/);
  assert.match(content, /\[resume the mission\]/);
  assert.match(content, /T3_APPROVAL_TO_DROID_AUTONOMY/);
  assert.match(content, /DROID_AUTONOMY_TO_T3_RUNTIME_MODE/);
  assert.match(content, /acpRegistry_devin/);
  assert.match(content, /acpRegistry_cursor/);
});
