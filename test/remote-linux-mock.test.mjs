import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { nextCall, startMock, transcript, shellQuote } from "../acceptance/remote-linux/mock.mjs";
import { parseOptions } from "../acceptance/remote-linux/run.mjs";

const context = { acceptanceCommand: "node --test /coordinator/accept.test.mjs", hostTestPath: "/coordinator/accept.test.mjs" };
function request(kind, state, last) {
  const names = kind === "orchestrator" ? ["SpawnAgent", "GetMissionState", "CreateTask", "UpdateTask", "SendMessage", "WaitForMessage", "CompleteMission"]
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
