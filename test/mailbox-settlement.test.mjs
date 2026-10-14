import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { queryAppliedMailboxUploads } from "../dist/node.js";
import { NodeWorkerSupervisor } from "../dist/node-workers.js";
import { startServer } from "../dist/server.js";
import { DurableWorkerMailbox } from "../dist/worker-mailbox.js";

const CREDENTIAL = "MC_NODE_SETTLEMENT_CREDENTIAL";
process.env[CREDENTIAL] ||= "settlement-sentinel";

function fixture(t, executionMode = "metadata-only", limits = {}) {
  const home = mkdtempSync(join(tmpdir(), "mailbox-settlement-"));
  let control;
  t.after(() => { control?.close(); rmSync(home, { recursive: true, force: true }); });
  const localPath = join(home, "local");
  const remotePath = join(home, "remote");
  mkdirSync(localPath);
  mkdirSync(remotePath);
  control = new ControlPlane(join(home, "control"));
  const local = control.addWorkspace("Local", localPath);
  const enrolled = control.enrollMachine(`settle-${crypto.randomUUID()}`, "Settlement node");
  const session = control.nodeSession(enrolled.machine.id, enrolled.token, {
    protocol: executionMode === "workspace-effects" ? 3 : 2,
    version: "test", platform: process.platform, arch: process.arch, node: process.version, piDurable: "test",
    roots: [remotePath], credentialRefs: [], executionEnabled: true, executionMode
  }, crypto.randomUUID());
  const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), remotePath);
  control.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  control.nodeEvent(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: remotePath, path: remotePath, isDirectory: true }
  });
  const remote = control.addRemoteWorkspace("Remote", enrolled.machine.id, probe.id);
  const profile = {
    id: `settle-profile-${crypto.randomUUID()}`, name: "Fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "https://models.example.test/v1", credentialEnv: "", contextWindow: 4096, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false, revision: 1,
    ...(limits.cost ? { cost: limits.cost } : {})
  };
  control.upsertProfile(profile);
  const roleIds = ["orchestrator", "worker", "validator"].map((kind) => `settle-${kind}-${crypto.randomUUID()}`);
  for (let index = 0; index < roleIds.length; index += 1) {
    const kind = ["orchestrator", "worker", "validator"][index];
    control.upsertRole({ id: roleIds[index], name: kind, kind, instructions: "fixture", profileId: profile.id });
  }
  const mission = control.createMission({
    title: "Mailbox settlement", goal: "settle non-authorizing transport", acceptance: "no replay",
    workspaceId: local.id, remoteWorkspaceIds: [remote.id], roleIds,
    maxTurns: limits.maxTurns ?? 10, maxCost: limits.maxCost ?? 0, autonomy: "trusted", workspaceStrategy: "shared"
  });
  control.missionAction(mission.id, "start");
  const created = control.createAgent(mission.id, "Remote worker", roleIds[1], "fixture", `request-${crypto.randomUUID()}`, remote.id);
  const assignment = control.assignRemoteRuntime(created.id);
  control.remoteRuntimeReady(assignment.binding);
  const agent = control.getAgentPublic(created.id);
  return { control, home, remotePath, enrolled, session, mission, agent, assignment };
}

// One place builds the stopped report. A parallel change adds a stop-reason field here.
function reportControlledStop(f) {
  const requested = f.control.requestRemoteRuntimeStop(f.agent.id);
  const report = f.control.nodeRuntimeReport(
    f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, {
      reportId: crypto.randomUUID(),
      binding: f.assignment.binding,
      descriptorHash: f.assignment.descriptorHash,
      outcome: "stopped"
    }
  );
  return { requested, report };
}

function snapshot(f) {
  return {
    transcripts: f.control.transcript(f.agent.id),
    messages: f.control.detail(f.mission.id).messages.map((message) => ({ id: message.id, status: message.status, attempt: message.attempt })),
    outbox: f.control.db.prepare("SELECT id,status,attempt FROM outbox WHERE mission_id=? ORDER BY id").all(f.mission.id),
    commands: f.control.db.prepare("SELECT scope,command_id,payload_hash FROM commands ORDER BY scope,command_id").all(),
    mailbox: f.control.workerMailbox.inspectOutbox(f.assignment.binding).map((item) => ({
      id: item.envelope.messageId, status: item.status, sha256: item.sha256
    })),
    inbox: f.control.workerMailbox.inspectInbox(f.assignment.binding).map((item) => ({
      id: item.envelope.messageId, status: item.status, sha256: item.sha256
    }))
  };
}

