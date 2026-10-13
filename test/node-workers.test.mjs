import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DurableWorkerMailbox } from "../dist/worker-mailbox.js";
import { NodeWorkerSupervisor, parseWorkerStartSpec } from "../dist/node-workers.js";

const waitFor = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for node worker state");
};

const profile = (credentialEnv = "MC_NODE_TEST_CREDENTIAL") => ({
  id: "node-worker-profile",
  name: "Node worker fixture",
  api: "openai-completions",
  modelId: "fixture-model",
  baseUrl: "http://127.0.0.1:18080/v1",
  credentialEnv,
  contextWindow: 4096,
  maxTokens: 1024,
  reasoning: false,
  toolCalling: true,
  vision: false,
  revision: 1
});

const role = {
  id: "node-worker-role",
  name: "Node worker fixture role",
  kind: "worker",
  instructions: "Use only the test provider.",
  profileId: "node-worker-profile"
};

const bindingFor = (suffix, agentId = `node-agent-${suffix}`) => ({
  runtimeId: `node-runtime-${suffix}`,
  machineId: "node-machine-fixture",
  sessionId: "node-session-fixture",
  sessionEpoch: 1,
  agentId,
  epoch: 1
});

const specFor = (binding, workspace, credentialEnv = "MC_NODE_TEST_CREDENTIAL") => ({
  binding,
  missionId: "node-mission-fixture",
  workspacePath: workspace,
  workspaceStrategy: "shared",
  profile: profile(credentialEnv),
  role
});

const supervisorOptions = (home, root, isLeaseCurrent = () => true) => ({
  home,
  machineId: "node-machine-fixture",
  sessionId: "node-session-fixture",
  sessionEpoch: 1,
  roots: [root],
  credentialRefs: ["MC_NODE_TEST_CREDENTIAL", "MC_NODE_MISSING_CREDENTIAL"],
  executionEnabled: true,
  isLeaseCurrent,
  testOnlyScripted: true
});

const closeQuietly = async (supervisor) => {
  if (!supervisor) return;
  await supervisor.close().catch(() => undefined);
};

const assertProcessGroupExtinct = (pid) => {
  assert.equal(typeof pid, "number");
  let code;
  try { process.kill(-pid, 0); } catch (error) { code = error.code; }
  assert.equal(code, "ESRCH");
};

