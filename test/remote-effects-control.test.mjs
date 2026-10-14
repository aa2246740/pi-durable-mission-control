import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane, RemoteRuntimeRecoveryError, RemoteRuntimeStopPendingError } from "../dist/control.js";
import { WorkerManager } from "../dist/workers.js";
import { startServer } from "../dist/server.js";
import { nodeEffectUpload } from "../dist/node-effects.js";

function fixture(t, executionMode = "workspace-effects", autonomy = "trusted", capabilityOverrides = {}) {
  const home = mkdtempSync(join(tmpdir(), "remote-effects-control-"));
  let control;
  t.after(() => { control?.close(); rmSync(home, { recursive: true, force: true }); });
  const localPath = join(home, "local");
  const remotePath = join(home, "remote");
  mkdirSync(localPath); mkdirSync(remotePath);
  control = new ControlPlane(join(home, "control"));
  const local = control.addWorkspace("Local", localPath);
  const enrolled = control.enrollMachine(`effects-${crypto.randomUUID()}`, "Effects node");
  const capabilities = {
    protocol: executionMode === "workspace-effects" ? 3 : 2,
    version: "test", platform: process.platform, arch: process.arch, node: process.version, piDurable: "test",
    roots: [remotePath], credentialRefs: [], executionEnabled: true, executionMode,
    ...capabilityOverrides
  };
  const session = control.nodeSession(enrolled.machine.id, enrolled.token, capabilities, crypto.randomUUID());
  const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), remotePath);
  control.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  control.nodeEvent(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: remotePath, path: remotePath, isDirectory: true }
  });
  const remote = control.addRemoteWorkspace("Remote", enrolled.machine.id, probe.id);
  const profile = {
    id: `effects-profile-${crypto.randomUUID()}`, name: "Fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "https://models.example.test/v1", credentialEnv: "", contextWindow: 4096, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false, revision: 1
  };
  control.upsertProfile(profile);
  const roleIds = ["orchestrator", "worker", "validator"].map(kind => `effects-${kind}-${crypto.randomUUID()}`);
  for (let index = 0; index < roleIds.length; index++) {
    const kind = ["orchestrator", "worker", "validator"][index];
    control.upsertRole({ id: roleIds[index], name: kind, kind, instructions: "fixture", profileId: profile.id });
  }
  const mission = control.createMission({
    title: "Remote effects control", goal: "exercise authorization", acceptance: "only valid effects receive permits",
    workspaceId: local.id, remoteWorkspaceIds: [remote.id], roleIds, maxTurns: 10, maxCost: 0, autonomy,
    workspaceStrategy: "shared"
  });
  control.missionAction(mission.id, "start");
  const createdAgent = control.createAgent(mission.id, "Remote worker", roleIds[1], "fixture", `request-${crypto.randomUUID()}`, remote.id);
  let agent = createdAgent;
  const assignment = control.assignRemoteRuntime(agent.id);
  control.remoteRuntimeReady(assignment.binding);
  agent = control.getAgentPublic(agent.id);
  return { control, home, remotePath, enrolled, session, profile, roleIds, mission, agent, assignment };
}

function request(agent, method, args, suffix = "effect") {
  return { agentId: agent.id, epoch: agent.epoch, method, args, taskId: `${agent.id}:${suffix}` };
}

for (const executionMode of ["metadata-only", "workspace-effects"]) {
  for (const kind of ["worker", "validator"]) {
    test(`remote ${executionMode} ${kind} cannot create a user-input blocker through RPC`, async t => {
      const { control, agent, mission, roleIds } = fixture(t, executionMode);
      if (kind === "validator") {
        // Remote placement admits workers only; also reject a stored role changed to validator.
        const row = control.db.prepare("SELECT data FROM agents WHERE id=?").get(agent.id);
        control.db.prepare("UPDATE agents SET data=? WHERE id=?")
          .run(JSON.stringify({ ...JSON.parse(row.data), roleId: roleIds[2] }), agent.id);
      }
      await assert.rejects(() => control.workerCommand(request(agent, "RequestUserInput", { question: "Move to review?" })), error => {
        assert.equal(error.status, 403);
        assert.match(error.message, /Only the orchestrator/);
        assert.match(error.message, /Report or SendMessage/);
        return true;
      });
      assert.equal(control.missionById(mission.id).status, "active");
      assert.deepEqual(control.blockers(mission.id), []);
      assert.equal(control.getAgentPublic(agent.id).status, agent.status);
      assert.equal(control.detail(mission.id).events.some(event => event.type === "user_input_requested"), false);
    });
  }
}

test("protocol-3 worker receives identity-bound idempotent permits without coordinator filesystem effects", async t => {
  const f = fixture(t), { control, agent, assignment, remotePath, mission } = f;
  assert.equal(assignment.descriptor.effects, true);
  const permit = await control.workerCommand(request(agent, "write_file", { path: "only-on-node.txt", content: "node" }));
  assert.equal(permit.effectPermit.method, "write_file");
  assert.deepEqual(permit.effectPermit.args, { path: "only-on-node.txt", content: "node" });
  assert.deepEqual(permit.effectPermit.binding, assignment.binding);
  assert.equal(permit.effectPermit.descriptorHash, assignment.descriptorHash);
  assert.equal(permit.effectPermit.taskId, `${agent.id}:effect`);
  assert.ok(permit.effectPermit.expiresAt <= control.machineRegistry.get(agent.machineId).leaseExpiresAt);
  assert.deepEqual(
    (await control.workerCommand(request(agent, "write_file", { path: "only-on-node.txt", content: "node" }))).effectPermit,
    permit.effectPermit
  );
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_authorized").length, 1);
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_authorized")[0].data.method, "write_file");
  const taskId = `${agent.id}:effect`;
  const receiptRequest = {
    agentId: agent.id, epoch: agent.epoch, taskId, method: "RecordEffectReceipt",
    args: { effectId: `${agent.id}\0${taskId}`, binding: assignment.binding, descriptorHash: assignment.descriptorHash,
      taskId, receipt: { status: "succeeded", result: { path: "only-on-node.txt", bytes: 4 } } }
  };
  assert.deepEqual(await control.workerCommand(receiptRequest), { recorded: true });
  assert.deepEqual(await control.workerCommand(receiptRequest), { recorded: true });
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_receipt").length, 1);
  await assert.rejects(
    () => control.workerCommand({ ...receiptRequest, args: { ...receiptRequest.args, receipt: { status: "succeeded" } } }),
    error => error.status === 409
  );
  assert.equal(control.remoteRuntimeForAgent(agent.id).descriptor_json.includes(remotePath), true);
  assert.equal(existsSync(join(remotePath, "only-on-node.txt")), false);
  assert.equal(control.detail(mission.id).artifacts.some(item => item.name === "only-on-node.txt"), false);
});

test("remote PublishArtifact fails closed on protocol 3 without the frozen transfer capability", async t => {
  const f = fixture(t), { control, agent, mission, roleIds } = f;
  assert.equal(f.assignment.descriptor.artifactTransfers, undefined);
  const orchestrator = control.listAgents(mission.id).find(item => item.kind === "orchestrator");
  const validator = control.createAgent(mission.id, "Validator", roleIds[2], "fixture", `validator-${crypto.randomUUID()}`);
  const task = control.createTask(orchestrator.id, orchestrator.epoch, `create-${crypto.randomUUID()}`, {
    missionId: mission.id, title: "Publish", description: "", acceptance: "bound artifact",
    dependencies: [], ownerId: agent.id, validatorId: validator.id
  });
  const before = {
    agents: control.db.prepare("SELECT COUNT(*) AS count FROM agents").get().count,
    messages: control.db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
    events: control.detail(mission.id).events.length,
    transfers: control.db.prepare("SELECT COUNT(*) AS count FROM remote_artifact_transfers").get().count
  };
  await assert.rejects(() => control.workerCommand({
    agentId: agent.id, epoch: agent.epoch, taskId: `${agent.id}:publish-without-negotiation`,
    method: "PublishArtifact", args: { name: "evidence", path: "evidence.bin", taskId: task.id }
  }), error => error.status === 409 && /not negotiated/.test(error.message));
  assert.deepEqual({
    agents: control.db.prepare("SELECT COUNT(*) AS count FROM agents").get().count,
    messages: control.db.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
    events: control.detail(mission.id).events.length,
    transfers: control.db.prepare("SELECT COUNT(*) AS count FROM remote_artifact_transfers").get().count
  }, before);
});

