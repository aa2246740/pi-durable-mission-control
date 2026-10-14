import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CoordinatorUnavailable, fetchJson, nodeReconnectDelay } from "../dist/node.js";
import { workerStartSpecHash } from "../dist/node-worker-spec.js";
import { DurableWorkerMailbox } from "../dist/worker-mailbox.js";

const waitFor = async (predicate, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Reconnect fixture timed out");
};

async function fixture(t, execution = false) {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-reconnect-"));
  const root = join(home, "root");
  mkdirSync(root);
  const nodeHome = join(home, "node");
  const state = { sessionId: crypto.randomUUID(), sessionEpoch: 1, failure: undefined, polls: 0, registrations: [], workersAtRegistration: [], reports: [], requests: [] };
  const db = new DatabaseSync(":memory:");
  const mailbox = new DurableWorkerMailbox(db, "coordinator");
  let descriptor;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const path = request.url;
    state.requests.push({ path, body });
    if (state.failure === "reset") { request.socket.destroy(); return; }
    if (state.failure === "timeout") return;
    if (state.failure) {
      if (state.failure === "malformed") { response.end("{"); return; }
      if (state.failure === "protocol") { response.end("{}"); return; }
      response.writeHead(state.failure);
      response.end(JSON.stringify({ error: "fixture failure" }));
      return;
    }
    const machine = { id: "reconnect-node", kind: "remote", status: "online", sessionId: state.sessionId, sessionEpoch: state.sessionEpoch };
    let value;
    if (path === "/api/nodes/session") {
      state.registrations.push(body.registrationId);
      if (execution && state.sessionEpoch > 1) state.workersAtRegistration.push(readRuntime());
      value = { machine, sessionId: state.sessionId, sessionEpoch: state.sessionEpoch, leaseMs: 20000 };
    } else if (body.sessionId !== state.sessionId || body.sessionEpoch !== state.sessionEpoch) {
      response.writeHead(409);
      response.end(JSON.stringify({ error: state.fenceReason ?? "Node session is fenced; stop local work and isolate this node" }));
      return;
    } else if (path === "/api/nodes/poll") {
      state.polls++;
      value = { machine, commands: [], leaseMs: 20000 };
    } else if (path === "/api/nodes/runtimes/poll") {
      value = { directives: descriptor && state.sessionEpoch === 1 ? [{ action: "start", descriptor, descriptorHash: workerStartSpecHash(descriptor) }] : [] };
    } else if (path === "/api/nodes/mailbox/upload") {
      value = mailbox.receive(body.binding, body.envelope);
    } else if (path === "/api/nodes/mailbox/poll") {
      value = { envelopes: [] };
    } else if (path === "/api/nodes/runtimes/events") {
      state.reports.push(body);
      value = { recorded: true };
    } else assert.fail(`Unexpected fixture endpoint ${path}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = new URL(`http://127.0.0.1:${server.address().port}`);
  if (execution) {
    const profile = { id: "profile", name: "fixture", api: "openai-completions", modelId: "fixture", baseUrl: "http://127.0.0.1:9/v1", credentialEnv: "", contextWindow: 4096, maxTokens: 512, reasoning: false, toolCalling: true, vision: false, revision: 1 };
    descriptor = { binding: { runtimeId: crypto.randomUUID(), machineId: "reconnect-node", sessionId: state.sessionId, sessionEpoch: 1, agentId: crypto.randomUUID(), epoch: 1 }, missionId: crypto.randomUUID(), workspacePath: root, workspaceStrategy: "shared", effects: false, profile, role: { id: "worker", name: "worker", kind: "worker", instructions: "Wait for input", profileId: profile.id } };
    mailbox.open(descriptor.binding);
  }
  let child;
  let output = "";
  const start = () => {
    const options = { coordinator: base.href, machineId: "reconnect-node", tokenEnv: "NODE_RECONNECT_TOKEN", home: nodeHome, roots: [root], credentialRefs: [], ...(execution ? { executionMode: "metadata-only", testOnlyScripted: true } : {}) };
    const source = `import { runNode } from ${JSON.stringify(new URL("../dist/node.js", import.meta.url).href)}; runNode(${JSON.stringify(options)}).catch(error => { process.stderr.write(error.message + "\\n"); process.exitCode = 1; });`;
    child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, NODE_RECONNECT_TOKEN: "private-fixture-token" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    return child;
  };
  const readRuntime = () => {
    const local = new DatabaseSync(join(nodeHome, "worker-runtime", "node-workers.sqlite"), { readOnly: true });
    try { return local.prepare("SELECT * FROM node_worker_runtimes").all(); }
    finally { local.close(); }
  };
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { state, server, base, start, descriptor, readRuntime, nodeHome, output: () => output };
}

test("reconnect backoff doubles, jitters, and stays capped at 30 seconds", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 1000].map(attempt => nodeReconnectDelay(attempt, 1)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(nodeReconnectDelay(0, 0), 500);
  assert.equal(nodeReconnectDelay(1000, 0), 15000);
});