test("starts one real node worker with isolated durable state and strict admission", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-"));
  const root = join(home, "root");
  const workspace = join(root, "workspace");
  const nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  const credential = "node-model-sentinel-never-persisted";
  const bearer = "node-bearer-sentinel-never-forwarded";
  const oldCredential = process.env.MC_NODE_TEST_CREDENTIAL;
  const oldBearer = process.env.MC_NODE_BEARER_SENTINEL;
  process.env.MC_NODE_TEST_CREDENTIAL = credential;
  process.env.MC_NODE_BEARER_SENTINEL = bearer;
  let supervisor;
  const binding = bindingFor("strict");
  const spec = specFor(binding, workspace);
  t.after(async () => {
    await closeQuietly(supervisor);
    if (oldCredential === undefined) delete process.env.MC_NODE_TEST_CREDENTIAL;
    else process.env.MC_NODE_TEST_CREDENTIAL = oldCredential;
    if (oldBearer === undefined) delete process.env.MC_NODE_BEARER_SENTINEL;
    else process.env.MC_NODE_BEARER_SENTINEL = oldBearer;
    rmSync(home, { recursive: true, force: true });
  });

  supervisor = new NodeWorkerSupervisor(supervisorOptions(nodeHome, root));
  const started = await supervisor.start(spec);
  assert.equal(started.state, "running");
  assert.equal(started.live, true);
  assert.equal(typeof started.pid, "number");
  assert.equal(supervisor.inspect().length, 1);
  const duplicate = await supervisor.start(spec);
  assert.equal(duplicate.runtimeId, started.runtimeId);
  assert.equal(duplicate.pid, started.pid);
  assert.equal(supervisor.inspect().length, 1);

  const piPath = join(
    nodeHome,
    "agents",
    `${createHash("sha256").update(binding.agentId, "utf8").digest("hex")}.sqlite`
  );
  await waitFor(() => existsSync(piPath));
  assert.equal(supervisor.mailbox.inspectOutbox(binding).some(
    ({ envelope }) => envelope.payload.kind === "notice" && envelope.payload.notice.type === "ready"
  ), true);
  assert.equal((statSync(nodeHome).mode & 0o777).toString(8), "700");
  assert.equal((statSync(join(nodeHome, "node-workers.sqlite")).mode & 0o777).toString(8), "600");

  const evidenceFiles = readdirSync(nodeHome)
    .filter((name) => name.startsWith("node-workers.sqlite"))
    .map((name) => readFileSync(join(nodeHome, name), "utf8"));
  assert.equal(evidenceFiles.some((contents) => contents.includes(credential)), false);
  assert.equal(evidenceFiles.some((contents) => contents.includes(bearer)), false);
  assert.equal(JSON.stringify(supervisor.inspect()).includes(credential), false);
  assert.equal(JSON.stringify(supervisor.inspect()).includes(bearer), false);

  const beforeSecondOwner = supervisor.inspect();
  assert.throws(
    () => new NodeWorkerSupervisor(supervisorOptions(nodeHome, root)),
    /Another node worker supervisor already owns/
  );
  assert.deepEqual(supervisor.inspect(), beforeSecondOwner);

  await assert.rejects(() => supervisor.start({ ...spec, testOnlyScripted: true }), /unsupported fields/);
  const reservedCredentialNames = [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "BASH_ENV",
    "ENV",
    "IFS",
    "SHELL",
    "PATH",
    "MC_WORKER_CONFIG"
  ];
  for (const [index, credentialEnv] of reservedCredentialNames.entries()) {
    await assert.rejects(() => supervisor.start({
      ...spec,
      binding: bindingFor(`reserved-env-${index}`),
      profile: profile(credentialEnv)
    }), /non-reserved environment variable/);
  }
  assert.equal(parseWorkerStartSpec({ ...spec, profile: profile("MC_NODE_TEST_CREDENTIAL") })
    .profile.credentialEnv, "MC_NODE_TEST_CREDENTIAL");
  await assert.rejects(() => supervisor.start({
    ...spec,
    binding: bindingFor("path-escape"),
    workspacePath: home
  }), /not inside a declared node root/);
  await assert.rejects(() => supervisor.start({
    ...spec,
    binding: bindingFor("missing-credential"),
    profile: profile("MC_NODE_MISSING_CREDENTIAL")
  }), /credential is not available/);
  assert.equal(supervisor.inspect().length, 1);

  const invalidCredentialHome = join(home, "invalid-credential-home");
  assert.throws(() => new NodeWorkerSupervisor({
    ...supervisorOptions(invalidCredentialHome, root),
    credentialRefs: ["LD_PRELOAD"]
  }), /reserved or forbidden/);
  assert.equal(existsSync(join(invalidCredentialHome, "node-workers.sqlite")), false);
  const callerForbiddenHome = join(home, "caller-forbidden-home");
  assert.throws(() => new NodeWorkerSupervisor({
    ...supervisorOptions(callerForbiddenHome, root),
    credentialRefs: ["MC_NODE_TEST_CREDENTIAL"],
    forbiddenCredentialRefs: ["MC_NODE_TEST_CREDENTIAL"]
  }), /reserved or forbidden/);
  assert.equal(existsSync(join(callerForbiddenHome, "node-workers.sqlite")), false);

  const stopEvidence = await supervisor.stop(binding);
  assert.equal(stopEvidence.confirmedStopped, true);
  assert.equal(stopEvidence.state, "closed");
  assertProcessGroupExtinct(stopEvidence.pid);
  assert.equal(supervisor.inspect()[0].live, false);
});

