import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../dist/server.js";

const waitFor = async predicate => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error("timed out waiting for remote approval continuation");
};

test("real HTTP node child denies without effects and executes an approved effect once", async t => {
  const home = mkdtempSync(join(tmpdir(), "remote-effect-approvals-http-"));
  const root = join(home, "remote-root"), localPath = join(home, "local-workspace"), nodeHome = join(home, "node-home");
  mkdirSync(root); mkdirSync(localPath);
  const service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0, testOnlyScripted: true });
  const control = service.control;
  const enrolled = control.enrollMachine("approval-http-node", "Approval HTTP node");
  const nodeModule = new URL("../dist/node.js", import.meta.url).href;
  const nodeOptions = {
    coordinator: `http://127.0.0.1:${service.nodePort}`, machineId: enrolled.machine.id,
    tokenEnv: "NODE_AUTH_TOKEN", home: nodeHome, roots: [root], credentialRefs: [],
    executionMode: "workspace-effects", testOnlyScripted: true, testOnlyWorkspaceEffectLoop: true
  };
  let node, nodeOutput = "";
  const spawnNode = () => {
    const script = `import { runNode } from ${JSON.stringify(nodeModule)}; runNode(${JSON.stringify(nodeOptions)}).catch(error => { process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, NODE_AUTH_TOKEN: enrolled.token }, stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { nodeOutput += chunk; });
    child.stderr.on("data", chunk => { nodeOutput += chunk; });
    return child;
  };
  const stopNode = async child => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("exit", resolve));
    }
  };
  t.after(async () => {
    await stopNode(node);
    await service.close();
    rmSync(home, { recursive: true, force: true });
  });
  node = spawnNode();
  await waitFor(() => control.machineRegistry.get(enrolled.machine.id)?.status === "online");
  assert.equal(control.machineRegistry.get(enrolled.machine.id).capabilities.effectApprovals, true);
  const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), root);
  await waitFor(() => control.machineCommand(enrolled.machine.id, probe.id).status === "completed");
  const remote = control.addRemoteWorkspace("Approval workspace", enrolled.machine.id, probe.id);
  const local = control.addWorkspace("Local approval workspace", localPath);
  const profile = {
    id: "approval-http-profile", name: "Fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "http://127.0.0.1:9/v1", credentialEnv: "", contextWindow: 4096, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  control.upsertProfile(profile);
  const roles = [
    { id: "approval-http-orchestrator", name: "orchestrator", kind: "orchestrator", instructions: "coordinate", profileId: profile.id },
    { id: "approval-http-worker", name: "worker", kind: "worker", instructions: "use workspace effects", profileId: profile.id },
    { id: "approval-http-validator", name: "validator", kind: "validator", instructions: "validate", profileId: profile.id }
  ];
  for (const role of roles) control.upsertRole(role);
  const mission = control.createMission({
    title: "Approval HTTP integration", goal: "approve one remote effect",
    acceptance: "denied effect does not execute; approved effect executes once",
    workspaceId: local.id, remoteWorkspaceIds: [remote.id], roleIds: roles.map(role => role.id),
    maxTurns: 10, maxCost: 0, autonomy: "approve", workspaceStrategy: "shared"
  });
  const started = control.missionAction(mission.id, "start");
  const orchestrator = control.getAgentPublic(started.orchestratorId);
  control.markAgentInterrupted(orchestrator.id, orchestrator.epoch);
  const agent = control.createAgent(mission.id, "Approval worker", roles[1].id, "Run the scripted effect fixture.", "approval-http-open", remote.id);
  await service.workers.startAgent(control.getAgentPublic(agent.id));
  await waitFor(() => control.remoteRuntimeForAgent(agent.id)?.state === "running");
  const initialRuntime = control.remoteRuntimeForAgent(agent.id);
  const initialWorkerDb = new DatabaseSync(join(nodeHome, "worker-runtime", "node-workers.sqlite"), { readOnly: true });
  let initialWorker;
  try {
    initialWorker = initialWorkerDb.prepare("SELECT pid FROM node_worker_runtimes WHERE runtime_id=?")
      .get(initialRuntime.runtime_id);
  } finally {
    initialWorkerDb.close();
  }
  assert.ok(Number.isSafeInteger(initialWorker?.pid));
  await waitFor(() => control.db.prepare("SELECT 1 FROM approvals WHERE mission_id=? AND status='pending'").get(mission.id));
  const approvals = () => control.db.prepare("SELECT data FROM approvals WHERE mission_id=? ORDER BY rowid").all(mission.id).map(row => JSON.parse(row.data));
  const denied = approvals().find(item => item.tool === "bash");
  assert.ok(denied, nodeOutput);
  const callsBeforeWait = control.db.prepare("SELECT COUNT(*) AS count FROM generation_admissions WHERE agent_id=?").get(agent.id).count;
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(control.db.prepare("SELECT COUNT(*) AS count FROM generation_admissions WHERE agent_id=?").get(agent.id).count, callsBeforeWait);
  const bootstrap = await fetch(`http://127.0.0.1:${service.port}/api/bootstrap`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const adminHeaders = {
    cookie, origin: `http://127.0.0.1:${service.port}`,
    "x-requested-with": "MissionControl", "content-type": "application/json"
  };
  const denyResponse = await fetch(`http://127.0.0.1:${service.port}/api/approvals/${denied.id}`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ decision: "denied" })
  });
  assert.equal(denyResponse.status, 200);
  assert.equal(existsSync(join(root, "effect-marker")), false);
  await waitFor(() => approvals().some(item => item.tool === "write_file" && item.status === "pending"));
  const approved = approvals().find(item => item.tool === "write_file");
  assert.ok(approved, nodeOutput);
  const approveResponse = await fetch(`http://127.0.0.1:${service.port}/api/approvals/${approved.id}`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ decision: "approved" })
  });
  assert.equal(approveResponse.status, 200);
  const decisionResult = await approveResponse.json();
  assert.equal(decisionResult.status, approvals().find(item => item.id === approved.id)?.status);
  await waitFor(() => approvals().find(item => item.id === approved.id)?.status === "succeeded");
  await waitFor(() => control.detail(mission.id).events.some(event =>
    event.type === "agent_report" && event.agentId === agent.id));
  await waitFor(() => control.detail(mission.id).messages.find(item =>
    item.id === `approval-execution:${approved.id}:succeeded`)?.status === "completed");
  await waitFor(() => existsSync(join(root, "remote-effect.txt")));
  assert.equal(readFileSync(join(root, "remote-effect.txt"), "utf8"), "node-only");
  assert.equal(existsSync(join(root, "effect-marker")), false);
  assert.equal(existsSync(join(localPath, "remote-effect.txt")), false);
  assert.equal(existsSync(join(localPath, "effect-marker")), false);
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_receipt").length, 1);
  assert.equal(control.detail(mission.id).events.filter(event =>
    event.type === "agent_report" && event.agentId === agent.id).length, 1);
  assert.equal(control.detail(mission.id).messages.filter(item =>
    item.id === `approval-execution:${approved.id}:succeeded`).length, 1);
  assert.equal(approvals().filter(item => item.tool === "write_file").length, 1);
  assert.equal(approvals().filter(item => item.tool === "bash").length, 1);
  const savedApproved = approvals().find(item => item.id === approved.id);
  assert.equal(savedApproved.remoteEffectReceipt.status, "succeeded");
  assert.equal(savedApproved.remoteEffectReceipt.result.bytes, 9);
  assert.match(savedApproved.remoteEffectReceipt.result.path, /\/remote-effect\.txt$/);
  assert.deepEqual(savedApproved.receipt, {
    stdout: JSON.stringify(savedApproved.remoteEffectReceipt.result), stderr: "", exitCode: 0
  });
  const runtime = control.remoteRuntimeForAgent(agent.id);
  const binding = {
    runtimeId: runtime.runtime_id, machineId: runtime.machine_id, sessionId: runtime.session_id,
    sessionEpoch: runtime.session_epoch, agentId: runtime.agent_id, epoch: runtime.epoch
  };
  assert.equal(control.workerMailbox.inspectOutbox(binding).some(({ envelope }) =>
    envelope.payload.kind === "approved-effect"), true);
  assert.equal(control.workerMailbox.inspectOutbox(binding).filter(({ envelope }) =>
    envelope.payload.kind === "approved-effect").length, 1);
  assert.equal((control.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtimes WHERE agent_id=?").get(agent.id)).count, 1);
  const nodeWorkerDb = new DatabaseSync(join(nodeHome, "worker-runtime", "node-workers.sqlite"), { readOnly: true });
  let workerRows;
  try {
    workerRows = nodeWorkerDb.prepare("SELECT runtime_id,pid,state FROM node_worker_runtimes WHERE runtime_id=?")
      .all(runtime.runtime_id);
  } finally {
    nodeWorkerDb.close();
  }
  assert.equal(workerRows.length, 1);
  assert.equal(workerRows[0].state, "running");
  assert.equal(workerRows[0].pid, initialWorker.pid);
  assert.equal(node.exitCode, null, nodeOutput);
  assert.equal(node.signalCode, null, nodeOutput);
});
