import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ControlPlane } from "../dist/control.js";
import { probe, readDaemonRecord } from "../dist/daemon.js";
import { generateLaunchAgentPlist, serviceLabel } from "../dist/service.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(file, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function runCli(args, env = process.env) {
  return run(process.execPath, [cli, ...args], env);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealthy(home, previousPid, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readDaemonRecord(home);
    if (record.state === "present" && record.info.pid !== previousPid && await probe(record.info)) return record.info;
    await delay(100);
  }
  throw new Error(`No replacement daemon became healthy in ${timeoutMs} ms`);
}

async function waitForPidExit(pid, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
    }
    await delay(100);
  }
  throw new Error(`Test daemon pid ${pid} did not exit during cleanup`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mission-control-service-"));
  const home = join(root, "home");
  const agents = join(root, "LaunchAgents");
  mkdirSync(home);
  mkdirSync(agents);
  const label = serviceLabel(home);
  const plist = join(agents, `${label}.plist`);
  const env = { ...process.env, MISSION_CONTROL_LAUNCH_AGENTS_DIR: agents };
  return { root, home, agents, label, plist, env, domainLabel: `gui/${process.getuid()}/${label}` };
}

async function cleanupFixture(f) {
  let failure;
  try {
    await run("/bin/launchctl", ["bootout", f.domainLabel], f.env);
    let record = readDaemonRecord(f.home);
    if (record.state === "present" && await probe(record.info)) {
      const stopped = await runCli(["stop", "--home", f.home], f.env);
      if (stopped.code !== 0 && await probe(record.info)) {
        try { process.kill(record.info.pid, "SIGTERM"); } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await waitForPidExit(record.info.pid);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const loaded = await run("/bin/launchctl", ["print", f.domainLabel], f.env);
      if (loaded.code !== 0) break;
      await run("/bin/launchctl", ["bootout", f.domainLabel], f.env);
    }
    const stillLoaded = await run("/bin/launchctl", ["print", f.domainLabel], f.env);
    assert.notEqual(stillLoaded.code, 0, `test LaunchAgent remained loaded: ${f.label}`);
  } catch (error) {
    failure = error;
  } finally {
    try { unlinkSync(f.plist); } catch (error) {
      if (error.code !== "ENOENT" && !failure) failure = error;
    }
    assert.equal(existsSync(f.plist), false, `test plist remains: ${f.plist}`);
    rmSync(f.root, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

test("plist generation escapes XML and limits launchd environment", () => {
  const plist = generateLaunchAgentPlist({
    label: "ai.mission-control.test&<>",
    executable: "/opt/node & runtime",
    cliPath: "/app/mission<control>.js",
    home: "/tmp/home&<>\"'",
    port: 0,
    environment: { PATH: "/usr/bin:/bin", HOME: "/Users/test", LANG: "en_US.UTF-8", TOKEN: "secret" }
  });
  assert.match(plist, /ai\.mission-control\.test&amp;&lt;&gt;/);
  assert.match(plist, /\/opt\/node &amp; runtime/);
  assert.match(plist, /\/app\/mission&lt;control&gt;\.js/);
  assert.match(plist, /\/tmp\/home&amp;&lt;&gt;&quot;&apos;/);
  const argumentBlock = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  assert.ok(argumentBlock);
  assert.deepEqual([...argumentBlock.matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]), [
    "/opt/node &amp; runtime", "/app/mission&lt;control&gt;.js", "serve", "--home", "/tmp/home&amp;&lt;&gt;&quot;&apos;", "--port", "0"
  ]);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  const envBlock = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1];
  assert.ok(envBlock);
  assert.deepEqual([...envBlock.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]), ["PATH", "HOME", "LANG"]);
  assert.doesNotMatch(envBlock, /TOKEN|SECRET|CREDENTIAL/i);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.match(plist, /<key>ExitTimeOut<\/key>\s*<integer>30<\/integer>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
});

test("LaunchAgent install is idempotent, restarts crashes, respects stop, and uninstalls on macOS", { skip: process.platform !== "darwin" }, async () => {
  const f = fixture();
  try {
    const installed = await runCli(["service", "install", "--home", f.home, "--port", "0"], f.env);
    assert.equal(installed.code, 0, `${installed.stdout}\n${installed.stderr}`);
    assert.match(installed.stdout, /configuration loaded for the current GUI session/);
    assert.match(installed.stdout, /has not been verified/);
    assert.equal(existsSync(f.plist), true);
    assert.equal(statSync(f.plist).mode & 0o777, 0o600);

    const first = readDaemonRecord(f.home);
    assert.equal(first.state, "present");
    assert.equal(await probe(first.info), true);

    const repeated = await runCli(["service", "install", "--home", f.home, "--port", "0"], f.env);
    assert.equal(repeated.code, 0, `${repeated.stdout}\n${repeated.stderr}`);
    assert.match(repeated.stdout, /already installed/);
    assert.equal(readDaemonRecord(f.home).info.pid, first.info.pid);

    process.kill(first.info.pid, "SIGKILL");
    const restarted = await waitForHealthy(f.home, first.info.pid);
    assert.notEqual(restarted.pid, first.info.pid);

    const stopped = await runCli(["stop", "--home", f.home], f.env);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    await delay(15000);
    const status = await runCli(["service", "status", "--home", f.home], f.env);
    assert.equal(status.code, 1, `${status.stdout}\n${status.stderr}`);
    assert.match(status.stdout, /LaunchAgent .*: loaded/);
    assert.match(status.stdout, /Daemon: stopped/);

    const resumed = await runCli(["service", "start", "--home", f.home], f.env);
    assert.equal(resumed.code, 0, `${resumed.stdout}\n${resumed.stderr}`);
    assert.match(resumed.stdout, /started daemon pid=/);
    const resumedRecord = readDaemonRecord(f.home);
    assert.equal(resumedRecord.state, "present");
    assert.notEqual(resumedRecord.info.pid, restarted.pid);

    const repeatedStart = await runCli(["service", "start", "--home", f.home], f.env);
    assert.equal(repeatedStart.code, 0, `${repeatedStart.stdout}\n${repeatedStart.stderr}`);
    assert.match(repeatedStart.stdout, /already healthy/);
    assert.equal(readDaemonRecord(f.home).info.pid, resumedRecord.info.pid);

    const removed = await runCli(["service", "uninstall", "--home", f.home], f.env);
    assert.equal(removed.code, 0, `${removed.stdout}\n${removed.stderr}`);
    assert.equal(existsSync(f.plist), false);
    await waitForPidExit(resumedRecord.info.pid);
    const launchctl = await run("/bin/launchctl", ["print", f.domainLabel], f.env);
    assert.notEqual(launchctl.code, 0, launchctl.stdout + launchctl.stderr);
  } finally {
    await cleanupFixture(f);
  }
});

test("service refuses an unconfirmed live daemon without touching launchd", { skip: process.platform !== "darwin" }, async () => {
  const f = fixture();
  const control = new ControlPlane(f.home);
  try {
    writeFileSync(join(f.home, "daemon.json"), JSON.stringify({
      pid: process.pid,
      port: 65534,
      daemonId: "11111111-1111-4111-8111-111111111111",
      startedAt: new Date().toISOString()
    }), { mode: 0o600 });
    const status = await runCli(["service", "status", "--home", f.home], f.env);
    assert.equal(status.code, 1);
    assert.match(status.stdout, /unavailable\/unconfirmed/);
    const result = await runCli(["service", "install", "--home", f.home, "--port", "0"], f.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ownership lock .* held but its identity is unconfirmed/);
    assert.equal(existsSync(f.plist), false);
    const launchctl = await run("/bin/launchctl", ["print", f.domainLabel], f.env);
    assert.notEqual(launchctl.code, 0);
  } finally {
    control.close();
    await cleanupFixture(f);
  }
});

test("service ignores a stale record pointing at an unrelated live PID", { skip: process.platform !== "darwin" }, async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.home, "daemon.json"), JSON.stringify({
      pid: process.pid,
      port: 65534,
      daemonId: "11111111-1111-4111-8111-111111111111",
      startedAt: new Date().toISOString()
    }), { mode: 0o600 });
    const status = await runCli(["service", "status", "--home", f.home], f.env);
    assert.equal(status.code, 1);
    assert.match(status.stdout, /Daemon: stopped/);
    const result = await runCli(["service", "install", "--home", f.home, "--port", "0"], f.env);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const record = readDaemonRecord(f.home);
    assert.equal(record.state, "present");
    assert.notEqual(record.info.pid, process.pid);
    assert.equal(await probe(record.info), true);
    const stopped = await runCli(["stop", "--home", f.home], f.env);
    assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
    writeFileSync(join(f.home, "daemon.json"), JSON.stringify({ ...record.info, pid: process.pid }), { mode: 0o600 });
    const removed = await runCli(["service", "uninstall", "--home", f.home], f.env);
    assert.equal(removed.code, 0, removed.stdout + removed.stderr);
    assert.equal(existsSync(f.plist), false);
    process.kill(process.pid, 0);
  } finally {
    await cleanupFixture(f);
  }
});

