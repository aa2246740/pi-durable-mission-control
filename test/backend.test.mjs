import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { calculateCost } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { ControlPlane } from "../dist/control.js";
import { createRuntimeProvider, openWorkerRuntime } from "../dist/worker.js";
import { startServer } from "../dist/server.js";
import { redactDiagnosticChunk } from "../dist/workers.js";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

test("custom model adapter provides required SDK rates without claiming unknown prices are free", () => {
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses"]) {
    const unpriced = { ...profile, api };
    delete unpriced.cost;
    const [model] = createRuntimeProvider(unpriced).getModels();
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    assert.doesNotThrow(() => calculateCost(model, usage));
    assert.equal(unpriced.cost, undefined, "SDK placeholders must not set product pricing");
    const [priced] = createRuntimeProvider({ ...unpriced, cost: { input: 2, output: 4, cacheRead: 1, cacheWrite: 3 } }).getModels();
    assert.ok(Math.abs(calculateCost(priced, usage).total - 0.00004) < 1e-18);
  }
});

function validationTarget(f, suffix) {
  const task = f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, `task-${suffix}`, {
    missionId: f.mission.id, title: `Task ${suffix}`, description: "", acceptance: "The command succeeds",
    dependencies: [], ownerId: f.worker.id, validatorId: f.validator.id
  });
  f.control.updateTask(f.worker.id, f.worker.epoch, `start-${suffix}`, task.id, { status: "running" });
  f.control.updateTask(f.worker.id, f.worker.epoch, `review-${suffix}`, task.id, { status: "review" });
  const path = join(f.workspacePath, `${suffix}.txt`);
  writeFileSync(path, `immutable ${suffix}`);
  const artifact = f.control.publishArtifact(f.worker.id, f.worker.epoch, `artifact-${suffix}`, "Validation input", path, readFileSync(path), task.id);
  return { task, artifact };
}

