// Explicit Apple Container regression; outside npm test's glob.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "./run.mjs";

test("three node power losses, default and worker-crash retain fail-closed behavior", { timeout: 1100000 }, async () => {
  const parent = join(process.cwd(), ".acceptance-proof");
  mkdirSync(parent, { recursive: true });
  const stamp = Date.now();
  const results = [];
  for (const [index, scenario] of ["node-power-loss", "node-power-loss", "node-power-loss", "default", "worker-crash"].entries()) {
    const proof = join(parent, `node-power-loss-${stamp}-${index + 1}-${scenario}`);
    const keep = index !== 2;
    const started = Date.now();
    try {
      const result = await run({ scenario, keep, out: proof, timeoutMs: 180000 });
      assert.equal(existsSync(proof), keep, "Successful evidence cleanup did not follow --keep");
      assert.equal(existsSync(join(proof, "node-home")), keep && scenario === "node-power-loss", "Persistent home did not follow evidence cleanup");
      results.push({ attempt: index + 1, scenario, ...result.summary, durationMs: Date.now() - started, proof, retained: keep });
    } catch (error) {
      const summary = existsSync(join(proof, "summary.json")) ? JSON.parse(readFileSync(join(proof, "summary.json"), "utf8")) : {};
      results.push({ attempt: index + 1, scenario, ...summary, status: "failed", durationMs: Date.now() - started, error: error.message, proof, retained: existsSync(proof) });
    }
    writeFileSync(join(parent, `node-power-loss-results-${stamp}.json`), JSON.stringify(results, null, 2) + "\n");
  }
  assert.equal(results.filter((result) => result.status !== "passed").length, 0, JSON.stringify(results));
  assert.ok(results.every((result) => result.cleanupVerified));
  assert.ok(results.filter((result) => result.scenario === "node-power-loss").every((result) => result.missionStatus === "failed" && result.artifacts === 0 && result.recoverable === false));
});
