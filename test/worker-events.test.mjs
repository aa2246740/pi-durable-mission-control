import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { applyWorkerNotice, parseWorkerNotice } from "../dist/worker-events.js";

const profile = {
  id: "worker-events-profile",
  name: "Worker events test",
  api: "openai-completions",
  modelId: "faux-1",
  baseUrl: "http://127.0.0.1:9999",
  credentialEnv: "",
  contextWindow: 16000,
  maxTokens: 512,
  reasoning: false,
  toolCalling: true,
  vision: false,
  revision: 1,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "mission-control-worker-events-"));
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  const control = new ControlPlane(join(home, "state"));
  control.upsertProfile(profile);
  for (const kind of ["orchestrator", "worker", "validator"]) {
    control.upsertRole({ id: `worker-events-${kind}`, name: kind, kind, instructions: "", profileId: profile.id });
  }
  const workspace = control.addWorkspace("worker events", workspacePath);
  const mission = control.createMission({
    title: "Worker events",
    goal: "Exercise typed worker notices",
    acceptance: "Only the owning worker can apply delivery notices",
    workspaceId: workspace.id,
    roleIds: ["worker-events-orchestrator", "worker-events-worker", "worker-events-validator"],
    maxTurns: 10,
    maxCost: 1,
    autonomy: "trusted"
  });
  control.missionAction(mission.id, "start");
  const worker = control.createAgent(mission.id, "Worker A", "worker-events-worker", "", "worker-a");
  const validator = control.createAgent(mission.id, "Worker B", "worker-events-validator", "", "worker-b");
  return { home, control, mission, worker, validator };
}

function delivery(fixtureValue, recipient, requestId) {
  const message = fixtureValue.control.sendMessage(fixtureValue.mission.id, recipient.id, requestId, "followUp", requestId);
  const row = fixtureValue.control.db.prepare("SELECT id,request_id,attempt FROM outbox WHERE message_id=?").get(message.id);
  assert.ok(row);
  assert.equal(fixtureValue.control.markOutboxDispatching(row.id, recipient.epoch), true);
  return { message, row };
}

const sanitize = (value) => String(value).replaceAll("secret", "[REDACTED]");

