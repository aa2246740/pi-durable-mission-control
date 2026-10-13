import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { nodeEffectUpload } from "../dist/node-effects.js";

function fixture(t, optedIn = true) {
  const home = mkdtempSync(join(tmpdir(), "remote-effect-approvals-"));
  const localPath = join(home, "local"), remotePath = join(home, "remote");
  mkdirSync(localPath); mkdirSync(remotePath);
  let control = new ControlPlane(join(home, "control"));
  t.after(() => { control.close(); rmSync(home, { recursive: true, force: true }); });
  const local = control.addWorkspace("Local", localPath);
  const enrolled = control.enrollMachine(`approval-${crypto.randomUUID()}`, "Approval node");
  const capabilities = {
    protocol: 3, version: "test", platform: process.platform, arch: process.arch, node: process.version,
    piDurable: "test", roots: [remotePath], credentialRefs: [], executionEnabled: true,
    executionMode: "workspace-effects", ...(optedIn ? { effectApprovals: true } : {})
  };
  const session = control.nodeSession(enrolled.machine.id, enrolled.token, capabilities, crypto.randomUUID());
  const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), remotePath);
  control.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  control.nodeEvent(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: remotePath, path: remotePath, isDirectory: true }
  });
  const remote = control.addRemoteWorkspace("Remote", enrolled.machine.id, probe.id);
  const profile = {
    id: `profile-${crypto.randomUUID()}`, name: "Fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "https://models.example.test/v1", credentialEnv: "", contextWindow: 4096, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false, revision: 1
  };
  control.upsertProfile(profile);
  const roleIds = ["orchestrator", "worker", "validator"].map(kind => `${kind}-${crypto.randomUUID()}`);
  for (let i = 0; i < roleIds.length; i++) {
    control.upsertRole({ id: roleIds[i], name: roleIds[i], kind: ["orchestrator", "worker", "validator"][i],
      instructions: "fixture", profileId: profile.id });
  }
  const workerRole = { id: roleIds[1], name: roleIds[1], kind: "worker", instructions: "fixture", profileId: profile.id };
  const mission = control.createMission({
    title: "Remote approval fixture", goal: "test durable approvals", acceptance: "no replay",
    workspaceId: local.id, remoteWorkspaceIds: [remote.id], roleIds, maxTurns: 8, maxCost: 0,
    autonomy: "approve", workspaceStrategy: "shared"
  });
  control.missionAction(mission.id, "start");
  const created = control.createAgent(mission.id, "Worker", roleIds[1], "fixture", `worker-${crypto.randomUUID()}`, remote.id);
  const assignment = control.assignRemoteRuntime(created.id);
  control.remoteRuntimeReady(assignment.binding);
  const agent = control.getAgentPublic(created.id);
  return { get control() { return control; }, replaceControl(value) { control = value; },
    home, enrolled, session, capabilities, mission, agent, assignment, workerRole };
}

function currentApproval(control, id) {
  return JSON.parse(control.db.prepare("SELECT data FROM approvals WHERE id=?").get(id).data);
}

function request(f, task, method = "write_file", args = { path: "approved.txt", content: "node" }, rpcId = "rpc-approval") {
  return { id: rpcId, agentId: f.agent.id, epoch: f.agent.epoch, method, args, taskId: `${f.agent.id}:${task}` };
}

function pendingReply(f, approvalId, rpcId = "rpc-approval") {
  return f.control.workerMailbox.enqueue(f.assignment.binding, {
    kind: "reply", rpcId, ok: true, result: { status: "pending", approvalId }
  }, `pending:${approvalId}:${rpcId}`);
}