function assertNoReplay(f, before, next) {
  const after = snapshot(f);
  assert.deepEqual(after.transcripts, before.transcripts);
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.outbox, before.outbox);
  assert.deepEqual(after.commands, before.commands);
  assert.deepEqual(after.mailbox, before.mailbox);
  assert.deepEqual(after.inbox, before.inbox);
  assert.equal(f.control.workerMailbox.inspectOutbox(next.binding).length, 0);
  assert.equal(f.control.workerMailbox.inspectInbox(next.binding).length, 0);
  assert.equal(f.control.db.prepare("SELECT COUNT(*) AS n FROM remote_worker_runtimes WHERE agent_id=?").get(f.agent.id).n, 2);
}

function nodeSpec(binding, workspace, missionId) {
  return {
    binding, missionId, workspacePath: workspace, workspaceStrategy: "shared", effects: false,
    profile: {
      id: "settlement-node-profile", name: "Fixture", api: "openai-completions", modelId: "fixture",
      baseUrl: "http://127.0.0.1:9/v1", credentialEnv: CREDENTIAL, contextWindow: 4096, maxTokens: 128,
      reasoning: false, toolCalling: true, vision: false, revision: 1
    },
    role: { id: "settlement-node-role", name: "worker", kind: "worker", instructions: "fixture", profileId: "settlement-node-profile" }
  };
}

async function stoppedNode(t, binding, workspace, missionId, lookup, prepare) {
  const nodeHome = mkdtempSync(join(tmpdir(), "mailbox-settlement-supervisor-"));
  const supervisor = new NodeWorkerSupervisor({
    home: nodeHome, machineId: binding.machineId, sessionId: binding.sessionId, sessionEpoch: binding.sessionEpoch,
    roots: [workspace], credentialRefs: [CREDENTIAL], executionEnabled: true, executionMode: "metadata-only",
    isLeaseCurrent: () => true, testOnlyScripted: true,
    ...(lookup ? { lookupAppliedUploads: lookup } : {})
  });
  t.after(async () => {
    await supervisor.close().catch(() => undefined);
    rmSync(nodeHome, { recursive: true, force: true });
  });
  supervisor.mailbox.open(binding);
  await prepare(supervisor.mailbox);
  const spec = nodeSpec(binding, workspace, missionId);
  await supervisor.start(spec);
  const stopped = await supervisor.stop(binding);
  assert.equal(stopped.confirmedStopped, true);
  return { supervisor, spec };
}

function coordinatorLookup(f) {
  return (oldBinding, entries) => Promise.resolve(f.control.nodeWorkerMailboxSettlement(
    f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, oldBinding, [...entries]
  ).entries);
}

