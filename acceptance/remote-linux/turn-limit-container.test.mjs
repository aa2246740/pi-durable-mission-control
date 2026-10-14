// Explicit Apple Container regression; outside npm test's glob.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "./run.mjs";

test("three consecutive remote AdmitTurn limits and both existing scenarios preserve acceptance and cleanup", { timeout: 1200000 }, async () => {
  assert.equal(process.env.MC_ACCEPTANCE_CONTAINER_PREFIX, "mc-acc-l1-gpt-", "Use the assigned container prefix");
  const parent = join(process.cwd(), ".acceptance-proof");
  mkdirSync(parent, { recursive: true });
  const stamp = Date.now();
  const results = [];
  for (const [index, scenario] of ["turn-limit", "turn-limit", "turn-limit", "default", "pause-resume"].entries()) {
    const proof = join(parent, `turn-limit-${stamp}-${index + 1}-${scenario}`);
    const started = Date.now();
    let error;
    try { await run({ scenario, keep: true, out: proof, timeoutMs: 180000 }); }
    catch (value) { error = value.message; }
    const summary = JSON.parse(readFileSync(join(proof, "summary.json"), "utf8"));
    results.push({ attempt: index + 1, scenario, status: summary.status, durationMs: Date.now() - started, cleanupVerified: summary.cleanupVerified, error, proof });
    writeFileSync(join(parent, `turn-limit-results-${stamp}.json`), JSON.stringify(results, null, 2) + "\n");
  }
  assert.ok(results.every((result) => result.cleanupVerified), JSON.stringify(results));
  assert.equal(results.filter((result) => result.status === "failed").length, 0, JSON.stringify(results));
});