test("approval request is durable and idempotent; dispatch waits for its pending RPC reply", async t => {
  const f = fixture(t), { control, mission, agent, assignment } = f;
  const args = { path: "approved.txt", content: "node" };
  const first = await control.workerCommand(request(f, "one", "write_file", args, "rpc-first"));
  const retry = await control.workerCommand(request(f, "one", "write_file", args, "rpc-retry"));
  assert.deepEqual(retry, first);
  assert.equal(first.status, "pending");
  await assert.rejects(() => control.workerCommand(request(f, "one", "write_file",
    { path: "approved.txt", content: "changed" }, "rpc-changed")), error => error.status === 409);
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "approval_requested").length, 1);
  const saved = currentApproval(control, first.approvalId);
  assert.equal(saved.remoteEffectBinding.originalRpcId, "rpc-first");
  assert.equal(saved.remoteEffectBinding.workspacePath, assignment.descriptor.workspacePath);
  assert.equal(saved.remoteEffectBinding.profileRevision, assignment.descriptor.profile.revision);
  assert.deepEqual(saved.remoteEffectBinding.spec.args, args);
  control.resolveApproval(first.approvalId, "approved");
  assert.deepEqual(await control.workerCommand(request(f, "one", "write_file", args, "rpc-after-approve")),
    { status: "pending", approvalId: first.approvalId });
  control.reconcileRemoteEffectApprovals();
  assert.equal(currentApproval(control, first.approvalId).status, "approved");
  assert.equal(control.workerMailbox.inspectOutbox(assignment.binding).some(({ envelope }) =>
    envelope.payload.kind === "approved-effect"), false);
  control.workerMailbox.enqueue(assignment.binding, {
    kind: "reply", rpcId: "rpc-first", ok: true,
    result: { status: "pending", approvalId: "different-approval" }
  }, "pending:mismatched-approval");
  control.reconcileRemoteEffectApprovals();
  assert.equal(currentApproval(control, first.approvalId).status, "approved");
  assert.equal(control.workerMailbox.inspectOutbox(assignment.binding).some(({ envelope }) =>
    envelope.payload.kind === "approved-effect"), false);
  pendingReply(f, first.approvalId, "rpc-first");
  control.reconcileRemoteEffectApprovals();
  const dispatched = currentApproval(control, first.approvalId);
  assert.equal(dispatched.status, "running");
  assert.deepEqual(await control.workerCommand(request(f, "one", "write_file", args, "rpc-after-dispatch")),
    { status: "pending", approvalId: first.approvalId });
  assert.equal((await control.executeApproved(first.approvalId)).status, "running");
  const downlinks = control.workerMailbox.inspectOutbox(assignment.binding)
    .filter(({ envelope }) => envelope.payload.kind === "approved-effect");
  assert.equal(downlinks.length, 1);
  assert.equal(downlinks[0].envelope.messageId, `approval-effect:${first.approvalId}`);
  control.reconcileRemoteEffectApprovals();
  assert.equal(control.workerMailbox.inspectOutbox(assignment.binding)
    .filter(({ envelope }) => envelope.payload.kind === "approved-effect").length, 1);
  assert.equal(agent.machineId, assignment.binding.machineId);
});

test("denial does not dispatch an effect and duplicate decisions produce one follow-up", async t => {
  const f = fixture(t), { control, mission, assignment } = f;
  const result = await control.workerCommand(request(f, "deny", "bash", { command: "touch forbidden" }, "rpc-deny"));
  control.resolveApproval(result.approvalId, "denied");
  control.resolveApproval(result.approvalId, "denied");
  control.reconcileRemoteEffectApprovals();
  assert.equal(currentApproval(control, result.approvalId).status, "denied");
  assert.equal(control.workerMailbox.inspectOutbox(assignment.binding)
    .some(({ envelope }) => envelope.payload.kind === "approved-effect"), false);
  assert.equal(control.detail(mission.id).messages.filter(message => message.id ===
    `approval-outcome:${result.approvalId}:denied`).length, 1);
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "approval_denied").length, 1);
  assert.deepEqual(await control.workerCommand(request(f, "deny", "bash", { command: "touch forbidden" }, "rpc-denied-retry")),
    { status: "pending", approvalId: result.approvalId });
});

