import assert from "node:assert/strict";
import { createServer } from "node:http";
import { localRelay } from "../acceptance/remote-linux/local-relay.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalBackend, localEnvironment, localUncovered, ProcessTree, readProcesses, sameProcess } from "../acceptance/remote-linux/local-process.mjs";
import { childProcess, commandOutput, parseOptions } from "../acceptance/remote-linux/run.mjs";
import { independentReview, sha256, tapPassed } from "../acceptance/remote-linux/real.mjs";

const temporary = (t) => { const path = mkdtempSync(join(tmpdir(), "mc-local-process-")); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
const wait = async (predicate) => { const deadline = Date.now() + 10000; while (!predicate()) { assert.ok(Date.now() < deadline, "Wait timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); } };

test("backend selection preserves container default and rejects unsupported names", () => {
  assert.equal(parseOptions([]).backend ?? "container", "container");
  for (const backend of ["container", "local-process"]) assert.equal(parseOptions(["--backend", backend]).backend, backend);
  assert.throws(() => parseOptions(["--backend", "docker"]), /--backend must be/);
  assert.throws(() => parseOptions(["--backend"]), /incomplete/);
});

test("local backend records isolation gaps and removes only its runtime directory", async (t) => {
  const proof = temporary(t);
  const marker = join(proof, "keep.json");
  writeFileSync(marker, "evidence");
  const backend = createLocalBackend({ root: process.cwd(), proof, childProcess, commandOutput });
  assert.ok(existsSync(backend.home));
  assert.equal(backend.platform, process.platform);
  const environment = localEnvironment();
  assert.equal(environment.architecture, process.arch);
  assert.ok(environment.availableParallelism > 0);
  assert.equal(environment.imposedResourceLimits, false);
  assert.equal(backend.uncovered.length, 4);
  assert.deepEqual(backend.uncovered, localUncovered);
  assert.ok(backend.uncovered.every((value) => value.startsWith("未覆盖：")));
  const result = await backend.cleanup();
  assert.equal(result.temporaryDirectoryRemoved, true);
  assert.equal(existsSync(join(proof, "local-runtime")), false);
  assert.equal(readFileSync(marker, "utf8"), "evidence");
});

test("process census distinguishes start identity and process group", () => {
  const entry = readProcesses().find((value) => value.pid === process.pid);
  assert.ok(entry && entry.identity && entry.pgid > 1);
  assert.equal(sameProcess(entry, { ...entry }), true);
  assert.equal(sameProcess(entry, { ...entry, identity: "other-start" }), false);
  assert.equal(sameProcess(entry, { ...entry, pgid: entry.pgid + 1 }), false);
});

test("whole-node kill closes descendants across detached process groups and preserves unrelated process", { timeout: 20000 }, async (t) => {
  const proof = temporary(t), ready = join(proof, "ready.json");
  const grandchild = `setInterval(()=>{},1000)`;
  const child = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({child:process.pid,grandchild:child.pid}));setInterval(()=>{},1000)`;
  const root = spawn(process.execPath, ["-e", `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)`], { detached: true, stdio: "ignore" });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  const done = new Promise((resolve) => root.on("close", resolve));
  const unrelatedDone = new Promise((resolve) => unrelated.on("close", resolve));
  const tree = new ProcessTree(root.pid);
  t.after(async () => { await tree.kill(); await done; unrelated.kill("SIGKILL"); await unrelatedDone; });
  await wait(() => existsSync(ready));
  const descendants = JSON.parse(readFileSync(ready, "utf8"));
  const result = await tree.kill();
  await done;
  assert.equal(result.closedDescendantSet, true);
  assert.equal(result.processesExited, true);
  assert.ok(result.processGroups.length >= 3);
  for (const pid of [root.pid, descendants.child, descendants.grandchild]) assert.ok(result.processes.some((entry) => entry.pid === pid));
  assert.deepEqual(tree.capture(), []);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});

test("local independent review executes frozen bytes in a fresh cwd and detects invalid output", async (t) => {
  const proof = temporary(t);
  const source = "import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';test('frozen value',()=>assert.equal(readFileSync('value.txt','utf8'),'42'));";
  const artifact = { id: "artifact", path: "/remote/value.txt", sha256: sha256("42") };
  const casPath = join(proof, "cas"); writeFileSync(casPath, "42");
  const acceptance = { source, sha256: sha256(source), tests: 1 };
  const receipt = { id: "receipt", exitCode: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n" };
  const executeLocal = async (file, cwd) => {
    assert.notEqual(cwd, process.cwd());
    assert.equal(readFileSync(join(cwd, "value.txt"), "utf8"), "42");
    const handle = childProcess(process.execPath, ["--test", "--test-reporter=tap", file], { PATH: process.env.PATH }, { cwd });
    await handle.done;
    return { exitCode: handle.child.exitCode, stdout: handle.stdout(), stderr: handle.stderr() };
  };
  const result = await independentReview({ proof, acceptance, artifact, casPath, receipt, backend: "local-process", executeLocal });
  assert.equal(result.passed, true, result.error);
  assert.equal(result.isolation, "fresh-process-frozen-copy");
  assert.equal(tapPassed(result.stdout, 1), true);
  const negative = join(proof, "negative"); mkdirSync(negative);
  const badSource = source.replace("'42'", "'43'");
  const bad = await independentReview({ proof: negative, acceptance: { source: badSource, sha256: sha256(badSource), tests: 1 }, artifact, casPath, receipt, backend: "local-process", executeLocal });
  assert.equal(bad.exitCode, 1);
  assert.equal(bad.passed, false);
  assert.equal(bad.agreesWithReceipt, false);
});


test("local runner timeout and interruption retain failed evidence after verified cleanup", { timeout: 30000 }, async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "mc-local-interrupt-"));
  const handles = [];
  t.after(async () => {
    for (const handle of handles) {
      if (handle.child.exitCode === null) handle.child.kill("SIGTERM");
      await handle.done;
    }
    rmSync(parent, { recursive: true, force: true });
  });
  for (const interrupt of [false, true]) {
    const proof = join(parent, interrupt ? "interrupt" : "timeout");
    const handle = childProcess(process.execPath, ["acceptance/remote-linux/run.mjs", "--backend", "local-process", "--out", proof,
      "--timeout-ms", interrupt ? "20000" : "1"], { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: parent });
    handles.push(handle);
    if (interrupt) {
      await wait(() => readProcesses().some((entry) => entry.command.some((arg) => arg.startsWith(proof)) && entry.command.some((arg) => arg.endsWith("/local-bootstrap.mjs"))));
      handle.child.kill("SIGINT");
    }
    await handle.done;
    assert.equal(handle.child.exitCode, 1, handle.output());
    const summary = JSON.parse(readFileSync(join(proof, "summary.json"), "utf8"));
    assert.equal(summary.backend, "local-process");
    assert.equal(summary.status, "failed");
    assert.match(summary.error, interrupt ? /Interrupted by SIGINT/ : /timed out/);
    assert.equal(summary.cleanupVerified, true, handle.output());
    assert.equal(existsSync(join(proof, "local-runtime")), false);
    assert.equal(readProcesses().some((entry) => entry.command.some((arg) => arg.startsWith(proof))), false);
  }
});


test("loopback relay forwards real runtime polls immediately and keeps credentials private", async (t) => {
  const stopped = false;
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, credential: request.headers.authorization, body: Buffer.concat(chunks).toString(), stopped });
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ stopped }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const relay = await localRelay(server.address().port);
  t.after(async () => { await relay.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${relay.port}/api/nodes/runtimes/poll`, { method: "POST", headers: { authorization: "Bearer unit-private-token" }, body: "real-poll-body" });
  assert.deepEqual(await response.json(), { stopped: false });
  assert.deepEqual(requests, [{ path: "/api/nodes/runtimes/poll", credential: "Bearer unit-private-token", body: "real-poll-body", stopped: false }]);
  assert.equal(JSON.stringify(relay.observations).includes("unit-private-token"), false);
  assert.deepEqual(relay.observations.map(({ phase }) => phase), ["request", "response"]);
});

test("closing the local relay destroys an in-flight request without a synchronization gate", async t => {
  let received;
  const pending = new Promise(resolve => { received = resolve; });
  const server = createServer(() => received());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const relay = await localRelay(server.address().port);
  t.after(async () => { await relay.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = assert.rejects(fetch(`http://127.0.0.1:${relay.port}/api/nodes/runtimes/poll`, { method: "POST", body: "{}" }));
  await pending;
  await relay.close();
  await request;
});