const profile = {
  id: "test-profile",
  name: "Test-only faux",
  api: "openai-completions",
  modelId: "faux-1",
  baseUrl: "http://127.0.0.1:9999",
  credentialEnv: "",
  contextWindow: 16000,
  maxTokens: 512,
  reasoning: false,
  toolCalling: true,
  vision: false,
  revision: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

function fixture({ maxTurns = 10, maxCost = 1, autonomy = "trusted" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "mission-control-test-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const stateHome = join(home, "state");
  const control = new ControlPlane(stateHome);
  control.upsertProfile(profile);
  const roleIds = ["orchestrator", "worker", "validator"];
  for (const kind of roleIds) control.upsertRole({ id: kind, name: kind, kind, instructions: `${kind} test instructions`, profileId: profile.id });
  const workspace = control.addWorkspace("test workspace", workspacePath);
  const mission = control.createMission({
    title: "Test mission",
    goal: "Exercise control-plane gates",
    acceptance: "Assertions pass",
    workspaceId: workspace.id,
    roleIds,
    maxTurns,
    maxCost,
    autonomy
  });
  const started = control.missionAction(mission.id, "start");
  const orchestrator = control.getAgentPublic(started.orchestratorId);
  const worker = control.createAgent(mission.id, "Worker", "worker", "system prompt", "create-worker");
  const validator = control.createAgent(mission.id, "Validator", "validator", "system prompt", "create-validator");
  return { home, stateHome, workspacePath, control, workspace, mission, orchestrator, worker, validator };
}

test("WaitForMessage ends a native run and only new durable input wakes it after reopen", async () => {
  const f = fixture();
  let runtime;
  const config = {
    agentId: f.worker.id, missionId: f.mission.id, epoch: f.worker.epoch,
    token: "test-only-internal-token", durablePath: join(f.stateHome, "agents", `${f.worker.id}.sqlite`),
    workspacePath: f.workspacePath, profile: f.control.profile(f.worker.profileId),
    role: f.control.role(f.worker.roleId), testOnlyScripted: true
  };
  const wait = fauxAssistantMessage(fauxToolCall("WaitForMessage", {}), { stopReason: "toolUse" });
  try {
    runtime = await openWorkerRuntime(config, async (id) => f.control.admitTurn(f.worker.id, f.worker.epoch, id));
    runtime.faux.setResponses([wait, fauxAssistantMessage("Must not poll after waiting")]);
    const first = await runtime.root.submit({ type: "input", content: "Wait for assigned work", requestId: "waiting:1" }, BACKGROUND_CONTEXT);
    assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, "done");
    await runtime.root.waitForIdle(BACKGROUND_CONTEXT);
    assert.equal(runtime.faux.state.callCount, 1);
    assert.equal(runtime.faux.getPendingResponseCount(), 1);
    const firstId = first.id;
    await runtime.harness.close(BACKGROUND_CONTEXT);
    runtime = undefined;

    runtime = await openWorkerRuntime(config, async (id) => f.control.admitTurn(f.worker.id, f.worker.epoch, id));
    runtime.faux.setResponses([wait, fauxAssistantMessage("Must not poll after waking")]);
    const duplicate = await runtime.root.submit({ type: "input", content: "Wait for assigned work", requestId: "waiting:1" }, BACKGROUND_CONTEXT);
    assert.equal(duplicate.id, firstId);
    assert.equal((await duplicate.wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal(runtime.faux.state.callCount, 0);
    const next = await runtime.root.submit({ type: "input", content: "A new assignment is ready", requestId: "waiting:2" }, BACKGROUND_CONTEXT);
    assert.notEqual(next.id, firstId);
    assert.equal((await next.wait(BACKGROUND_CONTEXT)).status, "done");
    await runtime.root.waitForIdle(BACKGROUND_CONTEXT);
    assert.equal(runtime.faux.state.callCount, 1);
    assert.equal(runtime.faux.getPendingResponseCount(), 1);
  } finally {
    await runtime?.harness.close(BACKGROUND_CONTEXT);
    clean(f);
  }
});

test("starting a mission creates exactly one orchestrator and stable durable opening work", () => {
  const f = fixture();
  try {
    assert.throws(() => f.control.createMission({
      title: "Invalid team", goal: "Reject incomplete roles", acceptance: "Rejected",
      workspaceId: f.workspace.id, roleIds: ["orchestrator"], maxTurns: 10, maxCost: 1, autonomy: "trusted"
    }), /exactly one orchestrator, at least one worker, and at least one validator/);
    f.control.upsertRole({ id: "second-worker", kind: "worker", name: "Second worker", instructions: "Second implementation specialty", profileId: profile.id });
    const largerTeam = {
      title: "Multiple specialties", goal: "Allow more than three roles", acceptance: "Unique enabled roles",
      workspaceId: f.workspace.id, roleIds: ["orchestrator", "worker", "second-worker", "validator"], maxTurns: 10, maxCost: 1, autonomy: "trusted"
    };
    assert.deepEqual(f.control.createMission(largerTeam).roleIds, largerTeam.roleIds);
    assert.throws(() => f.control.createMission({ ...largerTeam, roleIds: [...largerTeam.roleIds, "second-worker"] }), /unique roles/);
    const agents = f.control.listAgents(f.mission.id).filter((agent) => agent.kind === "orchestrator");
    const openings = f.control.detail(f.mission.id).messages.filter((message) => message.id === `mission-opening:${f.mission.id}`);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, f.orchestrator.id);
    assert.equal(openings.length, 1);
    assert.equal(openings[0].status, "queued");
    assert.match(openings[0].content, new RegExp(f.mission.goal));
    assert.match(openings[0].content, new RegExp(f.workspacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(f.control.pendingOutbox().some((row) => row.message_id === openings[0].id && row.request_id === `${openings[0].id}:1`));
  } finally {
    clean(f);
  }
});

function clean(f) {
  f.control.close();
  rmSync(f.home, { recursive: true, force: true });
}

for (const runtimeMode of [undefined, "remote-metadata-only", "remote-workspace-effects"]) {
  for (const kind of ["worker", "validator", "orchestrator"]) {
    test(`${runtimeMode ?? "local"} ${kind} tools reserve human questions for the orchestrator`, async () => {
      const f = fixture();
      let runtime;
      const agent = f[kind];
      try {
        runtime = await openWorkerRuntime({
          agentId: agent.id, missionId: f.mission.id, epoch: agent.epoch,
          token: "test-only-internal-token", durablePath: join(f.stateHome, "agents", `${agent.id}.sqlite`),
          workspacePath: f.workspacePath, profile: f.control.profile(agent.profileId),
          role: f.control.role(agent.roleId), runtimeMode, artifactTransfers: true, testOnlyScripted: true
        });
        const resolved = await runtime.root.agent(BACKGROUND_CONTEXT);
        const names = resolved.tools.map(tool => tool.name);
        assert.ok(names.includes("Report"));
        assert.ok(names.includes("SendMessage"));
        assert.equal(names.includes("RequestUserInput"), kind === "orchestrator");
      } finally {
        await runtime?.harness.close(BACKGROUND_CONTEXT);
        clean(f);
      }
    });
  }
}

test("only orchestrator questions create blockers and receive durable user answers", async () => {
  const f = fixture();
  const ask = agent => f.control.workerCommand({
    agentId: agent.id, epoch: agent.epoch, method: "RequestUserInput",
    taskId: `${agent.id}:question`, args: { question: "Choose a value" }
  });
  try {
    for (const agent of [f.worker, f.validator]) {
      await assert.rejects(() => ask(agent), error => {
        assert.equal(error.status, 403);
        assert.match(error.message, /Only the orchestrator/);
        assert.match(error.message, /Report/);
        assert.match(error.message, /SendMessage/);
        return true;
      });
      assert.equal(f.control.missionById(f.mission.id).status, "active");
      assert.deepEqual(f.control.blockers(f.mission.id), []);
      assert.equal(f.control.getAgentPublic(agent.id).status, agent.status);
    }
    const blocker = await ask(f.orchestrator);
    assert.equal(blocker.kind, "user_input");
    assert.equal(blocker.agentId, f.orchestrator.id);
    assert.equal(f.control.missionById(f.mission.id).status, "blocked");
    f.control.resolveBlocker(blocker.id, "Use the safe default");
    const answer = f.control.detail(f.mission.id).messages.find(message => message.id === `blocker-resolution:${blocker.id}`);
    assert.equal(answer.recipientId, f.orchestrator.id);
    assert.equal(answer.content, "Use the safe default");
    assert.equal(answer.status, "queued");
    assert.equal(f.control.missionById(f.mission.id).status, "active");
  } finally {
    clean(f);
  }
});

test("task assignment errors list mission agent identities for CreateTask and UpdateTask", async () => {
  const f = fixture();
  try {
    const input = {
      missionId: f.mission.id, title: "Handoff", description: "Review published delivery", acceptance: "Validate published work",
      dependencies: [], ownerId: f.worker.id, validatorId: f.validator.id
    };
    const task = f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "valid-assignment", input);
    for (const method of ["CreateTask", "UpdateTask"]) {
      for (const [field, wrongId] of [["ownerId", "worker"], ["validatorId", "validator"], ["ownerId", f.validator.id], ["validatorId", "unknown-agent"]]) {
        await assert.rejects(() => f.control.workerCommand({
          agentId: f.orchestrator.id, epoch: f.orchestrator.epoch,
          taskId: `${method}:${field}:${wrongId}`, method,
          args: method === "CreateTask" ? { ...input, [field]: wrongId } : { taskId: task.id, [field]: wrongId }
        }), error => {
          assert.equal(error.status, 400);
          assert.ok(error.message.includes(`${f.worker.id} ("Worker")`));
          assert.ok(error.message.includes(`${f.validator.id} ("Validator")`));
          assert.match(error.message, /roleId is not an agent id/);
          assert.match(error.message, /agent id returned by SpawnAgent/);
          return true;
        });
      }
    }
    assert.equal(f.control.detail(f.mission.id).tasks.length, 1);
    assert.equal(f.control.task(task.id).ownerId, f.worker.id);
    assert.equal(f.control.task(task.id).validatorId, f.validator.id);
  } finally {
    clean(f);
  }
});

test("all validation status gates give the same actionable handoff error", async () => {
  const f = fixture();
  try {
    const { task, artifact } = validationTarget(f, "status-error");
    f.control.updateTask(f.worker.id, f.worker.epoch, "back-to-running", task.id, { status: "running" });
    const input = { taskId: task.id, command: "printf validated", artifactIds: [artifact.id] };
    const errors = [];
    for (const operation of [
      () => f.control.runValidation(f.validator.id, f.validator.epoch, "status-run", input),
      () => f.control.createApproval(f.validator.id, f.validator.epoch, "status-approval", "run_validation", input),
      () => f.control.validateTask(f.validator.id, f.validator.epoch, "status-decision", task.id, "no-receipt", true, "not executed")
    ]) {
      await assert.rejects(async () => operation(), error => {
        assert.equal(error.status, 409);
        assert.ok(error.message.includes(`Task ${task.id} is currently running`));
        assert.match(error.message, /owner or orchestrator.*UpdateTask.*status=review/);
        assert.match(error.message, /Validators cannot change task status/);
        assert.match(error.message, /SendMessage or Report.*orchestrator/);
        assert.match(error.message, /Do not ask the user/);
        errors.push(error.message);
        return true;
      });
    }
    assert.equal(new Set(errors).size, 1);
    assert.equal(f.control.task(task.id).status, "running");
    assert.equal(f.control.detail(f.mission.id).validationReceipts.length, 0);
    assert.equal(f.control.detail(f.mission.id).approvals.length, 0);
    assert.deepEqual(f.control.blockers(f.mission.id), []);
  } finally {
    clean(f);
  }
});

test("owner publication returns current handoff state without changing the task or artifact fields", async () => {
  const f = fixture();
  try {
    const { task } = validationTarget(f, "publish-handoff");
    f.control.updateTask(f.worker.id, f.worker.epoch, "publish-running", task.id, { status: "running" });
    const path = join(f.workspacePath, "publish-handoff.txt");
    const request = {
      agentId: f.worker.id, epoch: f.worker.epoch, method: "PublishArtifact", taskId: "publish-with-handoff",
      args: { name: "Handoff input", path, taskId: task.id }
    };
    const result = await f.control.workerCommand(request);
    const { task: state, nextStep, ...artifact } = result;
    assert.deepEqual(state, { id: task.id, status: "running" });
    assert.match(nextStep, /When delivery is complete.*UpdateTask.*status=review, then Report/);
    assert.ok(nextStep.includes(task.id));
    assert.deepEqual(artifact, f.control.artifact(result.id));
    assert.deepEqual(readFileSync(result.snapshotPath), readFileSync(path));
    assert.equal(f.control.task(task.id).status, "running");
    const orchestratorPublication = f.control.publishArtifact(f.orchestrator.id, f.orchestrator.epoch,
      "orchestrator-publication", "Reference", path, readFileSync(path), task.id);
    assert.equal(Object.hasOwn(orchestratorPublication, "nextStep"), false);
    f.control.updateTask(f.worker.id, f.worker.epoch, "publish-review", task.id, { status: "review" });
    const replay = await f.control.workerCommand(request);
    assert.equal(replay.id, result.id);
    assert.deepEqual(replay.task, { id: task.id, status: "review" });
    assert.equal(Object.hasOwn(replay, "nextStep"), false);
    const reviewed = await f.control.workerCommand({ ...request, taskId: "publish-already-review" });
    assert.deepEqual(reviewed.task, { id: task.id, status: "review" });
    assert.equal(Object.hasOwn(reviewed, "nextStep"), false);
  } finally {
    clean(f);
  }
});

test("orchestrator recovers a published running task and completes independent validation without user input", async () => {
  const f = fixture();
  const command = (agent, method, args, taskId) => f.control.workerCommand({
    agentId: agent.id, epoch: agent.epoch, method, args, taskId
  });
  try {
    const task = await command(f.orchestrator, "CreateTask", {
      title: "Delivery", description: "Publish the acceptance file", acceptance: "Published file is correct", dependencies: [],
      ownerId: f.worker.id, validatorId: f.validator.id, fulfills: ["REQ-001"]
    }, "handoff-task");
    await command(f.worker, "UpdateTask", { taskId: task.id, status: "running" }, "handoff-running");
    const path = join(f.workspacePath, "delivery.txt");
    writeFileSync(path, "ready for acceptance");
    const artifact = await command(f.worker, "PublishArtifact", { name: "Delivery", path, taskId: task.id }, "handoff-publish");
    await command(f.worker, "Report", { summary: "Delivery published", evidence: artifact.id }, "handoff-report");
    const validation = { taskId: task.id, command: "test \"$(cat delivery.txt)\" = 'ready for acceptance'", artifactIds: [artifact.id] };
    await assert.rejects(() => command(f.validator, "RunValidation", validation, "handoff-premature-validation"), /currently running/);
    await assert.rejects(() => command(f.validator, "RequestUserInput", { question: "Move to review?" }, "handoff-premature-question"), error => error.status === 403);
    await command(f.validator, "SendMessage", {
      recipientId: f.orchestrator.id, content: `Task ${task.id} has a complete artifact; use UpdateTask status=review.`, mode: "followUp"
    }, "handoff-notify");
    await command(f.orchestrator, "UpdateTask", { taskId: task.id, status: "review" }, "handoff-recover-review");
    const receipt = await command(f.validator, "RunValidation", validation, "handoff-real-validation");
    assert.equal(receipt.exitCode, 0);
    await command(f.validator, "ValidateTask", {
      taskId: task.id, receiptId: receipt.id, passed: true, evidence: "Published delivery passed the acceptance command",
      assertionResults: [{ assertionId: "REQ-001", status: "passed", evidence: "The delivery file contains the expected acceptance text" }]
    }, "handoff-accept");
    await command(f.orchestrator, "CompleteMission", {}, "handoff-complete");
    assert.equal(f.control.missionById(f.mission.id).status, "completed");
    assert.equal(f.control.task(task.id).status, "accepted");
    assert.equal(f.control.detail(f.mission.id).validationReceipts.length, 1);
    assert.deepEqual(f.control.blockers(f.mission.id), []);
  } finally {
    clean(f);
  }
});

test("profile and bound-role revisions are retained in mission audit history", () => {
  const f = fixture();
  try {
    const revisedProfile = f.control.upsertProfile({ ...profile, id: "revision-profile", name: "Revision profile" });
    f.control.setAgentStatus(f.worker.id, f.worker.epoch, "idle");
    const pending = f.control.sendMessage(f.mission.id, f.worker.id, "Queued work blocks reconfiguration", "followUp", "profile-revision-work");
    const pendingOutbox = f.control.db.prepare("SELECT id,request_id,attempt FROM outbox WHERE message_id=?").get(pending.id);
    assert.throws(() => f.control.updateAgentProfile(f.worker.id, revisedProfile.id), /queued or in-flight work/);
    assert.equal(f.control.markOutboxDispatching(pendingOutbox.id, f.worker.epoch), true);
    assert.equal(f.control.ackOutbox(pending.id, pendingOutbox.request_id, pendingOutbox.attempt, f.worker.epoch, "completed"), true);
    const opening = f.control.pendingOutbox().find((row) => f.control.message(row.message_id)?.recipientId === f.worker.id);
    if (opening) {
      assert.equal(f.control.markOutboxDispatching(opening.id, f.worker.epoch), true);
      assert.equal(f.control.ackOutbox(opening.message_id, opening.request_id, opening.attempt, f.worker.epoch, "completed"), true);
    }
    assert.equal(f.control.setAgentStatus(f.worker.id, f.worker.epoch, "idle"), true);
    const agent = f.control.updateAgentProfile(f.worker.id, revisedProfile.id);
    assert.equal(agent.profileRevision, revisedProfile.revision);
    const profileEvent = f.control.detail(f.mission.id).events.find((event) => event.type === "agent_profile_changed");
    assert.equal(profileEvent.data.profileRevision, revisedProfile.revision);

    f.control.upsertRole({ id: "worker", name: "Worker v2", kind: "worker", instructions: "Updated role", profileId: revisedProfile.id });
    const roleEvent = f.control.detail(f.mission.id).events.find((event) => event.type === "role_profile_changed");
    assert.equal(roleEvent.data.roleRevision, 2);
    assert.equal(roleEvent.data.modelRevision, revisedProfile.revision);
  } finally {
    clean(f);
  }
});

test("command IDs are idempotent and reject changed payloads; workers cannot cross mission or role boundaries", () => {
  const f = fixture();
  try {
    const repeated = f.control.createAgent(f.mission.id, "Worker", "worker", "system prompt", "create-worker");
    assert.equal(repeated.id, f.worker.id);
    assert.throws(
      () => f.control.createAgent(f.mission.id, "Different worker", "worker", "different prompt", "create-worker"),
      /different payload/
    );

    const otherMission = f.control.createMission({
      title: "Other mission",
      goal: "Separate scope",
      acceptance: "Separate",
      workspaceId: f.workspace.id,
      roleIds: ["orchestrator", "worker", "validator"],
      maxTurns: 10,
      maxCost: 1,
      autonomy: "trusted"
    });
    const otherWorker = f.control.createAgent(otherMission.id, "Other worker", "worker", "prompt", "other-worker");
    const input = { missionId: otherMission.id, title: "Cross-mission task", description: "", acceptance: "", dependencies: [] };
    assert.throws(() => f.control.createTask(f.worker.id, f.worker.epoch, "cross-mission", input), /not authorized/);
    assert.throws(() => f.control.createTask(f.worker.id, f.worker.epoch, "worker-task", { ...input, missionId: f.mission.id }), /Only the orchestrator/);
    assert.notEqual(otherWorker.missionId, f.worker.missionId);
  } finally {
    clean(f);
  }
});

test("dependency cycles, independent validation, rework, and completion gates are enforced", async () => {
  const f = fixture();
  try {
    const first = f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "task-first", {
      missionId: f.mission.id, title: "First", description: "", acceptance: "Evidence", dependencies: [],
      ownerId: f.worker.id, validatorId: f.validator.id
    });
    const second = f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "task-second", {
      missionId: f.mission.id, title: "Second", description: "", acceptance: "Evidence", dependencies: [first.id],
      ownerId: f.worker.id, validatorId: f.validator.id
    });
    assert.equal(second.status, "blocked");
    assert.throws(
      () => f.control.updateTask(f.orchestrator.id, f.orchestrator.epoch, "task-cycle", first.id, { dependencies: [second.id] }),
      /cycle/
    );
    f.control.updateTask(f.orchestrator.id, f.orchestrator.epoch, "first-review", first.id, { status: "review" });
    const artifactPath = join(f.workspacePath, "validation-evidence.txt");
    writeFileSync(artifactPath, "immutable validation target");
    const artifact = f.control.publishArtifact(f.worker.id, f.worker.epoch, "first-artifact", "Validation evidence", artifactPath, readFileSync(artifactPath), first.id);
    const firstReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "first-validation-run", { taskId: first.id, command: "printf first-validation; exit 0", artifactIds: [artifact.id] });
    writeFileSync(artifactPath, "changed after validation");
    assert.throws(
      () => f.control.validateTask(f.validator.id, f.validator.epoch, "stale-validation", first.id, firstReceipt.id, true, "must reject changed artifact"),
      /artifact is stale or has changed/
    );
    writeFileSync(artifactPath, "immutable validation target");
    assert.throws(
      () => f.control.validateTask(f.validator.id, f.validator.epoch, "missing-evidence", first.id, firstReceipt.id, true, "   "),
      /evidence is required/
    );
    assert.throws(
      () => f.control.validateTask(f.worker.id, f.worker.epoch, "owner-validation", first.id, firstReceipt.id, true, "worker's own review"),
      /Only a validator/
    );
    const failedReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "first-validation-failure", { taskId: first.id, command: "printf failure-output; exit 7", artifactIds: [artifact.id] });
    assert.equal(failedReceipt.exitCode, 7);
    assert.equal(failedReceipt.stdout, "failure-output");
    assert.equal(failedReceipt.command, "printf failure-output; exit 7");
    f.control.validateTask(f.validator.id, f.validator.epoch, "first-failure", first.id, failedReceipt.id, false, "Test failed");
    assert.equal(f.control.detail(f.mission.id).tasks.find((task) => task.id === first.id).attempt, 1);
    f.control.updateTask(f.worker.id, f.worker.epoch, "rework-start", first.id, { status: "running" });
    f.control.updateTask(f.worker.id, f.worker.epoch, "rework-review", first.id, { status: "review" });
    const successReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "second-validation-run", { taskId: first.id, command: "printf rework-passed; exit 0", artifactIds: [artifact.id] });
    f.control.validateTask(f.validator.id, f.validator.epoch, "first-success", first.id, successReceipt.id, true, "Test passed");
    assert.equal(f.control.detail(f.mission.id).tasks.find((task) => task.id === second.id).status, "ready");
    await assert.rejects(
      () => f.control.workerCommand({ id: "complete", token: "internal", agentId: f.orchestrator.id, epoch: f.orchestrator.epoch, method: "CompleteMission", args: {}, taskId: "complete" }),
      /All required tasks/
    );
  } finally {
    clean(f);
  }
});

