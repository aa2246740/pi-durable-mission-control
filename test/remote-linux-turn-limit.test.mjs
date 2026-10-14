import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nextCall, startMock } from "../acceptance/remote-linux/mock.mjs";
import { parseOptions } from "../acceptance/remote-linux/run.mjs";
import { turnLimitMaxTurns, findLimitRpc, createTurnLimitScenario } from "../acceptance/remote-linux/scenarios/turn-limit.mjs";

const context = { scenario: "turn-limit", acceptanceCommand: "node --test /host/test.mjs", hostTestPath: "/host/test.mjs" };
const state = { mission: {}, roles: [], tasks: [{ id: "task", ownerId: "worker", status: "running" }], agents: [{ id: "worker", kind: "worker" }], executionEnvironment: { platform: "linux" } };
function request(results) {
  const body = { model: "mock", stream: true, tools: ["bash", "GetMissionState", "write_file", "PublishArtifact", "Report", "UpdateTask", "WaitForMessage"].map((name) => ({ function: { name } })),
    messages: [{ role: "system", content: "You are a persistent member of a Mission" }] };
  for (const [name, value, args = {}] of results) {
    const id = `call-${body.messages.length}`;
    body.messages.push({ role: "assistant", tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] }, { role: "tool", tool_call_id: id, content: JSON.stringify(value) });
  }
  return body;
}
const selfCheck = ["bash", { status: "succeeded", result: { exitCode: 0 } }, { command: "Linux self-check" }];

test("turn-limit calculates the exact setup budget and validates integer bounds", () => {
  assert.equal(turnLimitMaxTurns(), 16);
  assert.equal(turnLimitMaxTurns({ orchestrator: 12, validator: 2, worker: 3 }), 17);
  for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => turnLimitMaxTurns({ worker: count }));
});

test("turn-limit accepts mock CLI mode and rejects real-model mode", () => {
  assert.equal(parseOptions(["--scenario", "turn-limit"]).scenario, "turn-limit");
  assert.throws(() => parseOptions(["--scenario", "turn-limit", "--real", "config.json", "--secrets-file", "secrets"]), /mock mode/);
});

test("turn-limit worker resumes from its successful self-check without rewriting or repeating bash", () => {
  const body = request([["GetMissionState", state], selfCheck, ["GetMissionState", state]]);
  assert.deepEqual(nextCall(body, context), { role: "worker", name: "PublishArtifact", args: { name: "Frozen Linux delivery", path: "linux-delivery.json", taskId: "task" } });
  const beforeCheck = request([["GetMissionState", state]]);
  assert.equal(nextCall(beforeCheck, context).name, "write_file");
  for (const value of [{ status: "failed" }, { status: "succeeded", result: { exitCode: 1 } }]) {
    assert.throws(() => nextCall(request([["GetMissionState", state], ["bash", value, selfCheck[2]], ["GetMissionState", state]]), context));
  }
  body.messages.push({ role: "user", content: "replacement runtime wake" });
  assert.equal(nextCall(body, context).name, "GetMissionState");
});

function evidenceFixture() {
  const binding = { runtimeId: "runtime", machineId: "linux", sessionId: "session", sessionEpoch: 1, agentId: "worker", epoch: 2 };
  const detail = { mission: { status: "blocked", turns: 16, maxTurns: 16 }, events: [{ seq: 2, type: "turn_admission_denied", text: "Mission turn limit exhausted", agentId: "worker", data: { generationId: "denied", turns: 16, maxTurns: 16 } },
    { seq: 1, type: "remote_effect_receipt", agentId: "worker", data: { receipt: { status: "succeeded", result: { exitCode: 0, stdout: "LINUX-SELF-CHECK-OK" } } } }], artifacts: [], blockers: [{ id: "limit", kind: "limit", status: "open" }] };
  const envelope = { binding, payload: { kind: "rpc", method: "AdmitTurn", rpcId: "rpc", args: { generationId: "denied" } } };
  const transport = { inbox: [{ message_id: "inbox", runtime_id: "runtime", status: "applied", envelope_json: JSON.stringify(envelope) }],
    outbox: [{ source_inbox_id: "inbox", envelope_json: JSON.stringify({ payload: { kind: "reply", rpcId: "rpc", ok: false, error: "Remote operation was rejected" } }) }] };
  const stopped = { binding, state: "closed", stopProvenance: "controlled", report: { outcome: "stopped" } };
  return { binding, detail, transport, stopped };
}

test("turn-limit ties the applied denial and persisted rejection to the exact remote binding", () => {
  const { binding, detail, transport } = evidenceFixture();
  assert.equal(findLimitRpc(detail, transport, binding).inbox.message_id, "inbox");
  for (const status of ["received", "processing", "uncertain"]) assert.throws(() => findLimitRpc(detail, { ...transport, inbox: [{ ...transport.inbox[0], status }] }, binding), /not settled/);
  assert.throws(() => findLimitRpc(detail, transport, { ...binding, epoch: 4 }), /binding mismatch/);
  assert.throws(() => findLimitRpc({ ...detail, events: [{ ...detail.events[0], agentId: "local" }] }, transport, binding), /remote worker/);
  assert.throws(() => findLimitRpc(detail, { ...transport, outbox: [] }, binding), /persisted reply/);
  assert.throws(() => findLimitRpc(detail, { ...transport, inbox: [...transport.inbox, ...transport.inbox] }, binding), /missing from coordinator inbox/);
});

