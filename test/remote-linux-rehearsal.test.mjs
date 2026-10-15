import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRuntimeProvider } from "../dist/worker.js";
import { parseOptions } from "../acceptance/remote-linux/run.mjs";
import { acceptanceCommandMatch, frozenAcceptanceCommand, assertRealOutcome, readConfig, scanEvidence } from "../acceptance/remote-linux/real.mjs";
import { encodeReply, normalizeMessages, rehearsalCall, rehearsalConfig, rehearsalSecrets, startFakeProvider, totalsSource, validateRequest } from "../acceptance/remote-linux/fake-provider.mjs";

const config = () => readConfig(new URL("../acceptance/remote-linux/real-minimax.json", import.meta.url));
const secret = "unit-only-rehearsal-key";
const temporary = (t) => { const path = mkdtempSync(join(tmpdir(), "mc-rehearsal-")); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
const close = async (server) => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };

test("rehearsal CLI retains real defaults and refuses supplied secrets or mock mode", () => {
  assert.equal(parseOptions(["--real", "config.json", "--rehearsal"]).timeoutMs, 1800000);
  assert.equal(parseOptions(["--real", "config.json", "--rehearsal", "--timeout-ms", "500"]).timeoutMs, 500);
  for (const args of [["--rehearsal"], ["--real", "config.json", "--rehearsal", "--secrets-file", "unread.env"], ["--real", "config.json", "--rehearsal", "--scenario", "pause-resume"]]) assert.throws(() => parseOptions(args));
});

test("rehearsal rewrites only endpoints and generates private credentials through readSecrets", (t) => {
  const original = config(), proof = temporary(t);
  const rewritten = rehearsalConfig(original, 1234, 5678);
  for (const kind of Object.keys(original)) {
    const { baseUrl, ...rest } = rewritten[kind];
    assert.deepEqual(rest, Object.fromEntries(Object.entries(original[kind]).filter(([key]) => key !== "baseUrl")));
    assert.equal(baseUrl, `http://${kind === "worker" ? "192.168.64.1:5678" : "127.0.0.1:1234"}/${kind}`);
  }
  const generated = rehearsalSecrets(proof, original);
  assert.equal(statSync(generated.path).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(generated.credentials), ["MINIMAX_CN"]);
  assert.match(generated.credentials.MINIMAX_CN, /^rehearsal-/);
  assert.ok(readFileSync(generated.path, "utf8").includes(generated.credentials.MINIMAX_CN));
  assert.throws(() => scanEvidence(proof, Object.values(generated.credentials)), /Credential found/);
  rmSync(generated.path);
  writeFileSync(join(proof, "evidence.json"), JSON.stringify(rewritten));
  assert.doesNotThrow(() => scanEvidence(proof, Object.values(generated.credentials)));
  const unsupported = config(); unsupported.worker.api = "openai-responses";
  assert.throws(() => rehearsalConfig(unsupported, 1, 2), /supports/);
});

