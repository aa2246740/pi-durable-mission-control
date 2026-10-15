import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { backupHome, restoreHome } from "../dist/backup.js";
import { CONTROL_SCHEMA_VERSION, ControlPlane } from "../dist/control.js";
import { startServer } from "../dist/server.js";
import {
  HttpError,
  WorkflowOperationError,
  adminErrorBody,
  assertWorkflowDigest,
  canonicalJson,
  missionParityGateEnabled,
  parseJsonText,
  parseRoleBindings,
  parseStoredWorkflowPolicy,
  parseWorkflowPolicyRequest,
  workflowDigest,
  workflowDigestFromCanonical
} from "../dist/workflow-schema.js";

const POLICY_CANONICAL = '{"autoAcceptPlan":true,"autoAcceptRepairs":false,"defaultAttemptLimit":7,"maxParallelTasks":1,"skipScrutiny":true,"skipUserTesting":false}';
const POLICY_DIGEST = "6ffb356c129d47b5679ea07072007ede00d6f4b8045ffd8b8376c9ca5898672a";
const ROLES_DIGEST = "55c0a51aea219843f53d51329d05a8a58e8b9032f901dd3da9fca9cd60c188dd";
const SET_CANONICAL = '[{"n":1,"slot":"orchestrator"},{"n":1,"slot":"worker"}]';

function homeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mission-workflow-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home: join(realpathSync(root), "home") };
}

function liveProfile(id, modelId) {
  return {
    id, name: "Live profile", api: "openai-completions", modelId, baseUrl: "http://127.0.0.1:9/v1",
    credentialEnv: "", contextWindow: 8000, maxTokens: 256, reasoning: true, toolCalling: true, vision: false,
    revision: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

function openMission(home) {
  const control = new ControlPlane(home);
  control.upsertProfile(liveProfile("profile-live", "synthetic-live"));
  control.upsertProfile(liveProfile("profile-old", "synthetic-old-model"));
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: `live-${kind}`, name: kind, kind, instructions: "Live instructions", profileId: "profile-live" });
  }
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const workspace = control.addWorkspace("foundation", realpathSync(workspacePath));
  const mission = control.createMission({
    title: "Foundation", goal: "Keep the foundation row", acceptance: "The stored authorization round-trips",
    workspaceId: workspace.id, roleIds: ["live-orchestrator", "live-worker", "live-validator"],
    maxTurns: 4, maxCost: 0, autonomy: "trusted"
  });
  return { control, mission };
}

function oldProfile() {
  return {
    id: "profile-old", name: "Old profile", api: "openai-completions", modelId: "synthetic-old-model",
    baseUrl: "http://127.0.0.1:9/v1", credentialEnv: "SYNTHETIC_OLD_KEY", contextWindow: 8000, maxTokens: 256,
    reasoning: true, toolCalling: true, vision: false, revision: 4, available: true,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 }
  };
}

function foundationBindings() {
  const slots = [
    ["worker", "role-worker", "worker", undefined],
    ["orchestrator", "role-orchestrator", "orchestrator", "low"],
    ["user-testing", "role-user-testing", "validator", undefined],
    ["task-validator", "role-task-validator", "validator", "high"],
    ["scrutiny", "role-scrutiny", "validator", undefined]
  ];
  return slots.map(([slot, roleId, kind, reasoningEffort]) => ({
    slot, expectedRoleId: roleId,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    resolved: {
      profileId: "profile-old", profileRevision: 4, profileSnapshot: oldProfile(),
      roleId, roleRevision: 2,
      roleSnapshot: {
        id: roleId, name: `${slot} role`, kind, instructions: `Synthetic instructions for ${slot}`, profileId: "profile-old",
        ...(kind === "validator" ? { mcpPermissions: [{ serverId: "synthetic-server", toolName: "synthetic_tool", mode: "approve" }] } : {})
      },
      reasoningEffort: "high", adapterVersion: "adapter-v1"
    }
  }));
}

