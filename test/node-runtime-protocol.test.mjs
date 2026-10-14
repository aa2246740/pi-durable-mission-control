import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseNodeCapabilities } from "../dist/machines.js";
import { parseWorkerStartSpec, workerStartSpecHash } from "../dist/node-worker-spec.js";
import { ControlPlane } from "../dist/control.js";
import { validRuntimeReportAck } from "../dist/node.js";

const binding = {
  runtimeId: crypto.randomUUID(),
  machineId: "protocol-node",
  sessionId: crypto.randomUUID(),
  sessionEpoch: 1,
  agentId: crypto.randomUUID(),
  epoch: 1
};

const profile = {
  id: "protocol-profile",
  name: "Metadata fixture",
  api: "openai-completions",
  modelId: "fixture",
  baseUrl: "https://models.example.test/v1",
  credentialEnv: "MC_NODE_TEST_CREDENTIAL",
  contextWindow: 4096,
  maxTokens: 512,
  reasoning: false,
  toolCalling: true,
  vision: false,
  revision: 1
};

const role = {
  id: "protocol-role",
  name: "Metadata worker",
  kind: "worker",
  instructions: "metadata only",
  profileId: profile.id
};

function createAssignedRemoteRuntime(home) {
  const stateHome = join(home, "control");
  const control = new ControlPlane(stateHome);
  const localPath = join(home, "local-workspace");
  mkdirSync(localPath, { recursive: true });
  const remotePath = `/remote-protocol-${crypto.randomUUID()}`;
  const localWorkspace = control.addWorkspace("Local delivery", localPath);
  const enrolled = control.enrollMachine(`protocol-node-${crypto.randomUUID()}`, "Protocol node");
  const capabilities = {
    protocol: 2, version: "test", platform: process.platform, arch: process.arch,
    node: process.version, piDurable: "test", roots: [remotePath],
    credentialRefs: ["MC_NODE_TEST_CREDENTIAL"], executionEnabled: true, executionMode: "metadata-only"
  };
  const session = control.nodeSession(enrolled.machine.id, enrolled.token, capabilities, crypto.randomUUID());
  const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), remotePath);
  control.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  control.nodeEvent(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: remotePath, path: remotePath, isDirectory: true }
  });
  const remoteWorkspace = control.addRemoteWorkspace("Remote worker workspace", enrolled.machine.id, probe.id);
  const localProfile = { ...profile, id: `protocol-profile-${crypto.randomUUID()}`, credentialEnv: "" };
  control.upsertProfile(localProfile);
  const roleIds = ["orchestrator", "worker", "validator"].map((kind) => `protocol-${kind}-${crypto.randomUUID()}`);
  const roles = ["orchestrator", "worker", "validator"].map((kind, index) => ({
    id: roleIds[index], name: `Protocol ${kind}`, kind, instructions: "Metadata test role.", profileId: localProfile.id
  }));
  for (const item of roles) control.upsertRole(item);
  const mission = control.createMission({
    title: "Remote runtime protocol mission", goal: "Test durable remote ownership",
    acceptance: "Remote ownership remains fenced across uncertain outcomes.",
    workspaceId: localWorkspace.id, remoteWorkspaceIds: [remoteWorkspace.id], roleIds,
    maxTurns: 10, maxCost: 0, autonomy: "trusted"
  });
  control.missionAction(mission.id, "start");
  const agent = control.createAgent(mission.id, "Remote worker", roleIds[1], "Process one metadata turn.", crypto.randomUUID(), remoteWorkspace.id);
  const assignment = control.assignRemoteRuntime(agent.id);
  assert.equal(control.remoteRuntimeReady(assignment.binding), true);
  return { control, stateHome, enrolled, session, capabilities, mission, agent, assignment };
}

function reportToCoordinator(fixture, report) {
  const { control, enrolled, session } = fixture;
  return control.nodeRuntimeReport(
    enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, report
  );
}

