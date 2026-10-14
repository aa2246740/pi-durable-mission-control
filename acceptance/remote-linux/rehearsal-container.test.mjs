// Explicit Apple Container rehearsal, excluded from npm test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commandOutput } from "./run.mjs";

const prefix = process.env.MC_ACCEPTANCE_CONTAINER_PREFIX;
assert.match(prefix ?? "", /^mc-acc-[a-z0-9-]+-$/, "Set an isolated acceptance container prefix");
const parent = join(process.cwd(), ".acceptance-proof", `rehearsal-${Date.now()}`);
mkdirSync(parent, { recursive: true });
const results = [];
for (const model of ["minimax", "glm"]) for (const negative of [false, true]) {
  test(`${model} real rehearsal ${negative ? "rejects invalid totals" : "completes"}`, { timeout: 240000 }, async () => {
    const proof = join(parent, `${model}-${negative ? "negative" : "positive"}`);
    const options = { real: join(process.cwd(), `acceptance/remote-linux/real-${model}.json`), rehearsal: true, rehearsalWrongImplementation: negative, out: proof, timeoutMs: 180000 };
    // A child process proves the runner's actual nonzero exit on negative cases.
    const code = `import {run} from './acceptance/remote-linux/run.mjs'; run(${JSON.stringify(options)}).catch(error=>{console.error(error.message);process.exitCode=1});`;
    const started = Date.now();
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { PATH: process.env.PATH, HOME: process.env.HOME, MC_ACCEPTANCE_CONTAINER_PREFIX: prefix, TMPDIR: parent }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    writeFileSync(join(parent, `${model}-${negative ? "negative" : "positive"}.log`), output, { mode: 0o600 });
    const summary = JSON.parse(readFileSync(join(proof, "summary.json"), "utf8"));
    results.push({ model, negative, exitCode, status: summary.status, durationMs: Date.now() - started, modelRequests: summary.modelRequests, tools: summary.modelRequestTools, cleanupVerified: summary.cleanupVerified, error: summary.error });
    writeFileSync(join(parent, "results.json"), JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
    assert.equal(summary.cleanupVerified, true, output);
    assert.equal(summary.rehearsal, true);
    assert.equal(existsSync(join(proof, "rehearsal.env")), false);
    assert.equal(summary.mode, "real");
    if (negative) {
      assert.notEqual(exitCode, 0, output);
      assert.equal(summary.status, "failed");
      assert.match(summary.error, /Frozen acceptance failed/);
      assert.ok(!summary.error.includes("provider rejected"));
      const mission = JSON.parse(readFileSync(join(proof, "mission-export.json"), "utf8"));
      assert.ok(mission.validationReceipts.some((receipt) => receipt.exitCode !== 0 && /totalCents did not reject invalid input/.test(receipt.stdout)), "Frozen business test must reject invalid totals");
      assert.ok(mission.validations.some((decision) => decision.passed === false), "Validator must reject the failed receipt");
    } else {
      assert.equal(exitCode, 0, output);
      assert.equal(summary.status, "passed", output);
      assert.equal(summary.missionStatus, "completed");
      assert.equal(summary.evidenceComplete, true);
      assert.equal(summary.independentReview.passed, true);
      assert.deepEqual(summary.oracleTouches, []);
      for (const role of Object.values(summary.roles)) { assert.ok(role.modelCalls > 0); assert.ok(role.usage.totalTokens > 0); }
    }
    const residue = (await commandOutput("/opt/homebrew/bin/container", ["list", "--all", "--quiet"], { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: parent })).trim().split(/\s+/).filter((name) => name.startsWith(prefix));
    assert.deepEqual(residue, []);
    console.log(`rehearsal result ${JSON.stringify(results.at(-1))}`);
  });
}
