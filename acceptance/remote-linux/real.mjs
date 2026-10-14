import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { shellQuote } from "./mock.mjs";

export const kinds = ["orchestrator", "worker", "validator"];
const profileKeys = ["name", "api", "modelId", "baseUrl", "credentialEnv", "contextWindow", "maxTokens", "reasoning", "toolCalling", "vision", "cost"];
const reserved = /^(?:PATH|HOME|TMPDIR|LANG|SHELL|BASH_ENV|ENV|IFS|USER|LOGNAME|NODE_.*|MC_.*|DYLD_.*|LD_.*)$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const valid = (condition, message) => { if (!condition) throw new Error(message); };

export function validateConfig(config) {
  valid(object(config) && Object.keys(config).length === 3 && kinds.every((kind) => Object.hasOwn(config, kind)), "Real config requires exactly orchestrator, worker and validator profiles");
  for (const kind of kinds) {
    const profile = config[kind];
    valid(object(profile) && Object.keys(profile).every((key) => profileKeys.includes(key)), `Invalid ${kind} profile fields`);
    for (const key of ["name", "modelId", "baseUrl", "credentialEnv"]) valid(typeof profile[key] === "string" && profile[key].trim().length > 0, `Invalid ${kind} ${key}`);
    valid(["anthropic-messages", "openai-completions", "openai-responses"].includes(profile.api), `Invalid ${kind} api`);
    valid(/^[A-Z_][A-Z0-9_]*$/.test(profile.credentialEnv) && !reserved.test(profile.credentialEnv), `Invalid ${kind} credentialEnv`);
    let endpoint;
    try { endpoint = new URL(profile.baseUrl); } catch { throw new Error(`Invalid ${kind} baseUrl`); }
    valid(["http:", "https:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, `Invalid ${kind} baseUrl`);
    for (const key of ["contextWindow", "maxTokens"]) valid(Number.isSafeInteger(profile[key]) && profile[key] > 0, `Invalid ${kind} ${key}`);
    valid(profile.maxTokens <= profile.contextWindow, `Invalid ${kind} token limits`);
    for (const key of ["reasoning", "toolCalling", "vision"]) valid(typeof profile[key] === "boolean", `Invalid ${kind} ${key}`);
    valid(profile.toolCalling, `The ${kind} profile must support tool calling`);
    if (profile.cost !== undefined) valid(object(profile.cost) && Object.keys(profile.cost).length === 4 && ["input", "output", "cacheRead", "cacheWrite"].every((key) => Number.isFinite(profile.cost[key]) && profile.cost[key] >= 0), `Invalid ${kind} cost rates`);
  }
  return config;
}

export function readConfig(path) {
  try { return validateConfig(JSON.parse(readFileSync(path, "utf8"))); }
  catch { throw new Error("Real model config is unreadable or invalid; check profile fields"); }
}

export function parseSecrets(text, names) {
  const wanted = new Set(names);
  const values = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (separator < 1 || !wanted.has(key)) continue;
    valid(!Object.hasOwn(values, key), "Duplicate referenced credential in secrets file");
    const value = line.slice(separator + 1);
    valid(value.length > 0 && !/[\x00-\x1f\x7f]/.test(value), "Referenced credential must be a nonempty single-line value");
    values[key] = value;
  }
  valid([...wanted].every((name) => Object.hasOwn(values, name)), "Missing referenced credential in secrets file");
  return values;
}

export function readSecrets(path, names, uid = process.getuid()) {
  let fd;
  try {
    // Validate the opened inode, refusing symlinks and FIFOs before reading bytes.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    valid(stat.isFile() && stat.uid === uid && (stat.mode & 0o7777) === 0o600, "Secrets file must be a regular file owned by the current user with mode 0600");
    return parseSecrets(readFileSync(fd, "utf8"), names);
  } catch (error) {
    const category = fd === undefined ? "file access or type" : error.message.startsWith("Secrets file must") ? "owner, type or permissions" : error.message.startsWith("Missing referenced") ? "missing referenced credential" : "referenced KEY=VALUE format";
    throw new Error(`Secrets file rejected: ${category}`);
  } finally { if (fd !== undefined) closeSync(fd); }
}

const credentialPatterns = (secrets) => [...new Set(secrets.filter((value) => value.length > 0).flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))];

