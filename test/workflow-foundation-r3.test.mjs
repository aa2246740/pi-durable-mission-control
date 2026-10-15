import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fetchJson } from "../dist/node.js";
import { startServer } from "../dist/server.js";
import { DurableWorkerMailbox, parseWorkerEnvelope } from "../dist/worker-mailbox.js";

function snapshotProfile() {
  return {
    id: "profile-old", name: "Old profile", api: "openai-completions", modelId: "synthetic-old-model",
    baseUrl: "http://127.0.0.1:9/v1", credentialEnv: "SYNTHETIC_OLD_KEY", contextWindow: 8000, maxTokens: 256,
    reasoning: true, toolCalling: true, vision: false, revision: 4, available: true,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 }
  };
}

function foundationBindings() {
  return ["orchestrator", "worker", "task-validator", "scrutiny", "user-testing"].map((slot) => {
    const kind = slot === "orchestrator" ? "orchestrator" : slot === "worker" ? "worker" : "validator";
    const roleId = `role-${slot}`;
    return {
      slot, expectedRoleId: roleId, reasoningEffort: "high",
      resolved: {
        profileId: "profile-old", profileRevision: 4, profileSnapshot: snapshotProfile(),
        roleId, roleRevision: 2, reasoningEffort: "high", adapterVersion: "adapter-v1",
        roleSnapshot: {
          id: roleId, name: `${slot} role`, kind, instructions: `Synthetic instructions for ${slot}`, profileId: "profile-old",
          ...(kind === "validator" ? { mcpPermissions: [{ serverId: "synthetic-server", toolName: "synthetic_tool", mode: "approve" }] } : {})
        }
      }
    };
  });
}

async function serviceFor(t, gate) {
  const previous = process.env.MC_ENABLE_MISSION_PARITY;
  if (gate === undefined) delete process.env.MC_ENABLE_MISSION_PARITY;
  else process.env.MC_ENABLE_MISSION_PARITY = gate;
  const home = mkdtempSync(join(tmpdir(), "mission-r3-"));
  const localPath = join(home, "local");
  const remotePath = join(home, "remote");
  mkdirSync(localPath);
  mkdirSync(remotePath);
  const service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0, testOnlyScripted: true });
  if (previous === undefined) delete process.env.MC_ENABLE_MISSION_PARITY;
  else process.env.MC_ENABLE_MISSION_PARITY = previous;
  t.after(async () => {
    await service.close();
    rmSync(home, { recursive: true, force: true });
  });
  const control = service.control;
  const local = control.addWorkspace("Local", localPath);
  const enrolled = control.enrollMachine(`r3-${crypto.randomUUID()}`, "R3 node");
  const capabilities = {
    protocol: 3, version: "test", platform: process.platform, arch: process.arch, node: process.version,
    piDurable: "test", roots: [remotePath], credentialRefs: [], executionEnabled: true,
    executionMode: "workspace-effects", effectApprovals: true
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
  const roleIds = ["orchestrator", "worker", "validator"].map((kind) => `${kind}-${crypto.randomUUID()}`);
  for (let index = 0; index < roleIds.length; index += 1) {
    control.upsertRole({
      id: roleIds[index], name: roleIds[index], kind: ["orchestrator", "worker", "validator"][index],
      instructions: "fixture", profileId: profile.id
    });
  }
  return { service, control, home, local, remote, enrolled, session, roleIds, localPath };
}

function createRemoteMission(env, title) {
  const mission = env.control.createMission({
    title, goal: "stored parity must not run", acceptance: "no permit",
    workspaceId: env.local.id, remoteWorkspaceIds: [env.remote.id], roleIds: env.roleIds,
    maxTurns: 8, maxCost: 0, autonomy: "approve", workspaceStrategy: "shared"
  });
  env.control.missionAction(mission.id, "start");
  const agent = env.control.createAgent(mission.id, "Worker", env.roleIds[1], "fixture", `worker-${crypto.randomUUID()}`, env.remote.id);
  const assignment = env.control.assignRemoteRuntime(agent.id);
  env.control.remoteRuntimeReady(assignment.binding);
  return { mission, agent: env.control.getAgentPublic(agent.id), assignment };
}

function storeParity(env, missionId) {
  env.control.recordFoundationWorkflow(missionId, { policy: {}, roleBindings: foundationBindings() });
}

