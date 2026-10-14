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
  assert.equal(task?.status, "running");
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

export function createTurnLimitScenario() {
  const evidence = { humanActions: [], initialMaxTurns: turnLimitMaxTurns(), synchronization: [] };
  const gatePath = `/turn-limit/${randomUUID()}`;
  let context;
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
      for (const blocker of (await snapshot()).blockers.filter((item) => item.kind === "limit" && item.status === "open")) {
        await action("resolve-limit", `/api/blockers/${blocker.id}/resolve`, { resolution: "Turn budget increased; continue after the controlled remote stop." });
      }
      const resolved = await snapshot();
      if (["blocked", "paused"].includes(resolved.mission.status)) await action("resume", `/api/missions/${context.missionId}/resume`, {});
      assert.ok(evidence.limitBlockers.length > 0, "Remote AdmitTurn blocked the Mission without a limit blocker");
      assert.deepEqual(evidence.otherBlockers, [], "Unexpected non-limit blockers");
    },
    assertCompleted(detail) {
      assert.equal(evidence.blockedMissionStatus, "blocked");
      assert.ok(evidence.limitRpc, "Missing applied remote AdmitTurn evidence");
      assert.ok(evidence.limitBlockers.length > 0, "No limit blocker recorded");
      assert.equal(detail.mission.status, "completed");
      assert.equal(evidence.humanActions.filter((entry) => entry.action === "raise-maxTurns").length, 1);
    }
  };
}