test("runtime capability and descriptor protocol are explicit opt-ins", () => {
  const readonly = {
    protocol: 1, version: "test", platform: "test", arch: "test", node: process.version,
    piDurable: "test", roots: ["/remote"], credentialRefs: [], executionEnabled: false
  };
  assert.equal(parseNodeCapabilities(readonly).executionEnabled, false);
  assert.deepEqual(
    parseNodeCapabilities({ ...readonly, protocol: 2, executionEnabled: true, executionMode: "metadata-only" }).executionMode,
    "metadata-only"
  );
  for (const invalid of [
    { ...readonly, protocol: 1, executionEnabled: true },
    { ...readonly, executionMode: "metadata-only" },
    { ...readonly, protocol: 2, executionEnabled: false },
    { ...readonly, protocol: 2, executionEnabled: true },
    { ...readonly, protocol: 2, executionEnabled: true, executionMode: "full" },
    { ...readonly, protocol: 2, executionEnabled: true, executionMode: "metadata-only", testOnlyScripted: true }
  ]) assert.throws(() => parseNodeCapabilities(invalid));

  const descriptor = {
    binding,
    missionId: "protocol-mission",
    workspacePath: "/remote/workspace",
    workspaceStrategy: "shared",
    effects: false,
    profile,
    role
  };
  const parsed = parseWorkerStartSpec(descriptor);
  assert.equal(workerStartSpecHash(parsed).length, 64);
  const legacy = { ...descriptor };
  delete legacy.effects;
  const parsedLegacy = parseWorkerStartSpec(legacy);
  assert.deepEqual(parsedLegacy, legacy);
  assert.equal(Object.hasOwn(parsedLegacy, "effects"), false);
  assert.equal(workerStartSpecHash(parsedLegacy), workerStartSpecHash(legacy));
  for (const invalid of [
    { ...descriptor, testOnlyScripted: true },
    { ...descriptor, token: "private-token" },
    { ...descriptor, profile: { ...profile, credentialEnv: "NODE_OPTIONS" } },
    { ...descriptor, role: { ...role, profileId: "other" } },
    { ...descriptor, role: { ...role, kind: "orchestrator" } },
    { ...descriptor, workspaceStrategy: "worktree" }
  ]) assert.throws(() => parseWorkerStartSpec(invalid));
});

