import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { CoordinatorSessionExpired, fetchJson } from "../dist/node.js";
import { startServer } from "../dist/server.js";
import { WorkerManager } from "../dist/workers.js";
import { canonicalJson, parseJsonText, parseRoleBindings, parseWorkflowPolicyRequest, workflowDigest } from "../dist/workflow-schema.js";

function homeOf(t) {
  const root = mkdtempSync(join(tmpdir(), "mission-r1-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(realpathSync(root), "home");
}

function profile(id, reasoning = true) {
  return {
    id, name: id, api: "openai-completions", modelId: "synthetic-r1", baseUrl: "http://127.0.0.1:9/v1",
    credentialEnv: "", contextWindow: 8000, maxTokens: 256, reasoning, toolCalling: true, vision: false,
    revision: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

function snapshotProfile(reasoning = true) {
  return {
    id: "profile-old", name: "Old profile", api: "openai-completions", modelId: "synthetic-old-model",
    baseUrl: "http://127.0.0.1:9/v1", credentialEnv: "SYNTHETIC_OLD_KEY", contextWindow: 8000, maxTokens: 256,
    reasoning, toolCalling: true, vision: false, revision: 4, available: true,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 }
  };
}

function bindings({ requested = undefined, resolved = "high", reasoning = true } = {}) {
  const slots = [
    ["worker", "role-worker", "worker"],
    ["orchestrator", "role-orchestrator", "orchestrator"],
    ["user-testing", "role-user-testing", "validator"],
    ["task-validator", "role-task-validator", "validator"],
    ["scrutiny", "role-scrutiny", "validator"]
  ];
  return slots.map(([slot, roleId, kind]) => ({
    slot,
    expectedRoleId: roleId,
    ...(slot === "orchestrator" && requested !== undefined ? { reasoningEffort: requested } : {}),
    resolved: {
      profileId: "profile-old", profileRevision: 4, profileSnapshot: snapshotProfile(reasoning),
      roleId, roleRevision: 2,
      roleSnapshot: {
        id: roleId, name: `${slot} role`, kind, instructions: `Synthetic instructions for ${slot}`, profileId: "profile-old",
        ...(kind === "validator" ? { mcpPermissions: [{ serverId: "synthetic-server", toolName: "synthetic_tool", mode: "approve" }] } : {})
      },
      reasoningEffort: resolved,
      adapterVersion: "adapter-v1"
    }
  }));
}

function openControl(home, gate) {
  const previous = process.env.MC_ENABLE_MISSION_PARITY;
  if (gate === undefined) delete process.env.MC_ENABLE_MISSION_PARITY;
  else process.env.MC_ENABLE_MISSION_PARITY = gate;
  const control = new ControlPlane(home);
  if (previous === undefined) delete process.env.MC_ENABLE_MISSION_PARITY;
  else process.env.MC_ENABLE_MISSION_PARITY = previous;
  return control;
}

function prepareMission(control, home, { parity = false, requested = "high", agents = false } = {}) {
  control.upsertProfile(profile("profile-live"));
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: `live-${kind}`, name: kind, kind, instructions: "Live instructions", profileId: "profile-live" });
  }
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const workspace = control.addWorkspace("r1", realpathSync(workspacePath));
  const mission = control.createMission({
    title: "R1", goal: "Keep parity non-executable", acceptance: "No file is written",
    workspaceId: workspace.id, roleIds: ["live-orchestrator", "live-worker", "live-validator"],
    maxTurns: 4, maxCost: 0, autonomy: "trusted"
  });
  if (parity) control.recordFoundationWorkflow(mission.id, { policy: {}, roleBindings: bindings({ requested }) });
  const orchestrator = agents ? control.createAgent(mission.id, "Orchestrator", "live-orchestrator", "plan", "r1-orchestrator") : undefined;
  const worker = agents ? control.createAgent(mission.id, "Worker", "live-worker", "", "r1-worker") : undefined;
  return { mission, orchestrator, worker, workspacePath: workspace.path };
}

