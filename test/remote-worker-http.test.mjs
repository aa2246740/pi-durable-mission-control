import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../dist/server.js";

const waitFor = async (predicate, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("timed out waiting for remote runtime");
};

const post = async (base, token, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const value = await response.json();
  assert.ok(response.status >= 200 && response.status < 300, `${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
};

test("real node process performs metadata-only assignment, durable delivery, RPC admission, and physical stop", { timeout: 90000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-remote-http-"));
  const root = join(home, "remote-root");
  const localWorkspacePath = join(home, "local-workspace");
  const nodeHome = join(home, "node-home");
  mkdirSync(root, { recursive: true });
  mkdirSync(localWorkspacePath, { recursive: true });
  const credentialName = "MC_NODE_TEST_CREDENTIAL";
  const credentialValue = "node-only-model-secret-never-in-coordinator";
  const priorCredential = process.env[credentialName];
  delete process.env[credentialName];
  let service;
  let node;
  let nodeOutput = "";
  try {
    service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0 });
    const control = service.control;
    const adminToken = readFileSync(join(home, "control", "admin.token"), "utf8").trim();
    const adminBase = `http://127.0.0.1:${service.port}`;
    const nodeBase = `http://127.0.0.1:${service.nodePort}`;
    const enrolled = control.enrollMachine("real-metadata-node", "Real metadata node");
    const nodeModule = new URL("../dist/node.js", import.meta.url).href;
    const nodeOptions = {
      coordinator: nodeBase,
      machineId: enrolled.machine.id,
      tokenEnv: "NODE_AUTH_TOKEN",
      home: nodeHome,
      roots: [root],
      credentialRefs: [credentialName],
      executionMode: "metadata-only",
      testOnlyScripted: true,
      testOnlyToolLoop: true
    };
    const script = `import { runNode } from ${JSON.stringify(nodeModule)}; process.on("SIGTERM", () => process.stderr.write("node-signal:SIGTERM\\n")); process.on("SIGINT", () => process.stderr.write("node-signal:SIGINT\\n")); runNode(${JSON.stringify(nodeOptions)}).catch((error) => { process.stderr.write("node runtime failed\\n"); process.exitCode = 1; });`;
    node = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, NODE_AUTH_TOKEN: enrolled.token, [credentialName]: credentialValue },
      stdio: ["ignore", "pipe", "pipe"]
    });
    node.stdout.setEncoding("utf8");
    node.stderr.setEncoding("utf8");
    node.stdout.on("data", (chunk) => { nodeOutput += chunk; });
    node.stderr.on("data", (chunk) => { nodeOutput += chunk; });
    t.after(async () => {
      if (node && node.exitCode === null && node.signalCode === null) {
        node.kill("SIGTERM");
        await new Promise((resolve) => node.once("exit", resolve));
      }
      if (service) await service.close();
      rmSync(home, { recursive: true, force: true });
      if (priorCredential === undefined) delete process.env[credentialName];
      else process.env[credentialName] = priorCredential;
    });

    await waitFor(() => control.machineRegistry.get(enrolled.machine.id)?.status === "online");
    const machine = control.machineRegistry.get(enrolled.machine.id);
    assert.equal(machine.capabilities.protocol, 2);
    assert.equal(machine.capabilities.executionEnabled, true);
    assert.equal(machine.capabilities.executionMode, "metadata-only");
    assert.deepEqual(machine.capabilities.credentialRefs, [credentialName]);
    assert.equal(process.env[credentialName], undefined);

    const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), root);
    await waitFor(() => control.machineCommand(enrolled.machine.id, probe.id).status === "completed");
    const remoteWorkspace = await post(adminBase, adminToken, "/api/workspaces", {
      name: "Remote node workspace", machineId: enrolled.machine.id, probeCommandId: probe.id
    });
    const localWorkspace = await post(adminBase, adminToken, "/api/workspaces", {
      name: "Local delivery workspace", path: localWorkspacePath, machineId: "local"
    });

    const localProfile = {
      id: "real-http-local-profile", name: "Local fixture profile", api: "openai-completions",
      modelId: "fixture-local", baseUrl: "http://127.0.0.1:9/v1", credentialEnv: "",
      contextWindow: 4096, maxTokens: 512, reasoning: false, toolCalling: true, vision: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
    const remoteProfile = {
      ...localProfile, id: "real-http-remote-profile", name: "Node-only fixture profile",
      modelId: "fixture-remote", credentialEnv: credentialName, contextWindow: 16000
    };
    await post(adminBase, adminToken, "/api/profiles", localProfile);
    await post(adminBase, adminToken, "/api/profiles", remoteProfile);
    const roles = [
      { id: "real-http-orchestrator", name: "orchestrator", kind: "orchestrator", instructions: "coordinate", profileId: localProfile.id },
      { id: "real-http-worker", name: "worker", kind: "worker", instructions: "metadata-only worker", profileId: remoteProfile.id },
      { id: "real-http-validator", name: "validator", kind: "validator", instructions: "validate", profileId: localProfile.id }
    ];
    for (const role of roles) await post(adminBase, adminToken, "/api/roles", { ...role, mcpPermissions: [] });
    const mission = await post(adminBase, adminToken, "/api/missions", {
      title: "Real remote metadata fixture", goal: "deliver one faux turn",
      acceptance: "admission and settlement are durable", workspaceId: localWorkspace.id,
      remoteWorkspaceIds: [remoteWorkspace.id], roleIds: roles.map((role) => role.id),
      maxTurns: 10, maxCost: 0, autonomy: "trusted",
      assertions: [{ id: "REMOTE-METADATA", description: "The faux metadata turn is admitted and settled." }],
      workspaceStrategy: "shared"
    });
    const started = control.missionAction(mission.id, "start");
    const orchestrator = control.getAgentPublic(started.orchestratorId);
    // This fixture intentionally does not start the local orchestrator: it isolates
    // the remote path and leaves no local worker process to confuse the proof.
    control.markAgentInterrupted(orchestrator.id);
    const methods = [];
    const rpcResults = [];
    const runtimeReports = [];
    const originalWorkerCommand = control.workerCommand.bind(control);
    control.workerCommand = async (request) => {
      methods.push(request.method);
      try {
        const result = await originalWorkerCommand(request);
        rpcResults.push({ method: request.method, resultType: Array.isArray(result) ? "array" : typeof result,
          resultKeys: result && typeof result === "object" ? Object.keys(result).slice(0, 8) : undefined });
        return result;
      } catch (error) {
        rpcResults.push({ method: request.method, rejected: error instanceof Error ? error.constructor.name : "unknown" });
        throw error;
      }
    };
    const originalRuntimeReport = control.nodeRuntimeReport.bind(control);
    control.nodeRuntimeReport = (...args) => {
      const outcome = args.at(-1)?.outcome;
      try {
        const result = originalRuntimeReport(...args);
        runtimeReports.push({ outcome, result });
        return result;
      } catch (error) {
        runtimeReports.push({ outcome, errorType: error?.constructor?.name, status: error?.status });
        throw error;
      }
    };

    const remoteAgent = await post(adminBase, adminToken, `/api/missions/${mission.id}/agents`, {
      title: "Remote metadata worker", roleId: "real-http-worker", prompt: "Process this metadata-only turn.",
      requestId: "real-http-worker-1", targetWorkspaceId: remoteWorkspace.id
    });
    assert.equal(remoteAgent.machineId, enrolled.machine.id);
    assert.equal(service.workers.handles.size, 0);
    assert.equal(service.workers.handles.has(remoteAgent.id), false);
    assert.equal(existsSync(join(home, "control", "agents", `${remoteAgent.id}.sqlite`)), false);
    const runtimeBefore = control.remoteRuntimeForAgent(remoteAgent.id);
    assert.ok(runtimeBefore);
    const duplicateStart = service.workers.startAgent(control.getAgentPublic(remoteAgent.id));
    const sameStart = service.workers.startAgent(control.getAgentPublic(remoteAgent.id));
    await Promise.all([duplicateStart, sameStart]);
    assert.equal(control.remoteRuntimeForAgent(remoteAgent.id).runtime_id, runtimeBefore.runtime_id);
    assert.equal((control.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtimes WHERE agent_id=?").get(remoteAgent.id)).count, 1);

    const unauthenticated = await fetch(`${nodeBase}/api/nodes/runtimes/poll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ machineId: enrolled.machine.id, sessionId: machine.sessionId, sessionEpoch: machine.sessionEpoch })
    });
    assert.equal(unauthenticated.status, 401);

    await waitFor(() => control.remoteRuntimeForAgent(remoteAgent.id)?.state === "running");
    const running = control.remoteRuntimeForAgent(remoteAgent.id);
    assert.ok(running);
    const binding = {
      runtimeId: running.runtime_id, machineId: running.machine_id, sessionId: running.session_id,
      sessionEpoch: running.session_epoch, agentId: running.agent_id, epoch: running.epoch
    };
    const snapshot = await (await fetch(`${adminBase}/api/missions/${mission.id}/runtimes`, {
      headers: { authorization: `Bearer ${adminToken}` }
    })).json();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].state, "running");
    assert.equal(Object.hasOwn(snapshot[0], "descriptor"), false);
    assert.equal(Object.hasOwn(snapshot[0], "credential"), false);

    try {
      await waitFor(() => {
        const detail = control.detail(mission.id);
        const message = detail.messages.find((item) => item.recipientId === remoteAgent.id);
        return message?.status === "completed";
      }, 12000);
    } catch {
      const debugDb = new DatabaseSync(join(nodeHome, "worker-runtime", "node-workers.sqlite"), { readOnly: true });
      const localRuntime = debugDb.prepare("SELECT state,pid,confirmed_stopped FROM node_worker_runtimes WHERE runtime_id=?").get(running.runtime_id);
      debugDb.close();
      const pending = control.pendingOutbox().filter((row) => row.mission_id === mission.id);
      const detail = control.detail(mission.id);
      throw new Error(JSON.stringify({
        nodeExit: node.exitCode, nodeOutputPresent: nodeOutput.length > 0, nodeRuntimeFailed: nodeOutput.includes("node runtime failed"),
        runtime: control.remoteRuntimeForAgent(remoteAgent.id)?.state, localRuntime,
        message: detail.messages.find((item) => item.recipientId === remoteAgent.id)?.status,
        outbox: pending.map(({ status, message_id }) => ({ status, message_id })),
        mailbox: control.workerMailbox.inspectBindings().map(({ agentId, status }) => ({ agentId, status })),
        mailboxInbox: control.workerMailbox.inspectInbox(binding).map(({ envelope, status }) => ({
          kind: envelope.payload.kind,
          method: envelope.payload.kind === "rpc" ? envelope.payload.method : undefined,
          notice: envelope.payload.kind === "notice" ? envelope.payload.notice.type : undefined,
          status
        })),
        mailboxOutbox: control.workerMailbox.inspectOutbox(binding).map(({ envelope, status }) => ({
          kind: envelope.payload.kind, method: envelope.payload.kind === "reply" ? envelope.payload.rpcId : undefined, status
        })),
        agentStatus: control.getAgentPublic(remoteAgent.id)?.status, methods, rpcResults
      }));
    }
    const detail = control.detail(mission.id);
    const remoteMessage = detail.messages.find((item) => item.recipientId === remoteAgent.id);
    assert.equal(remoteMessage.status, "completed");
    assert.ok(methods.includes("AdmitTurn"));
    assert.ok(methods.includes("Transcript"));
    assert.ok(detail.events.some((event) => event.type === "delivery_admitted"));
    assert.equal(service.workers.handles.size, 0);

    const nodeDb = new DatabaseSync(join(nodeHome, "worker-runtime", "node-workers.sqlite"), { readOnly: true });
    const workerRow = nodeDb.prepare("SELECT runtime_id,pid,state,confirmed_stopped FROM node_worker_runtimes WHERE runtime_id=?").get(running.runtime_id);
    assert.equal(workerRow.runtime_id, running.runtime_id);
    assert.equal(typeof workerRow.pid, "number");
    nodeDb.close();

    const pause = await post(adminBase, adminToken, `/api/missions/${mission.id}/pause`, {});
    assert.equal(pause.status, "paused");
    try {
      await waitFor(() => control.remoteRuntimeForAgent(remoteAgent.id)?.state === "closed", 40000);
    } catch {
      const debugDb = new DatabaseSync(join(nodeHome, "worker-runtime", "node-workers.sqlite"), { readOnly: true });
      const localRuntime = debugDb.prepare("SELECT state,pid,confirmed_stopped FROM node_worker_runtimes WHERE runtime_id=?").get(running.runtime_id);
      debugDb.close();
      const journalDb = new DatabaseSync(join(nodeHome, "node.sqlite"), { readOnly: true });
      const reports = journalDb.prepare("SELECT outcome,state FROM node_runtime_reports WHERE runtime_id=?").all(running.runtime_id);
      journalDb.close();
      throw new Error(JSON.stringify({
        nodeExit: node.exitCode, nodeSignal: node.signalCode, nodeOutputPresent: nodeOutput.length > 0,
        localRuntime, reports, remoteRuntime: control.remoteRuntimeForAgent(remoteAgent.id)?.state,
        machine: control.machineRegistry.get(enrolled.machine.id)?.status,
        mailbox: control.workerMailbox.inspectBinding(binding).status, runtimeReports,
        nodeSignalMarker: nodeOutput.match(/node-signal:(?:SIGTERM|SIGINT)/)?.[0]
      }));
    }
    const stopped = control.remoteRuntimeForAgent(remoteAgent.id);
    assert.equal(stopped.last_report_json && JSON.parse(stopped.last_report_json).outcome, "stopped");
    assert.ok(runtimeReports.some(({ outcome, result }) =>
      outcome === "stopped" && result?.recorded === true &&
      (result.duplicate === undefined || typeof result.duplicate === "boolean")));
    assert.equal(control.workerMailbox.inspectBinding(binding).status, "uncertain");
    const stoppedDb = new DatabaseSync(join(nodeHome, "worker-runtime", "node-workers.sqlite"), { readOnly: true });
    const stoppedRow = stoppedDb.prepare("SELECT pid,confirmed_stopped FROM node_worker_runtimes WHERE runtime_id=?").get(running.runtime_id);
    assert.equal(stoppedRow.confirmed_stopped, 1);
    assert.throws(() => process.kill(-stoppedRow.pid, 0), { code: "ESRCH" });
    const nodeMailboxRows = stoppedDb.prepare(`SELECT envelope_json FROM worker_mailbox_inbox
      UNION ALL SELECT envelope_json FROM worker_mailbox_outbox`).all();
    assert.equal(JSON.stringify(nodeMailboxRows).includes(credentialValue), false);
    assert.equal(JSON.stringify(nodeMailboxRows).includes(enrolled.token), false);
    stoppedDb.close();
    assert.equal(nodeOutput.includes(credentialValue), false);
    assert.equal(nodeOutput.includes(enrolled.token), false);

    const fencedMission = await post(adminBase, adminToken, "/api/missions", {
      title: "Mailbox fence fixture", goal: "stop when only the mailbox is fenced",
      acceptance: "the runtime reports its unexpected physical stop", workspaceId: localWorkspace.id,
      remoteWorkspaceIds: [remoteWorkspace.id], roleIds: roles.map((role) => role.id),
      maxTurns: 10, maxCost: 0, autonomy: "trusted",
      assertions: [{ id: "MAILBOX-FENCE", description: "A fenced mailbox stops its owned child." }],
      workspaceStrategy: "shared"
    });
    const fencedStarted = control.missionAction(fencedMission.id, "start");
    const fencedOrchestrator = control.getAgentPublic(fencedStarted.orchestratorId);
    control.markAgentInterrupted(fencedOrchestrator.id, fencedOrchestrator.epoch);
    const fencedAgent = await post(adminBase, adminToken, `/api/missions/${fencedMission.id}/agents`, {
      title: "Mailbox fence worker", roleId: "real-http-worker", prompt: "Wait for the mailbox fence.",
      requestId: "real-http-mailbox-fence-worker", targetWorkspaceId: remoteWorkspace.id
    });
    await service.workers.startAgent(control.getAgentPublic(fencedAgent.id));
    await waitFor(() => control.remoteRuntimeForAgent(fencedAgent.id)?.state === "running");
    const fencedRuntime = control.remoteRuntimeForAgent(fencedAgent.id);
    assert.ok(fencedRuntime);
    assert.equal(fencedRuntime.desired, "run");
    const fencedBinding = {
      runtimeId: fencedRuntime.runtime_id, machineId: fencedRuntime.machine_id, sessionId: fencedRuntime.session_id,
      sessionEpoch: fencedRuntime.session_epoch, agentId: fencedRuntime.agent_id, epoch: fencedRuntime.epoch
    };
    const leaseBeforeFence = control.machineRegistry.get(enrolled.machine.id)?.leaseExpiresAt ?? 0;
    control.workerMailbox.fence(fencedBinding);
    await waitFor(() => ["closed", "uncertain"].includes(control.remoteRuntimeForAgent(fencedAgent.id)?.state));
    const fencedResult = control.remoteRuntimeForAgent(fencedAgent.id);
    assert.equal(fencedResult.state, "closed");
    assert.equal(JSON.parse(fencedResult.last_report_json).outcome, "stopped");
    assert.ok(control.blockers(fencedMission.id).some((blocker) => blocker.id === `remote-runtime:${fencedBinding.runtimeId}`), JSON.stringify({
      missionStatus: control.missionById(fencedMission.id)?.status,
      blockers: control.blockers(fencedMission.id).map(({ id, status, kind }) => ({ id, status, kind })),
      lastReport: JSON.parse(fencedResult.last_report_json),
      runtime: { state: fencedResult.state, desired: fencedResult.desired }
    }));
    assert.equal(node.exitCode, null);
    assert.equal(node.signalCode, null);
    await waitFor(() => (control.machineRegistry.get(enrolled.machine.id)?.leaseExpiresAt ?? 0) > leaseBeforeFence, 10000);
    assert.equal((control.db.prepare("SELECT COUNT(*) AS count FROM remote_worker_runtimes WHERE agent_id=?")
      .get(fencedAgent.id)).count, 1);
    const fencedDb = new DatabaseSync(join(nodeHome, "worker-runtime", "node-workers.sqlite"), { readOnly: true });
    const fencedRow = fencedDb.prepare("SELECT pid, state, confirmed_stopped FROM node_worker_runtimes WHERE runtime_id=?")
      .get(fencedBinding.runtimeId);
    assert.equal(fencedRow.state, "closed");
    assert.equal(fencedRow.confirmed_stopped, 1);
    assert.throws(() => process.kill(-fencedRow.pid, 0), { code: "ESRCH" });
    fencedDb.close();

    const heartbeatMission = await post(adminBase, adminToken, "/api/missions", {
      title: "Heartbeat failure fixture", goal: "stop safely after node heartbeat failure",
      acceptance: "the real remote child is physically stopped", workspaceId: localWorkspace.id,
      remoteWorkspaceIds: [remoteWorkspace.id], roleIds: roles.map((role) => role.id),
      maxTurns: 10, maxCost: 0, autonomy: "trusted",
      assertions: [{ id: "HEARTBEAT-STOP", description: "Node lease loss stops the real worker." }],
      workspaceStrategy: "shared"
    });
    const heartbeatStarted = control.missionAction(heartbeatMission.id, "start");
    const currentOrchestrator = control.getAgentPublic(heartbeatStarted.orchestratorId);
    control.markAgentInterrupted(currentOrchestrator.id, currentOrchestrator.epoch);
    const heartbeatAgent = await post(adminBase, adminToken, `/api/missions/${heartbeatMission.id}/agents`, {
      title: "Heartbeat failure worker", roleId: "real-http-worker", prompt: "Wait for node lease loss.",
      requestId: "real-http-heartbeat-worker", targetWorkspaceId: remoteWorkspace.id
    });
    await service.workers.startAgent(control.getAgentPublic(heartbeatAgent.id));
    await waitFor(() => control.remoteRuntimeForAgent(heartbeatAgent.id)?.state === "running");
    const heartbeatRuntime = control.remoteRuntimeForAgent(heartbeatAgent.id);
    control.machineRegistry.revoke(enrolled.machine.id);
    control.fenceStaleWorkerBindings();
    await waitFor(() => node.exitCode !== null || node.signalCode !== null, 30000);
    assert.equal(node.exitCode, 1);
    const heartbeatDb = new DatabaseSync(join(nodeHome, "worker-runtime", "node-workers.sqlite"), { readOnly: true });
    const heartbeatRow = heartbeatDb.prepare("SELECT pid,state,confirmed_stopped FROM node_worker_runtimes WHERE runtime_id=?")
      .get(heartbeatRuntime.runtime_id);
    assert.equal(heartbeatRow.state, "closed");
    assert.equal(heartbeatRow.confirmed_stopped, 1);
    assert.throws(() => process.kill(-heartbeatRow.pid, 0), { code: "ESRCH" });
    heartbeatDb.close();
    assert.ok(["stopping", "uncertain"].includes(control.remoteRuntimeForAgent(heartbeatAgent.id)?.state));
    assert.equal(nodeOutput.includes(credentialValue), false);
    assert.equal(nodeOutput.includes(enrolled.token), false);
  } catch (error) {
    if (nodeOutput) assert.equal(nodeOutput.includes(credentialValue), false);
    throw error;
  }
});
