// Explicit Apple Container regression; outside npm test's glob.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "./run.mjs";
import { restartScenarios } from "./scenarios/coordinator-restart.mjs";

test("coordinator restart scenarios run twice each, then default, preserving every result", { timeout: 1500000 }, async () => {
  assert.equal(process.env.MC_ACCEPTANCE_CONTAINER_PREFIX, "mc-acc-s1-gpt-", "Use the task-owned container prefix");
  const parent = join(process.cwd(), ".acceptance-proof");
  mkdirSync(parent, { recursive: true });
  const stamp = Date.now();
  const results = [];
  for (const scenario of [...restartScenarios.flatMap((name) => [name, name]), "default"]) {
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
    if (result.scenario.startsWith("coordinator-restart")) assert.ok(["irrecoverable", "recovered"].includes(result.outcome));
  }
});