test("redacts IPC JSON without truncating business content and rejects invalid payloads before persistence", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-redaction-"));
  const root = join(home, "root");
  const workspace = join(root, "workspace");
  const nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  const secret = "model-secret-structured-redaction-sentinel";
  const oldCredential = process.env.MC_NODE_TEST_CREDENTIAL;
  process.env.MC_NODE_TEST_CREDENTIAL = secret;
  const binding = bindingFor("redaction");
  const spec = specFor(binding, workspace);
  let supervisor;
  t.after(async () => {
    await closeQuietly(supervisor);
    if (oldCredential === undefined) delete process.env.MC_NODE_TEST_CREDENTIAL;
    else process.env.MC_NODE_TEST_CREDENTIAL = oldCredential;
    rmSync(home, { recursive: true, force: true });
  });

  supervisor = new NodeWorkerSupervisor(supervisorOptions(nodeHome, root));
  await supervisor.start(spec);
  const handle = supervisor.handles.get(binding.runtimeId);
  assert.ok(handle?.child);
  const token = handle.token;
  const longKey = `business-key-${"k".repeat(1100)}`;
  const longValue = `business-value-${"v".repeat(1200)}`;
  const combined = `prefix:${secret}|${token}|${longValue}`;
  const injectedRpc = {
    type: "rpc",
    id: "rpc-structured-redaction",
    token,
    agentId: binding.agentId,
    epoch: binding.epoch,
    method: "Transcript",
    taskId: "task-structured-redaction",
    args: { [longKey]: combined }
  };
  handle.child.emit("message", injectedRpc);

  const expected = `prefix:[REDACTED]|[REDACTED]|${longValue}`;
  const rpcRow = supervisor.mailbox.inspectOutbox(binding).find(
    ({ envelope }) => envelope.payload.kind === "rpc"
      && envelope.payload.rpcId === injectedRpc.id
  );
  assert.ok(rpcRow);
  assert.equal(rpcRow.envelope.payload.args[longKey] === expected, true);
  assert.equal(Object.hasOwn(rpcRow.envelope.payload.args, longKey), true);
  assert.equal(longKey.length > 1000, true);
  assert.equal(longValue.length > 1000, true);

  const settledError = `settlement-error:${secret}|${token}|${longValue}`;
  const settledResult = `settlement-result:${secret}|${token}|${longValue}`;
  handle.child.emit("message", {
    type: "settled",
    agentId: binding.agentId,
    epoch: binding.epoch,
    messageId: "message-structured-redaction",
    requestId: "request-structured-redaction",
    attempt: 1,
    submissionId: "submission-structured-redaction",
    status: "done",
    result: { [longKey]: settledResult },
    error: settledError
  });
  const expectedError = `settlement-error:[REDACTED]|[REDACTED]|${longValue}`;
  const expectedResult = `settlement-result:[REDACTED]|[REDACTED]|${longValue}`;
  const settledRow = supervisor.mailbox.inspectOutbox(binding).find(
    ({ envelope }) => envelope.payload.kind === "notice"
      && envelope.payload.notice.type === "settled"
      && envelope.payload.notice.messageId === "message-structured-redaction"
  );
  assert.ok(settledRow);
  assert.equal(settledRow.envelope.payload.notice.error === expectedError, true);
  assert.equal(settledRow.envelope.payload.notice.result[longKey] === expectedResult, true);

  const sendInvalidRpc = (id, args) => supervisor.onChildRpc(handle, {
    type: "rpc",
    id,
    token,
    agentId: binding.agentId,
    epoch: binding.epoch,
    method: "Transcript",
    taskId: `task-${id}`,
    args
  });
  assert.throws(() => sendInvalidRpc("rpc-invalid-nan", { value: Number.NaN }), /invalid or exceeds/);
  assert.throws(() => sendInvalidRpc("rpc-invalid-class", { value: new Date() }), /invalid or exceeds/);
  assert.throws(() => sendInvalidRpc("rpc-invalid-size", { value: "x".repeat(520 * 1024) }), /invalid or exceeds/);
  const sparseArray = [];
  sparseArray.length = 1;
  assert.throws(() => sendInvalidRpc("rpc-invalid-array-hole", { value: sparseArray }), /invalid or exceeds/);
  const deepValue = {};
  let cursor = deepValue;
  for (let depth = 0; depth < 260; depth += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  assert.throws(() => sendInvalidRpc("rpc-invalid-depth", deepValue), /invalid or exceeds/);
  assert.throws(() => sendInvalidRpc("rpc-secret-key", { [secret]: "value", "[REDACTED]": "collision" }), /object key contains private data/);
  const rpcIds = supervisor.mailbox.inspectOutbox(binding)
    .filter(({ envelope }) => envelope.payload.kind === "rpc")
    .map(({ envelope }) => envelope.payload.rpcId);
  assert.deepEqual(rpcIds, [injectedRpc.id]);

  const evidence = readdirSync(nodeHome)
    .filter((name) => name.startsWith("node-workers.sqlite"))
    .map((name) => readFileSync(join(nodeHome, name), "utf8"))
    .join("");
  assert.equal(evidence.includes(secret), false);
  assert.equal(evidence.includes(token), false);
});