test("strict worker notices apply only for the current owning agent and preserve settlement evidence", () => {
  const f = fixture();
  try {
    const first = delivery(f, f.worker, "owned-delivery");
    const admitted = parseWorkerNotice({
      type: "admitted",
      agentId: f.worker.id,
      epoch: f.worker.epoch,
      messageId: first.message.id,
      requestId: first.row.request_id,
      attempt: first.row.attempt,
      submissionId: "submission-a"
    });
    assert.ok(admitted);
    assert.deepEqual(applyWorkerNotice(f.control, f.worker, admitted, sanitize), {
      applied: true, ready: false, lifecycleSync: false
    });
    assert.equal(f.control.getAgentPublic(f.worker.id)?.status, "running");

    const settled = parseWorkerNotice({
      type: "settled",
      agentId: f.worker.id,
      epoch: f.worker.epoch,
      messageId: first.message.id,
      requestId: first.row.request_id,
      attempt: first.row.attempt,
      submissionId: "submission-a",
      status: "done",
      result: { answer: "preserved" }
    });
    assert.ok(settled);
    assert.deepEqual(applyWorkerNotice(f.control, f.worker, settled, sanitize), {
      applied: true, ready: false, lifecycleSync: false
    });
    assert.equal(f.control.message(first.message.id)?.status, "completed");
    assert.equal(f.control.getAgentPublic(f.worker.id)?.status, "idle");
    assert.equal(
      f.control.db.prepare("SELECT result FROM outbox WHERE id=?").get(first.row.id).result,
      JSON.stringify({ answer: "preserved" })
    );
  } finally {
    f.control.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("malformed, fenced, duplicate, and cross-agent notices do not mutate delivery state", () => {
  const f = fixture();
  try {
    assert.equal(parseWorkerNotice(null), undefined);
    assert.equal(parseWorkerNotice({
      type: "admitted", agentId: f.worker.id, epoch: f.worker.epoch,
      messageId: "message", requestId: "request", attempt: "1", submissionId: "submission"
    }), undefined);
    assert.equal(parseWorkerNotice({
      type: "ready", agentId: f.worker.id, epoch: f.worker.epoch, unexpected: true
    }), undefined);

    const crossAgent = delivery(f, f.validator, "cross-agent");
    const beforeCrossAgent = {
      message: f.control.message(crossAgent.message.id),
      outbox: f.control.db.prepare("SELECT status FROM outbox WHERE id=?").get(crossAgent.row.id),
      agent: f.control.getAgentPublic(f.validator.id)
    };
    const attackerNotice = parseWorkerNotice({
      type: "admitted",
      agentId: f.worker.id,
      epoch: f.worker.epoch,
      messageId: crossAgent.message.id,
      requestId: crossAgent.row.request_id,
      attempt: crossAgent.row.attempt,
      submissionId: "attacker-submission"
    });
    assert.ok(attackerNotice);
    assert.deepEqual(applyWorkerNotice(f.control, f.worker, attackerNotice, sanitize), {
      applied: false, ready: false, lifecycleSync: false
    });
    assert.deepEqual(f.control.message(crossAgent.message.id), beforeCrossAgent.message);
    assert.deepEqual(f.control.db.prepare("SELECT status FROM outbox WHERE id=?").get(crossAgent.row.id), beforeCrossAgent.outbox);
    assert.deepEqual(f.control.getAgentPublic(f.validator.id), beforeCrossAgent.agent);

    const duplicate = delivery(f, f.worker, "duplicate-admission");
    const admission = parseWorkerNotice({
      type: "admitted", agentId: f.worker.id, epoch: f.worker.epoch,
      messageId: duplicate.message.id, requestId: duplicate.row.request_id,
      attempt: duplicate.row.attempt, submissionId: "duplicate-submission"
    });
    assert.ok(admission);
    assert.equal(applyWorkerNotice(f.control, f.worker, admission, sanitize).applied, true);
    f.control.setAgentStatus(f.worker.id, f.worker.epoch, "idle");
    assert.deepEqual(applyWorkerNotice(f.control, f.worker, admission, sanitize), {
      applied: false, ready: false, lifecycleSync: false
    });
    assert.equal(f.control.getAgentPublic(f.worker.id)?.status, "idle");

    const fenced = delivery(f, f.worker, "fenced-admission");
    const oldOwner = f.worker;
    f.control.claimAgentOwner(f.worker.id);
    const fencedNotice = parseWorkerNotice({
      type: "admitted", agentId: oldOwner.id, epoch: oldOwner.epoch,
      messageId: fenced.message.id, requestId: fenced.row.request_id,
      attempt: fenced.row.attempt, submissionId: "fenced-submission"
    });
    assert.ok(fencedNotice);
    assert.equal(applyWorkerNotice(f.control, oldOwner, fencedNotice, sanitize).applied, false);
    assert.equal(f.control.db.prepare("SELECT status FROM outbox WHERE id=?").get(fenced.row.id).status, "dispatching");
  } finally {
    f.control.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

test("uncertain settlement retains the evidence and delivery blocker", () => {
  const f = fixture();
  try {
    const pending = delivery(f, f.worker, "uncertain-delivery");
    const admitted = parseWorkerNotice({
      type: "admitted", agentId: f.worker.id, epoch: f.worker.epoch,
      messageId: pending.message.id, requestId: pending.row.request_id,
      attempt: pending.row.attempt, submissionId: "uncertain-submission"
    });
    assert.ok(admitted);
    assert.equal(applyWorkerNotice(f.control, f.worker, admitted, sanitize).applied, true);
    const settled = parseWorkerNotice({
      type: "settled", agentId: f.worker.id, epoch: f.worker.epoch,
      messageId: pending.message.id, requestId: pending.row.request_id,
      attempt: pending.row.attempt, submissionId: "uncertain-submission",
      status: "unanswered", result: { status: "unanswered", reason: "worker stopped" }, error: "secret token"
    });
    assert.ok(settled);
    assert.deepEqual(applyWorkerNotice(f.control, f.worker, settled, sanitize), {
      applied: true, ready: false, lifecycleSync: true
    });
    assert.equal(f.control.message(pending.message.id)?.status, "uncertain");
    assert.equal(f.control.db.prepare("SELECT status,result FROM outbox WHERE id=?").get(pending.row.id).status, "uncertain");
    assert.equal(
      f.control.db.prepare("SELECT result FROM outbox WHERE id=?").get(pending.row.id).result,
      JSON.stringify({ result: { status: "unanswered", reason: "worker stopped" }, error: "[REDACTED] token" })
    );
    assert.equal(f.control.blockers(f.mission.id).filter((blocker) => blocker.id === `delivery:${pending.row.id}`).length, 1);
  } finally {
    f.control.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});