function nonDefaultPolicy() {
  return { autoAcceptPlan: true, autoAcceptRepairs: false, defaultAttemptLimit: 7, maxParallelTasks: 1, skipScrutiny: true, skipUserTesting: false };
}

function codeOf(error) {
  assert.ok(error instanceof WorkflowOperationError || error instanceof HttpError);
  return error;
}

test("canonical bytes and domain prefixes match independent literals", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ label: "中文" }), '{"label":"中文"}');
  assert.equal(canonicalJson({ text: "say \"hi\"\n" }), '{"text":"say \\"hi\\"\\n"}');
  assert.equal(canonicalJson({ z: -0 }), '{"z":0}');
  assert.equal(canonicalJson({ q: -2.5, p: 0.1 }), '{"p":0.1,"q":-2.5}');
  const setSchema = { type: "array", uniqueKey: "slot", items: { type: "object" } };
  assert.equal(canonicalJson([{ slot: "worker", n: 1 }, { slot: "orchestrator", n: 1 }], setSchema), SET_CANONICAL);
  assert.throws(() => canonicalJson([{ slot: "worker", n: 1 }, { slot: "worker", n: 2 }], setSchema), /unique/);
  assert.throws(() => parseJsonText('{"a":1,"\\u0061":2}'), /duplicate keys/);
  assert.throws(() => parseJsonText('{"a":1,"a":2}'), /duplicate keys/);
  assert.throws(() => parseJsonText('"\\uD800"'), /surrogate/);
  assert.throws(() => parseJsonText("1e309"), /finite/);
  const sparse = [];
  sparse.length = 2;
  sparse[1] = 1;
  assert.throws(() => canonicalJson(sparse), /sparse/);
  assert.throws(() => canonicalJson({ value: undefined }), /undefined/);

  assert.equal(workflowDigestFromCanonical("policy", '{"a":2,"b":1}'), "aaa30b79821d3b559ff352725a92a89ca585eaf039b582ff7f50af76d3dd4ef3");
  assert.equal(workflowDigestFromCanonical("policy", '{"label":"中文"}'), "dcabb5c3c206e7af888897f62132ad759cefc0011376af9ba790c734ef8f07f6");
  assert.equal(workflowDigestFromCanonical("policy", '{"text":"say \\"hi\\"\\n"}'), "2bcbec73348133ee260a3dab21033f3668d44cb8538456d50b893789ae128594");
  assert.equal(workflowDigestFromCanonical("policy", '{"z":0}'), "a532e5a5f660640b60b22ed83cae546dfab063031af35a30c30333d2efa8b253");
  assert.equal(workflowDigestFromCanonical("policy", '{"p":0.1,"q":-2.5}'), "962d4288eabab5ae470f24d83f1f697cceaef8dba56105ee28f19268f65641f2");
  assert.equal(workflowDigestFromCanonical("policy", SET_CANONICAL), "3736f864214098b9d7acbeb6393e802e18238dc40033657dca6c4952acea3faa");
  const same = '{"k":1}';
  assert.equal(workflowDigestFromCanonical("policy", same), "86d9a4c280b60657c3acac065b33278c9ac66546932448700ebaac6392af3e77");
  assert.equal(workflowDigestFromCanonical("roles", same), "f874f5c802d9e0b42955194413aae59349f27ae99be80cc10ce12cc0a7823a88");
  assert.equal(workflowDigestFromCanonical("command-payload", same), "f55c5129ff843bbd06546e9c9f32c13c1a4453eeb7d6b200e9397582fdaa3faa");
  assert.equal(workflowDigestFromCanonical("execution-config", same), "6a1a9b6d2771ad11c0a3ec89842a9044a0dff654598b7f6463904675b0adcc89");
  assert.equal(workflowDigest("command-payload", { k: 1 }), workflowDigestFromCanonical("command-payload", same));
  assert.throws(() => workflowDigestFromCanonical("plan", same), /Unknown workflow digest domain/);
});

