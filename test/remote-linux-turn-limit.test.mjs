import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nextCall, startMock } from "../acceptance/remote-linux/mock.mjs";
import { parseOptions } from "../acceptance/remote-linux/run.mjs";
import { turnLimitMaxTurns, findLimitRpc, createTurnLimitScenario, reconcileDelivery, assertInterruptedDeliveries } from "../acceptance/remote-linux/scenarios/turn-limit.mjs";

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

test("turn-limit worker waits after handing off review instead of publishing again", () => {
  const review = { ...state, tasks: [{ ...state.tasks[0], status: "review" }] };
  const body = request([["GetMissionState", state], selfCheck, ["PublishArtifact", { status: "succeeded", result: { id: "artifact" } }], ["GetMissionState", review]]);
  assert.deepEqual(nextCall(body, context), { role: "worker", name: "WaitForMessage", args: {} });
  assert.equal(nextCall(request([["GetMissionState", state], selfCheck, ["PublishArtifact", { status: "succeeded", result: { id: "artifact" } }], ["GetMissionState", review]]), { ...context, scenario: "default" }).name, "WaitForMessage");
});

function evidenceFixture() {
  const binding = { runtimeId: "runtime", machineId: "linux", sessionId: "session", sessionEpoch: 1, agentId: "worker", epoch: 2 };
  const detail = { mission: { status: "blocked", turns: 16, maxTurns: 16, orchestratorId: "orchestrator" }, agents: [{ id: "orchestrator", status: "idle" }, { id: "worker", status: "offline" }], messages: [], events: [{ seq: 2, type: "turn_admission_denied", text: "Mission turn limit exhausted", agentId: "worker", data: { generationId: "denied", turns: 16, maxTurns: 16 } },
    { seq: 1, type: "remote_effect_receipt", agentId: "worker", data: { receipt: { status: "succeeded", result: { exitCode: 0, stdout: "LINUX-SELF-CHECK-OK" } } } }, { seq: 0, type: "remote_effect_receipt", agentId: "worker", data: { receipt: { status: "succeeded", result: { bytes: 45 } } } }], artifacts: [], blockers: [{ id: "limit", kind: "limit", status: "open" }] };
  const envelope = { binding, payload: { kind: "rpc", method: "AdmitTurn", rpcId: "rpc", args: { generationId: "denied" } } };
  const transport = { deliveries: [], inbox: [{ message_id: "inbox", runtime_id: "runtime", status: "applied", envelope_json: JSON.stringify(envelope) }],
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
      if (path.endsWith("/resolve")) {
        const blocker = current.blockers.find((item) => item.id === path.split("/").at(-2));
        blocker.status = "resolved";
        if (current.blockers.every((item) => item.status === "resolved")) current.mission.status = "paused";
        return structuredClone(blocker);
      }
      if (path.endsWith("/resume")) {
        if (rejectResume) throw new Error("409 Resolve mission blockers before resuming");
        current.mission.status = "active";
      }
      return structuredClone(current);
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
    { path: "/api/blockers/limit/resolve", body: { resolution: "已核对 Mission 使用 16 轮，上限已提高到 96，剩余预算足够继续。" }, method: "POST" },
    { path: "/api/missions/mission/resume", body: {}, method: "POST" }
  ]);
  assert.deepEqual(scenario.evidence.humanActions.map((entry) => entry.action), ["raise-maxTurns", "resolve-blocker", "resume"]);
  assert.ok(scenario.evidence.humanActions.every((entry) => entry.completedAt));
  assert.equal(scenario.evidence.limitRpc.inbox.status, "applied");
});

function interruptedFixture() {
  const fixture = evidenceFixture();
  fixture.detail.blockers = [{ id: "delivery:old-outbox", kind: "delivery", status: "open", text: "uncertain delivery" }];
  fixture.detail.messages = [{ id: "old-message", recipientId: "worker", attempt: 1, status: "uncertain", error: "Delivery state is uncertain after interrupt" }];
  fixture.transport.deliveries = [{ id: "old-outbox", message_id: "old-message", attempt: 1, status: "uncertain" }];
  return fixture;
}

test("turn-limit reconciles each delivery blocker and retains the full resume rejection", async () => {
  const fixture = interruptedFixture();
  const { context, calls } = recoveryContext(fixture, true);
  const scenario = createTurnLimitScenario();
  scenario.configure(context);
  await assert.rejects(scenario.recover(fixture.detail), /409 Resolve mission blockers before resuming/);
  assert.deepEqual(scenario.evidence.limitBlockers, []);
  assert.deepEqual(scenario.evidence.otherBlockers, fixture.detail.blockers);
  assert.deepEqual(calls.map((call) => call.path), ["/api/missions/mission", "/api/blockers/delivery:old-outbox/resolve", "/api/missions/mission/resume"]);
  assert.equal(calls[1].body.resolution, "已只读核对协调端投递 old-message 的 attempt 1、远端受控停止回报及写入和 Linux 自查成功回执；尚未发布，确认该投递不需要重放，后续工作由新输入继续。");
  assert.equal(scenario.evidence.humanActions.at(-1).error, "409 Resolve mission blockers before resuming");
  assert.equal(scenario.evidence.recoveryRejection.action, "resume");
});