test("metadata-only stays fail-closed; validators and approval autonomy cannot obtain write/bash permits", async t => {
  const metadata = fixture(t, "metadata-only");
  assert.equal(Object.hasOwn(metadata.assignment.descriptor, "effects"), false);
  await assert.rejects(
    () => metadata.control.workerCommand(request(metadata.agent, "read_file", { path: "x" })),
    error => error.status === 409 && error.message === "Remote operation is unavailable for this agent"
  );

  const validator = fixture(t);
  const row = validator.control.db.prepare("SELECT data FROM agents WHERE id=?").get(validator.agent.id);
  const agentData = JSON.parse(row.data);
  agentData.roleId = validator.roleIds[2];
  validator.control.db.prepare("UPDATE agents SET data=? WHERE id=?").run(JSON.stringify(agentData), validator.agent.id);
  for (const method of ["write_file", "bash"]) {
    const args = method === "bash" ? { command: "true" } : { path: "x", content: "x" };
    await assert.rejects(
      () => validator.control.workerCommand(request(validator.agent, method, args)),
      error => error.status === 403
    );
  }

  const approval = fixture(t, "workspace-effects", "approve");
  await assert.rejects(
    () => approval.control.workerCommand(request(approval.agent, "bash", { command: "true" })),
    error => error.status === 409 && /does not support effect approvals/.test(error.message)
  );
});

test("dedicated receipt evidence accepts a historical same-machine binding without changing ownership", async t => {
  const f = fixture(t);
  const { control, agent, assignment, enrolled, session, mission } = f;
  const taskId = `${agent.id}:historical-receipt`;
  const spec = {
    binding: assignment.binding,
    descriptorHash: assignment.descriptorHash,
    taskId,
    method: "write_file",
    args: { path: "late.txt", content: "late" }
  };
  await control.workerCommand(request(agent, "write_file", spec.args, "historical-receipt"));
  const upload = nodeEffectUpload(spec, { status: "succeeded", result: { path: "late.txt", bytes: 4 } });
  control.missionAction(mission.id, "pause");
  control.requestRemoteRuntimeStop(agent.id);
  control.markAgentInterrupted(agent.id, agent.epoch);
  control.nodeRuntimeReport(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, {
    reportId: crypto.randomUUID(), binding: assignment.binding, descriptorHash: assignment.descriptorHash, outcome: "stopped"
  });
  assert.equal(control.remoteRuntimeForAgent(agent.id).state, "closed");
  assert.equal(control.missionById(mission.id).status, "paused");
  const stableBeforeLateReceipt = {
    agent: control.getAgentPublic(agent.id),
    runtime: control.remoteRuntimeForAgent(agent.id),
    messages: control.detail(mission.id).messages,
    budget: control.detail(mission.id).budget
  };
  assert.equal(stableBeforeLateReceipt.runtime.state, "closed");
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_receipt").length, 0);
  assert.deepEqual(
    control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, upload),
    { recorded: true, duplicate: false, effectId: upload.effectId, receiptHash: upload.receiptHash }
  );
  assert.deepEqual(
    control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, upload),
    { recorded: true, duplicate: true, effectId: upload.effectId, receiptHash: upload.receiptHash }
  );
  const afterLateReceipt = {
    mission: control.missionById(mission.id),
    agent: control.getAgentPublic(agent.id),
    runtime: control.remoteRuntimeForAgent(agent.id),
    messages: control.detail(mission.id).messages,
    budget: control.detail(mission.id).budget
  };
  assert.equal(afterLateReceipt.mission.status, "paused");
  assert.deepEqual(afterLateReceipt.agent, stableBeforeLateReceipt.agent);
  assert.deepEqual(afterLateReceipt.runtime, stableBeforeLateReceipt.runtime);
  assert.deepEqual(afterLateReceipt.messages, stableBeforeLateReceipt.messages);
  assert.deepEqual(afterLateReceipt.budget, stableBeforeLateReceipt.budget);
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_receipt").length, 1);

  control.revokeMachine(enrolled.machine.id);
  const replacement = control.reenrollMachine(enrolled.machine.id);
  const replacementSession = control.nodeSession(
    enrolled.machine.id, replacement.token,
    { protocol: 3, version: "test", platform: process.platform, arch: process.arch, node: process.version,
      piDurable: "test", roots: [f.remotePath], credentialRefs: [], executionEnabled: true, executionMode: "workspace-effects" },
    crypto.randomUUID()
  );
  const stableAfterReenrollment = {
    mission: control.missionById(mission.id),
    agent: control.getAgentPublic(agent.id),
    runtime: control.remoteRuntimeForAgent(agent.id),
    messages: control.detail(mission.id).messages,
    budget: control.detail(mission.id).budget
  };
  assert.deepEqual(
    control.nodeEffectReceipt(enrolled.machine.id, replacement.token, replacementSession.sessionId, replacementSession.sessionEpoch, upload),
    { recorded: true, duplicate: true, effectId: upload.effectId, receiptHash: upload.receiptHash }
  );
  const after = {
    mission: control.missionById(mission.id),
    agent: control.getAgentPublic(agent.id),
    runtime: control.remoteRuntimeForAgent(agent.id),
    messages: control.detail(mission.id).messages,
    budget: control.detail(mission.id).budget
  };
  assert.deepEqual(after.agent, stableAfterReenrollment.agent);
  assert.deepEqual(after.messages, stableAfterReenrollment.messages);
  assert.deepEqual(after.budget, stableAfterReenrollment.budget);
  assert.equal(after.runtime.state, "closed");
  assert.equal(after.mission.status, "paused");
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_receipt").length, 1);

  assert.throws(
    () => control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, replacementSession.sessionId, replacementSession.sessionEpoch, upload),
    error => error.status === 401
  );
  const wrongMachine = control.enrollMachine(`wrong-${crypto.randomUUID()}`, "Wrong machine");
  const wrongSession = control.nodeSession(wrongMachine.machine.id, wrongMachine.token, {
    protocol: 1, version: "test", platform: process.platform, arch: process.arch, node: process.version,
    piDurable: "test", roots: [f.remotePath], credentialRefs: [], executionEnabled: false
  }, crypto.randomUUID());
  assert.throws(
    () => control.nodeEffectReceipt(wrongMachine.machine.id, wrongMachine.token, wrongSession.sessionId, wrongSession.sessionEpoch, upload),
    error => error.status === 403
  );
  for (const changed of [
    { ...spec, method: "bash", args: { command: "true" } },
    { ...spec, args: { path: "other.txt", content: "late" } },
    { ...spec, descriptorHash: "0".repeat(64) },
    { ...spec, taskId: `${agent.id}:never-authorized` },
  ]) {
    const changedUpload = nodeEffectUpload(changed, upload.receipt);
    assert.throws(
      () => control.nodeEffectReceipt(enrolled.machine.id, replacement.token, replacementSession.sessionId, replacementSession.sessionEpoch, changedUpload),
      error => error.status === 409
    );
  }
  const conflicting = nodeEffectUpload(spec, { status: "succeeded", result: { path: "late.txt", bytes: 99 } });
  assert.throws(
    () => control.nodeEffectReceipt(enrolled.machine.id, replacement.token, replacementSession.sessionId, replacementSession.sessionEpoch, conflicting),
    error => error.status === 409
  );
});

test("recovered uncertain receipt creates one durable unsafe-execution blocker without resuming", async t => {
  const f = fixture(t);
  const { control, agent, assignment, enrolled, session, mission } = f;
  const taskId = `${agent.id}:recovered-uncertain`;
  const spec = {
    binding: assignment.binding,
    descriptorHash: assignment.descriptorHash,
    taskId,
    method: "bash",
    args: { command: "printf x >> effect-marker" }
  };
  await control.workerCommand(request(agent, "bash", spec.args, "recovered-uncertain"));
  control.missionAction(mission.id, "pause");
  control.requestRemoteRuntimeStop(agent.id);
  control.markAgentInterrupted(agent.id, agent.epoch);
  const stopped = control.nodeRuntimeReport(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, {
    reportId: crypto.randomUUID(), binding: assignment.binding, descriptorHash: assignment.descriptorHash, outcome: "stopped"
  });
  assert.equal(stopped.recorded, true);
  assert.equal(control.remoteRuntimeForAgent(agent.id).state, "closed");
  const upload = nodeEffectUpload(spec, { status: "uncertain", error: "Node restarted while the effect was executing" });
  const first = control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, upload);
  assert.equal(first.duplicate, false);
  const blockers = control.blockers(mission.id).filter(blocker => blocker.kind === "unsafe_execution");
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].status, "open");
  assert.equal(control.missionById(mission.id).status, "paused");
  assert.equal(control.remoteRuntimeForAgent(agent.id).state, "closed");
  const eventsBeforeDuplicate = control.detail(mission.id).events.filter(event => event.type === "remote_effect_receipt").length;
  assert.equal(eventsBeforeDuplicate, 1);
  const duplicate = control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, upload);
  assert.equal(duplicate.duplicate, true);
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_receipt").length, eventsBeforeDuplicate);
  assert.equal(control.blockers(mission.id).filter(blocker => blocker.kind === "unsafe_execution").length, 1);
  assert.equal(control.missionById(mission.id).status, "paused");
  assert.equal(control.remoteRuntimeForAgent(agent.id).state, "closed");
  assert.throws(() => control.missionAction(mission.id, "resume"), error => error.status === 409);
});