for (const failure of [502, 503, 504, "reset", "timeout"]) {
  test(`node transport classifies ${failure} as retryable`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    f.state.failure = failure;
    await assert.rejects(fetchJson(f.base, "/api/nodes/session", "fixture", {}), CoordinatorUnavailable);
  });
}

test("real node retries connection refusal at startup and SIGTERM immediately interrupts backoff", async t => {
  const f = await fixture(t);
  const port = f.server.address().port;
  await new Promise(resolve => f.server.close(resolve));
  const child = f.start();
  await waitFor(() => f.output().includes("retrying"));
  assert.equal(child.exitCode, null);
  await new Promise(resolve => f.server.listen(port, "127.0.0.1", resolve));
  await waitFor(() => f.state.polls > 0);
  assert.equal(f.state.registrations.length, 1);
  f.state.failure = 503;
  await waitFor(() => f.output().split("retrying").length >= 3);
  const exit = once(child, "exit");
  const started = Date.now();
  child.kill("SIGTERM");
  await exit;
  assert.ok(Date.now() - started < 1000, f.output());
  assert.equal(child.exitCode, 0);
  assert.equal(f.output().includes("private-fixture-token"), false);
});

test("short transport outage preserves the session and live worker without a new assignment", async t => {
  const f = await fixture(t, true);
  const child = f.start();
  await waitFor(() => f.state.requests.some(({ path }) => path === "/api/nodes/mailbox/upload"));
  await waitFor(() => f.readRuntime()[0]?.state === "running");
  const runtime = f.readRuntime()[0];
  f.state.failure = "reset";
  await waitFor(() => f.output().includes("retrying"));
  const polls = f.state.polls;
  const requests = f.state.requests.length;
  assert.equal(child.exitCode, null);
  f.state.failure = undefined;
  await waitFor(() => f.state.polls > polls);
  await waitFor(() => f.state.requests.slice(requests).some(({ path }) => path === "/api/nodes/mailbox/poll"));
  assert.equal(f.state.registrations.length, 1);
  assert.deepEqual(f.readRuntime(), [runtime]);
  assert.deepEqual(f.state.reports, []);
});

