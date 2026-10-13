import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane, parseCreateMissionInput } from "../dist/control.js";
import { inspectRepository } from "../dist/worktrees.js";

const profile = {
  id: "worktree-test-profile",
  name: "Worktree test profile",
  api: "openai-completions",
  modelId: "faux-1",
  baseUrl: "http://127.0.0.1:1",
  credentialEnv: "",
  contextWindow: 16000,
  maxTokens: 512,
  reasoning: false,
  toolCalling: true,
  vision: false,
  revision: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_TERMINAL_PROMPT: "0"
    }
  }).trim();
}

function commitAll(repo, message) {
  git(repo, "add", "-A");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function makeFixture({ assertions, start = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mission-control-worktrees-"));
  const repo = join(root, "source");
  const home = join(root, "daemon");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Mission Control test");
  git(repo, "config", "user.email", "mission-control-test@example.invalid");
  writeFileSync(join(repo, ".gitignore"), "*.ignored\n");
  writeFileSync(join(repo, "fixture.txt"), "source-version\n");
  writeFileSync(join(repo, "companion.txt"), "base-companion\n");
  writeFileSync(join(repo, "secret.ignored"), "must not be copied\n");
  const baseCommit = commitAll(repo, "fixture base");

  const control = new ControlPlane(home);
  control.upsertProfile(profile);
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: `worktree-${kind}`, name: kind, kind, instructions: `${kind} instructions`, profileId: profile.id });
  }
  const workspace = control.addWorkspace("worktree fixture", repo);
  const mission = control.createMission({
    title: "Worktree fixture",
    goal: "Exercise isolated Git worktrees",
    acceptance: "Committed artifacts are independently validated",
    workspaceId: workspace.id,
    roleIds: ["worktree-orchestrator", "worktree-worker", "worktree-validator"],
    maxTurns: 20,
    maxCost: 0,
    autonomy: "trusted",
    workspaceStrategy: "worktree",
    ...(assertions ? { assertions } : {})
  });
  const started = start ? control.missionAction(mission.id, "start") : mission;
  if (!start) return { root, repo, home, baseCommit, control, workspace, mission: started };
  const orchestrator = control.getAgentPublic(started.orchestratorId);
  const worker = control.createAgent(mission.id, "Worker", "worktree-worker", "work", "worker-create");
  const secondWorker = control.createAgent(mission.id, "Second worker", "worktree-worker", "work", "worker-create-2");
  const validator = control.createAgent(mission.id, "Validator", "worktree-validator", "validate", "validator-create");
  return { root, repo, home, baseCommit, control, workspace, mission: started, orchestrator, worker, secondWorker, validator };
}

function closeFixture(f) {
  try { f.control.close(); } finally { rmSync(f.root, { recursive: true, force: true }); }
}

function makeReviewTask(f, owner, suffix, { fulfills = [], dependencies = [], integration = false } = {}) {
  const task = f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, `task-create-${suffix}`, {
    missionId: f.mission.id,
    title: suffix,
    description: "Worktree regression task",
    acceptance: "The independent command verifies the committed tree",
    dependencies,
    ownerId: owner.id,
    validatorId: f.validator.id,
    fulfills,
    ...(integration ? { integration: true } : {})
  });
  if (task.status === "blocked" && dependencies.length === 0) throw new Error("Unexpected blocked test task");
  if (task.status !== "ready") {
    for (const dependency of dependencies) assert.equal(f.control.task(dependency)?.status, "accepted");
  }
  if (task.status === "blocked") {
    f.control.refreshDependentTasks(f.mission.id);
  }
  f.control.updateTask(owner.id, owner.epoch, `task-running-${suffix}`, task.id, { status: "running" });
  f.control.updateTask(owner.id, owner.epoch, `task-review-${suffix}`, task.id, { status: "review" });
  f.control.setAgentStatus(owner.id, owner.epoch, "idle");
  return f.control.task(task.id);
}