function setMissionStatus(control, missionId, status) {
  const data = JSON.parse(control.db.prepare("SELECT data FROM missions WHERE id=?").get(missionId).data);
  data.status = status;
  control.db.prepare("UPDATE missions SET status=?, data=? WHERE id=?").run(status, JSON.stringify(data), missionId);
}

function writeRpc(agent, relativePath) {
  return {
    type: "rpc", id: "write-1", token: "test", agentId: agent.id, epoch: agent.epoch,
    method: "write_file", taskId: `${agent.id}:write-1`, args: { path: relativePath, content: "should-not-land" }
  };
}

test("stored parity does not execute or release held work for either gate value", async (t) => {
  for (const gate of [undefined, "1"]) {
    const home = homeOf(t);
    const control = openControl(home, gate);
    try {
      assert.equal(control.missionParityEnabled, gate === "1");
      const { mission, orchestrator, worker, workspacePath } = prepareMission(control, home, { parity: true, agents: true });
      setMissionStatus(control, mission.id, "active");
      const target = join(workspacePath, "r1-write.txt");
      await assert.rejects(() => control.workerCommand(writeRpc(worker, "r1-write.txt")), (error) => error.code === "CAPABILITY_UNAVAILABLE");
      assert.equal(existsSync(target), false);
      const held = {
        id: "held-before-answer", missionId: mission.id, senderId: "user", recipientId: orchestrator.id,
        content: "held", mode: "followUp", status: "aborted", attempt: 1, createdAt: "2026-01-01T00:00:00.000Z",
        error: "Held until the mission can resume"
      };
      control.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(held.id, mission.id, held.status, JSON.stringify(held));
      const blocker = {
        id: "parity-question", missionId: mission.id, agentId: orchestrator.id, kind: "user_input",
        status: "open", text: "Need a decision", createdAt: "2026-01-01T00:00:00.000Z"
      };
      setMissionStatus(control, mission.id, "blocked");
      control.db.prepare("INSERT INTO blockers(id,mission_id,status,data) VALUES(?,?,?,?)").run(blocker.id, mission.id, "open", JSON.stringify(blocker));
      control.resolveBlocker(blocker.id, "recorded answer");
      assert.notEqual(control.missionById(mission.id).status, "active");
      assert.equal(control.db.prepare("SELECT status FROM messages WHERE id=?").get(held.id).status, "aborted");
      assert.equal(control.db.prepare("SELECT count(*) AS n FROM outbox WHERE message_id=?").get(held.id).n, 0);
      const answer = control.db.prepare("SELECT status FROM messages WHERE id=?").get(`blocker-resolution:${blocker.id}`);
      assert.equal(answer.status, "aborted");
      setMissionStatus(control, mission.id, "active");
      await assert.rejects(() => control.workerCommand(writeRpc(worker, "r1-write.txt")), (error) => error.code === "CAPABILITY_UNAVAILABLE");
      assert.equal(existsSync(target), false);
      const approval = {
        id: "parity-approval", missionId: mission.id, agentId: worker.id, tool: "write_file",
        args: { path: target, content: "approved-should-not-land" }, status: "approved", createdAt: "2026-01-01T00:00:00.000Z"
      };
      control.db.prepare("INSERT INTO approvals(id,mission_id,status,data) VALUES(?,?,?,?)").run(approval.id, mission.id, approval.status, JSON.stringify(approval));
      await assert.rejects(() => control.executeApproved(approval.id), (error) => error.code === "CAPABILITY_UNAVAILABLE");
      assert.equal(existsSync(target), false);
      assert.equal(control.getApproval(approval.id).status, "approved");
      const dispatchMessage = {
        id: "parity-dispatch", missionId: mission.id, senderId: "user", recipientId: worker.id,
        content: "do not run", mode: "followUp", status: "queued", attempt: 1, createdAt: "2026-01-01T00:00:00.000Z"
      };
      control.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(dispatchMessage.id, mission.id, dispatchMessage.status, JSON.stringify(dispatchMessage));
      control.db.prepare("INSERT INTO outbox(id,mission_id,message_id,attempt,request_id,status,epoch,created_at,retry_count) VALUES(?,?,?,?,?,?,?,?,?)")
        .run("parity-dispatch-outbox", mission.id, dispatchMessage.id, 1, "parity-dispatch:1", "queued", 0, dispatchMessage.createdAt, 0);
      const workers = new WorkerManager(control, true);
      try {
        await workers.dispatchPending();
        await workers.recoverActiveMissions();
        assert.equal(control.db.prepare("SELECT status FROM outbox WHERE id='parity-dispatch-outbox'").get().status, "queued");
        assert.equal(control.getAgentPublic(worker.id).status, "idle");
      } finally {
        await workers.close();
      }
    } finally {
      control.close();
    }
  }
});