test("terminal receipt reconciles once; late success after pause never wakes or reopens ownership", async t => {
  const f = fixture(t), { control, mission, agent, assignment, enrolled, session } = f;
  const args = { path: "late.txt", content: "evidence" };
  const result = await control.workerCommand(request(f, "late", "write_file", args, "rpc-late"));
  control.resolveApproval(result.approvalId, "approved");
  pendingReply(f, result.approvalId, "rpc-late");
  control.reconcileRemoteEffectApprovals();
  const runtime = control.remoteRuntimeForAgent(agent.id);
  const spec = {
    binding: assignment.binding, descriptorHash: runtime.descriptor_hash,
    taskId: `${agent.id}:late`, method: "write_file", args
  };
  control.missionAction(mission.id, "pause");
  const pausedRuntime = control.remoteRuntimeForAgent(agent.id);
  const upload = nodeEffectUpload(spec, { status: "succeeded", result: { path: "late.txt", bytes: 8 } });
  const ack = control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, upload);
  assert.equal(ack.duplicate, false);
  assert.equal(control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, upload).duplicate, true);
  control.reconcileRemoteEffectApprovals();
  assert.equal(currentApproval(control, result.approvalId).status, "succeeded");
  assert.equal(control.missionById(mission.id).status, "paused");
  assert.equal(control.detail(mission.id).messages.some(message => message.id.startsWith(`approval-execution:${result.approvalId}:`)), false);
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_receipt").length, 1);
  const afterReceipt = control.remoteRuntimeForAgent(agent.id);
  assert.equal(afterReceipt.state, pausedRuntime.state);
  assert.equal(afterReceipt.desired, pausedRuntime.desired);
});

test("active terminal receipt is exposed as an approval receipt and queues one continuation", async t => {
  const f = fixture(t), { control, mission, agent, assignment, enrolled, session } = f;
  const args = { path: "result.txt", content: "evidence" };
  const result = await control.workerCommand(request(f, "active-result", "write_file", args, "rpc-active-result"));
  control.resolveApproval(result.approvalId, "approved");
  assert.equal(control.resolveApproval(result.approvalId, "approved").status, "approved");
  pendingReply(f, result.approvalId, "rpc-active-result");
  control.reconcileRemoteEffectApprovals();
  const runtime = control.remoteRuntimeForAgent(agent.id);
  const spec = {
    binding: assignment.binding, descriptorHash: runtime.descriptor_hash,
    taskId: `${agent.id}:active-result`, method: "write_file", args
  };
  const upload = nodeEffectUpload(spec, { status: "succeeded", result: { path: "result.txt", bytes: 8 } });
  assert.equal(control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, upload).duplicate, false);
  assert.equal(control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, upload).duplicate, true);
  control.reconcileRemoteEffectApprovals();
  control.reconcileRemoteEffectApprovals();
  const saved = currentApproval(control, result.approvalId);
  assert.equal(saved.status, "succeeded");
  assert.deepEqual(
    JSON.parse(JSON.stringify(saved.remoteEffectReceipt)),
    JSON.parse(JSON.stringify(upload.receipt))
  );
  assert.deepEqual(saved.receipt, {
    stdout: JSON.stringify(upload.receipt.result), stderr: "", exitCode: 0
  });
  assert.equal(control.detail(mission.id).messages.filter(message =>
    message.id === `approval-execution:${result.approvalId}:succeeded`).length, 1);
  assert.equal(control.detail(mission.id).events.filter(event =>
    event.type === "approval_execution" && event.data?.approvalId === result.approvalId &&
    event.data?.status === "succeeded").length, 1);
  assert.equal((await control.executeApproved(result.approvalId)).status, "succeeded");
  assert.equal(control.workerMailbox.inspectOutbox(assignment.binding)
    .filter(({ envelope }) => envelope.payload.kind === "approved-effect").length, 1);
});

test("bash approval outcome preserves typed shell output in the standard receipt", async t => {
  const f = fixture(t), { control, agent, assignment, enrolled, session } = f;
  const args = { command: "printf out; printf err >&2; exit 7" };
  const requestValue = request(f, "bash-result", "bash", args, "rpc-bash-result");
  const result = await control.workerCommand(requestValue);
  control.resolveApproval(result.approvalId, "approved");
  pendingReply(f, result.approvalId, "rpc-bash-result");
  control.reconcileRemoteEffectApprovals();
  const runtime = control.remoteRuntimeForAgent(agent.id);
  const upload = nodeEffectUpload({
    binding: assignment.binding, descriptorHash: runtime.descriptor_hash,
    taskId: requestValue.taskId, method: "bash", args
  }, { status: "succeeded", result: { stdout: "out", stderr: "err", exitCode: 7 } });
  control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, upload);
  control.reconcileRemoteEffectApprovals();
  const saved = currentApproval(control, result.approvalId);
  assert.equal(saved.status, "succeeded");
  assert.deepEqual(saved.receipt, { stdout: "out", stderr: "err", exitCode: 7 });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.remoteEffectReceipt)), JSON.parse(JSON.stringify(upload.receipt)));
});

