// Explicit Apple Container regression; outside npm test's glob.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "./run.mjs";
import { restartScenarios } from "./scenarios/coordinator-restart.mjs";

test("coordinator restart scenarios run twice each, then default, pause-resume and worker-crash, preserving every result", { timeout: 1800000 }, async () => {
  assert.match(process.env.MC_ACCEPTANCE_CONTAINER_PREFIX ?? "", /^mc-acc-[a-z0-9-]+-$/, "Use a task-owned container prefix");
  const parent = join(process.cwd(), ".acceptance-proof");
  mkdirSync(parent, { recursive: true });
  const stamp = Date.now();
  const results = [];
  for (const scenario of [...restartScenarios.flatMap((name) => [name, name]), "default", "pause-resume", "worker-crash"]) {
    const attempt = results.filter((result) => result.scenario === scenario).length + 1;
    const proof = join(parent, `${scenario}-${stamp}-${attempt}`);
    const started = Date.now();
    try {
      const { summary } = await run({ scenario, keep: true, out: proof, timeoutMs: 180000 });
      results.push({ scenario, attempt, ...summary, durationMs: Date.now() - started, proof });
    } catch (error) {
      let summary;
      try { summary = JSON.parse(readFileSync(join(proof, "summary.json"), "utf8")); }
      catch { summary = { status: "failed", cleanupVerified: false }; }
      results.push({ scenario, attempt, ...summary, durationMs: Date.now() - started, error: error.message, proof });
    }
    writeFileSync(join(parent, `coordinator-restart-results-${stamp}.json`), JSON.stringify(results, null, 2) + "\n");
    process.stdout.write(`restart regression ${scenario} #${attempt}: ${results.at(-1).status}, ${results.at(-1).durationMs} ms\n`);
  }
  assert.equal(results.filter((result) => result.status !== "passed").length, 0, JSON.stringify(results));
  assert.ok(results.every((result) => result.cleanupVerified === true));
  for (const result of results) {
    if (result.scenario === "restart-after-complete") assert.equal(result.coordinatorRestart.missionStatus, "completed");
    if (result.scenario === "coordinator-restart") assert.equal(result.outcome, "recovered");
    if (result.scenario === "coordinator-restart-kill") assert.equal(result.outcome, "irrecoverable");
    if (restartScenarios.includes(result.scenario)) {
      const evidence = JSON.parse(readFileSync(join(result.proof, "coordinator-restart.json"), "utf8"));
      if (result.scenario === "coordinator-restart-kill") {
        const runtime = evidence.snapshots.at(-1).runtimes[0];
        assert.equal(runtime.report.outcome, "stopped");
        assert.equal(runtime.report.stopReason, "unexpected");
      }
      assert.ok(evidence.restarts.every(({ nodeReconnect }) => nodeReconnect.explicit === false && nodeReconnect.previousPid === nodeReconnect.pid && nodeReconnect.previousSessionId !== nodeReconnect.sessionId));
    }
  }
});