test("classic question resolution still resumes and pause still holds delivery", async (t) => {
  const home = homeOf(t);
  const control = openControl(home, "1");
  try {
    const { mission } = prepareMission(control, home, { parity: false });
    const started = control.missionAction(mission.id, "start");
    assert.equal(started.status, "active");
    const orchestrator = control.getAgentPublic(started.orchestratorId);
    const blocker = await control.workerCommand({
      type: "rpc", id: "question", token: "test", agentId: orchestrator.id, epoch: orchestrator.epoch,
      method: "RequestUserInput", taskId: `${orchestrator.id}:question`, args: { question: "Which name?" }
    });
    assert.equal(control.missionById(mission.id).status, "blocked");
    const held = {
      id: "classic-held", missionId: mission.id, senderId: "user", recipientId: orchestrator.id,
      content: "held classic", mode: "followUp", status: "aborted", attempt: 1, createdAt: "2026-01-01T00:00:00.000Z",
      error: "Held until the mission can resume"
    };
    control.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(held.id, mission.id, held.status, JSON.stringify(held));
    control.resolveBlocker(blocker.id, "use the synthetic name");
    assert.equal(control.missionById(mission.id).status, "active");
    assert.equal(control.db.prepare("SELECT status FROM messages WHERE id=?").get(held.id).status, "queued");
    assert.equal(control.db.prepare("SELECT status FROM messages WHERE id=?").get(`blocker-resolution:${blocker.id}`).status, "queued");
    control.missionAction(mission.id, "pause");
    assert.equal(control.missionById(mission.id).status, "paused");
    assert.equal(control.db.prepare("SELECT status FROM outbox WHERE message_id=?").get(held.id).status, "aborted");
    const resumed = control.missionAction(mission.id, "resume");
    assert.equal(resumed.status, "active");
    assert.equal(control.db.prepare("SELECT status FROM messages WHERE id=?").get(held.id).status, "queued");
  } finally {
    control.close();
  }
});

