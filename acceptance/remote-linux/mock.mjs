import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { workerCrashTool } from "./scenarios/worker-crash.mjs";

export const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

export const pauseReport = "LINUX-SELF-CHECK-PAUSE-READY";
export const pauseQuestion = "Linux self-check passed. Continue publication on a replacement runtime?";

export const deliveryName = "linux-delivery.json";
export const delivery = { platform: "linux", answer: 42, version: 1 };

// Tool IDs and results come from the provider transcript, including across wakes.
export function transcript(body) {
  const calls = new Map();
  const results = [];
  for (const message of body.messages) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, call.function);
    if (message.role === "tool") {
      const call = calls.get(message.tool_call_id);
      assert.ok(call, "Tool result has no preceding call");
      let value;
      if (call.name === "WaitForMessage") {
        assert.equal(message.content, "Waiting for the next durable input.");
        value = message.content;
      } else value = JSON.parse(message.content);
      results.push({ name: call.name, args: JSON.parse(call.arguments), value });
    }
  }
  return results;
}

export function nextCall(body, { acceptanceCommand, hostTestPath, scenario = "default" }) {
  const names = new Set(body.tools.map((tool) => tool.function.name));
  const system = body.messages.filter((m) => ["system", "developer"].includes(m.role)).map((m) => m.content).join("\n");
  const role = names.has("SpawnAgent") ? "orchestrator" : names.has("bash") ? "worker" : "validator";
  assert.match(system, role === "orchestrator" ? /coordinate a persistent Mission/ : /persistent member of a Mission/);
  const history = transcript(body);
  const last = history.at(-1);
  const call = (name, args = {}) => {
    assert.ok(names.has(name), `${role} is missing ${name}`);
    return { role, name, args };
  };
  if (body.messages.at(-1)?.role !== "tool") return call("GetMissionState");
  if (last?.value?.error || last?.value?.isError) throw new Error(`Tool ${last.name} failed`);
  const state = history.findLast((r) => r.name === "GetMissionState")?.value;
  assert.ok(state?.mission && state.roles && state.tasks, "Missing real mission state");
  const task = state.tasks[0];
  if (role === "orchestrator") {
    if (["CreateTask", "SpawnAgent", "UpdateTask"].includes(last.name)) return call("GetMissionState");
    if (last.name === "SendMessage") return call("WaitForMessage");
    if (!task) return call("CreateTask", {
      title: "Linux frozen delivery", description: "Write and self-check a delivery on Linux; independently validate its frozen snapshot.",
      acceptance: state.mission.acceptance, dependencies: [], fulfills: state.validationContract.assertions.map((a) => a.id)
    });
    const worker = state.agents.find((a) => a.kind === "worker");
    const validator = state.agents.find((a) => a.kind === "validator");
    for (const kind of ["worker", "validator"]) {
      if (!(kind === "worker" ? worker : validator)) {
        const roleId = state.roles.find((r) => r.kind === kind)?.roleId;
        assert.ok(roleId, `No enabled ${kind} role`);
        return call("SpawnAgent", {
          title: `Acceptance ${kind}`, roleId,
          prompt: "Read GetMissionState. WaitForMessage until a task is assigned and ready for your role.",
          ...(kind === "worker" ? { targetWorkspaceId: state.remoteWorkspaces[0].id } : {})
        });
      }
    }
    if (!task.ownerId || !task.validatorId) return call("UpdateTask", { taskId: task.id, ownerId: worker.id, validatorId: validator.id, status: "running" });
    if (last.name === "RequestUserInput") return call("WaitForMessage");
    if (scenario === "pause-resume" && task.status === "running" &&
      body.messages.some((message) => message.role === "user" && message.content.includes(pauseReport)) &&
      !(state.blockers ?? []).some((blocker) => blocker.kind === "user_input" && blocker.text.startsWith(pauseQuestion))) {
      return call("RequestUserInput", { question: pauseQuestion });
    }
    if (task.status === "accepted") return call("CompleteMission");
    if (task.status === "running") return call("SendMessage", { recipientId: worker.id, mode: "followUp", content: `Implement task ${task.id}. Self-check on Linux, PublishArtifact, UpdateTask review, then Report.` });
    if (task.status === "review") return call("SendMessage", { recipientId: validator.id, mode: "followUp", content: `Independently accept task ${task.id} using ${acceptanceCommand} on the coordinator frozen snapshot, then Report.` });
    throw new Error(`Unexpected task status ${task.status}`);
  }
  if (role === "worker") {
    assert.equal(state.executionEnvironment?.platform, "linux");
    const owned = state.tasks.find((t) => state.agents.find((a) => a.id === t.ownerId)?.kind === "worker");
    if (!owned || owned.status !== "running") return call("WaitForMessage");
    if (scenario === "worker-crash") {
      const decision = workerCrashTool(history);
      if (decision) return call(decision.name, decision.args);
    }
    if (scenario === "pause-resume" && last.name === "GetMissionState" &&
      history.some((result) => result.name === "Report" && result.args.summary === pauseReport)) {
      const answer = (state.blockers ?? []).find((blocker) => blocker.kind === "user_input" && blocker.text.startsWith(pauseQuestion));
      if (answer?.status !== "resolved") return call("WaitForMessage");
      assert.ok(history.some((result) => result.name === "bash" && result.value.status === "succeeded" && result.value.result?.exitCode === 0), "Missing pre-pause Linux self-check");
      return call("PublishArtifact", { name: "Frozen Linux delivery", path: deliveryName, taskId: owned.id });
    }
    if (last.name === "GetMissionState") return call("write_file", { path: deliveryName, content: JSON.stringify(delivery) + "\n" });
    if (last.name === "write_file") {
      const code = `const a=require("node:assert/strict");a.equal(process.platform,"linux");a.deepEqual(require("./${deliveryName}"),${JSON.stringify(delivery)});a.equal(require("node:fs").existsSync(${JSON.stringify(hostTestPath)}),false);a.equal(process.env.MC_ACCEPTANCE_MODEL_CREDENTIAL,undefined);console.log("LINUX-SELF-CHECK-OK")`;
      return call("bash", { command: `command -v node && node -e ${shellQuote(code)}` });
    }
    if (last.name === "bash" && !last.args.command.includes("LIVE-SOURCE-CHANGED")) {
      assert.equal(last.value.status, "succeeded", "Linux self-check effect failed");
      assert.equal(last.value.result?.exitCode, 0, "Linux self-check failed");
      if (scenario === "pause-resume") return call("Report", { summary: pauseReport, evidence: "LINUX-SELF-CHECK-OK; await the orchestrator's user input before publishing." });
      return call("PublishArtifact", { name: "Frozen Linux delivery", path: deliveryName, taskId: owned.id });
    }
    if (last.name === "PublishArtifact") {
      assert.equal(last.value.status, "succeeded", "Publication effect failed");
      assert.ok(last.value.result?.id, "Publication did not return an artifact ID");
      return call("bash", { command: `node -e 'require("node:fs").writeFileSync("${deliveryName}",JSON.stringify({version:2}));console.log("LIVE-SOURCE-CHANGED")'` });
    }
    if (last.name === "bash") {
      assert.equal(last.value.status, "succeeded", "Live mutation effect failed");
      assert.equal(last.value.result?.exitCode, 0, "Live mutation failed");
      return call("UpdateTask", { taskId: owned.id, status: "review", evidence: "Linux self-check passed; frozen artifact published; live source then changed." });
    }
    if (last.name === "Report" && last.args.summary === pauseReport) return call("WaitForMessage");
    if (last.name === "UpdateTask") return call("Report", { summary: "Linux delivery ready for independent review", evidence: "LINUX-SELF-CHECK-OK; frozen snapshot published before live mutation." });
  } else {
    if (!task || task.status !== "review") return call("WaitForMessage");
    if (last.name === "GetMissionState") {
      const artifactIds = state.artifacts.filter((a) => a.taskId === task.id).map((a) => a.id);
      assert.equal(artifactIds.length, 1);
      return call("RunValidation", { taskId: task.id, command: acceptanceCommand, artifactIds });
    }
    if (last.name === "RunValidation") {
      const receipt = last.value;
      assert.equal(receipt.exitCode, 0);
      assert.equal(receipt.snapshotIntegrity, true);
      assert.equal(receipt.workspaceKind, "remote-snapshot");
      return call("ValidateTask", { taskId: task.id, receiptId: receipt.id, passed: true,
        evidence: "Host tests passed against the intact frozen Linux delivery.",
        assertionResults: state.validationContract.assertions.map((a) => ({ assertionId: a.id, status: "passed", evidence: receipt.stdout })) });
    }
    if (last.name === "ValidateTask") return call("Report", { summary: "Frozen Linux delivery accepted", evidence: "RunValidation exited zero with snapshotIntegrity=true; ValidateTask passed." });
  }
  throw new Error(`Unexpected ${role} tool progress after ${last?.name}`);
}

export async function startMock({ credential, acceptanceCommand, hostTestPath, scenario = "default", record, fail }) {
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${credential}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert.ok(size < 8 * 1024 * 1024, "Mock request too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.stream, true);
      let decision;
      try { decision = nextCall(body, { acceptanceCommand, hostTestPath, scenario }); }
      catch (error) {
        record({ role: "protocol", name: "rejected", results: transcript(body) });
        throw error;
      }
      record({ ...decision, results: transcript(body) });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const id = `chatcmpl-${randomUUID()}`;
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      const args = JSON.stringify(decision.args);
      const split = Math.floor(args.length / 2);
      send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: "function", function: { name: decision.name, arguments: args.slice(0, split) } }] });
      send({ tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] });
      send({}, "tool_calls");
      response.end("data: [DONE]\n\n");
    } catch (error) {
      fail(new Error(`Mock protocol or workflow failure: ${error.message}`));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Deterministic acceptance mock rejected request" } }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}
