import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { terminateOwnChild } from "../dist/cli.js";
import { tryAcquireDaemonOwnership } from "../dist/control.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const daemonId = "11111111-1111-4111-8111-111111111111";

async function runCli(args) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  return { code, stdout, stderr };
}

test("startup cleanup never signals an already exited child", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  await once(child, "exit");
  child.kill = () => { assert.fail("must not signal an exited child"); };
  assert.equal(await terminateOwnChild(child), true);
  assert.equal(child.exitCode, 7);
});

test("startup cleanup waits for its own child exit event", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  assert.equal(await terminateOwnChild(child), true);
  assert.equal(child.signalCode, "SIGTERM");
});

async function fixture(t, rejectShutdown = false) {
  const home = mkdtempSync(join(tmpdir(), "mc-cli-stop-"));
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(unrelated, "spawn");
  let ownership = tryAcquireDaemonOwnership(home);
  let shutdownRequested = false;
  let releaseTimer;
  const server = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ pid: unrelated.pid, daemonId }));
    } else {
      assert.equal(request.url, "/api/daemon/stop");
      assert.equal(request.method, "POST");
      assert.equal(request.headers.authorization, "Bearer test-admin-token");
      assert.equal(request.headers["x-mission-control-daemon-id"], daemonId);
      shutdownRequested = true;
      response.writeHead(rejectShutdown ? 409 : 202).end();
      if (!rejectShutdown) {
        // The record disappears while the old PID is still an unrelated live process.
        unlinkSync(join(home, "daemon.json"));
        releaseTimer = setTimeout(() => { ownership.close(); ownership = undefined; }, 700);
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(home, "admin.token"), "test-admin-token");
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: unrelated.pid, port: server.address().port, daemonId }));
  t.after(async () => {
    clearTimeout(releaseTimer);
    ownership?.close();
    await new Promise((resolve) => server.close(resolve));
    unrelated.kill("SIGTERM");
    await once(unrelated, "close");
    rmSync(home, { recursive: true, force: true });
  });
  return { home, unrelated, shutdownRequested: () => shutdownRequested, ownershipReleased: () => ownership === undefined };
}

test("stop waits for ownership release after record removal despite an unrelated live recorded PID", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const result = await runCli(["stop", "--home", f.home]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.shutdownRequested(), true);
  assert.equal(f.ownershipReleased(), true, "record removal alone must not confirm stop");
  assert.match(result.stdout, /ownership lock released/);
  assert.equal(f.unrelated.exitCode, null);
  assert.equal(f.unrelated.signalCode, null);
});

test("identity change after health probe refuses shutdown without signaling the reused PID", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, true);
  const result = await runCli(["stop", "--home", f.home]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 409.*refusing to signal/);
  assert.equal(f.shutdownRequested(), true);
  assert.equal(f.ownershipReleased(), false);
  assert.equal(f.unrelated.exitCode, null);
  assert.equal(f.unrelated.signalCode, null);
});

test("daemon shutdown requires administrator authentication and matching incarnation on the admin listener", { timeout: 30000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-cli-auth-stop-"));
  try {
    const started = await runCli(["start", "--home", home, "--port", "0", "--node-port", "0"]);
    assert.equal(started.code, 0, started.stderr);
    const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
    const token = readFileSync(join(home, "admin.token"), "utf8").trim();
    for (const [method, headers, expected] of [
      ["POST", {}, 403],
      ["POST", { authorization: "Bearer wrong" }, 403],
      ["POST", { authorization: `Bearer ${"x".repeat(token.length)}` }, 403],
      ["POST", { authorization: token }, 403],
      ["POST", { authorization: `Bearer ${token}` }, 409],
      ["GET", { authorization: `Bearer ${token}` }, 403],
      ["POST", { authorization: `Bearer ${token}`, "x-mission-control-daemon-id": daemonId }, 409],
      ["POST", { authorization: `Bearer ${token}`, "x-mission-control-daemon-id": info.daemonId, origin: `http://127.0.0.1:${info.port}` }, 403],
      ["POST", { authorization: `Bearer ${token}`, "x-mission-control-daemon-id": info.daemonId, origin: "invalid-origin" }, 403],
      ["POST", { authorization: `Bearer ${token}`, "x-mission-control-daemon-id": info.daemonId, cookie: "session=browser" }, 403],
      ["POST", { authorization: `Bearer ${token}`, "x-mission-control-daemon-id": info.daemonId, "sec-fetch-site": "same-origin" }, 403]
    ]) {
      const response = await fetch(`http://127.0.0.1:${info.port}/api/daemon/stop`, { method, headers });
      assert.equal(response.status, expected);
      await response.body?.cancel();
      const health = await fetch(`http://127.0.0.1:${info.port}/api/health`);
      assert.equal((await health.json()).daemonId, info.daemonId);
    }
    for (const host of ["attacker.invalid", "127.0.0.1", `localhost:${info.nodePort}`]) {
      const badHostStatus = await new Promise((resolve, reject) => {
        const call = request(`http://127.0.0.1:${info.port}/api/daemon/stop`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "x-mission-control-daemon-id": info.daemonId, host }
        }, (response) => { response.resume(); resolve(response.statusCode); });
        call.on("error", reject);
        call.end();
      });
      assert.equal(badHostStatus, 403, host);
    }
    const nodeResponse = await fetch(`http://127.0.0.1:${info.nodePort}/api/daemon/stop`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "x-mission-control-daemon-id": info.daemonId }
    });
    assert.equal(nodeResponse.status, 404);
    await nodeResponse.body?.cancel();
  } finally {
    const stopped = await runCli(["stop", "--home", home]);
    assert.equal(stopped.code, 0, stopped.stderr);
    rmSync(home, { recursive: true, force: true });
  }
});
