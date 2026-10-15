// Explicit Apple Container regression; never calls an external model endpoint.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { childProcess, commandOutput, run } from "./run.mjs";
import { assertIndependentReview, independentReview, sha256, writeFrozenAcceptance } from "./real.mjs";

const containerCLI = "/opt/homebrew/bin/container";
const containerEnvironment = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR });
const prefix = process.env.MC_ACCEPTANCE_CONTAINER_PREFIX;
const ownedContainers = async () => (await commandOutput(containerCLI, ["list", "--all", "--quiet"], containerEnvironment())).trim().split(/\s+/).filter((name) => name.startsWith(prefix));
assert.match(prefix ?? "", /^mc-acc-[a-z0-9-]+-$/, "Set an isolated acceptance container prefix");
async function removeOwnedContainer(name) {
  for (const action of ["stop", "delete"]) {
    if (!(await ownedContainers()).includes(name)) continue;
    try { await commandOutput(containerCLI, [action, name], containerEnvironment()); }
    catch (error) { if ((await ownedContainers()).includes(name)) throw error; }
  }
}
const parent = join(process.cwd(), ".acceptance-proof", `regression-${Date.now()}`);
mkdirSync(parent, { recursive: true });

test("four mock scenarios preserve outcomes and clean up owned containers", { timeout: 960000 }, async () => {
  const results = [];
  for (const scenario of ["default", "pause-resume", "worker-crash", "turn-limit"]) {
    const proof = join(parent, scenario);
    const started = Date.now();
    try {
      const { summary } = await run({ scenario, keep: true, out: proof, timeoutMs: 180000 });
      results.push({ scenario, status: summary.status, missionStatus: summary.missionStatus,
        durationMs: Date.now() - started, cleanupVerified: summary.cleanupVerified, proof });
    } catch (error) {
      let summary;
      try { summary = JSON.parse(readFileSync(join(proof, "summary.json"), "utf8")); } catch { /* Preserve the original failure. */ }
      results.push({ scenario, status: "failed", durationMs: Date.now() - started, cleanupVerified: summary?.cleanupVerified, error: error.message, proof });
    }
    writeFileSync(join(parent, "results.json"), JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
  }
  assert.equal(results.filter((result) => result.status !== "passed" || !result.cleanupVerified).length, 0, JSON.stringify(results));
  assert.deepEqual(await ownedContainers(), []);
  console.log(`regression results ${join(parent, "results.json")}`);
});

test("fresh Linux container isolates totals builtin mutations from frozen assertions", { timeout: 180000 }, async () => {
  const oracle = join(parent, "isolated-oracle"); mkdirSync(oracle);
  const acceptance = writeFrozenAcceptance(oracle);
  const sources = [
    `export function totalCents(lines) {
      let total = 0;
      for (const {quantity,unitPriceCents} of lines) {
        if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(unitPriceCents) || quantity < 0 || unitPriceCents < 0) throw new Error('invalid');
        const amount = quantity * unitPriceCents;
        total += amount;
        if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total)) throw new Error('unsafe');
      }
      return total;
    }`,
    "import assert from 'node:assert/strict'; assert.equal = () => {}; assert.throws = () => {}; export const totalCents = () => 0;"
  ];
  const receipt = { id: "isolated-fixture", exitCode: 0, stdout: "# tests 4\n# pass 4\n# fail 0\n" };
  for (const [index, source] of sources.entries()) {
    const proof = join(parent, `isolated-${index}`); mkdirSync(proof);
    const casPath = join(proof, "cas"); writeFileSync(casPath, source, { mode: 0o400 });
    const artifact = { id: "fixture", path: "/work/totals.mjs", sha256: sha256(source) };
    const name = `${prefix}isolated-${index}-${Date.now()}`;
    const review = await independentReview({ proof, acceptance, artifact, casPath, receipt,
      name, image: "node:22-bookworm-slim",
      execute: async (args) => {
        const handle = childProcess(containerCLI, args, containerEnvironment());
        const timer = setTimeout(() => handle.child.kill("SIGKILL"), 60000);
        try {
          await handle.done;
          return { exitCode: handle.child.exitCode, signalCode: handle.child.signalCode, stdout: handle.stdout(), stderr: handle.stderr() };
        } finally {
          clearTimeout(timer);
          await removeOwnedContainer(name);
        }
      }
    });
    writeFileSync(join(proof, "independent-review.json"), JSON.stringify(review, null, 2) + "\n", { mode: 0o600 });
    assert.equal(review.passed, index === 0, JSON.stringify(review));
    if (index === 0) assertIndependentReview(review, acceptance, artifact, receipt);
    else {
      assert.equal(review.exitCode, 1);
      assert.equal(review.agreesWithReceipt, false);
      assert.match(review.stdout, /^# tests 4$/m);
      assert.throws(() => assertIndependentReview(review, acceptance, artifact, receipt), /disagrees/);
    }
  }
  assert.deepEqual(await ownedContainers(), []);
});
