import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../real.mjs";
import { DatabaseSync } from "node:sqlite";
import { workerCrashArmed } from "./worker-crash.mjs";

export const restartScenarios = ["restart-after-complete", "coordinator-restart", "coordinator-restart-kill"];

export function coordinatorRestartCall({ role, last, history, state, call, released = false }) {
  if (role !== "worker") return;
  const selfCheck = history.findLast((result) => result.name === "bash" && !String(result.args?.command ?? "").includes("LIVE-SOURCE-CHANGED"));
  if (!selfCheck) return;
  assert.equal(selfCheck.value?.status, "succeeded", "Pre-restart self-check failed");
  assert.equal(selfCheck.value?.result?.exitCode, 0, "Pre-restart self-check failed");
  if (!released) return call("WaitForMessage");
  if (last?.name === "GetMissionState" && !history.some((result) => result.name === "PublishArtifact")) {
    const task = state.tasks.find((value) => value.ownerId === state.agents.find((agent) => agent.kind === "worker")?.id);
    if (task?.status === "running") return call("PublishArtifact", { name: "Frozen Linux delivery", path: "linux-delivery.json", taskId: task.id });
  }
}

export function readRestartBindings(path, missionId) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT b.* FROM worker_mailbox_bindings b JOIN agents a ON a.id=b.agent_id WHERE a.mission_id=? ORDER BY b.runtime_id").all(missionId);
  } finally { db.close(); }
}

export function assertNoRestartReplay(snapshot, { afterComplete = false, progressing = false } = {}) {
  const { detail, transport, records } = snapshot;
  const receipts = detail.events.filter((event) => event.type === "remote_effect_receipt");
  assert.equal(new Set(receipts.map((event) => event.data.effectId)).size, receipts.length, "Effect receipt replayed");
  assert.equal(new Set(transport.effects.map((row) => row.command_id)).size, transport.effects.length, "Effect permit replayed");
  assert.equal(new Set(transport.deliveries.map((row) => `${row.message_id}:${row.attempt}`)).size, transport.deliveries.length, "Durable outbox replayed");
  assert.ok(detail.messages.every((message) => message.attempt === 1), "Delivery attempt was replayed");
  assert.equal(detail.events.some((event) => event.type === "delivery_resumed"), false, "Uncertain delivery resumed");
  for (const type of ["delivery_admitted", "delivery_delivered", "delivery_completed"]) {
    const events = detail.events.filter((event) => event.type === type);
    assert.equal(new Set(events.map((event) => `${event.data.messageId}:${event.data.attempt}`)).size, events.length, `${type} replayed`);
  }
  const count = (name) => records.filter((record) => record.role === "worker" && record.name === name).length;
  assert.equal(count("write_file"), 1, "write_file replayed");
  if (progressing) {
    assert.ok(count("bash") >= 1 && count("bash") <= 2, "bash replayed");
    assert.ok(count("PublishArtifact") <= 1, "Publication replayed");
    assert.ok(receipts.length >= 2 && receipts.length <= 4, "Unexpected effect receipts");
    assert.ok(transport.effects.length >= 2 && transport.effects.length <= 4, "Unexpected effect permits");
  } else {
    assert.equal(count("bash"), afterComplete ? 2 : 1, "bash replayed");
    assert.equal(count("PublishArtifact"), afterComplete ? 1 : 0, "Publication replayed or premature");
    assert.equal(receipts.length, afterComplete ? 4 : 2, "Unexpected effect receipts");
    assert.equal(transport.effects.length, afterComplete ? 4 : 2, "Unexpected effect permits");
  }
  assert.ok(receipts.every((event) => event.data.receipt.status === "succeeded"), "Effect has no successful terminal receipt");
}