function commitFile(repo, path, content, message) {
  writeFileSync(join(repo, path), content);
  git(repo, "add", "--", path);
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function publish(f, owner, task, relPath, name = relPath) {
  const path = join(owner.workspacePath, relPath);
  const bytes = readFileSync(path);
  return f.control.publishArtifact(owner.id, owner.epoch, `publish-${task.id}-${name}`, name, path, bytes, task.id);
}

function validationWorktreePath(f, task, commandId) {
  const digest = createHash("sha256").update(JSON.stringify([task.id, commandId])).digest("hex").slice(0, 32);
  return join(realpathSync(f.home), "worktrees", f.mission.id, "validation", digest);
}

test("validation waits for every overlapping owner shell through the shared execution path", async () => {
  const f = makeFixture();
  let waiting;
  const gate = join(f.root, "release-shell");
  try {
    const owner = f.control.prepareAgentWorkspace(f.worker.id);
    const task = makeReviewTask(f, owner, "overlapping-shells");
    commitFile(owner.workspacePath, "input.txt", "stable\n", "shell test input");
    const artifact = publish(f, owner, task, "input.txt");
    const code = `const fs=require("node:fs");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)})){clearInterval(timer);}},20)`;
    waiting = f.control.runShell(owner, `node -e '${code}'`, false);
    const quick = await f.control.runShellCommand(owner, "quick-parallel-shell", 'node -e "process.exit(0)"');
    assert.equal(quick.exitCode, 0);
    await assert.rejects(
      () => f.control.runValidation(f.validator.id, f.validator.epoch, "while-owner-shell-active", {
        taskId: task.id, command: 'node -e "process.exit(0)"', artifactIds: [artifact.id]
      }),
      /Task owner still has active work/
    );
    writeFileSync(gate, "release");
    assert.equal((await waiting).exitCode, 0);
    const receipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "after-owner-shells", {
      taskId: task.id, command: 'node -e "process.exit(0)"', artifactIds: [artifact.id]
    });
    assert.equal(receipt.exitCode, 0);
  } finally {
    writeFileSync(gate, "release");
    if (waiting) await waiting;
    closeFixture(f);
  }
});

