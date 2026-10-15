import assert from "node:assert/strict";
import { test } from "node:test";
import { nextCall, startMock } from "../acceptance/remote-linux/mock.mjs";
import { parseOptions } from "../acceptance/remote-linux/run.mjs";
import { assertCompletedRestart, assertInterruptedRestart, assertIrrecoverableRestart, assertNoRestartReplay, coordinatorRestartCall,
  createCoordinatorRestartScenario, restartScenarios } from "../acceptance/remote-linux/scenarios/coordinator-restart.mjs";

function fixture(completed = false) {
  const binding = { runtimeId: "runtime", machineId: "linux", sessionId: "session", sessionEpoch: 1, agentId: "worker", epoch: 2 };
  const names = completed ? ["GetMissionState", "write_file", "bash", "PublishArtifact", "bash", "UpdateTask", "Report"] : ["GetMissionState", "write_file", "bash", "WaitForMessage"];
  const records = names.map((name) => ({ role: "worker", name, args: {} }));
  const effects = Array.from({ length: completed ? 4 : 2 }, (_, index) => ({ command_id: `effect-${index}`, response: "persisted permit" }));
  const detail = { mission: { id: "mission", status: completed ? "completed" : "blocked", orchestratorId: "orchestrator" },
    tasks: [{ id: "task", status: completed ? "accepted" : "running" }], artifacts: completed ? [{ id: "artifact" }] : [],
    validationReceipts: completed ? [{ id: "receipt", stdout: "passed\n", exitCode: 0 }] : [],
    messages: [{ id: "message", attempt: 1, status: "completed" }], blockers: completed ? [] : [{ id: "runtime-blocker", kind: "delivery", text: "uncertain runtime", status: "open" }],
    events: effects.map((_, index) => ({ seq: index, type: "remote_effect_receipt", data: { effectId: `effect-${index}`, receipt: { status: "succeeded", result: { stdout: index === 1 ? "LINUX-SELF-CHECK-OK" : "", exitCode: 0 } } } })) };
  return { detail, runtimes: [{ binding, state: "closed", desired: "stop", stopProvenance: "controlled" }], records, mockRequests: names.length,
    download: completed ? { sha256: "frozen-sha256", contentDisposition: 'attachment; filename="linux-delivery.json"' } : undefined,
    bindings: [{ runtime_id: "runtime", status: "uncertain" }], transport: { effects, inbox: [], outbox: [], deliveries: [{ message_id: "message", attempt: 1, status: "completed" }] } };
}

function workerRequest(results) {
  const body = { tools: ["GetMissionState", "bash", "write_file", "WaitForMessage", "PublishArtifact"].map((name) => ({ function: { name } })),
    messages: [{ role: "system", content: "You are a persistent member of a Mission" }] };
  for (const [name, value, args = {}] of results) {
    const id = `call-${body.messages.length}`;
    body.messages.push({ role: "assistant", tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: id, content: name === "WaitForMessage" ? "Waiting for the next durable input." : JSON.stringify(value) });
  }
  return body;
}
const state = { mission: {}, roles: [], agents: [{ id: "worker", kind: "worker" }], tasks: [{ id: "task", ownerId: "worker", status: "running" }], executionEnvironment: { platform: "linux" } };
const check = ["bash", { status: "succeeded", result: { exitCode: 0 } }, { command: "self-check" }];
const context = { acceptanceCommand: "node --test /host/test.mjs", hostTestPath: "/host/test.mjs" };

test("restart scenarios parse only in mock mode and leave default options intact", () => {
  assert.deepEqual(parseOptions([]), { keep: false, timeoutMs: 180000 });
  for (const scenario of restartScenarios) {
    assert.equal(parseOptions(["--scenario", scenario]).scenario, scenario);
    assert.throws(() => parseOptions(["--scenario", scenario, "--real", "config", "--secrets-file", "unused"]), /mock mode/);
  }
  assert.equal(createCoordinatorRestartScenario("default"), undefined);
});

test("restart mock waits after Linux self-check and publishes from preserved history only after release", () => {
  const body = workerRequest([["GetMissionState", state], check]);
  for (const scenario of ["coordinator-restart", "coordinator-restart-kill"]) {
    assert.deepEqual(nextCall(body, { ...context, scenario }), { role: "worker", name: "WaitForMessage", args: {} });
    assert.equal(nextCall(workerRequest([["GetMissionState", state]]), { ...context, scenario }).name, "write_file");
    const resumed = workerRequest([["GetMissionState", state], check, ["WaitForMessage"], ["GetMissionState", state]]);
    assert.deepEqual(nextCall(resumed, { ...context, scenario, hooks: { released: true } }), { role: "worker", name: "PublishArtifact", args: { name: "Frozen Linux delivery", path: "linux-delivery.json", taskId: "task" } });
    assert.throws(() => nextCall(workerRequest([["GetMissionState", state], ["bash", { status: "succeeded", result: { exitCode: 1 } }]]), { ...context, scenario }), /self-check failed/);
  }
  assert.equal(nextCall(body, { ...context, scenario: "restart-after-complete" }).name, "PublishArtifact");
  assert.equal(coordinatorRestartCall({ role: "validator" }), undefined);
});