test("asynchronous ENOENT fork errors are handled and leave one uncertain admission", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-enoent-"));
  const root = join(home, "root");
  const workspace = join(root, "workspace");
  const nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  const binding = bindingFor("enoent");
  const spec = specFor(binding, workspace, "");
  let supervisor;
  const originalExecPath = process.execPath;
  const originalEmit = ChildProcess.prototype.emit;
  let missingExecutableErrorObserved = false;
  t.after(async () => {
    process.execPath = originalExecPath;
    ChildProcess.prototype.emit = originalEmit;
    await closeQuietly(supervisor);
    rmSync(home, { recursive: true, force: true });
  });

  supervisor = new NodeWorkerSupervisor(supervisorOptions(nodeHome, root));
  ChildProcess.prototype.emit = function (event, ...args) {
    if (event === "error" && this.pid === undefined) missingExecutableErrorObserved = true;
    return originalEmit.call(this, event, ...args);
  };
  process.execPath = join(home, "missing-node-executable");
  try {
    await assert.rejects(() => supervisor.start(spec), /process could not be started/);
  } finally {
    process.execPath = originalExecPath;
  }
  await waitFor(() => missingExecutableErrorObserved, 5000);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const [row] = supervisor.inspect();
  assert.ok(row);
  assert.equal(row.state, "uncertain");
  assert.equal(row.pid, null);
  assert.equal(row.live, false);
  assert.equal(missingExecutableErrorObserved, true);
  await assert.rejects(() => supervisor.start(spec), /already has uncertain evidence/);
  assert.equal(supervisor.inspect().length, 1);
});

test("a failed fork can be closed before its asynchronous error arrives", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-early-close-"));
  const root = join(home, "root");
  mkdirSync(root);
  const supervisor = new NodeWorkerSupervisor(supervisorOptions(join(home, "node-home"), root));
  const originalExecPath = process.execPath;
  t.after(async () => {
    process.execPath = originalExecPath;
    await closeQuietly(supervisor);
    rmSync(home, { recursive: true, force: true });
  });
  await Promise.resolve();
  process.execPath = join(home, "missing-node-executable");
  try {
    await assert.rejects(() => supervisor.start(specFor(bindingFor("early-close"), root, "")), /process could not be started/);
    await supervisor.close();
  } finally {
    process.execPath = originalExecPath;
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("post-readiness child errors and IPC disconnects fence and stop under a current lease", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-child-events-"));
  const root = join(home, "root");
  const workspace = join(root, "workspace");
  const nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  let supervisor;
  t.after(async () => {
    await closeQuietly(supervisor);
    rmSync(home, { recursive: true, force: true });
  });

  supervisor = new NodeWorkerSupervisor(supervisorOptions(nodeHome, root));
  for (const event of ["error", "disconnect"]) {
    const binding = bindingFor(`post-ready-${event}`);
    const started = await supervisor.start(specFor(binding, workspace, ""));
    const handle = supervisor.handles.get(binding.runtimeId);
    assert.ok(handle?.child);
    if (event === "error") handle.child.emit("error", new Error("post-readiness unit fault"));
    else handle.child.disconnect();

    await waitFor(() => supervisor.inspect().find((row) => row.runtimeId === binding.runtimeId)?.live === false);
    const stopped = supervisor.inspect().find((row) => row.runtimeId === binding.runtimeId);
    assert.ok(stopped);
    assert.equal(stopped.state, "closed");
    assert.equal(stopped.confirmedStopped, true);
    assertProcessGroupExtinct(started.pid);
  }
});

test("pumps one real delivery through durable mailboxes and only applies after worker admission", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-mailbox-"));
  const root = join(home, "root");
  const workspace = join(root, "workspace");
  const nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  const binding = bindingFor("mailbox");
  const spec = specFor(binding, workspace, "");
  let supervisor;
  let coordinatorDb;
  let coordinator;
  t.after(async () => {
    await closeQuietly(supervisor);
    try { coordinatorDb?.close(); } catch { /* fixture cleanup */ }
    rmSync(home, { recursive: true, force: true });
  });

  supervisor = new NodeWorkerSupervisor(supervisorOptions(nodeHome, root));
  coordinatorDb = new DatabaseSync(join(home, "coordinator-mailbox.sqlite"));
  coordinator = new DurableWorkerMailbox(coordinatorDb, "coordinator");
  coordinator.open(binding);
  await supervisor.start(spec);

  const deliver = coordinator.enqueue(binding, {
    kind: "deliver",
    messageId: "fixture-message-1",
    requestId: "fixture-request-1",
    attempt: 1,
    content: "durable fixture input",
    mode: "followUp"
  }, "coordinator-delivery-1");
  const delivered = coordinator.pending(binding)[0];
  assert.ok(delivered);
  assert.deepEqual(supervisor.mailbox.receive(binding, delivered), supervisor.mailbox.receive(binding, delivered));
  await supervisor.pump(binding);

  const processing = supervisor.mailbox.inspectInbox(binding).find(
    ({ envelope }) => envelope.messageId === deliver.messageId
  );
  assert.equal(processing?.status, "processing");

  await waitFor(() => supervisor.mailbox.inspectOutbox(binding).some(
    ({ envelope }) => envelope.payload.kind === "rpc"
  ));
  const nodeOutbox = supervisor.mailbox.pending(binding);
  for (const envelope of nodeOutbox) coordinator.receive(binding, envelope);
  const rpcEnvelope = nodeOutbox.find((envelope) => envelope.payload.kind === "rpc");
  assert.ok(rpcEnvelope);
  const rpc = rpcEnvelope.payload;
  assert.deepEqual(Object.keys(rpc).sort(), ["args", "kind", "method", "rpcId", "taskId"]);
  assert.equal("token" in rpc, false);
  assert.equal(JSON.stringify(rpc).includes("MC_WORKER_CONFIG"), false);

  const reply = coordinator.enqueue(binding, {
    kind: "reply",
    rpcId: rpc.rpcId,
    ok: true,
    result: { admitted: true }
  }, "coordinator-reply-1");
  const replyEnvelope = coordinator.pending(binding).find(
    (envelope) => envelope.messageId === reply.messageId
  );
  assert.ok(replyEnvelope);
  supervisor.mailbox.receive(binding, replyEnvelope);
  await supervisor.pump(binding);
  await waitFor(() => supervisor.mailbox.inspectInbox(binding).some(
    ({ envelope, status }) => envelope.messageId === reply.messageId && status === "applied"
  ));
  await waitFor(() => supervisor.mailbox.inspectOutbox(binding).some(
    ({ envelope }) => envelope.payload.kind === "notice"
      && envelope.payload.notice.type === "admitted"
      && envelope.payload.notice.messageId === deliver.payload.messageId
  ));
  const applied = supervisor.mailbox.inspectInbox(binding).find(
    ({ envelope }) => envelope.messageId === deliver.messageId
  );
  assert.equal(applied?.status, "applied");
  const admitted = supervisor.mailbox.inspectOutbox(binding).filter(
    ({ envelope }) => envelope.payload.kind === "notice"
      && envelope.payload.notice.type === "admitted"
      && envelope.payload.notice.messageId === deliver.payload.messageId
  );
  assert.equal(admitted.length, 1);
});