function executablePayload(kind, created) {
  if (kind === "deliver") {
    return {
      kind: "deliver", messageId: `msg-${crypto.randomUUID()}`, requestId: `req-${crypto.randomUUID()}`,
      attempt: 1, content: "historical work", mode: "followUp"
    };
  }
  if (kind === "approved-effect") {
    return {
      kind: "approved-effect", approvalId: `approval-${crypto.randomUUID()}`,
      permit: {
        binding: created.assignment.binding, descriptorHash: created.assignment.descriptorHash,
        taskId: `${created.agent.id}:historical`, method: "write_file",
        args: { path: "approved.txt", content: "historical" }, expiresAt: Date.now() + 10_000
      }
    };
  }
  return {
    kind: "reply", rpcId: `rpc-permit-${crypto.randomUUID()}`, ok: true,
    result: { effectPermit: { method: "read_file", taskId: `${created.agent.id}:historical` } }
  };
}

function evidencePayload() {
  return { kind: "reply", rpcId: `rpc-evidence-${crypto.randomUUID()}`, ok: true, result: { recorded: true } };
}

function enqueueQueue(env, created, payloads) {
  return payloads.map((payload) => env.control.workerMailbox.enqueue(created.assignment.binding, payload, crypto.randomUUID()));
}

function outboxRow(env, binding, messageId) {
  return env.control.workerMailbox.inspectOutbox(binding).find((row) => row.envelope.messageId === messageId);
}

function poll(env, binding) {
  return env.control.nodeWorkerPoll(
    env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch, binding
  );
}

function ack(env, binding, envelope) {
  const row = outboxRow(env, binding, envelope.messageId);
  return env.control.nodeWorkerAck(
    env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch, binding,
    { messageId: envelope.messageId, sequence: envelope.sequence, sha256: row.sha256 }
  );
}

function commandCount(control, missionId) {
  return control.db.prepare("SELECT count(*) AS n FROM commands WHERE scope=?").get(`mission:${missionId}:remote-effects`).n;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for mailbox application");
}

