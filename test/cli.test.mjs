import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sentinel = "MISSION_CONTROL_CLI_SECRET_SENTINEL_7f9d2e";

function makeHome() {
  return mkdtempSync(join(tmpdir(), "mission-control-cli-"));
}

function runCli(args, { timeout = 12000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        reject(new Error(`CLI timed out: ${args.join(" ")}`));
      }
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code, signal, stdout, stderr });
      }
    });
  });
}

async function stopIfRecorded(home) {
  const recordPath = join(home, "daemon.json");
  if (!existsSync(recordPath)) return;
  const result = await runCli(["stop", "--home", home], { timeout: 35000 });
  if (result.code !== 0) throw new Error(`Could not stop test daemon: ${result.stderr}`);
}

async function waitForHealth(port, pid, daemonId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json();
      if (response.ok && health.pid === pid && health.daemonId === daemonId) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Daemon ${pid} did not report healthy identity ${daemonId}`);
}

async function postJson(port, token, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const value = await response.json();
  assert.equal(response.status, 201, JSON.stringify(value));
  return value;
}

test("start is detached and idempotent; status, export, and stop use the selected home", { timeout: 120000 }, async () => {
  const home = makeHome();
  try {
    const freshStatus = await runCli(["status", "--home", home]);
    assert.equal(freshStatus.code, 1);
    assert.match(freshStatus.stdout, /stopped/);
    assert.equal(existsSync(home), true);
    assert.equal(existsSync(join(home, "control.sqlite")), false);

    const warningScript = join(home, "stderr-warning.cjs");
    writeFileSync(warningScript, "if (process.argv.includes('serve')) process.stderr.write('ordinary NODE_OPTIONS warning\\n');\n", { mode: 0o600 });
    const warningEnv = { ...process.env, NODE_OPTIONS: `--require=${warningScript}` };
    const started = await runCli(["start", "--port", "0", "--home", home], { timeout: 40000, env: warningEnv });
    assert.equal(started.code, 0, started.stderr);
    const startedIdentity = /started pid=(\d+) port=(\d+) daemonId=([^\s]+)/.exec(started.stdout);
    assert.ok(startedIdentity, started.stdout);
    const [, pidText, portText, daemonId] = startedIdentity;
    const pid = Number(pidText);
    const port = Number(portText);
    assert.ok(pid > 0);
    assert.ok(port > 0);
    const recordPath = join(home, "daemon.json");
    const originalRecord = readFileSync(recordPath, "utf8");
    const info = JSON.parse(originalRecord);
    assert.equal(info.pid, pid);
    assert.equal(info.port, port);
    assert.equal(info.daemonId, daemonId);
    assert.match(readFileSync(join(home, "daemon.err.log"), "utf8"), /ordinary NODE_OPTIONS warning/);
    await waitForHealth(port, pid, daemonId);

    const repeated = await runCli(["start", "--home", home, "--port", "1"]);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stdout, new RegExp(`already running pid=${pid} port=${port} daemonId=${daemonId}`));
    assert.equal(readFileSync(recordPath, "utf8"), originalRecord);
    await waitForHealth(port, pid, daemonId);

    const status = await runCli(["status", "--home", home]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`running pid=${pid} port=${port}`));
    const healthyDoctor = await runCli(["doctor", "--home", home]);
    assert.equal(healthyDoctor.code, 0, healthyDoctor.stderr);
    assert.match(healthyDoctor.stdout, /daemon running \(identity confirmed\)/);
    assert.match(healthyDoctor.stdout, new RegExp(`daemon record pid=${pid} port=${port} daemonId=${daemonId}`));

    const workspacePath = join(home, "workspace");
    mkdirSync(workspacePath);
    const token = readFileSync(join(home, "admin.token"), "utf8").trim();
    const workspace = await postJson(port, token, "/api/workspaces", { name: "CLI argument fixture", path: workspacePath });
    const roleIds = ["cli-orchestrator", "cli-worker", "cli-validator"];
    for (const [index, kind] of ["orchestrator", "worker", "validator"].entries()) {
      await postJson(port, token, "/api/roles", {
        id: roleIds[index],
        name: `CLI ${kind}`,
        kind,
        instructions: "Isolated CLI parser test",
        profileId: "glm-4.7-coding"
      });
    }
    const mission = await postJson(port, token, "/api/missions", {
      title: "CLI export argument test",
      goal: "Prove --home is not mistaken for the positional mission ID",
      acceptance: "Export returns this mission",
      workspaceId: workspace.id,
      roleIds,
      maxTurns: 5,
      maxCost: 0,
      autonomy: "trusted"
    });
    const exported = await runCli(["export", "--home", home, mission.id]);
    assert.equal(exported.code, 0, exported.stderr);
    assert.match(exported.stdout, new RegExp(mission.id));
    assert.match(exported.stdout, /CLI export argument test/);

    const stopped = await runCli(["stop", "--home", home], { timeout: 35000 });
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.match(stopped.stdout, new RegExp(`stopped pid=${pid}`));
    assert.equal(existsSync(recordPath), false);
    try {
      process.kill(pid, 0);
      assert.fail(`daemon process ${pid} still exists after stop`);
    } catch (error) {
      assert.equal(error.code, "ESRCH");
    }
    const stoppedStatus = await runCli(["status", "--home", home]);
    assert.equal(stoppedStatus.code, 1);
    assert.match(stoppedStatus.stdout, /stopped/);
  } finally {
    await stopIfRecorded(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test("node CLI rejects unsafe coordinator URLs and secret-shaped unexpected arguments", async (t) => {
  const home = makeHome();
  const root = join(home, "root");
  mkdirSync(root);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, NODE_TEST_TOKEN: sentinel };
  const common = ["node", "--machine-id", "strict-node", "--token-env", "NODE_TEST_TOKEN",
    "--home", join(home, "node-home"), "--root", root];
  const unsafeUrl = await runCli([...common, "--coordinator", "http://localhost:4310"], { env });
  assert.equal(unsafeUrl.code, 1);
  assert.equal(`${unsafeUrl.stdout}${unsafeUrl.stderr}`.includes(sentinel), false);
  assert.equal(existsSync(join(home, "node-home", "node.sqlite")), false);
  for (const coordinator of [
    "http://127.0.0.2:4310",
    "https://user:pass@coordinator.example",
    `https://coordinator.example/?${sentinel}`
  ]) {
    const rejected = await runCli([...common, "--coordinator", coordinator], { env });
    assert.equal(rejected.code, 1);
    assert.equal(`${rejected.stdout}${rejected.stderr}`.includes(sentinel), false);
  }
  const unknownFlag = await runCli([...common, "--coordinator", "http://127.0.0.1:4310", "--unknown", sentinel], { env });
  assert.equal(unknownFlag.code, 1);
  assert.equal(`${unknownFlag.stdout}${unknownFlag.stderr}`.includes(sentinel), false);
  const positional = await runCli(["node", sentinel], { env });
  assert.equal(positional.code, 1);
  assert.equal(`${positional.stdout}${positional.stderr}`.includes(sentinel), false);
});

