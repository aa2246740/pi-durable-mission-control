import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyProbe, containerArgs, containerEnv, containerPrefix, parseOptions, publishReport, runPreflight, uniqueTargets } from "../acceptance/remote-linux/preflight.mjs";
import { readConfig } from "../acceptance/remote-linux/real.mjs";

const preflightPath = fileURLToPath(new URL("../acceptance/remote-linux/preflight.mjs", import.meta.url));
const secret = 'preflight-secret-"quoted"\\tail';

const temporary = (t) => {
  const path = mkdtempSync(join(tmpdir(), "mc-preflight-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};

function writeSecrets(directory, text = `UNIT_KEY=${secret}\nOTHER_KEY=${secret}-other\n`) {
  const path = join(directory, "secrets.env");
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

function profile(baseUrl, api, modelId = "preflight-model", credentialEnv = "UNIT_KEY") {
  return {
    name: "Preflight",
    api,
    modelId,
    baseUrl,
    credentialEnv,
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: true,
    toolCalling: true,
    vision: false
  };
}

function writeConfig(directory, config) {
  const path = join(directory, "models.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function openaiStream(tool, modelName) {
  const first = tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: "call_ping", type: "function", function: { name: "ping", arguments: "" } }] }
    : { role: "assistant", content: "hello" };
  const second = tool
    ? { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }
    : { content: "" };
  const finish = tool ? "tool_calls" : "stop";
  const chunks = [
    { id: "chatcmpl-preflight", object: "chat.completion.chunk", created: 1, model: modelName, choices: [{ index: 0, delta: first, finish_reason: null }] },
    { id: "chatcmpl-preflight", object: "chat.completion.chunk", created: 1, model: modelName, choices: [{ index: 0, delta: second, finish_reason: null }] },
    { id: "chatcmpl-preflight", object: "chat.completion.chunk", created: 1, model: modelName, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } }
  ];
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function anthropicStream(tool, modelName) {
  const blocks = tool
    ? [
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_ping", name: "ping", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }]
    ]
    : [
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "hello" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }]
    ];
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_preflight", type: "message", role: "assistant", model: modelName, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 1 } } }],
    ...blocks,
    ["message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
    ["message_stop", { type: "message_stop" }]
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

async function startServer(t, mode) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const record = { url: request.url, body, authorization: request.headers.authorization, apiKey: request.headers["x-api-key"] };
    requests.push(record);
    if (mode === "timeout") return;
    const anthropic = request.url.includes("/messages");
    if (mode === "unauthorized" || mode === "echo") {
      const echoed = record.authorization?.replace(/^Bearer /, "") || record.apiKey || "";
      const payload = JSON.stringify({ error: { message: `rejected ${echoed}`, type: "authentication_error" } });
      response.writeHead(401, { "content-type": "application/json" });
      response.end(payload);
      return;
    }
    let requested = "preflight-model";
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.model === "string" && parsed.model.length > 0) requested = parsed.model;
    } catch { /* A malformed body still gets a named fake model. */ }
    const modelName = mode === "mismatch" ? "mapped-from-endpoint" : requested;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(anthropic ? anthropicStream(mode === "tool" || mode === "mismatch", modelName) : openaiStream(mode === "tool" || mode === "mismatch", modelName));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = server.address().port;
  return {
    requests,
    origin: `http://127.0.0.1:${port}`,
    openai: `http://127.0.0.1:${port}/v1`,
    anthropic: `http://127.0.0.1:${port}/anthropic`
  };
}

function configFor(server, workerApi = "openai-completions") {
  return {
    orchestrator: profile(server.anthropic, "anthropic-messages", "preflight-anthropic"),
    worker: profile(workerApi === "anthropic-messages" ? server.anthropic : server.openai, workerApi, workerApi === "anthropic-messages" ? "preflight-anthropic" : "preflight-openai"),
    validator: profile(server.anthropic, "anthropic-messages", "preflight-anthropic")
  };
}

