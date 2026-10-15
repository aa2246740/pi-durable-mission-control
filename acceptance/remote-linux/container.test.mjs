// Explicit Apple Container acceptance only; this file is outside npm test's glob.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

test("Apple Container remote Linux frozen mission completes and cleans up", { timeout: 240000 }, async (t) => {
  const parent = join(process.cwd(), ".acceptance-proof");
  mkdirSync(parent, { recursive: true });
  const keep = process.env.MC_ACCEPTANCE_TEST_KEEP === "1";
  const proof = join(parent, `run-${Date.now()}${keep ? " 'quoted" : ""}`);
  const before = readdirSync(parent).sort();
  const args = keep ? ["--keep", "--out", proof] : [];
  const child = spawn(process.execPath, ["acceptance/remote-linux/run.mjs", ...args], {
    env: { ...process.env, TMPDIR: parent }, stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, output);
  assert.match(output, /cleanup verified/);
  const summary = JSON.parse(output.split("\n").find((line) => line.startsWith("summary ")).slice(8));
  assert.equal(summary.missionStatus, "completed");
  assert.equal(summary.taskStatus, "accepted");
  assert.equal(summary.cleanupVerified, true);
  assert.equal(summary.snapshotIntegrity, true);
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.blockers, 0);
  assert.equal(summary.validatorRequestedUserInput, false);
  assert.equal(summary.platform, "linux");
  assert.equal(summary.liveSourceChanged, true);
  assert.equal(summary.remoteRuntimeState, "closed");
  if (keep) {
    assert.equal(existsSync(proof), true, "--keep must preserve evidence");
    assert.deepEqual(JSON.parse(readFileSync(join(proof, "summary.json"), "utf8")), summary);
    assert.equal(existsSync(join(proof, "home/admin.token")), false);
    rmSync(proof, { recursive: true });
  }
  assert.deepEqual(readdirSync(parent).sort(), before, "Successful default run must remove its evidence directory");
  process.stdout.write(`acceptance result ${JSON.stringify(summary)}\n`);
});