test("settlement query is read-only and matches applied envelope identity", async (t) => {
  const f = fixture(t);
  const binding = f.assignment.binding;
  const nodeDb = new DatabaseSync(":memory:");
  t.after(() => nodeDb.close());
  const node = new DurableWorkerMailbox(nodeDb, "node");
  node.open(binding);
  const envelope = node.enqueue(binding, {
    kind: "rpc", rpcId: "rpc-query", taskId: `${f.agent.id}:query`, method: "Transcript",
    args: { role: "assistant", text: "query", entryId: "query-entry" }
  });
  f.control.workerMailbox.receive(binding, envelope);
  const row = f.control.workerMailbox.inspectInbox(binding)[0];
  const identity = { messageId: envelope.messageId, sequence: envelope.sequence, sha256: row.sha256 };
  const ask = (entry) => f.control.nodeWorkerMailboxSettlement(
    f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, binding, [entry]
  );
  assert.deepEqual(ask(identity).entries, [{ ...identity, applied: false }]);
  f.control.workerMailbox.claim(binding, envelope.messageId);
  assert.equal(ask(identity).entries[0].applied, false);
  assert.equal(f.control.workerMailbox.inspectInbox(binding)[0].status, "processing");
  f.control.workerMailbox.finish(binding, envelope.messageId);
  assert.equal(ask(identity).entries[0].applied, true);
  assert.equal(ask({ ...identity, sha256: "ab".repeat(32) }).entries[0].applied, false);
  f.control.workerMailbox.fence(binding);
  f.control.markAgentInterrupted(f.agent.id, f.agent.epoch);
  const events = f.control.detail(f.mission.id).events.length;
  assert.equal(ask(identity).entries[0].applied, true);
  assert.equal(f.control.workerMailbox.inspectBinding(binding).status, "uncertain");
  assert.equal(f.control.workerMailbox.inspectInbox(binding)[0].status, "applied");
  assert.equal(f.control.detail(f.mission.id).events.length, events);
  assert.throws(() => f.control.nodeWorkerUpload(
    f.enrolled.machine.id, f.enrolled.token, f.session.sessionId, f.session.sessionEpoch, binding, envelope
  ), (error) => error.status === 409);
  assert.throws(() => ask({ ...identity, extra: true }), (error) => error.status === 400);
});

test("uncertain reply to an applied transcript does not block reassignment or replay", async (t) => {
  const f = fixture(t);
  const binding = f.assignment.binding;
  const rpcId = "rpc-transcript";
  const messageId = crypto.randomUUID();
  f.control.workerMailbox.receive(binding, {
    binding, messageId, sequence: 1,
    payload: {
      kind: "rpc", rpcId, taskId: `${f.agent.id}:transcript`, method: "Transcript",
      args: { role: "assistant", text: "kept", entryId: "entry-a" }
    }
  });
  f.control.workerMailbox.claim(binding, messageId);
  const result = await f.control.workerCommand({
    agentId: f.agent.id, epoch: f.agent.epoch, method: "Transcript", taskId: `${f.agent.id}:transcript`,
    args: { role: "assistant", text: "kept", entryId: "entry-a" }
  });
  f.control.workerMailbox.finishWithReply(binding, messageId, { kind: "reply", rpcId, ok: true, result });
  f.control.workerMailbox.pending(binding);
  assert.equal(f.control.workerMailbox.inspectOutbox(binding)[0].status, "offered");
  reportControlledStop(f);
  assert.equal(f.control.workerMailbox.inspectInbox(binding)[0].status, "applied");
  assert.equal(f.control.workerMailbox.inspectOutbox(binding)[0].status, "uncertain");
  const before = snapshot(f);
  const next = f.control.assignRemoteRuntime(f.agent.id);
  assert.notEqual(next.binding.runtimeId, binding.runtimeId);
  assert.equal(f.control.workerMailbox.inspectBinding(binding).status, "closed");
  assertNoReplay(f, before, next);
  assert.equal(f.control.workerMailbox.inspectOutbox(binding)[0].status, "uncertain");
});

