import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { NodeEffectJournal } from "../dist/node-effects.js";
import { startServer } from "../dist/server.js";

const waitFor = async predicate => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error("timed out waiting for remote effects runtime");
};

test("real node supervisor executes workspace effects once, records receipts, and recovers executing rows as uncertain", async t => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-remote-effects-"));
  const root = join(home, "remote-root"), localPath = join(home, "local-workspace"), nodeHome = join(home, "node-home");
  mkdirSync(root); mkdirSync(localPath);
  const service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0 });
  const control = service.control;
  const enrolled = control.enrollMachine("real-effects-node", "Real effects node");
  const nodeModule = new URL("../dist/node.js", import.meta.url).href;
  const supervisorModule = new URL("../dist/node-workers.js", import.meta.url).href;
  const nodeOptions = {
    coordinator: `http://127.0.0.1:${service.nodePort}`, machineId: enrolled.machine.id,
    tokenEnv: "NODE_AUTH_TOKEN", home: nodeHome, roots: [root], credentialRefs: [],
    executionMode: "workspace-effects", testOnlyScripted: true, testOnlyWorkspaceEffectLoop: true
  };
  let node, recoveryProcess, nodeOutput = "", recoveryOutput = "";
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
    await stopNode(recoveryProcess);
    await service.close();
    rmSync(home, { recursive: true, force: true });
  });
  node = spawnNode();
  await waitFor(() => control.machineRegistry.get(enrolled.machine.id)?.status === "online");
  const machine = control.machineRegistry.get(enrolled.machine.id);
  assert.equal(machine.capabilities.protocol, 3);
  assert.equal(machine.capabilities.executionMode, "workspace-effects");
  const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), root);
  await waitFor(() => control.machineCommand(enrolled.machine.id, probe.id).status === "completed");
  const remote = control.addRemoteWorkspace("Remote effects workspace", enrolled.machine.id, probe.id);
  const local = control.addWorkspace("Local delivery workspace", localPath);
  const profile = {
    id: "remote-effects-profile", name: "Fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "http://127.0.0.1:9/v1", credentialEnv: "", contextWindow: 4096, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  control.upsertProfile(profile);
  const roles = [
    { id: "effects-orchestrator", name: "orchestrator", kind: "orchestrator", instructions: "coordinate", profileId: profile.id },
    { id: "effects-worker", name: "worker", kind: "worker", instructions: "use workspace effects", profileId: profile.id },
    { id: "effects-validator", name: "validator", kind: "validator", instructions: "validate", profileId: profile.id }
  ];
  for (const role of roles) control.upsertRole(role);
  const mission = control.createMission({
    title: "Remote effects integration", goal: "perform node-local effects",
    acceptance: "a node-only file and receipt are recorded once", workspaceId: local.id,
    remoteWorkspaceIds: [remote.id], roleIds: roles.map(role => role.id),
    maxTurns: 10, maxCost: 0, autonomy: "trusted", workspaceStrategy: "shared"
  });
  const started = control.missionAction(mission.id, "start");
  const orchestrator = control.getAgentPublic(started.orchestratorId);
  control.markAgentInterrupted(orchestrator.id, orchestrator.epoch);
  const agent = control.createAgent(mission.id, "Remote effects worker", roles[1].id, "Perform test effects.", "effects-worker-open", remote.id);
  await service.workers.startAgent(control.getAgentPublic(agent.id));
  await waitFor(() => control.remoteRuntimeForAgent(agent.id)?.state === "running");
  const runtime = control.remoteRuntimeForAgent(agent.id);
  const binding = {
    runtimeId: runtime.runtime_id, machineId: runtime.machine_id, sessionId: runtime.session_id,
    sessionEpoch: runtime.session_epoch, agentId: runtime.agent_id, epoch: runtime.epoch
  };
  await waitFor(() => control.detail(mission.id).messages.find(item => item.recipientId === agent.id)?.status === "completed");
  assert.equal(readFileSync(join(root, "remote-effect.txt"), "utf8"), "node-only");
  assert.equal(readFileSync(join(root, "effect-marker"), "utf8"), "x");
  assert.equal(existsSync(join(localPath, "remote-effect.txt")), false);
  assert.equal(control.detail(mission.id).events.filter(event => event.type === "remote_effect_receipt").length, 2);
  const bashPermitReply = control.workerMailbox.inspectOutbox(binding).find(({ envelope }) =>
    envelope.payload.kind === "reply" && envelope.payload.ok &&
    envelope.payload.result?.effectPermit?.method === "bash")?.envelope;
  assert.ok(bashPermitReply);
  const duplicatePermitReply = control.workerMailbox.enqueue(binding, bashPermitReply.payload);
  await waitFor(() => control.workerMailbox.inspectOutbox(binding)
    .some(item => item.envelope.messageId === duplicatePermitReply.messageId && item.status === "acknowledged"));
  assert.equal(control.remoteRuntimeForAgent(agent.id).state, "running");
  assert.equal(readFileSync(join(root, "effect-marker"), "utf8"), "x");
  assert.equal(node.exitCode, null, nodeOutput);
  assert.equal(node.signalCode, null, nodeOutput);
  assert.equal((control.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtimes WHERE agent_id=?").get(agent.id)).count, 1);

  await stopNode(node);
  node = undefined;
  const dbPath = join(nodeHome, "worker-runtime", "node-workers.sqlite");
  const db = new DatabaseSync(dbPath);
  const journal = new NodeEffectJournal(db);
  const restartSpec = {
    binding, descriptorHash: runtime.descriptor_hash, taskId: `${agent.id}:restart-uncertain`,
    method: "bash", args: { command: "printf rerun >> effect-marker" }
  };
  journal.admit(restartSpec);
  assert.deepEqual(journal.begin(restartSpec), { execute: true });
  db.close();
  const recoveryOptions = {
    home: join(nodeHome, "worker-runtime"), machineId: binding.machineId,
    sessionId: binding.sessionId, sessionEpoch: binding.sessionEpoch,
    roots: [root], credentialRefs: [], forbiddenCredentialRefs: ["NODE_AUTH_TOKEN"],
    executionEnabled: true, executionMode: "workspace-effects", isLeaseCurrent: () => false
  };
  const recoveryScript = `import { NodeWorkerSupervisor } from ${JSON.stringify(supervisorModule)}; const options = ${JSON.stringify(recoveryOptions)}; options.isLeaseCurrent = () => false; const supervisor = new NodeWorkerSupervisor(options); await supervisor.close();`;
  recoveryProcess = spawn(process.execPath, ["--input-type=module", "-e", recoveryScript], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  recoveryProcess.stdout.setEncoding("utf8");
  recoveryProcess.stderr.setEncoding("utf8");
  recoveryProcess.stdout.on("data", chunk => { recoveryOutput += chunk; });
  recoveryProcess.stderr.on("data", chunk => { recoveryOutput += chunk; });
  await waitFor(() => recoveryProcess.exitCode !== null || recoveryProcess.signalCode !== null);
  assert.equal(recoveryProcess.exitCode, 0, recoveryOutput);
  const findRecovered = () => {
    try {
      const recoveredDb = new DatabaseSync(dbPath, { readOnly: true });
      try {
        return recoveredDb.prepare("SELECT state,spec_json FROM node_effects").all()
          .map(row => ({ ...row, spec: JSON.parse(row.spec_json) }))
          .find(row => row.spec.taskId === restartSpec.taskId);
      } finally {
        recoveredDb.close();
      }
    } catch {
      return undefined;
    }
  };
  const recovered = findRecovered();
  assert.equal(recovered?.state, "uncertain");
  assert.equal(readFileSync(join(root, "effect-marker"), "utf8"), "x");
});