test("remote GetMissionState reports the live session execution environment and local state stays unchanged", async t => {
  for (const executionMode of ["workspace-effects", "metadata-only"]) {
    const f = fixture(t, executionMode, "trusted", {
      platform: "linux", arch: "x64", node: "v22.19.0-isolated",
      credentialRefs: ["SHOULD_NOT_LEAK_CREDENTIAL_REF"]
    });
    const stored = f.control.machineRegistry.get(f.agent.machineId);
    stored.capabilities.roots = [...stored.capabilities.roots, "/should-not-leak-other-root"];
    f.control.db.prepare("UPDATE remote_machines SET data=? WHERE id=?").run(JSON.stringify(stored), stored.id);
    const other = f.control.enrollMachine(`other-${crypto.randomUUID()}`, "Other node");
    f.control.nodeSession(other.machine.id, other.token, {
      protocol: 3, version: "test", platform: "freebsd", arch: "arm", node: "v0.0.1-other-machine",
      piDurable: "test", roots: ["/other-machine-root"], credentialRefs: ["OTHER_MACHINE_SECRET_REF"],
      executionEnabled: true, executionMode: "workspace-effects"
    }, crypto.randomUUID());

    const state = await f.control.workerCommand(request(f.agent, "GetMissionState", {}, "execution-environment"));
    assert.deepEqual(state.executionEnvironment, {
      machineId: f.agent.machineId,
      platform: "linux",
      arch: "x64",
      node: "v22.19.0-isolated",
      workspacePath: f.remotePath
    });
    assert.equal(state.executionEnvironment.workspacePath, f.agent.workspacePath);
    assert.deepEqual(Object.keys(state.executionEnvironment).sort(), ["arch", "machineId", "node", "platform", "workspacePath"]);
    assert.equal(Object.hasOwn(state.remoteWorkspaces[0], "node"), false);
    assert.equal(Object.hasOwn(state.remoteWorkspaces[0], "platform"), false);
    const remoteText = JSON.stringify(state);
    assert.equal(remoteText.includes("SHOULD_NOT_LEAK_CREDENTIAL_REF"), false);
    assert.equal(remoteText.includes("/should-not-leak-other-root"), false);
    assert.equal(remoteText.includes("v0.0.1-other-machine"), false);
    assert.equal(remoteText.includes("OTHER_MACHINE_SECRET_REF"), false);
    assert.equal(remoteText.includes("freebsd"), false);

    const orchestrator = f.control.listAgents(f.mission.id).find(item => item.kind === "orchestrator");
    assert.equal(orchestrator.machineId, "local");
    const local = await f.control.workerCommand({
      agentId: orchestrator.id, epoch: orchestrator.epoch, method: "GetMissionState", args: {},
      taskId: `${orchestrator.id}:local-state`
    });
    assert.equal(Object.hasOwn(local, "executionEnvironment"), false);
    const localText = JSON.stringify(local);
    assert.equal(localText.includes("v22.19.0-isolated"), false);
    assert.equal(localText.includes("SHOULD_NOT_LEAK_CREDENTIAL_REF"), false);
    assert.equal(localText.includes("v0.0.1-other-machine"), false);
    assert.equal(Array.isArray(local.tasks), true);
    assert.equal(local.mission.id, f.mission.id);

    stored.leaseExpiresAt = Date.now() - 1;
    f.control.db.prepare("UPDATE remote_machines SET data=? WHERE id=?").run(JSON.stringify(stored), stored.id);
    const stale = await f.control.workerCommand(request(f.agent, "GetMissionState", {}, "stale-execution-environment"));
    assert.equal(Object.hasOwn(stale, "executionEnvironment"), false);
    assert.equal(JSON.stringify(stale).includes("v22.19.0-isolated"), false);
    assert.equal(f.control.machineRegistry.get(f.agent.machineId).capabilities.node, "v22.19.0-isolated");
    assert.equal(Array.isArray(stale.tasks), true);
  }
});

function stopReport(f, outcome = "stopped", stopReason = "requested") {
  return f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, {
    reportId: crypto.randomUUID(), binding: f.assignment.binding, descriptorHash: f.assignment.descriptorHash, outcome, ...(stopReason === "missing" ? {} : { stopReason })
  });
}

function controlledStop(f) {
  f.control.missionAction(f.mission.id, "pause");
  f.control.requestRemoteRuntimeStop(f.agent.id);
  f.control.markAgentInterrupted(f.agent.id, f.agent.epoch);
  f.control.fenceStaleWorkerBindings();
  assert.equal(f.control.blockers(f.mission.id).some(item => item.id === `remote-runtime:${f.assignment.binding.runtimeId}`), false);
  stopReport(f);
}

function explicitResume(f) {
  for (const blocker of f.control.blockers(f.mission.id).filter(item => item.status === "open")) {
    f.control.resolveBlocker(blocker.id, "Inspect evidence; test that resolution alone never restores uncertain ownership.");
  }
  f.control.missionAction(f.mission.id, "resume");
}

function assertNoReassignment(f, reason) {
  const before = {
    runtime: f.control.remoteRuntimeForAgent(f.agent.id), agent: f.control.getAgentPublic(f.agent.id),
    messages: f.control.detail(f.mission.id).messages,
    outbox: f.control.db.prepare("SELECT * FROM outbox WHERE mission_id=? ORDER BY id").all(f.mission.id),
    mailbox: f.control.workerMailbox.inspectOutbox(f.assignment.binding)
  };
  assert.throws(() => f.control.assignRemoteRuntime(f.agent.id), error => error.status === 409 && reason.test(error.message));
  assert.deepEqual(f.control.remoteRuntimeForAgent(f.agent.id), before.runtime);
  assert.deepEqual(f.control.getAgentPublic(f.agent.id), before.agent);
  assert.deepEqual(f.control.detail(f.mission.id).messages, before.messages);
  assert.deepEqual(f.control.db.prepare("SELECT * FROM outbox WHERE mission_id=? ORDER BY id").all(f.mission.id), before.outbox);
  assert.deepEqual(f.control.workerMailbox.inspectOutbox(f.assignment.binding), before.mailbox);
  assert.equal(f.control.db.prepare("SELECT COUNT(*) AS n FROM remote_worker_runtimes WHERE agent_id=?").get(f.agent.id).n, 1);
}

async function resumeBeforeStopReport(f, workers) {
  const orchestrator = f.control.listAgents(f.mission.id).find(agent => agent.kind === "orchestrator");
  const question = await f.control.workerCommand(request(orchestrator, "RequestUserInput", { question: "Continue?" }, "pending-stop-question"));
  await workers.syncMissionLifecycle(f.mission.id);
  f.control.resolveBlocker(question.id, "Continue with a new runtime.");
  assert.equal(f.control.missionById(f.mission.id).status, "active");
  await workers.startAgent(f.control.getAgentPublic(f.agent.id));
}

const waitForStopResult = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for stop confirmation result");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test("invalid remote stop deadlines are rejected before creating server state", async t => {
  const f = fixture(t);
  for (const timeout of [0, -1, 0.5, NaN, Infinity, 2147483648]) {
    assert.throws(() => new WorkerManager(f.control, false, false, timeout), /Remote runtime stop timeout/);
    const serverHome = join(f.home, "invalid-timeout-server");
    await assert.rejects(() => startServer({ home: serverHome, port: 0, remoteRuntimeStopTimeoutMs: timeout }), /Remote runtime stop timeout/);
    assert.equal(existsSync(serverHome), false);
  }
});

