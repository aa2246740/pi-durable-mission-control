import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crashSnapshot, workerCrashArmed, workerCrashTool } from "./worker-crash.mjs";

export const nodePowerLossTool = workerCrashTool;
export const powerLossResolution = "已记录节点断电及旧 runtime 所有权不确定；仅清除此 blocker 以测试 resume 拒绝，不授权重放或重新分配。";

// Both host and guest readers use read-only SQLite connections. No ownership,
// registration, mailbox or effect record is repaired by the acceptance script.
export function readNodeJournal(home) {
  const query = (path, tables) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    } finally { db.close(); }
  };
  return {
    ...query(join(home, "node.sqlite"), ["node_identity", "node_owner", "node_runtime_reports"]),
    ...query(join(home, "worker-runtime/node-workers.sqlite"), ["node_worker_runtimes", "worker_mailbox_bindings", "node_effects"])
  };
}

export function nodeProcesses() {
  return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    let command;
    try { command = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return []; throw error; }
    if (!command.some((arg) => arg === "worker.js" || arg.endsWith("/worker.js") || arg.endsWith("/cli.js"))) return [];
    return [{ pid: Number(name), command }];
  });
}

export function nodeEvidenceSource() {
  return `const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const readNodeJournal = ${readNodeJournal.toString()};
const nodeProcesses = ${nodeProcesses.toString()};
console.log(JSON.stringify({ journal: readNodeJournal("/node-home/state"), processes: nodeProcesses() }));`;
}

export function assertNoPowerLossReplay(detail, runtimes, before, records, transport) {
  assert.equal(runtimes.length, 1, "Expected only the original runtime");
  assert.deepEqual(runtimes[0].binding, before.binding, "Old binding changed or was reclaimed");
  assert.equal(detail.artifacts.length, 0, "Publication occurred");
  for (const type of ["remote_runtime_reassigned", "artifact_published", "delivery_resumed"]) {
    assert.equal(detail.events.some((event) => event.type === type), false, `${type} appeared`);
  }
  const after = crashSnapshot(detail, records, transport);
  assert.deepEqual(after.workerTools, before.activity.workerTools, "Worker tool calls changed after power loss");
  assert.deepEqual(after.effectIds, before.activity.effectIds, "Effect receipts changed after power loss");
  assert.deepEqual(after.effects, before.activity.effects, "Effect permits changed after power loss");
  const attempts = (rows) => rows.map(({ id, attempt }) => ({ id, attempt }));
  assert.deepEqual(attempts(after.messageAttempts), attempts(before.activity.messageAttempts), "Delivery attempts changed after power loss");
  const deliveries = (rows) => rows.map(({ message_id, attempt }) => ({ message_id, attempt }));
  assert.deepEqual(deliveries(after.deliveries), deliveries(before.activity.deliveries), "Durable deliveries changed after power loss");
  for (const type of ["delivery_admitted", "delivery_delivered", "delivery_completed"]) {
    const ids = detail.events.filter((event) => event.type === type).map((event) => `${event.data.messageId}:${event.data.attempt}`);
    assert.equal(new Set(ids).size, ids.length, `${type} replayed`);
  }
  return after;
}

export function assertLostOwnership(detail, runtimes, machine, before) {
  assert.equal(machine.status, "offline", "Lease loss was not observed");
  assert.equal(detail.mission.status, "blocked", "Mission did not block after lease loss");
  assert.equal(runtimes.length, 1);
  assert.deepEqual(runtimes[0].binding, before.binding);
  assert.ok(["uncertain", "unproven"].includes(runtimes[0].stopProvenance), "Lost ownership was recorded as controlled or unexpected");
  assert.equal(runtimes[0].desired, "stop");
  assert.ok(detail.blockers.some((blocker) => blocker.id === `remote-runtime:${before.binding.runtimeId}` && blocker.status === "open"), "Missing open ownership blocker");
}

export function assertRestartedNode(machine, node, before) {
  assert.equal(machine.id, before.machine.id);
  assert.equal(machine.status, "online");
  assert.ok(machine.sessionId && machine.sessionId !== before.machine.sessionId, "No new live session");
  assert.ok(machine.sessionEpoch > before.machine.sessionEpoch, "Session epoch did not increase");
  assert.deepEqual(node.journal.node_identity, before.node.journal.node_identity, "Persistent node identity changed");
  const rows = node.journal.node_worker_runtimes;
  assert.equal(rows.length, 1, "Node journal gained a replacement runtime");
  assert.deepEqual(JSON.parse(rows[0].binding_json), before.binding, "Node reclaimed the old binding");
  assert.equal(rows[0].state, "uncertain", "Node restart did not preserve uncertain ownership");
  assert.equal(rows[0].confirmed_stopped, 0, "Node invented physical stop evidence");
  assert.equal(node.processes.filter((entry) => entry.command.some((arg) => arg === "worker.js" || arg.endsWith("/worker.js"))).length, 0, "Node restarted a worker");
  assert.equal(node.processes.filter((entry) => entry.command.some((arg) => arg.endsWith("/cli.js"))).length, 1, "No live node supervisor");
  assert.deepEqual(node.journal.node_effects, before.node.journal.node_effects, "Node effects changed after restart");
}