test("parity read replies progress and a blocked executable head is fenced in place", async (t) => {
  for (const gate of [undefined, "0", "1"]) {
    const env = await serviceFor(t, gate);
    const label = gate ?? "default";
    for (const kind of ["deliver", "approved-effect", "effect-permit"]) {
      for (const history of ["queued", "offered"]) {
        const created = createRemoteMission(env, `${label} ${kind} ${history}`);
        const executable = executablePayload(kind, created);
        const evidence = evidencePayload();
        const payloads = [executable, evidence, { kind: "abort" }, { kind: "shutdown" }];
        const queued = enqueueQueue(env, created, payloads);
        if (history === "offered") env.control.workerMailbox.pending(created.assignment.binding, 1);
        const before = queued.map((envelope) => outboxRow(env, created.assignment.binding, envelope.messageId));
        storeParity(env, created.mission.id);
        const first = poll(env, created.assignment.binding);
        assert.equal(first.envelopes.length, 0, `${label} ${kind} ${history} poll`);
        assert.equal(env.control.workerMailbox.inspectBinding(created.assignment.binding).status, "uncertain", `${label} ${kind} ${history} binding`);
        const after = before.map((row) => outboxRow(env, created.assignment.binding, row.envelope.messageId));
        assert.equal(after.length, 4);
        assert.equal(after[0].status, history === "offered" ? "uncertain" : "cancelled", `${label} ${kind} ${history} head`);
        assert.deepEqual(after.slice(1).map((row) => row.status), ["cancelled", "cancelled", "cancelled"]);
        for (let index = 0; index < before.length; index += 1) {
          assert.equal(after[index].sha256, before[index].sha256);
          assert.deepEqual(after[index].envelope.payload, before[index].envelope.payload);
          assert.notEqual(after[index].status, "offered");
          assert.notEqual(after[index].status, "acknowledged");
        }
        assert.equal(env.control.remoteRuntimes.byRuntime(created.assignment.binding.runtimeId).desired, "stop");
        assert.equal(env.control.remoteRuntimes.byRuntime(created.assignment.binding.runtimeId).state, "stopping");
        assert.throws(() => poll(env, created.assignment.binding), (error) => error.status === 409);
        const runtime = env.control.remoteRuntimes.byRuntime(created.assignment.binding.runtimeId);
        if (history === "offered") {
          assert.throws(() => env.control.assertRemoteRuntimeReassignable(runtime, created.agent), /trusted reconciliation is required/);
          assert.equal(env.control.workerMailbox.inspectBinding(created.assignment.binding).status, "uncertain");
          assert.equal(outboxRow(env, created.assignment.binding, before[0].envelope.messageId).status, "uncertain");
        } else {
          assert.equal(env.control.workerMailbox.inspectBinding(created.assignment.binding).status, "uncertain");
          assert.equal(env.control.workerMailbox.inspectOutbox(created.assignment.binding)
            .every((row) => row.status === "cancelled" && env.control.workerMailbox.outboxSettledForStop(created.assignment.binding, row.envelope.messageId)), true);
        }
      }
    }
    for (const kind of ["deliver", "approved-effect", "effect-permit"]) {
      for (const history of ["queued", "offered"]) {
        const created = createRemoteMission(env, `${label} safe-first ${kind} ${history}`);
        const executable = executablePayload(kind, created);
        const payloads = [evidencePayload(), { kind: "abort" }, { kind: "shutdown" }, executable];
        const queued = enqueueQueue(env, created, payloads);
        if (history === "offered") env.control.workerMailbox.pending(created.assignment.binding, 4);
        storeParity(env, created.mission.id);
        for (const expected of ["reply", "abort", "shutdown"]) {
          const offered = poll(env, created.assignment.binding);
          assert.equal(offered.envelopes.length, 1, `${label} safe-first ${kind} ${history} ${expected}`);
          assert.equal(offered.envelopes[0].payload.kind, expected);
          if (expected === "reply") assert.equal(offered.envelopes[0].payload.result.recorded, true);
          assert.equal(ack(env, created.assignment.binding, offered.envelopes[0]).acknowledged, true);
        }
        const tail = poll(env, created.assignment.binding);
        assert.equal(tail.envelopes.length, 0);
        const executableRow = outboxRow(env, created.assignment.binding, queued[3].messageId);
        assert.equal(executableRow.status, history === "offered" ? "offered" : "queued");
        assert.equal(env.control.workerMailbox.inspectBinding(created.assignment.binding).status, "open");
        assert.equal(env.control.remoteRuntimes.byRuntime(created.assignment.binding.runtimeId).desired, "run");
      }
    }
    const classic = createRemoteMission(env, `${label} classic after fence`);
    env.control.db.prepare("UPDATE remote_worker_runtimes SET state='queued',desired='run',last_offered_at=NULL WHERE runtime_id=?").run(classic.assignment.binding.runtimeId);
    let classicOffered = false;
    for (let attempt = 0; attempt < 40 && !classicOffered; attempt += 1) {
      const directives = env.control.nodeRuntimePoll(env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch).directives;
      classicOffered = directives.some((directive) => directive.action === "start" && directive.descriptor.binding.runtimeId === classic.assignment.binding.runtimeId);
    }
    assert.equal(classicOffered, true, `${label} classic start`);
    const classicShutdown = env.control.workerMailbox.enqueue(classic.assignment.binding, { kind: "shutdown" });
    assert.equal(poll(env, classic.assignment.binding).envelopes[0].messageId, classicShutdown.messageId);
    const acknowledged = createRemoteMission(env, `${label} ack offered head`);
    const permit = env.control.workerMailbox.enqueue(acknowledged.assignment.binding, executablePayload("approved-effect", acknowledged));
    const trailing = env.control.workerMailbox.enqueue(acknowledged.assignment.binding, evidencePayload());
    env.control.workerMailbox.pending(acknowledged.assignment.binding, 1);
    storeParity(env, acknowledged.mission.id);
    assert.equal(ack(env, acknowledged.assignment.binding, permit).acknowledged, true);
    const unblocked = poll(env, acknowledged.assignment.binding);
    assert.equal(unblocked.envelopes[0].messageId, trailing.messageId);
    assert.equal(unblocked.envelopes[0].payload.result.recorded, true);
    assert.equal(env.control.workerMailbox.inspectBinding(acknowledged.assignment.binding).status, "open");
  }
});

