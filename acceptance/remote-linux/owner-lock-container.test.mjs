import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const proof = join(root, ".acceptance-proof");
mkdirSync(proof, { recursive: true });
const prefix = process.env.MC_ACCEPTANCE_CONTAINER_PREFIX ?? "mc-acc-p5-gpt-";
assert.match(prefix, /^mc-acc-p5-gpt-[a-z0-9-]*$/);
const image = "node:22-bookworm-slim";
function container(args) {
  const result = spawnSync("container", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180000 });
  return { code: result.status, error: result.error?.message, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}
const images = container(["image", "list"]);
assert.equal(images.code, 0, images.output);
assert.match(images.output, /node\s+22-bookworm-slim\s/);
const name = `${prefix}owner-lock-${process.pid}`;
const manifest = join(proof, "owner-lock-manifest");
mkdirSync(manifest, { recursive: true });
copyFileSync(join(root, "package.json"), join(manifest, "package.json"));
const args = ["run", "--rm", "--name", name, "--arch", "arm64", "--cpus", "2", "--memory", "512M", "--workdir", "/tmp/app"];
for (const entry of ["dist", "node_modules", "test"]) {
  args.push("--mount", `type=bind,source=${realpathSync(join(root, entry))},target=/tmp/app/${entry},readonly`);
}
args.push("--mount", `type=bind,source=${manifest},target=/input/manifest,readonly`);
args.push(image, "sh", "-c", "cp /input/manifest/package.json /tmp/app/package.json && node -p 'JSON.stringify({platform:process.platform,arch:process.arch,node:process.version})' && TMPDIR=/tmp node --test --test-concurrency=1 test/control-owner.test.mjs test/node-owner.test.mjs test/cli-stop.test.mjs");
const started = Date.now();
const result = container(args);
const elapsedMs = Date.now() - started;
writeFileSync(join(proof, `linux-owner-lock-${started}.log`), result.output);
// Apple Container can return before asynchronous --rm removal finishes.
let remaining = container(["list", "--all"]);
for (let attempt = 0; remaining.code === 0 && remaining.output.includes(name) && attempt < 10; attempt += 1) {
  await delay(500);
  remaining = container(["list", "--all"]);
}
writeFileSync(join(proof, `linux-owner-lock-${started}.json`), JSON.stringify({ image, name, args, elapsedMs, ...result, remaining }, null, 2));
assert.equal(remaining.code, 0, remaining.output);
assert.equal(remaining.output.includes(prefix), false, remaining.output);
console.log(result.output);
console.log(`Linux owner-lock run: code=${result.code}, elapsedMs=${elapsedMs}, prefix containers remaining=0`);
assert.equal(result.code, 0, result.error ?? result.output);