export function assertNodePowerLoss(evidence, records) {
  const { detail, runtimes, transport, machine, node } = evidence.final;
  assert.equal(evidence.kill.signal, "SIGKILL");
  assert.equal(evidence.kill.containerRemoved, true, "Whole node container did not exit");
  assert.ok(Number.isFinite(evidence.lossObservedMs) && evidence.lossObservedMs >= 0);
  assertLostOwnership(evidence.lost.detail, evidence.lost.runtimes, evidence.lost.machine, evidence.before);
  assertRestartedNode(evidence.restarted.machine, evidence.restarted.node, evidence.before);
  assertRestartedNode(machine, node, evidence.before);
  const activity = assertNoPowerLossReplay(detail, runtimes, evidence.before, records, transport);
  assert.deepEqual(activity, evidence.beforeResume, "Activity changed after operator resume");
  assert.ok(["uncertain", "unproven"].includes(runtimes[0].stopProvenance));
  assert.equal(detail.mission.status, "failed");
  const failures = detail.events.filter((event) => event.type === "worker_start_failed");
  assert.equal(failures.length, 1, "Expected one worker_start_failed");
  assert.equal(failures[0].data?.recoverable, false);
  assert.match(failures[0].data?.reason ?? "", /^remote_runtime_[a-z_]+$/);
  assert.ok(evidence.humanActions.some((action) => action.action === "resolve" && action.status === 200));
  assert.equal(evidence.humanActions.filter((action) => action.action === "resume").length, 1);
  assert.equal(activity.workerTools.filter((name) => name === "write_file").length, 1);
  assert.equal(activity.workerTools.filter((name) => name === "bash").length, 1);
  assert.equal(activity.effectIds.length, 2);
  assert.equal(activity.effects.length, 2);
  assert.ok(activity.messageAttempts.every((message) => message.attempt === 1));
  return { artifacts: 0, stopProvenance: runtimes[0].stopProvenance, remoteRuntimeState: runtimes[0].state,
    lossObservedMs: evidence.lossObservedMs, reason: failures[0].data.reason, recoverable: false, effectReceipts: 2 };
}

