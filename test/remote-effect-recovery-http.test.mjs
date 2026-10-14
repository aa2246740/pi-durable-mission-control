import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest, createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nodeEffectUpload } from "../dist/node-effects.js";
import { startServer } from "../dist/server.js";

const waitFor = async predicate => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error("timed out waiting for node receipt transport recovery");
};

test("runNode automatically retries a lost receipt ACK after same-machine reenrollment without replaying the effect", async t => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-effect-recovery-"));
  const root = join(home, "remote-root"), localPath = join(home, "local-workspace"), nodeHome = join(home, "node-home");
  mkdirSync(root); mkdirSync(localPath);
  const service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0 });
  const control = service.control;
  const enrolled = control.enrollMachine("receipt-recovery-node", "Receipt recovery node");
  const nodeModule = new URL("../dist/node.js", import.meta.url).href;
  const supervisorModule = new URL("../dist/node-workers.js", import.meta.url).href;
  const baseNodeOptions = {
    machineId: enrolled.machine.id, tokenEnv: "NODE_AUTH_TOKEN", home: nodeHome, roots: [root], credentialRefs: [],
    executionMode: "workspace-effects", testOnlyScripted: true, testOnlyWorkspaceEffectLoop: true
  };
  const nodeProcesses = [];
  const heldReceipts = [];
  const receiptRequests = [];
  const receiptAcks = [];
  let mailboxTrafficCount = 0;
  let receiptMode = "hold";
  let dropNextAck = false;
  let droppedAcks = 0;
  const proxy = createServer((incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const receiptRequest = incoming.url === "/api/nodes/effects/receipts";
      if (incoming.url?.startsWith("/api/nodes/mailbox/")) mailboxTrafficCount++;
      let parsedBody;
      if (receiptRequest) {
        parsedBody = JSON.parse(body.toString("utf8"));
        receiptRequests.push(parsedBody);
        if (receiptMode === "hold") {
          heldReceipts.push({ parsedBody, outgoing });
          return;
        }
        if (receiptMode === "reject") {
          outgoing.writeHead(400, { "content-type": "application/json" });
          outgoing.end(JSON.stringify({ error: "Fixture protocol rejection keeps initial receipt unacknowledged" }));
          return;
        }
      }
      const headers = { ...incoming.headers, host: `127.0.0.1:${service.nodePort}`, "content-length": body.length };
      delete headers.connection;
      delete headers["transfer-encoding"];
      const upstream = httpRequest({
        hostname: "127.0.0.1", port: service.nodePort, path: incoming.url, method: incoming.method, headers
      }, upstreamResponse => {
        const responseChunks = [];
        upstreamResponse.on("data", chunk => responseChunks.push(Buffer.from(chunk)));
        upstreamResponse.on("end", () => {
          const responseBody = Buffer.concat(responseChunks);
          if (receiptRequest && upstreamResponse.statusCode === 200) {
            receiptAcks.push(JSON.parse(responseBody.toString("utf8")));
            if (dropNextAck) {
              dropNextAck = false;
              droppedAcks++;
              receiptMode = "hold";
              outgoing.destroy();
              return;
            }
          }
          const responseHeaders = { ...upstreamResponse.headers };
          delete responseHeaders.connection;
          delete responseHeaders["transfer-encoding"];
          outgoing.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          outgoing.end(responseBody);
        });
      });
      upstream.on("error", () => outgoing.destroy());
      upstream.end(body);
    });
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;
  const spawnNode = token => {
    const options = { ...baseNodeOptions, coordinator: `http://127.0.0.1:${proxyPort}` };
    const script = `import { runNode } from ${JSON.stringify(nodeModule)}; runNode(${JSON.stringify(options)}).catch(error => { process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, NODE_AUTH_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"]
    });
    child.outputText = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { child.outputText += chunk; });
    child.stderr.on("data", chunk => { child.outputText += chunk; });
    nodeProcesses.push(child);
    return child;
  };
  const stopNode = async child => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("exit", resolve));
    }
  };
  const effectDbPath = join(nodeHome, "worker-runtime", "node-workers.sqlite");
  const readEffectJournal = () => {
    const db = new DatabaseSync(effectDbPath, { readOnly: true });
    try {
      return db.prepare(`
        SELECT e.effect_id,e.state,e.spec_json,e.receipt_json,a.receipt_hash
        FROM node_effects e LEFT JOIN node_effect_upload_acks a ON a.effect_id=e.effect_id
        ORDER BY e.created_at,e.effect_id
      `).all().map(row => ({
        ...row,
        spec: JSON.parse(row.spec_json),
        receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null
      }));
    } finally {
      db.close();
    }
  };
  const readNodeReports = runtimeId => {
    const db = new DatabaseSync(join(nodeHome, "node.sqlite"), { readOnly: true });
    try {
      return db.prepare(`
        SELECT report_id,runtime_id,binding_json,descriptor_hash,outcome,state,stop_reason
        FROM node_runtime_reports WHERE runtime_id=? ORDER BY created_at,report_id
      `).all(runtimeId).map(row => ({ ...row, binding: JSON.parse(row.binding_json) }));
    } finally {
      db.close();
    }
  };
  const readNodeIdentity = () => {
    const db = new DatabaseSync(join(nodeHome, "node.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT coordinator_id,machine_id FROM node_identity WHERE singleton=1").get();
    } finally {
      db.close();
    }
  };
  const receiptEventCount = missionId => control.detail(missionId).events
    .filter(event => event.type === "remote_effect_receipt").length;
  let node;
  t.after(async () => {
    for (const child of nodeProcesses) await stopNode(child);
    await new Promise(resolve => proxy.close(resolve));
    await service.close();
    rmSync(home, { recursive: true, force: true });
  });

  node = spawnNode(enrolled.token);
  await waitFor(() => control.machineRegistry.get(enrolled.machine.id)?.status === "online");
  const initialSession = control.machineRegistry.get(enrolled.machine.id);
  const initialNodeIdentity = readNodeIdentity();
  const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), root);
  await waitFor(() => control.machineCommand(enrolled.machine.id, probe.id).status === "completed");
  const remote = control.addRemoteWorkspace("Receipt recovery workspace", enrolled.machine.id, probe.id);
  const local = control.addWorkspace("Receipt recovery delivery", localPath);
  const profile = {
    id: "receipt-recovery-profile", name: "Fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "http://127.0.0.1:9/v1", credentialEnv: "", contextWindow: 4096, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  control.upsertProfile(profile);
  const roles = [
    { id: "receipt-recovery-orchestrator", name: "orchestrator", kind: "orchestrator", instructions: "coordinate", profileId: profile.id },
    { id: "receipt-recovery-worker", name: "worker", kind: "worker", instructions: "use workspace effects", profileId: profile.id },
    { id: "receipt-recovery-validator", name: "validator", kind: "validator", instructions: "validate", profileId: profile.id }
  ];
  for (const role of roles) control.upsertRole(role);
  const mission = control.createMission({
    title: "Receipt recovery integration", goal: "execute one node effect exactly once",
    acceptance: "terminal effect evidence retries without effect replay", workspaceId: local.id,
    remoteWorkspaceIds: [remote.id], roleIds: roles.map(role => role.id),
    maxTurns: 10, maxCost: 0, autonomy: "trusted", workspaceStrategy: "shared"
  });
  const started = control.missionAction(mission.id, "start");
  const orchestrator = control.getAgentPublic(started.orchestratorId);
  control.markAgentInterrupted(orchestrator.id, orchestrator.epoch);
  const agent = control.createAgent(mission.id, "Recovery worker", roles[1].id, "Perform test effect.", "receipt-recovery-open", remote.id);
  await service.workers.startAgent(control.getAgentPublic(agent.id));
  await waitFor(() => control.remoteRuntimeForAgent(agent.id)?.state === "running");
  const runtime = control.remoteRuntimeForAgent(agent.id);
  const binding = {
    runtimeId: runtime.runtime_id, machineId: runtime.machine_id, sessionId: runtime.session_id,
    sessionEpoch: runtime.session_epoch, agentId: runtime.agent_id, epoch: runtime.epoch
  };
  await waitFor(() => heldReceipts.length === 1);
  await waitFor(() => {
    try {
      const rows = readEffectJournal();
      return rows.length === 1 && rows[0].state === "succeeded" && rows[0].receipt;
    } catch {
      return false;
    }
  });
  const originalRows = readEffectJournal();
  assert.equal(originalRows.length, 1);
  assert.equal(originalRows[0].state, "succeeded");
  const originalUpload = nodeEffectUpload(originalRows[0].spec, originalRows[0].receipt);
  assert.deepEqual(heldReceipts[0].parsedBody.upload, JSON.parse(JSON.stringify(originalUpload)));
  assert.equal(originalRows[0].receipt.status, "succeeded");
  assert.equal(originalRows[0].receipt.result.exitCode, 0);
  assert.equal(receiptEventCount(mission.id), 0);
  assert.equal(readFileSync(join(root, "effect-marker"), "utf8"), "x");

  control.missionAction(mission.id, "pause");
  await service.workers.pauseMission(mission.id);
  assert.equal(control.missionById(mission.id).status, "paused");
  const pausedDetails = {
    mission: control.missionById(mission.id),
    agents: control.listAgents(mission.id),
    messages: control.detail(mission.id).messages,
    budget: control.detail(mission.id).budget
  };
  // A protocol rejection remains fatal; transport loss alone now retries.
  receiptMode = "reject";
  heldReceipts[0].outgoing.destroy();
  await waitFor(() => node.exitCode !== null || node.signalCode !== null);
  assert.equal(node.exitCode, 1, node.outputText);
  assert.equal(receiptEventCount(mission.id), 0);
  assert.equal(readFileSync(join(root, "effect-marker"), "utf8"), "x");
  const localReports = readNodeReports(binding.runtimeId);
  const stopReport = localReports.find(report => report.outcome === "stopped");
  assert.ok(stopReport);
  assert.equal(stopReport.stop_reason, "unexpected");
  const stoppedResponse = await fetch(`http://127.0.0.1:${service.nodePort}/api/nodes/runtimes/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${enrolled.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      machineId: enrolled.machine.id,
      sessionId: initialSession.sessionId,
      sessionEpoch: initialSession.sessionEpoch,
      reportId: stopReport.report_id,
      binding: stopReport.binding,
      descriptorHash: stopReport.descriptor_hash,
      outcome: stopReport.outcome,
      stopReason: stopReport.stop_reason
    })
  });
  const stoppedText = await stoppedResponse.text();
  assert.equal(stoppedResponse.status, 200, stoppedText);
  assert.equal(JSON.parse(stoppedText).recorded, true);
  assert.equal(control.remoteRuntimeForAgent(agent.id).state, "closed");
  assert.equal(control.remoteRuntimeForAgent(agent.id).stop_provenance, "unexpected");
  assert.equal(receiptEventCount(mission.id), 0);
  const workerDb = new DatabaseSync(effectDbPath, { readOnly: true });
  let workerRuntime;
  try {
    workerRuntime = workerDb.prepare("SELECT runtime_id,state,pid,confirmed_stopped FROM node_worker_runtimes WHERE runtime_id=?")
      .get(binding.runtimeId);
  } finally {
    workerDb.close();
  }
  assert.equal(workerRuntime.state, "closed");
  assert.equal(workerRuntime.confirmed_stopped, 1);
  assert.ok(Number.isSafeInteger(workerRuntime.pid) && workerRuntime.pid > 0);
  assert.throws(() => process.kill(workerRuntime.pid, 0), error => error.code === "ESRCH");
  const mailboxTrafficBeforeRecovery = mailboxTrafficCount;

  control.revokeMachine(enrolled.machine.id);
  const reenrolledOnce = control.reenrollMachine(enrolled.machine.id);
  receiptMode = "forward";
  dropNextAck = true;
  node = spawnNode(reenrolledOnce.token);
  await waitFor(() => droppedAcks === 1);
  const reconnectPid = node.pid;
  const reconnectSession = control.machineRegistry.get(enrolled.machine.id).sessionId;
  await waitFor(() => node.outputText.includes("retrying"));
  assert.equal(node.exitCode, null, node.outputText);
  assert.equal(receiptEventCount(mission.id), 1);
  assert.equal(receiptAcks.length, 1);
  assert.equal(receiptAcks[0].duplicate, false);
  const afterLostAck = readEffectJournal();
  assert.equal(afterLostAck.length, 1);
  assert.equal(afterLostAck[0].receipt_hash, null);
  assert.equal(nodeEffectUpload(afterLostAck[0].spec, afterLostAck[0].receipt).receiptHash, originalUpload.receiptHash);
  assert.deepEqual(receiptRequests.at(-1).upload, JSON.parse(JSON.stringify(originalUpload)));

  receiptMode = "forward";
  for (const held of heldReceipts) held.outgoing.destroy();
  await waitFor(() => receiptAcks.length === 2);
  assert.equal(node.pid, reconnectPid);
  assert.equal(node.exitCode, null, node.outputText);
  assert.equal(control.machineRegistry.get(enrolled.machine.id).sessionId, reconnectSession);
  assert.equal(receiptAcks[1].duplicate, true);
  await waitFor(() => {
    try {
      const rows = readEffectJournal();
      return rows.length === 1 && rows[0].receipt_hash === originalUpload.receiptHash;
    } catch {
      return false;
    }
  });
  assert.deepEqual(receiptRequests.at(-1).upload, JSON.parse(JSON.stringify(originalUpload)));
  assert.equal(receiptEventCount(mission.id), 1);
  assert.equal(readFileSync(join(root, "effect-marker"), "utf8"), "x");
  await stopNode(node);
  assert.equal(node.exitCode, 0, node.outputText);
  node = undefined;

  const persisted = readEffectJournal();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].receipt_hash, originalUpload.receiptHash);
  assert.equal(persisted[0].state, "succeeded");
  assert.equal(receiptEventCount(mission.id), 1);
  assert.equal(mailboxTrafficCount, mailboxTrafficBeforeRecovery);
  assert.deepEqual(control.missionById(mission.id), pausedDetails.mission);
  assert.deepEqual(control.listAgents(mission.id), pausedDetails.agents);
  assert.deepEqual(control.detail(mission.id).messages, pausedDetails.messages);
  assert.deepEqual(control.detail(mission.id).budget, pausedDetails.budget);
  assert.equal(control.remoteRuntimeForAgent(agent.id).state, "closed");
  assert.equal(control.listAgents(mission.id).filter(item => item.id === agent.id).length, 1);
  assert.equal((control.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtimes WHERE agent_id=?").get(agent.id)).count, 1);

  const currentMachine = control.machineRegistry.get(enrolled.machine.id);
  const reopenOptions = {
    home: join(nodeHome, "worker-runtime"), machineId: enrolled.machine.id,
    sessionId: currentMachine.sessionId, sessionEpoch: currentMachine.sessionEpoch,
    roots: [root], credentialRefs: [], forbiddenCredentialRefs: ["NODE_AUTH_TOKEN"],
    executionEnabled: true, executionMode: "workspace-effects", isLeaseCurrent: () => false
  };
  const reopenScript = `import { NodeWorkerSupervisor } from ${JSON.stringify(supervisorModule)}; const options = ${JSON.stringify(reopenOptions)}; options.isLeaseCurrent = () => false; const supervisor = new NodeWorkerSupervisor(options); await supervisor.close();`;
  const reopen = spawn(process.execPath, ["--input-type=module", "-e", reopenScript], { stdio: ["ignore", "pipe", "pipe"] });
  let reopenOutput = "";
  reopen.stdout.setEncoding("utf8"); reopen.stderr.setEncoding("utf8");
  reopen.stdout.on("data", chunk => { reopenOutput += chunk; });
  reopen.stderr.on("data", chunk => { reopenOutput += chunk; });
  await waitFor(() => reopen.exitCode !== null || reopen.signalCode !== null);
  assert.equal(reopen.exitCode, 0, reopenOutput);
  const afterSupervisorReopen = readEffectJournal();
  assert.equal(afterSupervisorReopen.length, 1);
  assert.equal(afterSupervisorReopen[0].receipt_hash, originalUpload.receiptHash);
  const reopenedWorkerDb = new DatabaseSync(effectDbPath, { readOnly: true });
  try {
    const runtimeAfterReopen = reopenedWorkerDb.prepare("SELECT runtime_id,state,pid,confirmed_stopped FROM node_worker_runtimes WHERE runtime_id=?")
      .get(binding.runtimeId);
    assert.deepEqual(runtimeAfterReopen, workerRuntime);
  } finally {
    reopenedWorkerDb.close();
  }
  assert.deepEqual(readNodeIdentity(), initialNodeIdentity);
  assert.equal(receiptAcks.length, 2);
  assert.equal(droppedAcks, 1);
  assert.equal(mailboxTrafficCount, mailboxTrafficBeforeRecovery);
  assert.equal(readFileSync(join(root, "effect-marker"), "utf8"), "x");
});