test("service refuses an occupied home even without a daemon record", { skip: process.platform !== "darwin" }, async () => {
  const f = fixture();
  const control = new ControlPlane(f.home);
  try {
    for (const malformed of [false, true]) {
      if (malformed) writeFileSync(join(f.home, "daemon.json"), "malformed");
      const status = await runCli(["service", "status", "--home", f.home], f.env);
      assert.equal(status.code, 1);
      assert.match(status.stdout, /unavailable\/unconfirmed.*ownership lock is held/);
      assert.doesNotMatch(status.stdout, /is still alive/);
    }
    unlinkSync(join(f.home, "daemon.json"));
    const result = await runCli(["service", "install", "--home", f.home, "--port", "0"], f.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /ownership lock .* held/);
    assert.equal(existsSync(f.plist), false);
  } finally {
    control.close();
    await cleanupFixture(f);
  }
});

test("service refuses symlinked launch logs without touching the target or launchd", { skip: process.platform !== "darwin" }, async () => {
  const f = fixture();
  const target = join(f.root, "log-target");
  const original = "must remain unchanged\n";
  try {
    writeFileSync(target, original, { mode: 0o600 });
    symlinkSync(target, join(f.home, "daemon.out.log"));
    const result = await runCli(["service", "install", "--home", f.home, "--port", "0"], f.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /regular file/);
    assert.equal(lstatSync(join(f.home, "daemon.out.log")).isSymbolicLink(), true);
    assert.equal(readFileSync(target, "utf8"), original);
    assert.equal(existsSync(f.plist), false);
    const launchctl = await run("/bin/launchctl", ["print", f.domainLabel], f.env);
    assert.notEqual(launchctl.code, 0);
  } finally {
    await cleanupFixture(f);
  }
});

