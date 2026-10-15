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
const totalsRunner = `import { readFileSync, writeSync } from 'node:fs';
import { Serializer, deserialize } from 'node:v8';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const send = writeSync;
const encoder = new Serializer();
const begin = encoder.writeHeader.bind(encoder), encode = encoder.writeValue.bind(encoder), finish = encoder.releaseBuffer.bind(encoder);
const { nonce, lines } = deserialize(readFileSync(0));
const header = new Uint8Array(4);
const { totalCents } = await import(pathToFileURL(join(process.cwd(), 'totals.mjs')));
if (typeof totalCents !== 'function') throw new Error('Missing totalCents export');
let result;
try { result = { kind: 'returned', value: totalCents(lines) }; }
catch { result = { kind: 'threw' }; }
begin();
encode({ nonce, ...result });
const payload = finish();
const size = payload.length;
header[0] = size >>> 24; header[1] = size >>> 16; header[2] = size >>> 8; header[3] = size;
for (let offset = 0; offset < header.length;) offset += send(3, header, offset, header.length - offset);
for (let offset = 0; offset < payload.length;) offset += send(3, payload, offset, payload.length - offset);
`;

export function writeFrozenAcceptance(proof) {
  const path = join(proof, "totals.acceptance.test.mjs");
  const source = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
const runner = ${JSON.stringify(totalsRunner)};
function probe(lines) {
  const nonce = randomBytes(32).toString('hex');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: process.cwd(), env: { PATH: process.env.PATH }, input: serialize({ nonce, lines }),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'], timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536
  });
  assert.equal(child.error, undefined, 'Delivery child transport failed');
  assert.equal(child.signal, null, 'Delivery child was interrupted');
  assert.equal(child.status, 0, 'Delivery child failed to execute');
  const frame = child.output[3];
  assert.ok(frame && frame.length >= 4, 'Missing delivery result frame');
  assert.equal(frame.readUInt32BE(0), frame.length - 4, 'Expected exactly one delivery result frame');
  const payload = frame.subarray(4);
  const result = deserialize(payload);
  assert.deepEqual(serialize(result), payload, 'Trailing or noncanonical delivery result bytes');
  assert.equal(result?.nonce, nonce, 'Delivery result nonce mismatch');
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
  const acceptance = { path, sha256: sha256(readFileSync(path)), tests: 4 };
  acceptance.entry = writeFrozenAcceptanceEntry(acceptance);
  return Object.defineProperty(acceptance, "source", { value: source });
}
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function writeFrozenAcceptanceEntry(acceptance) {
  const path = join(dirname(acceptance.path), "run-frozen-acceptance.mjs");
  const source = `import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const path = ${JSON.stringify(acceptance.path)};
if (createHash('sha256').update(readFileSync(path)).digest('hex') !== ${JSON.stringify(acceptance.sha256)}) {
  console.error('Frozen acceptance hash mismatch');
  process.exit(1);
}
const child = spawn(process.execPath, ['--test', '--test-reporter=tap', path], { cwd: process.cwd(), stdio: 'inherit' });
child.on('error', (error) => { console.error(error); process.exit(1); });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`;
  writeFileSync(path, source, { mode: 0o400, flag: "wx" });
  return { path, sha256: sha256(readFileSync(path)) };
}