test("uncertain remote receipt stays uncertain and is surfaced as an approval error", async t => {
  const f = fixture(t), { control, agent, assignment, enrolled, session, mission } = f;
  const args = { path: "unknown-result.txt", content: "possibly written" };
  const requestValue = request(f, "unknown-result", "write_file", args, "rpc-unknown-result");
  const result = await control.workerCommand(requestValue);
  control.resolveApproval(result.approvalId, "approved");
  pendingReply(f, result.approvalId, "rpc-unknown-result");
  control.reconcileRemoteEffectApprovals();
  const runtime = control.remoteRuntimeForAgent(agent.id);
  const error = "Receipt does not establish whether the write completed";
  const upload = nodeEffectUpload({
    binding: assignment.binding, descriptorHash: runtime.descriptor_hash,
    taskId: requestValue.taskId, method: "write_file", args
  }, { status: "uncertain", error });
  control.nodeEffectReceipt(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, upload);
  control.reconcileRemoteEffectApprovals();
  const saved = currentApproval(control, result.approvalId);
  assert.equal(saved.status, "uncertain");
  assert.deepEqual(saved.receipt, { stdout: "", stderr: error, exitCode: null });
  assert.deepEqual(JSON.parse(JSON.stringify(saved.remoteEffectReceipt)), JSON.parse(JSON.stringify(upload.receipt)));
  assert.equal(control.blockers(mission.id)
    .filter(item => item.id === `approval:${result.approvalId}` && item.status === "open").length, 1);
});

test("running approval becomes uncertain across lost runtime and a late success cannot resolve it", async t => {
  const f = fixture(t), { mission, agent, assignment, enrolled, capabilities } = f;
  let control = f.control;
  const args = { path: "uncertain.txt", content: "not replayed" };
  const requestValue = request(f, "lost-runtime", "write_file", args, "rpc-lost-runtime");
  const created = await control.workerCommand(requestValue);
  control.resolveApproval(created.approvalId, "approved");
  pendingReply(f, created.approvalId, "rpc-lost-runtime");
  control.reconcileRemoteEffectApprovals();
  const runtime = control.remoteRuntimeForAgent(agent.id);
  const spec = {
    binding: assignment.binding, descriptorHash: runtime.descriptor_hash,
    taskId: requestValue.taskId, method: "write_file", args
  };
  control.missionAction(mission.id, "pause");
  control.reconcileRemoteEffectApprovals();
  assert.equal(currentApproval(control, created.approvalId).status, "uncertain");
  assert.equal(control.blockers(mission.id).filter(item =>
    item.id === `approval:${created.approvalId}` && item.status === "open").length, 1);
  assert.equal(control.workerMailbox.inspectOutbox(assignment.binding)
    .filter(({ envelope }) => envelope.payload.kind === "approved-effect").length, 1);

  control.close();
  control = new ControlPlane(join(f.home, "control"));
  f.replaceControl(control);
  control.reconcileRemoteEffectApprovals();
  const approvalAfterRestart = currentApproval(control, created.approvalId);
  assert.equal(approvalAfterRestart.status, "uncertain");
  const preReceipt = {
    mission: control.missionById(mission.id),
    agents: control.listAgents(mission.id),
    runtime: (() => {
      const row = control.remoteRuntimeForAgent(agent.id);
      return {
        runtime_id: row.runtime_id, agent_id: row.agent_id, epoch: row.epoch,
        descriptor_hash: row.descriptor_hash, state: row.state, desired: row.desired
      };
    })(),
    messages: control.detail(mission.id).messages,
    budget: control.detail(mission.id).budget
  };
  control.revokeMachine(enrolled.machine.id);
  const reenrolled = control.reenrollMachine(enrolled.machine.id);
  const session = control.nodeSession(enrolled.machine.id, reenrolled.token, capabilities, crypto.randomUUID());
  const late = nodeEffectUpload(spec, { status: "succeeded", result: { path: "uncertain.txt", bytes: 12 } });
  assert.equal(control.nodeEffectReceipt(enrolled.machine.id, reenrolled.token, session.sessionId, session.sessionEpoch, late).duplicate, false);
  assert.equal(control.nodeEffectReceipt(enrolled.machine.id, reenrolled.token, session.sessionId, session.sessionEpoch, late).duplicate, true);
  control.reconcileRemoteEffectApprovals();
  assert.equal(currentApproval(control, created.approvalId).status, "uncertain");
  const blockers = control.blockers(mission.id).filter(item => item.id === `approval:${created.approvalId}`);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].status, "open");
  assert.equal(blockers[0].kind, "approval");
  assert.equal(control.detail(mission.id).messages.some(item => item.id.startsWith(`approval-execution:${created.approvalId}:`)), false);
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_receipt" &&
    event.data?.effectId === `${agent.id}\0${requestValue.taskId}`).length, 1);
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "approval_execution" &&
    event.data?.approvalId === created.approvalId && event.data?.status !== "running").length, 0);
  assert.deepEqual({
    mission: control.missionById(mission.id),
    agents: control.listAgents(mission.id),
    runtime: (() => {
      const row = control.remoteRuntimeForAgent(agent.id);
      return {
        runtime_id: row.runtime_id, agent_id: row.agent_id, epoch: row.epoch,
        descriptor_hash: row.descriptor_hash, state: row.state, desired: row.desired
      };
    })(),
    messages: control.detail(mission.id).messages,
    budget: control.detail(mission.id).budget
  }, preReceipt);
});

