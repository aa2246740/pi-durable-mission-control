// Explicit Apple Container regression; outside npm test's glob.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "./run.mjs";

test("three consecutive worker-crash container runs stay fail-closed and clean up", { timeout: 900000 }, async () => {
  const parent = join(process.cwd(), ".acceptance-proof");
  mkdirSync(parent, { recursive: true });
  const stamp = Date.now();
  const results = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const proof = join(parent, `worker-crash-${stamp}-${attempt}`);
    const started = Date.now();
    try {
      const result = await run({ scenario: "worker-crash", keep: true, out: proof, timeoutMs: 180000 });
      results.push({ attempt, status: result.summary.status, missionStatus: result.summary.missionStatus, artifacts: result.summary.artifacts,
        stopProvenance: result.summary.stopProvenance, durationMs: Date.now() - started, cleanupVerified: result.summary.cleanupVerified, proof });
    } catch (error) {
      results.push({ attempt, status: "failed", durationMs: Date.now() - started, error: error.message, proof });
    }
    writeFileSync(join(parent, `worker-crash-results-${stamp}.json`), JSON.stringify(results, null, 2) + "\n");
  }
  assert.equal(results.filter((result) => result.status !== "passed").length, 0, JSON.stringify(results));
  assert.ok(results.every((result) => result.missionStatus === "failed" && result.artifacts === 0 && result.stopProvenance !== "controlled" && result.cleanupVerified === true));
});