test("service lifecycle lease rejects concurrent operations before launchd activity", { skip: process.platform !== "darwin" }, async () => {
  const f = fixture();
  const originalPlist = "pre-existing test plist\n";
  writeFileSync(f.plist, originalPlist, { mode: 0o600 });
  const lease = new DatabaseSync(join(f.home, "service.ownership.sqlite"), { timeout: 0 });
  lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  try {
    const result = await runCli(["service", "install", "--home", f.home, "--port", "0"], f.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already in progress/);
    assert.equal(readFileSync(f.plist, "utf8"), originalPlist);
    const launchctl = await run("/bin/launchctl", ["print", f.domainLabel], f.env);
    assert.notEqual(launchctl.code, 0);
  } finally {
    lease.exec("ROLLBACK");
    lease.close();
    await cleanupFixture(f);
  }
});

test("service install refuses a different existing plist without changing it on macOS", { skip: process.platform !== "darwin" }, async () => {
  const f = fixture();
  const contents = "user-owned conflicting plist\n";
  try {
    writeFileSync(f.plist, contents, { mode: 0o600 });
    const result = await runCli(["service", "install", "--home", f.home, "--port", "0"], f.env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already exists with different content/);
    assert.equal(readFileSync(f.plist, "utf8"), contents);
  } finally {
    await cleanupFixture(f);
  }
});
