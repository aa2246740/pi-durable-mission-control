import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../dist/server.js";
import { REMOTE_ARTIFACT_CHUNK_BYTES } from "../dist/remote-artifacts.js";

const waitFor = async (predicate, diagnostics = () => "") => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`timed out waiting for remote artifact publication\n${diagnostics()}`);
};

test("real protocol-3 node publishes a frozen artifact through authenticated HTTP and local detached validation", async t => {
  const home = mkdtempSync(join(tmpdir(), "remote-artifact-http-"));
  const root = join(home, "remote-root"), localPath = join(home, "local-workspace"), nodeHome = join(home, "node-home");
  mkdirSync(root); mkdirSync(localPath);
  const service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0 });
  const control = service.control;
  const enrolled = control.enrollMachine("remote-artifact-node", "Remote artifact node");
  const nodeModule = new URL("../dist/node.js", import.meta.url).href;
  const nodeOptions = {
    coordinator: `http://127.0.0.1:${service.nodePort}`, machineId: enrolled.machine.id,
    tokenEnv: "NODE_AUTH_TOKEN", home: nodeHome, roots: [root], credentialRefs: [],
    executionMode: "workspace-effects", testOnlyScripted: true,
    testOnlyArtifactTransferLoop: true, testOnlyArtifactTaskId: "__test_only_current_owned_task__"
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
  const machine = control.machineRegistry.get(enrolled.machine.id);
  assert.equal(machine.capabilities.protocol, 3);
  assert.equal(machine.capabilities.artifactTransfers, true);
  const unauthorized = await fetch(`http://127.0.0.1:${service.nodePort}/api/nodes/artifacts/complete`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  });
  assert.equal(unauthorized.status, 401);

  const probe = control.probeMachine(enrolled.machine.id, crypto.randomUUID(), root);
  await waitFor(() => control.machineCommand(enrolled.machine.id, probe.id).status === "completed");
  const remote = control.addRemoteWorkspace("Artifact source", enrolled.machine.id, probe.id);
  const local = control.addWorkspace("Local validation workspace", realpathSync(localPath));
  const profile = {
    id: "remote-artifact-profile", name: "Fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "http://127.0.0.1:9/v1", credentialEnv: "", contextWindow: 4096, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  control.upsertProfile(profile);
  const roles = [
    { id: "remote-artifact-orchestrator", name: "orchestrator", kind: "orchestrator", instructions: "coordinate", profileId: profile.id },
    { id: "remote-artifact-worker", name: "worker", kind: "worker", instructions: "publish task artifacts", profileId: profile.id },
    { id: "remote-artifact-validator", name: "validator", kind: "validator", instructions: "validate independently", profileId: profile.id }
  ];
  for (const role of roles) control.upsertRole(role);
  const mission = control.createMission({
    title: "Remote artifact integration", goal: "publish and validate a frozen artifact",
    acceptance: "validator sees the published snapshot, not the changed source",
    workspaceId: local.id, remoteWorkspaceIds: [remote.id], roleIds: roles.map(role => role.id),
    maxTurns: 10, maxCost: 0, autonomy: "trusted", workspaceStrategy: "shared"
  });
  const started = control.missionAction(mission.id, "start");
  const orchestrator = control.getAgentPublic(started.orchestratorId);
  control.markAgentInterrupted(orchestrator.id, orchestrator.epoch);
  const currentOrchestrator = control.getAgentPublic(orchestrator.id);
  const worker = control.createAgent(mission.id, "Remote publisher", roles[1].id, "Publish the assigned task artifact.", "artifact-worker", remote.id);
  const validator = control.createAgent(mission.id, "Local validator", roles[2].id, "Validate detached input.", "artifact-validator");
  const task = control.createTask(currentOrchestrator.id, currentOrchestrator.epoch, "artifact-task", {
    missionId: mission.id, title: "Freeze evidence", description: "", acceptance: "The frozen bytes pass validation",
    dependencies: [], ownerId: worker.id, validatorId: validator.id
  });
  const runningTask = control.updateTask(currentOrchestrator.id, currentOrchestrator.epoch, "artifact-task-running", task.id, { status: "running" });
  const original = Buffer.alloc(REMOTE_ARTIFACT_CHUNK_BYTES + 19, 0xa5);
  original.set([0, 255, 128, 65]);
  writeFileSync(join(root, "artifact.bin"), original);

  control.sendMessage(mission.id, worker.id, "Publish the assigned task artifact.", "followUp", "artifact-publication-request");
  await service.workers.startAgent(control.getAgentPublic(worker.id));
  const publicationDiagnostics = () => {
    const runtime = control.remoteRuntimeForAgent(worker.id);
    const detail = control.detail(mission.id);
    return JSON.stringify({
      nodeOutput,
      nodeExitCode: node.exitCode,
      agent: (() => {
        const current = control.getAgentPublic(worker.id);
        return current && { status: current.status, epoch: current.epoch, error: current.error };
      })(),
      runtime: runtime && {
        state: runtime.state, desired: runtime.desired,
        runtimeId: runtime.runtime_id, updatedAt: runtime.updated_at
      },
      messages: detail.messages.map(message => ({
        id: message.id, status: message.status, recipientId: message.recipientId
      })),
      events: detail.events.slice(-8).map(event => ({
        type: event.type, text: event.text,
        diagnostic: event.type === "worker_start_failed" && event.data && event.data.diagnostic
      })),
      transfers: control.db.prepare(
        "SELECT status,next_offset FROM remote_artifact_transfers"
      ).all()
    });
  };
  await waitFor(() => control.detail(mission.id).messages.some(message =>
    message.recipientId === worker.id && message.status === "completed"), publicationDiagnostics);
  const detail = control.detail(mission.id);
  const artifact = detail.artifacts.find(item => item.taskId === task.id);
  assert.ok(artifact, nodeOutput);
  assert.equal(artifact.remoteProvenance.taskAttempt, runningTask.attempt);
  assert.equal(artifact.sha256, createHash("sha256").update(original).digest("hex"));
  assert.equal(detail.events.filter(event => event.type === "artifact_published").length, 1);
  assert.equal(JSON.stringify(detail).includes(original.toString("base64")), false);
  assert.equal(node.exitCode, null, nodeOutput);

  const transfer = control.db.prepare(
    "SELECT transfer_id,spec_json,manifest_json FROM remote_artifact_transfers WHERE status='complete'"
  ).get();
  const persistedChunks = control.db.prepare(
    "SELECT byte_offset,length(bytes) AS size FROM remote_artifact_chunks WHERE transfer_id=? ORDER BY byte_offset"
  ).all(transfer.transfer_id).map(row => ({ byte_offset: row.byte_offset, size: row.size }));
  assert.deepEqual(persistedChunks, [
    { byte_offset: 0, size: REMOTE_ARTIFACT_CHUNK_BYTES },
    { byte_offset: REMOTE_ARTIFACT_CHUNK_BYTES, size: 19 }
  ]);
  const currentMachine = control.machineRegistry.get(enrolled.machine.id);
  const completeBody = {
    machineId: enrolled.machine.id, sessionId: currentMachine.sessionId, sessionEpoch: currentMachine.sessionEpoch,
    spec: JSON.parse(transfer.spec_json), manifest: JSON.parse(transfer.manifest_json)
  };
  const completeUrl = `http://127.0.0.1:${service.nodePort}/api/nodes/artifacts/complete`;
  const chunkUrl = `http://127.0.0.1:${service.nodePort}/api/nodes/artifacts/chunk`;
  const postNode = (url, body) => fetch(url, {
    method: "POST", headers: { authorization: `Bearer ${enrolled.token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const originalPermitScope = `mission:${mission.id}:remote-effects`;
  const originalPermitRow = control.db.prepare("SELECT response FROM commands WHERE scope=? AND command_id=?")
    .get(originalPermitScope, completeBody.spec.taskId);
  assert.ok(originalPermitRow);
  const expiredPermitResponse = JSON.parse(originalPermitRow.response);
  expiredPermitResponse.effectPermit.expiresAt = Date.now() - 1000;
  control.db.prepare("UPDATE commands SET response=? WHERE scope=? AND command_id=?")
    .run(JSON.stringify(expiredPermitResponse), originalPermitScope, completeBody.spec.taskId);
  const duplicate = await postNode(completeUrl, completeBody);
  assert.equal(duplicate.status, 200, await duplicate.text());
  control.db.prepare("UPDATE commands SET response=? WHERE scope=? AND command_id=?")
    .run(originalPermitRow.response, originalPermitScope, completeBody.spec.taskId);
  const staleDuplicate = await fetch(completeUrl, {
    method: "POST", headers: { authorization: `Bearer ${enrolled.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...completeBody, sessionId: `${currentMachine.sessionId}-stale` })
  });
  assert.notEqual(staleDuplicate.status, 200);

  const transferState = () => ({
    transfers: control.db.prepare("SELECT COUNT(*) AS count FROM remote_artifact_transfers").get().count,
    chunks: control.db.prepare("SELECT COUNT(*) AS count FROM remote_artifact_chunks").get().count,
    artifacts: control.detail(mission.id).artifacts.length,
    publishedEvents: control.detail(mission.id).events.filter(event => event.type === "artifact_published").length
  });
  const changedManifest = { ...completeBody.manifest, sha256: "f".repeat(64) };
  const beforeManifestRebind = transferState();
  const firstChunkRebind = await postNode(chunkUrl, {
    ...completeBody, manifest: changedManifest, offset: 0,
    chunkBase64: original.subarray(0, REMOTE_ARTIFACT_CHUNK_BYTES).toString("base64")
  });
  assert.notEqual(firstChunkRebind.status, 200, await firstChunkRebind.text());
  const finalizedManifestRebind = await postNode(completeUrl, { ...completeBody, manifest: changedManifest });
  assert.notEqual(finalizedManifestRebind.status, 200, await finalizedManifestRebind.text());
  assert.deepEqual(transferState(), beforeManifestRebind);

  const foreignSpec = structuredClone(completeBody.spec);
  foreignSpec.binding.epoch++;
  const foreignBinding = await postNode(chunkUrl, {
    ...completeBody, spec: foreignSpec, offset: 0,
    chunkBase64: original.subarray(0, REMOTE_ARTIFACT_CHUNK_BYTES).toString("base64")
  });
  assert.notEqual(foreignBinding.status, 200);
  assert.equal(control.db.prepare("SELECT COUNT(*) AS count FROM remote_artifact_chunks WHERE transfer_id=?").get(transfer.transfer_id).count, 2);

  const secondTaskId = `${worker.id}:artifact-version-2`;
  const currentPublisher = control.getAgentPublic(worker.id);
  const secondArgs = { name: "artifact-version-2", path: "artifact.bin", taskId: task.id };
  const issued = await control.workerCommand({
    agentId: worker.id, epoch: currentPublisher.epoch, taskId: secondTaskId, method: "PublishArtifact", args: secondArgs
  });
  const secondPermit = issued.effectPermit;
  const secondSpec = {
    binding: secondPermit.binding, descriptorHash: secondPermit.descriptorHash, taskId: secondPermit.taskId,
    method: secondPermit.method, args: secondPermit.args, taskAttempt: secondPermit.taskAttempt
  };
  const secondBytes = Buffer.from("second authorized artifact version");
  const secondManifest = {
    ...completeBody.manifest, size: secondBytes.length,
    sha256: createHash("sha256").update(secondBytes).digest("hex")
  };
  const secondPermitRow = control.db.prepare("SELECT response FROM commands WHERE scope=? AND command_id=?")
    .get(originalPermitScope, secondTaskId);
  assert.ok(secondPermitRow);
  const beforeUnauthorizedTransfers = transferState();
  const changedPermitResponse = JSON.parse(secondPermitRow.response);
  changedPermitResponse.effectPermit.args.name = "tampered-before-upload";
  control.db.prepare("UPDATE commands SET response=? WHERE scope=? AND command_id=?")
    .run(JSON.stringify(changedPermitResponse), originalPermitScope, secondTaskId);
  const changedPermitUpload = await postNode(chunkUrl, {
    ...completeBody, spec: secondSpec, manifest: secondManifest, offset: 0, chunkBase64: secondBytes.toString("base64")
  });
  assert.notEqual(changedPermitUpload.status, 200, await changedPermitUpload.text());
  assert.deepEqual(transferState(), beforeUnauthorizedTransfers);
  control.db.prepare("UPDATE commands SET response=? WHERE scope=? AND command_id=?")
    .run(secondPermitRow.response, originalPermitScope, secondTaskId);

  const missingPermitSpec = { ...secondSpec, taskId: `${worker.id}:missing-artifact-permit` };
  const missingPermitUpload = await postNode(chunkUrl, {
    ...completeBody, spec: missingPermitSpec, manifest: secondManifest, offset: 0, chunkBase64: secondBytes.toString("base64")
  });
  assert.notEqual(missingPermitUpload.status, 200, await missingPermitUpload.text());
  assert.deepEqual(transferState(), beforeUnauthorizedTransfers);

  const secondChunk = await postNode(chunkUrl, {
    ...completeBody, spec: secondSpec, manifest: secondManifest, offset: 0, chunkBase64: secondBytes.toString("base64")
  });
  assert.equal(secondChunk.status, 200, await secondChunk.text());
  const secondComplete = await postNode(completeUrl, {
    ...completeBody, spec: secondSpec, manifest: secondManifest
  });
  assert.equal(secondComplete.status, 200, await secondComplete.text());
  const secondDetail = control.detail(mission.id);
  assert.equal(secondDetail.artifacts.length, 2);
  assert.equal(secondDetail.events.filter(event => event.type === "artifact_published").length, 2);
  assert.equal(JSON.stringify(secondDetail).includes(secondBytes.toString("base64")), false);

  writeFileSync(join(root, "artifact.bin"), "mutated-after-publication");
  const validationOrchestrator = control.getAgentPublic(orchestrator.id);
  control.updateTask(validationOrchestrator.id, validationOrchestrator.epoch, "artifact-task-review", task.id, { status: "review" });
  const currentWorker = control.getAgentPublic(worker.id);
  await assert.rejects(control.runValidation(currentWorker.id, currentWorker.epoch, "artifact-owner-self-validation", {
    taskId: task.id, command: "exit 0", artifactIds: [artifact.id]
  }), /distinct assigned validator/i);
  const validationInput = {
    taskId: task.id,
    command: `actual="$(sha256sum artifact.bin | cut -d ' ' -f1)" && test "$actual" = '${createHash("sha256").update(original).digest("hex")}' && printf 'FROZEN-SNAPSHOT-VERIFIED %s\\n' "$actual" && printf 'DETACHED-SNAPSHOT-CHECK\\n' >&2`,
    artifactIds: [artifact.id]
  };
  const currentValidator = control.getAgentPublic(validator.id);
  const receipt = await control.runValidation(currentValidator.id, currentValidator.epoch, "artifact-validation", validationInput);
  assert.equal(receipt.workspaceKind, "remote-snapshot");
  assert.equal(receipt.snapshotIntegrity, true);
  assert.match(receipt.stdout, /FROZEN-SNAPSHOT-VERIFIED/);
  assert.match(receipt.stderr, /DETACHED-SNAPSHOT-CHECK/);
  assert.equal(JSON.stringify(receipt).includes(original.toString("base64")), false);
  assert.notEqual(receipt.workspacePath, localPath);
  assert.notEqual(receipt.workspacePath, root);
  assert.deepEqual(readFileSync(join(receipt.workspacePath, "artifact.bin")), original);

  writeFileSync(join(receipt.workspacePath, "artifact.bin"), "tampered-validation-copy");
  assert.throws(() => control.validateTask(currentValidator.id, currentValidator.epoch, "artifact-validate-tampered",
    task.id, receipt.id, true, "tampered copy"), /detached validation inputs/i);
  writeFileSync(join(receipt.workspacePath, "artifact.bin"), original);
  const taskRow = control.db.prepare("SELECT data FROM tasks WHERE id=?").get(task.id);
  const staleTask = { ...JSON.parse(taskRow.data), attempt: runningTask.attempt + 1 };
  control.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(staleTask), task.id);
  await assert.rejects(control.runValidation(currentValidator.id, currentValidator.epoch, "artifact-stale-attempt", validationInput),
    /provenance is stale|task attempt/i);
  control.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(taskRow.data, task.id);
  const validation = control.validateTask(currentValidator.id, currentValidator.epoch, "artifact-validate",
    task.id, receipt.id, true, "detached copy matched the frozen artifact");
  assert.equal(validation.passed, true);
});
