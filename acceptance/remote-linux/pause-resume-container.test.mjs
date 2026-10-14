// Explicit Apple Container regression; outside npm test's glob.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "./run.mjs";

test("five consecutive pause-resume container runs preserve outcomes and cleanup evidence", { timeout: 1200000 }, async () => {
  const parent = join(process.cwd(), ".acceptance-proof");
  mkdirSync(parent, { recursive: true });
  const stamp = Date.now();
  const results = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const proof = join(parent, `pause-${stamp}-${attempt}`);
    const started = Date.now();
    try {
      const result = await run({ scenario: "pause-resume", keep: true, out: proof, timeoutMs: 180000 });
      results.push({ attempt, status: result.summary.status, durationMs: Date.now() - started, proof });
    } catch (error) {
      results.push({ attempt, status: "failed", durationMs: Date.now() - started, error: error.message, proof });
    }
    writeFileSync(join(parent, `pause-results-${stamp}.json`), JSON.stringify(results, null, 2) + "\n");
  }
  assert.equal(results.filter((result) => result.status === "failed").length, 0, JSON.stringify(results));
});
