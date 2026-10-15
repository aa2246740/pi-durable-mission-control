import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";

async function waitFor(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Shutdown phase fixture timed out");
}

for (const phase of ["mailbox-upload", "mailbox-poll", "mailbox-ack", "runtime-poll", "worker-rpc", "idle"]) {
  test(`SIGTERM during ${phase} confirms the real node stop before the persisted deadline`, { timeout: 30000 }, async t => {
    const home = mkdtempSync(join(tmpdir(), "node-shutdown-phase-"));
    const coordinator = fork(new URL("./fixtures/shutdown-coordinator.mjs", import.meta.url), [home], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let output = "", node, armed = false, signalled = false, mailboxSeen = false;
    const requests = [], replies = [], messages = [];
    let outputAtReport;
    let inFlight = 0;
    coordinator.on("message", message => messages.push(message));
    coordinator.stderr.on("data", chunk => { output += chunk; });
    const closed = once(coordinator, "exit");
    const signal = () => { signalled = true; coordinator.kill("SIGTERM"); };
    const ready = await waitFor(() => messages.find(message => message.type === "ready"));
    const relay = createServer(async (request, response) => {
      inFlight++;
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const parsed = JSON.parse(body);
        const path = request.url;
        requests.push({ path, afterSignal: signalled });
        if (path.startsWith("/api/nodes/mailbox/")) mailboxSeen = true;
        const matches = phase === "mailbox-upload" ? path === "/api/nodes/mailbox/upload"
          : phase === "mailbox-poll" ? path === "/api/nodes/mailbox/poll"
          : phase === "mailbox-ack" ? path === "/api/nodes/mailbox/ack"
          : phase === "runtime-poll" ? path === "/api/nodes/runtimes/poll" && mailboxSeen
          : phase === "worker-rpc" ? path === "/api/nodes/mailbox/upload" && parsed.envelope?.payload.kind === "rpc"
          : false;
        if (armed && !signalled && matches) {
          signal();
          // Release this real request only after the shutdown transaction fenced the binding.
          await waitFor(() => {
            const db = new DatabaseSync(join(home, "control", "control.sqlite"), { readOnly: true });
            try { return db.prepare("SELECT 1 FROM remote_worker_runtimes WHERE desired='stop'").get(); }
            finally { db.close(); }
          });
        }
        const reply = await fetch(`http://127.0.0.1:${ready.port}${path}`, { method: "POST", headers: { authorization: request.headers.authorization, "content-type": "application/json" }, body });
        const value = await reply.text();
        replies.push({ path, status: reply.status });
        if (path === "/api/nodes/runtimes/events") outputAtReport = output;
        response.writeHead(reply.status, { "content-type": "application/json" }).end(value);
        if (armed && !signalled && phase === "idle" && path === "/api/nodes/mailbox/poll" && value === '{"envelopes":[]}') {
          setTimeout(() => {
            if (signalled || inFlight) return;
            const db = new DatabaseSync(join(home, "control", "control.sqlite"), { readOnly: true });
            try {
              const idle = db.prepare("SELECT 1 FROM agents WHERE json_extract(data,'$.machineId')='shutdown-node' AND status='idle'").get();
              if (idle) signal();
            } finally { db.close(); }
          }, 25);
        }
      } catch { response.destroy(); }
      finally { inFlight--; }
    });
    await new Promise(resolve => relay.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      if (node && node.exitCode === null && node.signalCode === null) { node.kill("SIGTERM"); await once(node, "exit"); }
      if (coordinator.exitCode === null && coordinator.signalCode === null) { coordinator.kill("SIGKILL"); await closed; }
      relay.closeAllConnections();
      await new Promise(resolve => relay.close(resolve));
      rmSync(home, { recursive: true, force: true });
    });
    const options = { coordinator: `http://127.0.0.1:${relay.address().port}`, machineId: ready.machine.id,
      tokenEnv: "SHUTDOWN_TEST_TOKEN", home: join(home, "node"), roots: [ready.root], credentialRefs: [], executionMode: "metadata-only", testOnlyScripted: true, testOnlyToolLoop: true };
    node = spawn(process.execPath, ["--input-type=module", "-e", `import { runNode } from ${JSON.stringify(new URL("../dist/node.js", import.meta.url).href)}; Math.random = () => 1; await runNode(${JSON.stringify(options)});`],
      { env: { ...process.env, SHUTDOWN_TEST_TOKEN: ready.token }, stdio: ["ignore", "pipe", "pipe"] });
    node.stderr.on("data", chunk => { output += chunk; });
    await waitFor(() => requests.some(request => request.path === "/api/nodes/poll"));
    armed = true;
    coordinator.send("assign");
    const assigned = await waitFor(() => messages.find(message => message.type === "assigned"));
    await waitFor(() => signalled).catch(error => { throw new Error(`${error.message}: ${JSON.stringify(replies)}\n${output}`); });
    await closed;
    assert.equal(coordinator.exitCode, 0, output);
    const control = new ControlPlane(join(home, "control"));
    try {
      const runtime = control.remoteRuntimes.byRuntime(assigned.binding.runtimeId);
      assert.equal(runtime.stop_provenance, "controlled", `${phase}: ${JSON.stringify(replies)}\n${output}`);
      assert.equal(runtime.state, "closed");
      const report = JSON.parse(runtime.last_report_json);
      assert.equal(report.outcome, "stopped");
      assert.equal(report.stopReason, "requested");
      assert.equal(report.binding.sessionId, assigned.binding.sessionId);
      assert.equal(requests.filter(request => request.path === "/api/nodes/session").length, 1);
      const stopping = control.detail(assigned.missionId).events.find(event => ["coordinator_stopping", "coordinator_stop_waiting"].includes(event.type));
      assert.equal(control.confirmedRemoteRuntimeStop(runtime.runtime_id), true);
      const confirmed = control.db.prepare("SELECT MIN(created_at) AS at FROM remote_worker_runtime_reports WHERE runtime_id=?").get(runtime.runtime_id);
      assert.ok(confirmed.at < stopping.data.deadlineAt);
      t.diagnostic(JSON.stringify({ phase, confirmedInMs: confirmed.at - (stopping.data.deadlineAt - 5000), deadlineMs: 5000 }));
      assert.equal(outputAtReport?.includes("retrying"), false,
        "Mailbox shutdown must not trigger global reconnect backoff before the report");
    } finally { control.close(); }
  });
}
