import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { nextCall, startMock, transcript, shellQuote, pauseReport, pauseQuestion } from "../acceptance/remote-linux/mock.mjs";
import { parseOptions, assertPauseResume } from "../acceptance/remote-linux/run.mjs";

const context = { acceptanceCommand: "node --test /coordinator/accept.test.mjs", hostTestPath: "/coordinator/accept.test.mjs" };
function request(kind, state, last) {
  const names = kind === "orchestrator" ? ["SpawnAgent", "GetMissionState", "CreateTask", "UpdateTask", "SendMessage", "WaitForMessage", "CompleteMission", "RequestUserInput"]
    : kind === "worker" ? ["bash", "GetMissionState", "write_file", "PublishArtifact", "UpdateTask", "Report", "WaitForMessage"]
      : ["GetMissionState", "RunValidation", "ValidateTask", "Report", "WaitForMessage"];
  const body = { model: "mock", stream: true, tools: names.map((name) => ({ type: "function", function: { name } })), messages: [
    { role: "system", content: kind === "orchestrator" ? "You coordinate a persistent Mission" : "You are a persistent member of a Mission" },
    { role: "user", content: "start" }
  ] };
  const add = (name, value, args = {}) => {
    const id = `call-${body.messages.length}`;
    body.messages.push({ role: "assistant", tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: id, content: JSON.stringify(value) });
  };
  if (state) add("GetMissionState", state);
  if (last) add(last.name, last.value, last.args);
  return body;
}
const state = () => ({ mission: { acceptance: "host acceptance" }, roles: [{ roleId: "real-worker-role", kind: "worker" }, { roleId: "real-validator-role", kind: "validator" }],
  tasks: [{ id: "real-task", status: "review", ownerId: "real-worker", validatorId: "real-validator" }],
  agents: [{ id: "real-worker", kind: "worker" }, { id: "real-validator", kind: "validator" }],
  artifacts: [{ id: "real-artifact", taskId: "real-task" }], remoteWorkspaces: [{ id: "real-remote-workspace" }],
  executionEnvironment: { platform: "linux" }, validationContract: { assertions: [{ id: "real-assertion" }] } });

test("mock reads real IDs and enforces independent snapshot validation", () => {
  const body = request("validator", state());
  assert.deepEqual(nextCall(body, context), { role: "validator", name: "RunValidation", args: {
    taskId: "real-task", command: context.acceptanceCommand, artifactIds: ["real-artifact"]
  } });
  const receipt = { id: "real-receipt", exitCode: 0, snapshotIntegrity: true, workspaceKind: "remote-snapshot", stdout: "passed" };
  const decision = nextCall(request("validator", state(), { name: "RunValidation", value: receipt }), context);
  assert.equal(decision.args.receiptId, "real-receipt");
  assert.deepEqual(decision.args.assertionResults, [{ assertionId: "real-assertion", status: "passed", evidence: "passed" }]);
  assert.throws(() => nextCall(request("validator", state(), { name: "RunValidation", value: { ...receipt, exitCode: 1 } }), context));
  assert.throws(() => nextCall(request("validator", state(), { name: "RunValidation", value: { ...receipt, snapshotIntegrity: false } }), context));
  assert.throws(() => nextCall(request("validator", state(), { name: "RunValidation", value: { ...receipt, workspaceKind: "shared" } }), context));
});

test("mock waits for review and derives orchestrator role and remote assignment", () => {
  const beforeReview = state();
  beforeReview.tasks[0].status = "running";
  assert.equal(nextCall(request("validator", beforeReview), context).name, "WaitForMessage");
  const initial = state();
  initial.agents = [];
  assert.deepEqual(nextCall(request("orchestrator", initial), context).args, {
    title: "Acceptance worker", roleId: "real-worker-role", prompt: "Read GetMissionState. WaitForMessage until a task is assigned and ready for your role.", targetWorkspaceId: "real-remote-workspace"
  });
  const accepted = state();
  accepted.tasks[0].status = "accepted";
  assert.equal(nextCall(request("orchestrator", accepted), context).name, "CompleteMission");
});