test("a lost upload receipt is settled from the same applied inbox evidence on both sides", async (t) => {
  const f = fixture(t);
  const binding = f.assignment.binding;
  const { supervisor, spec } = await stoppedNode(t, binding, f.remotePath, f.mission.id, coordinatorLookup(f), (mailbox) => {
    const envelope = mailbox.enqueue(binding, {
      kind: "rpc", rpcId: "rpc-upload", taskId: `${f.agent.id}:upload`, method: "Usage", args: { cost: 0 }
    });
    mailbox.pending(binding, 1);
    return envelope;
  });
  const upload = supervisor.mailbox.inspectOutbox(binding).find((item) => item.envelope.payload.kind === "rpc" && item.envelope.payload.method === "Usage");
  assert.equal(upload.status, "uncertain");
  f.control.workerMailbox.receive(binding, upload.envelope);
  f.control.workerMailbox.claim(binding, upload.envelope.messageId);
  const result = await f.control.workerCommand({
    agentId: f.agent.id, epoch: binding.epoch, method: "Usage", taskId: `${f.agent.id}:upload`, args: { cost: 0 }
  });
  f.control.workerMailbox.finishWithReply(binding, upload.envelope.messageId, {
    kind: "reply", rpcId: "rpc-upload", ok: true, result
  });
  reportControlledStop(f);
  assert.equal(f.control.workerMailbox.inspectInbox(binding)[0].status, "applied");
  const before = snapshot(f);
  const next = f.control.assignRemoteRuntime(f.agent.id);
  assertNoReplay(f, before, next);
  const nextBinding = { ...binding, runtimeId: crypto.randomUUID(), epoch: binding.epoch + 1 };
  const started = await supervisor.start({ ...spec, binding: nextBinding }, { coordinatorAssigned: true });
  assert.equal(started.live, true);
  assert.equal(supervisor.mailbox.inspectBinding(binding).status, "closed");
  assert.equal(supervisor.mailbox.inspectOutbox(binding).find((item) => item.envelope.messageId === upload.envelope.messageId).status, "uncertain");
  assert.equal(supervisor.mailbox.inspectOutbox(nextBinding).some((item) => item.envelope.messageId === upload.envelope.messageId), false);
  assert.equal(f.control.workerMailbox.inspectInbox(binding)[0].status, "applied");
});

