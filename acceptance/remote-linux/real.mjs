import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  } catch {
    throw new Error("Secrets file rejected; require an owned regular file, mode 0600, and unique referenced KEY=VALUE lines");
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

export function writeFrozenAcceptance(proof) {
  const path = join(proof, "totals.acceptance.test.mjs");
  const source = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { totalCents } = await import(pathToFileURL(join(process.cwd(), 'totals.mjs')));
test('empty order', () => assert.equal(totalCents([]), 0));
test('multiple lines', () => assert.equal(totalCents([{quantity:2,unitPriceCents:125},{quantity:3,unitPriceCents:70}]), 460));
test('integer cents multiplication and zero', () => {
  assert.equal(totalCents([{quantity:7,unitPriceCents:199}]), 1393);
  assert.equal(totalCents([{quantity:0,unitPriceCents:999},{quantity:9,unitPriceCents:0}]), 0);
});
test('reject invalid fields and unsafe amounts', () => {
  for (const value of [-1, 1.5, NaN, Infinity, '2', undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => totalCents([{quantity:value,unitPriceCents:100}]));
    assert.throws(() => totalCents([{quantity:2,unitPriceCents:value}]));
  }
  assert.throws(() => totalCents([{quantity:2,unitPriceCents:Number.MAX_SAFE_INTEGER}]));
  assert.throws(() => totalCents([{quantity:1,unitPriceCents:Number.MAX_SAFE_INTEGER},{quantity:1,unitPriceCents:1}]));
});
`;
  writeFileSync(path, source, { mode: 0o400, flag: "wx" });
  return { path, sha256: sha256(readFileSync(path)), tests: 4 };
}
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function realMission({ acceptanceCommand, localWorkspaceId, remoteWorkspaceId, roleIds }) {
  return { title: "Remote Linux order totals frozen acceptance", goal: `${businessRules} Deliver from the assigned Linux workspace and complete independent host-only frozen snapshot acceptance.`,
    acceptance: `${businessRules} Publish only totals.mjs for one task. Self-check on Linux before publication. After publication the acceptance harness will corrupt the live source; never repair or republish it. The validator must run the exact host-only command ${acceptanceCommand} via RunValidation with the published artifactIds, accept using its successful receipt, and the orchestrator must CompleteMission. The host acceptance file is read-only and unavailable to the worker. Use the existing mission state, roles and assertion IDs. Assign distinct worker and validator agents; move the task to review after publication. Do not request human intervention.`,
    workspaceId: localWorkspaceId, remoteWorkspaceIds: [remoteWorkspaceId], roleIds, maxTurns: 60, maxCost: 0, autonomy: "trusted", workspaceStrategy: "shared",
    assertions: [{ id: "TOTALS-FROZEN", description: `${businessRules} The independently assigned local validator passes all four host-only tests against the frozen remote snapshot after the live source is corrupted.` }] };
}

export function collectRealEvidence(exported, mutation, acceptance, casHashes = {}) {
  const tools = [];
  const roles = Object.fromEntries(kinds.map((kind) => [kind, { modelCalls: 0, modelResponses: 0, usage: null }]));
  for (const agent of exported.agents) {
    if (!roles[agent.kind]) continue;
    const role = roles[agent.kind];
    role.modelCalls += (exported.generationAdmissions ?? []).filter((row) => row.agent_id === agent.id).length;
    const entries = exported.transcripts.find((value) => value.agentId === agent.id)?.entries ?? [];
    const responses = entries.filter((entry) => entry.role === "model").map((entry) => ({ entry, data: JSON.parse(entry.text) }));
    role.modelResponses += responses.length;
    for (const { entry, data } of responses) for (const [index, name] of data.tools.entries()) tools.push({ agentId: agent.id, role: agent.kind, name, entryId: entry.id, index, createdAt: entry.createdAt });
    const usage = entries.filter((entry) => entry.role === "model_usage").at(-1);
    if (usage) {
      const counters = JSON.parse(usage.text);
      role.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
      for (const key of Object.keys(role.usage)) role.usage[key] += counters[key];
    }
  }
  tools.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.entryId.localeCompare(b.entryId) || a.index - b.index);
  return { status: exported.mission.status, turns: exported.mission.turns, maxTurns: exported.mission.maxTurns,
    cost: exported.mission.costKnown ? exported.mission.cost : null, costKnown: exported.mission.costKnown,
    roles, tools, toolSequenceOrdering: "transcript commit time; per-response order retained", acceptance, mutation,
    artifacts: exported.artifacts.map((artifact) => ({ id: artifact.id, sha256: artifact.sha256, casSha256: casHashes[artifact.id] ?? null, snapshotPath: artifact.snapshotPath, remoteProvenance: artifact.remoteProvenance })),
    validationReceipts: exported.validationReceipts, blockers: exported.blockers };
}

export function assertRealSuccess(detail, evidence, acceptanceCommand, machineId) {
  assert.equal(detail.mission.status, "completed");
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0].status, "accepted");
  assert.deepEqual(detail.blockers, []);
  assert.equal(detail.artifacts.length, 1);
  const artifact = detail.artifacts[0];
  assert.equal(artifact.remoteProvenance.machineId, machineId);
  const mutation = evidence.mutation;
  assert.ok(mutation, "No post-publication fault injection observed");
  assert.equal(mutation.artifactId, artifact.id);
  assert.notEqual(mutation.beforeSha256, mutation.afterSha256);
  assert.equal(mutation.casBeforeSha256, artifact.sha256);
  assert.equal(mutation.casAfterSha256, artifact.sha256);
  assert.equal(mutation.casFinalSha256, artifact.sha256);
  const receipt = detail.validationReceipts.find((value) => value.command === acceptanceCommand && value.artifactIds.includes(artifact.id));
  assert.ok(receipt, "No exact frozen acceptance receipt");
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.snapshotIntegrity, true);
  assert.equal(receipt.workspaceKind, "remote-snapshot");
  assert.equal(receipt.artifactDigests[artifact.id], artifact.sha256);
  assert.match(receipt.stdout, /# tests 4/);
  assert.match(receipt.stdout, /# pass 4/);
  assert.match(receipt.stdout, /# fail 0/);
  assert.ok(Date.parse(mutation.completedAt) <= Date.parse(receipt.createdAt), "Validation finished before fault injection");
  const worker = detail.agents.find((agent) => agent.id === artifact.agentId);
  const validator = detail.agents.find((agent) => agent.id === receipt.validatorId);
  assert.equal(worker.kind, "worker");
  assert.equal(worker.machineId, machineId);
  assert.equal(validator.kind, "validator");
  assert.equal(validator.machineId, "local");
  assert.notEqual(worker.id, validator.id);
  assert.equal(evidence.tools.some((tool) => tool.name === "RequestUserInput"), false);
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