test("worktree Missions pin a clean root and prepare isolated stable worktrees safely", () => {
  const f = makeFixture();
  try {
    assert.equal(f.mission.repository.path, realpathSync(f.repo));
    assert.equal(f.mission.repository.baseCommit, f.baseCommit);
    assert.notEqual(f.mission.repository.gitCommonDir, f.repo);
    mkdirSync(join(f.repo, "nested"));
    assert.throws(() => inspectRepository(join(f.repo, "nested")), /repository root/);
    writeFileSync(join(f.repo, "fixture.txt"), "tracked change\n");
    assert.throws(() => inspectRepository(f.repo), /clean repository/);
    writeFileSync(join(f.repo, "fixture.txt"), "source-version\n");
    writeFileSync(join(f.repo, "tracked.txt"), "dirty");
    assert.throws(() => inspectRepository(f.repo), /clean repository/);
    rmSync(join(f.repo, "tracked.txt"));
    writeFileSync(join(f.repo, "untracked.txt"), "dirty");
    assert.throws(() => inspectRepository(f.repo), /clean repository/);
    rmSync(join(f.repo, "untracked.txt"));
    assert.equal(inspectRepository(f.repo).baseCommit, f.baseCommit);

    const first = f.control.prepareAgentWorkspace(f.worker.id);
    const second = f.control.prepareAgentWorkspace(f.secondWorker.id);
    assert.equal(existsSync(join(first.workspacePath, "secret.ignored")), false);
    assert.equal(first.worktreeId, `agent:${f.worker.id}`);
    assert.notEqual(first.workspacePath, second.workspacePath);
    assert.equal(git(first.workspacePath, "branch", "--show-current"), `mission-control/${f.mission.id}/${f.worker.id}`);
    assert.equal(git(second.workspacePath, "branch", "--show-current"), `mission-control/${f.mission.id}/${f.secondWorker.id}`);
    commitFile(first.workspacePath, "same-name.txt", "worker one\n", "worker one");
    commitFile(second.workspacePath, "same-name.txt", "worker two\n", "worker two");
    assert.equal(readFileSync(join(first.workspacePath, "same-name.txt"), "utf8"), "worker one\n");
    assert.equal(readFileSync(join(second.workspacePath, "same-name.txt"), "utf8"), "worker two\n");
    assert.equal(readFileSync(join(f.repo, "fixture.txt"), "utf8"), "source-version\n");
    assert.equal(git(first.workspacePath, "status", "--porcelain"), "");
    assert.equal(git(second.workspacePath, "status", "--porcelain"), "");

    const advancedHead = git(first.workspacePath, "rev-parse", "HEAD");
    const stablePath = first.workspacePath;
    f.control.close();
    f.control = new ControlPlane(f.home);
    const recovered = f.control.prepareAgentWorkspace(f.worker.id);
    assert.equal(recovered.workspacePath, stablePath);
    assert.equal(git(stablePath, "rev-parse", "HEAD"), advancedHead, "restart must not reset the advanced branch");

    f.orchestrator = f.control.getAgentPublic(f.mission.orchestratorId);
    const pending = f.control.createAgent(f.mission.id, "Pending recovery", "worktree-worker", "work", "worker-pending");
    const pendingRecord = f.control.listWorktrees(f.mission.id).find((record) => record.agentId === pending.id);
    git(f.repo, "worktree", "add", "-b", pendingRecord.branch, pendingRecord.path, pendingRecord.baseCommit);
    const resumed = f.control.prepareAgentWorkspace(pending.id);
    assert.equal(f.control.listWorktrees(f.mission.id).find((record) => record.id === resumed.worktreeId).status, "ready");

    const collision = f.control.createAgent(f.mission.id, "Collision", "worktree-worker", "work", "worker-collision");
    const collisionRecord = f.control.listWorktrees(f.mission.id).find((record) => record.agentId === collision.id);
    mkdirSync(collisionRecord.path, { recursive: true });
    writeFileSync(join(collisionRecord.path, "keep.txt"), "do not overwrite");
    assert.throws(() => f.control.prepareAgentWorkspace(collision.id), /already exists but is not registered/);
    assert.equal(readFileSync(join(collisionRecord.path, "keep.txt"), "utf8"), "do not overwrite");

    const symlinkAgent = f.control.createAgent(f.mission.id, "Symlink", "worktree-worker", "work", "worker-symlink");
    const prepared = f.control.prepareAgentWorkspace(symlinkAgent.id);
    const moved = join(f.root, "preserved-worktree");
    rmSync(prepared.workspacePath, { recursive: true });
    mkdirSync(moved);
    writeFileSync(join(moved, "keep.txt"), "preserve");
    symlinkSync(moved, prepared.workspacePath);
    assert.throws(() => f.control.prepareAgentWorkspace(prepared.id), /symlink/);
    assert.equal(readFileSync(join(moved, "keep.txt"), "utf8"), "preserve");
    assert.equal(f.control.listWorktrees(f.mission.id).find((record) => record.agentId === prepared.id).status, "error");

    const unborn = join(f.root, "unborn");
    mkdirSync(unborn);
    git(unborn, "init", "-q");
    assert.throws(() => inspectRepository(unborn), /existing commit/);
    assert.throws(() => parseCreateMissionInput({
      title: "x", goal: "x", acceptance: "x", workspaceId: "x", roleIds: ["x"], maxTurns: 1, maxCost: 0, autonomy: "trusted",
      workspaceStrategy: "other"
    }), /workspaceStrategy/);
  } finally {
    closeFixture(f);
  }
});