test("policy requests keep capability rejection distinct from schema rejection", () => {
  const stored = parseWorkflowPolicyRequest({});
  assert.deepEqual(stored, { autoAcceptPlan: false, autoAcceptRepairs: false, defaultAttemptLimit: 5, maxParallelTasks: 1, skipScrutiny: false, skipUserTesting: false });
  assert.deepEqual(parseWorkflowPolicyRequest(nonDefaultPolicy()), nonDefaultPolicy());
  assert.equal(canonicalJson(nonDefaultPolicy()), POLICY_CANONICAL);
  assert.equal(workflowDigest("policy", nonDefaultPolicy()), POLICY_DIGEST);
  assert.equal(assertWorkflowDigest("policy", nonDefaultPolicy(), POLICY_DIGEST), POLICY_DIGEST);
  for (const input of [{ autoAcceptRepairs: true }, { maxParallelTasks: 2 }, { maxParallelTasks: 1000, autoAcceptRepairs: true }]) {
    assert.throws(() => parseWorkflowPolicyRequest(input), (error) => codeOf(error).status === 409 && error.code === "CAPABILITY_UNAVAILABLE");
  }
  for (const input of [{ maxParallelTasks: 0 }, { defaultAttemptLimit: 0 }, { autoAcceptRepairs: "false" }, { extra: true }, { maxParallelTasks: 1.5 }]) {
    assert.throws(() => parseWorkflowPolicyRequest(input), (error) => codeOf(error).status === 400 && error.code === "OPERATION_REJECTED");
  }
  assert.throws(() => parseStoredWorkflowPolicy({ ...nonDefaultPolicy(), autoAcceptRepairs: true }), (error) => error.status === 400 && error.code === "OPERATION_REJECTED");
  assert.throws(() => parseStoredWorkflowPolicy({ ...nonDefaultPolicy(), maxParallelTasks: 2 }), (error) => error.status === 400);
  assert.throws(() => assertWorkflowDigest("policy", nonDefaultPolicy(), "a".repeat(64)), (error) => error.status === 409 && error.code === "DIGEST_MISMATCH");
  assert.throws(() => parseRoleBindings(foundationBindings().slice(0, 4)), /each workflow slot/);
  const duplicated = foundationBindings();
  duplicated[1] = { ...duplicated[0], slot: "orchestrator" };
  assert.throws(() => parseRoleBindings(duplicated), /duplicate slot|does not match its slot|invalid/i);
});

