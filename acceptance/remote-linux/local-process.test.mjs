// Explicit end-to-end gate for Linux/macOS. Excluded from npm test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const results = [];
const parent = join(process.cwd(), ".acceptance-proof", `local-process-${Date.now()}`);
mkdirSync(parent, { recursive: true });
const cases = ["default", "pause-resume", "turn-limit", "worker-crash", "restart-after-complete", "coordinator-restart", "coordinator-restart-kill", "node-power-loss"]
  .map((scenario) => ({ scenario }));
for (const model of ["minimax", "glm"]) for (const negative of [false, true]) cases.push({ model, negative });
for (const item of cases) {
  const label = item.scenario ?? `${item.model}-${item.negative ? "negative" : "positive"}`;
  test(`local-process ${label}`, { timeout: 240000 }, async () => {
    const options = { backend: "local-process", timeoutMs: 180000, keep: true, ...(item.scenario ? { scenario: item.scenario } : {
      real: join(process.cwd(), `acceptance/remote-linux/real-${item.model}.json`), rehearsal: true,
      rehearsalWrongImplementation: item.negative
    }) };
    const code = `import {run} from './acceptance/remote-linux/run.mjs';run(${JSON.stringify(options)}).catch(error=>{console.error(error.message);process.exitCode=1});`;
    const start = Date.now();
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir() }, stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    writeFileSync(join(parent, `${label}.log`), output, { mode: 0o600 });
    const summaryLine = output.split("\n").find((line) => line.startsWith("summary "));
    assert.ok(summaryLine, output);
    const summary = JSON.parse(summaryLine.slice(8));
    const retained = output.split("\n").find((line) => line.startsWith("proof "));
    assert.ok(retained, "Run must retain reviewable evidence");
    renameSync(retained.slice(6), join(parent, `${label}-proof`));
    results.push({ ...item, exitCode, durationMs: Date.now() - start, summary });
    writeFileSync(join(parent, "results.json"), JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
    assert.equal(summary.backend, "local-process");
    assert.equal(summary.uncovered.length, 4);
    assert.equal(summary.cleanupVerified, true, output);
    assert.equal(summary.localCleanup.processesExited, true);
    assert.equal(summary.localCleanup.temporaryDirectoryRemoved, true);
    assert.equal(exitCode === 0, !item.negative, output);
    assert.equal(summary.status, item.negative ? "failed" : "passed", output);
    if (item.negative) assert.match(summary.error, /Frozen acceptance failed/);
    if (item.model && !item.negative) {
      assert.equal(summary.evidenceComplete, true);
      assert.equal(summary.independentReview.passed, true);
      assert.deepEqual(summary.oracleTouches, []);
    }
    console.log(`local-process result ${JSON.stringify({ ...item, durationMs: Date.now() - start, exitCode, cleanupVerified: summary.cleanupVerified })}`);
  });
}