test("early recovery waits once for the controlled report and assigns without another resume", async t => {
  const f = fixture(t), workers = new WorkerManager(f.control, false, false, 5000);
  try {
    await resumeBeforeStopReport(f, workers);
    const epoch = f.control.getAgentPublic(f.agent.id).epoch;
    for (let count = 0; count < 3; count++) await workers.startAgent(f.control.getAgentPublic(f.agent.id));
    assert.equal(f.control.missionById(f.mission.id).status, "active");
    assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).state, "stopping");
    assert.equal(f.control.getAgentPublic(f.agent.id).epoch, epoch);
    assert.equal(f.control.workerMailbox.inspectBinding(f.assignment.binding).status, "uncertain");
    assert.equal(f.control.detail(f.mission.id).events.some(event => event.type === "worker_start_failed"), false);
    const pending = f.control.detail(f.mission.id).events.filter(event => event.type === "remote_runtime_stop_pending");
    assert.equal(pending.length, 1);
    assert.deepEqual(pending[0].data, { runtimeId: f.assignment.binding.runtimeId, timeoutMs: 5000 });
    await workers.remoteRuntimeReported(f.agent.id, crypto.randomUUID());
    assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).state, "stopping");
    stopReport(f);
    await Promise.all([workers.remoteRuntimeReported(f.agent.id, f.assignment.binding.runtimeId),
      workers.remoteRuntimeReported(f.agent.id, f.assignment.binding.runtimeId)]);
    const replacement = f.control.remoteRuntimeForAgent(f.agent.id);
    assert.notEqual(replacement.runtime_id, f.assignment.binding.runtimeId);
    assert.equal(replacement.epoch, epoch + 1);
    assert.equal(f.control.missionById(f.mission.id).status, "active");
    assert.equal(f.control.db.prepare("SELECT COUNT(*) AS n FROM remote_worker_runtimes WHERE agent_id=?").get(f.agent.id).n, 2);
    assert.equal(f.control.workerMailbox.inspectBinding(f.assignment.binding).status, "closed");
  } finally { await workers.close(); }
});

test("missing controlled stop report fails at its original deadline with an accurate diagnostic", async t => {
  const f = fixture(t), workers = new WorkerManager(f.control, false, false, 100);
  try {
    await resumeBeforeStopReport(f, workers);
    for (let count = 0; count < 3; count++) await workers.startAgent(f.control.getAgentPublic(f.agent.id));
    await waitForStopResult(() => f.control.missionById(f.mission.id).status === "failed");
    const failures = f.control.detail(f.mission.id).events.filter(event => event.type === "worker_start_failed");
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].data, {
      diagnostic: `Prior remote runtime ${f.assignment.binding.runtimeId} did not confirm its stop within 0.1 seconds`,
      recoverable: true, reason: "remote_runtime_stop_timeout"
    });
    assert.equal(failures[0].data.diagnostic.includes("trusted reconciliation"), false);
    stopReport(f);
    await workers.remoteRuntimeReported(f.agent.id, f.assignment.binding.runtimeId);
    assert.equal(f.control.missionById(f.mission.id).status, "failed");
    assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).runtime_id, f.assignment.binding.runtimeId);
    explicitResume(f);
    await workers.startAgent(f.control.getAgentPublic(f.agent.id));
    assert.equal(f.control.missionById(f.mission.id).status, "active");
    assert.notEqual(f.control.remoteRuntimeForAgent(f.agent.id).runtime_id, f.assignment.binding.runtimeId);
  } finally { await workers.close(); }
});

for (const ending of ["unexpected", "uncertain", "unproven", "rejected"]) {
  test(`pending controlled stop rejects a later ${ending} report permanently`, async t => {
    const f = fixture(t), workers = new WorkerManager(f.control, false, false, 5000);
    try {
      await resumeBeforeStopReport(f, workers);
      stopReport(f, ["uncertain", "rejected"].includes(ending) ? ending : "stopped", ending === "unexpected" ? "unexpected" : ending === "unproven" ? "missing" : "requested");
      await workers.remoteRuntimeReported(f.agent.id, f.assignment.binding.runtimeId);
      assert.equal(f.control.missionById(f.mission.id).status, "failed");
      const data = f.control.detail(f.mission.id).events.find(event => event.type === "worker_start_failed").data;
      const diagnostic = data.diagnostic;
      assert.deepEqual(data, {
        diagnostic, recoverable: false,
        reason: ending === "unexpected" ? "remote_runtime_unexpected_stop" : `remote_runtime_${ending}`
      });
      assert.match(diagnostic, ending === "unproven" ? /controlled stop cannot be proven/ : new RegExp(ending === "rejected" ? "uncertain" : ending));
      assert.match(diagnostic, /trusted reconciliation is required/);
      assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).runtime_id, f.assignment.binding.runtimeId);
      assert.equal(f.control.db.prepare("SELECT COUNT(*) AS n FROM remote_worker_runtimes WHERE agent_id=?").get(f.agent.id).n, 1);
    } finally { await workers.close(); }
  });
}

for (const ending of ["unexpected", "uncertain", "unproven", "rejected"]) {
  test(`startup after ${ending} stop records an irrecoverable reason without replacement or replay`, async t => {
    const f = fixture(t), workers = new WorkerManager(f.control);
    try {
      f.control.missionAction(f.mission.id, "pause");
      await workers.pauseMission(f.mission.id);
      stopReport(f, ["uncertain", "rejected"].includes(ending) ? ending : "stopped",
        ending === "unexpected" ? "unexpected" : ending === "unproven" ? "missing" : "requested");
      explicitResume(f);
      const before = {
        messages: f.control.detail(f.mission.id).messages,
        outbox: f.control.db.prepare("SELECT * FROM outbox WHERE mission_id=? ORDER BY id").all(f.mission.id)
      };
      const reason = ending === "unexpected" ? "remote_runtime_unexpected_stop" : `remote_runtime_${ending}`;
      await assert.rejects(() => workers.startAgent(f.control.getAgentPublic(f.agent.id)), error => {
        assert.ok(error instanceof RemoteRuntimeRecoveryError);
        assert.equal(error.status, 409);
        assert.equal(error.reason, reason);
        return true;
      });
      const failures = f.control.detail(f.mission.id).events.filter(event => event.type === "worker_start_failed");
      assert.equal(failures.length, 1);
      assert.deepEqual(failures[0].data, { diagnostic: failures[0].data.diagnostic, recoverable: false, reason });
      assert.match(failures[0].data.diagnostic, /trusted reconciliation is required/);
      assert.equal(f.control.missionById(f.mission.id).status, "failed");
      assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).runtime_id, f.assignment.binding.runtimeId);
      assert.equal(f.control.db.prepare("SELECT COUNT(*) AS n FROM remote_worker_runtimes WHERE agent_id=?").get(f.agent.id).n, 1);
      const remoteMessages = new Set(before.messages.filter(item => item.recipientId === f.agent.id).map(item => item.id));
      assert.deepEqual(f.control.detail(f.mission.id).messages, before.messages.map(item => remoteMessages.has(item.id)
        ? { ...item, status: "aborted", error: "Delivery aborted before worker admission" } : item));
      assert.deepEqual(f.control.db.prepare("SELECT * FROM outbox WHERE mission_id=? ORDER BY id").all(f.mission.id).map(item => ({ ...item })),
        before.outbox.map(item => ({ ...item, status: remoteMessages.has(item.message_id) && item.status === "queued" ? "aborted" : item.status })));
    } finally { await workers.close(); }
  });
}

test("ordinary startup failure retains diagnostic-only event data", async t => {
  const f = fixture(t), workers = new WorkerManager(f.control);
  try {
    f.control.db.prepare("DELETE FROM profiles WHERE id=?").run(f.profile.id);
    await assert.rejects(() => workers.startAgent(f.control.getAgentPublic(f.agent.id)));
    const failures = f.control.detail(f.mission.id).events.filter(event => event.type === "worker_start_failed");
    assert.equal(failures.length, 1);
    assert.deepEqual(Object.keys(failures[0].data), ["diagnostic"]);
    assert.equal(typeof failures[0].data.diagnostic, "string");
  } finally { await workers.close(); }
});

