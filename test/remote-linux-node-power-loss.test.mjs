import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { nextCall, startMock } from "../acceptance/remote-linux/mock.mjs";
import { parseOptions } from "../acceptance/remote-linux/run.mjs";
import { crashSnapshot } from "../acceptance/remote-linux/scenarios/worker-crash.mjs";
import { assertLostOwnership, assertNoPowerLossReplay, assertNodePowerLoss, assertRestartedNode, createNodePowerLossScenario, nodePowerLossTool, readNodeJournal } from "../acceptance/remote-linux/scenarios/node-power-loss.mjs";

const context = { scenario: "node-power-loss", acceptanceCommand: "node --test /host/test.mjs", hostTestPath: "/host/test.mjs" };
const selfCheck = { name: "bash", args: { command: "Linux self-check" }, value: { status: "succeeded", result: { exitCode: 0 } } };
function request(result = selfCheck) {
  const state = { mission: {}, roles: [], tasks: [{ id: "task", ownerId: "worker", status: "running" }], agents: [{ id: "worker", kind: "worker" }], executionEnvironment: { platform: "linux" } };
  const body = { model: "mock", stream: true, tools: ["bash", "GetMissionState", "write_file", "PublishArtifact", "WaitForMessage"].map((name) => ({ function: { name } })), messages: [{ role: "system", content: "You are a persistent member of a Mission" }] };
  for (const [i, entry] of [{ name: "GetMissionState", value: state }, result].entries()) {
    body.messages.push({ role: "assistant", tool_calls: [{ id: String(i), function: { name: entry.name, arguments: JSON.stringify(entry.args ?? {}) } }] },
      { role: "tool", tool_call_id: String(i), content: JSON.stringify(entry.value) });
  }
  return body;
}

test("node-power-loss CLI is mock-only and retains default timeout", () => {
  assert.deepEqual(parseOptions(["--scenario", "node-power-loss"]), { scenario: "node-power-loss", keep: false, timeoutMs: 180000 });
  assert.throws(() => parseOptions(["--scenario", "node-power-loss", "--real", "config", "--secrets-file", "secrets"]), /mock mode/);
});

test("power-loss mock waits after one successful self-check without changing default publication", () => {
  assert.equal(nodePowerLossTool([]), null);
  assert.equal(nodePowerLossTool([{ ...selfCheck, value: { status: "failed" } }]), null);
  assert.equal(nodePowerLossTool([{ ...selfCheck, args: { command: "LIVE-SOURCE-CHANGED" } }]), null);
  assert.deepEqual(nextCall(request(), context), { role: "worker", name: "WaitForMessage", args: {} });
  assert.equal(nextCall(request(), { ...context, scenario: "default" }).name, "PublishArtifact");
  assert.throws(() => nextCall(request({ ...selfCheck, value: { status: "succeeded", result: { exitCode: 1 } } }), context), /self-check failed/);
});