export function frozenAcceptanceCommand(acceptance) {
  const quote = (path) => path.includes("'") ? '"' + path.replace(/[\\"$`]/g, "\\$&") + '"' : shellQuote(path);
  return `${quote(process.execPath)} ${quote(acceptance.entry.path)}`;
}

// Quote removal is safe only in this literal subset; unknown shell syntax fails closed.
function literalShellTokens(command) {
  if (typeof command !== "string" || /[\x00-\x08\x0a-\x1f\x7f$`]/.test(command)) return null;
  const tokens = [];
  let word = "", quote = "", started = false;
  const flush = () => {
    if (started) tokens.push({ kind: "word", value: word });
    word = ""; started = false;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = "";
      else if (char === "\\") {
        const next = command[++index];
        if (next !== '"' && next !== "\\") return null;
        word += next;
      } else word += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === "\\") {
      if (++index === command.length) return null;
      word += command[index]; started = true;
    } else if (char === " " || char === "\t") flush();
    else if (char === "&" && command[index + 1] === "&") {
      flush();
      if (tokens.at(-1)?.kind !== "word") return null;
      tokens.push({ kind: "operator", value: "&&" }); index++;
    } else if ("&;|<>()*?[#{}!~".includes(char) || /\s/.test(char)) return null;
    else { word += char; started = true; }
  }
  if (quote) return null;
  flush();
  if (tokens.at(-1)?.kind !== "word") return null;
  // Assignments and reserved words can change shell parsing despite identical word values.
  if (tokens.some((token) => token.kind === "word" &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value) || /^(?:if|then|else|elif|fi|do|done|case|esac|while|until|for|in|time|function|select|coproc|!|\{|\})$/.test(token.value)))) return null;
  return tokens;
}

export function acceptanceCommandMatch(expected, actual) {
  if (typeof expected !== "string" || typeof actual !== "string") return null;
  if (expected === actual) return "exact";
  const left = literalShellTokens(expected), right = literalShellTokens(actual);
  return left && right && left.length === right.length && left.every((token, index) =>
    token.kind === right[index].kind && token.value === right[index].value) ? "shell-equivalent" : null;
}

export function checkFrozenAcceptance(acceptance, phase, receiptId) {
  const check = { phase, checkedAt: new Date().toISOString(), ...(receiptId ? { receiptId } : {}) };
  check.files = [acceptance, acceptance.entry].map((file) => {
    const result = { path: file.path };
    try {
      result.sha256 = sha256(readFileSync(file.path));
      result.mode = statSync(file.path).mode & 0o7777;
      result.intact = result.sha256 === file.sha256 && result.mode === 0o400;
    } catch { result.intact = false; result.error = "Frozen acceptance file unreadable"; }
    return result;
  });
  check.sha256 = check.files[0].sha256;
  check.mode = check.files[0].mode;
  check.intact = check.files.every((file) => file.intact);
  return check;
}

function oracleReference(command, acceptancePath) {
  // Keep the existing proof-directory audit even when a command only reads it.
  const directory = dirname(acceptancePath);
  const unquoted = command.replace(/["']/g, "").replace(/\$\{(?:HOME|TMPDIR)\}|\$(?:HOME|TMPDIR)\b|~(?=\/|\s|$)/g, directory);
  const file = unquoted.replace(/\\/g, "").includes("totals.acceptance.test.mjs") || unquoted.replace(/\\/g, "").includes("run-frozen-acceptance.mjs") || unquoted.includes(acceptancePath);
  const directoryTouch = unquoted.includes(directory) && /\b(?:chmod|chflags|chown|rm|mv|cp|tee|touch|mkdir|rmdir|install|truncate|ln|sed|perl|python\d*|node)\b|>|write(?:File)?/i.test(unquoted);
  return { file, directoryTouch };
}

function readOnlyPipeline(command, acceptancePath) {
  // This is a deliberately small shell grammar, not a general shell parser.
  // Unknown expansions, control operators and escapes never earn read permission.
  const literal = command.replace(/\$\{(?:HOME|TMPDIR)\}|\$(?:HOME|TMPDIR)\b/g, dirname(acceptancePath));
  if (/[\n\r\x00-\x08\x0b-\x1f\x7f$`\\;&<>(){}*?!#]/.test(literal)) return false;
  const pipeline = [[]];
  let word = "", quote = "", started = false;
  const flush = () => { if (started) pipeline.at(-1).push(word); word = ""; started = false; };
  for (const char of literal) {
    if (quote) {
      if (char === quote) quote = "";
      else word += char;
      started = true;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === "|") { flush(); pipeline.push([]); }
    else if (/\s/.test(char)) flush();
    else { word += char; started = true; }
  }
  if (quote) return false;
  flush();
  return pipeline.every((words) => readOnlyCommand(words, acceptancePath));
}

const readOptions = {
  cat: /^-(?:[benstuvAET]+|-show-all|-number|-squeeze-blank)$/, head: /^-(?:[nclqv]|\d+)$/, tail: /^-(?:[ncqv]|\d+)$/,
  less: /^-[FNSXn]+$/, more: /^-(?:[dflpcsu]+|\d+)$/, wc: /^-[clmwL]+$/,
  grep: /^-(?:[EFGivwnclhHosrq]+|[emABC]|-color=(?:never|always|auto))$/,
  rg: /^-(?:[ivwnclHsoqUF]+|[emABC]|-no-heading|-fixed-strings|-line-number|-count|-files-with-matches|-color=(?:never|always|auto))$/,
  sha256sum: /^-(?:[bctwz]+|-check|-status|-strict)$/, shasum: /^-(?:[abctw]+|-check|-status|-strict)$/,
  stat: /^-[fctLx]+$/, ls: /^-[aAbBcCdDfFgGhHiklLmMnNopqQrRsStTuUvwx1]+$/, file: /^-(?:[bhiLNz]+|-mime|-mime-type|-brief)$/
};

function readOnlyCommand([executable, ...args], acceptancePath) {
  if (!executable) return false;
  const name = executable.replace(/^\/(?:usr\/)?bin\//, "");
  if (name === "node" || executable === process.execPath) {
    const operands = args.filter((arg) => !["--test", "--test-reporter=tap"].includes(arg));
    return args.includes("--test") && operands.length === 1 && [acceptancePath, "totals.acceptance.test.mjs", "./totals.acceptance.test.mjs"].includes(operands[0]);
  }
  if (name === "sed") {
    // sed can execute or write even without -i (e, w and s///e). Admit print only.
    if (args[0] === "-n") args.shift();
    if (args[0] === "-e") args.shift();
    return /^(?:\d+(?:,\d+)?)?p$/.test(args[0] ?? "") && args.length >= 1 && args.slice(1).every((arg) => !arg.startsWith("-"));
  }
  if (["less", "more"].includes(name) && args.some((arg) => arg.startsWith("+"))) return false;
  const options = Object.hasOwn(readOptions, name) ? readOptions[name] : undefined;
  if (!options || args.length === 0) return false;
  let operandsOnly = false;
  return args.every((arg) => {
    if (arg === "--") { operandsOnly = true; return true; }
    return operandsOnly || !arg.startsWith("-") || arg === "-" || options.test(arg);
  });
}

export function classifyOracleCommand(command, acceptancePath, acceptanceCommand = frozenAcceptanceCommand({ entry: { path: join(dirname(acceptancePath), "run-frozen-acceptance.mjs") } })) {
  if (acceptanceCommandMatch(acceptanceCommand, command)) return "read";
  const { file, directoryTouch } = oracleReference(command, acceptancePath);
  if (file) return readOnlyPipeline(command, acceptancePath) ? "read" : "touch";
  return directoryTouch ? "touch" : null;
}

export function touchedOracle(command, acceptancePath) {
  return classifyOracleCommand(command, acceptancePath) === "touch";
}

export function auditOracle(exported, acceptancePath, acceptanceCommand) {
  const local = new Set(exported.agents.filter((agent) => agent.machineId === "local").map((agent) => agent.id));
  const oracleReads = [], oracleTouches = [];
  const recordCommand = (record) => {
    const kind = classifyOracleCommand(record.command, acceptancePath, acceptanceCommand);
    if (kind) (kind === "read" ? oracleReads : oracleTouches).push(record);
  };
  for (const event of exported.events ?? []) {
    if (event.type === "shell_evidence" && local.has(event.agentId) && typeof event.data?.command === "string") {
      recordCommand({ agentId: event.agentId, source: "shell_evidence", seq: event.seq, command: event.data.command });
    }
  }
  for (const transcript of exported.transcripts ?? []) {
    if (!local.has(transcript.agentId)) continue;
    for (const entry of transcript.entries) {
      if (entry.role !== "tool") continue;
      let data;
      try { data = JSON.parse(entry.text); } catch { continue; }
      if (!object(data)) continue;
      const record = { agentId: transcript.agentId, source: "tool transcript", entryId: entry.id };
      const tool = data.name ?? data.toolName ?? data.tool ?? data.method;
      const args = data.args ?? data.arguments ?? data.input ?? data;
      if (!object(args)) continue;
      if (typeof args.command === "string" && !["read_file", "write_file"].includes(tool)) recordCommand({ ...record, command: args.command });
      else if (typeof args.path === "string") {
        const { file, directoryTouch } = oracleReference(args.path, acceptancePath);
        const read = tool === "read_file";
        if (file || directoryTouch || (!read && args.path.includes(dirname(acceptancePath)))) {
          (read ? oracleReads : oracleTouches).push({ ...record, tool: tool ?? "unknown", path: args.path, command: `${tool ?? "unknown"} ${shellQuote(args.path)}` });
        }
      }
    }
  }
  return { oracleReads, oracleTouches };
}

export function oracleTouches(exported, acceptancePath) {
  return auditOracle(exported, acceptancePath).oracleTouches;
}

export function realMission({ acceptanceCommand, localWorkspaceId, remoteWorkspaceId, roleIds }) {
  return { title: "Remote Linux order totals", goal: `${businessRules} Deliver totals.mjs at /work/totals.mjs in the assigned Linux workspace.`,
    acceptance: `${businessRules} Deliver one totals.mjs file. An independent validator on the coordinator verifies the published snapshot using this read-only host command: ${acceptanceCommand}. The frozen host entry script and test file are available only on the coordinator.`,
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
    ...auditOracle(exported, acceptance.path, frozenAcceptanceCommand(acceptance)),
    artifacts: exported.artifacts.map((artifact) => ({ id: artifact.id, sha256: artifact.sha256, casSha256: casHashes[artifact.id] ?? null, snapshotPath: artifact.snapshotPath, remoteProvenance: artifact.remoteProvenance })),
    validationReceipts: exported.validationReceipts.map((receipt) => ({ ...receipt, commandMatch: acceptanceCommandMatch(frozenAcceptanceCommand(acceptance), receipt.command) })), blockers: exported.blockers };
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
    value.validatorId === task.validatorId && acceptanceCommandMatch(acceptanceCommand, value.command) && value.artifactIds.includes(artifact.id));
  assert.ok(receipt, "No matching frozen acceptance receipt for the accepted task");
  return { task, artifact, receipt, commandMatch: acceptanceCommandMatch(acceptanceCommand, receipt.command) };
}

export function assertRealOutcome(detail, acceptanceCommand) {
  const failed = detail.validationReceipts.filter((receipt) => acceptanceCommandMatch(acceptanceCommand, receipt.command) && receipt.exitCode !== 0);
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
  assert.deepEqual(evidence.oracleTouches, [], "Acceptance oracle modification or unverified access by a local tool");
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