test("invalid remote assignment is rejected before agent or mailbox mutation", () => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-runtime-protocol-"));
  const control = new ControlPlane(home);
  try {
    const enrolled = control.machineRegistry.enroll("protocol-node", "Protocol node");
    const session = control.machineRegistry.openSession("protocol-node", enrolled.token, {
      protocol: 2, version: "test", platform: "test", arch: "test", node: process.version,
      piDurable: "test", roots: ["/remote"], credentialRefs: ["MC_NODE_TEST_CREDENTIAL"],
      executionEnabled: true, executionMode: "metadata-only"
    }, crypto.randomUUID());
    const workspace = control.addWorkspace("local delivery", home);
    const remote = control.db.prepare("INSERT INTO workspaces(id,data) VALUES(?,?)").run(
      "protocol-remote-workspace",
      JSON.stringify({
        id: "protocol-remote-workspace", name: "remote", machineId: "protocol-node",
        path: "/remote/workspace", probe: {
          commandId: crypto.randomUUID(), sessionEpoch: session.sessionEpoch,
          requestedPath: "/remote/workspace", verifiedAt: new Date().toISOString()
        }
      })
    );
    assert.equal(remote.changes, 1);
    const remoteWorkspace = control.workspace("protocol-remote-workspace");
    assert.ok(remoteWorkspace);
    control.upsertProfile({ ...profile, credentialEnv: "UNDECLARED_NODE_CREDENTIAL" });
    control.upsertRole({ ...role, kind: "worker" });
    control.upsertRole({ id: "protocol-orchestrator", name: "orchestrator", kind: "orchestrator", instructions: "coordinate", profileId: profile.id });
    control.upsertRole({ id: "protocol-validator", name: "validator", kind: "validator", instructions: "validate", profileId: profile.id });
    const mission = control.createMission({
      title: "Protocol mission", goal: "test", acceptance: "test",
      workspaceId: workspace.id, remoteWorkspaceIds: [remoteWorkspace.id],
      roleIds: ["protocol-orchestrator", role.id, "protocol-validator"], maxTurns: 1, maxCost: 0, autonomy: "trusted"
    });
    assert.throws(
      () => control.createAgent(mission.id, "invalid remote", role.id, "", crypto.randomUUID(), remoteWorkspace.id),
      /Remote node has not declared|Remote worker assignment is not valid/
    );
    assert.equal(control.listAgents(mission.id).length, 0);
    assert.equal(control.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtimes").get().count, 0);
    assert.equal(control.db.prepare("SELECT COUNT(*) AS count FROM worker_mailbox_bindings").get().count, 0);
  } finally {
    control.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("runtime report IDs are idempotent and weaker late reports never downgrade closed state (registry-only)", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-runtime-report-"));
  const fixture = createAssignedRemoteRuntime(home);
  const { control, assignment, enrolled, session, mission } = fixture;
  const pending = control.pendingOutbox().find((row) => control.message(row.message_id)?.recipientId === fixture.agent.id);
  assert.ok(pending);
  const message = control.message(pending.message_id);
  assert.ok(message);
  assert.equal(control.dispatchRemoteOutbox(pending, message, fixture.agent), true);
  t.after(() => {
    control.close();
    rmSync(home, { recursive: true, force: true });
  });

  const invalidHash = {
    reportId: crypto.randomUUID(), binding: assignment.binding,
    descriptorHash: "0".repeat(64), outcome: "stopped"
  };
  assert.throws(() => reportToCoordinator(fixture, invalidHash), (error) => error.status === 409);
  const invalidBinding = {
    reportId: crypto.randomUUID(),
    binding: { ...assignment.binding, sessionEpoch: assignment.binding.sessionEpoch + 1 },
    descriptorHash: assignment.descriptorHash, outcome: "stopped"
  };
  assert.throws(() => reportToCoordinator(fixture, invalidBinding), (error) => error.status === 409);
  assert.equal(control.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtime_reports").get().count, 0);

  const stopped = {
    reportId: crypto.randomUUID(), binding: assignment.binding,
    descriptorHash: assignment.descriptorHash, outcome: "stopped"
  };
  assert.deepEqual(reportToCoordinator(fixture, stopped), { recorded: true, duplicate: false });
  assert.deepEqual(reportToCoordinator(fixture, stopped), { recorded: true, duplicate: true });
  assert.equal(control.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtime_reports").get().count, 1);
  const lateUncertain = { ...stopped, reportId: crypto.randomUUID(), outcome: "uncertain" };
  assert.deepEqual(reportToCoordinator(fixture, lateUncertain), { recorded: true, duplicate: false });
  const runtime = control.remoteRuntimeForAgent(fixture.agent.id);
  assert.equal(runtime.state, "closed");
  assert.equal(JSON.parse(runtime.last_report_json).outcome, "stopped");
  assert.equal(control.getMission(mission.id).status, "blocked");
  const fencedMessage = control.db.prepare("SELECT status,data FROM messages WHERE id=?").get(message.id);
  const fencedOutbox = control.db.prepare("SELECT status FROM outbox WHERE message_id=?").get(message.id);
  assert.equal(fencedMessage.status, "uncertain");
  assert.equal(JSON.parse(fencedMessage.data).status, fencedMessage.status);
  assert.equal(fencedOutbox.status, "uncertain");
  assert.ok(control.blockers(mission.id).some((blocker) => blocker.id === `remote-runtime:${assignment.binding.runtimeId}`));
  assert.equal(control.machineRegistry.requireSession(
    enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch
  ).status, "online");

  assert.equal(validRuntimeReportAck({ recorded: true }), true);
  assert.equal(validRuntimeReportAck({ recorded: true, duplicate: false }), true);
  assert.equal(validRuntimeReportAck({ recorded: true, duplicate: true }), true);
  for (const invalid of [
    { recorded: false }, { recorded: true, duplicate: "true" },
    { recorded: true, duplicate: false, extra: true }, {}, null
  ]) assert.equal(validRuntimeReportAck(invalid), false);
});

test("unexpected stopped reports block an already-blocked nonterminal mission", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-runtime-report-blocked-"));
  const fixture = createAssignedRemoteRuntime(home);
  const { control, assignment, mission, agent } = fixture;
  t.after(() => {
    control.close();
    rmSync(home, { recursive: true, force: true });
  });

  const currentMission = control.getMission(mission.id);
  control.db.prepare("UPDATE missions SET status='blocked',data=? WHERE id=?")
    .run(JSON.stringify({ ...currentMission, status: "blocked" }), mission.id);
  const priorBlocker = {
    id: `delivery:prior-${assignment.binding.runtimeId}`, missionId: mission.id, agentId: agent.id,
    kind: "delivery", status: "open", text: "A prior delivery requires reconciliation.", createdAt: new Date().toISOString()
  };
  control.db.prepare("INSERT INTO blockers(id,mission_id,status,data) VALUES(?,?,?,?)")
    .run(priorBlocker.id, mission.id, priorBlocker.status, JSON.stringify(priorBlocker));

  assert.equal(control.remoteRuntimeForAgent(agent.id).desired, "run");
  const agentEpochBeforeReport = control.getAgentPublic(agent.id).epoch;
  assert.deepEqual(reportToCoordinator(fixture, {
    reportId: crypto.randomUUID(), binding: assignment.binding,
    descriptorHash: assignment.descriptorHash, outcome: "stopped"
  }), { recorded: true, duplicate: false });
  assert.equal(control.getMission(mission.id).status, "blocked");
  assert.equal(control.getAgentPublic(agent.id).epoch, agentEpochBeforeReport);
  assert.ok(control.blockers(mission.id).some((blocker) => blocker.id === priorBlocker.id));
  assert.ok(control.blockers(mission.id).some((blocker) => blocker.id === `remote-runtime:${assignment.binding.runtimeId}`));
  assert.equal(control.detail(mission.id).events.some(event => event.type === "remote_runtime_uncertain"), false);
});

test("coordinator restart and lease expiry fence remote delivery without requeue or replacement", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-runtime-recovery-"));
  const fixture = createAssignedRemoteRuntime(home);
  const { control, stateHome, enrolled, capabilities, mission, agent } = fixture;
  let activeControl = control;
  t.after(() => {
    activeControl.close();
    rmSync(home, { recursive: true, force: true });
  });
  const pending = control.pendingOutbox().find((row) => control.message(row.message_id)?.recipientId === agent.id);
  assert.ok(pending);
  const pendingMessage = control.message(pending.message_id);
  assert.ok(pendingMessage);
  assert.equal(control.dispatchRemoteOutbox(pending, pendingMessage, agent), true);
  assert.equal(control.db.prepare("SELECT status FROM outbox WHERE id=?").get(pending.id).status, "dispatching");

  control.db.prepare("UPDATE remote_machines SET data=json_set(data,'$.leaseExpiresAt',?) WHERE id=?")
    .run(Date.now() - 1, enrolled.machine.id);
  assert.deepEqual(control.machineRegistry.expireLeases(), [enrolled.machine.id]);
  control.close();

  const recovered = new ControlPlane(stateHome);
  activeControl = recovered;
  const recoveredSession = recovered.nodeSession(
    enrolled.machine.id, enrolled.token, capabilities, crypto.randomUUID()
  );
  recovered.fenceStaleWorkerBindings();
  const outbox = recovered.db.prepare("SELECT status FROM outbox WHERE id=?").get(pending.id);
  const messageColumns = recovered.db.prepare("SELECT status,data FROM messages WHERE id=?").get(pending.message_id);
  assert.equal(outbox.status, "uncertain");
  assert.equal(messageColumns.status, "uncertain");
  assert.equal(JSON.parse(messageColumns.data).status, messageColumns.status);
  assert.equal(recovered.message(pending.message_id).status, "uncertain");
  assert.equal(recovered.pendingOutbox().some((row) => row.id === pending.id), false);
  assert.equal(recovered.remoteRuntimeForAgent(agent.id).state, "uncertain");
  assert.equal(recovered.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtimes WHERE agent_id=?").get(agent.id).count, 1);
  assert.throws(() => recovered.assignRemoteRuntime(agent.id), (error) => error.status === 409);
  assert.equal(recovered.machineRegistry.requireSession(
    enrolled.machine.id, enrolled.token, recoveredSession.sessionId, recoveredSession.sessionEpoch
  ).status, "online");
  assert.equal(recovered.getMission(mission.id).status, "blocked");
});

test("requested remote stop permits epoch fencing without adding a completion blocker", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-runtime-requested-stop-"));
  const fixture = createAssignedRemoteRuntime(home);
  const { control, assignment, mission, agent, enrolled, session } = fixture;
  t.after(() => { control.close(); rmSync(home, { recursive: true, force: true }); });
  const completed = { ...control.getMission(mission.id), status: "completed" };
  control.db.prepare("UPDATE missions SET status=?,data=? WHERE id=?").run(completed.status, JSON.stringify(completed), mission.id);
  const currentEpoch = control.getAgentPublic(agent.id).epoch;
  assert.equal(control.requestRemoteRuntimeStop(agent.id), true);
  control.markAgentInterrupted(agent.id, currentEpoch);
  control.fenceStaleWorkerBindings();
  assert.deepEqual(control.blockers(mission.id), []);
  assert.equal(control.getAgentPublic(agent.id).epoch, currentEpoch + 1);
  assert.equal(control.remoteRuntimeForAgent(agent.id).state, "stopping");
  assert.throws(() => control.nodeWorkerPoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, assignment.binding),
    (error) => error.status === 409);
  assert.deepEqual(control.blockers(mission.id), []);
  assert.deepEqual(reportToCoordinator(fixture, { reportId: crypto.randomUUID(), binding: assignment.binding,
    descriptorHash: assignment.descriptorHash, outcome: "stopped", stopReason: "requested" }), { recorded: true, duplicate: false });
  assert.equal(control.remoteRuntimeForAgent(agent.id).state, "closed");
  assert.deepEqual(control.blockers(mission.id), []);
});

test("requested remote stop still blocks when the machine lease expires", (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-runtime-stopping-expiry-"));
  const fixture = createAssignedRemoteRuntime(home);
  const { control, assignment, mission, agent, enrolled } = fixture;
  t.after(() => { control.close(); rmSync(home, { recursive: true, force: true }); });
  const currentEpoch = control.getAgentPublic(agent.id).epoch;
  control.requestRemoteRuntimeStop(agent.id);
  control.markAgentInterrupted(agent.id, currentEpoch);
  control.db.prepare("UPDATE remote_machines SET data=json_set(data,'$.leaseExpiresAt',?) WHERE id=?").run(Date.now() - 1, enrolled.machine.id);
  control.fenceStaleWorkerBindings();
  assert.equal(control.getMission(mission.id).status, "blocked");
  assert.ok(control.blockers(mission.id).some((b) => b.id === `remote-runtime:${assignment.binding.runtimeId}`));
});


test("targeted stop polling returns only the requested runtime on that machine", t => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-runtime-targeted-stop-"));
  const fixture = createAssignedRemoteRuntime(home);
  const { control, mission, agent, assignment, enrolled, session } = fixture;
  t.after(() => { control.close(); rmSync(home, { recursive: true, force: true }); });
  const otherAgent = control.createAgent(mission.id, "Other remote worker", agent.roleId, "Metadata turn.",
    crypto.randomUUID(), agent.workspaceId);
  const other = control.assignRemoteRuntime(otherAgent.id);
  const poll = runtimeId => control.nodeRuntimePoll(enrolled.machine.id, enrolled.token,
    session.sessionId, session.sessionEpoch, runtimeId).directives;
  assert.deepEqual(poll(other.binding.runtimeId), []);
  control.requestRemoteRuntimeStop(agent.id);
  control.requestRemoteRuntimeStop(otherAgent.id);
  assert.deepEqual(poll(crypto.randomUUID()), []);
  assert.deepEqual(poll(other.binding.runtimeId), [{ action: "stop", binding: other.binding, descriptorHash: other.descriptorHash }]);
  assert.deepEqual(poll(assignment.binding.runtimeId), [{ action: "stop", binding: assignment.binding, descriptorHash: assignment.descriptorHash }]);
});