export function redact(text, secrets) {
  return credentialPatterns(secrets).sort((a, b) => b.length - a.length).reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), String(text));
}

export function scanEvidence(path, secrets) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) scanEvidence(file, secrets);
    else if (entry.isFile()) {
      const bytes = readFileSync(file);
      valid(credentialPatterns(secrets).every((secret) => !bytes.includes(Buffer.from(secret))), "Credential found in evidence directory");
    }
    else throw new Error("Unexpected non-regular evidence entry");
  }
}

export const businessRules = "Implement totals.mjs exporting totalCents(lines). Each line is { quantity, unitPriceCents }. Both fields must be nonnegative safe integers; reject negative, fractional, nonnumeric or missing fields with an error. Return the sum of quantity * unitPriceCents as a safe integer number of cents. Empty lines return 0; reject products or totals outside the safe integer range. Zero quantity or price is valid.";

// Capture transport functions before loading delivery code in the disposable child.
const totalsRunner = `import { readFileSync, writeFileSync } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const lines = deserialize(readFileSync(0));
const { totalCents } = await import(pathToFileURL(join(process.cwd(), 'totals.mjs')));
if (typeof totalCents !== 'function') throw new Error('Missing totalCents export');
let result;
try { result = { kind: 'returned', value: totalCents(lines) }; }
catch { result = { kind: 'threw' }; }
writeFileSync(3, serialize(result));
`;

