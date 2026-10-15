import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Setup uses eleven orchestrator turns and two validator turns. The worker's
// initial state read, file write and Linux self-check use three more turns.
export function turnLimitMaxTurns({ orchestrator = 11, validator = 2, worker = 3 } = {}) {
  for (const count of [orchestrator, validator, worker]) assert.ok(Number.isSafeInteger(count) && count > 0, "Turn counts must be positive safe integers");
  const total = orchestrator + validator + worker;
  assert.ok(Number.isSafeInteger(total), "Turn limit overflow");
  return total;
}

export function turnLimitCall({ role, last, history, state, call }) {
  if (role !== "worker" || last?.name !== "GetMissionState") return;
  const selfCheck = history.findLast((result) => result.name === "bash" && !result.args.command.includes("LIVE-SOURCE-CHANGED"));
  if (!selfCheck) return;
  assert.equal(selfCheck.value.status, "succeeded", "Missing successful pre-limit Linux self-check");
  assert.equal(selfCheck.value.result?.exitCode, 0, "Pre-limit Linux self-check failed");
  const task = state.tasks.find((item) => state.agents.find((agent) => agent.id === item.ownerId)?.kind === "worker");
  if (task?.status !== "running") return;
  assert.equal(history.some((result) => result.name === "PublishArtifact"), false, "Publication preceded turn limit");
  return call("PublishArtifact", { name: "Frozen Linux delivery", path: "linux-delivery.json", taskId: task.id });
}

export function findLimitRpc(detail, transport, binding) {
  const denials = detail.events.filter((event) => event.type === "turn_admission_denied" && event.text === "Mission turn limit exhausted");
  assert.equal(denials.length, 1, "Expected one turn-limit admission denial");
  const denial = denials[0];
  assert.equal(denial.agentId, binding.agentId, "Limit denial did not come from remote worker");
  assert.equal(denial.data.turns, denial.data.maxTurns);
  const rows = transport.inbox.filter((row) => {
    const envelope = JSON.parse(row.envelope_json);
    return row.runtime_id === binding.runtimeId && envelope.payload.method === "AdmitTurn" && envelope.payload.args.generationId === denial.data.generationId;
  });
  assert.equal(rows.length, 1, "Denied AdmitTurn RPC missing from coordinator inbox");
  const row = rows[0];
  const envelope = JSON.parse(row.envelope_json);
  assert.deepEqual(envelope.binding, binding, "Denied RPC binding mismatch");
  assert.equal(row.status, "applied", "Denied AdmitTurn RPC was not settled before fencing");
  const replies = transport.outbox.filter((reply) => reply.source_inbox_id === row.message_id);
  assert.equal(replies.length, 1, "Denied RPC has no unique persisted reply");
  const reply = JSON.parse(replies[0].envelope_json).payload;
  assert.equal(reply.rpcId, envelope.payload.rpcId);
  assert.equal(reply.ok, false);
  return { denial, inbox: row, reply: replies[0], binding };
}

export function reconcileDelivery(blocker, detail, transport, stopped) {
  assert.equal(blocker.kind, "delivery", "Cannot reconcile an unrelated blocker");
  const outbox = transport.deliveries.find((row) => blocker.id === `delivery:${row.id}`);
  assert.ok(outbox, "Delivery blocker has no matching persisted outbox attempt");
  const message = detail.messages.find((item) => item.id === outbox.message_id && item.attempt === outbox.attempt);
  assert.equal(outbox.status, "uncertain", "Delivery is not an interrupted uncertain attempt");
  assert.equal(message?.status, "uncertain", "Delivery message is not uncertain");
  assert.equal(stopped.state, "closed");
  assert.equal(stopped.stopProvenance, "controlled");
  assert.equal(stopped.report.outcome, "stopped");
  const receipts = detail.events.filter((event) => event.type === "remote_effect_receipt");
  assert.equal(receipts.length, 2, "Expected only write and Linux self-check before publication");
  assert.ok(receipts.every((event) => event.data.receipt.status === "succeeded"), "An effect has an unknown result");
  assert.equal(detail.artifacts.length, 0, "Publication already occurred before reconciliation");
  return { blockerId: blocker.id, outbox, message, stoppedBinding: stopped.binding,
    effectReceipts: receipts, conclusion: `已只读核对协调端投递 ${message.id} 的 attempt ${message.attempt}、远端受控停止回报及写入和 Linux 自查成功回执；尚未发布，确认该投递不需要重放，后续工作由新输入继续。` };
}

