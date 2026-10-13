import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { startServer } from "../dist/server.js";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

const profile = {
  id: "requirements-profile", name: "Requirements faux", api: "openai-completions", modelId: "faux",
  baseUrl: "http://127.0.0.1:9999", credentialEnv: "", contextWindow: 16000, maxTokens: 512,
  reasoning: false, toolCalling: true, vision: false, revision: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

function fixture(assertions = [
  { id: "REQ-A", description: "The first assertion" },
  { id: "REQ-B", description: "The second assertion" }
], autonomy = "trusted") {
  const home = mkdtempSync(join(tmpdir(), "mission-contract-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const control = new ControlPlane(join(home, "state"));
  control.upsertProfile(profile);
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: kind, name: kind, kind, instructions: `${kind} test`, profileId: profile.id });
  }
  const workspace = control.addWorkspace("requirements", workspacePath);
  const mission = control.createMission({
    title: "Requirements mission", goal: "Contract mechanics", acceptance: "Original acceptance",
    workspaceId: workspace.id, roleIds: ["orchestrator", "worker", "validator"], maxTurns: 10, maxCost: 1,
    autonomy, assertions
  });
  const started = control.missionAction(mission.id, "start");
  const orchestrator = control.getAgentPublic(started.orchestratorId);
  const worker = control.createAgent(mission.id, "Worker", "worker", "worker", "requirements-worker");
  const validator = control.createAgent(mission.id, "Validator", "validator", "validator", "requirements-validator");
  return { home, stateHome: join(home, "state"), workspacePath, control, workspace, mission, orchestrator, worker, validator };
}

function cleanup(f) {
  f.control.close();
  rmSync(f.home, { recursive: true, force: true });
}

function stopAgents(f) {
  for (const agent of f.control.listAgents(f.mission.id)) f.control.setAgentStatus(agent.id, agent.epoch, "offline");
}

function prepareTask(f, id, fulfills, dependencies = []) {
  const task = f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, `create-${id}`, {
    missionId: f.mission.id, title: id, description: "task", acceptance: "acceptance", dependencies,
    ownerId: f.worker.id, validatorId: f.validator.id, fulfills
  });
  f.control.updateTask(f.worker.id, f.worker.epoch, `run-${id}`, task.id, { status: "running" });
  f.control.updateTask(f.worker.id, f.worker.epoch, `review-${id}`, task.id, { status: "review" });
  const path = join(f.workspacePath, `${id}.txt`);
  writeFileSync(path, id);
  const artifact = f.control.publishArtifact(f.worker.id, f.worker.epoch, `artifact-${id}`, id, path, readFileSync(path), task.id);
  return { task: f.control.task(task.id), artifact };
}

test("new missions persist a root contract; claims are strict and orphan coverage blocks completion", async () => {
  const f = fixture();
  try {
    const contract = f.control.validationContract(f.mission.id);
    assert.deepEqual(contract.assertions, [
      { id: "REQ-A", description: "The first assertion", revision: 1 },
      { id: "REQ-B", description: "The second assertion", revision: 1 }
    ]);
    assert.equal(f.control.missionById(f.mission.id).contractRevision, 1);
    assert.equal(Object.hasOwn(f.control.missionById(f.mission.id), "assertions"), false);
    const defaultMission = f.control.createMission({
      title: "Default root", goal: "Default root", acceptance: "Authoritative acceptance",
      workspaceId: f.workspace.id, roleIds: ["orchestrator", "worker", "validator"], maxTurns: 10, maxCost: 1, autonomy: "trusted"
    });
    assert.deepEqual(f.control.validationContract(defaultMission.id).assertions, [
      { id: "REQ-001", description: "Authoritative acceptance", revision: 1 }
    ]);
    assert.throws(() => f.control.createMission({
      title: "Empty assertions", goal: "Reject empty", acceptance: "Acceptance",
      workspaceId: f.workspace.id, roleIds: ["orchestrator", "worker", "validator"], maxTurns: 10, maxCost: 1, autonomy: "trusted", assertions: []
    }), /non-empty array/);
    assert.throws(() => f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "unknown-claim", {
      missionId: f.mission.id, title: "unknown", description: "", acceptance: "", dependencies: [], fulfills: ["REQ-Z"]
    }), /unknown assertion/);
    assert.throws(() => f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "duplicate-claim", {
      missionId: f.mission.id, title: "duplicate", description: "", acceptance: "", dependencies: [], fulfills: ["REQ-A", "REQ-A"]
    }), /duplicate/);
    assert.throws(() => f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "null-domain-claim", {
      missionId: f.mission.id, title: "null", description: "", acceptance: "", dependencies: [], fulfills: null
    }), /array/);
    await assert.rejects(() => f.control.workerCommand({
      id: "null-rpc-claim", token: "test", agentId: f.orchestrator.id, epoch: f.orchestrator.epoch,
      method: "CreateTask", taskId: "null-rpc-claim",
      args: { title: "null", description: "", acceptance: "", dependencies: [], fulfills: null }
    }), /array/);
    const task = prepareTask(f, "owned", ["REQ-A"]).task;
    assert.throws(() => f.control.updateTask(f.worker.id, f.worker.epoch, "worker-claim-edit", task.id, { fulfills: ["REQ-B"] }), /Only the orchestrator/);
    assert.equal(f.control.detail(f.mission.id).requirementCoverage.find((item) => item.assertion.id === "REQ-B").status, "unassigned");
    await assert.rejects(() => f.control.workerCommand({
      id: "complete", token: "test", agentId: f.orchestrator.id, epoch: f.orchestrator.epoch,
      method: "CompleteMission", args: {}, taskId: "complete"
    }), /Every current validation assertion|All required tasks/);
  } finally {
    cleanup(f);
  }
});

