---
name: t3-mission-mode
description: Launch, orchestrate, validate, and losslessly resume durable multi-milestone Missions in T3 Code using T3 Orchestration V2, the Mission HUD, and three-role model slots (Orchestrator, Worker, Validator). Trigger when the user enters `/mission <request>`, says "开启 mission" / "start mission", or says `[resume the mission]` / "继续" / "恢复 mission".
---

# T3 Mission Mode (`t3-mission-mode`)

This skill turns the current T3 Code thread into a durable **Mission Orchestrator** backed by `.mission/` state files, the live **Mission HUD** preview panel, and **T3 Code Orchestration V2** (`orchestrator_capabilities`, `delegate_task`, `t3_thread_send`, `t3_thread_organize`).

## Core Architecture & Roles

Every Mission uses three independent model slots configured in `.mission/model-settings.json`:

1. **Orchestrator (`orchestrator`)**: Plans milestones/features/validation contracts (`VAL-*`), coordinates handoffs, and manages user checkpoints.
2. **Worker (`worker`)**: Executes scoped feature implementations inside isolated worktrees (`isolation: "worktree"`, `role: "implementation"`).
3. **Validator (`validator`)**: Performs independent **Scrutiny** (`role: "review"`) and **User-Testing** (`role: "test"`) validation at the end of every Milestone.

### Provider Slot Normalization (`normalizeTargetFromSlot`)

When dispatching via `delegate_task`, model slot settings are normalized into `target: { providerInstanceId, model, options }`:
- `providerInstanceId === "codex"` -> `options.reasoningEffort` (`"low" | "medium" | "high" | "xhigh" | "max"`)
- `providerInstanceId === "antigravity"` -> direct `model` ID (e.g. `"gemini-4-argon-high"`, `"claude-opus-5-5-high"`)
- `providerInstanceId === "acpRegistry_factory_droid"` -> `options.reasoning_effort` and `options.autonomy_level: "auto-high"`
- `providerInstanceId === "pi"` -> `options.thinking`

---

## Workflow A: Starting a New Mission (`/mission <需求>` or "开启 mission")

When the user triggers `/mission <需求>` or asks to start a Mission ("开启 mission"):

### Step 1: Start the Mission HUD Server & Open the Preview Panel
1. Start the local Mission HUD server pointing at the repository's `.mission` directory (if not already running):
   ```bash
   node t3-mission/hud/server.mjs --mission-dir .mission
   ```
2. Check T3 preview status with `preview_status`, and open or navigate the right-side collaborative panel with `preview_open` / `preview_navigate` to the HUD URL so the user can monitor live progress, review the plan, and configure model slots.

### Step 2: Dispatch Read-Only `Explorer` Subtasks to Survey the Repository
1. Query `orchestrator_capabilities` to inspect live available providers and models.
2. Dispatch one or more read-only `Explorer` subtasks (`role: "research"`, title format `[M1] Explorer #1: <scope>`) to map the repository structure, existing conventions, test runners, and architectural boundaries.

### Step 3: Propose the Mission Plan (`ProposeMission`) & Wait for User Approval
1. Synthesize the exploration findings into a structured Mission Plan containing:
   - **Milestones** (`M1`, `M2`, ...)
   - **Features** (scoped implementation units mapped to milestones and `VAL-*` assertions)
   - **Validation Contract** (`VAL-*` assertions with testable acceptance criteria)
   - **Three-Role Model Settings** (`orchestrator`, `worker`, `validator`)
2. Invoke `ProposeMission` via MCP or CLI:
   ```bash
   node t3-mission/bridge/cli.mjs ProposeMission --mission-dir .mission --json '<plan-payload>'
   ```
3. **HARD GUARDRAIL (Mandatory Approval Gate)**:
   - Prompt the user to review the proposed Milestones, Features, Validation Contract, and three-role model slots (`Orchestrator` / `Worker` / `Validator`) in the right-side **Mission HUD** and click **Approve** (or confirm approval).
   - **NEVER** call `StartMissionRun` or dispatch any implementation `Worker` before the user has explicitly approved the plan (`planAccepted === true`).

### Step 4: Execute Serial Workers & Mandatory Milestone Validators (`StartMissionRun`)
1. Once the user clicks **Approve** in the HUD (or approves the plan via `ApproveMissionPlan`):
   ```bash
   node t3-mission/bridge/cli.mjs ApproveMissionPlan --mission-dir .mission
   node t3-mission/bridge/cli.mjs StartMissionRun --mission-dir .mission
   ```
2. For each pending Feature in the active Milestone:
   - Dispatch the Worker using `delegate_task` with standardized title `[M<N>] Worker #<K>: <Feature Title>`, `role: "implementation"`, `isolation: "worktree"`, normalized `target` from the `worker` slot, and a stable idempotent `clientRequestId`.
   - When the Worker finishes, record its structured handoff via `EndFeatureRun`:
     ```bash
     node t3-mission/bridge/cli.mjs EndFeatureRun --mission-dir .mission --json '<handoff-payload>'
     ```
   - If the Worker handoff reports `discoveredIssues` or `whatWasLeftUndone`, either inject repair features with `UpdateMissionFeatures` or explicitly justify and dismiss non-blocking items with `DismissHandoffItems`.
3. At the end of every Milestone:
   - Automatically inject and run two independent Validators using the `validator` model slot:
     1. **Scrutiny Validator** (`[M<N>] Validator #<K>: Scrutiny validation for <Milestone>`, `role: "review"`) for code quality, boundary compliance, and test coverage.
     2. **User-Testing Validator** (`[M<N>] Validator #<K+1>: User-testing validation for <Milestone>`, `role: "test"`) for end-to-end verification of every `VAL-*` assertion.
   - Once all Milestone features and both Validators pass, call `settleCompletedMilestoneThreads(childThreadIds)` (`t3_thread_organize({ action: "settle", threadId })`) to neatly fold completed child threads.

---

## Workflow B: Lossless Pause & Resume (`[resume the mission]` or "继续")

When the user closes and reopens T3 Code, or sends `[resume the mission]` / `继续`:

### Step 1: Pre-Check Mission State and Git Working Tree (`CheckMissionStateBeforeResuming`)
1. Always run `CheckMissionStateBeforeResuming` first:
   ```bash
   node t3-mission/bridge/cli.mjs CheckMissionStateBeforeResuming --mission-dir .mission
   ```
2. This performs two critical checks:
   - Reconciles `.mission/state.json` (`reconcileMissionOnLoad`) and inspects `state.activeWorker`.
   - Runs `checkGitTreeBeforeResume(worktreePath || repoPath)` to inspect `git status --porcelain` for uncommitted changes or unresolved merge conflicts, producing a diagnostic summary such as:
     > `"The mission was paused on feature "f1", and the code tree has no uncommitted changes, so I'm resuming that worker."`
3. If unresolved Git merge conflicts are detected (`hasConflicts: true`), report the conflicted files to the user and do not overwrite or blindly restart the worktree.

### Step 2: Wake Up the Original Worker Thread (`StartMissionRun` -> `resumeWorker`)
1. If an interrupted `activeWorker` exists and `canResume` is `true`, invoke `StartMissionRun`:
   ```bash
   node t3-mission/bridge/cli.mjs StartMissionRun --mission-dir .mission
   ```
2. When `activeWorker.childThreadId` is present, the bridge adapter (`resumeWorker`) **prioritizes calling `t3_thread_send({ threadId: activeWorker.childThreadId, message })`** rather than spawning a duplicate `delegate_task`, waking up the exact original Worker conversation in its existing worktree to finish the feature losslessly.