for (const unsafe of ["mailbox", "delivery", "effect", "approval", "blocker", "ownership"]) {
  test(`pending stop with unresolved ${unsafe} fails immediately instead of waiting`, async t => {
    const f = fixture(t, "workspace-effects", unsafe === "approval" ? "approve" : "trusted", { effectApprovals: true });
    const workers = new WorkerManager(f.control, false, false, 5000);
    try {
      if (unsafe === "effect" || unsafe === "approval") {
        await f.control.workerCommand({ ...request(f.agent, "write_file", { path: "pending.txt", content: "unsafe" }), id: "pending-stop-rpc" });
      }
      if (unsafe === "mailbox") {
        f.control.workerMailbox.enqueue(f.assignment.binding, { kind: "reply", rpcId: crypto.randomUUID(), ok: true, result: {} });
        f.control.workerMailbox.pending(f.assignment.binding);
      }
      f.control.missionAction(f.mission.id, "pause");
      await workers.pauseMission(f.mission.id);
      explicitResume(f);
      if (unsafe === "delivery") {
        const message = f.control.sendMessage(f.mission.id, f.agent.id, "Pending delivery", "followUp", "pending-stop-delivery");
        f.control.db.prepare("UPDATE messages SET status='uncertain' WHERE id=?").run(message.id);
      } else if (unsafe === "blocker") {
        const blocker = { id: "pending-stop-safety", missionId: f.mission.id, kind: "unsafe_execution", status: "open", text: "Inspect", createdAt: new Date().toISOString() };
        f.control.db.prepare("INSERT INTO blockers VALUES(?,?,?,?)").run(blocker.id, f.mission.id, "open", JSON.stringify(blocker));
      } else if (unsafe === "ownership") {
        f.control.db.prepare("UPDATE remote_worker_runtimes SET stop_request_reason='ownership-lost' WHERE runtime_id=?").run(f.assignment.binding.runtimeId);
      }
      await assert.rejects(() => workers.startAgent(f.control.getAgentPublic(f.agent.id)), error => {
        assert.equal(error instanceof RemoteRuntimeStopPendingError, false);
        assert.match(error.message, /trusted reconciliation is required/);
        return true;
      });
      assert.equal(f.control.missionById(f.mission.id).status, "failed");
      assert.equal(f.control.detail(f.mission.id).events.some(event => event.type === "remote_runtime_stop_pending"), false);
    } finally { await workers.close(); }
  });
}

test("worker manager recovery re-arms pending controlled stops without needing queued delivery", async t => {
  const f = fixture(t), first = new WorkerManager(f.control, false, false, 5000);
  await resumeBeforeStopReport(f, first);
  await first.close();
  const workers = new WorkerManager(f.control, false, false, 5000);
  const startAgent = workers.startAgent.bind(workers);
  workers.startAgent = agent => agent.machineId === "local" ? Promise.resolve() : startAgent(agent);
  try {
    await workers.recoverActiveMissions();
    assert.equal(f.control.missionById(f.mission.id).status, "active");
    stopReport(f);
    await workers.remoteRuntimeReported(f.agent.id, f.assignment.binding.runtimeId);
    assert.notEqual(f.control.remoteRuntimeForAgent(f.agent.id).runtime_id, f.assignment.binding.runtimeId);
  } finally { await workers.close(); }
});

test("pausing again cancels the pending stop deadline", async t => {
  const f = fixture(t), workers = new WorkerManager(f.control, false, false, 50);
  try {
    await resumeBeforeStopReport(f, workers);
    f.control.missionAction(f.mission.id, "pause");
    await workers.pauseMission(f.mission.id);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.control.missionById(f.mission.id).status, "paused");
    assert.equal(f.control.detail(f.mission.id).events.some(event => event.type === "worker_start_failed"), false);
  } finally { await workers.close(); }
});

test("clean controlled stop reassigns atomically with new owner and preserves runtime evidence", async t => {
  const f = fixture(t);
  await f.control.workerCommand(request(f.agent, "read_file", { path: "read.txt" }, "finished"));
  const spec = { binding: f.assignment.binding, descriptorHash: f.assignment.descriptorHash,
    taskId: `${f.agent.id}:finished`, method: "read_file", args: { path: "read.txt" } };
  f.control.nodeEffectReceipt(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch,
    nodeEffectUpload(spec, { status: "failed", result: { error: "File not found" } }));
  // Ownership epochs, rather than wall-clock order, identify the latest runtime.
  f.control.db.prepare("UPDATE remote_worker_runtimes SET created_at=? WHERE runtime_id=?")
    .run(Date.now() + 60000, f.assignment.binding.runtimeId);
  controlledStop(f);
  const old = f.control.remoteRuntimeForAgent(f.agent.id);
  assert.equal(old.stop_provenance, "controlled");
  explicitResume(f);
  const beforeEpoch = f.control.getAgentPublic(f.agent.id).epoch;
  const next = f.control.assignRemoteRuntime(f.agent.id);
  assert.notEqual(next.binding.runtimeId, old.runtime_id);
  assert.equal(next.binding.epoch, beforeEpoch + 1);
  assert.equal(next.binding.machineId, f.assignment.binding.machineId);
  assert.equal(f.control.workerMailbox.inspectBinding(f.assignment.binding).status, "closed");
  assert.equal(f.control.workerMailbox.inspectBinding(next.binding).status, "open");
  assert.deepEqual(f.control.remoteRuntimes.byRuntime(old.runtime_id), old);
  assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).runtime_id, next.binding.runtimeId);
  assert.deepEqual(f.control.detail(f.mission.id).events.find(event => event.type === "remote_runtime_reassigned").data,
    { previousRuntimeId: old.runtime_id, runtimeId: next.binding.runtimeId });
  assert.equal(f.control.assignRemoteRuntime(f.agent.id).binding.runtimeId, next.binding.runtimeId);
  assert.deepEqual(f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId,
    f.session.sessionEpoch, JSON.parse(old.last_report_json)), { recorded: true, duplicate: true });
  assert.deepEqual(f.control.remoteRuntimes.byRuntime(old.runtime_id), old);
});

for (const ending of ["unexpected", "uncertain", "unproven"]) {
  test(`${ending} stop remains fail-closed after explicit blocker resolution and later stopped reports`, t => {
    const f = fixture(t);
    if (ending === "unexpected") {
      stopReport(f, "stopped", "unexpected");
      f.control.requestRemoteRuntimeStop(f.agent.id);
      stopReport(f);
    } else if (ending === "uncertain") {
      f.control.missionAction(f.mission.id, "pause");
      f.control.requestRemoteRuntimeStop(f.agent.id);
      stopReport(f, "uncertain");
      stopReport(f);
    } else {
      controlledStop(f);
      f.control.db.prepare("UPDATE remote_worker_runtimes SET stop_provenance='unproven' WHERE runtime_id=?")
        .run(f.assignment.binding.runtimeId);
      stopReport(f);
    }
    explicitResume(f);
    assertNoReassignment(f, ending === "unproven" ? /cannot be proven/ : new RegExp(ending));
  });
}

for (const kind of ["deliver", "reply", "rpc"]) {
  test(`controlled stop refuses uncertain mailbox ${kind} without replay`, t => {
    const f = fixture(t), mailbox = f.control.workerMailbox, binding = f.assignment.binding;
    if (kind === "rpc") {
      mailbox.receive(binding, { binding, messageId: crypto.randomUUID(), sequence: 1,
        payload: { kind: "rpc", rpcId: crypto.randomUUID(), taskId: `${f.agent.id}:rpc`, method: "GetMissionState", args: {} } });
      mailbox.claim(binding, mailbox.inspectInbox(binding)[0].envelope.messageId);
    } else {
      const payload = kind === "reply" ? { kind: "reply", rpcId: crypto.randomUUID(), ok: true, result: {} }
        : { kind: "deliver", messageId: crypto.randomUUID(), requestId: "transport-delivery", attempt: 1, content: "input", mode: "followUp" };
      mailbox.enqueue(binding, payload);
      mailbox.pending(binding);
    }
    controlledStop(f);
    explicitResume(f);
    assertNoReassignment(f, /uncertain mailbox/);
  });
}

