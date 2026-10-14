// Explicit lifecycle acceptance, outside the ordinary npm test glob.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

for (const mode of ["SIGINT", "timeout"]) {
  test(`acceptance ${mode} retains evidence and verifies cleanup`, { timeout: 90000 }, async (t) => {
    const parent = join(process.cwd(), ".acceptance-proof");
    mkdirSync(parent, { recursive: true });
    const proof = join(parent, `${mode}-${Date.now()}`);
    const child = spawn(process.execPath, ["acceptance/remote-linux/run.mjs", "--out", proof,
      ...(mode === "timeout" ? ["--timeout-ms", "2000"] : [])], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
    if (mode === "SIGINT") {
      const deadline = Date.now() + 45000;
      while (!existsSync(join(proof, "mock-tools.json"))) {
        assert.ok(Date.now() < deadline && child.exitCode === null, output || "Node did not start before interruption");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      child.kill("SIGINT");
    }
    assert.equal(await done, 1, output);
    assert.match(output, /cleanup verified/);
    const summary = JSON.parse(readFileSync(join(proof, "summary.json"), "utf8"));
    assert.equal(summary.status, "failed");
    assert.equal(summary.cleanupVerified, true);
    assert.match(summary.error, mode === "SIGINT" ? /Interrupted by SIGINT/ : /timed out/);
    assert.equal(existsSync(join(proof, "home/admin.token")), false);
    process.stdout.write(`lifecycle result ${JSON.stringify(summary)}\n`);
    rmSync(proof, { recursive: true });
  });
}