test("HTTP read replies are delivered in order and remote read_file issues no permit", async (t) => {
  for (const gate of [undefined, "0", "1"]) {
    const env = await serviceFor(t, gate);
    const label = gate ?? "default";
    const created = createRemoteMission(env, `${label} reads`);
    storeParity(env, created.mission.id);
    writeFileSync(join(env.localPath, "note.txt"), "local-note");
    const localAgent = env.control.getAgentPublic(env.control.createAgent(
      created.mission.id, "Local reader", env.roleIds[1], "fixture", `local-${crypto.randomUUID()}`
    ).id);
    const localRead = await env.control.workerCommand({
      id: "local-read", agentId: localAgent.id, epoch: localAgent.epoch, method: "read_file",
      args: { path: "note.txt" }, taskId: `${localAgent.id}:local-read`
    });
    assert.match(localRead.content, /local-note/);
    assert.equal(commandCount(env.control, created.mission.id), 0);
    const classic = createRemoteMission(env, `${label} classic read`);
    const classicPermit = await env.control.workerCommand({
      id: "classic-read", agentId: classic.agent.id, epoch: classic.agent.epoch, method: "read_file",
      args: { path: "source.txt" }, taskId: `${classic.agent.id}:classic-read`
    });
    assert.equal(classicPermit.effectPermit.method, "read_file");
    assert.equal(commandCount(env.control, classic.mission.id), 1);
    await assert.rejects(() => env.control.workerCommand({
      id: "parity-read", agentId: created.agent.id, epoch: created.agent.epoch, method: "read_file",
      args: { path: "source.txt" }, taskId: `${created.agent.id}:parity-read`
    }), (error) => error.status === 409 && error.code === "CAPABILITY_UNAVAILABLE");
    assert.equal(commandCount(env.control, created.mission.id), 0);
    assert.equal(env.control.db.prepare("SELECT count(*) AS n FROM events WHERE mission_id=? AND type='remote_effect_authorized'").get(created.mission.id).n, 0);
    const nodeDb = new DatabaseSync(":memory:");
    t.after(() => nodeDb.close());
    const node = new DurableWorkerMailbox(nodeDb, "node");
    node.open(created.assignment.binding);
    const base = new URL(`http://127.0.0.1:${env.service.nodePort}`);
    const identity = {
      machineId: env.enrolled.machine.id, sessionId: env.session.sessionId, sessionEpoch: env.session.sessionEpoch,
      binding: created.assignment.binding
    };
    const uploads = [
      { method: "GetMissionState", args: {}, taskId: `${created.agent.id}:state` },
      { method: "ListAgents", args: {}, taskId: `${created.agent.id}:agents` },
      { method: "Transcript", args: { role: "assistant", text: "evidence", entryId: `entry-${crypto.randomUUID()}` }, taskId: `${created.agent.id}:transcript` },
      { method: "read_file", args: { path: "source.txt" }, taskId: `${created.agent.id}:remote-read` }
    ];
    for (const request of uploads) {
      node.enqueue(created.assignment.binding, {
        kind: "rpc", rpcId: crypto.randomUUID(), taskId: request.taskId, method: request.method, args: request.args
      });
      const envelope = node.pending(created.assignment.binding, 1)[0];
      const receipt = await fetchJson(base, "/api/nodes/mailbox/upload", env.enrolled.token, { ...identity, envelope });
      node.acknowledge(created.assignment.binding, receipt);
      await waitFor(() => env.control.workerMailbox.inspectInbox(created.assignment.binding)
        .some((row) => row.envelope.messageId === envelope.messageId && row.status === "applied"));
    }
    assert.equal(commandCount(env.control, created.mission.id), 0);
    const kinds = [];
    for (let index = 0; index < 4; index += 1) {
      const body = await fetchJson(base, "/api/nodes/mailbox/poll", env.enrolled.token, identity);
      assert.equal(body.envelopes.length, 1, `${label} read poll ${index}`);
      const envelope = parseWorkerEnvelope(body.envelopes[0]);
      assert.equal(envelope.payload.kind, "reply");
      kinds.push(envelope.payload.ok ? envelope.payload.result : { rejected: true });
      const accepted = await fetchJson(base, "/api/nodes/mailbox/ack", env.enrolled.token, {
        ...identity,
        receipt: node.receive(created.assignment.binding, envelope)
      });
      assert.equal(accepted.acknowledged, true);
    }
    assert.equal(typeof kinds[0].mission, "object");
    assert.equal(Array.isArray(kinds[1]), true);
    assert.equal(kinds[2].recorded, true);
    assert.equal(kinds[3].rejected, true);
    assert.equal(env.control.workerMailbox.inspectBinding(created.assignment.binding).status, "open");
    assert.equal(env.control.remoteRuntimes.byRuntime(created.assignment.binding.runtimeId).desired, "run");
    assert.equal(commandCount(env.control, created.mission.id), 0);
    const classicMailbox = createRemoteMission(env, `${label} classic mailbox`);
    const shutdown = env.control.workerMailbox.enqueue(classicMailbox.assignment.binding, { kind: "shutdown" });
    const classicPoll = poll(env, classicMailbox.assignment.binding);
    assert.equal(classicPoll.envelopes[0].messageId, shutdown.messageId);
    env.control.db.prepare("UPDATE remote_worker_runtimes SET state='queued',desired='run',last_offered_at=NULL WHERE runtime_id=?").run(classicMailbox.assignment.binding.runtimeId);
    const started = env.control.nodeRuntimePoll(env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch);
    assert.equal(started.directives[0].action, "start");
    assert.equal(started.directives[0].descriptor.binding.runtimeId, classicMailbox.assignment.binding.runtimeId);
  }
});