function recoveryContext(fixture, rejectResume = false) {
  const current = structuredClone(fixture.detail);
  const calls = [];
  const context = { missionId: "mission", save() {}, readTransport: () => fixture.transport, wait: async (predicate) => { const result = await predicate(); assert.ok(result); return result; },
    api: async (path, body, method) => {
      if (body !== undefined) calls.push({ path, body, method });
      if (path.endsWith("/runtimes")) return [fixture.stopped];
      if (method === "PATCH") { current.mission.maxTurns = body.maxTurns; return current.mission; }
      if (path.endsWith("/resolve")) { current.blockers[0].status = "resolved"; current.mission.status = "paused"; return current.blockers[0]; }
      if (path.endsWith("/resume")) {
        if (rejectResume) throw new Error("409 Resolve mission blockers before resuming");
        current.mission.status = "active";
      }
      return current;
    } };
  return { context, calls };
}

test("turn-limit records PATCH, limit resolution and resume as separate operator actions", async () => {
  const fixture = evidenceFixture();
  const { context, calls } = recoveryContext(fixture);
  const scenario = createTurnLimitScenario();
  scenario.configure(context);
  await scenario.recover(fixture.detail);
  assert.deepEqual(calls, [
    { path: "/api/missions/mission", body: { maxTurns: 96 }, method: "PATCH" },
    { path: "/api/blockers/limit/resolve", body: { resolution: "Turn budget increased; continue after the controlled remote stop." }, method: "POST" },
    { path: "/api/missions/mission/resume", body: {}, method: "POST" }
  ]);
  assert.deepEqual(scenario.evidence.humanActions.map((entry) => entry.action), ["raise-maxTurns", "resolve-limit", "resume"]);
  assert.ok(scenario.evidence.humanActions.every((entry) => entry.completedAt));
  assert.equal(scenario.evidence.limitRpc.inbox.status, "applied");
});

test("turn-limit preserves a full resume rejection and does not resolve delivery blockers", async () => {
  const fixture = evidenceFixture();
  fixture.detail.blockers = [{ id: "delivery", kind: "delivery", status: "open", text: "uncertain delivery" }];
  const { context, calls } = recoveryContext(fixture, true);
  const scenario = createTurnLimitScenario();
  scenario.configure(context);
  await assert.rejects(scenario.recover(fixture.detail), /409 Resolve mission blockers before resuming/);
  assert.deepEqual(scenario.evidence.limitBlockers, []);
  assert.deepEqual(scenario.evidence.otherBlockers, fixture.detail.blockers);
  assert.deepEqual(calls.map((call) => call.path), ["/api/missions/mission", "/api/missions/mission/resume"]);
  assert.equal(scenario.evidence.humanActions.at(-1).error, "409 Resolve mission blockers before resuming");
});

test("mock forwards turn-limit hooks and resumes publication through the streaming protocol", async (t) => {
  const decisions = [];
  const server = await startMock({ ...context, credential: "unit", hooks: { handleRequest: async () => false, beforeReply: async (decision) => decisions.push(decision) }, record() {}, fail: (error) => assert.fail(error.message) });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer unit" }, body: JSON.stringify(request([["GetMissionState", state], selfCheck, ["GetMissionState", state]])) });
  assert.equal(response.status, 200);
  const events = (await response.text()).split("\n\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const tools = events.flatMap((event) => event.choices[0].delta.tool_calls ?? []);
  assert.equal(tools[0].function.name, "PublishArtifact");
  assert.equal(JSON.parse(tools.map((call) => call.function.arguments).join("")).taskId, "task");
  assert.equal(decisions.length, 1);
});


test("turn-limit shell synchronization waits for the last local admission before exiting", async (t) => {
  const scenario = createTurnLimitScenario();
  const server = await startMock({ ...context, credential: "gate-unit", hooks: scenario, record() {}, fail: (error) => assert.fail(error.message) });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const current = { mission: { status: "active", turns: 16 }, tasks: [{ status: "running" }], agents: [{ kind: "validator", status: "idle" }] };
  scenario.configure({ modelUrl: `http://127.0.0.1:${server.address().port}`, missionId: "mission", save() {}, api: async () => current,
    wait: async (predicate) => {
      let result = await predicate();
      if (!result) { current.mission.status = "blocked"; result = await predicate(); }
      assert.ok(result);
      return result;
    } });
  await scenario.beforeReply({ role: "worker", name: "GetMissionState" });
  let sent = false, finished = false;
  const send = scenario.beforeReply({ role: "orchestrator", name: "SendMessage" }).then(() => { sent = true; });
  assert.equal(sent, false, "Local response escaped before Linux self-check");
  const bash = { role: "worker", name: "bash", args: { command: "printf LINUX-SELF-CHECK-OK" } };
  await scenario.beforeReply(bash);
  const shell = promisify(execFile)("/bin/sh", ["-c", bash.args.command], { timeout: 5000 }).then((result) => { finished = true; return result; });
  await send;
  assert.equal(finished, false, "Linux bash escaped before the last admission");
  await scenario.beforeReply({ role: "orchestrator", name: "WaitForMessage" });
  assert.equal((await shell).stdout, "LINUX-SELF-CHECK-OK");
  assert.deepEqual(scenario.evidence.synchronization.map((entry) => entry.stage), ["linux-self-check-finished", "last-local-admission-held"]);
});
