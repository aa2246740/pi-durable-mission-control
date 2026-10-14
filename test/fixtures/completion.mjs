import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlane } from "../../dist/control.js";
import { applyWorkerNotice } from "../../dist/worker-events.js";
import { WorkerManager } from "../../dist/workers.js";

export async function fixture(t, { admitted = true, settleOnShutdown = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "worker-completion-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const control = new ControlPlane(join(home, "state"));
  const workers = new WorkerManager(control);
  t.after(async () => {
    if (!control.closed) {
      await workers.close();
      control.close();
    }
    rmSync(home, { recursive: true, force: true });
  });
  control.upsertProfile({
    id: "completion-profile", name: "Completion test", api: "openai-completions", modelId: "faux-1",
    baseUrl: "http://127.0.0.1:9", credentialEnv: "", contextWindow: 16000, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false, revision: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  });
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: kind, name: kind, kind, instructions: "", profileId: "completion-profile" });
  }
  const workspace = control.addWorkspace("completion", workspacePath);
  const mission = control.createMission({
    title: "Completion race", goal: "Finish without interrupting the final submission", acceptance: "Delivery exists",
    workspaceId: workspace.id, roleIds: ["orchestrator", "worker", "validator"], maxTurns: 50, maxCost: 1, autonomy: "trusted"
  });
  const started = control.missionAction(mission.id, "start");
  const agent = control.getAgentPublic(started.orchestratorId);
  const owner = control.createAgent(mission.id, "Owner", "worker", "", "owner");
  const validator = control.createAgent(mission.id, "Validator", "validator", "", "validator");
  const task = control.createTask(agent.id, agent.epoch, "task", {
    missionId: mission.id, title: "Delivery", description: "", acceptance: "Delivery exists", dependencies: [],
    ownerId: owner.id, validatorId: validator.id, fulfills: ["REQ-001"]
  });
  control.updateTask(owner.id, owner.epoch, "running", task.id, { status: "running" });
  const path = join(workspacePath, "delivery.txt");
  writeFileSync(path, "ready");
  const artifact = control.publishArtifact(owner.id, owner.epoch, "publish", "Delivery", path, Buffer.from("ready"), task.id);
  control.updateTask(owner.id, owner.epoch, "review", task.id, { status: "review" });
  const receipt = await control.runValidation(validator.id, validator.epoch, "validate", { taskId: task.id, command: "test -f delivery.txt", artifactIds: [artifact.id] });
  control.validateTask(validator.id, validator.epoch, "accept", task.id, receipt.id, true, "Delivery exists",
    [{ assertionId: "REQ-001", status: "passed", evidence: "Independent command found the delivery" }]);
  const row = control.pendingOutbox().find((item) => control.message(item.message_id).recipientId === agent.id);
  assert.equal(control.markOutboxDispatching(row.id, agent.epoch), true);
  if (admitted) assert.equal(control.ackOutbox(row.message_id, row.request_id, row.attempt, agent.epoch, "admitted"), true);
  const child = new EventEmitter();
  Object.assign(child, { connected: true, exitCode: null, signalCode: null });
  let replied;
  const reply = new Promise((resolve) => { replied = resolve; });
  const sent = [];
  let settled = false;
  const notice = (body) => child.emit("message", { ...body, agentId: agent.id, epoch: agent.epoch });
  const settle = (status = "done", error) => {
    if (settled) return;
    settled = true;
    notice({ type: "settled", messageId: row.message_id, requestId: row.request_id, attempt: row.attempt,
      submissionId: "final-submission", status, ...(error ? { error } : { result: { status } }) });
  };
  child.on("message", (message) => applyWorkerNotice(control, agent, message, String));
  child.send = (message, callback) => {
    sent.push(message);
    callback(null);
    if (message.id) replied(message);
    if (message.type === "shutdown") {
      if (settleOnShutdown) settle("unanswered", "Harness is closed");
      notice({ type: "closed" });
      child.exitCode = 0;
      child.connected = false;
      child.emit("exit", 0);
    }
    if (message.type === "abort") notice({ type: "aborted" });
  };
  const handle = { child, token: "completion-token", epoch: agent.epoch, ready: Promise.resolve(), stopping: false };
  workers.handles.set(agent.id, handle);
  const complete = () => workers.onRpc(agent, handle, {
    type: "rpc", id: "complete-rpc", token: handle.token, agentId: agent.id, epoch: agent.epoch,
    method: "CompleteMission", args: {}, taskId: "complete-mission"
  });
  return { home, control, workers, mission, agent, owner, row, child, handle, sent, reply, notice, settle, complete };
}