test("watchdog fences a lease-lost worker and restart preserves uncertain evidence without reforking", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-watchdog-"));
  const root = join(home, "root");
  const workspace = join(root, "workspace");
  const nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  const binding = bindingFor("watchdog");
  const spec = specFor(binding, workspace, "");
  let lease = true;
  let supervisor;
  let recovered;
  t.after(async () => {
    await closeQuietly(recovered);
    await closeQuietly(supervisor);
    rmSync(home, { recursive: true, force: true });
  });

  supervisor = new NodeWorkerSupervisor(supervisorOptions(nodeHome, root, () => lease));
  const started = await supervisor.start(spec);
  lease = false;
  await waitFor(() => supervisor.inspect()[0]?.live === false);
  const stopped = supervisor.inspect()[0];
  assert.ok(stopped);
  assert.equal(stopped.confirmedStopped, true);
  assert.equal(stopped.state, "closed");
  assert.equal(stopped.live, false);
  assertProcessGroupExtinct(started.pid);

  lease = true;
  await assert.rejects(
    () => supervisor.start({ ...spec, binding: bindingFor("watchdog-replacement", binding.agentId) }),
    /Mailbox binding is not open|unreconciled|Another open or uncertain/
  );

  const db = new DatabaseSync(join(nodeHome, "node-workers.sqlite"));
  db.prepare("UPDATE node_worker_runtimes SET state='running',confirmed_stopped=0 WHERE runtime_id=?").run(started.runtimeId);
  db.close();
  await supervisor.close();
  supervisor = undefined;

  recovered = new NodeWorkerSupervisor(supervisorOptions(nodeHome, root));
  const afterRecovery = recovered.inspect();
  assert.equal(afterRecovery.length, 1);
  assert.equal(afterRecovery[0].state, "uncertain");
  assert.equal(afterRecovery[0].live, false);
  await assert.rejects(() => recovered.start(spec), /already has uncertain evidence/);
});