for (const reason of ["Node session is fenced; stop local work and isolate this node", "Node lease expired; isolate this node and reconnect"]) {
  test(`new session stops old runtime with unexpected provenance: ${reason}`, async t => {
    const f = await fixture(t, true);
    const child = f.start();
    await waitFor(() => f.state.requests.some(({ path }) => path === "/api/nodes/mailbox/upload"));
    await waitFor(() => f.readRuntime()[0]?.state === "running");
    const old = f.readRuntime()[0];
    const uploads = f.state.requests.filter(({ path }) => path === "/api/nodes/mailbox/upload").length;
    const journalBefore = new DatabaseSync(join(f.nodeHome, "node.sqlite"));
    const operationId = crypto.randomUUID();
    journalBefore.prepare("INSERT INTO node_operations(command_id,requested_path,status,outcome,updated_at,session_id,session_epoch) VALUES(?,?,'completed',?,?,?,?)")
      .run(operationId, "unused-old-path", JSON.stringify({ ok: false, error: "old outcome" }), Date.now(), f.state.sessionId, f.state.sessionEpoch);
    journalBefore.close();
    f.state.fenceReason = reason;
    f.state.sessionId = crypto.randomUUID();
    f.state.sessionEpoch++;
    await waitFor(() => f.state.reports.length > 0);
    assert.equal(child.exitCode, null, f.output());
    assert.equal(f.state.registrations.length, 2);
    assert.notEqual(f.state.registrations[0], f.state.registrations[1]);
    assert.ok(f.state.reports.every(report => report.sessionId === f.state.sessionId && report.binding.sessionId === f.descriptor.binding.sessionId && report.stopReason === "unexpected" && report.outcome === "stopped"));
    assert.throws(() => process.kill(old.pid, 0), error => error.code === "ESRCH");
    const [stopped] = f.readRuntime();
    assert.equal(stopped.state, "closed");
    assert.equal(stopped.stop_reason, "unexpected");
    assert.equal(stopped.binding_json, old.binding_json);
    assert.equal(f.readRuntime().length, 1);
    assert.equal(f.state.workersAtRegistration[0][0].state, "closed");
    assert.equal(f.state.workersAtRegistration[0][0].stop_reason, "unexpected");
    const operations = new DatabaseSync(join(f.nodeHome, "node.sqlite"), { readOnly: true });
    assert.deepEqual({ ...operations.prepare("SELECT status,outcome,session_id FROM node_operations WHERE command_id=?").get(operationId) },
      { status: "uncertain", outcome: JSON.stringify({ ok: false, error: "old outcome" }), session_id: f.descriptor.binding.sessionId });
    operations.close();
    assert.equal(f.state.requests.some(({ path, body }) => path === "/api/nodes/events" && body.sessionEpoch === 2), false);
    assert.equal(f.state.requests.filter(({ path }) => path === "/api/nodes/mailbox/upload").length, uploads);
    const journal = new DatabaseSync(join(f.nodeHome, "worker-runtime", "node-workers.sqlite"), { readOnly: true });
    assert.equal(journal.prepare("SELECT status FROM worker_mailbox_bindings").get().status, "uncertain");
    journal.close();
  });
}

for (const failure of [401, 403, "malformed", "protocol", 400, 409, 302]) {
  test(`real node exits on fatal ${failure} instead of reconnecting`, async t => {
    const f = await fixture(t);
    f.state.failure = failure;
    const child = f.start();
    await once(child, "exit");
    assert.equal(child.exitCode, 1, f.output());
    assert.equal(f.state.requests.length, 1);
    assert.equal(f.output().includes("retrying"), false);
    assert.equal(f.output().includes("private-fixture-token"), false);
  });
}

for (const failure of [401, 403, "protocol"]) {
  test(`fatal ${failure} after startup still stops a live worker and exits`, async t => {
    const f = await fixture(t, true);
    const child = f.start();
    await waitFor(() => f.state.requests.some(({ path }) => path === "/api/nodes/mailbox/upload"));
    await waitFor(() => f.readRuntime()[0]?.state === "running");
    const worker = f.readRuntime()[0];
    f.state.failure = failure;
    await once(child, "exit");
    assert.equal(child.exitCode, 1, f.output());
    assert.throws(() => process.kill(worker.pid, 0), error => error.code === "ESRCH");
    assert.equal(f.output().includes("retrying"), false);
  });
}

test("DNS and network errors retry while TLS and redirect errors stay fatal", async t => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET"]) {
    t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("fixture"), { code }) }); });
    await assert.rejects(fetchJson(new URL("https://fixture.invalid"), "/api/nodes/session", "fixture", {}), CoordinatorUnavailable);
    t.mock.restoreAll();
  }
  for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UND_ERR_REDIRECT"]) {
    t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("fixture"), { code }) }); });
    await assert.rejects(fetchJson(new URL("https://fixture.invalid"), "/api/nodes/session", "fixture", {}), error => !(error instanceof CoordinatorUnavailable));
    t.mock.restoreAll();
  }
});

test("SIGTERM cancels a pending request without waiting for its seven-second timeout", async t => {
  const f = await fixture(t);
  f.state.failure = "timeout";
  const child = f.start();
  await waitFor(() => f.state.requests.length > 0);
  const exit = once(child, "exit");
  const started = Date.now();
  child.kill("SIGTERM");
  await exit;
  assert.ok(Date.now() - started < 1000, f.output());
  assert.equal(child.exitCode, 0);
});