export function assertCompletedRestart(before, after) {
  assert.equal(after.detail.mission.id, before.detail.mission.id);
  assert.equal(after.detail.mission.orchestratorId, before.detail.mission.orchestratorId);
  assert.equal(after.detail.mission.status, "completed");
  assert.deepEqual(after.detail.tasks, before.detail.tasks, "Accepted tasks changed");
  assert.ok(after.detail.tasks.length > 0 && after.detail.tasks.every((task) => task.status === "accepted"));
  assert.equal(JSON.stringify(after.detail.validationReceipts), JSON.stringify(before.detail.validationReceipts), "Validation receipt changed byte-for-byte");
  assert.deepEqual(after.download, before.download, "Artifact hash or Content-Disposition changed");
  assert.equal(after.detail.blockers.filter((blocker) => blocker.status === "open").length, 0, "Completed Mission gained a blocker");
  assert.deepEqual(after.runtimes.map(({ binding, state, desired, stopProvenance }) => ({ binding, state, desired, stopProvenance })),
    before.runtimes.map(({ binding, state, desired, stopProvenance }) => ({ binding, state, desired, stopProvenance })), "Closed runtime changed");
  assert.ok(after.runtimes.length > 0 && after.runtimes.every((runtime) => runtime.state === "closed"));
  const allocations = (snapshot) => snapshot.detail.events.filter((event) => /remote_runtime_(assigned|reassigned)/.test(event.type));
  assert.deepEqual(allocations(after), allocations(before), "New runtime allocated after completion");
  assert.equal(after.mockRequests, before.mockRequests, "Model received a new request after completion");
  assert.deepEqual(after.bindings, before.bindings, "Old mailbox binding was reopened or claimed");
  assert.ok(after.bindings.every((binding) => ["closed", "uncertain"].includes(binding.status)), "Old binding is open");
  assert.deepEqual(after.transport, before.transport, "Completed transport changed");
  assertNoRestartReplay(after, { afterComplete: true });
  return { missionStatus: "completed", taskStatus: "accepted", mockRequests: after.mockRequests, runtimes: after.runtimes.length, openBlockers: 0, download: after.download };
}

export function assertInterruptedRestart(before, after) {
  assertNoRestartReplay(after);
  assert.equal(after.detail.mission.id, before.detail.mission.id);
  assert.equal(after.detail.mission.orchestratorId, before.detail.mission.orchestratorId);
  assert.equal(after.runtimes.length, 1, "New runtime silently allocated before operator recovery");
  assert.deepEqual(after.runtimes[0].binding, before.runtimes[0].binding, "Old runtime binding changed");
  assert.equal(after.detail.events.some((event) => event.type === "remote_runtime_reassigned"), false);
  assert.equal(after.detail.artifacts.length, 0);
  assert.ok(after.detail.mission.status !== "active" || after.detail.blockers.some((blocker) => blocker.status === "open") ||
    after.detail.events.some((event) => ["worker_start_failed", "remote_runtime_uncertain"].includes(event.type)), "Mission active without blocker or diagnostic");
}

export function assertIrrecoverableRestart(before, after, evidence) {
  assertInterruptedRestart(before, after);
  assert.equal(after.detail.mission.status, "failed", "Recovery reached a dead end without terminal diagnosis");
  const failures = after.detail.events.filter((event) => event.type === "worker_start_failed");
  assert.equal(failures.length, 1, "Expected one startup diagnostic");
  const diagnosis = failures[0].data;
  assert.equal(diagnosis.recoverable, false, "Failure did not disable misleading resume");
  assert.match(diagnosis.reason, /^remote_runtime_[a-z_]+$/, "Missing machine-readable reason");
  assert.ok(String(diagnosis.diagnostic).trim(), "Empty failure diagnostic");
  assert.ok(evidence.humanActions.some((action) => action.action === "resolve" && action.status === 200));
  assert.ok(evidence.humanActions.some((action) => action.action === "resume" && Number.isInteger(action.status)));
  assert.deepEqual(after.transport, before.transport, "Mailbox, effect or delivery changed during failed recovery");
  assert.deepEqual(after.detail.messages, before.detail.messages, "Message attempt changed during failed recovery");
  assert.deepEqual(after.bindings, before.bindings, "Old mailbox binding changed during failed recovery");
  const workerTools = (snapshot) => snapshot.records.filter((record) => record.role === "worker").map(({ name, args }) => ({ name, args }));
  assert.deepEqual(workerTools(after), workerTools(before), "Worker tool repeated during failed recovery");
  return { outcome: "irrecoverable", missionStatus: "failed", reason: diagnosis.reason, diagnostic: diagnosis.diagnostic,
    runtimeState: after.runtimes[0].state, stopProvenance: after.runtimes[0].stopProvenance };
}

