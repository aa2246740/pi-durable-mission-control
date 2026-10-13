import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { nodeEffectUpload } from "../dist/node-effects.js";

function fixture(t, executionMode = "workspace-effects", autonomy = "trusted") {
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
    roots: [remotePath], credentialRefs: [], executionEnabled: true, executionMode
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
    error => error.status === 409 && /pending phase 2/.test(error.message)
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