export function createNodePowerLossScenario(home) {
  const evidence = { humanActions: [], nodeHome: join(home, "state"), leaseMs: 20000, leaseOverride: false };
  let context, killedHandle;
  const save = () => context.save("node-power-loss.json", evidence);
  const guest = async () => JSON.parse(await context.exec(["exec", context.containerName, "node", "-e", nodeEvidenceSource()]));
  const state = async (read = context.api) => ({
    detail: await read(`/api/missions/${context.missionId}`),
    runtimes: await read(`/api/missions/${context.missionId}/runtimes`),
    machine: (await read("/api/state")).machines.find((machine) => machine.id === context.machineId),
    transport: context.readTransport()
  });
  const unchanged = (snapshot) => assertNoPowerLossReplay(snapshot.detail, snapshot.runtimes, evidence.before, context.records, snapshot.transport);
  const human = async (action, path, body) => {
    const entry = { action, path, request: body, attemptedAt: new Date().toISOString() };
    evidence.humanActions.push(entry);
    save();
    try {
      const result = await context.post(path, body, 45000);
      Object.assign(entry, { status: result.status, response: result.body });
    }
    catch (error) { entry.error = error.message; throw error; }
    finally { save(); }
    return entry;
  };
  return {
    evidence,
    mountArgs() { mkdirSync(home, { recursive: true, mode: 0o700 }); return ["-v", `${home}:/node-home`, "--env", "MC_ACCEPTANCE_NODE_HOME=/node-home/state"]; },
    configure(value) { context = value; save(); },
    expectsExit(handle) { return handle === killedHandle; },
    async execute() {
      let readyAt;
      await context.wait(async () => {
        const detail = await context.api(`/api/missions/${context.missionId}`);
        assert.equal(detail.artifacts.length, 0);
        assert.ok(!["failed", "completed", "blocked"].includes(detail.mission.status), "Mission ended before power loss");
        if (!workerCrashArmed(detail, context.records) || detail.agents.some((agent) => !["idle", "offline"].includes(agent.status))) { readyAt = undefined; return false; }
        readyAt ??= Date.now();
        return Date.now() - readyAt >= 500;
      });
      const before = await state();
      assert.equal(before.runtimes.length, 1);
      assert.equal(before.runtimes[0].state, "running");
      evidence.before = { ...before, binding: before.runtimes[0].binding, node: await guest(), activity: crashSnapshot(before.detail, context.records, before.transport) };
      assert.equal(evidence.before.node.journal.node_worker_runtimes[0].state, "running");
      assert.equal(evidence.before.activity.effectIds.length, 2);
      killedHandle = context.getNode();
      const killedAt = Date.now();
      evidence.kill = { containerName: context.containerName, signal: "SIGKILL", attemptedAt: new Date(killedAt).toISOString(), command: ["kill", "--signal", "KILL", context.containerName] };
      save();
      await context.exec(evidence.kill.command);
      await context.wait(async () => {
        const names = (await context.exec(["list", "--all", "--quiet"])).trim().split(/\s+/);
        return !names.includes(context.containerName) && (killedHandle.child.exitCode !== null || killedHandle.child.signalCode !== null);
      });
      evidence.kill.containerRemoved = true;
      evidence.kill.completedAt = new Date().toISOString();
      evidence.kill.exitCode = killedHandle.child.exitCode;
      evidence.kill.output = killedHandle.output();
      save();
      evidence.lost = await context.wait(async () => {
        const snapshot = await state();
        unchanged(snapshot);
        if (snapshot.machine.status !== "offline" || snapshot.detail.mission.status !== "blocked") return false;
        assertLostOwnership(snapshot.detail, snapshot.runtimes, snapshot.machine, evidence.before);
        return snapshot;
      });
      evidence.lossObservedMs = Date.now() - killedAt;
      evidence.lossObservedAt = new Date().toISOString();
      evidence.journalAfterKill = readNodeJournal(join(home, "state"));
      save();
      evidence.restart = { attemptedAt: new Date().toISOString(), machineId: context.machineId, nodeHome: join(home, "state"), sameTokenViaStdin: true };
      save();
      context.startNode();
      const first = await context.wait(async () => {
        const snapshot = await state();
        unchanged(snapshot);
        return snapshot.machine.status === "online" && snapshot.machine.sessionId !== before.machine.sessionId && snapshot;
      });
      // Require another heartbeat, so a session opened just before startup fails
      // cannot masquerade as a live restarted node.
      evidence.restarted = await context.wait(async () => {
        const snapshot = await state();
        unchanged(snapshot);
        if (snapshot.machine.lastSeenAt <= first.machine.lastSeenAt) return false;
        const node = await guest();
        assertRestartedNode(snapshot.machine, node, evidence.before);
        assert.ok(["uncertain", "unproven"].includes(snapshot.runtimes[0].stopProvenance));
        return { ...snapshot, node };
      });
      save();
      for (const blocker of evidence.restarted.detail.blockers.filter((item) => item.status === "open")) {
        const result = await human("resolve", `/api/blockers/${blocker.id}/resolve`, { resolution: powerLossResolution });
        assert.equal(result.status, 200, JSON.stringify(result.response));
      }
      const resolved = await state();
      unchanged(resolved);
      evidence.beforeResume = crashSnapshot(resolved.detail, context.records, resolved.transport);
      save();
      await human("resume", `/api/missions/${context.missionId}/resume`, {});
      const final = await context.wait(async () => {
        const snapshot = await state();
        unchanged(snapshot);
        return snapshot.detail.mission.status === "failed" && snapshot;
      });
      evidence.final = { ...final, node: await guest() };
      save();
      assertNodePowerLoss(evidence, context.records);
      return final.detail;
    },
    async capture() {
      if (!context) return;
      try {
        evidence.final = await state(context.readEvidence);
        const handle = context.getNode();
        evidence.nodeExit = { exitCode: handle.child.exitCode, signalCode: handle.child.signalCode, output: handle.output() };
        try { evidence.final.node = await guest(); }
        catch (error) {
          evidence.nodeReadError = error.message;
          try { evidence.persistedJournal = readNodeJournal(join(home, "state")); }
          catch (journalError) { evidence.journalReadError = journalError.message; }
        }
        context.save("mission.json", evidence.final.detail);
        context.save("mission-export.json", await context.readEvidence(`/api/missions/${context.missionId}/export`));
        context.save("runtimes.json", evidence.final.runtimes);
      } finally { save(); }
    },
    assertCompleted() { return assertNodePowerLoss(evidence, context.records); }
  };
}
