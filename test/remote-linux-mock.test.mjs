import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { nextCall, startMock, transcript, shellQuote, pauseReport, pauseQuestion } from "../acceptance/remote-linux/mock.mjs";
import { parseOptions, assertPauseResume } from "../acceptance/remote-linux/run.mjs";
import { assertWorkerCrash, assessKill, crashResolution, crashSettlePolls, crashSnapshot, nextCrashAction, observeWorkerCrash, selectWorkerProcess, workerCrashTool, workerKillSource } from "../acceptance/remote-linux/scenarios/worker-crash.mjs";

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
  assert.equal(parseOptions(["--scenario", "worker-crash"]).scenario, "worker-crash");
  for (const args of [["--scenario"], ["--scenario", "unknown"], ["--scenario", "pause-resume", "--real", "config.json", "--secrets-file", "secrets"], ["--scenario", "worker-crash", "--real", "config.json", "--secrets-file", "secrets"]]) assert.throws(() => parseOptions(args));
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


test("worker-crash mock waits after the Linux self-check and does not publish or repeat effects", () => {
  const running = state();
  running.tasks[0].status = "running";
  const crashContext = { ...context, scenario: "worker-crash" };
  const selfCheck = { name: "bash", args: { command: "self-check" }, value: { status: "succeeded", result: { exitCode: 0 } } };
  assert.equal(workerCrashTool([]), null);
  assert.deepEqual(nextCall(request("worker", running, selfCheck), crashContext), { role: "worker", name: "WaitForMessage", args: {} });
  assert.equal(nextCall(request("worker", running, selfCheck), context).name, "PublishArtifact");
  assert.equal(nextCall(request("worker", running, selfCheck), { ...context, scenario: "pause-resume" }).name, "Report");
  assert.throws(() => nextCall(request("worker", running, { ...selfCheck, value: { status: "succeeded", result: { exitCode: 1 } } }), crashContext));
  const body = request("worker", running, selfCheck);
  const waitId = "crash-wait";
  body.messages.push({ role: "assistant", tool_calls: [{ id: waitId, function: { name: "WaitForMessage", arguments: "{}" } }] },
    { role: "tool", tool_call_id: waitId, content: "Waiting for the next durable input." });
  body.messages.push({ role: "user", content: "orchestrator follow-up" });
  assert.equal(nextCall(body, crashContext).name, "GetMissionState");
  const stateId = "crash-state";
  body.messages.push({ role: "assistant", tool_calls: [{ id: stateId, function: { name: "GetMissionState", arguments: "{}" } }] },
    { role: "tool", tool_call_id: stateId, content: JSON.stringify(running) });
  assert.deepEqual(nextCall(body, crashContext), { role: "worker", name: "WaitForMessage", args: {} });
  const orchestrator = request("orchestrator", running);
  assert.equal(nextCall(orchestrator, crashContext).name, "SendMessage");
});

function crashProcesses() {
  return [
    { pid: 1, ppid: 0, command: ["/usr/local/bin/node", "/app/bootstrap.mjs"], state: "S" },
    { pid: 10, ppid: 1, command: ["/usr/local/bin/node", "/app/dist/cli.js", "node", "--coordinator", "http://127.0.0.1:14311"], state: "S" },
    { pid: 20, ppid: 10, command: ["/usr/local/bin/node", "/app/dist/worker.js"], state: "S" },
    { pid: 21, ppid: 10, command: ["/bin/sh", "-c", "node -e self-check"], state: "S" },
    { pid: 30, ppid: 1, command: ["/usr/local/bin/node", "-e", "kill-script"], state: "R" }
  ];
}