test("effect permit replies, deliveries, and unapplied uploads still fail closed on both sides", async (t) => {
  const effect = fixture(t, "workspace-effects");
  const binding = effect.assignment.binding;
  const rpcId = "rpc-effect";
  const messageId = crypto.randomUUID();
  effect.control.workerMailbox.receive(binding, {
    binding, messageId, sequence: 1,
    payload: { kind: "rpc", rpcId, taskId: `${effect.agent.id}:effect`, method: "read_file", args: { path: "secret.txt" } }
  });
  effect.control.workerMailbox.claim(binding, messageId);
  const permit = await effect.control.workerCommand({
    agentId: effect.agent.id, epoch: effect.agent.epoch, method: "read_file", taskId: `${effect.agent.id}:effect`,
    args: { path: "secret.txt" }
  });
  assert.ok(permit.effectPermit);
  effect.control.workerMailbox.finishWithReply(binding, messageId, { kind: "reply", rpcId, ok: true, result: permit });
  effect.control.workerMailbox.pending(binding);
  reportControlledStop(effect);
  const effectBefore = snapshot(effect);
  assert.throws(() => effect.control.assignRemoteRuntime(effect.agent.id), (error) => error.status === 409 && /uncertain mailbox/.test(error.message));
  assert.deepEqual(snapshot(effect), effectBefore);
  assert.equal(effect.control.db.prepare("SELECT COUNT(*) AS n FROM remote_worker_runtimes WHERE agent_id=?").get(effect.agent.id).n, 1);

  const delivery = fixture(t);
  delivery.control.workerMailbox.enqueue(delivery.assignment.binding, {
    kind: "deliver", messageId: crypto.randomUUID(), requestId: "business-delivery", attempt: 1, content: "do the work", mode: "followUp"
  });
  delivery.control.workerMailbox.pending(delivery.assignment.binding);
  reportControlledStop(delivery);
  assert.throws(() => delivery.control.assignRemoteRuntime(delivery.agent.id), (error) => error.status === 409 && /uncertain mailbox/.test(error.message));

  const unapplied = fixture(t);
  const pendingId = crypto.randomUUID();
  unapplied.control.workerMailbox.receive(unapplied.assignment.binding, {
    binding: unapplied.assignment.binding, messageId: pendingId, sequence: 1,
    payload: { kind: "rpc", rpcId: "rpc-pending", taskId: `${unapplied.agent.id}:pending`, method: "Transcript", args: { role: "assistant", text: "no", entryId: "no" } }
  });
  unapplied.control.workerMailbox.claim(unapplied.assignment.binding, pendingId);
  reportControlledStop(unapplied);
  assert.equal(unapplied.control.workerMailbox.inspectInbox(unapplied.assignment.binding)[0].status, "uncertain");
  assert.throws(() => unapplied.control.assignRemoteRuntime(unapplied.agent.id), (error) => error.status === 409 && /unapplied or uncertain/.test(error.message));
  assert.equal(unapplied.control.transcript(unapplied.agent.id).length, 0);

  const nodeEffect = fixture(t);
  const nodeBinding = nodeEffect.assignment.binding;
  const { supervisor, spec } = await stoppedNode(t, nodeBinding, nodeEffect.remotePath, nodeEffect.mission.id, coordinatorLookup(nodeEffect), (mailbox) => {
    const uploaded = mailbox.enqueue(nodeBinding, {
      kind: "rpc", rpcId: "rpc-node-effect", taskId: `${nodeEffect.agent.id}:node-effect`, method: "read_file", args: { path: "secret.txt" }
    });
    mailbox.pending(nodeBinding, 1);
    mailbox.acknowledge(nodeBinding, {
      messageId: uploaded.messageId, sequence: uploaded.sequence,
      sha256: mailbox.inspectOutbox(nodeBinding).find((item) => item.envelope.messageId === uploaded.messageId).sha256
    });
    const reply = {
      binding: nodeBinding, messageId: crypto.randomUUID(), sequence: 1,
      payload: { kind: "reply", rpcId: "rpc-node-effect", ok: true, result: { effectPermit: { method: "read_file" } } }
    };
    mailbox.receive(nodeBinding, reply);
    mailbox.claim(nodeBinding, reply.messageId);
  });
  const nextBinding = { ...nodeBinding, runtimeId: crypto.randomUUID(), epoch: nodeBinding.epoch + 1 };
  await assert.rejects(() => supervisor.start({ ...spec, binding: nextBinding }, { coordinatorAssigned: true }), /unacknowledged or uncertain work/);
  assert.equal(supervisor.mailbox.inspectInbox(nodeBinding).some((item) => item.status === "uncertain" && item.envelope.payload.kind === "reply"), true);

  const nodeDelivery = fixture(t);
  const deliveryBinding = nodeDelivery.assignment.binding;
  const deliveryNode = await stoppedNode(t, deliveryBinding, nodeDelivery.remotePath, nodeDelivery.mission.id, undefined, (mailbox) => {
    const input = {
      binding: deliveryBinding, messageId: crypto.randomUUID(), sequence: 1,
      payload: { kind: "deliver", messageId: crypto.randomUUID(), requestId: "node-delivery", attempt: 1, content: "work", mode: "followUp" }
    };
    mailbox.receive(deliveryBinding, input);
    mailbox.claim(deliveryBinding, input.messageId);
  });
  await assert.rejects(
    () => deliveryNode.supervisor.start({ ...deliveryNode.spec, binding: { ...deliveryBinding, runtimeId: crypto.randomUUID(), epoch: deliveryBinding.epoch + 1 } }, { coordinatorAssigned: true }),
    /unacknowledged or uncertain work/
  );

  const nodePending = fixture(t);
  const pendingBinding = nodePending.assignment.binding;
  const pendingNode = await stoppedNode(t, pendingBinding, nodePending.remotePath, nodePending.mission.id, async () => [{ messageId: "missing", sequence: 1, sha256: "cd".repeat(32), applied: false }], (mailbox) => {
    mailbox.enqueue(pendingBinding, {
      kind: "rpc", rpcId: "rpc-unapplied", taskId: `${nodePending.agent.id}:unapplied`, method: "Transcript",
      args: { role: "assistant", text: "lost", entryId: "lost" }
    });
    mailbox.pending(pendingBinding, 1);
  });
  const pendingUpload = pendingNode.supervisor.mailbox.inspectOutbox(pendingBinding).find((item) => item.status === "uncertain");
  assert.ok(pendingUpload);
  nodePending.control.workerMailbox.receive(pendingBinding, pendingUpload.envelope);
  nodePending.control.workerMailbox.claim(pendingBinding, pendingUpload.envelope.messageId);
  reportControlledStop(nodePending);
  assert.equal(nodePending.control.workerMailbox.inspectInbox(pendingBinding)[0].status, "uncertain");
  assert.throws(() => nodePending.control.assignRemoteRuntime(nodePending.agent.id), (error) => error.status === 409 && /unapplied or uncertain/.test(error.message));
  await assert.rejects(
    () => pendingNode.supervisor.start({ ...pendingNode.spec, binding: { ...pendingBinding, runtimeId: crypto.randomUUID(), epoch: pendingBinding.epoch + 1 } }, { coordinatorAssigned: true }),
    /unacknowledged or uncertain work/
  );
  assert.equal(pendingNode.supervisor.mailbox.inspectOutbox(pendingBinding).find((item) => item.envelope.messageId === pendingUpload.envelope.messageId).status, "uncertain");
});