test("mission parity gate is exact and internal errors stay redacted", () => {
  const previous = process.env.MC_ENABLE_MISSION_PARITY;
  try {
    delete process.env.MC_ENABLE_MISSION_PARITY;
    assert.equal(missionParityGateEnabled(), false);
    for (const value of ["0", "true", "yes", "2", ""]) {
      process.env.MC_ENABLE_MISSION_PARITY = value;
      assert.equal(missionParityGateEnabled(), false, value);
    }
    process.env.MC_ENABLE_MISSION_PARITY = "1";
    assert.equal(missionParityGateEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.MC_ENABLE_MISSION_PARITY;
    else process.env.MC_ENABLE_MISSION_PARITY = previous;
  }
  const leaked = adminErrorBody(new Error("stack sk-secret https://provider.example/v1"), 500, "stack sk-secret https://provider.example/v1");
  assert.deepEqual(leaked, { error: "Internal server error", code: "INTERNAL_ERROR" });
  assert.equal(JSON.stringify(leaked).includes("sk-secret"), false);
  assert.equal(JSON.stringify(leaked).includes("stack"), false);
  assert.deepEqual(adminErrorBody(new HttpError(401, "Authentication required"), 401, "Authentication required"), {
    error: "Authentication required", code: "AUTHENTICATION_FAILED"
  });
  assert.deepEqual(adminErrorBody(new HttpError(400, "Nope"), 400, "Nope"), { error: "Nope", code: "OPERATION_REJECTED" });
});

test("foundation snapshots survive reopen, profile changes, backup, and restore isolation", async (t) => {
  const f = homeFixture(t);
  const previous = process.env.MC_ENABLE_MISSION_PARITY;
  process.env.MC_ENABLE_MISSION_PARITY = "1";
  const { control, mission } = openMission(f.home);
  let canonical = "";
  let workflow;
  try {
    assert.equal(control.missionParityEnabled, true);
    workflow = control.recordFoundationWorkflow(mission.id, { policy: nonDefaultPolicy(), roleBindings: foundationBindings() });
    assert.equal(workflow.mode, "parity-v1");
    assert.equal(workflow.phase, "planning");
    assert.equal(workflow.revision, 1);
    assert.equal(workflow.policyRevision, 1);
    assert.equal(workflowDigest("policy", workflow.policy), POLICY_DIGEST);
    assert.equal(workflowDigest("roles", workflow.roleBindings), ROLES_DIGEST);
    canonical = control.db.prepare("SELECT data FROM mission_workflows WHERE mission_id=?").get(mission.id).data;
    control.upsertProfile({ ...liveProfile("profile-old", "synthetic-new-model"), reasoning: false });
    control.upsertRole({ id: "role-orchestrator", name: "changed", kind: "orchestrator", instructions: "default-effort:max", profileId: "profile-old" });
    const missionData = JSON.parse(control.db.prepare("SELECT data FROM missions WHERE id=?").get(mission.id).data);
    missionData.status = "active";
    control.db.prepare("UPDATE missions SET status='active', data=? WHERE id=?").run(JSON.stringify(missionData), mission.id);
    const message = {
      id: "foundation-message", missionId: mission.id, senderId: "user", recipientId: "foundation-agent",
      content: "held for restore", mode: "followUp", status: "queued", attempt: 1, createdAt: "2026-01-01T00:00:00.000Z"
    };
    control.db.prepare("INSERT INTO messages(id,mission_id,status,data) VALUES(?,?,?,?)").run(message.id, mission.id, "queued", JSON.stringify(message));
    control.db.prepare("INSERT INTO outbox(id,mission_id,message_id,attempt,request_id,status,epoch,created_at,retry_count) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("foundation-outbox", mission.id, message.id, 1, "foundation-request", "queued", 1, message.createdAt, 0);
  } finally {
    control.close();
    if (previous === undefined) delete process.env.MC_ENABLE_MISSION_PARITY;
    else process.env.MC_ENABLE_MISSION_PARITY = previous;
  }

  delete process.env.MC_ENABLE_MISSION_PARITY;
  const reopened = new ControlPlane(f.home);
  try {
    assert.equal(reopened.missionParityEnabled, false);
    const read = reopened.missionWorkflow(mission.id);
    assert.equal(read.missionParityEnabled, false);
    assert.deepEqual(read.allowedActions, []);
    assert.equal(read.workflow.mode, "parity-v1");
    assert.deepEqual(read.workflow.policy, workflow.policy);
    assert.deepEqual(read.workflow.roleBindings, workflow.roleBindings);
    assert.equal(read.workflow.roleBindings[0].resolved.profileSnapshot.modelId, "synthetic-old-model");
    assert.equal(read.workflow.roleBindings.find((binding) => binding.slot === "orchestrator").resolved.reasoningEffort, "high");
    assert.equal(read.workflow.roleBindings.find((binding) => binding.slot === "orchestrator").resolved.roleSnapshot.instructions, "Synthetic instructions for orchestrator");
    assert.equal(reopened.profile("profile-old").modelId, "synthetic-new-model");
    assert.equal(workflowDigest("policy", read.workflow.policy), POLICY_DIGEST);
    assert.equal(workflowDigest("roles", read.workflow.roleBindings), ROLES_DIGEST);
    assert.equal(reopened.db.prepare("SELECT data FROM mission_workflows WHERE mission_id=?").get(mission.id).data, canonical);
  } finally { reopened.close(); }

  writeFileSync(join(f.home, "admin.token"), "foundation-backup-token\n", { mode: 0o600 });
  const backup = join(f.root, "backup");
  await backupHome(f.home, backup, "0.1.0", async () => {});
  const restoredHome = join(f.root, "restored");
  restoreHome(backup, restoredHome);
  const restoredDb = new DatabaseSync(join(restoredHome, "control.sqlite"), { readOnly: true });
  try {
    assert.equal(restoredDb.prepare("PRAGMA user_version").get().user_version, 11);
    assert.equal(restoredDb.prepare("SELECT data FROM mission_workflows").get().data, canonical);
    assert.equal(restoredDb.prepare("SELECT status FROM missions").get().status, "blocked");
    assert.equal(restoredDb.prepare("SELECT status FROM outbox WHERE id='foundation-outbox'").get().status, "uncertain");
  } finally { restoredDb.close(); }

  const restored = new ControlPlane(restoredHome);
  try {
    const read = restored.missionWorkflow(mission.id);
    assert.equal(read.workflow.mode, "parity-v1");
    assert.deepEqual(read.workflow.policy, nonDefaultPolicy());
    assert.equal(read.workflow.roleBindings.find((binding) => binding.slot === "worker").resolved.profileSnapshot.credentialEnv, "SYNTHETIC_OLD_KEY");
    assert.equal(workflowDigest("roles", read.workflow.roleBindings), ROLES_DIGEST);
    assert.equal(restored.db.prepare("SELECT status FROM outbox WHERE id='foundation-outbox'").get().status, "uncertain");
    assert.ok(restored.blockers(mission.id).some((blocker) => blocker.status === "open"));
    assert.throws(() => restored.missionAction(mission.id, "resume"), (error) => codeOf(error).status === 409 && error.code === "CAPABILITY_UNAVAILABLE");
    assert.equal(restored.db.prepare("SELECT status FROM outbox WHERE id='foundation-outbox'").get().status, "uncertain");
    assert.equal(restored.db.prepare("SELECT data FROM mission_workflows").get().data, canonical);
    assert.ok(restored.blockers(mission.id).some((blocker) => blocker.status === "open"));
  } finally { restored.close(); }
});

test("classic backups without a workflow row restore and upgrade without inventing one", async (t) => {
  const f = homeFixture(t);
  const { control, mission } = openMission(f.home);
  const title = mission.title;
  control.close();
  const legacy = new DatabaseSync(join(f.home, "control.sqlite"));
  legacy.exec("DROP TABLE mission_workflows; PRAGMA user_version=10");
  assert.equal(legacy.prepare("SELECT name FROM sqlite_schema WHERE name='mission_workflows'").get(), undefined);
  legacy.close();
  writeFileSync(join(f.home, "admin.token"), "classic-backup-token\n", { mode: 0o600 });
  const backup = join(f.root, "classic-backup");
  await backupHome(f.home, backup, "0.1.0", async () => {});
  const restoredHome = join(f.root, "classic-restored");
  restoreHome(backup, restoredHome);
  const check = new DatabaseSync(join(restoredHome, "control.sqlite"), { readOnly: true });
  try {
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 10);
    assert.equal(check.prepare("SELECT name FROM sqlite_schema WHERE name='mission_workflows'").get(), undefined);
  } finally { check.close(); }
  const restored = new ControlPlane(restoredHome);
  try {
    assert.equal(restored.db.prepare("PRAGMA user_version").get().user_version, CONTROL_SCHEMA_VERSION);
    assert.equal(restored.missionWorkflow(mission.id).workflow, null);
    assert.equal(restored.db.prepare("SELECT count(*) AS n FROM mission_workflows").get().n, 0);
    assert.equal(restored.missionById(mission.id).title, title);
    const started = restored.missionAction(mission.id, "start");
    assert.equal(started.status, "active");
    assert.ok(started.orchestratorId);
  } finally { restored.close(); }
});

test("corrupt or future workflow data fails closed and is not read as classic", async (t) => {
  const f = homeFixture(t);
  const { control, mission } = openMission(f.home);
  control.recordFoundationWorkflow(mission.id, { policy: nonDefaultPolicy(), roleBindings: foundationBindings() });
  control.db.prepare("UPDATE mission_workflows SET data=? WHERE mission_id=?").run(JSON.stringify({ schemaVersion: 2, policy: nonDefaultPolicy() }), mission.id);
  control.close();
  assert.throws(() => new ControlPlane(f.home), /Unsupported mission workflow data version/);
  const preserved = new DatabaseSync(join(f.home, "control.sqlite"), { readOnly: true });
  try {
    assert.equal(preserved.prepare("SELECT mode FROM mission_workflows").get().mode, "parity-v1");
    assert.equal(JSON.parse(preserved.prepare("SELECT data FROM mission_workflows").get().data).schemaVersion, 2);
  } finally { preserved.close(); }
  writeFileSync(join(f.home, "admin.token"), "corrupt-backup-token\n", { mode: 0o600 });
  await assert.rejects(backupHome(f.home, join(f.root, "corrupt-backup"), "0.1.0", async () => {}), /cannot preserve/);

  const phaseHome = join(f.root, "phase-home");
  const phase = openMission(phaseHome);
  phase.control.recordFoundationWorkflow(phase.mission.id, { policy: {}, roleBindings: foundationBindings() });
  phase.control.db.prepare("UPDATE mission_workflows SET phase='awaiting_plan_acceptance'").run();
  phase.control.close();
  assert.throws(() => new ControlPlane(phaseHome), /Unsupported mission workflow phase/);
  const phaseDb = new DatabaseSync(join(phaseHome, "control.sqlite"), { readOnly: true });
  try {
    assert.equal(phaseDb.prepare("SELECT mode, phase FROM mission_workflows").get().mode, "parity-v1");
    assert.equal(phaseDb.prepare("SELECT phase FROM mission_workflows").get().phase, "awaiting_plan_acceptance");
  } finally { phaseDb.close(); }
});

test("read state does not write and parity execution stays unavailable", async (t) => {
  const f = homeFixture(t);
  const { control, mission } = openMission(f.home);
  const workflow = control.recordFoundationWorkflow(mission.id, { policy: { skipScrutiny: true }, roleBindings: foundationBindings() });
  const before = {
    version: control.db.prepare("PRAGMA user_version").get().user_version,
    changes: control.db.prepare("SELECT total_changes() AS n").get().n,
    workflows: control.db.prepare("SELECT data FROM mission_workflows").all(),
    events: control.db.prepare("SELECT count(*) AS n FROM events").get().n
  };
  const read = control.missionWorkflow(mission.id);
  assert.equal(read.workflow.policy.skipScrutiny, true);
  assert.equal(read.workflow.policy.autoAcceptRepairs, false);
  assert.deepEqual(read.allowedActions, []);
  assert.equal(control.db.prepare("SELECT total_changes() AS n").get().n, before.changes);
  assert.deepEqual(control.db.prepare("SELECT data FROM mission_workflows").all(), before.workflows);
  assert.equal(control.db.prepare("SELECT count(*) AS n FROM events").get().n, before.events);
  assert.throws(() => control.missionAction(mission.id, "start"), (error) => error.code === "CAPABILITY_UNAVAILABLE");
  assert.equal(control.missionById(mission.id).status, "draft");
  assert.equal(control.listAgents(mission.id).length, 0);
  const missionData = JSON.parse(control.db.prepare("SELECT data FROM missions WHERE id=?").get(mission.id).data);
  missionData.status = "active";
  control.db.prepare("UPDATE missions SET status='active', data=? WHERE id=?").run(JSON.stringify(missionData), mission.id);
  const agent = control.createAgent(mission.id, "Worker", "live-worker", "wait", "foundation-agent");
  assert.throws(() => control.admitTurn(agent.id, agent.epoch, "generation-1"), (error) => error.code === "CAPABILITY_UNAVAILABLE");
  assert.equal(control.db.prepare("SELECT count(*) AS n FROM generation_admissions").get().n, 0);
  assert.equal(control.db.prepare("SELECT count(*) AS n FROM generation_denials").get().n, 0);
  control.missionAction(mission.id, "pause");
  assert.equal(control.missionById(mission.id).status, "paused");
  const held = control.db.prepare("SELECT status FROM outbox WHERE message_id LIKE 'agent-opening:%'").get();
  control.missionAction(mission.id, "cancel");
  assert.equal(control.missionById(mission.id).status, "cancelled");
  assert.equal(control.db.prepare("SELECT data FROM mission_workflows").get().data, before.workflows[0].data);
  assert.equal(workflow.mode, "parity-v1");
  if (held) assert.notEqual(control.db.prepare("SELECT status FROM outbox WHERE message_id LIKE 'agent-opening:%'").get().status, "queued");
  control.close();

  process.env.MC_ENABLE_MISSION_PARITY = "1";
  const enabled = new ControlPlane(f.home);
  try {
    assert.equal(enabled.missionParityEnabled, true);
    assert.equal(enabled.missionWorkflow(mission.id).workflow.mode, "parity-v1");
    assert.throws(() => enabled.missionAction(mission.id, "resume"), (error) => error.code === "CAPABILITY_UNAVAILABLE");
  } finally {
    enabled.close();
    delete process.env.MC_ENABLE_MISSION_PARITY;
  }

  const serverHome = join(f.root, "server");
  const serverMission = openMission(serverHome);
  const serverMissionId = serverMission.mission.id;
  serverMission.control.recordFoundationWorkflow(serverMissionId, { policy: {}, roleBindings: foundationBindings() });
  serverMission.control.close();
  const service = await startServer({ home: serverHome, port: 0, nodePort: 0 });
  try {
    const token = readFileSync(join(serverHome, "admin.token"), "utf8").trim();
    const unauthenticated = await fetch(`http://127.0.0.1:${service.port}/api/missions/${serverMissionId}/workflow`);
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), { error: "Authentication required", code: "AUTHENTICATION_FAILED" });
    const missing = await fetch(`http://127.0.0.1:${service.port}/api/missions/missing/workflow`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "OPERATION_REJECTED");
    const workflowResponse = await fetch(`http://127.0.0.1:${service.port}/api/missions/${serverMissionId}/workflow`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(workflowResponse.status, 200);
    const body = await workflowResponse.json();
    assert.equal(body.workflow.mode, "parity-v1");
    assert.deepEqual(body.allowedActions, []);
    assert.equal(body.missionParityEnabled, false);
    const rejected = await fetch(`http://127.0.0.1:${service.port}/api/missions`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ nope: true })
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, "OPERATION_REJECTED");
    const started = await fetch(`http://127.0.0.1:${service.port}/api/missions/${serverMissionId}/start`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}"
    });
    assert.equal(started.status, 409);
    const startBody = await started.json();
    assert.equal(startBody.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(typeof startBody.error, "string");
    assert.equal(service.control.db.prepare("SELECT count(*) AS n FROM mission_workflows").get().n, 1);
    const node = await fetch(`http://127.0.0.1:${service.nodePort}/api/nodes/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(node.status, 401);
    const nodeBody = await node.json();
    assert.deepEqual(nodeBody, { error: "Node authentication failed" });
    assert.equal("code" in nodeBody, false);
  } finally {
    await service.close();
  }
});