for (const api of ["anthropic-messages", "openai-completions"]) {
  test(`${api} SSE decodes with product provider including split JSON and usage`, async (t) => {
    const decision = { name: "probe", args: { text: "quoted '\" 中文", nested: { value: 42 } } };
    const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(encodeReply(api, "unit-model", decision)); });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => close(server));
    const models = createModels({ authContext: { env: async () => secret, fileExists: async () => false } });
    const provider = createRuntimeProvider({ ...config().worker, id: "unit", revision: 0, api, modelId: "unit-model", reasoning: false, baseUrl: `http://127.0.0.1:${server.address().port}` });
    models.setProvider(provider);
    const message = await models.completeSimple(provider.getModels()[0], { systemPrompt: "Call probe", messages: [{ role: "user", content: "probe", timestamp: Date.now() }],
      tools: [{ name: "probe", description: "Probe", parameters: Type.Object({ text: Type.String(), nested: Type.Object({ value: Type.Number() }) }) }] }, { maxTokens: 500, maxRetries: 0 });
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    assert.equal(message.content[0].name, decision.name);
    assert.deepEqual(message.content[0].arguments, decision.args);
    assert.equal(message.usage.input, 100);
    assert.equal(message.usage.output, 20);
    assert.equal(message.usage.totalTokens, 120);
  });

  test(`${api} request validation rejects model, auth, method, path and stream without echoing credentials`, () => {
    const profile = { ...config().worker, api }, role = "worker";
    const request = { method: "POST", url: `/worker/${api === "anthropic-messages" ? "v1/messages" : "chat/completions"}`, headers: api === "anthropic-messages" ? { "x-api-key": secret } : { authorization: `Bearer ${secret}` } };
    const body = { model: profile.modelId, stream: true };
    assert.doesNotThrow(() => validateRequest(request, body, profile, secret, role));
    if (api === "anthropic-messages") assert.doesNotThrow(() => validateRequest({ ...request, url: request.url + "?beta=true" }, body, profile, secret, role));
    for (const [r, b] of [[{ ...request, headers: {} }, body], [{ ...request, method: "GET" }, body], [{ ...request, url: "/wrong" }, body], [request, { ...body, model: secret }], [request, { ...body, stream: false }]]) {
      assert.throws(() => validateRequest(r, b, profile, secret, role), (error) => !error.message.includes(secret));
    }
  });
}

test("Anthropic tool results normalize to the same workflow transcript", () => {
  const body = normalizeMessages({ system: [{ text: "system" }], tools: [{ name: "GetMissionState" }], messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "dynamic", name: "GetMissionState", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "dynamic", content: [{ type: "text", text: '{"tasks":[]}' }] }] }
  ] }, "anthropic-messages");
  assert.deepEqual(body.messages.at(-1), { role: "tool", tool_call_id: "dynamic", content: '{"tasks":[]}' });
});

test("fake HTTP provider validates requests and never records credentials", async (t) => {
  const original = config(), records = [], errors = [];
  const server = await startFakeProvider({ config: original, credentials: { MINIMAX_CN: secret }, record: (value) => records.push(value), fail: (error) => errors.push(error.message) });
  t.after(() => close(server));
  const endpoint = `http://127.0.0.1:${server.address().port}/worker/chat/completions`;
  const body = { model: original.worker.modelId, stream: true, messages: [{ role: "user", content: "start" }], tools: [{ function: { name: "GetMissionState" } }] };
  const good = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
  assert.equal(good.status, 200); await good.text();
  const bad = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ ...body, model: "wrong" }) });
  assert.equal(bad.status, 500);
  assert.match(await bad.text(), /rejected request/);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "GetMissionState");
  assert.equal(JSON.stringify({ records, errors }).includes(secret), false);
});

test("rehearsal worker implementation follows the business rules", async () => {
  const { totalCents } = await import(`data:text/javascript,${encodeURIComponent(totalsSource)}`);
  assert.equal(totalCents([]), 0);
  assert.equal(totalCents([{ quantity: 7, unitPriceCents: 199 }]), 1393);
  assert.equal(totalCents([{ quantity: 0, unitPriceCents: 199 }]), 0);
  for (const value of [-1, 1.5, "2", undefined, NaN, Infinity]) {
    assert.throws(() => totalCents([{ quantity: value, unitPriceCents: 100 }]));
    assert.throws(() => totalCents([{ quantity: 2, unitPriceCents: value }]));
  }
  assert.throws(() => totalCents([{ quantity: 2, unitPriceCents: Number.MAX_SAFE_INTEGER }]));
  assert.throws(() => totalCents([{ quantity: 1, unitPriceCents: Number.MAX_SAFE_INTEGER }, { quantity: 1, unitPriceCents: 1 }]));
});


test("real outcome failures identify the frozen receipt rejection without changing the completion gate", () => {
  const command = "frozen command";
  assert.throws(() => assertRealOutcome({ mission: { status: "blocked" }, validationReceipts: [{ command, exitCode: 1 }] }, command), /Frozen acceptance failed.*failedReceipts=1/);
  assert.throws(() => assertRealOutcome({ mission: { status: "failed" }, validationReceipts: [] }, command), /Real Mission did not complete/);
  assert.doesNotThrow(() => assertRealOutcome({ mission: { status: "completed" }, validationReceipts: [] }, command));
});

