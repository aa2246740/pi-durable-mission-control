import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildMissionTaskTitle,
  buildStableClientRequestId,
  callT3McpTool,
  checkGitTreeBeforeResume,
  createT3Adapter,
  delegateMissionTask,
  getOrchestratorCapabilities,
  normalizeTargetFromSlot,
  resolveTargetFromModelSettings,
  resumeWorker,
  settleCompletedMilestoneThreads
} from "../bridge/t3-adapter.mjs";

import {
  callMissionTool,
  createMissionMcpServer,
  handleJsonRpcMessage,
  MISSION_TOOL_NAMES,
  MISSION_TOOLS,
  startStdioMcpServer
} from "../bridge/mcp-server.mjs";

import { parseCliArgs, runCli } from "../bridge/cli.mjs";

const execFileAsync = promisify(execFileCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../bridge/cli.mjs");
const SKILL_PATH = path.resolve(__dirname, "../skill/SKILL.md");

function createTempDir(prefix = "t3-mission-bridge-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// VAL-BRIDGE-001: Model Slot & Provider Option Normalization
// ============================================================================

test("VAL-BRIDGE-001: normalizeTargetFromSlot maps codex reasoningEffort correctly", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
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
  assert.equal(outcome.action, "blocked_by_conflicts");
  assert.equal(outcome.gitCheck.hasConflicts, true);
  assert.equal(mcpCalls.length, 0);
});

// ============================================================================
// VAL-BRIDGE-003: MCP Server JSON-RPC 2.0 & CLI Entrypoint
// ============================================================================

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
        dismissals: [{ itemId: "iss-1", type: "discovered_issue", reason: "Non-blocking" }]
      }
    ],
    [
      "EndFeatureRun",
      {
        missionDir: "/tmp/mock-mission",
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

test("VAL-BRIDGE-003: CLI entrypoint executes commands via node t3-mission/bridge/cli.mjs <command> --mission-dir <dir> [--json <payload>]", async () => {
  const tempMissionDir = createTempDir("t3-cli-e2e-");
  try {
    // 1. ProposeMission via CLI subprocess
    const proposePayload = JSON.stringify({
      title: "CLI E2E Mission",
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
      CLI_PATH,
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
});