test("pending approval survives coordinator restart but stale binding cannot dispatch", async t => {
  const f = fixture(t), result = await f.control.workerCommand(request(f, "restart-stale"));
  f.control.close();
  const control = new ControlPlane(join(f.home, "control"));
  f.replaceControl(control);
  assert.equal(currentApproval(control, result.approvalId).status, "pending");
  control.resolveApproval(result.approvalId, "approved");
  control.reconcileRemoteEffectApprovals();
  assert.equal(currentApproval(control, result.approvalId).status, "failed");
  assert.match(currentApproval(control, result.approvalId).receipt.stderr, /not dispatched/i);
  assert.equal(control.db.prepare("SELECT 1 FROM commands WHERE scope=? AND command_id=?")
    .get(`mission:${f.mission.id}:remote-effects`, `${f.agent.id}:restart-stale`), undefined);
  assert.equal(control.workerMailbox.inspectOutbox(f.assignment.binding)
    .some(({ envelope }) => envelope.payload.kind === "approved-effect"), false);
});

test("an unrelated existing trusted permit blocks creation of a new approval for its task", async t => {
  const f = fixture(t), { control, mission } = f;
  const requestValue = request(f, "preexisting-permit");
  const missionRow = control.db.prepare("SELECT data FROM missions WHERE id=?").get(mission.id);
  const priorMission = JSON.parse(missionRow.data);
  control.db.prepare("UPDATE missions SET data=? WHERE id=?")
    .run(JSON.stringify({ ...priorMission, autonomy: "trusted" }), mission.id);
  assert.ok((await control.workerCommand(requestValue)).effectPermit);
  control.db.prepare("UPDATE missions SET data=? WHERE id=?").run(JSON.stringify(priorMission), mission.id);
  await assert.rejects(() => control.workerCommand(requestValue),
    error => error.status === 409 && /unrelated trusted authorization/.test(error.message));
  assert.equal(control.db.prepare("SELECT COUNT(*) AS count FROM approvals WHERE mission_id=?").get(mission.id).count, 0);
});

test("legacy protocol-3 omission fails closed for approval execution", async t => {
  const f = fixture(t, false);
  assert.equal(Object.hasOwn(f.assignment.descriptor, "effectApprovals"), false);
  await assert.rejects(() => f.control.workerCommand(request(f, "legacy", "write_file")),
    error => error.status === 409 && /does not support effect approvals/.test(error.message));
});