test("turn-limit resolves multiple open blockers individually without changing interrupted deliveries", async () => {
  const fixture = interruptedFixture();
  fixture.detail.blockers.push({ id: "delivery:second-outbox", kind: "delivery", status: "open" }, { id: "limit", kind: "limit", status: "open" });
  fixture.detail.messages.push({ id: "second-message", recipientId: "orchestrator", attempt: 1, status: "uncertain" });
  fixture.transport.deliveries.push({ id: "second-outbox", message_id: "second-message", attempt: 1, status: "uncertain" });
  const { context, calls } = recoveryContext(fixture);
  const scenario = createTurnLimitScenario();
  scenario.configure(context);
  await scenario.recover(fixture.detail);
  assert.deepEqual(calls.map((call) => call.path), ["/api/missions/mission", "/api/blockers/delivery:old-outbox/resolve", "/api/blockers/delivery:second-outbox/resolve", "/api/blockers/limit/resolve", "/api/missions/mission/resume"]);
  assert.equal(scenario.evidence.deliveryReconciliations.length, 2);
  assertInterruptedDeliveries(fixture.detail, fixture.transport, scenario.evidence);
  for (const changed of [{ ...fixture.transport.deliveries[0], status: "queued" }, { ...fixture.transport.deliveries[0], attempt: 2 }]) {
    assert.throws(() => assertInterruptedDeliveries(fixture.detail, { ...fixture.transport, deliveries: [changed, fixture.transport.deliveries[1]] }, scenario.evidence), /outbox attempt changed/);
  }
  assert.throws(() => assertInterruptedDeliveries({ ...fixture.detail, messages: [{ ...fixture.detail.messages[0], attempt: 2 }, fixture.detail.messages[1]] }, fixture.transport, scenario.evidence), /message changed/);
});

test("turn-limit refuses an unproven reconciliation rather than inventing a conclusion", () => {
  const fixture = interruptedFixture();
  const reconcile = (detail = fixture.detail, transport = fixture.transport, stopped = fixture.stopped) => reconcileDelivery(fixture.detail.blockers[0], detail, transport, stopped);
  assert.throws(() => reconcile(undefined, { ...fixture.transport, deliveries: [] }), /matching persisted outbox/);
  assert.throws(() => reconcile(undefined, undefined, { ...fixture.stopped, stopProvenance: "unproven" }));
  const unknown = structuredClone(fixture.detail);
  unknown.events[1].data.receipt.status = "uncertain";
  assert.throws(() => reconcile(unknown), /unknown result/);
  assert.throws(() => reconcileDelivery({ kind: "unsafe_execution" }, fixture.detail, fixture.transport, fixture.stopped), /unrelated blocker/);
});

test("turn-limit sends one ordinary orchestrator message only after restored team is idle", async () => {
  const fixture = interruptedFixture();
  const { context } = recoveryContext(fixture);
  let clock = 0;
  const sent = [];
  const originalApi = context.api;
  context.now = () => clock;
  context.api = async (path, body, method) => {
    if (path.endsWith("/messages")) { sent.push({ path, body, method }); return { id: "operator-message" }; }
    return originalApi(path, body, method);
  };
  const scenario = createTurnLimitScenario();
  scenario.configure(context);
  await scenario.recover(fixture.detail);
  const idle = { ...fixture.detail, mission: { ...fixture.detail.mission, status: "active" }, blockers: [] };
  await scenario.observe({ ...idle, agents: [{ status: "running" }] });
  clock = 5000;
  await scenario.observe({ ...idle, messages: [{ status: "queued" }] });
  assert.equal(sent.length, 0);
  await scenario.observe(idle);
  clock = 6999;
  await scenario.observe(idle);
  assert.equal(sent.length, 0);
  clock = 7000;
  await scenario.observe(idle);
  assert.deepEqual(sent, [{ path: "/api/missions/mission/messages", method: "POST", body: { recipientId: "orchestrator", content: "继续完成剩余工作。已核对被打断的投递，不需要重放；请读取当前状态并继续。", mode: "followUp", requestId: "turn-limit-continue:mission" } }]);
  await scenario.observe(idle);
  clock = 17000;
  await assert.rejects(scenario.observe(idle), /Mission stalled after the operator message/);
  assert.equal(sent.length, 1);
  assert.deepEqual(scenario.evidence.stallSnapshot, idle);
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