for (const state of ["dispatching", "admitted", "delivering", "delivered"]) {
  test(`human-reconciled interrupted ${state} input stays uncertain while a replacement runtime starts`, t => {
    const f = fixture(t);
    const message = f.control.detail(f.mission.id).messages.find(item => item.recipientId === f.agent.id);
    f.control.db.prepare("UPDATE messages SET status=?,data=? WHERE id=?").run(state,
      JSON.stringify({ ...message, status: state }), message.id);
    f.control.db.prepare("UPDATE outbox SET status='admitted' WHERE message_id=?").run(message.id);
    f.control.requestRemoteRuntimeStop(f.agent.id);
    f.control.markAgentInterrupted(f.agent.id, f.agent.epoch);
    assert.equal(f.control.message(message.id).status, "uncertain");
    stopReport(f);
    assert.throws(() => f.control.missionAction(f.mission.id, "resume"), /Resolve mission blockers/);
    const row = f.control.db.prepare("SELECT * FROM outbox WHERE message_id=?").get(message.id);
    assert.equal(f.control.blockers(f.mission.id).find(blocker => blocker.id === `delivery:${row.id}`).status, "open");
    explicitResume(f);
    const evidence = f.control.message(message.id);
    const oldOutbox = f.control.db.prepare("SELECT * FROM outbox WHERE message_id=?").all(message.id);
    const replacement = f.control.assignRemoteRuntime(f.agent.id);
    assert.notEqual(replacement.binding.runtimeId, f.assignment.binding.runtimeId);
    assert.deepEqual(f.control.message(message.id), evidence);
    assert.deepEqual(f.control.db.prepare("SELECT * FROM outbox WHERE message_id=?").all(message.id), oldOutbox);
    assert.equal(f.control.workerMailbox.inspectOutbox(replacement.binding).length, 0);
    assert.equal(f.control.message(message.id).status, "uncertain");
    assert.equal(f.control.message(message.id).attempt, message.attempt);
    assert.equal(f.control.pendingOutbox().some(row => row.message_id === message.id), false);
  });
}

for (const state of ["dispatching", "admitted", "delivering", "delivered"]) {
  for (const side of ["message", "outbox"]) {
    test(`human delivery resolution does not admit a still-${state} ${side}`, t => {
      const f = fixture(t);
      const message = f.control.detail(f.mission.id).messages.find(item => item.recipientId === f.agent.id);
      f.control.db.prepare("UPDATE outbox SET status='admitted' WHERE message_id=?").run(message.id);
      controlledStop(f);
      explicitResume(f);
      if (side === "message") {
        f.control.db.prepare("UPDATE messages SET status=?,data=? WHERE id=?").run(state, JSON.stringify({ ...f.control.message(message.id), status: state }), message.id);
      } else {
        f.control.db.prepare("UPDATE outbox SET status=? WHERE message_id=?").run(state, message.id);
      }
      assertNoReassignment(f, /uncertain or partially executed durable delivery/);
    });
  }
}

for (const evidence of ["missing-blocker", "wrong-mission", "missing-outbox", "second-unresolved-outbox"]) {
  test(`uncertain delivery refuses ${evidence} reconciliation evidence`, t => {
    const f = fixture(t);
    const message = f.control.detail(f.mission.id).messages.find(item => item.recipientId === f.agent.id);
    f.control.db.prepare("UPDATE outbox SET status='admitted' WHERE message_id=?").run(message.id);
    controlledStop(f);
    explicitResume(f);
    const row = f.control.db.prepare("SELECT * FROM outbox WHERE message_id=?").get(message.id);
    if (evidence === "missing-blocker") {
      f.control.db.prepare("DELETE FROM blockers WHERE id=?").run(`delivery:${row.id}`);
    } else if (evidence === "wrong-mission") {
      f.control.db.prepare("UPDATE blockers SET mission_id='another-mission' WHERE id=?").run(`delivery:${row.id}`);
    } else if (evidence === "missing-outbox") {
      f.control.db.prepare("DELETE FROM outbox WHERE id=?").run(row.id);
    } else {
      f.control.db.prepare(`INSERT INTO outbox(id,mission_id,message_id,request_id,status,attempt,epoch,created_at)
        VALUES(?,?,?,?,'uncertain',2,?,?)`).run(crypto.randomUUID(), f.mission.id, message.id, "second-attempt", f.agent.epoch, new Date().toISOString());
    }
    assertNoReassignment(f, /uncertain or partially executed durable delivery/);
  });
}

for (const outcome of ["missing", "uncertain"]) {
  test(`controlled stop refuses workspace effect with ${outcome} terminal evidence`, async t => {
    const f = fixture(t);
    await f.control.workerCommand(request(f.agent, "write_file", { path: "pending.txt", content: "effect" }));
    if (outcome === "uncertain") {
      const spec = { binding: f.assignment.binding, descriptorHash: f.assignment.descriptorHash,
        taskId: `${f.agent.id}:effect`, method: "write_file", args: { path: "pending.txt", content: "effect" } };
      f.control.nodeEffectReceipt(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch,
        nodeEffectUpload(spec, { status: "uncertain", error: "Partial write" }));
    }
    controlledStop(f);
    explicitResume(f);
    assertNoReassignment(f, outcome === "missing" ? /has no terminal receipt/ : /has an uncertain receipt/);
  });
}

for (const status of ["pending", "approved"]) {
  test(`controlled stop refuses ${status} effect approval tied to old binding`, async t => {
    const f = fixture(t, "workspace-effects", "approve", { effectApprovals: true });
    const result = await f.control.workerCommand({ ...request(f.agent, "write_file", { path: "old.txt", content: "old" }), id: "old-rpc" });
    if (status === "approved") f.control.resolveApproval(result.approvalId, "approved");
    controlledStop(f);
    explicitResume(f);
    assertNoReassignment(f, /old-binding effect approval/);
    assert.equal(existsSync(join(f.remotePath, "old.txt")), false);
  });
}

test("unresolved safety blocker prevents replacement and worker startup still fails without automatic retries", async t => {
  const f = fixture(t);
  controlledStop(f);
  explicitResume(f);
  const blocker = { id: `remote-runtime:${f.assignment.binding.runtimeId}`, missionId: f.mission.id,
    kind: "unsafe_execution", status: "open", text: "Inspect the stopped runtime", createdAt: new Date().toISOString() };
  f.control.db.prepare("INSERT INTO blockers VALUES(?,?,?,?)").run(blocker.id, f.mission.id, "open", JSON.stringify(blocker));
  assertNoReassignment(f, /unresolved blocker/);
  const workers = new WorkerManager(f.control);
  await assert.rejects(() => workers.startAgent(f.control.getAgentPublic(f.agent.id)), /unresolved blocker/);
  assert.equal(f.control.missionById(f.mission.id).status, "failed");
  assert.equal(f.control.detail(f.mission.id).events.filter(event => event.type === "worker_start_failed").length, 1);
  assert.deepEqual(Object.keys(f.control.detail(f.mission.id).events.find(event => event.type === "worker_start_failed").data), ["diagnostic"]);
  await workers.startAgent(f.control.getAgentPublic(f.agent.id));
  assert.equal(f.control.detail(f.mission.id).events.filter(event => event.type === "worker_start_failed").length, 1);
});

for (const loss of ["lease", "session"]) {
  test(`requested stop still gains reconciliation blocker after node ${loss} loss`, t => {
    const f = fixture(t);
    f.control.requestRemoteRuntimeStop(f.agent.id);
    f.control.markAgentInterrupted(f.agent.id, f.agent.epoch);
    const machine = f.control.machineRegistry.get(f.enrolled.machine.id);
    f.control.db.prepare("UPDATE remote_machines SET data=? WHERE id=?").run(JSON.stringify({ ...machine,
      ...(loss === "lease" ? { leaseExpiresAt: Date.now() - 1 } : { sessionId: crypto.randomUUID() })
    }), machine.id);
    f.control.fenceStaleWorkerBindings();
    assert.ok(f.control.blockers(f.mission.id).some(item => item.id === `remote-runtime:${f.assignment.binding.runtimeId}` && item.status === "open"));
  });
}

test("failed replacement assignment rolls back mailbox closure and owner claim", t => {
  const f = fixture(t);
  controlledStop(f);
  explicitResume(f);
  const epoch = f.control.getAgentPublic(f.agent.id).epoch;
  f.control.db.exec("CREATE TRIGGER fail_reassignment BEFORE INSERT ON remote_worker_runtimes BEGIN SELECT RAISE(ABORT,'injected assignment failure'); END");
  assert.throws(() => f.control.assignRemoteRuntime(f.agent.id), /injected assignment failure/);
  assert.equal(f.control.workerMailbox.inspectBinding(f.assignment.binding).status, "uncertain");
  assert.equal(f.control.getAgentPublic(f.agent.id).epoch, epoch);
  assert.equal(f.control.db.prepare("SELECT COUNT(*) AS n FROM remote_worker_runtimes WHERE agent_id=?").get(f.agent.id).n, 1);
  assert.equal(f.control.detail(f.mission.id).events.some(event => event.type === "remote_runtime_reassigned"), false);
});