test("exit-0 receipt and explicit assertion results are required for acceptance", async () => {
  const f = fixture([{ id: "REQ-A", description: "The command succeeds" }]);
  try {
    const target = prepareTask(f, "validation", ["REQ-A"]);
    const missing = await f.control.runValidation(f.validator.id, f.validator.epoch, "missing-results-run", {
      taskId: target.task.id, command: "printf ok; exit 0", artifactIds: [target.artifact.id]
    });
    assert.throws(() => f.control.validateTask(f.validator.id, f.validator.epoch, "missing-results", target.task.id, missing.id, true, "ok"), /Assertion results are required/);
    assert.throws(() => f.control.validateTask(f.validator.id, f.validator.epoch, "duplicate-results", target.task.id, missing.id, true, "ok", [
      { assertionId: "REQ-A", status: "passed", evidence: "one" },
      { assertionId: "REQ-A", status: "passed", evidence: "two" }
    ]), /Duplicate assertion/);
    assert.throws(() => f.control.validateTask(f.validator.id, f.validator.epoch, "wrong-result", target.task.id, missing.id, true, "ok", [
      { assertionId: "REQ-Z", status: "passed", evidence: "wrong" }
    ]), /exactly match/);
    const failed = await f.control.runValidation(f.validator.id, f.validator.epoch, "nonzero-run", {
      taskId: target.task.id, command: "printf bad; exit 7", artifactIds: [target.artifact.id]
    });
    assert.throws(() => f.control.validateTask(f.validator.id, f.validator.epoch, "nonzero-pass", target.task.id, failed.id, true, "bad", [
      { assertionId: "REQ-A", status: "passed", evidence: "claimed" }
    ]), /exit-0/);
    const accepted = f.control.validateTask(f.validator.id, f.validator.epoch, "explicit-pass", target.task.id, missing.id, true, "verified", [
      { assertionId: "REQ-A", status: "passed", evidence: "The command exited zero" }
    ]);
    assert.equal(accepted.passed, true);
    assert.equal(f.control.detail(f.mission.id).requirementCoverage[0].status, "passed");
    const completed = await f.control.workerCommand({
      id: "complete-after-assertion", token: "test", agentId: f.orchestrator.id, epoch: f.orchestrator.epoch,
      method: "CompleteMission", args: {}, taskId: "complete-after-assertion"
    });
    assert.equal(completed.status, "completed");
  } finally {
    cleanup(f);
  }
});