test("node client classifies authentication, malformed input, and stale sessions on both listeners", async (t) => {
  const home = homeOf(t);
  const service = await startServer({ home, port: 0, nodePort: 0 });
  t.after(() => service.close());
  const enrolled = service.control.enrollMachine("r1-node", "R1 node");
  const capabilities = {
    protocol: 1, version: "test", platform: process.platform, arch: process.arch,
    node: process.version, piDurable: "1.1.0", roots: [home], credentialRefs: [], executionEnabled: false
  };
  const session = service.control.nodeSession(enrolled.machine.id, enrolled.token, capabilities, crypto.randomUUID());
  const listeners = [
    ["administrator", service.port],
    ["node", service.nodePort]
  ];
  for (const [name, port] of listeners) {
    const base = new URL(`http://127.0.0.1:${port}`);
    await assert.rejects(
      () => fetchJson(base, "/api/nodes/poll", "not-the-node-token", { machineId: enrolled.machine.id, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch }),
      (error) => error instanceof Error && !(error instanceof CoordinatorSessionExpired) && /connection failed/i.test(error.message),
      `${name} authentication`
    );
    const unauthorized = await fetch(new URL("/api/nodes/poll", base), {
      method: "POST", headers: { authorization: "Bearer not-the-node-token", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ machineId: enrolled.machine.id, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch })
    });
    assert.equal(unauthorized.status, 401, name);
    assert.deepEqual(await unauthorized.json(), { error: "Node authentication failed" }, name);
    await assert.rejects(
      () => fetchJson(base, "/api/nodes/poll", enrolled.token, { machineId: enrolled.machine.id, sessionId: session.sessionId, sessionEpoch: "stale" }),
      (error) => error instanceof Error && !(error instanceof CoordinatorSessionExpired) && /connection failed/i.test(error.message),
      `${name} malformed session`
    );
    const malformed = await fetch(new URL("/api/nodes/poll", base), {
      method: "POST", headers: { authorization: `Bearer ${enrolled.token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ machineId: enrolled.machine.id, sessionId: session.sessionId, sessionEpoch: "stale" })
    });
    assert.equal(malformed.status, 400, name);
    const malformedBody = await malformed.json();
    assert.equal(malformedBody.error.includes("sessionEpoch"), true, name);
    assert.equal("code" in malformedBody, false, name);
    await assert.rejects(
      () => fetchJson(base, "/api/nodes/poll", enrolled.token, { machineId: enrolled.machine.id, sessionId: session.sessionId, sessionEpoch: session.sessionEpoch + 1 }),
      (error) => error instanceof CoordinatorSessionExpired,
      `${name} stale session`
    );
  }
});

test("strict JSON keeps prototype keys and rejects duplicate decoded keys", () => {
  const parsed = parseJsonText('{"__proto__":1}');
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(parsed["__proto__"], 1);
  assert.equal(canonicalJson(parsed), '{"__proto__":1}');
  assert.throws(() => parseJsonText('{"__proto__":1,"\\u005f_proto__":2}'), /duplicate keys/);
  assert.throws(() => parseWorkflowPolicyRequest('{"__proto__":1}'), /unknown field/);
  const nested = parseJsonText('{"constructor":{"prototype":1},"toString":"value"}');
  assert.equal(nested.constructor.prototype, 1);
  assert.equal(nested.toString, "value");
  assert.equal(canonicalJson(nested), '{"constructor":{"prototype":1},"toString":"value"}');
});

test("explicit requested effort must match the frozen resolved effort", () => {
  assert.throws(() => parseRoleBindings(bindings({ requested: "low", resolved: "high" })), /match the frozen resolved effort/);
  const matched = parseRoleBindings(bindings({ requested: "high", resolved: "high" }));
  assert.equal(matched.find((binding) => binding.slot === "orchestrator").reasoningEffort, "high");
  assert.equal(matched.find((binding) => binding.slot === "orchestrator").resolved.reasoningEffort, "high");
  const omitted = parseRoleBindings(bindings({ resolved: "high" }));
  assert.equal(Object.hasOwn(omitted.find((binding) => binding.slot === "orchestrator"), "reasoningEffort"), false);
  const quiet = parseRoleBindings(bindings({ resolved: "off", reasoning: false }));
  assert.equal(quiet.find((binding) => binding.slot === "worker").resolved.reasoningEffort, "off");
  const quietRequested = parseRoleBindings(bindings({ requested: "off", resolved: "off", reasoning: false }));
  assert.equal(quietRequested.find((binding) => binding.slot === "orchestrator").reasoningEffort, "off");
  assert.throws(() => parseRoleBindings(bindings({ requested: "off", resolved: "high", reasoning: false })), /off|match the frozen/);
  assert.equal(typeof workflowDigest("roles", matched), "string");
});