test("delayed unexpected stop cannot become controlled after pause and later requested reports", t => {
  const f = fixture(t);
  const delayed = { reportId: crypto.randomUUID(), binding: f.assignment.binding,
    descriptorHash: f.assignment.descriptorHash, outcome: "stopped", stopReason: "unexpected" };
  f.control.missionAction(f.mission.id, "pause");
  f.control.requestRemoteRuntimeStop(f.agent.id);
  f.control.markAgentInterrupted(f.agent.id, f.agent.epoch);
  f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, delayed);
  assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_provenance, "unexpected");
  assert.ok(f.control.blockers(f.mission.id).some(b => b.id === `remote-runtime:${f.assignment.binding.runtimeId}`));
  stopReport(f);
  explicitResume(f);
  assertNoReassignment(f, /unexpected stop/);
});

test("ownership loss survives lease expiry, new session, old requested stop report, and blocker resolution", t => {
  const f = fixture(t);
  f.control.missionAction(f.mission.id, "pause");
  f.control.requestRemoteRuntimeStop(f.agent.id);
  f.control.markAgentInterrupted(f.agent.id, f.agent.epoch);
  f.control.db.prepare("UPDATE remote_machines SET data=json_set(data,'$.leaseExpiresAt',?) WHERE id=?")
    .run(Date.now() - 1, f.enrolled.machine.id);
  const capabilities = f.control.machineRegistry.get(f.enrolled.machine.id).capabilities;
  const newSession = f.control.nodeSession(f.enrolled.machine.id, f.enrolled.token, capabilities, crypto.randomUUID());
  assert.notEqual(newSession.sessionId, f.session.sessionId);
  f.session = newSession;
  stopReport(f);
  const row = f.control.remoteRuntimeForAgent(f.agent.id);
  assert.equal(row.state, "closed");
  assert.equal(row.stop_provenance, "uncertain");
  assert.equal(row.stop_request_reason, "ownership-lost");
  assert.equal(f.control.remoteRuntimeSnapshots(f.mission.id)[0].stopRequestReason, "ownership-lost");
  explicitResume(f);
  f.control.requestRemoteRuntimeStop(f.agent.id);
  stopReport(f);
  assertNoReassignment(f, /uncertain/);
  assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_request_reason, "ownership-lost");
});

for (const change of ["before-request", "after-controlled-fence", "after-request-owner-claim", "legacy-request"]) {
  test(`unrelated epoch increase ${change} cannot use controlled stop relaxation`, t => {
    const f = fixture(t);
    if (change === "before-request") {
      f.control.markAgentInterrupted(f.agent.id, f.agent.epoch);
      f.control.requestRemoteRuntimeStop(f.agent.id);
    } else if (change === "after-controlled-fence") {
      f.control.requestRemoteRuntimeStop(f.agent.id);
      f.control.markAgentInterrupted(f.agent.id, f.agent.epoch);
      f.control.markAgentInterrupted(f.agent.id, f.agent.epoch + 1);
    } else if (change === "after-request-owner-claim") {
      f.control.requestRemoteRuntimeStop(f.agent.id);
      f.control.claimAgentOwner(f.agent.id);
    } else {
      f.control.db.prepare("UPDATE remote_worker_runtimes SET desired='stop',state='stopping' WHERE runtime_id=?")
        .run(f.assignment.binding.runtimeId);
      f.control.markAgentInterrupted(f.agent.id, f.agent.epoch);
    }
    // Even if the report arrives before the periodic fence sweep, it must not
    // close the runtime with apparently controlled evidence.
    stopReport(f);
    f.control.fenceStaleWorkerBindings();
    assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_provenance, "uncertain");
    assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_request_reason, "ownership-lost");
    assert.ok(f.control.blockers(f.mission.id).some(b => b.id === `remote-runtime:${f.assignment.binding.runtimeId}`));
    stopReport(f);
    explicitResume(f);
    assertNoReassignment(f, /uncertain/);
  });
}

test("legacy stopped report without node reason cannot prove a controlled stop", t => {
  const f = fixture(t);
  f.control.missionAction(f.mission.id, "pause");
  f.control.requestRemoteRuntimeStop(f.agent.id);
  const report = { reportId: crypto.randomUUID(), binding: f.assignment.binding,
    descriptorHash: f.assignment.descriptorHash, outcome: "stopped" };
  f.control.nodeRuntimeReport(f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, report);
  assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_provenance, "unproven");
  stopReport(f);
  explicitResume(f);
  assertNoReassignment(f, /cannot be proven/);
});


test("unexpected node reason remains unexpected when physical extinction is unconfirmed", t => {
  const f = fixture(t);
  f.control.missionAction(f.mission.id, "pause");
  f.control.requestRemoteRuntimeStop(f.agent.id);
  stopReport(f, "uncertain", "unexpected");
  assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).state, "uncertain");
  assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_provenance, "unexpected");
  stopReport(f);
  explicitResume(f);
  assertNoReassignment(f, /unexpected stop/);
});


test("repeated blocked lifecycle sync preserves controlled stop and permits recovery", async t => {
  const f = fixture(t, "metadata-only");
  const workers = new WorkerManager(f.control);
  const orchestrator = f.control.listAgents(f.mission.id).find(agent => agent.kind === "orchestrator");
  const question = await f.control.workerCommand(request(orchestrator, "RequestUserInput", { question: "Continue?" }, "repeat-sync-question"));
  assert.equal(f.control.missionById(f.mission.id).status, "blocked");
  await workers.syncMissionLifecycle(f.mission.id);
  const firstEpoch = f.control.getAgentPublic(f.agent.id).epoch;
  assert.equal(firstEpoch, f.assignment.binding.epoch + 1);
  const lateMessage = f.control.sendMessage(f.mission.id, f.agent.id, "Input queued between syncs.", "followUp", "repeat-sync-input");
  await workers.syncMissionLifecycle(f.mission.id);
  const secondEpoch = f.control.getAgentPublic(f.agent.id).epoch;
  stopReport(f);
  const stopped = f.control.remoteRuntimeForAgent(f.agent.id);
  assert.equal(stopped.stop_provenance, "controlled", `epochs ${f.assignment.binding.epoch} -> ${firstEpoch} -> ${secondEpoch}`);
  assert.equal(secondEpoch, firstEpoch);
  assert.equal(stopped.stop_request_reason, "controlled");
  assert.equal(f.control.blockers(f.mission.id).some(b => b.id === `remote-runtime:${f.assignment.binding.runtimeId}`), false);
  assert.equal(f.control.message(lateMessage.id).status, "aborted");
  assert.equal(f.control.db.prepare("SELECT status FROM outbox WHERE message_id=?").get(lateMessage.id).status, "aborted");
  f.control.resolveBlocker(question.id, "Continue with a new runtime.");
  assert.equal(f.control.missionById(f.mission.id).status, "active");
  await workers.startAgent(f.control.getAgentPublic(f.agent.id));
  const replacement = f.control.remoteRuntimeForAgent(f.agent.id);
  assert.notEqual(replacement.runtime_id, stopped.runtime_id);
  assert.equal(replacement.state, "queued");
  assert.equal(f.control.missionById(f.mission.id).status, "active");
  assert.deepEqual(f.control.remoteRuntimes.byRuntime(stopped.runtime_id), stopped);
});


for (const action of ["refreshProfile", "refreshRole", "interruptAgent"]) {
  test(`repeated controlled ${action} preserves the fenced epoch and permits recovery`, async t => {
    const f = fixture(t, "metadata-only");
    const workers = new WorkerManager(f.control);
    const orchestrator = f.control.listAgents(f.mission.id).find(agent => agent.kind === "orchestrator");
    const question = await f.control.workerCommand(request(orchestrator, "RequestUserInput", { question: "Continue?" }, `repeat-${action}-question`));
    const invoke = () => action === "refreshProfile" ? workers.refreshProfile(f.profile.id)
      : action === "refreshRole" ? workers.refreshRole(f.roleIds[1]) : workers.interruptAgent(f.agent.id);
    await invoke();
    const fencedEpoch = f.control.getAgentPublic(f.agent.id).epoch;
    assert.equal(fencedEpoch, f.assignment.binding.epoch + 1);
    const lateMessage = f.control.sendMessage(f.mission.id, f.agent.id, "New input during shutdown.", "followUp", `repeat-${action}-input`);
    await invoke();
    assert.equal(f.control.message(lateMessage.id).status, "aborted");
    assert.equal(f.control.getAgentPublic(f.agent.id).epoch, fencedEpoch);
    stopReport(f);
    assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_provenance, "controlled");
    await invoke();
    assert.equal(f.control.getAgentPublic(f.agent.id).epoch, fencedEpoch);
    assert.equal(f.control.blockers(f.mission.id).some(b => b.id === `remote-runtime:${f.assignment.binding.runtimeId}`), false);
    f.control.resolveBlocker(question.id, "Continue.");
    assert.equal(f.control.missionById(f.mission.id).status, "active");
    await workers.startAgent(f.control.getAgentPublic(f.agent.id));
    assert.notEqual(f.control.remoteRuntimeForAgent(f.agent.id).runtime_id, f.assignment.binding.runtimeId);
    assert.equal(f.control.missionById(f.mission.id).status, "active");
  });
}