test("failed frozen validation produces a model request for correction, not a protocol error", () => {
  const body = { messages: [{ role: "assistant", tool_calls: [{ id: "state-result", function: { name: "GetMissionState", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "state-result", content: JSON.stringify({ tasks: [{ status: "blocked" }], validationReceipts: [{ command: "frozen", exitCode: 1 }] }) }] };
  assert.equal(rehearsalCall(body, { role: "orchestrator", acceptanceCommand: "frozen" }).name, "RequestUserInput");
});

test("rehearsal worker starts its attempt, reads a denied publication, and retries an absolute workspace path", () => {
  const messages = [];
  const tools = ["GetMissionState", "UpdateTask", "write_file", "bash", "PublishArtifact", "Report", "WaitForMessage"].map(name => ({ function: { name } }));
  const add = (name, args, value) => {
    const id = `call-${messages.length}`;
    messages.push({ role: "assistant", tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
    messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(value) });
  };
  const next = () => rehearsalCall({ messages, tools }, { role: "worker" });
  add("GetMissionState", {}, { mission: { id: "mission" }, tasks: [{ id: "task", status: "ready", attempt: 0 }], executionEnvironment: { platform: "linux" } });
  assert.deepEqual(next(), { role: "worker", name: "UpdateTask", args: { taskId: "task", status: "running" } });
  add("UpdateTask", next().args, { id: "task", status: "running", attempt: 1 });
  const write = next();
  assert.equal(write.name, "write_file");
  add(write.name, write.args, { status: "succeeded" });
  const bash = next();
  assert.equal(bash.name, "bash");
  add(bash.name, bash.args, { status: "succeeded", result: { exitCode: 0 } });
  const denied = next();
  assert.deepEqual(denied.args, { name: "Order totals", path: "/work/totals.mjs", taskId: "not-an-owned-task" });
  add(denied.name, denied.args, { error: "PublishArtifact taskId must identify a task owned by this worker. Use GetMissionState to find your assigned task." });
  const retry = next();
  assert.deepEqual(retry.args, { name: "Order totals", path: "/work/totals.mjs", taskId: "task" });
  add(retry.name, retry.args, { status: "succeeded", result: { id: "artifact" } });
  assert.deepEqual(next().args, { taskId: "task", status: "review", evidence: "Linux self-check passed; totals.mjs published." });
});


test("rehearsal validator executes a shell-equivalent frozen command", () => {
  const acceptanceCommand = frozenAcceptanceCommand({ entry: { path: "/host/run-frozen-acceptance.mjs" } });
  const body = { tools: [{ function: { name: "RunValidation" } }], messages: [
    { role: "assistant", tool_calls: [{ id: "state", function: { name: "GetMissionState", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "state", content: JSON.stringify({ mission: {}, tasks: [{ id: "t", status: "review" }], artifacts: [{ id: "a", taskId: "t" }] }) }
  ] };
  const call = rehearsalCall(body, { role: "validator", acceptanceCommand });
  assert.equal(call.name, "RunValidation");
  assert.equal(call.args.taskId, "t");
  assert.deepEqual(call.args.artifactIds, ["a"]);
  assert.notEqual(call.args.command, acceptanceCommand);
  assert.equal(acceptanceCommandMatch(acceptanceCommand, call.args.command), "shell-equivalent");
});

test("rehearsal orchestrator recognizes failure of a shell-equivalent frozen command", () => {
  const acceptanceCommand = frozenAcceptanceCommand({ entry: { path: "/host/run-frozen-acceptance.mjs" } });
  const command = ` ${acceptanceCommand} `;
  const body = { messages: [
    { role: "assistant", tool_calls: [{ id: "state", function: { name: "GetMissionState", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "state", content: JSON.stringify({ tasks: [{ status: "blocked" }], validationReceipts: [{ command, exitCode: 1 }] }) }
  ] };
  const call = rehearsalCall(body, { role: "orchestrator", acceptanceCommand });
  assert.equal(call.name, "RequestUserInput");
  assert.match(call.args.question, /Frozen business tests rejected/);
});