test("classic pending(limit) does not parse or roll back past its limit", () => {
  for (const side of ["node", "coordinator"]) {
    const binding = {
      runtimeId: crypto.randomUUID(), machineId: "machine", sessionId: "session", sessionEpoch: 1,
      agentId: "agent", epoch: 1
    };
    const payload = side === "node"
      ? { kind: "rpc", rpcId: "rpc-1", taskId: "task-1", method: "GetMissionState", args: {} }
      : { kind: "shutdown" };
    const limited = new DatabaseSync(":memory:");
    const withinLimit = new DurableWorkerMailbox(limited, side);
    withinLimit.open(binding);
    const first = withinLimit.enqueue(binding, payload, "first-message");
    const second = withinLimit.enqueue(binding, side === "node"
      ? { kind: "rpc", rpcId: "rpc-2", taskId: "task-2", method: "ListAgents", args: {} }
      : { kind: "abort" }, "second-message");
    limited.prepare("UPDATE worker_mailbox_outbox SET envelope_json=? WHERE message_id=?").run("{\"broken\":true}", second.messageId);
    const selected = withinLimit.pending(binding, 1);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].messageId, first.messageId);
    assert.equal(withinLimit.inspectOutboxMessage(binding, first.messageId).status, "offered");
    assert.equal(limited.prepare("SELECT status FROM worker_mailbox_outbox WHERE message_id=?").get(second.messageId).status, "queued");
    const filtered = new DatabaseSync(":memory:");
    const filteredMailbox = new DurableWorkerMailbox(filtered, side);
    filteredMailbox.open(binding);
    filteredMailbox.enqueue(binding, payload, "filtered-first");
    const filteredSecond = filteredMailbox.enqueue(binding, side === "node"
      ? { kind: "rpc", rpcId: "rpc-3", taskId: "task-3", method: "Usage", args: {} }
      : { kind: "abort" }, "filtered-second");
    filtered.prepare("UPDATE worker_mailbox_outbox SET envelope_json=? WHERE message_id=?").run("{\"broken\":true}", filteredSecond.messageId);
    assert.equal(filteredMailbox.pending(binding, 1, () => true).length, 1);
    assert.equal(filteredMailbox.inspectOutboxMessage(binding, "filtered-first").status, "offered");
    const bounded = new DatabaseSync(":memory:");
    const both = new DurableWorkerMailbox(bounded, side);
    both.open(binding);
    both.enqueue(binding, payload, "bounded-first");
    const corrupt = both.enqueue(binding, side === "node"
      ? { kind: "rpc", rpcId: "rpc-4", taskId: "task-4", method: "Transcript", args: {} }
      : { kind: "abort" }, "bounded-second");
    bounded.prepare("UPDATE worker_mailbox_outbox SET envelope_json=? WHERE message_id=?").run("{\"broken\":true}", corrupt.messageId);
    assert.throws(() => both.pending(binding, 2), /invalid envelope hash/);
    assert.equal(bounded.prepare("SELECT status FROM worker_mailbox_outbox WHERE message_id=?").get("bounded-first").status, "queued");
    assert.equal(bounded.prepare("SELECT status FROM worker_mailbox_outbox WHERE message_id=?").get(corrupt.messageId).status, "queued");
    limited.close();
    filtered.close();
    bounded.close();
  }
});