const staleMutations = [
  ["display workspace snapshot", (f, id) => {
    const approval = currentApproval(f.control, id);
    approval.remoteEffectBinding.workspacePath = "/different-workspace";
    f.control.db.prepare("UPDATE approvals SET data=? WHERE id=?").run(JSON.stringify(approval), id);
  }],
  ["display profile snapshot", (f, id) => {
    const approval = currentApproval(f.control, id);
    approval.remoteEffectBinding.profileRevision += 1;
    f.control.db.prepare("UPDATE approvals SET data=? WHERE id=?").run(JSON.stringify(approval), id);
  }],
  ["role revision", f => {
    const changedRole = { ...f.workerRole, instructions: "changed after approval" };
    const revision = f.control.db.prepare("SELECT MAX(revision) AS revision FROM role_revisions WHERE role_id=?")
      .get(changedRole.id).revision;
    f.control.db.prepare("UPDATE roles SET data=? WHERE id=?").run(JSON.stringify(changedRole), changedRole.id);
    f.control.db.prepare("INSERT INTO role_revisions(role_id,revision,data,created_at) VALUES(?,?,?,?)")
      .run(changedRole.id, revision + 1, JSON.stringify(changedRole), new Date().toISOString());
  }],
  ["profile revision", f => {
    const profile = f.control.profile(f.agent.profileId);
    const changed = { ...profile, revision: profile.revision + 1 };
    f.control.db.prepare("UPDATE profiles SET data=? WHERE id=?").run(JSON.stringify(changed), changed.id);
  }],
  ["approval args", (f, id) => {
    const approval = currentApproval(f.control, id);
    approval.args.content = "changed approval args";
    f.control.db.prepare("UPDATE approvals SET data=? WHERE id=?").run(JSON.stringify(approval), id);
  }],
  ["intent spec args", (f, id) => {
    const approval = currentApproval(f.control, id);
    approval.remoteEffectBinding.spec.args.content = "changed intent args";
    f.control.db.prepare("UPDATE approvals SET data=? WHERE id=?").run(JSON.stringify(approval), id);
  }],
  ["intent task", (f, id) => {
    const approval = currentApproval(f.control, id);
    approval.remoteEffectBinding.spec.taskId = `${f.agent.id}:different-task`;
    f.control.db.prepare("UPDATE approvals SET data=? WHERE id=?").run(JSON.stringify(approval), id);
  }],
  ["descriptor identity", f => {
    const runtime = f.control.remoteRuntimeForAgent(f.agent.id);
    const descriptor = JSON.parse(runtime.descriptor_json);
    descriptor.profile.revision += 1;
    f.control.db.prepare("UPDATE remote_worker_runtimes SET descriptor_json=? WHERE runtime_id=?")
      .run(JSON.stringify(descriptor), runtime.runtime_id);
  }],
  ["agent epoch", f => {
    const row = f.control.db.prepare("SELECT data,epoch FROM agents WHERE id=?").get(f.agent.id);
    const agent = { ...JSON.parse(row.data), epoch: row.epoch + 1, status: "offline" };
    f.control.db.prepare("UPDATE agents SET data=?,epoch=?,status=? WHERE id=?")
      .run(JSON.stringify(agent), agent.epoch, agent.status, agent.id);
  }],
  ["revoked session", f => { f.control.revokeMachine(f.enrolled.machine.id); }]
];

for (const [label, mutate] of staleMutations) {
  test(`stale ${label} fails closed before remote approval dispatch`, async t => {
    const f = fixture(t), { control, assignment } = f;
    const result = await control.workerCommand(request(f, `stale-${label.replaceAll(" ", "-")}`));
    control.resolveApproval(result.approvalId, "approved");
    pendingReply(f, result.approvalId);
    mutate(f, result.approvalId);
    control.reconcileRemoteEffectApprovals();
    const saved = currentApproval(control, result.approvalId);
    assert.equal(saved.status, "failed");
    assert.match(saved.receipt.stderr, /not dispatched/i);
    assert.equal(control.db.prepare("SELECT 1 FROM commands WHERE scope=? AND command_id=?")
      .get(`mission:${f.mission.id}:remote-effects`, `${f.agent.id}:stale-${label.replaceAll(" ", "-")}`), undefined);
    assert.equal(control.workerMailbox.inspectOutbox(assignment.binding)
      .some(({ envelope }) => envelope.payload.kind === "approved-effect"), false);
  });
}