test("power-loss scenario reaches the streaming mock and cannot publish", async (t) => {
  const records = [];
  const server = await startMock({ ...context, credential: "unit", record: (entry) => records.push(entry), fail: (error) => assert.fail(error.message) });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer unit" }, body: JSON.stringify(request()) });
  assert.equal(response.status, 200);
  const events = (await response.text()).split("\n\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  assert.equal(events[0].choices[0].delta.tool_calls[0].function.name, "WaitForMessage");
  assert.deepEqual(records.map(({ role, name }) => ({ role, name })), [{ role: "worker", name: "WaitForMessage" }]);
});

function fixture() {
  const binding = { runtimeId: "runtime", machineId: "linux", sessionId: "old-session", sessionEpoch: 1, agentId: "worker", epoch: 2 };
  const machine = { id: "linux", status: "online", sessionId: "old-session", sessionEpoch: 1 };
  const runtime = { binding, desired: "stop", state: "stopping", stopProvenance: "uncertain" };
  const transport = { effects: [{ command_id: "write" }, { command_id: "check" }], deliveries: [{ message_id: "message", attempt: 1, status: "completed" }] };
  const detail = { mission: { status: "blocked" }, artifacts: [], blockers: [{ id: "remote-runtime:runtime", status: "open" }], messages: [{ id: "message", attempt: 1, status: "completed" }], events: [
    { type: "remote_effect_receipt", data: { effectId: "write" } }, { type: "remote_effect_receipt", data: { effectId: "check" } }
  ] };
  const records = ["GetMissionState", "write_file", "bash", "WaitForMessage"].map((name) => ({ role: "worker", name }));
  const node = { journal: { node_identity: [{ machine_id: "linux", coordinator_id: "http://127.0.0.1:14311", registration_id: null }],
    node_worker_runtimes: [{ binding_json: JSON.stringify(binding), state: "uncertain", confirmed_stopped: 0 }], node_effects: [{ effect_id: "write", state: "succeeded" }, { effect_id: "check", state: "succeeded" }] },
    processes: [{ pid: 19, command: ["node", "/app/dist/cli.js", "node"] }] };
  const before = { binding: structuredClone(binding), machine, node: structuredClone(node), activity: structuredClone(crashSnapshot(detail, records, transport)) };
  before.node.journal.node_worker_runtimes[0].state = "running";
  const lost = { detail: structuredClone(detail), runtimes: [structuredClone(runtime)], machine: { ...machine, status: "offline" } };
  const restarted = { machine: { ...machine, sessionId: "new-session", sessionEpoch: 2 }, node };
  detail.mission.status = "failed";
  detail.events.push({ type: "worker_start_failed", data: { recoverable: false, reason: "remote_runtime_uncertain" } });
  const final = { detail, runtimes: [runtime], transport, ...structuredClone(restarted) };
  const evidence = { before, lost, restarted, final, kill: { signal: "SIGKILL", containerRemoved: true }, lossObservedMs: 19800,
    beforeResume: structuredClone(crashSnapshot(detail, records, transport)), humanActions: [{ action: "resolve", status: 200 }, { action: "resume", status: 409 }] };
  return { evidence, records };
}

test("power-loss accepts durable uncertainty and a machine-readable permanent refusal", () => {
  const { evidence, records } = fixture();
  assert.deepEqual(assertNodePowerLoss(evidence, records), { artifacts: 0, stopProvenance: "uncertain", remoteRuntimeState: "stopping", lossObservedMs: 19800, reason: "remote_runtime_uncertain", recoverable: false, effectReceipts: 2 });
});

test("lease loss requires an offline node, a blocked Mission and its ownership blocker", () => {
  for (const mutate of [
    (e) => { e.lost.machine.status = "online"; },
    (e) => { e.lost.detail.mission.status = "active"; },
    (e) => { e.lost.detail.blockers[0].status = "resolved"; },
    (e) => { e.lost.runtimes[0].stopProvenance = "controlled"; },
    (e) => { e.lost.runtimes[0].desired = "run"; }
  ]) {
    const { evidence: e } = fixture(); mutate(e);
    assert.throws(() => assertLostOwnership(e.lost.detail, e.lost.runtimes, e.lost.machine, e.before));
  }
});

test("restarted node must retain identity and old uncertainty without a live worker", () => {
  for (const mutate of [
    (e) => { e.restarted.machine.sessionId = "old-session"; },
    (e) => { e.restarted.machine.sessionEpoch = 1; },
    (e) => { e.restarted.node.journal.node_identity[0].machine_id = "other"; },
    (e) => { e.restarted.node.journal.node_worker_runtimes[0].state = "running"; },
    (e) => { e.restarted.node.journal.node_worker_runtimes[0].confirmed_stopped = 1; },
    (e) => { e.restarted.node.journal.node_worker_runtimes[0].binding_json = JSON.stringify({ runtimeId: "new" }); },
    (e) => { e.restarted.node.processes.push({ pid: 20, command: ["node", "/app/dist/worker.js"] }); },
    (e) => { e.restarted.node.processes = []; },
    (e) => { e.restarted.node.journal.node_effects.push({ effect_id: "replayed" }); }
  ]) {
    const { evidence: e } = fixture(); mutate(e);
    assert.throws(() => assertRestartedNode(e.restarted.machine, e.restarted.node, e.before));
  }
});

test("power-loss rejects replacement, publication and effect, tool or delivery replay", () => {
  for (const mutate of [
    (e) => { e.final.runtimes.push(e.final.runtimes[0]); },
    (e) => { e.final.runtimes[0].binding.epoch++; },
    (e) => { e.final.detail.artifacts.push({ id: "artifact" }); },
    (e) => { e.final.detail.events.push({ type: "remote_runtime_reassigned" }); },
    (e) => { e.final.detail.events.push({ type: "artifact_published" }); },
    (e) => { e.final.detail.events.push({ type: "delivery_resumed" }); },
    (e) => { e.final.detail.events.push(e.final.detail.events[0]); },
    (_e, r) => { r.push({ role: "worker", name: "bash" }); },
    (e) => { e.final.transport.effects.push({ command_id: "replay" }); },
    (e) => { e.final.transport.deliveries[0].attempt++; },
    (e) => { e.final.detail.messages[0].attempt++; },
    (e) => { e.final.detail.events.push(...[1, 2].map(() => ({ type: "delivery_admitted", data: { messageId: "message", attempt: 1 } }))); }
  ]) {
    const { evidence: e, records } = fixture(); mutate(e, records);
    assert.throws(() => assertNoPowerLossReplay(e.final.detail, e.final.runtimes, e.before, records, e.final.transport));
  }
});

test("operator recovery must fail permanently with a reason and no post-resume activity", () => {
  for (const mutate of [
    (e) => { e.final.detail.mission.status = "paused"; },
    (e) => { e.final.detail.events.at(-1).data.recoverable = true; },
    (e) => { delete e.final.detail.events.at(-1).data.reason; },
    (e) => { e.final.detail.events.at(-1).data.reason = "human prose"; },
    (e) => { e.final.detail.events.pop(); },
    (e) => { e.humanActions = []; },
    (e) => { e.kill.containerRemoved = false; },
    (e) => { e.beforeResume.deliveries[0].status = "uncertain"; }
  ]) {
    const { evidence, records } = fixture(); mutate(evidence);
    assert.throws(() => assertNodePowerLoss(evidence, records));
  }
});

test("persistent home is bound to this scenario and journal inspection leaves rows intact", (t) => {
  const root = mkdtempSync(join(tmpdir(), "power-loss-journal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "node-home");
  const scenario = createNodePowerLossScenario(home);
  assert.deepEqual(scenario.mountArgs(), ["-v", `${home}:/node-home`, "--env", "MC_ACCEPTANCE_NODE_HOME=/node-home/state"]);
  assert.equal(scenario.expectsExit({}), false);
  mkdirSync(join(home, "worker-runtime"));
  const files = [ ["node.sqlite", ["node_identity", "node_owner", "node_runtime_reports"]],
    ["worker-runtime/node-workers.sqlite", ["node_worker_runtimes", "worker_mailbox_bindings", "node_effects"]] ];
  for (const [file, tables] of files) {
    const db = new DatabaseSync(join(home, file));
    for (const table of tables) { db.exec(`CREATE TABLE ${table}(value TEXT)`); db.prepare(`INSERT INTO ${table} VALUES(?)`).run(`${table}-evidence`); }
    db.close();
  }
  const actual = JSON.parse(JSON.stringify(readNodeJournal(home)));
  assert.deepEqual(actual, Object.fromEntries(files.flatMap(([, tables]) => tables.map((table) => [table, [{ value: `${table}-evidence` }]]))));
  assert.deepEqual(JSON.parse(JSON.stringify(readNodeJournal(home))), actual);
});

test("power-loss driver kills the node once, restarts with the same home and records each operator action", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "power-loss-driver-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "state");
  mkdirSync(join(home, "worker-runtime"), { recursive: true });
  for (const [file, tables] of [["node.sqlite", ["node_identity", "node_owner", "node_runtime_reports"]], ["worker-runtime/node-workers.sqlite", ["node_worker_runtimes", "worker_mailbox_bindings", "node_effects"]]]) {
    const db = new DatabaseSync(join(home, file));
    for (const table of tables) db.exec(`CREATE TABLE ${table}(value TEXT)`);
    db.close();
  }
  const { evidence: e, records } = fixture();
  let clock = 0, stage = "before", heartbeat = 0;
  t.mock.method(Date, "now", () => { clock += 1000; return clock; });
  const active = structuredClone(e.lost);
  active.detail.mission.status = "active";
  active.detail.blockers = [];
  active.detail.agents = [{ status: "idle" }];
  active.detail.events[1].data.receipt = { status: "succeeded", result: { exitCode: 0, stdout: "LINUX-SELF-CHECK-OK" } };
  active.runtimes[0].state = "running";
  active.machine = e.before.machine;
  const calls = [], saved = {};
  const handle = { child: { exitCode: null, signalCode: null }, output: () => "node killed" };
  const scenario = createNodePowerLossScenario(root);
  const api = async (path) => {
    const current = stage === "before" ? active : stage === "lost" ? e.lost : e.final;
    if (path.endsWith("/runtimes")) return structuredClone(current.runtimes);
    if (path === "/api/state") return { machines: [{ ...current.machine, lastSeenAt: ++heartbeat }] };
    const detail = structuredClone(current.detail);
    if (stage === "restarted") { detail.mission.status = "blocked"; detail.events.pop(); }
    if (stage === "resolved") { detail.mission.status = "paused"; detail.blockers = []; detail.events.pop(); }
    return detail;
  };
  scenario.configure({ machineId: "linux", missionId: "mission", containerName: "mc-acc-unit", records, api, readEvidence: api,
    readTransport: () => structuredClone(e.final.transport), getNode: () => handle,
    save: (name, value) => { saved[name] = structuredClone(value); },
    wait: async (predicate) => { for (let i = 0; i < 10; i++) { const result = await predicate(); if (result) return result; } throw new Error("test wait exhausted"); },
    exec: async (args) => {
      if (args[0] === "kill") { calls.push(args); stage = "lost"; handle.child.exitCode = 137; return ""; }
      if (args[0] === "list") return "";
      if (args[0] === "exec") return JSON.stringify(stage === "before" ? e.before.node : e.restarted.node);
      assert.fail(args.join(" "));
    },
    startNode: () => { calls.push(["restart"]); stage = "restarted"; },
    post: async (path, body) => { calls.push([path, body]); stage = path.endsWith("/resolve") ? "resolved" : "failed"; return { status: stage === "resolved" ? 200 : 409, body: { error: "uncertain runtime" } }; }
  });
  assert.equal((await scenario.execute()).mission.status, "failed");
  await scenario.capture();
  assert.equal(scenario.assertCompleted().recoverable, false);
  assert.deepEqual(calls.map((call) => call[0]), ["kill", "restart", "/api/blockers/remote-runtime:runtime/resolve", "/api/missions/mission/resume"]);
  assert.deepEqual(calls[0], ["kill", "--signal", "KILL", "mc-acc-unit"]);
  assert.equal(scenario.expectsExit(handle), true);
  assert.equal(scenario.expectsExit({}), false);
  assert.equal(saved["node-power-loss.json"].humanActions[0].request.resolution, calls[2][1].resolution);
  assert.equal(saved["node-power-loss.json"].humanActions[1].status, 409);
  assert.equal(saved["node-power-loss.json"].restart.nodeHome, home);
});