test("mock rejects failed Linux commands and publishes using current task ID", () => {
  const running = state();
  running.tasks[0].status = "running";
  assert.throws(() => nextCall(request("worker", running, { name: "bash", args: { command: "self-check" }, value: { status: "succeeded", result: { exitCode: 1 } } }), context));
  const decision = nextCall(request("worker", running, { name: "bash", args: { command: "self-check" }, value: { status: "succeeded", result: { exitCode: 0 } } }), context);
  assert.equal(decision.name, "PublishArtifact");
  assert.equal(decision.args.taskId, "real-task");
  const mutation = nextCall(request("worker", running, { name: "PublishArtifact", value: { status: "succeeded", result: { id: "real-published-artifact" } } }), context);
  assert.equal(mutation.name, "bash");
  assert.match(mutation.args.command, /LIVE-SOURCE-CHANGED/);
  assert.throws(() => nextCall(request("worker", running, { name: "PublishArtifact", value: { status: "failed" } }), context));
  const body = request("worker", running);
  body.messages.push({ role: "assistant", tool_calls: [{ id: "wait-call", function: { name: "WaitForMessage", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "wait-call", content: "Waiting for the next durable input." });
  assert.equal(transcript(body).at(-1).value, "Waiting for the next durable input.");
  body.messages.push({ role: "user", content: "new durable wake" });
  assert.equal(nextCall(body, context).name, "GetMissionState");
  body.messages.push({ role: "tool", tool_call_id: "missing", content: "{}" });
  assert.throws(() => transcript(body), /no preceding call/);
});

test("mock serves split OpenAI SSE tool arguments and rejects wrong credentials", async (t) => {
  const records = [];
  const errors = [];
  const server = await startMock({ ...context, credential: "unit-credential", record: (record) => records.push(record), fail: (error) => errors.push(error) });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer unit-credential" }, body: JSON.stringify(request("validator", state())) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const events = (await response.text()).split("\n\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  const tools = events.flatMap((event) => event.choices[0].delta.tool_calls ?? []);
  assert.equal(tools[0].function.name, "RunValidation");
  assert.deepEqual(JSON.parse(tools.map((call) => call.function.arguments).join("")), { taskId: "real-task", command: context.acceptanceCommand, artifactIds: ["real-artifact"] });
  assert.equal(events.at(-1).choices[0].finish_reason, "tool_calls");
  assert.equal(records.length, 1);
  const rejected = await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong" }, body: "{}" });
  assert.equal(rejected.status, 500);
  assert.equal(errors.length, 1);
  assert.equal((await rejected.text()).includes("unit-credential"), false);
});

test("acceptance CLI validates timeouts and unknown options", () => {
  assert.deepEqual(parseOptions([]), { keep: false, timeoutMs: 180000 });
  assert.equal(parseOptions(["--keep", "--timeout-ms", "123"]).timeoutMs, 123);
  for (const args of [["--timeout-ms", "0"], ["--timeout-ms", "NaN"], ["--out"], ["--unknown"]]) assert.throws(() => parseOptions(args));
});

test("acceptance shell paths preserve quotes, spaces and shell metacharacters", () => {
  const paths = ["/tmp/host's tests/file.mjs", '/tmp/$HOME/`node`/file.mjs', "/tmp/a\nb/file.mjs"];
  for (const path of paths) {
    assert.equal(execFileSync("/bin/sh", ["-c", `printf '%s' ${shellQuote(path)}`], { encoding: "utf8" }), path);
  }
});


test("pause-resume mock reports the successful self-check and waits before publication", () => {
  const running = state();
  running.tasks[0].status = "running";
  const pauseContext = { ...context, scenario: "pause-resume" };
  const selfCheck = { name: "bash", args: { command: "self-check" }, value: { status: "succeeded", result: { exitCode: 0 } } };
  const report = nextCall(request("worker", running, selfCheck), pauseContext);
  assert.equal(report.name, "Report");
  assert.equal(report.args.summary, pauseReport);
  assert.throws(() => nextCall(request("worker", running, { ...selfCheck, value: { status: "succeeded", result: { exitCode: 1 } } }), pauseContext));
  const body = request("worker", running, selfCheck);
  const add = (name, args, value) => {
    const id = `pause-${body.messages.length}`;
    body.messages.push({ role: "assistant", tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: id, content: JSON.stringify(value) });
  };
  add("Report", report.args, { recorded: true });
  assert.equal(nextCall(body, pauseContext).name, "WaitForMessage");
  add("GetMissionState", {}, running);
  assert.equal(nextCall(body, pauseContext).name, "WaitForMessage");
  add("GetMissionState", {}, { ...running, blockers: [{ kind: "user_input", text: pauseQuestion, status: "open" }] });
  assert.equal(nextCall(body, pauseContext).name, "WaitForMessage");
  add("GetMissionState", {}, { ...running, blockers: [{ kind: "user_input", text: pauseQuestion + "\nResolution: continue", status: "resolved" }] });
  assert.deepEqual(nextCall(body, pauseContext), { role: "worker", name: "PublishArtifact", args: { name: "Frozen Linux delivery", path: "linux-delivery.json", taskId: "real-task" } });
});

test("pause-resume orchestrator asks once after the worker report and follows the human answer", () => {
  const running = state();
  running.tasks[0].status = "running";
  const body = request("orchestrator", running);
  body.messages[1].content = pauseReport;
  assert.equal(nextCall(body, context).name, "SendMessage", "Default scenario must not pause");
  const pauseContext = { ...context, scenario: "pause-resume" };
  assert.deepEqual(nextCall(body, pauseContext), { role: "orchestrator", name: "RequestUserInput", args: { question: pauseQuestion } });
  const afterQuestion = request("orchestrator", running, { name: "RequestUserInput", value: { id: "blocker" }, args: { question: pauseQuestion } });
  afterQuestion.messages[1].content = pauseReport;
  assert.equal(nextCall(afterQuestion, pauseContext).name, "WaitForMessage");
  running.blockers = [{ kind: "user_input", text: pauseQuestion + "\nResolution: continue", status: "resolved" }];
  const answered = request("orchestrator", running);
  answered.messages[1].content = pauseReport;
  assert.equal(nextCall(answered, pauseContext).name, "SendMessage");
  const beforeReport = request("orchestrator", { ...running, blockers: [] });
  assert.equal(nextCall(beforeReport, pauseContext).name, "SendMessage");
});

test("pause-resume CLI rejects unknown scenarios and real-model pauses", () => {
  assert.equal(parseOptions(["--scenario", "pause-resume"]).scenario, "pause-resume");
  assert.equal(parseOptions(["--scenario", "default"]).scenario, "default");
  for (const args of [["--scenario"], ["--scenario", "unknown"], ["--scenario", "pause-resume", "--real", "config.json", "--secrets-file", "secrets"]]) assert.throws(() => parseOptions(args));
});

test("pause-resume evidence rejects runtime, effect and delivery replay", () => {
  const old = { runtimeId: "old", epoch: 2, machineId: "linux", agentId: "worker" };
  const replacement = { ...old, runtimeId: "new", epoch: 4 };
  const stoppedRuntime = { binding: old, state: "closed", stopProvenance: "controlled", report: { outcome: "stopped" } };
  const methods = ["write_file", "bash", "PublishArtifact", "bash"];
  const effects = methods.map((method, i) => ({ command_id: `effect-${i}`, response: JSON.stringify({ effectPermit: { method, binding: i < 2 ? old : replacement } }) }));
  const detail = { mission: { status: "completed" }, messages: [{ id: "delivery", attempt: 1 }], events: [
    { type: "remote_runtime_reassigned", data: { previousRuntimeId: "old", runtimeId: "new" } },
    ...effects.map((row) => ({ type: "remote_effect_receipt", data: { effectId: row.command_id, receipt: { status: "succeeded" } } })),
    { type: "delivery_completed", data: { messageId: "delivery", attempt: 1 } }
  ] };
  const transport = { inbox: [], outbox: [], deliveries: [{ message_id: "delivery", attempt: 1 }], effects };
  const evidence = { stoppedRuntime, humanActions: [{ action: "answer" }], transportBeforeAnswer: { inbox: [], outbox: [], effects: effects.slice(0, 2) } };
  const records = methods.map((name) => ({ role: "worker", name }));
  assert.equal(assertPauseResume(detail, [stoppedRuntime, { binding: replacement }], evidence, records, transport).effectReceipts, 4);
  const mutations = [
    (d) => d.events.push(d.events.at(-1)),
    (d) => d.events[2].data.effectId = d.events[1].data.effectId,
    (d) => d.events[1].data.receipt.status = "uncertain",
    (d) => d.messages[0].attempt = 2,
    (d) => d.events.push({ type: "worker_start_failed" }),
    (d) => d.mission.status = "failed"
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(detail);
    mutate(changed);
    assert.throws(() => assertPauseResume(changed, [stoppedRuntime, { binding: replacement }], evidence, records, transport));
  }
  assert.throws(() => assertPauseResume(detail, [stoppedRuntime, { binding: { ...replacement, epoch: 2 } }], evidence, records, transport));
  assert.throws(() => assertPauseResume(detail, [stoppedRuntime, { binding: { ...replacement, machineId: "other" } }], evidence, records, transport));
  const wrongPublication = structuredClone(transport);
  wrongPublication.effects[2].response = JSON.stringify({ effectPermit: { method: "PublishArtifact", binding: old } });
  assert.throws(() => assertPauseResume(detail, [stoppedRuntime, { binding: replacement }], evidence, records, wrongPublication));
  assert.throws(() => assertPauseResume(detail, [stoppedRuntime, { binding: replacement }], evidence, [...records, records[0]], transport));
  assert.throws(() => assertPauseResume(detail, [stoppedRuntime, { binding: replacement }], evidence, records, { ...transport, deliveries: [...transport.deliveries, transport.deliveries[0]] }));
  assert.throws(() => assertPauseResume(detail, [stoppedRuntime, { binding: replacement }], evidence, records, { ...transport, outbox: [{ runtime_id: "old" }] }));
});


test("mock server forwards the pause-resume scenario into tool decisions", async (t) => {
  const records = [];
  const server = await startMock({ ...context, scenario: "pause-resume", credential: "pause-credential", record: (record) => records.push(record), fail: (error) => assert.fail(error.message) });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const running = state();
  running.tasks[0].status = "running";
  const body = request("orchestrator", running);
  body.messages[1].content = pauseReport;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer pause-credential" }, body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(records.map(({ role, name, args }) => ({ role, name, args })), [{ role: "orchestrator", name: "RequestUserInput", args: { question: pauseQuestion } }]);
});