test("contract revisions invalidate claimed owners and dependents while preserving history and legacy semantics", async () => {
  const f = fixture([{ id: "REQ-A", description: "First" }, { id: "REQ-B", description: "Unchanged" }]);
  try {
    const first = prepareTask(f, "first", ["REQ-A"]);
    const firstReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "first-before-change", {
      taskId: first.task.id, command: "printf first; exit 0", artifactIds: [first.artifact.id]
    });
    f.control.validateTask(f.validator.id, f.validator.epoch, "accept-first-before-change", first.task.id, firstReceipt.id, true, "first accepted", [
      { assertionId: "REQ-A", status: "passed", evidence: "first passed" }
    ]);
    const second = f.control.createTask(f.orchestrator.id, f.orchestrator.epoch, "create-second", {
      missionId: f.mission.id, title: "second", description: "dependent", acceptance: "dependent",
      dependencies: [first.task.id], ownerId: f.worker.id, validatorId: f.validator.id
    });
    f.control.updateTask(f.worker.id, f.worker.epoch, "run-second", second.id, { status: "running" });
    f.control.updateTask(f.worker.id, f.worker.epoch, "review-second", second.id, { status: "review" });
    const secondPath = join(f.workspacePath, "second.txt");
    writeFileSync(secondPath, "second");
    const secondArtifact = f.control.publishArtifact(f.worker.id, f.worker.epoch, "artifact-second", "second", secondPath, readFileSync(secondPath), second.id);
    const secondReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "second-before-change", {
      taskId: second.id, command: "printf second; exit 0", artifactIds: [secondArtifact.id]
    });
    assert.throws(() => f.control.validateTask(f.validator.id, f.validator.epoch, "second-wrong-result", second.id, secondReceipt.id, true, "second rejected", [
      { assertionId: "REQ-A", status: "passed", evidence: "unclaimed" }
    ]), /exactly match/);
    f.control.validateTask(f.validator.id, f.validator.epoch, "accept-second-before-change", second.id, secondReceipt.id, true, "second accepted", []);
    const stable = prepareTask(f, "stable", ["REQ-B"]);
    const stableReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "stable-before-change", {
      taskId: stable.task.id, command: "printf stable; exit 0", artifactIds: [stable.artifact.id]
    });
    f.control.validateTask(f.validator.id, f.validator.epoch, "accept-stable-before-change", stable.task.id, stableReceipt.id, true, "stable accepted", [
      { assertionId: "REQ-B", status: "passed", evidence: "unchanged assertion passed" }
    ]);
    f.control.missionAction(f.mission.id, "pause");
    stopAgents(f);
    const updated = f.control.updateValidationContract(f.mission.id, {
      expectedRevision: 1, assertions: [{ id: "REQ-A", description: "Changed" }, { id: "REQ-B", description: "Unchanged" }],
      reason: "Clarify first requirement", confirmRemoval: false
    });
    assert.equal(updated.revision, 2);
    const detail = f.control.detail(f.mission.id);
    assert.equal(detail.validationContractHistory.length, 2);
    assert.equal(detail.mission.acceptance, "Original acceptance");
    assert.equal(detail.tasks.find((task) => task.id === first.task.id).status, "blocked");
    assert.equal(detail.tasks.find((task) => task.id === second.id).status, "blocked");
    assert.equal(detail.tasks.find((task) => task.id === stable.task.id).status, "accepted");
    assert.equal(detail.requirementCoverage.find((item) => item.assertion.id === "REQ-A").status, "pending");
    assert.equal(detail.requirementCoverage.find((item) => item.assertion.id === "REQ-B").status, "passed");
    assert.throws(() => f.control.validateTask(f.validator.id, f.validator.epoch, "old-receipt-after-change", first.task.id, firstReceipt.id, true, "stale", [
      { assertionId: "REQ-A", status: "passed", evidence: "old scope" }
    ]), /stale/);
    assert.throws(() => f.control.updateValidationContract(f.mission.id, {
      expectedRevision: 2, assertions: [{ id: "REQ-B", description: "Unchanged" }], reason: "remove", confirmRemoval: false
    }), /confirmRemoval/);
    assert.throws(() => f.control.updateValidationContract(f.mission.id, {
      expectedRevision: 1, assertions: [{ id: "REQ-A", description: "Changed" }, { id: "REQ-B", description: "Unchanged" }],
      reason: "wrong revision", confirmRemoval: false
    }), /current revision/);
  } finally {
    cleanup(f);
  }
});