test("validation runs the owner's full detached commit and rejects uncommitted, unowned, mutated, or stale work", async () => {
  const f = makeFixture();
  try {
    const owner = f.control.prepareAgentWorkspace(f.worker.id);
    const other = f.control.prepareAgentWorkspace(f.secondWorker.id);
    const task = makeReviewTask(f, owner, "validation");
    assert.throws(() => f.control.publishArtifact(owner.id, owner.epoch, "uncommitted", "pending", join(owner.workspacePath, "pending.txt"), Buffer.from("pending"), task.id), /ENOENT|tracked regular/);
    writeFileSync(join(owner.workspacePath, "uncommitted.txt"), "uncommitted\n");
    assert.throws(() => f.control.publishArtifact(owner.id, owner.epoch, "dirty-before-commit", "uncommitted", join(owner.workspacePath, "uncommitted.txt"), readFileSync(join(owner.workspacePath, "uncommitted.txt")), task.id), /untracked|clean/i);
    rmSync(join(owner.workspacePath, "uncommitted.txt"));
    commitFile(other.workspacePath, "foreign.txt", "other worker\n", "other worker artifact");
    assert.throws(() => f.control.publishArtifact(
      owner.id, owner.epoch, "other-worker-path", "foreign", join(other.workspacePath, "foreign.txt"),
      readFileSync(join(other.workspacePath, "foreign.txt")), task.id
    ), /worktree|workspace/i);
    commitFile(owner.workspacePath, "deliverable.txt", "committed bytes\n", "deliverable");
    commitFile(owner.workspacePath, "companion.txt", "owner-companion\n", "companion tracked input");
    const ownerCommit = git(owner.workspacePath, "rev-parse", "HEAD");
    const artifact = publish(f, owner, task, "deliverable.txt");
    const sourceCompanion = join(f.repo, "companion.txt");
    writeFileSync(sourceCompanion, "source checkout changed after pin\n");
    const command = `node -e "const fs=require('node:fs');if(fs.readFileSync('companion.txt','utf8')!=='owner-companion\\\\n'||fs.readFileSync('fixture.txt','utf8')!=='source-version\\\\n'||fs.readFileSync('deliverable.txt','utf8')!=='committed bytes\\\\n')process.exit(7)"`;
    const receipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "validation-full-tree", {
      taskId: task.id, command, artifactIds: [artifact.id]
    });
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.snapshotIntegrity, true);
    assert.equal(receipt.workspaceCommit, ownerCommit);
    assert.notEqual(receipt.workspacePath, owner.workspacePath);
    assert.notEqual(receipt.workspacePath, f.repo);
    assert.equal(git(receipt.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  } catch (error) {
    throw error;
  } finally {
    closeFixture(f);
  }
});