test("worker kill selection targets only the supervisor's worker.js child", () => {
  const selected = selectWorkerProcess(crashProcesses(), 30);
  assert.equal(selected.ok, true);
  assert.equal(selected.pid, 20);
  assert.equal(selected.supervisorPid, 10);
  assert.deepEqual(selected.command, ["/usr/local/bin/node", "/app/dist/worker.js"]);
  assert.match(selected.basis, /worker\.js/);
  const missing = selectWorkerProcess(crashProcesses().filter((entry) => entry.pid !== 20), 30);
  assert.equal(missing.ok, false);
  const extra = crashProcesses();
  extra.push({ pid: 22, ppid: 10, command: ["/usr/local/bin/node", "/app/dist/worker.js"], state: "S" });
  assert.equal(selectWorkerProcess(extra, 30).ok, false);
  const orphan = crashProcesses();
  orphan[2].ppid = 1;
  assert.equal(selectWorkerProcess(orphan, 30).ok, false);
  assert.equal(selectWorkerProcess(crashProcesses(), 20).ok, false);
  const protectedPid = selectWorkerProcess([{ pid: 10, ppid: 1, command: ["/usr/local/bin/node", "/app/dist/cli.js", "node"], state: "S" }, { pid: 1, ppid: 0, command: ["/usr/local/bin/node", "/app/dist/worker.js"], state: "S" }], 99);
  assert.equal(protectedPid.ok, false);
  assert.equal(assessKill(selected, "Z", "S").ok, true);
  assert.equal(assessKill(selected, "gone", "S").supervisorAlive, true);
  assert.equal(assessKill(selected, "R", "S").ok, false);
  assert.equal(assessKill(selected, "Z", "Z").ok, false);
  const source = workerKillSource();
  new Function(source);
  assert.match(source, /SIGKILL/);
  assert.match(source, /\/worker\.js/);
  assert.doesNotMatch(source, /process\.kill\(-/);
  assert.match(source, /split\("\\0"\)/);
});

function crashedMission() {
  const runtime = { binding: { runtimeId: "rt-1", epoch: 2, agentId: "worker" }, state: "closed", stopProvenance: "unexpected" };
  const detail = {
    mission: { status: "failed" }, artifacts: [], tasks: [{ id: "task", status: "running" }],
    blockers: [{ id: "remote-runtime:rt-1", kind: "delivery", status: "resolved", text: "reconcile" }],
    messages: [{ id: "delivery", attempt: 1, status: "completed" }],
    events: [
      { type: "remote_effect_receipt", data: { effectId: "write" } },
      { type: "remote_effect_receipt", data: { effectId: "bash", receipt: { status: "succeeded", result: { stdout: "LINUX-SELF-CHECK-OK" } } } },
      { type: "worker_start_failed", data: { diagnostic: "Prior remote runtime rt-1: unexpected stop; trusted reconciliation is required" } }
    ]
  };
  const records = ["GetMissionState", "write_file", "bash", "WaitForMessage"].map((name) => ({ role: "worker", name }));
  const transport = { effects: [{ command_id: "write" }, { command_id: "bash" }], deliveries: [{ message_id: "delivery", attempt: 1, status: "completed" }] };
  const evidence = {
    humanActions: [{ action: "resolve", blockerId: "remote-runtime:rt-1" }, { action: "resume", status: 500 }],
    kill: { ok: true, signal: "SIGKILL", supervisorAlive: true, pid: 20, command: ["/usr/local/bin/node", "/app/dist/worker.js"], supervisorCommand: ["/usr/local/bin/node", "/app/dist/cli.js", "node"], basis: "cmdline ends with /worker.js, supervisor excluded" },
    snapshotBeforeResume: crashSnapshot(detail, records, transport)
  };
  return { runtime, detail, records, transport, evidence };
}

test("worker-crash evidence accepts only an unreplaced unexpected stop", () => {
  const ok = crashedMission();
  assert.equal(assertWorkerCrash(ok.detail, [ok.runtime], ok.evidence, ok.records, ok.transport).stopProvenance, "unexpected");
  for (const diagnostic of ["controlled stop cannot be proven from persisted evidence", "uncertain runtime report"]) {
    const changed = structuredClone(ok.detail);
    changed.events.at(-1).data.diagnostic = `Prior remote runtime rt-1: ${diagnostic}; trusted reconciliation is required`;
    assert.equal(assertWorkerCrash(changed, [{ ...ok.runtime, stopProvenance: diagnostic.startsWith("uncertain") ? "uncertain" : "unproven" }], ok.evidence, ok.records, ok.transport).diagnostic.includes(diagnostic), true);
  }
  const mutations = [
    (fixture) => { fixture.runtimes.push({ ...fixture.runtimes[0], binding: { ...fixture.runtimes[0].binding, runtimeId: "new" } }); },
    (fixture) => { fixture.runtimes[0].stopProvenance = "controlled"; },
    (fixture) => { fixture.detail.events.push({ type: "remote_runtime_reassigned", data: { runtimeId: "new" } }); },
    (fixture) => { fixture.detail.artifacts.push({ id: "artifact" }); },
    (fixture) => { fixture.detail.events.push({ type: "artifact_published" }); },
    (fixture) => { fixture.detail.events.push({ type: "delivery_resumed", data: { messageId: "delivery", attempt: 2 } }); },
    (fixture) => { fixture.detail.messages[0].attempt = 2; },
    (fixture) => { fixture.transport.effects.push(fixture.transport.effects[0]); },
    (fixture) => { fixture.records.push({ role: "worker", name: "write_file" }); },
    (fixture) => { fixture.detail.events.push(fixture.detail.events[0]); },
    (fixture) => { fixture.detail.events = fixture.detail.events.filter((event) => event.type !== "worker_start_failed"); },
    (fixture) => { fixture.detail.blockers = []; },
    (fixture) => { fixture.evidence.kill.supervisorAlive = false; },
    (fixture) => { fixture.evidence.humanActions = fixture.evidence.humanActions.filter((action) => action.action !== "resume"); }
  ];
  for (const mutate of mutations) {
    const fixture = crashedMission();
    const runtimes = [structuredClone(fixture.runtime)];
    const box = { detail: structuredClone(fixture.detail), records: structuredClone(fixture.records), transport: structuredClone(fixture.transport), evidence: structuredClone(fixture.evidence), runtimes };
    mutate(box);
    assert.throws(() => assertWorkerCrash(box.detail, box.runtimes, box.evidence, box.records, box.transport));
  }
});

test("worker-crash operator kills once, resolves every blocker, then resumes", async () => {
  const crash = { humanActions: [] };
  const detail = { mission: { status: "active" }, artifacts: [], events: [], blockers: [], messages: [{ id: "delivery", attempt: 1, status: "completed" }], tasks: [{ status: "running" }] };
  const records = ["GetMissionState", "write_file", "bash", "WaitForMessage"].map((name) => ({ role: "worker", name }));
  let runtimes = [];
  const posts = [];
  const execs = [];
  const observe = () => observeWorkerCrash({
    crash, current: detail, missionId: "mission-1", containerName: "mc-acc-l2-grok-test", records,
    api: async (path) => { assert.match(path, /\/runtimes$/); return runtimes; },
    post: async (path, body) => { posts.push({ path, body }); return { status: path.endsWith("/resume") ? 500 : 200, body: { error: "unexpected stop" } }; },
    exec: async (args) => {
      execs.push(args);
      return `${JSON.stringify({ ok: true, basis: "cmdline ends with /worker.js", pid: 20, command: ["/usr/local/bin/node", "/app/dist/worker.js"], supervisorPid: 10, supervisorCommand: ["/usr/local/bin/node", "/app/dist/cli.js", "node"], signal: "SIGKILL", gone: true, supervisorAlive: true, targetState: "Z", supervisorState: "S" })}\n`;
    },
    transport: () => ({ effects: [{ command_id: "write" }], deliveries: [{ message_id: "delivery", attempt: 1, status: "completed" }] }),
    save: () => undefined
  });
  assert.equal(await observe(), null);
  assert.equal(execs.length, 0);
  assert.equal(nextCrashAction(crash, detail, [], records).type, "wait");
  detail.events.push({ type: "remote_effect_receipt", data: { effectId: "bash", receipt: { status: "succeeded", result: { stdout: "/usr/local/bin/node\nLINUX-SELF-CHECK-OK\n" } } } });
  assert.equal(nextCrashAction(crash, detail, [], records).type, "wait");
  crash.settlePolls = crashSettlePolls;
  assert.equal(await observe(), null);
  assert.equal(crash.killed, true);
  assert.deepEqual(execs[0].slice(0, 3), ["exec", "mc-acc-l2-grok-test", "node"]);
  assert.equal(execs[0][3], "-e");
  assert.match(execs[0][4], /SIGKILL/);
  assert.equal(await observe(), null);
  runtimes = [{ binding: { runtimeId: "rt-1" }, state: "running", stopProvenance: "unproven" }];
  assert.equal(await observe(), null);
  assert.equal(posts.length, 0);
  runtimes = [{ binding: { runtimeId: "rt-1" }, state: "closed", stopProvenance: "unexpected", report: { outcome: "stopped" } }];
  detail.mission.status = "blocked";
  detail.blockers = [
    { id: "delivery:other", kind: "delivery", status: "open", text: "delivery needs reconciliation" },
    { id: "remote-runtime:rt-1", kind: "delivery", status: "open", text: "Remote runtime ownership or in-flight work requires trusted reconciliation before resuming." }
  ];
  assert.equal(await observe(), null);
  assert.equal(posts[0].path, "/api/blockers/remote-runtime:rt-1/resolve");
  assert.equal(posts[0].body.resolution, crashResolution);
  detail.blockers[1].status = "resolved";
  assert.equal(await observe(), null);
  assert.equal(posts[1].path, "/api/blockers/delivery:other/resolve");
  detail.blockers[0].status = "resolved";
  detail.mission.status = "paused";
  assert.equal(await observe(), null);
  assert.equal(posts[2].path, "/api/missions/mission-1/resume");
  assert.deepEqual(posts[2].body, {});
  assert.equal(crash.resumeAttempted, true);
  assert.equal(crash.snapshotBeforeResume.workerTools.filter((name) => name === "bash").length, 1);
  detail.mission.status = "failed";
  assert.equal(await observe(), detail);
  const refused = { humanActions: [], killed: true };
  const blocked = { mission: { status: "paused" }, artifacts: [], events: [], blockers: [{ id: "remote-runtime:rt-1", status: "resolved" }], messages: [], tasks: [] };
  let failed = false;
  assert.equal(await observeWorkerCrash({
    crash: refused, current: blocked, missionId: "mission-1", containerName: "c", records,
    api: async () => [{ binding: { runtimeId: "rt-1" }, state: "closed", stopProvenance: "unexpected" }],
    post: async () => { failed = true; return { status: 409, body: { error: "Prior remote runtime rt-1: unexpected stop; trusted reconciliation is required" } }; },
    exec: async () => { throw new Error("unexpected kill"); },
    transport: () => ({ effects: [], deliveries: [] }),
    save: () => undefined
  }), null);
  assert.equal(refused.resumeAttempted, true);
  assert.equal(failed, true);
  await assert.rejects(() => observeWorkerCrash({
    crash: { humanActions: [], killed: true, nodeExitedAfterKill: { exitCode: 1 } }, current: blocked, missionId: "mission-1", containerName: "c", records,
    api: async () => [{ binding: { runtimeId: "rt-1" }, state: "stopping", stopProvenance: "unproven" }],
    post: async () => { throw new Error("should not resume"); },
    exec: async () => { throw new Error("unexpected kill"); },
    transport: () => ({ effects: [], deliveries: [] }),
    save: () => undefined
  }), /Node supervisor exited/);
  blocked.mission.status = "failed";
  assert.equal(await observeWorkerCrash({
    crash: refused, current: blocked, missionId: "mission-1", containerName: "c", records,
    api: async () => [{ binding: { runtimeId: "rt-1" }, state: "closed", stopProvenance: "unexpected" }],
    post: async () => { throw new Error("resume twice"); },
    exec: async () => { throw new Error("unexpected kill"); },
    transport: () => ({ effects: [], deliveries: [] }),
    save: () => undefined
  }), blocked);
  const reassigned = structuredClone(detail);
  reassigned.mission.status = "active";
  reassigned.events.push({ type: "remote_runtime_reassigned" });
  await assert.rejects(() => observeWorkerCrash({
    crash: { humanActions: [], killed: true, resumeAttempted: true }, current: reassigned, missionId: "mission-1", containerName: "c", records, 
    api: async () => runtimes, post: async () => ({ status: 200, body: {} }), exec: async () => { throw new Error("unexpected kill"); },
    transport: () => ({ effects: [], deliveries: [] }), save: () => undefined
  }), /remote_runtime_reassigned/);
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