export function assertInterruptedDeliveries(detail, transport, evidence) {
  for (const reconciliation of evidence.deliveryReconciliations) {
    assert.deepEqual(transport.deliveries.find((row) => row.id === reconciliation.outbox.id), reconciliation.outbox, "Interrupted outbox attempt changed or replayed");
    assert.deepEqual(detail.messages.find((message) => message.id === reconciliation.message.id), reconciliation.message, "Interrupted message changed or replayed");
  }
}

export function createTurnLimitScenario() {
  const evidence = { humanActions: [], initialMaxTurns: turnLimitMaxTurns(), synchronization: [] };
  const gatePath = `/turn-limit/${randomUUID()}`;
  let context;
  let idleSince;
  let idleSequence;
  let selfCheckReady, localAdmissionReady;
  const selfCheck = new Promise((resolve) => { selfCheckReady = resolve; });
  const localAdmission = new Promise((resolve) => { localAdmissionReady = resolve; });
  const persist = () => context.save("turn-limit.json", evidence);
  const snapshot = async () => context.api(`/api/missions/${context.missionId}`);
  const action = async (name, path, body, method = "POST") => {
    const entry = { action: name, method, path, body, attemptedAt: new Date().toISOString() };
    evidence.humanActions.push(entry);
    persist();
    try {
      entry.response = await context.api(path, body, method);
      entry.completedAt = new Date().toISOString();
    } catch (error) {
      entry.error = error.message;
      evidence.recoveryRejection = { action: name, path, method, error: error.message };
      throw error;
    } finally { persist(); }
  };
  return {
    evidence,
    configure(value) { context = value; persist(); },
    async beforeReply(decision) {
      if (decision.role === "worker" && decision.name === "GetMissionState" && !evidence.workerStarted) {
        await context.wait(async () => {
          const current = await snapshot();
          return current.tasks[0]?.status === "running" && current.agents.some((agent) => agent.kind === "validator" && agent.status === "idle");
        });
        evidence.workerStarted = true;
      }
      if (decision.role === "worker" && decision.name === "bash" && !decision.args.command.includes("LIVE-SOURCE-CHANGED") && !evidence.gateInstalled) {
        // The shell finishes the real self-check, then waits for the last local
        // admission. Its response is held so no turn_end can block the mission.
        const script = `const r=await fetch(${JSON.stringify(context.modelUrl + gatePath)},{method:"POST"});if(!r.ok)throw new Error("turn-limit synchronization failed")`;
        decision.args.command += ` && node --input-type=module -e '${script}'`;
        evidence.gateInstalled = true;
      }
      if (decision.role === "orchestrator" && decision.name === "SendMessage" && !evidence.localAdmissionHeld) await selfCheck;
      if (decision.role === "orchestrator" && decision.name === "WaitForMessage" && !evidence.localAdmissionHeld) {
        const current = await snapshot();
        assert.equal(current.mission.status, "active", "Mission blocked before remote AdmitTurn");
        assert.equal(current.mission.turns, evidence.initialMaxTurns, "Unexpected setup turn count");
        evidence.localAdmissionHeld = true;
        evidence.synchronization.push({ stage: "last-local-admission-held", turns: current.mission.turns, at: new Date().toISOString() });
        persist();
        localAdmissionReady();
        await context.wait(async () => (await snapshot()).mission.status === "blocked");
      }
    },
    async handleRequest(request, response) {
      if (request.url !== gatePath) return false;
      assert.equal(request.method, "POST");
      evidence.synchronization.push({ stage: "linux-self-check-finished", at: new Date().toISOString() });
      persist();
      selfCheckReady();
      await localAdmission;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("continue");
      return true;
    },
    async recover(current) {
      evidence.blockedMissionStatus = current.mission.status;
      evidence.blockedSnapshot = current;
      persist();
      assert.equal(current.artifacts.length, 0, "Publication preceded limit");
      const stopped = await context.wait(async () => {
        const runtimes = await context.api(`/api/missions/${context.missionId}/runtimes`);
        assert.equal(runtimes.length, 1);
        if (runtimes[0].state === "uncertain") throw new Error("Pre-limit runtime stop is uncertain");
        return runtimes[0].state === "closed" && runtimes[0];
      });
      evidence.stoppedRuntime = stopped;
      evidence.transportBeforeResume = context.readTransport();
      persist();
      assert.equal(stopped.stopProvenance, "controlled");
      assert.equal(stopped.report.outcome, "stopped");
      const blocked = await snapshot();
      evidence.blockedSnapshot = blocked;
      evidence.limitBlockers = blocked.blockers.filter((blocker) => blocker.kind === "limit" && blocker.status === "open");
      evidence.otherBlockers = blocked.blockers.filter((blocker) => blocker.kind !== "limit" && blocker.status === "open");
      evidence.limitRpc = findLimitRpc(blocked, evidence.transportBeforeResume, stopped.binding);
      const receipt = blocked.events.find((event) => event.type === "remote_effect_receipt" && event.agentId === stopped.binding.agentId && event.data.receipt.status === "succeeded" && event.data.receipt.result?.exitCode === 0 && event.data.receipt.result.stdout?.includes("LINUX-SELF-CHECK-OK"));
      assert.ok(receipt && receipt.seq < evidence.limitRpc.denial.seq, "Limit preceded completed Linux self-check receipt");
      evidence.selfCheckReceipt = receipt;
      persist();
      evidence.resumeAttempted = true;
      await action("raise-maxTurns", `/api/missions/${context.missionId}`, { maxTurns: evidence.initialMaxTurns + 80 }, "PATCH");
      evidence.deliveryReconciliations = [];
      const raised = await snapshot();
      assert.ok(raised.mission.maxTurns > raised.mission.turns, "Budget increase did not take effect");
      for (const blocker of raised.blockers.filter((item) => item.status === "open")) {
        let resolution;
        if (blocker.kind === "limit") resolution = `已核对 Mission 使用 ${raised.mission.turns} 轮，上限已提高到 ${raised.mission.maxTurns}，剩余预算足够继续。`;
        else {
          const reconciliation = reconcileDelivery(blocker, blocked, evidence.transportBeforeResume, stopped);
          evidence.deliveryReconciliations.push(reconciliation);
          resolution = reconciliation.conclusion;
        }
        persist();
        await action("resolve-blocker", `/api/blockers/${blocker.id}/resolve`, { resolution });
      }
      const resolved = await snapshot();
      if (["blocked", "paused"].includes(resolved.mission.status)) await action("resume", `/api/missions/${context.missionId}/resume`, {});
      evidence.resumedSnapshot = await snapshot();
      persist();
    },
    async observe(current) {
      if (!evidence.resumeAttempted || current.mission.status !== "active") return;
      const failures = current.events.filter((event) => event.type === "worker_start_failed");
      if (failures.length) throw new Error(`Recovery failed: ${JSON.stringify(failures)}`);
      const pending = current.messages.filter((message) => ["queued", "dispatching", "admitted", "delivering", "delivered"].includes(message.status));
      const busy = current.agents.some((agent) => ["running", "recovering", "waiting_approval", "waiting_user"].includes(agent.status));
      if (pending.length || busy || current.blockers.some((blocker) => blocker.status === "open")) { idleSince = undefined; return; }
      const sequence = current.events.at(-1)?.seq ?? 0;
      const now = context.now?.() ?? Date.now();
      if (idleSince === undefined || sequence !== idleSequence) {
        idleSince = now;
        idleSequence = sequence;
        evidence.idleSnapshot = { mission: current.mission, agents: current.agents, messages: current.messages, events: current.events, observedAt: new Date(now).toISOString() };
        persist();
        return;
      }
      if (!evidence.operatorMessageSent && now - idleSince >= 2000) {
        evidence.operatorMessageSent = true;
        await action("message-orchestrator", `/api/missions/${context.missionId}/messages`, {
          recipientId: current.mission.orchestratorId, content: "继续完成剩余工作。已核对被打断的投递，不需要重放；请读取当前状态并继续。", mode: "followUp", requestId: `turn-limit-continue:${context.missionId}`
        });
        idleSince = undefined;
      } else if (evidence.operatorMessageSent && now - idleSince >= 10000) {
        evidence.stallSnapshot = current;
        evidence.transportAtStall = context.readTransport();
        persist();
        throw new Error(`Mission stalled after the operator message: ${JSON.stringify({ mission: current.mission, agents: current.agents, blockers: current.blockers })}`);
      }
    },
    assertCompleted(detail) {
      assert.equal(evidence.blockedMissionStatus, "blocked");
      assert.ok(evidence.limitRpc, "Missing applied remote AdmitTurn evidence");
      assert.equal(detail.blockers.some((blocker) => blocker.status === "open"), false);
      assertInterruptedDeliveries(detail, evidence.transport, evidence);
      assert.equal(detail.mission.status, "completed");
      assert.equal(evidence.humanActions.filter((entry) => entry.action === "raise-maxTurns").length, 1);
    }
  };
}