test("integration completion requires a new independently validated commit containing accepted task commits", async () => {
  const f = makeFixture({ assertions: [{ id: "REQ-001", description: "The integrated product includes committed work." }] });
  try {
    const ordinaryOwner = f.control.prepareAgentWorkspace(f.worker.id);
    const integrationOwner = f.control.prepareAgentWorkspace(f.secondWorker.id);
    const ordinary = makeReviewTask(f, ordinaryOwner, "ordinary", { fulfills: ["REQ-001"] });
    commitFile(ordinaryOwner.workspacePath, "result.txt", "ordinary result\n", "ordinary result");
    const artifact = publish(f, ordinaryOwner, ordinary, "result.txt");
    const ordinaryRun = await f.control.runValidation(f.validator.id, f.validator.epoch, "ordinary-run", {
      taskId: ordinary.id,
      command: "node -e \"require('node:fs').accessSync('result.txt')\"",
      artifactIds: [artifact.id]
    });
    f.control.validateTask(f.validator.id, f.validator.epoch, "ordinary-accept", ordinary.id, ordinaryRun.id, true, "Ordinary result passed.", [
      { assertionId: "REQ-001", status: "passed", evidence: "The ordinary contribution passed." }
    ]);
    const acceptedHead = ordinaryRun.workspaceCommit;
    assert.throws(() => f.control.completeMission(f.control.getAgentPublic(f.orchestrator.id), f.orchestrator.epoch, "complete-missing-integration"), /integration task/);

    commitFile(ordinaryOwner.workspacePath, "result.txt", "later owner work\n", "later ordinary-owner change");
    const integration = makeReviewTask(f, integrationOwner, "integration", { dependencies: [ordinary.id], integration: true });
    git(integrationOwner.workspacePath, "merge", "--no-ff", "--no-edit", `mission-control/${f.mission.id}/${ordinaryOwner.id}`);
    const integrationCommit = commitFile(integrationOwner.workspacePath, "delivery.txt", "integrated delivery\n", "delivery artifact");
    const finalArtifact = publish(f, integrationOwner, integration, "delivery.txt");
    const integrationRun = await f.control.runValidation(f.validator.id, f.validator.epoch, "integration-run", {
      taskId: integration.id,
      command: `node -e "const fs=require('node:fs');if(fs.readFileSync('result.txt','utf8')!=='later owner work\\\\n'||fs.readFileSync('delivery.txt','utf8')!=='integrated delivery\\\\n')process.exit(9)"`,
      artifactIds: [finalArtifact.id]
    });
    assert.equal(integrationRun.workspaceCommit, integrationCommit);
    assert.equal(integrationRun.snapshotIntegrity, true);
    f.control.validateTask(f.validator.id, f.validator.epoch, "integration-accept", integration.id, integrationRun.id, true, "All contract assertions passed on the merged commit.", [
      { assertionId: "REQ-001", status: "passed", evidence: "Verified in the integrated commit." }
    ]);
    assert.notEqual(acceptedHead, integrationCommit);
    assert.equal(git(f.repo, "status", "--porcelain"), "");
    const complete = f.control.completeMission(f.control.getAgentPublic(f.orchestrator.id), f.orchestrator.epoch, "complete-integrated");
    assert.equal(complete.status, "completed", "old accepted artifact/receipt remains valid by immutable Git blob identity");
    const detail = f.control.detail(f.mission.id);
    assert.equal(detail.worktrees.length, 6);
    assert.equal(detail.tasks.filter((task) => task.integration).length, 1);
  } finally {
    closeFixture(f);
  }
});

test("tracked validation mutations and stale owner commits cannot be accepted", async () => {
  const f = makeFixture();
  try {
    const owner = f.control.prepareAgentWorkspace(f.worker.id);
    const task = makeReviewTask(f, owner, "integrity");
    commitFile(owner.workspacePath, "input.txt", "stable\n", "tracked input");
    const artifact = publish(f, owner, task, "input.txt");
    const mutated = await f.control.runValidation(f.validator.id, f.validator.epoch, "mutate-tracked-input", {
      taskId: task.id,
      command: `node -e "require('node:fs').writeFileSync('input.txt','mutated\\\\n')"`,
      artifactIds: [artifact.id]
    });
    assert.equal(mutated.exitCode, 0);
    assert.equal(mutated.snapshotIntegrity, false);
    assert.match(mutated.snapshotError, /Tracked validation inputs changed/);
    assert.throws(() => f.control.validateTask(f.validator.id, f.validator.epoch, "reject-mutated", task.id, mutated.id, true, "Must reject", []), /intact tracked snapshot/);

    const staleTask = makeReviewTask(f, owner, "stale");
    commitFile(owner.workspacePath, "stale.txt", "before validation\n", "stale baseline");
    const staleArtifact = publish(f, owner, staleTask, "stale.txt");
    const staleReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "stale-receipt", {
      taskId: staleTask.id,
      command: "node -e \"process.exit(0)\"",
      artifactIds: [staleArtifact.id]
    });
    commitFile(owner.workspacePath, "later.txt", "new owner commit\n", "advance owner after validation");
    assert.throws(() => f.control.validateTask(f.validator.id, f.validator.epoch, "reject-stale", staleTask.id, staleReceipt.id, true, "Must reject", []), /owner's worktree changed/);

    const foreignTask = f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "foreign-task", {
      missionId: f.mission.id, title: "Foreign", description: "", acceptance: "x", dependencies: [], ownerId: f.secondWorker.id, validatorId: f.validator.id
    });
    const foreignPath = join(owner.workspacePath, "stale.txt");
    assert.throws(() => f.control.publishArtifact(owner.id, owner.epoch, "foreign-owner-artifact", "foreign", foreignPath, readFileSync(foreignPath), foreignTask.id), /task owner/);
    writeFileSync(join(owner.workspacePath, "dirty-untracked.txt"), "uncommitted");
    assert.throws(() => f.control.publishArtifact(owner.id, owner.epoch, "dirty-publish", "dirty", join(owner.workspacePath, "dirty-untracked.txt"), readFileSync(join(owner.workspacePath, "dirty-untracked.txt")), staleTask.id), /untracked|clean/i);
    assert.equal(git(f.repo, "status", "--porcelain"), "");
  } finally {
    closeFixture(f);
  }
});