test("both gates agree when they read the same applied or missing upload", async (t) => {
  const allowed = fixture(t);
  const binding = allowed.assignment.binding;
  const allowedNode = await stoppedNode(t, binding, allowed.remotePath, allowed.mission.id, coordinatorLookup(allowed), (mailbox) => {
    mailbox.enqueue(binding, {
      kind: "rpc", rpcId: "rpc-same", taskId: `${allowed.agent.id}:same`, method: "GetMissionState", args: {}
    });
    mailbox.pending(binding, 1);
  });
  const upload = allowedNode.supervisor.mailbox.inspectOutbox(binding).find((item) => item.status === "uncertain" && item.envelope.payload.method === "GetMissionState");
  allowed.control.workerMailbox.receive(binding, upload.envelope);
  allowed.control.workerMailbox.claim(binding, upload.envelope.messageId);
  const state = await allowed.control.workerCommand({
    agentId: allowed.agent.id, epoch: binding.epoch, method: "GetMissionState", taskId: `${allowed.agent.id}:same`, args: {}
  });
  allowed.control.workerMailbox.finishWithReply(binding, upload.envelope.messageId, {
    kind: "reply", rpcId: "rpc-same", ok: true, result: JSON.parse(JSON.stringify(state))
  });
  reportControlledStop(allowed);
  const coordinatorNext = allowed.control.assignRemoteRuntime(allowed.agent.id);
  const nodeNext = await allowedNode.supervisor.start(
    { ...allowedNode.spec, binding: { ...binding, runtimeId: crypto.randomUUID(), epoch: binding.epoch + 1 } },
    { coordinatorAssigned: true }
  );
  assert.notEqual(coordinatorNext.binding.runtimeId, binding.runtimeId);
  assert.equal(nodeNext.live, true);
  assert.equal(allowed.control.workerMailbox.inspectInbox(binding)[0].status, "applied");
  assert.equal(allowedNode.supervisor.mailbox.inspectOutbox(binding).find((item) => item.envelope.messageId === upload.envelope.messageId).status, "uncertain");

  const refused = fixture(t);
  const refusedBinding = refused.assignment.binding;
  const refusedNode = await stoppedNode(t, refusedBinding, refused.remotePath, refused.mission.id, coordinatorLookup(refused), (mailbox) => {
    mailbox.enqueue(refusedBinding, {
      kind: "rpc", rpcId: "rpc-missing", taskId: `${refused.agent.id}:missing`, method: "ListAgents", args: {}
    });
    mailbox.pending(refusedBinding, 1);
  });
  const missing = refusedNode.supervisor.mailbox.inspectOutbox(refusedBinding).find((item) => item.status === "uncertain");
  refused.control.workerMailbox.receive(refusedBinding, missing.envelope);
  refused.control.workerMailbox.claim(refusedBinding, missing.envelope.messageId);
  reportControlledStop(refused);
  assert.throws(() => refused.control.assignRemoteRuntime(refused.agent.id), (error) => error.status === 409);
  await assert.rejects(
    () => refusedNode.supervisor.start(
      { ...refusedNode.spec, binding: { ...refusedBinding, runtimeId: crypto.randomUUID(), epoch: refusedBinding.epoch + 1 } },
      { coordinatorAssigned: true }
    ),
    /unacknowledged or uncertain work/
  );
});

