import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { readSecrets, kinds } from "./real.mjs";
import { nextCall, shellQuote, transcript } from "./mock.mjs";

export function rehearsalSecrets(proof, config) {
  const path = join(proof, "rehearsal.env");
  const names = [...new Set(kinds.map((kind) => config[kind].credentialEnv))];
  writeFileSync(path, names.map((name) => `${name}=rehearsal-${randomUUID()}`).join("\n") + "\n", { mode: 0o600, flag: "wx" });
  return { path, credentials: readSecrets(path, names) };
}

export function rehearsalConfig(config, hostPort, relayPort) {
  return Object.fromEntries(kinds.map((kind) => {
    assert.ok(["anthropic-messages", "openai-completions"].includes(config[kind].api), "Rehearsal supports anthropic-messages and openai-completions only");
    return [kind, { ...config[kind], baseUrl: `http://${kind === "worker" ? `192.168.64.1:${relayPort}` : `127.0.0.1:${hostPort}`}/${kind}` }];
  }));
}

// Normalize only the transport shape; workflow decisions still use actual tool results.
export function normalizeMessages(body, api) {
  if (api === "openai-completions") return body;
  const messages = [];
  for (const message of body.messages) {
    const content = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    const calls = content.filter((block) => block.type === "tool_use");
    if (calls.length) messages.push({ role: "assistant", tool_calls: calls.map((block) => ({ id: block.id, function: { name: block.name, arguments: JSON.stringify(block.input) } })) });
    for (const block of content) {
      if (block.type === "tool_result") messages.push({ role: "tool", tool_call_id: block.tool_use_id,
        content: typeof block.content === "string" ? block.content : block.content.map((item) => item.text ?? "").join("\n") });
      else if (block.type === "text") messages.push({ role: message.role, content: block.text });
    }
  }
  return { ...body, messages: [{ role: "system", content: typeof body.system === "string" ? body.system : (body.system ?? []).map((block) => block.text).join("\n") }, ...messages],
    tools: body.tools.map((tool) => ({ function: { name: tool.name } })) };
}

export const totalsSource = `export function totalCents(lines) {
  let total = 0;
  for (const { quantity, unitPriceCents } of lines) {
    if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(unitPriceCents) || quantity < 0 || unitPriceCents < 0) throw new Error('Invalid fields');
    const amount = quantity * unitPriceCents;
    total += amount;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total)) throw new Error('Unsafe amount');
  }
  return total;
}
`;
const wrongSource = "export const totalCents = lines => lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);\n";