test("worktree Mission start replays before checking the source and reports dirty drafts as conflicts", () => {
  const startedFixture = makeFixture();
  try {
    const started = startedFixture.mission;
    writeFileSync(join(startedFixture.repo, "fixture.txt"), "dirty after start\n");
    assert.deepEqual(startedFixture.control.missionAction(started.id, "start"), started);
  } finally {
    closeFixture(startedFixture);
  }

  const draftFixture = makeFixture({ start: false });
  try {
    writeFileSync(join(draftFixture.repo, "fixture.txt"), "dirty before start\n");
    assert.throws(
      () => draftFixture.control.missionAction(draftFixture.mission.id, "start"),
      (error) => error.status === 409 && /clean repository/.test(error.message)
    );
  } finally {
    closeFixture(draftFixture);
  }
});

test("failed validation worktree preparation is terminal non-execution across restart", async () => {
  const f = makeFixture();
  try {
    const owner = f.control.prepareAgentWorkspace(f.worker.id);
    const task = makeReviewTask(f, owner, "validation-preparation-failure");
    commitFile(owner.workspacePath, "output.txt", "validated\n", "validation input");
    const artifact = publish(f, owner, task, "output.txt");
    const commandId = "validation-path-collision";
    const input = { taskId: task.id, command: "node -e \"process.exit(0)\"", artifactIds: [artifact.id] };
    const collisionPath = validationWorktreePath(f, task, commandId);
    mkdirSync(collisionPath, { recursive: true });

    await assert.rejects(
      () => f.control.runValidation(f.validator.id, f.validator.epoch, commandId, input),
      (error) => error.status === 409 && /Validation worktree could not be prepared safely/.test(error.message)
    );
    const validation = f.control.db.prepare("SELECT status,receipt_id FROM validation_intents WHERE scope=? AND command_id=?")
      .get(`mission:${f.mission.id}:validation:${f.validator.id}`, commandId);
    assert.equal(validation.status, "aborted");
    assert.equal(validation.receipt_id, null);
    const failedWorktree = f.control.listWorktrees(f.mission.id).find((record) => record.kind === "validation");
    assert.equal(failedWorktree.status, "error");
    assert.ok(failedWorktree.error);
    assert.equal(f.control.blockers(f.mission.id).some((blocker) => blocker.kind === "unsafe_execution"), false);

    f.control.close();
    f.control = new ControlPlane(f.home);
    f.control.reconcileInFlightOperations();
    assert.equal(f.control.db.prepare("SELECT status,receipt_id FROM validation_intents WHERE scope=? AND command_id=?")
      .get(`mission:${f.mission.id}:validation:${f.validator.id}`, commandId).status, "aborted");
    assert.equal(f.control.blockers(f.mission.id).some((blocker) => blocker.kind === "unsafe_execution"), false);
    const validator = f.control.getAgentPublic(f.validator.id);
    await assert.rejects(
      () => f.control.runValidation(validator.id, validator.epoch, commandId, input),
      (error) => error.status === 409 && error.message === `validation was not executed: ${failedWorktree.error}`
    );

    rmSync(collisionPath, { recursive: true, force: true });
    const recoveredOwner = f.control.getAgentPublic(owner.id);
    f.control.setAgentStatus(recoveredOwner.id, recoveredOwner.epoch, "idle");
    const freshValidator = f.control.getAgentPublic(f.validator.id);
    const receipt = await f.control.runValidation(freshValidator.id, freshValidator.epoch, "validation-path-collision-retry", input);
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.snapshotIntegrity, true);
    assert.equal(f.control.blockers(f.mission.id).some((blocker) => blocker.kind === "unsafe_execution"), false);
  } finally {
    closeFixture(f);
  }
});