test("completed restart requires identical receipts, download, bindings, transport and zero model requests", () => {
  const before = fixture(true);
  assert.equal(assertCompletedRestart(before, structuredClone(before)).taskStatus, "accepted");
  const changes = [
    (after) => { after.detail.mission.status = "active"; },
    (after) => { after.detail.mission.orchestratorId = "replacement"; },
    (after) => { after.detail.tasks[0].status = "review"; },
    (after) => { after.detail.validationReceipts[0].stdout += "changed"; },
    (after) => { after.download.sha256 = "changed"; },
    (after) => { after.download.contentDisposition = "changed"; },
    (after) => { after.detail.blockers.push({ status: "open" }); },
    (after) => { after.runtimes[0].state = "running"; },
    (after) => { after.runtimes[0].stopProvenance = "unproven"; },
    (after) => { after.runtimes.push({ ...after.runtimes[0], binding: { runtimeId: "new" } }); },
    (after) => { after.detail.events.push({ type: "remote_runtime_reassigned" }); },
    (after) => { after.mockRequests++; },
    (after) => { after.bindings[0].status = "open"; },
    (after) => { after.transport.outbox.push({ status: "queued" }); }
  ];
  for (const change of changes) {
    const after = structuredClone(before);
    change(after);
    assert.throws(() => assertCompletedRestart(before, after));
  }
});

test("restart safety checks reject effect, delivery and tool replay and silent runtime allocation", () => {
  const before = fixture();
  assertNoRestartReplay(before);
  assertInterruptedRestart(before, before);
  for (const change of [
    (after) => { after.records.push({ role: "worker", name: "write_file" }); },
    (after) => { after.records.push({ role: "worker", name: "bash" }); },
    (after) => { after.records.push({ role: "worker", name: "PublishArtifact" }); },
    (after) => { after.detail.events.push(after.detail.events[0]); },
    (after) => { after.detail.messages[0].attempt = 2; },
    (after) => { after.detail.events.push({ type: "delivery_resumed" }); },
    (after) => { after.transport.effects.push(after.transport.effects[0]); },
    (after) => { after.transport.deliveries.push(after.transport.deliveries[0]); },
    (after) => { after.runtimes.push(after.runtimes[0]); },
    (after) => { after.detail.mission.status = "active"; after.detail.blockers = []; }
  ]) {
    const after = structuredClone(before);
    change(after);
    assert.throws(() => assertInterruptedRestart(before, after));
  }
});

test("irrecoverable recovery requires failed status, recoverable false, reason and an actual operator resume", () => {
  const before = fixture();
  const after = structuredClone(before);
  after.detail.mission.status = "failed";
  after.detail.events.push({ type: "worker_start_failed", data: { recoverable: false, reason: "remote_runtime_ownership_uncertain", diagnostic: "Prior runtime ownership cannot be proven" } });
  const evidence = { humanActions: [{ action: "resolve", status: 200 }, { action: "resume", status: 409 }] };
  assert.equal(assertIrrecoverableRestart(before, after, evidence).outcome, "irrecoverable");
  for (const change of [
    (value) => { value.detail.mission.status = "paused"; },
    (value) => { value.detail.events.at(-1).data.recoverable = true; },
    (value) => { delete value.detail.events.at(-1).data.reason; },
    (value) => { value.detail.events.at(-1).data.diagnostic = ""; }
  ]) {
    const broken = structuredClone(after);
    change(broken);
    assert.throws(() => assertIrrecoverableRestart(before, broken, evidence));
  }
  assert.throws(() => assertIrrecoverableRestart(before, after, { humanActions: [] }));
});

test("completion scenario executes confirmed graceful restart then crash restart with separate snapshots", async () => {
  const snapshot = fixture(true);
  const scenario = createCoordinatorRestartScenario("restart-after-complete");
  const signals = [];
  scenario.configure({ snapshot: async () => structuredClone(snapshot), save() {}, restart: async (signal) => signals.push(signal) });
  await scenario.afterComplete();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(scenario.evidence.snapshots.map(({ label }) => label), ["before-restart", "after-SIGTERM", "after-SIGKILL"]);
});