export function createCoordinatorRestartScenario(name) {
  if (!restartScenarios.includes(name)) return;
  const completed = name === "restart-after-complete";
  const evidence = { scenario: name, snapshots: [], restarts: [], humanActions: [] };
  let context;
  const scenario = {
    evidence, completed, released: false, mockRequests: 0,
    handleRequest(request) { if (request.url === "/v1/chat/completions") scenario.mockRequests++; return false; },
    configure(value) { context = value; },
    summary() {
      return { ...evidence.assertions, humanActions: evidence.humanActions.map(({ response, ...action }) => ({ ...action,
        response: action.action === "inspect" ? { format: response?.format } : response })) };
    },
    async capture(label) {
      const snapshot = await context.snapshot();
      evidence.snapshots.push({ label, capturedAt: new Date().toISOString(), ...snapshot });
      context.save();
      return snapshot;
    },
    async afterComplete() {
      let before = await scenario.capture("before-restart");
      for (const signal of ["SIGTERM", "SIGKILL"]) {
        await context.restart(signal, evidence);
        const after = await scenario.capture(`after-${signal}`);
        evidence.assertions = assertCompletedRestart(before, after);
        context.save();
        before = after;
      }
      return evidence.assertions;
    },
    async observe(current) {
      if (completed || evidence.restarts.length) return false;
      if (!workerCrashArmed(current, context.records)) return false;
      // Let the final WaitForMessage upload settle before interrupting ownership.
      if ((evidence.settlePolls = (evidence.settlePolls ?? 0) + 1) < 5) return false;
      const before = await scenario.capture("before-restart");
      await context.restart(name === "coordinator-restart-kill" ? "SIGKILL" : "SIGTERM", evidence);
      const after = await scenario.capture("after-restart");
      assertInterruptedRestart(before, after);
      evidence.transportBeforeResume = after.transport;
      evidence.stoppedRuntime = after.runtimes[0];
      const entry = { action: "inspect", method: "GET", path: `/api/missions/${context.missionId}/export`, attemptedAt: new Date().toISOString() };
      evidence.humanActions.push(entry);
      const inspected = await context.request(entry.path);
      Object.assign(entry, { status: inspected.status, response: inspected.body });
      assert.equal(entry.status, 200);
      // Record real node content and terminal receipts before acknowledging uncertainty.
      evidence.workspaceInspection = await context.inspectWorkspace();
      assert.deepEqual(evidence.workspaceInspection, { platform: "linux", answer: 42, version: 1 });
      assertNoRestartReplay(after);
      context.save();
      for (let attempts = 0; ; attempts++) {
        const snapshot = await scenario.capture(`operator-check-${attempts}`);
        assertInterruptedRestart(before, snapshot);
        const open = snapshot.detail.blockers.filter((blocker) => blocker.status === "open");
        if (!open.length) break;
        assert.ok(attempts < 12, "Blockers keep reappearing after reconciliation");
        const blocker = open[0];
        const action = { action: "resolve", method: "POST", path: `/api/blockers/${blocker.id}/resolve`, blocker: { ...blocker },
          body: { resolution: "已只读核对 Linux 文件仍为 version 1、写入及自查成功回执、旧 runtime 与 mailbox 和投递状态；尚未发布。确认无需重放已完成操作，旧所有权仍以产品证据为准。" }, attemptedAt: new Date().toISOString() };
        evidence.humanActions.push(action);
        context.save();
        const result = await context.request(action.path, action.body);
        Object.assign(action, { status: result.status, response: result.body });
        context.save();
        assert.equal(result.status, 200, JSON.stringify(result.body));
      }
      scenario.released = true;
      const action = { action: "resume", method: "POST", path: `/api/missions/${context.missionId}/resume`, body: {}, attemptedAt: new Date().toISOString() };
      evidence.humanActions.push(action);
      context.save();
      const result = await context.request(action.path, action.body, 45000);
      Object.assign(action, { status: result.status, response: result.body });
      context.save();
      const final = await context.wait(async () => {
        const snapshot = await context.snapshot();
        if (snapshot.detail.mission.status === "failed") return snapshot;
        if (snapshot.detail.mission.status === "completed" && snapshot.runtimes.every((runtime) => runtime.state === "closed")) return snapshot;
        if (Date.now() - Date.parse(action.attemptedAt) > 10000) {
          evidence.snapshots.push({ label: "recovery-dead-end", ...snapshot });
          context.save();
          throw new Error(`Recovery dead end: resume HTTP ${result.status}, Mission ${snapshot.detail.mission.status}; ${JSON.stringify(result.body)}`);
        }
        assertNoRestartReplay(snapshot, { progressing: true });
        return false;
      });
      evidence.snapshots.push({ label: "after-operator-recovery", ...final });
      if (final.detail.mission.status === "failed") evidence.assertions = assertIrrecoverableRestart(after, final, evidence);
      else evidence.assertions = { outcome: "recovered", ...context.assertRecovered(final, evidence) };
      context.save();
      return final.detail;
    }
  };
  return scenario;
}

