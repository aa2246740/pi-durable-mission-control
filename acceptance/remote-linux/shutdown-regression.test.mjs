import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "./run.mjs";

test("unsynchronized coordinator shutdown recovers on both backends at three signal offsets while SIGKILL stays irrecoverable", { timeout: 1800000 }, async () => {
  const parent = join(process.cwd(), ".acceptance-proof", `shutdown-${Date.now()}`);
  mkdirSync(parent, { recursive: true });
  const results = [];
  for (const backend of ["container", "local-process"]) {
    for (const [index, delayMs] of [0, 37, 131, 0].entries()) {
      const scenario = index === 3 ? "coordinator-restart-kill" : "coordinator-restart";
      const proof = join(parent, `${backend}-${scenario}-${index + 1}`);
      const started = Date.now();
      try {
        const { summary } = await run({ backend, scenario, coordinatorRestartDelayMs: delayMs, keep: true, out: proof, timeoutMs: 180000 });
        const evidence = JSON.parse(readFileSync(join(proof, "coordinator-restart.json"), "utf8"));
        assert.equal(evidence.restarts[0].stopSynchronization, "none");
        assert.equal(evidence.restarts[0].signalDelayMs, delayMs);
        assert.equal(summary.outcome, index === 3 ? "irrecoverable" : "recovered");
        assert.equal(summary.cleanupVerified, true);
        results.push({ backend, scenario, delayMs, status: summary.status, outcome: summary.outcome, durationMs: Date.now() - started, proof });
      } catch (error) {
        results.push({ backend, scenario, delayMs, status: "failed", durationMs: Date.now() - started, error: error.message, proof });
      }
      writeFileSync(join(parent, "results.json"), JSON.stringify(results, null, 2) + "\n");
      process.stdout.write(`${backend} ${scenario} +${delayMs}ms: ${JSON.stringify(results.at(-1))}\n`);
    }
  }
  assert.equal(results.length, 8);
  assert.ok(results.every(result => result.status === "passed"), JSON.stringify(results));
});