function escaped(value) {
  return JSON.stringify(value).slice(1, -1);
}

function assertClean(text) {
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(escaped(secret)), false);
  assert.equal(text.includes(`${secret}-other`), false);
  assert.equal(text.includes(escaped(`${secret}-other`)), false);
}

function assertNoSecret(value) {
  const visit = (item) => {
    if (typeof item === "string") {
      assert.equal(item.includes(secret), false);
      assert.equal(item.includes(escaped(secret)), false);
      return;
    }
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [preflightPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("preflight options require a real config and secrets file", () => {
  assert.equal(parseOptions(["--real", "models.json", "--secrets-file", "unit.env", "--from-container"]).fromContainer, true);
  assert.equal(parseOptions(["--real", "models.json", "--secrets-file", "unit.env", "--timeout-ms", "250"]).timeoutMs, 250);
  for (const args of [[], ["--real", "models.json"], ["--secrets-file", "unit.env"], ["--real", "models.json", "--secrets-file", "unit.env", "--keep"]]) {
    assert.throws(() => parseOptions(args));
  }
  assert.equal(classifyProbe({ httpOk: true, toolCalled: true, httpStatus: 200, error: null }), null);
  assert.equal(classifyProbe({ httpOk: false, toolCalled: false, httpStatus: 401, error: "401 no" }), "auth");
});

test("examples collapse repeated provider combinations", () => {
  const mini = readConfig(new URL("../acceptance/remote-linux/real-minimax.json", import.meta.url));
  const glm = readConfig(new URL("../acceptance/remote-linux/real-glm.json", import.meta.url));
  assert.deepEqual(uniqueTargets(mini).map((target) => target.roles), [["orchestrator", "validator"], ["worker"]]);
  assert.deepEqual(uniqueTargets(glm).map((target) => target.roles), [["orchestrator", "worker", "validator"]]);
});

test("local OpenAI and Anthropic endpoints must return one ping tool call", async (t) => {
  const directory = temporary(t);
  const server = await startServer(t, "tool");
  const configPath = writeConfig(directory, configFor(server));
  const report = await runPreflight({ configPath, secretsFile: writeSecrets(directory), timeoutMs: 5000 });
  assert.equal(report.pass, true);
  assert.equal(report.checks.length, 2);
  assert.deepEqual(report.checks.map((check) => check.roles), [["orchestrator", "validator"], ["worker"]]);
  assert.deepEqual(report.checks.map((check) => check.transport), ["host", "host"]);
  for (const check of report.checks) {
    assert.equal(check.httpOk, true);
    assert.equal(check.httpStatus, 200);
    assert.equal(check.toolCalled, true);
    assert.equal(check.errorCategory, null);
    assert.equal(check.error, null);
    assert.equal(check.responseModel, check.modelId);
    assert.equal(check.responseModelReason, null);
    assert.equal(check.modelMismatch, false);
    assert.ok(check.latencyMs >= 0);
    assert.ok(check.usage.totalTokens > 0);
  }
  assert.deepEqual(report.modelMismatches, []);
  assert.equal(report.notice, undefined);
  assert.equal(server.requests.length, 2);
  const parsed = server.requests.map((request) => ({ url: request.url, body: JSON.parse(request.body) }));
  const anthropic = parsed.find((request) => request.url.includes("/messages")).body;
  const openai = parsed.find((request) => request.url.includes("/chat/completions")).body;
  assert.equal(anthropic.max_tokens, 1024);
  // Like product runs, the probe leaves tool choice to the model (some endpoints only accept auto).
  assert.equal(anthropic.tool_choice, undefined);
  assert.equal(anthropic.tools[0].name, "ping");
  assert.equal(openai.max_completion_tokens, 1024);
  assert.equal(openai.tool_choice, undefined);
  assert.equal(openai.tools[0].function.name, "ping");
  assert.equal(server.requests.some((request) => request.apiKey === secret), true);
  assert.equal(server.requests.some((request) => request.authorization === `Bearer ${secret}`), true);
  assertNoSecret(report);
  const cli = await runCli(["--real", configPath, "--secrets-file", writeSecrets(directory), "--timeout-ms", "5000"]);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assertClean(cli.stdout);
  assertClean(cli.stderr);
  assert.equal(JSON.parse(cli.stdout).pass, true);
  assert.equal(server.requests.length, 4);
});

test("authentication, missing tool calls, and timeouts fail closed without retries", async (t) => {
  const directory = temporary(t);
  for (const mode of ["unauthorized", "text", "timeout"]) {
    const server = await startServer(t, mode === "text" ? "text" : mode);
    const report = await runPreflight({ configPath: writeConfig(directory, configFor(server)), secretsFile: writeSecrets(directory), timeoutMs: mode === "timeout" ? 400 : 5000 });
    assert.equal(report.pass, false);
    assert.equal(report.checks.length, 2);
    assert.equal(server.requests.length, 2);
    for (const check of report.checks) {
      assert.equal(check.toolCalled, false);
      assert.equal(check.modelMismatch, false);
      if (mode === "unauthorized") {
        assert.equal(check.httpOk, false);
        assert.equal(check.httpStatus, 401);
        assert.equal(check.errorCategory, "auth");
        assert.equal(check.responseModel, null);
        assert.match(check.responseModelReason, /before a response model/);
      } else if (mode === "text") {
        assert.equal(check.httpOk, true);
        assert.equal(check.httpStatus, 200);
        assert.equal(check.errorCategory, "no-tool-call");
        assert.equal(check.responseModel, check.modelId);
        assert.ok(check.usage.totalTokens > 0);
      } else {
        assert.equal(check.httpOk, false);
        assert.equal(check.errorCategory, "timeout");
        assert.equal(check.responseModel, null);
        assert.match(check.responseModelReason, /before a response model/);
        assert.ok(check.latencyMs >= 300);
        assert.ok(check.latencyMs < 5000);
      }
    }
    assertNoSecret(report);
  }
});

test("a different response model is reported without failing the tool-call check", async (t) => {
  const directory = temporary(t);
  const server = await startServer(t, "mismatch");
  const configPath = writeConfig(directory, configFor(server));
  const report = await runPreflight({ configPath, secretsFile: writeSecrets(directory), timeoutMs: 5000 });
  assert.equal(report.pass, true);
  assert.equal(report.notice, "API response model differs from configured modelId");
  assert.equal(report.modelMismatches.length, 2);
  assert.deepEqual(report.modelMismatches.map((item) => item.responseModel), ["mapped-from-endpoint", "mapped-from-endpoint"]);
  for (const check of report.checks) {
    assert.equal(check.httpOk, true);
    assert.equal(check.toolCalled, true);
    assert.equal(check.errorCategory, null);
    assert.equal(check.responseModel, "mapped-from-endpoint");
    assert.equal(check.responseModelReason, null);
    assert.equal(check.modelMismatch, true);
    assert.notEqual(check.responseModel, check.modelId);
  }
  const cli = await runCli(["--real", configPath, "--secrets-file", writeSecrets(directory), "--timeout-ms", "5000"]);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.pass, true);
  assert.equal(parsed.modelMismatches.length, 2);
  assert.match(cli.stdout, /mapped-from-endpoint/);
});

test("provider error bodies that echo a credential are redacted", async (t) => {
  const directory = temporary(t);
  const server = await startServer(t, "echo");
  const configPath = writeConfig(directory, configFor(server));
  const secretsFile = writeSecrets(directory);
  const cli = await runCli(["--real", configPath, "--secrets-file", secretsFile, "--timeout-ms", "5000"]);
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assertClean(cli.stdout);
  assertClean(cli.stderr);
  assert.match(cli.stdout, /\[REDACTED\]/);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.pass, false);
  assert.equal(report.checks.every((check) => check.errorCategory === "auth"), true);
  assert.equal(report.checks.every((check) => check.error.includes("[REDACTED]")), true);
  assert.equal(server.requests.length, 2);
  assert.equal(publishReport({ error: `echo ${secret}` }, [secret]).includes(secret), false);
});

test("rejected secrets files do not echo credential bytes", async (t) => {
  const directory = temporary(t);
  const configPath = writeConfig(directory, configFor({ openai: "http://127.0.0.1:9/v1", anthropic: "http://127.0.0.1:9/anthropic" }));
  const secretsFile = join(directory, "open.env");
  writeFileSync(secretsFile, `UNIT_KEY=${secret}\n`, { mode: 0o644 });
  const cli = await runCli(["--real", configPath, "--secrets-file", secretsFile]);
  assert.equal(cli.status, 1);
  assertClean(cli.stdout);
  assertClean(cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.equal(report.pass, false);
  assert.deepEqual(report.checks, []);
  assert.match(report.error, /Secrets file rejected/);
});

test("container preflight sends the worker credential only on stdin", async (t) => {
  const directory = temporary(t);
  const server = await startServer(t, "tool");
  const prefix = containerPrefix();
  const args = containerArgs({ name: `${prefix}unit`, image: "node:22-bookworm-slim" });
  assert.equal(args.includes("--rm"), true);
  assert.equal(args.includes(`${prefix}unit`), true);
  assert.ok(args.filter((arg) => arg.endsWith(":ro")).length >= 2);
  assertClean(args.join("\n"));
  assertClean(Object.values(containerEnv()).join("\n"));
  const report = await runPreflight({
    configPath: writeConfig(directory, configFor(server)),
    secretsFile: writeSecrets(directory),
    fromContainer: true,
    timeoutMs: 5000,
    containerRun: ({ args: launchArgs, env, stdin }) => {
      assert.equal(launchArgs.includes("--rm"), true);
      assertClean(JSON.stringify({ launchArgs, env }));
      const payload = JSON.parse(stdin);
      assert.equal(payload.credential === secret, true);
      assert.equal(payload.profile.modelId, "preflight-openai");
      const child = spawn(process.execPath, [preflightPath, "--container-probe"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdin.end(stdin);
      return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          assert.equal(code, 0, stderr);
          assertClean(stdout);
          assertClean(stderr);
          resolve(JSON.parse(stdout));
        });
      });
    }
  });
  assert.equal(report.pass, true, JSON.stringify(report));
  assert.deepEqual(report.checks.map((check) => [check.transport, check.toolCalled]), [["host", true], ["container", true]]);
  assert.equal(server.requests.filter((request) => request.url.includes("/messages")).length, 1);
  assert.equal(server.requests.filter((request) => request.url.includes("/chat/completions")).length, 1);
  assertNoSecret(report);
});

test("a shared worker combination is probed once from the container entry", async (t) => {
  const directory = temporary(t);
  const server = await startServer(t, "tool");
  const shared = profile(server.openai, "openai-completions", "preflight-openai");
  const report = await runPreflight({
    configPath: writeConfig(directory, { orchestrator: shared, worker: shared, validator: shared }),
    secretsFile: writeSecrets(directory),
    fromContainer: true,
    timeoutMs: 5000,
    containerRun: ({ stdin }) => {
      const child = spawn(process.execPath, [preflightPath, "--container-probe"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stdin.end(stdin);
      return new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          assert.equal(code, 0);
          resolve(JSON.parse(stdout));
        });
      });
    }
  });
  assert.equal(report.pass, true);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].transport, "container");
  assert.deepEqual(report.checks[0].roles, ["orchestrator", "worker", "validator"]);
  assert.equal(server.requests.length, 1);
});