test("restart records operator reconciliation and accepts irrecoverable only for SIGKILL", async () => {
  for (const name of ["coordinator-restart", "coordinator-restart-kill"]) {
    const value = fixture();
    value.detail.blockers.push({ id: "delivery-blocker", kind: "delivery", text: "uncertain delivery", status: "open" });
    const scenario = createCoordinatorRestartScenario(name);
    const signals = [], calls = [];
    scenario.configure({ missionId: "mission", records: value.records, save() {}, snapshot: async () => structuredClone(value),
      restart: async (signal, evidence) => { signals.push(signal); evidence.restarts.push({ signal }); },
      inspectWorkspace: async () => ({ platform: "linux", answer: 42, version: 1 }), wait: async (predicate) => { const result = await predicate(); assert.ok(result); return result; },
      request: async (path, body) => {
        calls.push({ path, body });
        if (path.endsWith("/export")) return { status: 200, body: structuredClone(value.detail) };
        if (path.endsWith("/resolve")) {
          value.detail.blockers.find((blocker) => path.includes(blocker.id)).status = "resolved";
          return { status: 200, body: { resolved: true } };
        }
        value.detail.mission.status = "failed";
        value.detail.events.push({ type: "worker_start_failed", data: { recoverable: false, reason: "remote_runtime_unproven", diagnostic: "controlled stop cannot be proven" } });
        return { status: 409, body: { error: "controlled stop cannot be proven" } };
      } });
    for (let count = 0; count < 4; count++) assert.equal(await scenario.observe(value.detail), false);
    if (name === "coordinator-restart") {
      await assert.rejects(scenario.observe(value.detail), /Confirmed graceful stop must allow explicit resume/);
      assert.equal(scenario.evidence.assertions, undefined);
    } else {
      const result = await scenario.observe(value.detail);
      assert.equal(result.mission.status, "failed");
      assert.equal(scenario.evidence.assertions.outcome, "irrecoverable");
    }
    assert.deepEqual(signals, [name.endsWith("kill") ? "SIGKILL" : "SIGTERM"]);
    assert.deepEqual(calls.map(({ path }) => path), ["/api/missions/mission/export", "/api/blockers/runtime-blocker/resolve", "/api/blockers/delivery-blocker/resolve", "/api/missions/mission/resume"]);
    assert.equal(scenario.evidence.humanActions.at(-1).status, 409);
  }
});

test("mock request counter records each streaming request across restart without changing default behavior", async (t) => {
  const scenario = createCoordinatorRestartScenario("restart-after-complete");
  const errors = [];
  const server = await startMock({ ...context, scenario: "restart-after-complete", hooks: scenario, credential: "unit", record() {}, fail: (error) => errors.push(error) });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer unit" }, body: JSON.stringify({ ...workerRequest([["GetMissionState", state], check]), stream: true, model: "mock" }) });
  assert.equal(response.status, 200, errors.map((error) => error.message).join("; "));
  assert.match(await response.text(), /PublishArtifact/);
  assert.equal(scenario.mockRequests, 1);
  assert.deepEqual(errors, []);
});

test("running restart rejects a paused dead end after resume and preserves its HTTP result", async (t) => {
  const value = fixture();
  const scenario = createCoordinatorRestartScenario("coordinator-restart");
  scenario.configure({ missionId: "mission", records: value.records, save() {}, snapshot: async () => structuredClone(value),
    restart: async (signal, evidence) => evidence.restarts.push({ signal }), inspectWorkspace: async () => ({ platform: "linux", answer: 42, version: 1 }),
    request: async (path) => {
      if (path.endsWith("/export")) return { status: 200, body: { format: "mission-control-replay-v1" } };
      if (path.endsWith("/resolve")) { value.detail.blockers[0].status = "resolved"; value.detail.mission.status = "paused"; return { status: 200, body: {} }; }
      return { status: 409, body: { error: "Resume unavailable without an explanation" } };
    },
    wait: async (predicate) => {
      const clock = Date.now() + 11000;
      t.mock.method(Date, "now", () => clock);
      return predicate();
    } });
  for (let index = 0; index < 4; index++) assert.equal(await scenario.observe(value.detail), false);
  await assert.rejects(scenario.observe(value.detail), /Recovery dead end: resume HTTP 409, Mission paused/);
  assert.equal(scenario.evidence.humanActions.at(-1).status, 409);
  assert.equal(scenario.evidence.humanActions.at(-1).response.error, "Resume unavailable without an explanation");
  assert.equal(scenario.evidence.snapshots.at(-1).label, "recovery-dead-end");
  assert.equal(scenario.summary().humanActions[0].response.format, "mission-control-replay-v1");
});

test("local restart waits for idle agents and unchanged transport before signalling", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const snapshot = fixture(); snapshot.detail.agents = [{ status: "running" }];
  const scenario = createCoordinatorRestartScenario("coordinator-restart", { quiescenceMs: 1000 });
  scenario.evidence.settlePolls = 4;
  scenario.configure({ records: snapshot.records, snapshot: async () => snapshot, save() {},
    restart: async () => { throw new Error("ready-to-restart"); } });
  assert.equal(await scenario.observe(snapshot.detail), false);
  now += 2000;
  assert.equal(await scenario.observe(snapshot.detail), false, "A busy agent cannot satisfy the quiet interval");
  snapshot.detail.agents[0].status = "idle";
  assert.equal(await scenario.observe(snapshot.detail), false);
  now += 800;
  assert.equal(await scenario.observe(snapshot.detail), false);
  snapshot.transport.outbox.push({ status: "acknowledged" });
  assert.equal(await scenario.observe(snapshot.detail), false, "Transport change restarts the quiet interval");
  now += 1001;
  await assert.rejects(scenario.observe(snapshot.detail), /ready-to-restart/);
});