test("CLI start forwards optional node listener and records its separate port", { timeout: 120000 }, async () => {
  const home = makeHome();
  try {
    const started = await runCli(["start", "--home", home, "--port", "0", "--node-port", "0"], { timeout: 40000 });
    assert.equal(started.code, 0, started.stderr);
    const info = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
    assert.ok(info.nodePort > 0);
    assert.notEqual(info.nodePort, info.port);
    const nodeBootstrap = await fetch(`http://127.0.0.1:${info.nodePort}/api/bootstrap`);
    assert.equal(nodeBootstrap.status, 404);
    assert.equal(nodeBootstrap.headers.get("set-cookie"), null);
    const unchanged = await runCli(["start", "--home", home, "--node-port", "0"]);
    assert.equal(unchanged.code, 0, unchanged.stderr);
    const conflicting = await runCli(["start", "--home", home, "--node-port", String(info.port)]);
    assert.equal(conflicting.code, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")), info);
    const stopped = await runCli(["stop", "--home", home], { timeout: 35000 });
    assert.equal(stopped.code, 0, stopped.stderr);
    await assert.rejects(fetch(`http://127.0.0.1:${info.nodePort}/api/bootstrap`));
  } finally {
    await stopIfRecorded(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test("help, version, and invalid arguments do not create the requested home", async () => {
  const home = join(tmpdir(), `mission-control-cli-never-created-${process.pid}-${Date.now()}`);
  const help = await runCli(["--help", "--home", home]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: mission-control/);
  assert.match(help.stdout, /--execution-mode metadata-only/);
  assert.match(help.stdout, /--execution-mode metadata-only\|workspace-effects/);
  const invalidExecutionMode = await runCli([
    "node", "--coordinator", "http://127.0.0.1:4310", "--machine-id", "test-node",
    "--token-env", "NODE_TEST_TOKEN", "--home", home, "--root", "/", "--execution-mode", "full"
  ]);
  assert.equal(invalidExecutionMode.code, 1);
  assert.match(invalidExecutionMode.stderr, /--execution-mode must be metadata-only or workspace-effects/);
  const helpCommand = await runCli(["help", "--home", home]);
  assert.equal(helpCommand.code, 0);
  const version = await runCli(["--version", "--home", home]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);
  const inlineHelp = await runCli(["start", "--help", "--home", home]);
  assert.equal(inlineHelp.code, 0);

  const invalid = [
    ["start", "--home", home, "--unknown"],
    ["start", "--home", home, "--port"],
    ["start", "--home", home, "--port", "1.5"],
    ["start", "--home", home, "--port", "9007199254740992"],
    ["start", "--home", ""],
    ["start", "--home", home, "--port", "1", "--port", "2"],
    ["start", "--home", home, "unexpected"],
    ["status", "--home", home, "--port", "4310"],
    ["logs", "--home", home, "--lines", "0"],
    ["logs", "--home", home, "--lines", "10001"],
    ["export", "--home", home]
  ];
  for (const args of invalid) {
    const result = await runCli(args);
    assert.equal(result.code, 1, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  const doctor = await runCli(["doctor", "--home", home]);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, /home .*missing/);
  assert.match(doctor.stdout, /daemon record absent/);
  assert.equal(existsSync(home), false);
});

test("stale and malformed records are reported without signaling an unrelated live PID", { timeout: 20000 }, async () => {
  const home = makeHome();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const wrongIdentity = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ pid: (unrelated.pid ?? 0) + 1, daemonId: "00000000-0000-4000-8000-000000000002" }));
  });
  try {
    await once(unrelated, "spawn");
    assert.ok(unrelated.pid);
    await new Promise((resolve) => wrongIdentity.listen(0, "127.0.0.1", resolve));
    const address = wrongIdentity.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(join(home, "daemon.json"), JSON.stringify({
      pid: unrelated.pid,
      port: address.port,
      daemonId: "00000000-0000-4000-8000-000000000001",
      startedAt: new Date().toISOString()
    }), { mode: 0o600 });
    const status = await runCli(["status", "--home", home]);
    assert.equal(status.code, 1);
    assert.match(status.stdout, /stopped \(stale/);
    const staleDoctor = await runCli(["doctor", "--home", home]);
    assert.equal(staleDoctor.code, 0, staleDoctor.stderr);
    assert.match(staleDoctor.stdout, /daemon stale/);
    const refused = await runCli(["stop", "--home", home]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /refusing to signal/);
    process.kill(unrelated.pid, 0);
    assert.equal(unrelated.exitCode, null);

    writeFileSync(join(home, "daemon.json"), JSON.stringify({ pid: 0, port: 1, daemonId: "bad" }), { mode: 0o600 });
    const malformedStatus = await runCli(["status", "--home", home]);
    assert.equal(malformedStatus.code, 1);
    assert.match(malformedStatus.stdout, /unreadable daemon record/);
    const malformedStop = await runCli(["stop", "--home", home]);
    assert.equal(malformedStop.code, 1);
    assert.match(malformedStop.stderr, /refusing to signal any process/);
    process.kill(unrelated.pid, 0);
  } finally {
    if (wrongIdentity.listening) await new Promise((resolve, reject) => wrongIdentity.close((error) => error ? reject(error) : resolve()));
    if (unrelated.exitCode === null) {
      unrelated.kill("SIGTERM");
      await once(unrelated, "close");
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("start reports a bounded listen failure and does not leave its child behind", { timeout: 150000 }, async () => {
  const home = makeHome();
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  try {
    const started = await runCli(["start", "--home", home, "--port", String(address.port)], { timeout: 40000 });
    assert.equal(started.code, 1);
    assert.match(started.stderr, /startup error|did not report a healthy identity/);
    assert.doesNotMatch(started.stderr, /process \d+ is still running/);
    assert.match(readFileSync(join(home, "daemon.err.log"), "utf8"), /EADDRINUSE/);
    assert.equal(existsSync(join(home, "daemon.json")), false);
    assert.equal(occupied.listening, true);
    await new Promise((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    const recovered = await runCli(["start", "--home", home, "--port", "0"], { timeout: 40000 });
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.match(recovered.stdout, /started pid=/);
    const record = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
    await waitForHealth(record.port, record.pid, record.daemonId, 20000);
    const stopped = await runCli(["stop", "--home", home], { timeout: 35000 });
    assert.equal(stopped.code, 0, stopped.stderr);
  } finally {
    if (occupied.listening) await new Promise((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    await stopIfRecorded(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test("logs show a bounded redacted tail and doctor never displays secrets or opens state", async () => {
  const home = makeHome();
  try {
    const logPath = join(home, "daemon.out.log");
    const lines = Array.from({ length: 5000 }, (_, index) => `line-${index + 1}`).join("\n");
    const jsonSecret = "json quoted secret";
    const quotedToken = "quoted token with spaces";
    const bearerSecret = "bearer token with spaces";
    const environmentSecret = "KNOWN_ENV_API_SECRET_VALUE_123";
    writeFileSync(logPath, `${"x".repeat(512 * 1024)}\n${lines}\nAPI_KEY=${sentinel}\nadmin.token=${sentinel}\n{"API_KEY": "${jsonSecret}", "TOKEN": "${quotedToken}"}\nBearer "${bearerSecret}"\nraw ${environmentSecret}\ntail-marker\nend-marker\n`, { mode: 0o600 });
    writeFileSync(join(home, "admin.token"), sentinel, { mode: 0o600 });
    symlinkSync(join(home, "admin.token"), join(home, "daemon.err.log"));
    const mode = statSync(logPath).mode & 0o777;
    assert.equal(mode, 0o600);
    const logged = await runCli(["logs", "--home", home, "--lines", "7"], {
      env: { ...process.env, MISSION_CONTROL_TEST_API_KEY: environmentSecret }
    });
    assert.equal(logged.code, 0, logged.stderr);
    assert.match(logged.stdout, /end-marker/);
    assert.match(logged.stdout, /API_KEY=\[redacted\]/);
    assert.match(logged.stdout, /admin\.token=\[redacted\]/);
    assert.match(logged.stdout, /"API_KEY": "\[redacted\]"/);
    assert.match(logged.stdout, /"TOKEN": "\[redacted\]"/);
    assert.match(logged.stdout, /Bearer \[redacted\]/);
    for (const secret of [sentinel, jsonSecret, quotedToken, bearerSecret, environmentSecret]) {
      assert.doesNotMatch(logged.stdout, new RegExp(secret));
    }
    assert.doesNotMatch(logged.stdout, /line-5000/);
    assert.doesNotMatch(logged.stdout, /==> .*daemon\.err\.log <==/);

    writeFileSync(join(home, "control.sqlite"), "");
    mkdirSync(join(home, "agents"));
    const dbBefore = statSync(join(home, "control.sqlite"));
    const env = { ...process.env, MISSION_CONTROL_DOCTOR_SECRET_SENTINEL: sentinel };
    const diagnosis = await runCli(["doctor", "--home", home], { env });
    assert.equal(diagnosis.code, 0, diagnosis.stderr);
    assert.match(diagnosis.stdout, /node v\d+/);
    assert.match(diagnosis.stdout, /control database present/);
    assert.match(diagnosis.stdout, /admin token present/);
    assert.match(diagnosis.stdout, /daemon record absent/);
    assert.doesNotMatch(diagnosis.stdout, new RegExp(sentinel));
    assert.doesNotMatch(diagnosis.stderr, new RegExp(sentinel));
    const dbAfter = statSync(join(home, "control.sqlite"));
    assert.equal(dbAfter.size, dbBefore.size);
    assert.equal(dbAfter.mtimeMs, dbBefore.mtimeMs);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