test("completion rejects accepted ordinary commits missing from the integration commit", async () => {
  const f = makeFixture({ assertions: [{ id: "REQ-001", description: "The accepted change is integrated." }] });
  try {
    const ordinaryOwner = f.control.prepareAgentWorkspace(f.worker.id);
    const integrationOwner = f.control.prepareAgentWorkspace(f.secondWorker.id);
    const ordinary = makeReviewTask(f, ordinaryOwner, "missing-integration-ordinary", { fulfills: ["REQ-001"] });
    commitFile(ordinaryOwner.workspacePath, "ordinary.txt", "ordinary result\n", "ordinary accepted result");
    const ordinaryArtifact = publish(f, ordinaryOwner, ordinary, "ordinary.txt");
    const ordinaryReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "missing-integration-ordinary-run", {
      taskId: ordinary.id, command: "node -e \"require('node:fs').accessSync('ordinary.txt')\"", artifactIds: [ordinaryArtifact.id]
    });
    f.control.validateTask(f.validator.id, f.validator.epoch, "missing-integration-ordinary-accept", ordinary.id, ordinaryReceipt.id, true, "Ordinary contribution passed.", [
      { assertionId: "REQ-001", status: "passed", evidence: "Validated on the accepted ordinary commit." }
    ]);

    const integration = makeReviewTask(f, integrationOwner, "missing-integration-task", { dependencies: [ordinary.id], integration: true });
    commitFile(integrationOwner.workspacePath, "integrated.txt", "not merged\n", "unrelated integration commit");
    const integrationArtifact = publish(f, integrationOwner, integration, "integrated.txt");
    const integrationReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "missing-integration-run", {
      taskId: integration.id, command: "node -e \"require('node:fs').accessSync('integrated.txt')\"", artifactIds: [integrationArtifact.id]
    });
    f.control.validateTask(f.validator.id, f.validator.epoch, "missing-integration-accept", integration.id, integrationReceipt.id, true, "Integration assertion passed independently.", [
      { assertionId: "REQ-001", status: "passed", evidence: "Independently validated on the integration commit." }
    ]);
    assert.throws(
      () => f.control.completeMission(f.control.getAgentPublic(f.orchestrator.id), f.orchestrator.epoch, "complete-without-ordinary-commit"),
      /not included in the accepted integration commit/
    );
  } finally {
    closeFixture(f);
  }
});

test("a worktree Mission permits only one integration task", () => {
  const f = makeFixture();
  try {
    const first = f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "create-first-integration", {
      missionId: f.mission.id, title: "First integration", description: "", acceptance: "Integrate all work",
      dependencies: [], ownerId: f.worker.id, validatorId: f.validator.id, fulfills: [], integration: true
    });
    assert.equal(f.control.updateTask(f.orchestrator.id, f.orchestrator.epoch, "keep-first-integration", first.id, { integration: true }).integration, true);
    assert.throws(
      () => f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "create-second-integration", {
        missionId: f.mission.id, title: "Second integration", description: "", acceptance: "Integrate all work",
        dependencies: [], ownerId: f.secondWorker.id, validatorId: f.validator.id, fulfills: [], integration: true
      }),
      (error) => error.status === 409 && /A worktree Mission can have only one integration task/.test(error.message)
    );
    const ordinary = f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "create-ordinary-for-integration-flag", {
      missionId: f.mission.id, title: "Ordinary", description: "", acceptance: "Do ordinary work",
      dependencies: [], ownerId: f.secondWorker.id, validatorId: f.validator.id, fulfills: []
    });
    assert.throws(
      () => f.control.updateTask(f.orchestrator.id, f.orchestrator.epoch, "make-second-integration", ordinary.id, { integration: true }),
      (error) => error.status === 409 && /A worktree Mission can have only one integration task/.test(error.message)
    );
  } finally {
    closeFixture(f);
  }
});