test("validation commands single-flight, replay terminal receipts, and fence uncertain recovery", async () => {
  const f = fixture();
  try {
    const { task, artifact } = validationTarget(f, "singleflight");
    const input = {
      taskId: task.id,
      command: "printf validated",
      artifactIds: [artifact.id]
    };
    const [first, concurrent] = await Promise.all([
      f.control.runValidation(f.validator.id, f.validator.epoch, "validation-singleflight", input),
      f.control.runValidation(f.validator.id, f.validator.epoch, "validation-singleflight", input)
    ]);
    assert.equal(first.id, concurrent.id);
    assert.equal(f.control.detail(f.mission.id).validationReceipts.filter((receipt) => receipt.id === first.id).length, 1);
    const replay = await f.control.runValidation(f.validator.id, f.validator.epoch, "validation-singleflight", input);
    assert.equal(replay.id, first.id);
    await assert.rejects(
      () => f.control.runValidation(f.validator.id, f.validator.epoch, "validation-singleflight", { ...input, command: "printf changed" }),
      /different payload/
    );
    const outcome = f.control.validateTask(f.validator.id, f.validator.epoch, "validation-terminal", task.id, first.id, true, "Command passed");
    assert.equal(outcome.receiptId, first.id);
    assert.equal(
      f.control.validateTask(f.validator.id, f.validator.epoch, "validation-terminal", task.id, first.id, true, "Command passed").id,
      outcome.id
    );
    assert.throws(
      () => f.control.updateTask(f.worker.id, f.worker.epoch, "accepted-task-change", task.id, { title: "Changed after acceptance" }),
      /accepted task cannot be modified/
    );
    assert.throws(
      () => f.control.updateTask(f.worker.id, f.worker.epoch, "accepted-task-acceptance-change", task.id, { acceptance: "Weakened" }),
      /Only the orchestrator may edit authoritative task acceptance/
    );
    assert.throws(
      () => f.control.updateTask(f.orchestrator.id, f.orchestrator.epoch, "accepted-task-orchestrator-change", task.id, { title: "Changed after acceptance" }),
      /accepted task cannot be modified/
    );

    const pendingTarget = validationTarget(f, "pending");
    const pendingPayload = { taskId: pendingTarget.task.id, command: "printf should-not-run", artifactIds: [pendingTarget.artifact.id] };
    const pendingDigest = createHash("sha256").update(stable(pendingPayload)).digest("hex");
    const pendingScope = `mission:${f.mission.id}:validation:${f.validator.id}`;
    f.control.db.prepare("INSERT INTO validation_intents(scope,command_id,payload_hash,status,mission_id,task_id,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(pendingScope, "interrupted-validation", pendingDigest, "pending", f.mission.id, pendingTarget.task.id, "pending-receipt", new Date().toISOString());
    const stateHome = f.stateHome;
    f.control.close();
    f.control = new ControlPlane(stateHome);
    f.control.reconcileInFlightOperations();
    const recoveredValidator = f.control.getAgentPublic(f.validator.id);
    assert.equal(f.control.blockers(f.mission.id).some((blocker) => blocker.id === `validation:${f.mission.id}:interrupted-validation`), true);
    await assert.rejects(
      () => f.control.runValidation(
        f.validator.id,
        recoveredValidator.epoch,
        "interrupted-validation",
        pendingPayload
      ),
      /outcome is uncertain/
    );
    assert.equal(f.control.db.prepare("SELECT status FROM validation_intents WHERE scope=? AND command_id=?").get(pendingScope, "interrupted-validation").status, "uncertain");
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS count FROM validation_receipts WHERE id=?").get("pending-receipt").count, 0);
  } finally {
    if (!f.control.closed) f.control.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("local shared-mode mission completion still rechecks its source and snapshot", async () => {
  const f = fixture();
  try {
    const { task, artifact } = validationTarget(f, "local-completion");
    f.control.updateTask(f.orchestrator.id, f.orchestrator.epoch, "local-completion-claim", task.id, { fulfills: ["REQ-001"] });
    const receipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "local-completion-receipt", {
      taskId: task.id, command: "printf local-completion", artifactIds: [artifact.id]
    });
    f.control.validateTask(f.validator.id, f.validator.epoch, "local-completion-validation",
      task.id, receipt.id, true, "Local validation passed", [
        { assertionId: "REQ-001", status: "passed", evidence: "The local command exited zero" }
      ]);
    const completeMission = async commandId => f.control.workerCommand({
      id: commandId, token: "test-only", agentId: f.orchestrator.id, epoch: f.orchestrator.epoch,
      method: "CompleteMission", args: {}, taskId: commandId
    });
    const sourceBytes = readFileSync(artifact.path);
    writeFileSync(artifact.path, "changed local source");
    await assert.rejects(completeMission("reject-changed-local-source"), /Artifact .* or its source has changed/);
    assert.equal(f.control.detail(f.mission.id).events.filter(event => event.type === "mission_completed").length, 0);
    writeFileSync(artifact.path, sourceBytes);
    const completed = await completeMission("local-completion");
    assert.equal(completed.status, "completed");
    assert.equal(f.control.detail(f.mission.id).events.filter(event => event.type === "mission_completed").length, 1);
  } finally {
    clean(f);
  }
});

test("approve-mode validation stores and notifies the real validator receipt", async () => {
  const f = fixture({ autonomy: "approve" });
  try {
    const { task, artifact } = validationTarget(f, "approved-validation");
    const args = { taskId: task.id, command: "printf approved-validation", artifactIds: [artifact.id] };
    const approval = f.control.createApproval(f.validator.id, f.validator.epoch, "validation-approval-request", "run_validation", args);
    assert.equal(approval.status, "pending");
    assert.throws(
      () => f.control.createApproval(f.worker.id, f.worker.epoch, "wrong-validator-approval", "run_validation", args),
      /Only an assigned validator/
    );
    f.control.resolveApproval(approval.id, "approved");
    const result = await f.control.executeApproved(approval.id);
    assert.equal(result.status, "succeeded");
    assert.ok(result.receipt?.id);
    const detail = f.control.detail(f.mission.id);
    assert.equal(detail.validationReceipts.find((receipt) => receipt.id === result.receipt.id).command, args.command);
    assert.ok(detail.messages.some((message) => message.id === `approval-execution:${approval.id}:succeeded` && message.content.includes(result.receipt.id)));
    const validation = f.control.validateTask(f.validator.id, f.validator.epoch, "approved-validation-outcome", task.id, result.receipt.id, true, "Receipt passed");
    assert.equal(validation.receiptId, result.receipt.id);
    assert.equal(f.control.detail(f.mission.id).tasks.find((item) => item.id === task.id).status, "accepted");
  } finally {
    clean(f);
  }
});

test("paused human answers survive restart and release only after explicit resume", () => {
  const f = fixture();
  try {
    const blocker = f.control.createBlocker(f.orchestrator.id, f.orchestrator.epoch, "need-human-answer", "user_input", "Choose a value");
    f.control.missionAction(f.mission.id, "pause");
    f.control.resolveBlocker(blocker.id, "Use the safe default");
    const held = f.control.detail(f.mission.id).messages.find((message) => message.id === `blocker-resolution:${blocker.id}`);
    assert.equal(held.status, "aborted");
    f.control.close();
    f.control = new ControlPlane(f.stateHome);
    const stillPaused = f.control.missionById(f.mission.id);
    assert.equal(stillPaused.status, "paused");
    assert.equal(f.control.detail(f.mission.id).messages.find((message) => message.id === held.id).content, "Use the safe default");
    f.control.missionAction(f.mission.id, "resume");
    const released = f.control.message(held.id);
    assert.equal(released.status, "queued");
    assert.ok(f.control.pendingOutbox().some((row) => row.message_id === held.id && row.request_id === `${held.id}:2`));
  } finally {
    if (!f.control.closed) f.control.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("uncertain command outcome cannot undo an explicit mission pause", async () => {
  const f = fixture();
  try {
    const { task, artifact } = validationTarget(f, "paused-validation");
    const pending = f.control.runValidation(f.validator.id, f.validator.epoch, "paused-command", {
      taskId: task.id, command: "echo ready > validation-ready; sleep 30", artifactIds: [artifact.id]
    });
    const ready = join(f.workspacePath, "validation-ready");
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(ready), "validation command must actually start before pause");
    f.control.missionAction(f.mission.id, "pause");
    await f.control.stopAgentProcesses(f.validator.id);
    const receipt = await pending;
    assert.equal(receipt.exitCode, null);
    assert.equal(f.control.missionById(f.mission.id).status, "paused");
    const blocker = f.control.blockers(f.mission.id).find((item) => item.id === `validation:${f.mission.id}:paused-command`);
    assert.equal(blocker.status, "open");
    assert.throws(() => f.control.missionAction(f.mission.id, "resume"), /Resolve mission blockers/);
    f.control.resolveBlocker(blocker.id, "Observed the command was stopped; no retry requested");
    assert.equal(f.control.missionById(f.mission.id).status, "paused");
    f.control.missionAction(f.mission.id, "resume");
    assert.equal(f.control.missionById(f.mission.id).status, "active");
  } finally {
    await f.control.stopMissionProcesses(f.mission.id);
    clean(f);
  }
});

test("diagnostic redaction retains and removes a secret at every stream split", () => {
  for (const secret of ["sentinel-super-secret", "ababa", "aaaa", "x"]) {
    for (const input of [`before-${secret}-after`, `before-${secret}`, `${secret}${secret}`]) {
      const expected = input.split(secret).join("[REDACTED]");
      for (let split = 0; split <= input.length; split++) {
        const first = redactDiagnosticChunk("", input.slice(0, split), secret);
        const second = redactDiagnosticChunk(first.pending, input.slice(split), secret);
        const final = redactDiagnosticChunk(second.pending, "", secret, true);
        const output = first.complete + second.complete + final.complete;
        assert.equal(output, expected, `redaction changed output for ${secret} at split ${split}`);
      }
      let pending = "";
      let output = "";
      for (const character of input) {
        const chunk = redactDiagnosticChunk(pending, character, secret);
        pending = chunk.pending;
        output += chunk.complete;
      }
      output += redactDiagnosticChunk(pending, "", secret, true).complete;
      assert.equal(output, expected, "one-character chunks must redact self-overlapping secrets");
    }
  }
});

test("transcript entry identity is stable within an agent and distinct across agents", () => {
  const f = fixture();
  try {
    f.control.recordTranscript(f.worker.id, "assistant", "worker entry", "7");
    f.control.recordTranscript(f.validator.id, "assistant", "validator entry", "7");
    f.control.recordTranscript(f.worker.id, "assistant", "worker entry", "7");
    assert.deepEqual(f.control.transcript(f.worker.id).map((entry) => entry.text), ["worker entry"]);
    assert.deepEqual(f.control.transcript(f.validator.id).map((entry) => entry.text), ["validator entry"]);
  } finally {
    clean(f);
  }
});

test("workspace file tools reject symlink escapes", async () => {
  const f = fixture();
  try {
    const empty = await f.control.workerCommand({
      id: "nested-empty-write", token: "internal", agentId: f.worker.id, epoch: f.worker.epoch,
      method: "write_file", args: { path: "nested/deeper/empty.txt", content: "" }, taskId: "nested-empty-write"
    });
    assert.equal(empty.bytes, 0);
    assert.equal(readFileSync(join(f.workspacePath, "nested", "deeper", "empty.txt"), "utf8"), "");
    const outside = join(f.home, "outside.txt");
    writeFileSync(outside, "outside workspace");
    symlinkSync(outside, join(f.workspacePath, "escape.txt"));
    await assert.rejects(
      () => f.control.workerCommand({
        id: "symlink-read", token: "internal", agentId: f.worker.id, epoch: f.worker.epoch,
        method: "read_file", args: { path: "escape.txt" }, taskId: "symlink-read"
      }),
      /escaped/
    );
  } finally {
    clean(f);
  }
});

test("interrupting a controller-owned command stops its process-group descendants", async () => {
  const f = fixture();
  try {
    const command = f.control.workerCommand({
      id: "shell-descendant-test",
      token: "test-only-internal-token",
      agentId: f.worker.id,
      epoch: f.worker.epoch,
      method: "bash",
      taskId: "shell-descendant-test",
      args: { command: "sleep 30 & echo $! > descendant.pid; wait" }
    });
    const pidFile = join(f.workspacePath, "descendant.pid");
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(existsSync(pidFile), true, "shell descendant did not start");
    const descendantPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    await f.control.stopAgentProcesses(f.worker.id);
    const result = await command;
    assert.equal(result.exitCode, null);
    let alive = true;
    const exitDeadline = Date.now() + 2000;
    while (alive && Date.now() < exitDeadline) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, `descendant process ${descendantPid} survived interruption`);
  } finally {
    clean(f);
  }
});

test("late reports are recorded while paused without waking or redelivering the mission", async () => {
  const f = fixture();
  try {
    const notSent = f.control.sendMessage(f.mission.id, f.worker.id, "Not dispatched", "followUp", "not-dispatched");
    const uncertain = f.control.sendMessage(f.mission.id, f.worker.id, "Possibly dispatched", "followUp", "possibly-dispatched");
    const uncertainOutbox = f.control.pendingOutbox().find((row) => row.message_id === uncertain.id);
    f.control.setOutboxStatus(uncertainOutbox.id, "dispatching");
    f.control.missionAction(f.mission.id, "pause");
    const messages = f.control.detail(f.mission.id).messages;
    assert.equal(messages.find((message) => message.id === notSent.id).status, "aborted");
    assert.equal(messages.find((message) => message.id === uncertain.id).status, "uncertain");
    f.control.missionAction(f.mission.id, "resume");
    const resumed = f.control.detail(f.mission.id).messages.find((message) => message.id === notSent.id);
    assert.equal(resumed.attempt, 2);
    assert.equal(f.control.pendingOutbox().filter((row) => row.message_id === notSent.id).length, 1);
    assert.equal(f.control.pendingOutbox().filter((row) => row.message_id === uncertain.id).length, 0);
    f.control.missionAction(f.mission.id, "pause");
    await f.control.workerCommand({
      id: "late-report", token: "internal", agentId: f.worker.id, epoch: f.worker.epoch,
      method: "Report", args: { summary: "Late result", evidence: "Captured" }, taskId: "late-report"
    });
    assert.equal(f.control.missionById(f.mission.id).status, "paused");
    assert.equal(f.control.pendingOutbox().length, 0);
    assert.ok(f.control.detail(f.mission.id).events.some((event) => event.type === "agent_report" && event.text === "Late result"));
  } finally {
    clean(f);
  }
});

test("admission is not completion and interrupted deliveries become deterministic uncertainty", () => {
  const f = fixture();
  try {
    const message = f.control.sendMessage(f.mission.id, f.worker.id, "Admission is only a receipt", "followUp", "admission-message");
    const outbox = f.control.db.prepare("SELECT id,request_id,attempt FROM outbox WHERE message_id=?").get(message.id);
    assert.ok(outbox);
    assert.equal(f.control.markOutboxDispatching(outbox.id, f.worker.epoch), true);
    assert.equal(f.control.ackOutbox(message.id, outbox.request_id, outbox.attempt, f.worker.epoch, "admitted"), true);
    assert.equal(f.control.message(message.id).status, "admitted");
    assert.equal(f.control.db.prepare("SELECT deadline_at FROM outbox WHERE id=?").get(outbox.id).deadline_at, null);
    assert.equal(f.control.pendingOutbox().some((row) => row.message_id === message.id), false);
    f.control.markAgentInterrupted(f.worker.id);
    assert.equal(f.control.message(message.id).status, "uncertain");
    assert.ok(f.control.blockers(f.mission.id).some((blocker) => blocker.id === `delivery:${outbox.id}`));
    assert.equal(f.control.pendingOutbox().some((row) => row.message_id === message.id), false);
  } finally {
    clean(f);
  }
});

test("generation admission reserves across agents, fences stale epochs and survives reopen without double charging", () => {
  const f = fixture({ maxTurns: 2 });
  let reopened;
  try {
    f.control.admitTurn(f.worker.id, f.worker.epoch, "same-local-id");
    f.control.admitTurn(f.worker.id, f.worker.epoch, "same-local-id");
    assert.equal(f.control.missionById(f.mission.id).turns, 1);
    assert.throws(() => f.control.admitTurn(f.worker.id, f.worker.epoch - 1, "stale"), /fenced/);
    f.control.admitTurn(f.validator.id, f.validator.epoch, "same-local-id");
    assert.equal(f.control.missionById(f.mission.id).turns, 2);
    const pending = f.control.pendingOutbox()[0];
    assert.ok(pending);
    assert.equal(f.control.markOutboxDispatching(pending.id, f.orchestrator.epoch), false);
    f.control.recordTurn(f.worker.id, f.worker.epoch, "answer-1", "same-local-id");
    f.control.recordTurn(f.worker.id, f.worker.epoch, "answer-1", "same-local-id");
    f.control.recordTurn(f.worker.id, f.worker.epoch, "aborted-partial", "same-local-id");
    f.control.recordTurn(f.validator.id, f.validator.epoch, "answer-2", "same-local-id");
    assert.equal(f.control.missionById(f.mission.id).turns, 2);
    assert.equal(f.control.missionById(f.mission.id).status, "blocked");
    assert.throws(() => f.control.admitTurn(f.orchestrator.id, f.orchestrator.epoch, "over-limit"), /not accepting/);
    assert.equal(f.control.exportMission(f.mission.id).generationAdmissions.length, 2);
    f.control.close();
    reopened = new ControlPlane(f.stateHome);
    reopened.updateMissionLimits(f.mission.id, 3);
    reopened.missionAction(f.mission.id, "resume");
    const worker = reopened.getAgentPublic(f.worker.id);
    reopened.admitTurn(worker.id, worker.epoch, "same-local-id");
    assert.equal(reopened.missionById(f.mission.id).turns, 2);
    assert.equal(reopened.exportMission(f.mission.id).generationAdmissions.length, 2);
  } finally {
    reopened?.close();
    clean(f);
  }
});

test("native generation admission rejects a concurrent provider call at the turn limit", { timeout: 15000 }, async () => {
  const f = fixture({ maxTurns: 1 });
  const runtimes = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  try {
    for (const agent of [f.worker, f.validator]) {
      runtimes.push(await openWorkerRuntime({
        agentId: agent.id, missionId: f.mission.id, epoch: agent.epoch,
        token: "test-only-internal-token", durablePath: join(f.stateHome, "agents", `${agent.id}.sqlite`),
        workspacePath: f.workspacePath, profile: f.control.profile(agent.profileId),
        role: f.control.role(agent.roleId), testOnlyScripted: true
      }, async (id) => f.control.admitTurn(agent.id, agent.epoch, id)));
    }
    runtimes[0].faux.setResponses([async () => {
      signalStarted();
      await gate;
      return fauxAssistantMessage(fauxToolCall("WaitForMessage", {}), { stopReason: "toolUse" });
    }]);
    runtimes[1].faux.setResponses([fauxAssistantMessage("This model must not be called")]);
    const first = await runtimes[0].root.submit({ type: "input", content: "First request", requestId: "budget:first" }, BACKGROUND_CONTEXT);
    await started;
    const denied = await runtimes[1].root.submit({ type: "input", content: "Competing request", requestId: "budget:denied" }, BACKGROUND_CONTEXT);
    assert.equal((await denied.wait(BACKGROUND_CONTEXT)).status, "unanswered");
    assert.equal(runtimes[1].faux.state.callCount, 0);
    const deniedEntries = await runtimes[1].root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
    for (const entry of deniedEntries.items.filter((item) => AssistantEntry.is(item))) {
      f.control.recordTurn(f.validator.id, f.validator.epoch, String(entry.id), String(entry.byTaskId));
    }
    assert.equal(f.control.exportMission(f.mission.id).generationDenials.length, 1);
    assert.equal(f.control.missionById(f.mission.id).turns, 1);
    assert.equal(f.control.missionById(f.mission.id).status, "blocked");
    release();
    assert.equal((await first.wait(BACKGROUND_CONTEXT)).status, "done");
    assert.equal(runtimes[0].faux.state.callCount, 1);
    assert.equal(f.control.exportMission(f.mission.id).generationAdmissions.length, 1);
    assert.equal(f.control.missionById(f.mission.id).turns, 1);
  } finally {
    release();
    for (const runtime of runtimes) await runtime.harness.close(BACKGROUND_CONTEXT);
    clean(f);
  }
});

test("native compaction uses request admission, including after its selection phase ends", async () => {
  for (const maxTurns of [2, 1]) {
    const f = fixture({ maxTurns });
    let runtime;
    try {
      runtime = await openWorkerRuntime({
        agentId: f.worker.id, missionId: f.mission.id, epoch: f.worker.epoch,
        token: "test-only-internal-token", durablePath: join(f.stateHome, "agents", `${f.worker.id}.sqlite`),
        workspacePath: f.workspacePath, profile: f.control.profile(f.worker.profileId),
        role: f.control.role(f.worker.roleId), testOnlyScripted: true
      }, async (id) => f.control.admitTurn(f.worker.id, f.worker.epoch, id));
      runtime.faux.setResponses([
        fauxAssistantMessage("Retained recent context. ".repeat(5000)),
        fauxAssistantMessage("Summary of the earlier input.")
      ]);
      const input = await runtime.root.submit({ type: "input", content: "Earlier history to summarize", requestId: "compaction:history" }, BACKGROUND_CONTEXT);
      assert.equal((await input.wait(BACKGROUND_CONTEXT)).status, "done");
      await runtime.root.waitForIdle(BACKGROUND_CONTEXT);
      const compactionId = await runtime.root.compact(undefined, BACKGROUND_CONTEXT);
      const compacted = await runtime.harness.waitForTask(compactionId, BACKGROUND_CONTEXT);
      const allowed = maxTurns === 2;
      assert.equal(runtime.faux.state.callCount, allowed ? 2 : 1);
      assert.equal(f.control.missionById(f.mission.id).turns, maxTurns);
      const exported = f.control.exportMission(f.mission.id);
      if (allowed) {
        assert.equal(compacted.state.outcome.status, "completed");
        assert.equal(exported.generationAdmissions.filter((item) => item.generation_id.startsWith("auxiliary:")).length, 1);
      } else {
        assert.equal(compacted.state.outcome.status, "failed");
        assert.equal(exported.generationDenials.filter((item) => item.generation_id.startsWith("auxiliary:")).length, 1);
        assert.equal(f.control.missionById(f.mission.id).status, "blocked");
      }
    } finally {
      await runtime?.harness.close(BACKGROUND_CONTEXT);
      clean(f);
    }
  }
});

test("turn and known-cost limits block missions and prevent over-budget resume", () => {
  const byTurns = fixture({ maxTurns: 1 });
  try {
    byTurns.control.recordTurn(byTurns.worker.id, byTurns.worker.epoch, "turn-1");
    byTurns.control.recordTurn(byTurns.worker.id, byTurns.worker.epoch, "turn-1");
    assert.equal(byTurns.control.missionById(byTurns.mission.id).turns, 1);
    assert.equal(byTurns.control.missionById(byTurns.mission.id).status, "blocked");
    byTurns.control.missionAction(byTurns.mission.id, "pause");
    assert.throws(() => byTurns.control.missionAction(byTurns.mission.id, "resume"), /turn limit/);
  } finally {
    clean(byTurns);
  }
  const byCost = fixture({ maxCost: 1 });
  try {
    byCost.control.recordUsage(byCost.worker.id, byCost.worker.epoch, 1);
    assert.equal(byCost.control.missionById(byCost.mission.id).cost, 1);
    assert.equal(byCost.control.missionById(byCost.mission.id).status, "blocked");
    byCost.control.missionAction(byCost.mission.id, "pause");
    assert.throws(() => byCost.control.missionAction(byCost.mission.id, "resume"), /cost limit/);
  } finally {
    clean(byCost);
  }
});

test("stopped budget changes preserve history and reject invalid or unenforceable limits", () => {
  const f = fixture({ maxTurns: 2 });
  try {
    assert.throws(() => f.control.updateMissionLimits(f.mission.id, 300), /stopped/);
    f.control.recordTurn(f.worker.id, f.worker.epoch, "budget-history-1");
    f.control.recordTurn(f.worker.id, f.worker.epoch, "budget-history-2");
    const before = f.control.exportMission(f.mission.id);
    assert.equal(before.mission.turns, 2);
    assert.equal(before.mission.status, "blocked");
    for (const total of [0, 1, 2.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      assert.throws(() => f.control.updateMissionLimits(f.mission.id, total), /positive safe integer/);
    }
    for (const cost of [-1, Infinity, NaN]) {
      assert.throws(() => f.control.updateMissionLimits(f.mission.id, 300, cost), /finite number/);
    }
    assert.equal(f.control.missionById(f.mission.id).maxTurns, 2);
    f.control.updateMissionLimits(f.mission.id, 300, 0);
    const after = f.control.exportMission(f.mission.id);
    assert.equal(after.mission.turns, 2);
    assert.equal(after.mission.maxTurns, 300);
    assert.equal(after.mission.maxCost, 0);
    assert.equal(after.mission.status, "blocked");
    for (const key of ["outbox", "messages", "agents", "tasks", "artifacts", "validationReceipts", "generationAdmissions"]) {
      assert.deepEqual(after[key], before[key], `budget changes must not mutate ${key}`);
    }
    assert.deepEqual(after.events.slice(0, before.events.length), before.events);
    assert.equal(after.events.at(-1).type, "mission_limits_changed");

    f.control.upsertProfile({ ...profile, id: "unknown-budget-profile", cost: undefined });
    const unknownRoleIds = ["orchestrator", "worker", "validator"].map((kind) => {
      const id = `unknown-budget-${kind}`;
      f.control.upsertRole({ id, name: id, kind, instructions: "Budget test only", profileId: "unknown-budget-profile" });
      return id;
    });
    const unknown = f.control.createMission({
      title: "Unknown pricing", goal: "No fabricated cost", acceptance: "Explicit pricing boundary",
      workspaceId: f.workspace.id, roleIds: unknownRoleIds,
      maxTurns: 10, maxCost: 0, autonomy: "approve"
    });
    assert.equal(unknown.costKnown, false);
    assert.throws(() => f.control.updateMissionLimits(unknown.id, 300, 1), /rates are unknown/);
    const changed = f.control.updateMissionLimits(unknown.id, 300);
    assert.equal(changed.costKnown, false);
    assert.equal(changed.turns, 0);
    assert.equal(changed.status, "draft");
    assert.equal(changed.maxTurns, 300);
  } finally {
    clean(f);
  }
});

test("approval arguments are exact, approval consumption is one-time, and delivery retries are bounded", async () => {
  const f = fixture({ autonomy: "approve" });
  try {
    const request = {
      id: "approval-command", token: "internal", agentId: f.worker.id, epoch: f.worker.epoch,
      method: "bash", args: { command: "printf approved" }, taskId: "approval-command"
    };
    const approval = await f.control.workerCommand(request);
    assert.equal(approval.status, "pending");
    assert.deepEqual(approval.args, { command: "printf approved" });
    assert.equal((await f.control.workerCommand(request)).id, approval.id);
    await assert.rejects(
      () => f.control.workerCommand({ ...request, args: { command: "printf changed" } }),
      /different payload/
    );
    f.control.resolveApproval(approval.id, "approved");
    assert.equal((await f.control.executeApproved(approval.id)).status, "succeeded");
    assert.equal((await f.control.executeApproved(approval.id)).status, "succeeded");
    assert.equal(f.control.detail(f.mission.id).events.filter((event) => event.type === "shell_evidence").length, 1);

    const failedRequest = {
      id: "approval-failed-command", token: "internal", agentId: f.worker.id, epoch: f.worker.epoch,
      method: "bash", args: { command: "printf x >> failed-approval-once.txt; printf failed-output; exit 7" }, taskId: "approval-failed-command"
    };
    const failedApproval = await f.control.workerCommand(failedRequest);
    f.control.resolveApproval(failedApproval.id, "approved");
    const failedResult = await f.control.executeApproved(failedApproval.id);
    assert.equal(failedResult.status, "failed");
    assert.equal(failedResult.receipt.exitCode, 7);
    assert.equal(failedResult.receipt.stdout, "failed-output");
    assert.equal((await f.control.executeApproved(failedApproval.id)).status, "failed");
    assert.equal(readFileSync(join(f.workspacePath, "failed-approval-once.txt"), "utf8"), "x");

    const message = f.control.sendMessage(f.mission.id, f.worker.id, "Retry", "followUp", "retry-message");
    const outbox = f.control.pendingOutbox().find((row) => row.message_id === message.id);
    for (let attempt = 0; attempt < 5; attempt++) f.control.retryOutbox(outbox.id, "worker unavailable");
    assert.equal(f.control.pendingOutbox().some((row) => row.message_id === message.id), false);
    assert.equal(f.control.message(message.id).status, "failed");
    assert.ok(f.control.detail(f.mission.id).blockers.some((blocker) => blocker.kind === "delivery" && blocker.status === "open"));
  } finally {
    clean(f);
  }
});

test("trusted shell commands are deduplicated and changed payloads are rejected", async () => {
  const f = fixture();
  try {
    const request = {
      id: "shell-command", token: "internal", agentId: f.worker.id, epoch: f.worker.epoch,
      method: "bash", args: { command: "printf x >> shell-once.txt; printf complete; exit 7" }, taskId: "shell-command"
    };
    const first = await f.control.workerCommand(request);
    const repeated = await f.control.workerCommand(request);
    assert.deepEqual(repeated, first);
    assert.equal(first.exitCode, 7);
    assert.equal(readFileSync(join(f.workspacePath, "shell-once.txt"), "utf8"), "x");
    await assert.rejects(
      f.control.workerCommand({ ...request, args: { command: "printf changed >> shell-once.txt" } }),
      /different payload/
    );
    assert.equal(readFileSync(join(f.workspacePath, "shell-once.txt"), "utf8"), "x");
  } finally {
    clean(f);
  }
});

test("approved side effects wait through pause and are reconciled as uncertain after restart", async () => {
  const f = fixture({ autonomy: "approve" });
  try {
    const request = {
      id: "paused-approval-command", token: "internal", agentId: f.worker.id, epoch: f.worker.epoch,
      method: "bash", args: { command: "printf x > paused-approval.txt" }, taskId: "paused-approval-command"
    };
    const approval = await f.control.workerCommand(request);
    f.control.missionAction(f.mission.id, "pause");
    f.control.resolveApproval(approval.id, "approved");
    assert.throws(() => readFileSync(join(f.workspacePath, "paused-approval.txt")), { code: "ENOENT" });
    f.control.missionAction(f.mission.id, "resume");
    assert.equal((await f.control.executeApproved(approval.id)).status, "succeeded");
    assert.equal(readFileSync(join(f.workspacePath, "paused-approval.txt"), "utf8"), "x");

    const denied = await f.control.workerCommand({
      ...request, id: "paused-denied-command", taskId: "paused-denied-command",
      args: { command: "printf must-not-run > denied-approval.txt" }
    });
    f.control.missionAction(f.mission.id, "pause");
    f.control.resolveApproval(denied.id, "denied");
    const heldDenial = f.control.message(`approval-outcome:${denied.id}:denied`);
    assert.equal(heldDenial.status, "aborted");
    assert.throws(() => readFileSync(join(f.workspacePath, "denied-approval.txt")), { code: "ENOENT" });
    f.control.missionAction(f.mission.id, "resume");
    assert.equal(f.control.message(heldDenial.id).status, "queued");
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE message_id=?").get(heldDenial.id).count, 1);

    const uncertain = await f.control.workerCommand({
      ...request, id: "uncertain-approval-command", taskId: "uncertain-approval-command",
      args: { command: "printf must-not-run > uncertain-approval.txt" }
    });
    f.control.resolveApproval(uncertain.id, "approved");
    const running = { ...uncertain, status: "running" };
    f.control.db.prepare("UPDATE approvals SET status='running',data=? WHERE id=?").run(JSON.stringify(running), uncertain.id);
    f.control.close();
    f.control = new ControlPlane(f.stateHome);
    f.control.reconcileInFlightOperations();
    const recovered = f.control.detail(f.mission.id).approvals.find((item) => item.id === uncertain.id);
    assert.equal(recovered.status, "uncertain");
    const blocker = f.control.detail(f.mission.id).blockers.find((item) => item.id === `approval:${uncertain.id}`);
    assert.equal(blocker.status, "open");
    assert.throws(() => readFileSync(join(f.workspacePath, "uncertain-approval.txt")), { code: "ENOENT" });
    f.control.resolveBlocker(blocker.id, "I verified the command had no effect; do not rerun it.");
    assert.equal(f.control.missionById(f.mission.id).status, "paused");
  } finally {
    clean(f);
  }
});

test("browser mutations require the UI's same-origin cookie and request header", async () => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-http-"));
  const server = await startServer({ home, port: 0 });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Mission Control/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const cookie = page.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 200);
    const body = JSON.stringify({ name: "Workspace", path: home, machineId: "local" });
    const rejected = await fetch(`${base}/api/workspaces`, {
      method: "POST", headers: { "content-type": "application/json", cookie, origin: base }, body
    });
    assert.equal(rejected.status, 403);
    const accepted = await fetch(`${base}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base, "x-requested-with": "MissionControl" },
      body
    });
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.json()).machineId, "local");
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("native pi-durable worker storage deduplicates the outbox request across daemon restart", async () => {
  const f = fixture();
  let runtime;
  try {
    const message = f.control.sendMessage(f.mission.id, f.worker.id, "Persist this request", "followUp", "user-message");
    const repeated = f.control.sendMessage(f.mission.id, f.worker.id, "Persist this request", "followUp", "user-message");
    assert.equal(repeated.id, message.id);
    const [outbox] = f.control.pendingOutbox();
    assert.ok(outbox);
    const config = (control, agent, testOnlyScripted = true) => ({
      agentId: agent.id,
      missionId: agent.missionId,
      epoch: agent.epoch,
      token: "test-only-internal-token",
      durablePath: join(f.stateHome, "agents", `${agent.id}.sqlite`),
      workspacePath: f.workspacePath,
      profile: control.profile(agent.profileId),
      role: control.role(agent.roleId),
      prompt: "",
      testOnlyScripted
    });
    runtime = await openWorkerRuntime(config(f.control, f.worker), async (id) => f.control.admitTurn(f.worker.id, f.worker.epoch, id));
    await assert.rejects(() => openWorkerRuntime(config(f.control, f.worker)), /already owned by another live worker/);
    const first = await runtime.root.submit({ type: "input", content: message.content, requestId: outbox.request_id }, BACKGROUND_CONTEXT);
    await first.wait(BACKGROUND_CONTEXT);
    assert.equal(runtime.faux.state.callCount, 1);
    const firstId = first.id;
    await runtime.harness.close(BACKGROUND_CONTEXT);
    runtime = undefined;
    f.control.close();

    const controlAfterRestart = new ControlPlane(f.stateHome);
    try {
      const recoveredAgent = controlAfterRestart.listAgents(f.mission.id).find((agent) => agent.id === f.worker.id);
      runtime = await openWorkerRuntime(config(controlAfterRestart, recoveredAgent));
      const duplicate = await runtime.root.submit({ type: "input", content: message.content, requestId: outbox.request_id }, BACKGROUND_CONTEXT);
      assert.equal(duplicate.id, firstId);
      await duplicate.wait(BACKGROUND_CONTEXT);
      assert.equal(runtime.faux.state.callCount, 0);
    } finally {
      await runtime?.harness.close(BACKGROUND_CONTEXT);
      runtime = undefined;
      controlAfterRestart.close();
    }
  } finally {
    if (runtime) await runtime.harness.close(BACKGROUND_CONTEXT);
    if (!f.control.closed) f.control.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("native store lease rejects a contender and releases when its owner is killed", async () => {
  const f = fixture();
  let runtime;
  let owner;
  try {
    const config = {
      agentId: f.worker.id,
      missionId: f.worker.missionId,
      epoch: f.worker.epoch,
      token: "test-only-internal-token",
      durablePath: join(f.stateHome, "agents", `${f.worker.id}.sqlite`),
      workspacePath: f.workspacePath,
      profile: f.control.profile(f.worker.profileId),
      role: f.control.role(f.worker.roleId),
      prompt: "",
      testOnlyScripted: true
    };
    const workerModule = new URL("../dist/worker.js", import.meta.url).href;
    const contextModule = import.meta.resolve("@earendil-works/chord/context");
    const source = `import { openWorkerRuntime } from ${JSON.stringify(workerModule)}; import { BACKGROUND_CONTEXT } from ${JSON.stringify(contextModule)}; await openWorkerRuntime(${JSON.stringify(config)}); console.log("LEASE_READY"); setInterval(() => {}, 1000);`;
    owner = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const ready = new Promise((resolve, reject) => {
      owner.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("LEASE_READY")) resolve();
      });
      owner.once("error", reject);
      owner.once("exit", (code) => reject(new Error(`lease owner exited before ready (${code})`)));
    });
    await ready;
    await assert.rejects(() => openWorkerRuntime(config), /already owned by another live worker/);
    owner.kill("SIGKILL");
    await new Promise((resolve, reject) => {
      owner.once("exit", (code, signal) => code === null && signal === "SIGKILL" ? resolve() : reject(new Error(`lease owner exit was ${code}/${signal}`)));
    });
    runtime = await openWorkerRuntime(config);
    assert.ok(runtime.root);
  } finally {
    if (owner && owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    if (runtime) await runtime.harness.close(BACKGROUND_CONTEXT);
    clean(f);
  }
});

test("HTTP mission start admits its durable opening through the pi-durable worker", { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-http-worker-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const server = await startServer({ home, port: 0, testOnlyScripted: true, testOnlyToolLoop: true });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(base);
    const cookie = page.headers.get("set-cookie").split(";")[0];
    const headers = { "content-type": "application/json", cookie, origin: base, "x-requested-with": "MissionControl" };
    const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const createdProfile = await post("/api/profiles", {
      id: "http-faux", name: "Test-only faux", api: "openai-completions", modelId: "faux-1",
      baseUrl: "http://127.0.0.1:9999", credentialEnv: "", contextWindow: 16000, maxTokens: 512,
      reasoning: false, toolCalling: true, vision: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    });
    assert.equal(createdProfile.status, 201);
    for (const kind of ["orchestrator", "worker", "validator"]) {
      const response = await post("/api/roles", {
        id: `http-${kind}`, name: kind, kind, instructions: `Test-only ${kind} role.`, profileId: "http-faux"
      });
      assert.equal(response.status, 201);
    }
    const workspaceResponse = await post("/api/workspaces", { name: "test", path: workspacePath, machineId: "local" });
    const workspace = await workspaceResponse.json();
    const missionResponse = await post("/api/missions", {
      title: "HTTP admission", goal: "Prove durable admission", acceptance: "Opening message settles",
      workspaceId: workspace.id, roleIds: ["http-orchestrator", "http-worker", "http-validator"], maxTurns: 10, maxCost: 1, autonomy: "trusted"
    });
    const mission = await missionResponse.json();
    const started = await post(`/api/missions/${mission.id}/start`, {});
    assert.equal(started.status, 200);

    let detail;
    const deadline = Date.now() + 10000;
    do {
      detail = await (await fetch(`${base}/api/missions/${mission.id}`, { headers: { cookie } })).json();
      if (detail.messages[0]?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.equal(detail.agents.filter((agent) => agent.kind === "orchestrator").length, 1);
    assert.equal(detail.messages.filter((message) => message.id === `mission-opening:${mission.id}`).length, 1);
    assert.equal(detail.messages[0].status, "completed");
    assert.ok(detail.mission.turns >= 2, "tool-call and follow-up assistant entries count as distinct turns");
    assert.equal(detail.mission.turns, 2, "Report must end the native run after GetMissionState, without a third provider request");
    assert.ok(detail.events.some((event) => event.type === "agent_report" && event.data.evidence === "IPC receipt"));
    const replay = await (await fetch(`${base}/api/missions/${mission.id}/export`, { headers: { cookie } })).json();
    assert.ok(replay.outbox.some((row) => row.request_id === `${detail.messages[0].id}:1` && row.status === "completed"));

    const createdAgentResponse = await post(`/api/missions/${mission.id}/agents`, {
      title: "Idle worker", roleId: "http-worker", prompt: "Wait for assigned work.", requestId: "idle-worker"
    });
    assert.equal(createdAgentResponse.status, 201);
    const idleWorker = await createdAgentResponse.json();
    const workerMessageId = `agent-opening:${mission.id}:idle-worker`;
    const workerDeadline = Date.now() + 10000;
    do {
      detail = await (await fetch(`${base}/api/missions/${mission.id}`, { headers: { cookie } })).json();
      if (detail.messages.some((message) => message.id === workerMessageId && message.status === "completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < workerDeadline);
    assert.equal(detail.messages.find((message) => message.id === workerMessageId)?.status, "completed");
    assert.ok(detail.events.some((event) => event.type === "agent_report" && event.agentId === idleWorker.id), "the second agent's same-numbered tool task must not be swallowed as a duplicate");
    const workerTranscript = await (await fetch(`${base}/api/agents/${idleWorker.id}/transcript`, { headers: { cookie } })).json();
    assert.ok(workerTranscript.entries.some((entry) => entry.text === "test-only tool loop completed"), "the second agent's same-numbered assistant entry must remain visible");
    let modelRecords;
    do {
      const exported = await (await fetch(`${base}/api/missions/${mission.id}/export`, { headers: { cookie } })).json();
      modelRecords = exported.transcripts.find((item) => item.agentId === idleWorker.id)?.entries ?? [];
      if (modelRecords.filter((entry) => entry.role === "model").length === 2 && modelRecords.some((entry) => entry.role === "model_usage" && JSON.parse(entry.text).totalTokens > 0)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < workerDeadline);
    assert.deepEqual(modelRecords.filter((entry) => entry.role === "model").flatMap((entry) => JSON.parse(entry.text).tools), ["GetMissionState", "Report"]);
    assert.ok(modelRecords.some((entry) => entry.role === "model_usage" && JSON.parse(entry.text).totalTokens > 0), "actual worker token counters must reach Mission export");
    const updatedProfile = await post("/api/profiles", {
      id: "http-faux", name: "Test-only faux revision 2", api: "openai-completions", modelId: "faux-1",
      baseUrl: "http://127.0.0.1:9999", credentialEnv: "", contextWindow: 16000, maxTokens: 512,
      reasoning: false, toolCalling: true, vision: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    });
    const profileUpdateError = await updatedProfile.clone().text();
    const recoveredDetail = await (await fetch(`${base}/api/missions/${mission.id}`, { headers: { cookie } })).json();
    assert.equal(updatedProfile.status, 201, `${profileUpdateError} ${JSON.stringify(recoveredDetail.events.slice(-8))}`);
    const newRevision = await updatedProfile.json();
    const refreshedWorker = recoveredDetail.agents.find((agent) => agent.id === idleWorker.id);
    assert.equal(newRevision.revision, 2);
    assert.equal(refreshedWorker.profileRevision, 2);
    assert.ok(refreshedWorker.epoch > idleWorker.epoch);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("unexpected native worker exit recovers the same agent and outbox request", { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-worker-recovery-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const server = await startServer({ home, port: 0, testOnlyScripted: true });
  try {
    server.control.upsertProfile({ ...profile, id: "recovery-profile" });
    for (const kind of ["orchestrator", "worker", "validator"]) {
      server.control.upsertRole({ id: `recovery-${kind}`, name: kind, kind, instructions: "Test-only recovery role.", profileId: "recovery-profile" });
    }
    const workspace = server.control.addWorkspace("recovery", realpathSync(workspacePath));
    const mission = server.control.createMission({
      title: "Worker recovery", goal: "Recover a native worker", acceptance: "The opening settles",
      workspaceId: workspace.id, roleIds: ["recovery-orchestrator", "recovery-worker", "recovery-validator"],
      maxTurns: 10, maxCost: 1, autonomy: "trusted"
    });
    server.control.missionAction(mission.id, "start");
    const [agent] = server.control.listAgents(mission.id);
    assert.ok(agent);
    await server.workers.startAgent(agent);
    const [outbox] = server.control.pendingOutbox();
    assert.ok(outbox);
    assert.equal(server.control.markOutboxDispatching(outbox.id, agent.epoch), true);
    const handle = server.workers.handles.get(agent.id);
    assert.ok(handle?.child.pid, "the test must kill the native worker, not a lease helper");
    const durablePath = join(home, "agents", `${agent.id}.sqlite`);
    assert.equal(existsSync(durablePath), true);
    process.kill(handle.child.pid, "SIGKILL");

    const deadline = Date.now() + 12000;
    let recovered;
    do {
      recovered = server.control.getAgentPublic(agent.id);
      const current = server.control.exportMission(mission.id);
      const row = current.outbox.find((item) => item.id === outbox.id);
      if (recovered?.epoch > agent.epoch && row?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    const replay = server.control.exportMission(mission.id);
    const recoveredOutbox = replay.outbox.find((item) => item.id === outbox.id);
    assert.equal(server.control.listAgents(mission.id).filter((item) => item.id === agent.id).length, 1);
    assert.ok(recovered?.epoch > agent.epoch, "the same agent must advance epoch after the native worker exits");
    assert.equal(existsSync(durablePath), true, "recovery must reopen the same durable store");
    assert.equal(recoveredOutbox?.message_id, outbox.message_id);
    assert.equal(recoveredOutbox?.request_id, outbox.request_id);
    assert.equal(recoveredOutbox?.attempt, outbox.attempt);
    assert.equal(recoveredOutbox?.status, "completed");
    assert.ok(replay.events.some((event) => event.type === "worker_recovery_started"));
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("uncertain command outcome for settled delivery creates a deterministic blocker and preserves completed delivery", () => {
  const f = fixture();
  try {
    f.control.missionAction(f.mission.id, "start");
    const orchestrator = f.control.listAgents(f.mission.id).find((agent) => agent.kind === "orchestrator");
    assert.ok(orchestrator);
    f.control.sendMessage(f.mission.id, orchestrator.id, "second delivery", "followUp", "second-delivery");
    const [completed, uncertain] = f.control.pendingOutbox();
    assert.ok(completed && uncertain);

    for (const row of [completed, uncertain]) {
      assert.equal(f.control.markOutboxDispatching(row.id, orchestrator.epoch), true);
      assert.equal(f.control.ackOutbox(row.message_id, row.request_id, row.attempt, orchestrator.epoch, "admitted"), true);
    }
    assert.equal(f.control.ackOutbox(completed.message_id, completed.request_id, completed.attempt, orchestrator.epoch, "completed"), true);
    assert.equal(f.control.ackOutbox(uncertain.message_id, uncertain.request_id, uncertain.attempt, orchestrator.epoch, "uncertain"), true);

    const detail = f.control.detail(f.mission.id);
    assert.equal(f.control.message(completed.message_id)?.status, "completed");
    assert.equal(f.control.message(uncertain.message_id)?.status, "uncertain");
    assert.equal(detail.mission.status, "blocked");
    assert.equal(detail.blockers.filter((blocker) => blocker.id === `delivery:${uncertain.id}`).length, 1);
    assert.equal(f.control.ackOutbox(completed.message_id, completed.request_id, completed.attempt, orchestrator.epoch, "uncertain"), false);
  } finally {
    clean(f);
  }
});

test("intentional worker stop does not trigger unexpected-exit recovery", { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-worker-stop-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const server = await startServer({ home, port: 0, testOnlyScripted: true });
  try {
    server.control.upsertProfile({ ...profile, id: "stop-profile" });
    for (const kind of ["orchestrator", "worker", "validator"]) {
      server.control.upsertRole({ id: `stop-${kind}`, name: kind, kind, instructions: "Test-only stop role.", profileId: "stop-profile" });
    }
    const workspace = server.control.addWorkspace("stop", realpathSync(workspacePath));
    const mission = server.control.createMission({
      title: "Intentional stop", goal: "Do not revive", acceptance: "The worker stays stopped",
      workspaceId: workspace.id, roleIds: ["stop-orchestrator", "stop-worker", "stop-validator"],
      maxTurns: 10, maxCost: 1, autonomy: "trusted"
    });
    server.control.missionAction(mission.id, "start");
    const [agent] = server.control.listAgents(mission.id);
    await server.workers.startAgent(agent);
    server.control.missionAction(mission.id, "pause");
    await server.workers.pauseMission(mission.id);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const exported = server.control.exportMission(mission.id);
    assert.equal(exported.mission.status, "paused");
    assert.equal(exported.events.some((event) => event.type === "worker_recovery_started"), false);
    assert.equal(server.workers.handles.has(agent.id), false);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("concurrent pause and shutdown callbacks share one native cleanup", { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-worker-quiescence-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const server = await startServer({ home, port: 0, testOnlyScripted: true });
  try {
    server.control.upsertProfile({ ...profile, id: "quiescence-profile" });
    for (const kind of ["orchestrator", "worker", "validator"]) {
      server.control.upsertRole({ id: `quiescence-${kind}`, name: kind, kind, instructions: "Test-only quiescence role.", profileId: "quiescence-profile" });
    }
    const workspace = server.control.addWorkspace("quiescence", realpathSync(workspacePath));
    const mission = server.control.createMission({
      title: "Concurrent quiescence", goal: "Share native cleanup", acceptance: "One fence",
      workspaceId: workspace.id, roleIds: ["quiescence-orchestrator", "quiescence-worker", "quiescence-validator"],
      maxTurns: 10, maxCost: 1, autonomy: "trusted"
    });
    server.control.missionAction(mission.id, "start");
    const [agent] = server.control.listAgents(mission.id);
    assert.ok(agent);
    await server.workers.startAgent(agent);
    const before = server.control.getAgentPublic(agent.id);
    assert.ok(before);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const originalStopProcesses = server.control.stopMissionProcesses.bind(server.control);
    server.control.stopMissionProcesses = async (missionId) => {
      await gate;
      return originalStopProcesses(missionId);
    };
    server.control.missionAction(mission.id, "pause");
    const pause = server.workers.pauseMission(mission.id);
    const shutdown = server.workers.stopMission(mission.id);
    release();
    await Promise.all([pause, shutdown]);
    server.control.stopMissionProcesses = originalStopProcesses;
    const after = server.control.getAgentPublic(agent.id);
    assert.ok(after);
    assert.equal(after.epoch, before.epoch + 1, "concurrent callbacks must fence the live agent once");
    assert.equal(server.workers.handles.has(agent.id), false, "native worker must stay stopped");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(server.workers.handles.has(agent.id), false, "intentional shutdown must not resurrect the worker");
    assert.equal(server.control.getAgentPublic(agent.id)?.epoch, after.epoch);
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("IPC disconnect in-flight rejects RPC without killing the host", { timeout: 10000 }, async () => {
  const workerModule = new URL("../dist/worker.js", import.meta.url).href;
  const source = `import { rpcRequest } from ${JSON.stringify(workerModule)};
const config = ${JSON.stringify({
    agentId: "ipc-test-agent", missionId: "ipc-test-mission", epoch: 1, token: "ipc-test-token",
    durablePath: "/tmp/ipc-test.sqlite", workspacePath: "/tmp",
    profile, role: { id: "ipc-role", name: "IPC", kind: "worker", instructions: "", profileId: profile.id }
  })};
try { await rpcRequest(config, "GetMissionState", {}, "ipc-test"); console.log("UNEXPECTED_SUCCESS"); process.exitCode = 2; }
catch (error) { console.log("RPC_REJECTED:" + error.message); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`IPC child did not settle: ${output} ${errorOutput}`));
    }, 3000);
    child.on("message", (message) => {
      if (message?.type === "rpc" && child.connected) child.disconnect();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(result, { code: 0, signal: null });
  assert.match(output, /RPC_REJECTED:Control-plane IPC channel disconnected/);
});