test("repeated controlled lifecycle sync still fences newly admitted delivery as uncertain", async t => {
  const f = fixture(t, "metadata-only");
  const workers = new WorkerManager(f.control);
  const orchestrator = f.control.listAgents(f.mission.id).find(agent => agent.kind === "orchestrator");
  await f.control.workerCommand(request(orchestrator, "RequestUserInput", { question: "Continue?" }, "repeat-sync-admitted-question"));
  await workers.syncMissionLifecycle(f.mission.id);
  const fencedEpoch = f.control.getAgentPublic(f.agent.id).epoch;
  const input = f.control.sendMessage(f.mission.id, f.agent.id, "Delivery admission arrived late.", "followUp", "repeat-sync-admitted-input");
  f.control.db.prepare("UPDATE messages SET status='admitted',data=? WHERE id=?")
    .run(JSON.stringify({ ...input, status: "admitted" }), input.id);
  f.control.db.prepare("UPDATE outbox SET status='admitted' WHERE message_id=?").run(input.id);
  const outbox = f.control.db.prepare("SELECT id FROM outbox WHERE message_id=?").get(input.id);
  await workers.syncMissionLifecycle(f.mission.id);
  assert.equal(f.control.getAgentPublic(f.agent.id).epoch, fencedEpoch);
  assert.equal(f.control.message(input.id).status, "uncertain");
  assert.equal(f.control.db.prepare("SELECT status FROM outbox WHERE id=?").get(outbox.id).status, "uncertain");
  assert.ok(f.control.blockers(f.mission.id).some(b => b.id === `delivery:${outbox.id}` && b.status === "open"));
  stopReport(f);
  assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_provenance, "controlled");
  assert.equal(f.control.blockers(f.mission.id).some(b => b.id === `remote-runtime:${f.assignment.binding.runtimeId}`), false);
  explicitResume(f);
  const evidence = f.control.message(input.id);
  await workers.startAgent(f.control.getAgentPublic(f.agent.id));
  assert.notEqual(f.control.remoteRuntimeForAgent(f.agent.id).runtime_id, f.assignment.binding.runtimeId);
  assert.deepEqual(f.control.message(input.id), evidence);
  assert.equal(f.control.db.prepare("SELECT status FROM outbox WHERE id=?").get(outbox.id).status, "uncertain");
  assert.equal(f.control.pendingOutbox().some(row => row.message_id === input.id), false);
});

test("unrelated interruption between controlled lifecycle syncs remains ownership loss", async t => {
  const f = fixture(t, "metadata-only");
  const workers = new WorkerManager(f.control);
  const orchestrator = f.control.listAgents(f.mission.id).find(agent => agent.kind === "orchestrator");
  await f.control.workerCommand(request(orchestrator, "RequestUserInput", { question: "Continue?" }, "repeat-sync-owner-question"));
  await workers.syncMissionLifecycle(f.mission.id);
  f.control.markAgentInterrupted(f.agent.id, f.control.getAgentPublic(f.agent.id).epoch);
  await workers.syncMissionLifecycle(f.mission.id);
  stopReport(f);
  assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_provenance, "uncertain");
  assert.equal(f.control.remoteRuntimeForAgent(f.agent.id).stop_request_reason, "ownership-lost");
  explicitResume(f);
  assertNoReassignment(f, /uncertain/);
});


test("manual pause exposes interrupted delivery reconciliation before remote reassignment", t => {
  const f = fixture(t);
  const message = f.control.detail(f.mission.id).messages.find(item => item.recipientId === f.agent.id);
  const outbox = f.control.pendingOutbox().find(row => row.message_id === message.id);
  assert.equal(f.control.markOutboxDispatching(outbox.id, f.agent.epoch), true);
  assert.equal(f.control.ackOutbox(message.id, outbox.request_id, outbox.attempt, f.agent.epoch, "admitted"), true);
  f.control.missionAction(f.mission.id, "pause");
  f.control.requestRemoteRuntimeStop(f.agent.id);
  f.control.markAgentInterrupted(f.agent.id, f.agent.epoch, { controlledRemoteStop: true });
  stopReport(f);
  const blocker = f.control.blockers(f.mission.id).find(item => item.id === `delivery:${outbox.id}`);
  assert.ok(blocker, "Manual pause must expose a resolvable delivery blocker");
  assert.equal(blocker.status, "open");
  assert.throws(() => f.control.missionAction(f.mission.id, "resume"), /Resolve mission blockers/);
  f.control.resolveBlocker(blocker.id, "Reviewed the interrupted input; do not replay it.");
  f.control.missionAction(f.mission.id, "resume");
  const before = f.control.message(message.id);
  const oldOutbox = f.control.db.prepare("SELECT * FROM outbox WHERE id=?").get(outbox.id);
  const replacement = f.control.assignRemoteRuntime(f.agent.id);
  assert.notEqual(replacement.binding.runtimeId, f.assignment.binding.runtimeId);
  assert.ok(replacement.binding.epoch > f.assignment.binding.epoch);
  assert.equal(before.status, "uncertain");
  assert.equal(oldOutbox.status, "uncertain");
  assert.deepEqual(f.control.message(message.id), before);
  assert.deepEqual(f.control.db.prepare("SELECT * FROM outbox WHERE id=?").get(outbox.id), oldOutbox);
  assert.equal(f.control.pendingOutbox().some(row => row.message_id === message.id), false);
  assert.equal(f.control.workerMailbox.inspectOutbox(replacement.binding).length, 0);
});


for (const cause of ["coordinator-restart", "lease-loss", "admission-timeout"]) {
  test(`remote ${cause} exposes delivery reconciliation without replaying the input`, t => {
    const f = fixture(t);
    let reopened;
    try {
      const message = f.control.detail(f.mission.id).messages.find(item => item.recipientId === f.agent.id);
      const row = f.control.pendingOutbox().find(item => item.message_id === message.id);
      assert.equal(f.control.markOutboxDispatching(row.id, f.agent.epoch), true);
      if (cause !== "admission-timeout") assert.equal(f.control.ackOutbox(message.id, row.request_id, row.attempt, f.agent.epoch, "admitted"), true);
      let control = f.control;
      if (cause === "coordinator-restart") {
        control.close();
        reopened = new ControlPlane(join(f.home, "control"));
        control = reopened;
      } else if (cause === "lease-loss") {
        control.db.prepare("UPDATE remote_machines SET data=json_set(data,'$.leaseExpiresAt',?) WHERE id=?")
          .run(Date.now() - 1, f.enrolled.machine.id);
        control.fenceStaleWorkerBindings();
      } else {
        control.db.prepare("UPDATE outbox SET deadline_at=? WHERE id=?").run(Date.now() - 1, row.id);
        control.pendingOutbox();
      }
      assert.equal(control.message(message.id).status, "uncertain");
      assert.equal(control.db.prepare("SELECT status FROM outbox WHERE id=?").get(row.id).status, "uncertain");
      const blocker = control.blockers(f.mission.id).find(item => item.id === `delivery:${row.id}`);
      assert.equal(blocker?.status, "open");
      control.resolveBlocker(blocker.id, "Reviewed interrupted delivery; ownership evidence is a separate gate.");
      assert.equal(control.pendingOutbox().some(item => item.id === row.id), false);
      assert.equal(control.message(message.id).attempt, message.attempt);
      if (cause !== "admission-timeout") assert.ok(control.blockers(f.mission.id).some(item => item.id === `remote-runtime:${f.assignment.binding.runtimeId}` && item.status === "open"));
    } finally { reopened?.close(); }
  });
}
