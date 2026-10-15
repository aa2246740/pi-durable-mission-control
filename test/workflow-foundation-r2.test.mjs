import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../dist/server.js";

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
  const home = mkdtempSync(join(tmpdir(), "mission-r2-"));
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
  const enrolled = control.enrollMachine(`r2-${crypto.randomUUID()}`, "R2 node");
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
  const token = readFileSync(join(home, "control", "admin.token"), "utf8").trim();
  return { service, control, home, local, remote, enrolled, session, capabilities, roleIds, token, remotePath };
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

function requestEffect(agent, task, rpcId) {
  return {
    id: rpcId, agentId: agent.id, epoch: agent.epoch, method: "write_file",
    args: { path: "approved.txt", content: "node" }, taskId: `${agent.id}:${task}`
  };
}

function approvalData(control, id) {
  return JSON.parse(control.db.prepare("SELECT data FROM approvals WHERE id=?").get(id).data);
}

function permits(control, binding) {
  return control.workerMailbox.inspectOutbox(binding).filter(({ envelope }) => envelope.payload.kind === "approved-effect");
}

test("parity does not issue remote permits through HTTP or maintenance", async (t) => {
  for (const gate of [undefined, "1"]) {
    const env = await serviceFor(t, gate);
    const httpMission = createRemoteMission(env, "HTTP permit");
    const httpRequest = requestEffect(httpMission.agent, "http", "rpc-http");
    const httpPending = await env.control.workerCommand(httpRequest);
    env.control.workerMailbox.enqueue(httpMission.assignment.binding, {
      kind: "reply", rpcId: "rpc-http", ok: true, result: { status: "pending", approvalId: httpPending.approvalId }
    }, `pending:${httpPending.approvalId}`);
    const maintenanceMission = createRemoteMission(env, "Maintenance permit");
    const maintenanceRequest = requestEffect(maintenanceMission.agent, "maintain", "rpc-maintain");
    const maintenancePending = await env.control.workerCommand(maintenanceRequest);
    env.control.resolveApproval(maintenancePending.approvalId, "approved");
    env.control.workerMailbox.enqueue(maintenanceMission.assignment.binding, {
      kind: "reply", rpcId: "rpc-maintain", ok: true, result: { status: "pending", approvalId: maintenancePending.approvalId }
    }, `pending:${maintenancePending.approvalId}`);
    env.control.recordFoundationWorkflow(httpMission.mission.id, { policy: {}, roleBindings: foundationBindings() });
    env.control.recordFoundationWorkflow(maintenanceMission.mission.id, { policy: {}, roleBindings: foundationBindings() });
    const response = await fetch(`http://127.0.0.1:${env.service.port}/api/approvals/${httpPending.approvalId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.token}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" })
    });
    const body = await response.json();
    assert.equal(response.status, 409, gate ?? "default");
    assert.equal(body.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(approvalData(env.control, httpPending.approvalId).status, "approved");
    assert.equal(permits(env.control, httpMission.assignment.binding).length, 0);
    env.control.reconcileRemoteEffectApprovals();
    assert.equal(approvalData(env.control, maintenancePending.approvalId).status, "approved");
    assert.equal(permits(env.control, maintenanceMission.assignment.binding).length, 0);
    assert.equal(env.control.db.prepare("SELECT count(*) AS n FROM commands WHERE scope=? AND command_id=?")
      .get(`mission:${maintenanceMission.mission.id}:remote-effects`, maintenanceRequest.taskId).n, 0);
  }
});

test("parity runtime starts and executable downlink stay unoffered without starving other work", async (t) => {
  for (const gate of [undefined, "1"]) {
    const env = await serviceFor(t, gate);
    const parity = createRemoteMission(env, "Parity runtime");
    const classic = createRemoteMission(env, "Classic runtime");
    env.control.recordFoundationWorkflow(parity.mission.id, { policy: {}, roleBindings: foundationBindings() });
    const parityRuntime = env.control.remoteRuntimeForAgent(parity.agent.id);
    const classicRuntime = env.control.remoteRuntimeForAgent(classic.agent.id);
    assert.equal(parityRuntime.state, "running");
    env.control.db.prepare("UPDATE remote_worker_runtimes SET state='queued',desired='run',last_offered_at=NULL WHERE runtime_id=?").run(parityRuntime.runtime_id);
    env.control.db.prepare("UPDATE remote_worker_runtimes SET state='queued',desired='run',last_offered_at=NULL,created_at=? WHERE runtime_id=?")
      .run(parityRuntime.created_at + 1, classicRuntime.runtime_id);
    const polled = env.control.nodeRuntimePoll(env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch);
    assert.equal(polled.directives.length, 1);
    assert.equal(polled.directives[0].action, "start");
    assert.equal(polled.directives[0].descriptor.binding.agentId, classic.agent.id);
    assert.equal(env.control.remoteRuntimes.byRuntime(parityRuntime.runtime_id).state, "queued");
    assert.equal(env.control.remoteRuntimes.byRuntime(classicRuntime.runtime_id).state, "offered");
    env.control.remoteRuntimes.requestStop(parity.assignment.binding, "controlled", parity.agent.epoch);
    const stopped = env.control.nodeRuntimePoll(env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch);
    assert.equal(stopped.directives.some((directive) => directive.action === "stop" && directive.binding.runtimeId === parityRuntime.runtime_id), true);
    assert.equal(env.control.remoteRuntimes.byRuntime(parityRuntime.runtime_id).desired, "stop");
  }
});

test("an already queued parity effect is not offered after safe mailbox traffic", async (t) => {
  for (const gate of [undefined, "1"]) {
    const env = await serviceFor(t, gate);
    const parity = createRemoteMission(env, "Queued effect");
    env.control.recordFoundationWorkflow(parity.mission.id, { policy: {}, roleBindings: foundationBindings() });
    const shutdown = env.control.workerMailbox.enqueue(parity.assignment.binding, { kind: "shutdown" }, `shutdown-${crypto.randomUUID()}`);
    env.control.workerMailbox.enqueue(parity.assignment.binding, {
      kind: "approved-effect", approvalId: "parity-existing-permit",
      permit: {
        binding: parity.assignment.binding, descriptorHash: parity.assignment.descriptorHash,
        taskId: `${parity.agent.id}:existing`, method: "write_file",
        args: { path: "approved.txt", content: "node" }, expiresAt: Date.now() + 10_000
      }
    }, "parity-existing-permit");
    const first = env.control.nodeWorkerPoll(env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch, parity.assignment.binding);
    assert.equal(first.envelopes[0]?.payload.kind, "shutdown");
    const shutdownRow = env.control.workerMailbox.inspectOutbox(parity.assignment.binding)
      .find((row) => row.envelope.messageId === shutdown.messageId);
    assert.equal(env.control.nodeWorkerAck(env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch, parity.assignment.binding, {
      messageId: shutdown.messageId, sequence: shutdown.sequence, sha256: shutdownRow.sha256
    }).acknowledged, true);
    const second = env.control.nodeWorkerPoll(env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch, parity.assignment.binding);
    assert.equal(second.envelopes.some((envelope) => envelope.payload.kind === "approved-effect"), false);
    assert.equal(env.control.workerMailbox.inspectOutbox(parity.assignment.binding)
      .find((row) => row.envelope.messageId === "parity-existing-permit").status, "queued");
  }
});

test("running parity approvals still accept uncertain receipts and settlement stays readable", async (t) => {
  const env = await serviceFor(t, "0");
  const ready = createRemoteMission(env, "Already running");
  const effect = requestEffect(ready.agent, "running", "rpc-running");
  const pending = await env.control.workerCommand(effect);
  env.control.resolveApproval(pending.approvalId, "approved");
  env.control.workerMailbox.enqueue(ready.assignment.binding, {
    kind: "reply", rpcId: "rpc-running", ok: true, result: { status: "pending", approvalId: pending.approvalId }
  }, `pending:${pending.approvalId}`);
  env.control.reconcileRemoteEffectApprovals();
  assert.equal(approvalData(env.control, pending.approvalId).status, "running");
  env.control.recordFoundationWorkflow(ready.mission.id, { policy: {}, roleBindings: foundationBindings() });
  const runtime = env.control.remoteRuntimeForAgent(ready.agent.id);
  const { nodeEffectUpload } = await import("../dist/node-effects.js");
  const upload = nodeEffectUpload({
    binding: ready.assignment.binding, descriptorHash: runtime.descriptor_hash,
    taskId: effect.taskId, method: "write_file", args: effect.args
  }, { status: "uncertain", error: "connection dropped" });
  const ack = env.control.nodeEffectReceipt(env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch, upload);
  assert.equal(ack.duplicate, false);
  env.control.reconcileRemoteEffectApprovals();
  assert.equal(approvalData(env.control, pending.approvalId).status, "uncertain");
  const settlement = env.control.nodeWorkerMailboxSettlement(
    env.enrolled.machine.id, env.enrolled.token, env.session.sessionId, env.session.sessionEpoch,
    ready.assignment.binding, [{ messageId: "missing-message", sequence: 1, sha256: "a".repeat(64) }]
  );
  assert.equal(settlement.entries[0].applied, false);
});

test("early node-route rejections stay classic on both listeners", async (t) => {
  const env = await serviceFor(t, undefined);
  const listeners = [["administrator", env.service.port], ["node", env.service.nodePort]];
  for (const [name, port] of listeners) {
    for (const [label, headers] of [
      ["origin", { origin: "http://evil.example" }],
      ["cross-site", { "sec-fetch-site": "cross-site" }]
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/nodes/poll`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}"
      });
      assert.equal(response.status, 403, `${name} ${label}`);
      const body = await response.json();
      assert.equal(typeof body.error, "string");
      assert.equal("code" in body, false, `${name} ${label}`);
    }
  }
  const admin = await fetch(`http://127.0.0.1:${env.service.port}/api/state`, { headers: { origin: "http://evil.example" } });
  assert.equal(admin.status, 403);
  assert.equal((await admin.json()).code, "OPERATION_REJECTED");
  const foreignHost = await postRaw(env.service.port, "/api/nodes/session", { host: "evil.example", "content-type": "application/json" }, "{}");
  assert.equal(foreignHost.status, 403);
  assert.equal(foreignHost.body.error, "Host is not a loopback host");
  assert.equal("code" in foreignHost.body, false);
  const adminHost = await postRaw(env.service.port, "/api/state", { host: "evil.example" }, "");
  assert.equal(adminHost.status, 403);
  assert.equal(adminHost.body.code, "OPERATION_REJECTED");
});

function postRaw(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method: "POST", headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : {} });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}