export function configureCoordinatorRestartRun(restart, { missionId, home, proof, records, api, post, wait, command, save, redact,
  readTransport, readRequest, downloadContent, containerName: name, machineId, daemonState, spawnDaemon, activateDaemon, spawnNode, setDetail, assertRecovered, assertCoordinatorExit }) {
  const snapshot = async () => {
    const detail = await api(`/api/missions/${missionId}`);
    setDetail(detail);
    const runtimes = await api(`/api/missions/${missionId}/runtimes`);
    const artifact = detail.artifacts[0];
    let download;
    if (artifact) {
      const response = await downloadContent(artifact.id);
      assert.equal(response.status, 200);
      download = { sha256: sha256(Buffer.from(await response.arrayBuffer())), contentDisposition: response.headers.get("content-disposition") };
    }
    return { detail, runtimes, blockers: detail.blockers, mockRequests: restart.mockRequests, records: structuredClone(records), download,
      bindings: readRestartBindings(join(home, "control.sqlite"), missionId), transport: readTransport() };
  };
  const capture = async () => {
    const { detail } = await restart.capture("final-read");
    save("mission.json", detail);
    save("mission-export.json", (await readRequest(`/api/missions/${missionId}/export`)).body);
  };
  restart.configure({ missionId, records, snapshot, wait, request: (path, body, timeoutMs) => body === undefined ? readRequest(path) : post(path, body, timeoutMs),
    save: () => save("coordinator-restart.json", restart.evidence),
    inspectWorkspace: async () => JSON.parse(await command(["exec", name, "node", "-e", 'console.log(require("node:fs").readFileSync("/work/linux-delivery.json","utf8"))'])),
    assertRecovered,
    restart: async (signal, evidence) => {
      const { handle: previous, info: daemonInfo } = daemonState();
      const entry = { signal, pid: previous.child.pid, daemonId: daemonInfo.daemonId, port: daemonInfo.port, nodePort: daemonInfo.nodePort, startedAt: new Date().toISOString() };
      evidence.restarts.push(entry);
      save("coordinator-restart.json", evidence);
      previous.child.kill(signal);
      const timer = setTimeout(() => previous.child.kill("SIGKILL"), 12000);
      await previous.done;
      clearTimeout(timer);
      Object.assign(entry, { exitCode: previous.child.exitCode, signalCode: previous.child.signalCode });
      writeFileSync(join(proof, `coordinator-${evidence.restarts.length}-${signal}.log`), redact(previous.output()), { mode: 0o600 });
      if (signal === "SIGTERM") assertCoordinatorExit(previous.child.signalCode, true);
      else assert.equal(previous.child.signalCode, "SIGKILL");
      const next = spawnDaemon();
      const newInfo = await wait(() => {
        if (!existsSync(join(home, "daemon.json"))) return false;
        const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
        return info.pid === next.child.pid && info;
      });
      assert.notEqual(newInfo.daemonId, entry.daemonId);
      activateDaemon(newInfo);
      Object.assign(entry, { newPid: newInfo.pid, newDaemonId: newInfo.daemonId, newPort: newInfo.port, newNodePort: newInfo.nodePort });
      // The product node CLI exits on lost transport. Reconnect explicitly in the
      // same running container with the same journal, roots and credentials.
      let reconnect;
      await wait(async () => {
        const state = await api("/api/state");
        if (state.machines.some((machine) => machine.id === machineId && machine.status === "online")) return true;
        const stopped = JSON.parse(await command(["exec", name, "node", "-e", 'const fs=require("node:fs");const pid=Number(fs.readFileSync("/node-home/acceptance-node.pid","utf8"));let alive=true;try{process.kill(pid,0)}catch{alive=false}console.log(JSON.stringify({pid,alive}))']));
        if (!stopped.alive && !reconnect) {
          entry.nodeReconnect = { previousPid: stopped.pid, explicit: true, sameHome: "/node-home", sameContainer: name };
          reconnect = spawnNode();
        }
        if (reconnect?.error() || (reconnect && (reconnect.child.exitCode !== null || reconnect.child.signalCode !== null))) throw new Error(`Node reconnect failed: ${reconnect.output()}`);
        return false;
      });
      // Allow old-binding fencing and historical stop reports to settle.
      const settledAt = Date.now();
      await wait(async () => Date.now() - settledAt >= 1000 && await api("/api/state"));
      entry.completedAt = new Date().toISOString();
      entry.durationMs = Date.now() - Date.parse(entry.startedAt);
      save("coordinator-restart.json", evidence);
    }
  });

  return capture;
}