test("integration validation requires results for every current contract assertion", async () => {
  const f = makeFixture({ assertions: [
    { id: "REQ-001", description: "First integrated contract assertion." },
    { id: "REQ-002", description: "Second integrated contract assertion." }
  ] });
  try {
    const owner = f.control.prepareAgentWorkspace(f.worker.id);
    const integration = makeReviewTask(f, owner, "partial-integration", { integration: true });
    commitFile(owner.workspacePath, "integrated.txt", "integrated\n", "integration artifact");
    const artifact = publish(f, owner, integration, "integrated.txt");
    const receipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "partial-integration-run", {
      taskId: integration.id, command: "node -e \"require('node:fs').accessSync('integrated.txt')\"", artifactIds: [artifact.id]
    });
    assert.throws(
      () => f.control.validateTask(f.validator.id, f.validator.epoch, "partial-integration-accept", integration.id, receipt.id, true, "Partial integration result.", [
        { assertionId: "REQ-001", status: "passed", evidence: "Only the first assertion was checked." }
      ]),
      /Integration assertion results must exactly match the current contract/
    );
  } finally {
    closeFixture(f);
  }
});

test("a fast-forward integration commit may equal an accepted ordinary commit", async () => {
  const f = makeFixture({ assertions: [{ id: "REQ-001", description: "The integrated product includes accepted work." }] });
  try {
    const ordinaryOwner = f.control.prepareAgentWorkspace(f.worker.id);
    const integrationOwner = f.control.prepareAgentWorkspace(f.secondWorker.id);
    const ordinary = makeReviewTask(f, ordinaryOwner, "fast-forward-ordinary", { fulfills: ["REQ-001"] });
    commitFile(ordinaryOwner.workspacePath, "result.txt", "accepted contribution\n", "accepted ordinary commit");
    const ordinaryArtifact = publish(f, ordinaryOwner, ordinary, "result.txt");
    const ordinaryReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "fast-forward-ordinary-run", {
      taskId: ordinary.id, command: "node -e \"require('node:fs').accessSync('result.txt')\"", artifactIds: [ordinaryArtifact.id]
    });
    f.control.validateTask(f.validator.id, f.validator.epoch, "fast-forward-ordinary-accept", ordinary.id, ordinaryReceipt.id, true, "Ordinary contribution passed.", [
      { assertionId: "REQ-001", status: "passed", evidence: "Accepted ordinary commit passes." }
    ]);

    const integration = makeReviewTask(f, integrationOwner, "fast-forward-integration", { dependencies: [ordinary.id], integration: true });
    git(integrationOwner.workspacePath, "merge", "--ff-only", `mission-control/${f.mission.id}/${ordinaryOwner.id}`);
    const integrationCommit = git(integrationOwner.workspacePath, "rev-parse", "HEAD");
    assert.equal(integrationCommit, ordinaryReceipt.workspaceCommit);
    const integrationArtifact = publish(f, integrationOwner, integration, "result.txt");
    const integrationReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "fast-forward-integration-run", {
      taskId: integration.id, command: "node -e \"require('node:fs').accessSync('result.txt')\"", artifactIds: [integrationArtifact.id]
    });
    f.control.validateTask(f.validator.id, f.validator.epoch, "fast-forward-integration-accept", integration.id, integrationReceipt.id, true, "Full contract passed on the fast-forwarded commit.", [
      { assertionId: "REQ-001", status: "passed", evidence: "Integration independently validates the accepted commit." }
    ]);
    assert.equal(integrationReceipt.workspaceCommit, ordinaryReceipt.workspaceCommit);
    assert.equal(
      f.control.completeMission(f.control.getAgentPublic(f.orchestrator.id), f.orchestrator.epoch, "complete-fast-forward").status,
      "completed"
    );
  } finally {
    closeFixture(f);
  }
});