export function rehearsalCall(body, { role, acceptanceCommand, wrongImplementation = false }) {
  if (role === "orchestrator") {
    const state = transcript(body).findLast((result) => result.name === "GetMissionState")?.value;
    if (state?.tasks.some((task) => task.status === "blocked") && state.validationReceipts?.some((receipt) => receipt.command === acceptanceCommand && receipt.exitCode !== 0)) {
      return { role, name: "RequestUserInput", args: { question: "Frozen business tests rejected the totals implementation; a correction is required." } };
    }
    return nextCall(body, { acceptanceCommand });
  }
  const names = new Set(body.tools.map((tool) => tool.function.name));
  const call = (name, args = {}) => { assert.ok(names.has(name), `${role} is missing ${name}`); return { role, name, args }; };
  if (body.messages.at(-1)?.role !== "tool") return call("GetMissionState");
  const history = transcript(body), last = history.at(-1);
  const rejectedPublication = role === "worker" && last?.name === "PublishArtifact" &&
    last.args.taskId === "not-an-owned-task";
  if (rejectedPublication) {
    assert.equal(typeof last.value.error, "string", "Invalid publication must return a tool error");
    assert.match(last.value.error, /taskId.*owned by this worker/, "Publication denial must explain how to correct taskId");
  } else assert.ok(!last?.value?.error && !last?.value?.isError, `Tool ${last?.name} failed`);
  const state = history.findLast((result) => result.name === "GetMissionState")?.value;
  assert.ok(state?.mission && state.tasks, "Missing mission state");
  const task = state.tasks[0];
  if (!task || (role === "worker" ? !["ready", "assigned", "running"].includes(task.status) : task.status !== "review")) return call("WaitForMessage");
  if (role === "worker") {
    assert.equal(state.executionEnvironment?.platform, "linux");
    if (last.name === "GetMissionState") return call("UpdateTask", { taskId: task.id, status: "running" });
    if (last.name === "UpdateTask" && last.args.status === "running") return call("write_file", { path: "totals.mjs", content: wrongImplementation ? wrongSource : totalsSource });
    if (last.name === "write_file") return call("bash", { command: `command -v node && node --input-type=module -e ${shellQuote("import assert from 'node:assert/strict'; import {totalCents} from './totals.mjs'; assert.equal(process.platform,'linux'); assert.equal(totalCents([{quantity:2,unitPriceCents:125},{quantity:3,unitPriceCents:70}]),460); console.log('LINUX-SELF-CHECK-OK');")}` });
    if (last.name === "bash") {
      assert.equal(last.value.status, "succeeded");
      assert.equal(last.value.result?.exitCode, 0, "Linux self-check failed");
      return call("PublishArtifact", { name: "Order totals", path: "/work/totals.mjs", taskId: "not-an-owned-task" });
    }
    if (last.name === "PublishArtifact") {
      if (rejectedPublication) return call("PublishArtifact", { name: "Order totals", path: "/work/totals.mjs", taskId: task.id });
      assert.equal(last.value.status, "succeeded");
      assert.ok(last.value.result?.id, "Publication did not return an artifact ID");
      return call("UpdateTask", { taskId: task.id, status: "review", evidence: "Linux self-check passed; totals.mjs published." });
    }
    if (last.name === "UpdateTask") return call("Report", { summary: "Totals ready for independent validation", evidence: "LINUX-SELF-CHECK-OK; frozen artifact published." });
  } else {
    if (last.name === "GetMissionState") {
      const artifactIds = state.artifacts.filter((artifact) => artifact.taskId === task.id).map((artifact) => artifact.id);
      assert.equal(artifactIds.length, 1);
      return call("RunValidation", { taskId: task.id, command: acceptanceCommand, artifactIds });
    }
    if (last.name === "RunValidation") {
      const receipt = last.value;
      assert.equal(receipt.snapshotIntegrity, true);
      assert.equal(receipt.workspaceKind, "remote-snapshot");
      const passed = receipt.exitCode === 0;
      return call("ValidateTask", { taskId: task.id, receiptId: receipt.id, passed,
        evidence: passed ? "Frozen business tests passed" : "Frozen business tests rejected invalid totals",
        assertionResults: state.validationContract.assertions.map((assertion) => ({ assertionId: assertion.id, status: passed ? "passed" : "failed", evidence: receipt.stdout })) });
    }
    if (last.name === "ValidateTask") return call("Report", { summary: "Frozen totals validated", evidence: "Independent frozen business tests ran." });
  }
  throw new Error(`Unexpected ${role} progress after ${last.name}`);
}

export function encodeReply(api, model, decision) {
  const id = randomUUID(), args = JSON.stringify(decision.args), split = Math.floor(args.length / 2);
  if (api === "anthropic-messages") {
    const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    return event("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) +
      event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `tool_${id}`, name: decision.name, input: {} } }) +
      [args.slice(0, split), args.slice(split)].map((partial_json) => event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json } })).join("") +
      event("content_block_stop", { index: 0 }) + event("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }) + event("message_stop", {});
  }
  const chunk = (delta, finish_reason = null, usage) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: usage ? [] : [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
  return chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: decision.name, arguments: args.slice(0, split) } }] }) +
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] }) + chunk({}, "tool_calls") +
    chunk({}, null, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) + "data: [DONE]\n\n";
}

export function validateRequest(request, body, profile, credential, role) {
  // Never include received or expected credentials in an assertion error.
  assert.ok(request.method === "POST", "Expected POST");
  const url = new URL(request.url, "http://127.0.0.1");
  assert.ok(url.pathname === `/${role}/${profile.api === "anthropic-messages" ? "v1/messages" : "chat/completions"}` &&
    (!url.search || (profile.api === "anthropic-messages" && url.search === "?beta=true")), "Unexpected provider path");
  assert.ok(body.model === profile.modelId, "Configured model mismatch");
  assert.ok(body.stream === true, "Streaming required");
  const header = profile.api === "anthropic-messages" ? request.headers["x-api-key"] : request.headers.authorization;
  assert.ok(header === (profile.api === "anthropic-messages" ? credential : `Bearer ${credential}`), "Provider credential header mismatch");
}

export async function startFakeProvider({ config, credentials, acceptanceCommand, wrongImplementation, record, fail }) {
  const server = createServer(async (request, response) => {
    try {
      const role = request.url?.split("/")[1];
      assert.ok(kinds.includes(role), "Unknown provider role");
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size < 8 * 1024 * 1024, "Request too large"); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      validateRequest(request, body, config[role], credentials[config[role].credentialEnv], role);
      const normalized = normalizeMessages(body, config[role].api);
      const decision = rehearsalCall(normalized, { role, acceptanceCommand, wrongImplementation });
      record({ role, name: decision.name, model: body.model, api: config[role].api });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(encodeReply(config[role].api, body.model, decision));
    } catch (error) {
      fail(new Error(`Rehearsal provider rejected request: ${error.message}`));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Rehearsal provider rejected request" } }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}