export function writeFrozenAcceptance(proof) {
  const path = join(proof, "totals.acceptance.test.mjs");
  const source = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { serialize, deserialize } from 'node:v8';
const runner = ${JSON.stringify(totalsRunner)};
function probe(lines) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: process.cwd(), env: { PATH: process.env.PATH }, input: serialize(lines),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 65536
  });
  assert.equal(child.error, undefined, 'Delivery child transport failed');
  assert.equal(child.signal, null, 'Delivery child was interrupted');
  assert.equal(child.status, 0, 'Delivery child failed to execute');
  const result = deserialize(child.output[3]);
  assert.ok(result && ['returned', 'threw'].includes(result.kind), 'Invalid delivery result');
  return result;
}
function totalCents(lines) {
  const result = probe(lines);
  assert.equal(result.kind, 'returned', 'totalCents unexpectedly threw');
  return result.value;
}
function rejects(lines) {
  assert.equal(probe(lines).kind, 'threw', 'totalCents did not reject invalid input');
}
test('empty order', () => assert.equal(totalCents([]), 0));
test('multiple lines', () => assert.equal(totalCents([{quantity:2,unitPriceCents:125},{quantity:3,unitPriceCents:70}]), 460));
test('integer cents multiplication and zero', () => {
  assert.equal(totalCents([{quantity:7,unitPriceCents:199}]), 1393);
  assert.equal(totalCents([{quantity:0,unitPriceCents:999},{quantity:9,unitPriceCents:0}]), 0);
});
test('reject invalid fields and unsafe amounts', () => {
  for (const value of [-1, 1.5, NaN, Infinity, '2', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    rejects([{quantity:value,unitPriceCents:100}]);
    rejects([{quantity:2,unitPriceCents:value}]);
  }
  rejects([{quantity:2,unitPriceCents:Number.MAX_SAFE_INTEGER}]);
  rejects([{quantity:1,unitPriceCents:Number.MAX_SAFE_INTEGER},{quantity:1,unitPriceCents:1}]);
});
`;
  writeFileSync(path, source, { mode: 0o400, flag: "wx" });
  return Object.defineProperty({ path, sha256: sha256(readFileSync(path)), tests: 4 }, "source", { value: source });
}
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function frozenAcceptanceCommand(acceptance) {
  const check = `const fs=require('node:fs'),crypto=require('node:crypto');if(crypto.createHash('sha256').update(fs.readFileSync(${JSON.stringify(acceptance.path)})).digest('hex')!==${JSON.stringify(acceptance.sha256)}){console.error('Frozen acceptance hash mismatch');process.exit(1)}`;
  return `${shellQuote(process.execPath)} -e ${shellQuote(check)} && ${shellQuote(process.execPath)} --test --test-reporter=tap ${shellQuote(acceptance.path)}`;
}

export function checkFrozenAcceptance(acceptance, phase, receiptId) {
  const check = { phase, checkedAt: new Date().toISOString(), ...(receiptId ? { receiptId } : {}) };
  try {
    check.sha256 = sha256(readFileSync(acceptance.path));
    check.mode = statSync(acceptance.path).mode & 0o7777;
    check.intact = check.sha256 === acceptance.sha256 && check.mode === 0o400;
  } catch { check.intact = false; check.error = "Frozen acceptance file unreadable"; }
  return check;
}

export function touchedOracle(command, acceptancePath) {
  // Shell evidence is audited conservatively, including relative file references.
  const directory = dirname(acceptancePath);
  const unquoted = command.replace(/["']/g, "").replace(/\$\{(?:HOME|TMPDIR)\}|\$(?:HOME|TMPDIR)\b|~(?=\/|\s|$)/g, directory);
  return unquoted.includes(acceptancePath) || unquoted.includes("totals.acceptance.test.mjs") ||
    (unquoted.includes(directory) && /\b(?:chmod|chflags|chown|rm|mv|cp|tee|touch|mkdir|rmdir|install|truncate|ln|sed|perl|python\d*|node)\b|>|write(?:File)?/i.test(unquoted));
}

export function oracleTouches(exported, acceptancePath) {
  const local = new Set(exported.agents.filter((agent) => agent.machineId === "local").map((agent) => agent.id));
  const commands = [];
  for (const event of exported.events ?? []) {
    if (event.type === "shell_evidence" && local.has(event.agentId) && typeof event.data?.command === "string") {
      commands.push({ agentId: event.agentId, source: "shell_evidence", seq: event.seq, command: event.data.command });
    }
  }
  for (const transcript of exported.transcripts ?? []) {
    if (!local.has(transcript.agentId)) continue;
    for (const entry of transcript.entries) {
      if (entry.role !== "tool") continue;
      let data;
      try { data = JSON.parse(entry.text); } catch { continue; }
      if (typeof data.command === "string") commands.push({ agentId: transcript.agentId, source: "tool transcript", entryId: entry.id, command: data.command });
    }
  }
  return commands.filter((record) => touchedOracle(record.command, acceptancePath));
}

export function realMission({ acceptanceCommand, localWorkspaceId, remoteWorkspaceId, roleIds }) {
  return { title: "Remote Linux order totals", goal: `${businessRules} Deliver totals.mjs at /work/totals.mjs in the assigned Linux workspace.`,
    acceptance: `${businessRules} Deliver one totals.mjs file. An independent validator on the coordinator verifies the published snapshot using this read-only host command: ${acceptanceCommand}. The host test file is available only on the coordinator.`,
    workspaceId: localWorkspaceId, remoteWorkspaceIds: [remoteWorkspaceId], roleIds, maxTurns: 60, maxCost: 0, autonomy: "trusted", workspaceStrategy: "shared",
    assertions: [{ id: "TOTALS-FROZEN", description: `${businessRules} Independent validation of the published Linux snapshot passes all four host tests.` }] };
}

export function collectRealEvidence(exported, mutation, acceptance, casHashes = {}, sessions = [], config = {}) {
  const roles = Object.fromEntries(kinds.map((kind) => [kind, { modelCalls: 0, admittedModelCalls: 0, usage: null, evidenceComplete: true, configuredModelId: config[kind]?.modelId ?? null, responseModels: [], modelMismatch: false, unreportedModelCalls: 0 }]));
  const tools = [];
  const agents = exported.agents.map((agent) => {
    const session = sessions.find((value) => value.agentId === agent.id) ?? { agentId: agent.id, complete: false, error: "Session evidence not collected" };
    const admittedModelCalls = (exported.generationAdmissions ?? []).filter((row) => row.agent_id === agent.id).length;
    const role = roles[agent.kind];
    if (role) {
      role.admittedModelCalls += admittedModelCalls;
      for (const model of session.models ?? []) {
        if (model.responseModel) {
          if (!role.responseModels.includes(model.responseModel)) role.responseModels.push(model.responseModel);
          if (role.configuredModelId && model.responseModel !== role.configuredModelId) role.modelMismatch = true;
        } else role.unreportedModelCalls += model.calls;
      }
      role.evidenceComplete &&= session.complete;
      if (session.complete) {
        role.modelCalls += session.modelCalls;
        role.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
        for (const key of Object.keys(role.usage)) role.usage[key] += session.usage[key];
        for (const tool of session.tools) tools.push({ agentId: agent.id, role: agent.kind, ...tool });
      }
    }
    return { ...session, kind: agent.kind, admittedModelCalls };
  });
  for (const role of Object.values(roles)) if (!role.evidenceComplete) { role.modelCalls = null; role.usage = null; }
  return { status: exported.mission.status, turns: exported.mission.turns, maxTurns: exported.mission.maxTurns,
    cost: exported.mission.costKnown ? exported.mission.cost : null, costKnown: exported.mission.costKnown,
    roles, agents, evidenceComplete: agents.every((agent) => agent.complete), tools,
    toolSequenceOrdering: "per-agent durable commit_seq, entry id and tool position; no cross-agent clock ordering", acceptance, mutation,
    oracleTouches: oracleTouches(exported, acceptance.path),
    artifacts: exported.artifacts.map((artifact) => ({ id: artifact.id, sha256: artifact.sha256, casSha256: casHashes[artifact.id] ?? null, snapshotPath: artifact.snapshotPath, remoteProvenance: artifact.remoteProvenance })),
    validationReceipts: exported.validationReceipts, blockers: exported.blockers };
}

export function realAcceptanceSelection(detail, acceptanceCommand, machineId, artifactId) {
  const accepted = detail.tasks.filter((task) => task.status === "accepted");
  assert.equal(accepted.length, 1, "Expected exactly one accepted task");
  const task = accepted[0];
  assert.ok(detail.tasks.every((other) => other === task || other.status === "cancelled" ||
    (other.attempt === 0 && ["pending", "ready", "assigned", "blocked"].includes(other.status))), "Another task has started without acceptance");
  const artifact = detail.artifacts.find((value) => value.id === artifactId);
  assert.ok(artifact, "Frozen totals artifact missing");
  assert.equal(artifact.path, "/work/totals.mjs");
  assert.equal(artifact.taskId, task.id);
  assert.equal(artifact.agentId, task.ownerId);
  assert.equal(artifact.remoteProvenance.machineId, machineId);
  const validation = detail.validations.filter((value) => value.taskId === task.id).at(-1);
  assert.ok(validation?.passed, "Accepted task has no successful validator decision");
  const receipt = detail.validationReceipts.find((value) => value.id === validation.receiptId && value.taskId === task.id &&
    value.validatorId === task.validatorId && value.command === acceptanceCommand && value.artifactIds.includes(artifact.id));
  assert.ok(receipt, "No exact frozen acceptance receipt for the accepted task");
  return { task, artifact, receipt };
}

export function assertRealOutcome(detail, acceptanceCommand) {
  const failed = detail.validationReceipts.filter((receipt) => receipt.command === acceptanceCommand && receipt.exitCode !== 0);
  const reason = failed.length ? "Frozen acceptance failed for the published snapshot" : "Real Mission did not complete";
  assert.equal(detail.mission.status, "completed", `${reason}; status=${detail.mission.status}; failedReceipts=${failed.length}`);
}

export function assertRealSuccess(detail, evidence, acceptanceCommand, machineId) {
  assert.equal(detail.mission.status, "completed");
  assert.deepEqual(detail.blockers, []);
  const { artifact, receipt } = realAcceptanceSelection(detail, acceptanceCommand, machineId, evidence.mutation?.artifactId);
  const mutation = evidence.mutation;
  assert.ok(mutation, "No post-publication fault injection observed");
  assert.equal(mutation.artifactId, artifact.id);
  assert.notEqual(mutation.beforeSha256, mutation.afterSha256);
  assert.equal(mutation.casBeforeSha256, artifact.sha256);
  assert.equal(mutation.casAfterSha256, artifact.sha256);
  assert.equal(mutation.casFinalSha256, artifact.sha256);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.snapshotIntegrity, true);
  assert.equal(receipt.workspaceKind, "remote-snapshot");
  assert.equal(receipt.artifactDigests[artifact.id], artifact.sha256);
  assert.match(receipt.stdout, /^# tests 4$/m);
  assert.match(receipt.stdout, /^# pass 4$/m);
  assert.match(receipt.stdout, /^# fail 0$/m);
  assertHostRuntime(evidence.hostRuntime);
  assertIndependentReview(evidence.independentReview, evidence.acceptance, artifact, receipt);
  assert.deepEqual(evidence.oracleTouches, [], "Acceptance oracle was touched by a local shell command");
  assert.ok(evidence.acceptance.checks.some((check) => check.phase === "publication"), "Publication hash check missing");
  assert.ok(evidence.acceptance.checks.some((check) => check.phase === "receipt" && check.receiptId === receipt.id), "Receipt hash check missing");
  assert.ok(evidence.acceptance.checks.every((check) => check.intact), "Frozen acceptance hash or permissions changed");
  const worker = detail.agents.find((agent) => agent.id === artifact.agentId);
  const validator = detail.agents.find((agent) => agent.id === receipt.validatorId);
  assert.equal(worker.kind, "worker");
  assert.equal(worker.machineId, machineId);
  assert.equal(validator.kind, "validator");
  assert.equal(validator.machineId, "local");
  assert.notEqual(worker.id, validator.id);
  assert.equal(evidence.tools.some((tool) => tool.name === "RequestUserInput"), false);
}

export function findRealPublication(detail, machineId, seen, rejected) {
  for (const event of detail.events) {
    if (event.type !== "artifact_published" || seen.has(event.seq) || !detail.agents.some((agent) => agent.id === event.agentId && agent.kind === "worker")) continue;
    seen.add(event.seq);
    const artifact = detail.artifacts.find((value) => value.id === event.data.artifactId);
    assert.ok(artifact, "Published artifact missing");
    if (artifact.path !== "/work/totals.mjs") {
      rejected.push({ eventSeq: event.seq, artifactId: artifact.id, path: artifact.path, reason: "Expected /work/totals.mjs" });
      continue;
    }
    assert.equal(artifact.remoteProvenance?.machineId, machineId, "Publication did not come from the assigned Linux node");
    assert.equal(event.data.sha256, artifact.sha256);
    return { event, artifact };
  }
}

export function checkHostRuntime(runtime) {
  try { return { ...runtime, afterSha256: sha256(readFileSync(runtime.path)) }; }
  catch { return { ...runtime, afterSha256: null, error: "Host node binary unreadable" }; }
}

export function assertHostRuntime(runtime) {
  assert.match(runtime?.beforeSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(runtime.afterSha256, runtime.beforeSha256, "Host node binary changed during acceptance");
}

export const tapPassed = (stdout, tests) => [new RegExp(`^# tests ${tests}$`, "m"), new RegExp(`^# pass ${tests}$`, "m"), /^# fail 0$/m].every((pattern) => pattern.test(stdout));

// The coordinator must be stopped before preparing these fresh inputs.
export async function independentReview({ proof, acceptance, artifact, casPath, receipt, name, image, execute }) {
  const review = { name, image, artifactId: artifact.id, artifactSha256: artifact.sha256, acceptanceSha256: acceptance.sha256,
    tests: acceptance.tests, receiptId: receipt?.id ?? null, receiptPassed: receipt?.exitCode === 0 && tapPassed(receipt.stdout, acceptance.tests), passed: false };
  try {
    assert.equal(sha256(acceptance.source), acceptance.sha256, "In-memory frozen acceptance hash mismatch");
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    const bytes = readFileSync(casPath);
    review.casSha256 = sha256(bytes);
    assert.equal(review.casSha256, artifact.sha256, "Published CAS hash mismatch");
    const inputs = join(proof, "independent-inputs");
    mkdirSync(inputs, { mode: 0o700 });
    const testPath = join(inputs, "frozen.test.mjs"), snapshot = join(inputs, "snapshot");
    mkdirSync(snapshot, { mode: 0o700 });
    writeFileSync(testPath, acceptance.source, { flag: "wx", mode: 0o400 });
    writeFileSync(join(snapshot, artifact.path.split("/").at(-1)), bytes, { flag: "wx", mode: 0o400 });
    const guestSnapshot = "/validations/remote/" + artifact.sha256.slice(0, 32);
    // Linux Node also checks the mounted bytes before importing the snapshot.
    const check = `const fs=require('node:fs'),crypto=require('node:crypto');for(const [path,hash] of ${JSON.stringify([["/oracle/frozen.test.mjs", acceptance.sha256], [guestSnapshot + "/" + artifact.path.split("/").at(-1), artifact.sha256]])}){if(crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')!==hash)process.exit(1)}`;
    Object.assign(review, await execute(["run", "--rm", "--name", name, "--arch", "arm64", "--cpus", "1", "--memory", "256M",
      "-v", `${testPath}:/oracle/frozen.test.mjs:ro`, "-v", `${snapshot}:${guestSnapshot}:ro`, "--workdir", guestSnapshot,
      image, "sh", "-c", `node -e ${shellQuote(check)} && node --test --test-reporter=tap /oracle/frozen.test.mjs`]));
    review.passed = review.exitCode === 0 && tapPassed(review.stdout, acceptance.tests);
  } catch (error) { review.error = error.message; }
  review.agreesWithReceipt = review.passed === review.receiptPassed;
  return review;
}

export function assertIndependentReview(review, acceptance, artifact, receipt) {
  assert.ok(review, "Independent container review missing");
  assert.equal(review.artifactId, artifact.id);
  assert.equal(review.artifactSha256, artifact.sha256);
  assert.equal(review.casSha256, artifact.sha256);
  assert.equal(review.acceptanceSha256, acceptance.sha256);
  assert.equal(review.tests, acceptance.tests);
  assert.equal(review.receiptId, receipt.id);
  assert.equal(review.receiptPassed, true, "Product validator did not pass the frozen tests");
  assert.equal(review.agreesWithReceipt, true, "Independent review disagrees with product validator");
  assert.equal(review.passed, true, review.error ?? "Independent container tests failed");
}

export const nodeCredentialShell = 'IFS= read -r MC_ACCEPTANCE_NODE_TOKEN || exit 1; export MC_ACCEPTANCE_NODE_TOKEN; relay_port=$1; machine_id=$2; shift 2; for ref in "$@"; do IFS= read -r value || exit 1; export "$ref=$value"; done; unset value; exec node /app/bootstrap.mjs "$relay_port" "$machine_id" "$@"';

export const faultInjectionScript = `
  const fs = require('node:fs'), crypto = require('node:crypto');
  const file = process.argv[1];
  if (!fs.lstatSync(file).isFile()) throw new Error('Source must be a regular file');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const beforeSha256 = hash();
  fs.writeFileSync(file, 'throw new Error("mutated after publish");\\n');
  console.log(JSON.stringify({beforeSha256,afterSha256:hash()}));
`;