test("authenticated HTTP contract update enforces strict revision and removal semantics", async () => {
  const f = fixture([{ id: "REQ-A", description: "A" }, { id: "REQ-B", description: "B" }]);
  f.control.missionAction(f.mission.id, "pause");
  stopAgents(f);
  f.control.close();
  const app = await startServer({ home: f.stateHome, port: 0 });
  try {
    const token = readFileSync(join(f.stateHome, "admin.token"), "utf8").trim();
    const url = `http://127.0.0.1:${app.port}/api/missions/${f.mission.id}/validation-contract`;
    const request = (body) => fetch(url, {
      method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body)
    });
    app.control.missionAction(f.mission.id, "resume");
    const active = await request({ expectedRevision: 1, assertions: [{ id: "REQ-A", description: "A2" }, { id: "REQ-B", description: "B" }], reason: "active", confirmRemoval: false });
    assert.equal(active.status, 409);
    app.control.missionAction(f.mission.id, "pause");
    for (const agent of app.control.listAgents(f.mission.id)) app.control.setAgentStatus(agent.id, agent.epoch, "offline");
    const response = await request({ expectedRevision: 1, assertions: [{ id: "REQ-B", description: "B" }], reason: "remove", confirmRemoval: false });
    assert.equal(response.status, 400);
    const changed = await request({ expectedRevision: 1, assertions: [{ id: "REQ-A", description: "A2" }, { id: "REQ-B", description: "B" }], reason: "clarify", confirmRemoval: false });
    assert.equal(changed.status, 200);
    const stale = await request({ expectedRevision: 1, assertions: [{ id: "REQ-A", description: "A3" }, { id: "REQ-B", description: "B" }], reason: "stale", confirmRemoval: false });
    assert.equal(stale.status, 409);
    const empty = await request({ expectedRevision: 2, assertions: [], reason: "remove all", confirmRemoval: true });
    assert.equal(empty.status, 400);
    const removed = await request({ expectedRevision: 2, assertions: [{ id: "REQ-B", description: "B" }], reason: "confirmed removal", confirmRemoval: true });
    assert.equal(removed.status, 200);
    const reused = await request({ expectedRevision: 3, assertions: [{ id: "REQ-A", description: "Reused" }, { id: "REQ-B", description: "B" }], reason: "reuse", confirmRemoval: false });
    assert.equal(reused.status, 409);
  } finally {
    await app.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("approved validation cannot execute after its assertion scope changes", async () => {
  const f = fixture([{ id: "REQ-A", description: "Original" }], "approve");
  try {
    const target = prepareTask(f, "approval", ["REQ-A"]);
    const approval = f.control.createApproval(f.validator.id, f.validator.epoch, "request-validation-approval", "run_validation", {
      taskId: target.task.id, command: "printf must-not-run", artifactIds: [target.artifact.id]
    });
    f.control.resolveApproval(approval.id, "approved");
    f.control.missionAction(f.mission.id, "pause");
    stopAgents(f);
    f.control.updateValidationContract(f.mission.id, {
      expectedRevision: 1, assertions: [{ id: "REQ-A", description: "Revised" }],
      reason: "Change validation scope", confirmRemoval: false
    });
    f.control.missionAction(f.mission.id, "resume");
    const result = await f.control.executeApproved(approval.id);
    assert.equal(result.status, "failed");
    assert.match(result.receipt.stderr, /scope is stale/);
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS count FROM validation_intents WHERE mission_id=?").get(f.mission.id).count, 0);
  } finally {
    cleanup(f);
  }
});

test("mixed assertion failures stay assertion-specific and stale evidence ids disappear after rework", async () => {
  const f = fixture([
    { id: "REQ-A", description: "A" },
    { id: "REQ-B", description: "B" },
    { id: "REQ-C", description: "C" }
  ]);
  try {
    const target = prepareTask(f, "mixed", ["REQ-A", "REQ-B", "REQ-C"]);
    const receipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "mixed-run", {
      taskId: target.task.id, command: "printf mixed; exit 0", artifactIds: [target.artifact.id]
    });
    f.control.validateTask(f.validator.id, f.validator.epoch, "mixed-failure", target.task.id, receipt.id, false, "partial failure", [
      { assertionId: "REQ-A", status: "passed", evidence: "A passed individually" },
      { assertionId: "REQ-B", status: "failed", evidence: "B failed" },
      { assertionId: "REQ-C", status: "untested", evidence: "C untested" }
    ]);
    const current = Object.fromEntries(f.control.detail(f.mission.id).requirementCoverage.map((item) => [item.assertion.id, item]));
    assert.equal(current["REQ-A"].status, "pending");
    assert.equal(current["REQ-B"].status, "failed");
    assert.equal(current["REQ-C"].status, "pending");
    for (const item of Object.values(current)) {
      assert.equal(typeof item.validationId, "string");
      assert.equal(typeof item.receiptId, "string");
    }
    f.control.updateTask(f.worker.id, f.worker.epoch, "mixed-rework", target.task.id, { status: "running" });
    const stale = f.control.detail(f.mission.id).requirementCoverage;
    assert.equal(stale.every((item) => item.validationId === undefined && item.receiptId === undefined), true);
    const stateHome = f.stateHome;
    f.control.close();
    f.control = new ControlPlane(stateHome);
    const reopened = f.control.detail(f.mission.id);
    assert.equal(reopened.validations.length, 1);
    assert.equal(reopened.validationReceipts.length, 1);
    assert.equal(reopened.validationContractHistory.length, 1);
    assert.equal(reopened.requirementCoverage.every((item) => item.validationId === undefined && item.receiptId === undefined), true);
  } finally {
    if (f.control) cleanup(f);
    else rmSync(f.home, { recursive: true, force: true });
  }
});

test("contract linkage fails closed when the pointed snapshot is missing", async () => {
  const f = fixture();
  try {
    const before = f.control.missionById(f.mission.id);
    f.control.db.prepare("DELETE FROM validation_contracts WHERE mission_id=? AND revision=?").run(f.mission.id, 1);
    assert.throws(() => f.control.validationContract(f.mission.id), (error) => error.status === 409 && /snapshot is missing/.test(error.message));
    assert.throws(() => f.control.detail(f.mission.id), (error) => error.status === 409 && /snapshot is missing/.test(error.message));
    await assert.rejects(() => f.control.workerCommand({
      id: "missing-contract-complete", token: "test", agentId: f.orchestrator.id, epoch: f.orchestrator.epoch,
      method: "CompleteMission", args: {}, taskId: "missing-contract-complete"
    }), (error) => error.status === 409 && /snapshot is missing/.test(error.message));
    assert.deepEqual(f.control.missionById(f.mission.id), before);
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS count FROM validation_contracts WHERE mission_id=?").get(f.mission.id).count, 0);
  } finally {
    cleanup(f);
  }
});

test("original CreateTask and ValidateTask payload hashes replay without new effects", async () => {
  const f = fixture([{ id: "REQ-A", description: "A" }]);
  try {
    const taskId = "legacy-task";
    const createCommandId = "legacy-create";
    const createPayload = {
      missionId: f.mission.id, title: "legacy", description: "legacy", acceptance: "legacy",
      dependencies: [], ownerId: f.worker.id, validatorId: f.validator.id
    };
    const task = { ...createPayload, id: taskId, status: "review", attempt: 1, revision: 1 };
    f.control.db.prepare("INSERT INTO tasks(id,mission_id,status,data) VALUES(?,?,?,?)").run(task.id, task.missionId, task.status, JSON.stringify(task));
    f.control.db.prepare("INSERT INTO commands(scope,command_id,payload_hash,response,created_at) VALUES(?,?,?,?,?)")
      .run(`mission:${f.mission.id}:tasks`, createCommandId, hash(createPayload), JSON.stringify(task), new Date().toISOString());
    const counts = () => ({
      tasks: f.control.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE mission_id=?").get(f.mission.id).count,
      events: f.control.db.prepare("SELECT COUNT(*) AS count FROM events WHERE mission_id=?").get(f.mission.id).count,
      commands: f.control.db.prepare("SELECT COUNT(*) AS count FROM commands WHERE scope LIKE ?").get(`mission:${f.mission.id}:%`).count
    });
    const beforeCreateReplay = counts();
    const replayedTask = await f.control.workerCommand({
      id: createCommandId, token: "test", agentId: f.orchestrator.id, epoch: f.orchestrator.epoch,
      method: "CreateTask", taskId: createCommandId,
      args: { title: "legacy", description: "legacy", acceptance: "legacy", dependencies: [], ownerId: f.worker.id, validatorId: f.validator.id }
    });
    assert.deepEqual(replayedTask, task);
    assert.deepEqual(counts(), beforeCreateReplay);
    const path = join(f.workspacePath, "legacy.txt");
    writeFileSync(path, "legacy");
    const artifact = f.control.publishArtifact(f.worker.id, f.worker.epoch, "legacy-artifact", "legacy", path, readFileSync(path), taskId);
    const receipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "legacy-receipt", {
      taskId, command: "printf legacy; exit 0", artifactIds: [artifact.id]
    });
    const validateCommandId = "legacy-validate";
    const validatePayload = { taskId, receiptId: receipt.id, passed: true, evidence: "legacy accepted" };
    const legacyValidation = {
      id: "legacy-validation", missionId: f.mission.id, taskId, agentId: f.validator.id, passed: true,
      evidence: "legacy accepted", receiptId: receipt.id, attempt: 1, taskRevision: 1,
      artifactIds: [artifact.id], createdAt: new Date().toISOString()
    };
    f.control.db.prepare("INSERT INTO validations(id,mission_id,task_id,data) VALUES(?,?,?,?)")
      .run(legacyValidation.id, f.mission.id, taskId, JSON.stringify(legacyValidation));
    f.control.db.prepare("INSERT INTO commands(scope,command_id,payload_hash,response,created_at) VALUES(?,?,?,?,?)")
      .run(`mission:${f.mission.id}:validations`, validateCommandId, hash(validatePayload), JSON.stringify(legacyValidation), new Date().toISOString());
    const beforeValidateReplay = {
      ...counts(),
      validations: f.control.db.prepare("SELECT COUNT(*) AS count FROM validations WHERE mission_id=?").get(f.mission.id).count
    };
    const replayedValidation = await f.control.workerCommand({
      id: validateCommandId, token: "test", agentId: f.validator.id, epoch: f.validator.epoch,
      method: "ValidateTask", taskId: validateCommandId,
      args: { taskId, receiptId: receipt.id, passed: true, evidence: "legacy accepted" }
    });
    assert.deepEqual(replayedValidation, legacyValidation);
    assert.deepEqual({
      ...counts(),
      validations: f.control.db.prepare("SELECT COUNT(*) AS count FROM validations WHERE mission_id=?").get(f.mission.id).count
    }, beforeValidateReplay);
  } finally {
    cleanup(f);
  }
});