test("an RPC that blocks the mission is applied before the controlled stop fences it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mailbox-settlement-block-"));
  const service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0 });
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  const localPath = join(home, "local");
  const remotePath = join(home, "remote");
  mkdirSync(localPath);
  mkdirSync(remotePath);
  const control = service.control;
  const local = control.addWorkspace("Local", localPath);
  const enrolled = control.enrollMachine("block-node", "Block node");
  const session = control.nodeSession(enrolled.machine.id, enrolled.token, {
    protocol: 2, version: "test", platform: process.platform, arch: process.arch, node: process.version, piDurable: "test",
    roots: [remotePath], credentialRefs: [], executionEnabled: true, executionMode: "metadata-only"
  }, crypto.randomUUID());
  const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), remotePath);
  control.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  control.nodeEvent(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch, probe.id, {
    ok: true, result: { requestedPath: remotePath, path: remotePath, isDirectory: true }
  });
  const remote = control.addRemoteWorkspace("Remote", enrolled.machine.id, probe.id);
  const profile = {
    id: "block-profile", name: "Fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "https://models.example.test/v1", credentialEnv: "", contextWindow: 4096, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false, revision: 1
  };
  control.upsertProfile(profile);
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: `block-${kind}`, name: kind, kind, instructions: "fixture", profileId: profile.id });
  }
  const mission = control.missionAction(control.createMission({
    title: "Block on admit", goal: "hit the turn limit", acceptance: "reassign",
    workspaceId: local.id, remoteWorkspaceIds: [remote.id],
    roleIds: ["block-orchestrator", "block-worker", "block-validator"],
    maxTurns: 1, maxCost: 0, autonomy: "trusted", workspaceStrategy: "shared"
  }).id, "start");
  const created = control.createAgent(mission.id, "Remote worker", "block-worker", "fixture", "block-request", remote.id);
  const assignment = control.assignRemoteRuntime(created.id);
  const agent = control.getAgentPublic(created.id);
  const serverFixture = { control, enrolled, session, mission, agent, assignment };
  await control.workerCommand({
    agentId: agent.id, epoch: agent.epoch, method: "AdmitTurn", taskId: `${agent.id}:first`,
    args: { generationId: "generation-used" }
  });
  assert.equal(control.missionById(mission.id).turns, 1);
  assert.equal(control.missionById(mission.id).status, "active");
  const nodeDb = new DatabaseSync(":memory:");
  t.after(() => nodeDb.close());
  const node = new DurableWorkerMailbox(nodeDb, "node");
  node.open(assignment.binding);
  const envelope = node.enqueue(assignment.binding, {
    kind: "rpc", rpcId: "rpc-limit", taskId: `${agent.id}:limit`, method: "AdmitTurn", args: { generationId: "generation-limit" }
  });
  const response = await fetch(`http://127.0.0.1:${service.nodePort}/api/nodes/mailbox/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${enrolled.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      machineId: enrolled.machine.id, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch,
      binding: assignment.binding, envelope
    })
  });
  assert.equal(response.status, 200);
  const deadline = Date.now() + 5000;
  let inboxStatus;
  while (Date.now() < deadline) {
    inboxStatus = control.workerMailbox.inspectInbox(assignment.binding)[0]?.status;
    if (control.missionById(mission.id).status === "blocked" && control.remoteRuntimeForAgent(agent.id).desired === "stop") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(control.missionById(mission.id).status, "blocked");
  assert.equal(inboxStatus, "applied");
  const denials = control.db.prepare("SELECT COUNT(*) AS n FROM generation_denials WHERE agent_id=?").get(agent.id).n;
  reportControlledStop(serverFixture);
  assert.equal(control.workerMailbox.inspectInbox(assignment.binding)[0].status, "applied");
  control.updateMissionLimits(mission.id, 4);
  control.missionAction(mission.id, "resume");
  control.nodePoll(enrolled.machine.id, enrolled.token, session.sessionId, session.sessionEpoch);
  const before = {
    denials,
    inbox: control.workerMailbox.inspectInbox(assignment.binding).map((item) => ({ id: item.envelope.messageId, status: item.status })),
    outbox: control.workerMailbox.inspectOutbox(assignment.binding).map((item) => ({ id: item.envelope.messageId, status: item.status, rpcId: item.envelope.payload.rpcId }))
  };
  const next = control.assignRemoteRuntime(agent.id);
  assert.notEqual(next.binding.runtimeId, assignment.binding.runtimeId);
  assert.equal(control.workerMailbox.inspectBinding(assignment.binding).status, "closed");
  assert.equal(control.workerMailbox.inspectInbox(assignment.binding)[0].status, "applied");
  assert.deepEqual(control.workerMailbox.inspectInbox(assignment.binding).map((item) => ({ id: item.envelope.messageId, status: item.status })), before.inbox);
  assert.deepEqual(control.workerMailbox.inspectOutbox(assignment.binding).map((item) => ({ id: item.envelope.messageId, status: item.status, rpcId: item.envelope.payload.rpcId })), before.outbox);
  assert.equal(control.db.prepare("SELECT COUNT(*) AS n FROM generation_denials WHERE agent_id=?").get(agent.id).n, denials);
  assert.equal(control.workerMailbox.inspectInbox(next.binding).length, 0);
  assert.equal(control.workerMailbox.inspectOutbox(next.binding).some((item) => item.envelope.payload.rpcId === "rpc-limit"), false);
});

test("the node client accepts a read-only settlement answer and rejects a malformed one", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mailbox-settlement-client-"));
  const service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0 });
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  const control = service.control;
  const enrolled = control.enrollMachine("client-node", "Client node");
  const session = control.nodeSession(enrolled.machine.id, enrolled.token, {
    protocol: 2, version: "test", platform: process.platform, arch: process.arch, node: process.version, piDurable: "test",
    roots: [home], credentialRefs: [], executionEnabled: true, executionMode: "metadata-only"
  }, crypto.randomUUID());
  const binding = {
    runtimeId: crypto.randomUUID(), machineId: enrolled.machine.id, sessionId: session.sessionId,
    sessionEpoch: session.sessionEpoch, agentId: "client-agent", epoch: 1
  };
  control.db.prepare("INSERT INTO agents(id,mission_id,status,epoch,data) VALUES(?,?,?,?,?)").run(
    binding.agentId, "client-mission", "idle", 3, JSON.stringify({ id: binding.agentId, missionId: "client-mission", machineId: binding.machineId, epoch: 3, status: "idle" })
  );
  control.workerMailbox.open(binding);
  const nodeDb = new DatabaseSync(":memory:");
  t.after(() => nodeDb.close());
  const node = new DurableWorkerMailbox(nodeDb, "node");
  node.open(binding);
  const envelope = node.enqueue(binding, { kind: "notice", notice: { type: "ready", agentId: binding.agentId, epoch: binding.epoch } });
  control.workerMailbox.receive(binding, envelope);
  control.workerMailbox.claim(binding, envelope.messageId);
  control.workerMailbox.finish(binding, envelope.messageId);
  control.workerMailbox.fence(binding);
  const row = control.workerMailbox.inspectInbox(binding)[0];
  const base = `http://127.0.0.1:${service.nodePort}`;
  const answers = await queryAppliedMailboxUploads(base, enrolled.token, {
    machineId: enrolled.machine.id, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch
  }, binding, [{ messageId: envelope.messageId, sequence: envelope.sequence, sha256: row.sha256 }]);
  assert.deepEqual(answers, [{ messageId: envelope.messageId, sequence: envelope.sequence, sha256: row.sha256, applied: true }]);
  assert.equal(control.workerMailbox.inspectBinding(binding).status, "uncertain");
  assert.equal(control.workerMailbox.inspectInbox(binding)[0].status, "applied");
  const tampered = await fetch(`${base}/api/nodes/mailbox/settlement`, {
    method: "POST",
    headers: { authorization: `Bearer ${enrolled.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      machineId: enrolled.machine.id, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch,
      binding, entries: [{ messageId: envelope.messageId, sequence: envelope.sequence, sha256: row.sha256 }], envelope
    })
  });
  assert.equal(tampered.status, 400);
  assert.equal(control.workerMailbox.inspectInbox(binding).length, 1);
});