test("contract scalar fences approvals and unsubmitted receipts across unrelated revisions", async () => {
  const f = fixture([{ id: "REQ-A", description: "A" }], "approve");
  try {
    const target = prepareTask(f, "scalar", ["REQ-A"]);
    const oldReceipt = await f.control.runValidation(f.validator.id, f.validator.epoch, "scalar-old-receipt", {
      taskId: target.task.id, command: "printf old; exit 0", artifactIds: [target.artifact.id]
    });
    const intentCount = f.control.db.prepare("SELECT COUNT(*) AS count FROM validation_intents WHERE mission_id=?").get(f.mission.id).count;
    const approval = f.control.createApproval(f.validator.id, f.validator.epoch, "scalar-approval", "run_validation", {
      taskId: target.task.id, command: "printf must-not-run", artifactIds: [target.artifact.id]
    });
    f.control.resolveApproval(approval.id, "approved");
    f.control.missionAction(f.mission.id, "pause");
    stopAgents(f);
    f.control.updateValidationContract(f.mission.id, {
      expectedRevision: 1, assertions: [{ id: "REQ-A", description: "A" }, { id: "REQ-B", description: "Added" }],
      reason: "Add unrelated assertion", confirmRemoval: false
    });
    f.control.missionAction(f.mission.id, "resume");
    assert.throws(() => f.control.validateTask(f.validator.id, f.validator.epoch, "scalar-old-validation", target.task.id, oldReceipt.id, true, "old", [
      { assertionId: "REQ-A", status: "passed", evidence: "old" }
    ]), /contract revision/);
    const result = await f.control.executeApproved(approval.id);
    assert.equal(result.status, "failed");
    assert.match(result.receipt.stderr, /scope is stale/);
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS count FROM validation_intents WHERE mission_id=?").get(f.mission.id).count, intentCount);
  } finally {
    cleanup(f);
  }
});

test("legacy persisted missions remain legacy after reopen", () => {
  const f = fixture();
  try {
    const row = f.control.db.prepare("SELECT data FROM missions WHERE id=?").get(f.mission.id);
    const mission = JSON.parse(row.data);
    delete mission.contractRevision;
    f.control.db.prepare("UPDATE missions SET data=? WHERE id=?").run(JSON.stringify(mission), f.mission.id);
    f.control.db.prepare("DELETE FROM validation_contracts WHERE mission_id=?").run(f.mission.id);
    const stateHome = join(f.home, "state");
    f.control.close();
    const reopened = new ControlPlane(stateHome);
    assert.equal(reopened.missionById(f.mission.id).contractRevision, undefined);
    assert.equal(reopened.validationContract(f.mission.id), undefined);
    assert.equal(reopened.missionById(f.mission.id).acceptance, "Original acceptance");
    reopened.close();
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
