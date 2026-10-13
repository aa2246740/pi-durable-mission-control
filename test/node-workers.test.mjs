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
  statSync,
  writeFileSync
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DurableWorkerMailbox } from "../dist/worker-mailbox.js";
import { NodeWorkerSupervisor, parseWorkerStartSpec } from "../dist/node-workers.js";
import { nodeEffectExtinct } from "../dist/node-effect-executor.js";

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
  effects: false,
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

test("effect-approval descriptors require an explicit effect-capable node", () => {
  const binding = bindingFor("approval-spec");
  const base = specFor(binding, "/tmp");
  assert.equal(parseWorkerStartSpec({ ...base, effects: true, effectApprovals: true }).effectApprovals, true);
  assert.throws(() => parseWorkerStartSpec({ ...base, effectApprovals: true }), /requires workspace effects/);
  assert.throws(() => parseWorkerStartSpec({ ...base, effects: true, effectApprovals: false }), /must be true/);
});

test("lease loss cancels a running node-local shell before reporting confirmed stop", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-effect-stop-"));
  const root = join(home, "root"), workspace = join(root, "workspace"), nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  let leaseCurrent = true, supervisor;
  const binding = bindingFor("effect-stop");
  const spec = { ...specFor(binding, workspace, ""), effects: true };
  t.after(async () => { await closeQuietly(supervisor); rmSync(home, { recursive: true, force: true }); });
  supervisor = new NodeWorkerSupervisor({
    ...supervisorOptions(nodeHome, root, () => leaseCurrent),
    executionMode: "workspace-effects"
  });
  const started = await supervisor.start(spec);
  const handle = supervisor.handles.get(binding.runtimeId);
  assert.ok(handle);
  const taskId = `${binding.agentId}:long-running-shell`;
  const args = { command: `sleep 30; printf late > '${join(workspace, "late-marker")}'` };
  handle.child.emit("message", {
    type: "rpc", id: "rpc-long-shell", token: handle.token, agentId: binding.agentId,
    epoch: binding.epoch, method: "bash", args, taskId
  });
  await waitFor(() => supervisor.mailbox.inspectOutbox(binding).some(({ envelope }) =>
    envelope.payload.kind === "rpc" && envelope.payload.rpcId === "rpc-long-shell"));
  const permit = {
    binding, descriptorHash: started.descriptorHash, taskId, method: "bash", args, expiresAt: Date.now() + 20000
  };
  supervisor.mailbox.receive(binding, {
    binding, messageId: "effect-stop-permit", sequence: 1,
    payload: { kind: "reply", rpcId: "rpc-long-shell", ok: true, result: { effectPermit: permit } }
  });
  const pump = supervisor.pump(binding);
  await waitFor(() => !nodeEffectExtinct(binding.runtimeId));
  leaseCurrent = false;
  supervisor.sweep();
  await waitFor(() => supervisor.inspect()[0]?.state === "closed");
  await pump;
  assert.equal(supervisor.inspect()[0].confirmedStopped, true);
  assert.equal(nodeEffectExtinct(binding.runtimeId), true);
  assert.equal(existsSync(join(workspace, "late-marker")), false);
  assertProcessGroupExtinct(started.pid);
});

test("effect arguments containing a configured secret are rejected before they reach the mailbox", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-effect-redaction-"));
  const root = join(home, "root"), workspace = join(root, "workspace"), nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  const secret = "effect-command-secret-sentinel";
  const previous = process.env.MC_NODE_TEST_CREDENTIAL;
  process.env.MC_NODE_TEST_CREDENTIAL = secret;
  let supervisor;
  const binding = bindingFor("effect-redaction");
  const spec = { ...specFor(binding, workspace), effects: true };
  t.after(async () => {
    await closeQuietly(supervisor);
    if (previous === undefined) delete process.env.MC_NODE_TEST_CREDENTIAL;
    else process.env.MC_NODE_TEST_CREDENTIAL = previous;
    rmSync(home, { recursive: true, force: true });
  });
  supervisor = new NodeWorkerSupervisor({
    ...supervisorOptions(nodeHome, root),
    executionMode: "workspace-effects"
  });
  await supervisor.start(spec);
  const handle = supervisor.handles.get(binding.runtimeId);
  assert.ok(handle);
  handle.child.emit("message", {
    type: "rpc", id: "rpc-secret-effect", token: handle.token, agentId: binding.agentId,
    epoch: binding.epoch, method: "bash",
    args: { command: `printf '${secret}' > '${join(workspace, "secret-effect-output")}'` },
    taskId: `${binding.agentId}:secret-effect`
  });
  await waitFor(() => supervisor.inspect()[0]?.state === "closed");
  assert.equal(supervisor.mailbox.inspectOutbox(binding).some(({ envelope }) =>
    envelope.payload.kind === "rpc" && envelope.payload.rpcId === "rpc-secret-effect"), false);
  assert.equal(existsSync(join(workspace, "secret-effect-output")), false);
  assert.equal(JSON.stringify(supervisor.inspect()).includes(secret), false);
});

test("effect receipts redact configured secrets before mailbox disclosure", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-effect-result-redaction-"));
  const root = join(home, "root"), workspace = join(root, "workspace"), nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  const secret = "effect-result-secret-sentinel";
  const bearer = "node-auth-token-secret-sentinel";
  const previous = process.env.MC_NODE_TEST_CREDENTIAL;
  const previousBearer = process.env.NODE_AUTH_TOKEN;
  process.env.MC_NODE_TEST_CREDENTIAL = secret;
  process.env.NODE_AUTH_TOKEN = bearer;
  let supervisor;
  const binding = bindingFor("effect-result-redaction");
  const spec = { ...specFor(binding, workspace), effects: true };
  t.after(async () => {
    await closeQuietly(supervisor);
    if (previous === undefined) delete process.env.MC_NODE_TEST_CREDENTIAL;
    else process.env.MC_NODE_TEST_CREDENTIAL = previous;
    if (previousBearer === undefined) delete process.env.NODE_AUTH_TOKEN;
    else process.env.NODE_AUTH_TOKEN = previousBearer;
    rmSync(home, { recursive: true, force: true });
  });
  supervisor = new NodeWorkerSupervisor({
    ...supervisorOptions(nodeHome, root),
    forbiddenCredentialRefs: ["NODE_AUTH_TOKEN"],
    executionMode: "workspace-effects"
  });
  const started = await supervisor.start(spec);
  const handle = supervisor.handles.get(binding.runtimeId);
  assert.ok(handle);
  const content = `public:${secret}|${handle.token}|${bearer}:end`;
  writeFileSync(join(workspace, "secret.txt"), content);
  const taskId = `${binding.agentId}:secret-read`;
  const args = { path: "secret.txt" };
  const childResults = [];
  const originalSend = handle.child.send;
  handle.child.send = (message, callback) => {
    if (message?.id === "rpc-secret-read") childResults.push(message);
    return originalSend.call(handle.child, message, callback);
  };
  handle.child.emit("message", {
    type: "rpc", id: "rpc-secret-read", token: handle.token, agentId: binding.agentId,
    epoch: binding.epoch, method: "read_file", args, taskId
  });
  await waitFor(() => supervisor.mailbox.inspectOutbox(binding).some(({ envelope }) =>
    envelope.payload.kind === "rpc" && envelope.payload.rpcId === "rpc-secret-read"));
  supervisor.mailbox.receive(binding, {
    binding, messageId: "effect-result-redaction-permit", sequence: 1,
    payload: {
      kind: "reply", rpcId: "rpc-secret-read", ok: true,
      result: { effectPermit: {
        binding, descriptorHash: started.descriptorHash, taskId, method: "read_file", args, expiresAt: Date.now() + 20000
      } }
    }
  });
  await supervisor.pump(binding);
  const [receipt] = supervisor.pendingEffectReceipts();
  assert.ok(receipt);
  assert.equal(receipt.spec.method, "read_file");
  assert.equal(receipt.receipt.result.content, "public:[REDACTED]|[REDACTED]|[REDACTED]:end");
  for (const value of [secret, handle.token, bearer]) {
    for (const evidence of [
      JSON.stringify(receipt),
      JSON.stringify(supervisor.effects.inspect()),
      JSON.stringify(childResults),
      JSON.stringify(supervisor.mailbox.inspectInbox(binding)),
      JSON.stringify(supervisor.mailbox.inspectOutbox(binding))
    ]) assert.equal(evidence.includes(value), false);
  }
  assert.equal(childResults.length, 1);
  assert.equal(childResults[0].result.result.content, "public:[REDACTED]|[REDACTED]|[REDACTED]:end");
});

test("stderr diagnostics redact whole-chunk and split model, IPC, and node bearer secrets", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-stderr-redaction-"));
  const root = join(home, "root"), workspace = join(root, "workspace"), nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  const modelSecret = "stderr-model-credential-sentinel";
  const bearerSecret = "stderr-node-bearer-sentinel";
  const previousModel = process.env.MC_NODE_TEST_CREDENTIAL;
  const previousBearer = process.env.NODE_AUTH_TOKEN;
  process.env.MC_NODE_TEST_CREDENTIAL = modelSecret;
  process.env.NODE_AUTH_TOKEN = bearerSecret;
  let supervisor;
  const binding = bindingFor("stderr-redaction");
  t.after(async () => {
    await closeQuietly(supervisor);
    if (previousModel === undefined) delete process.env.MC_NODE_TEST_CREDENTIAL;
    else process.env.MC_NODE_TEST_CREDENTIAL = previousModel;
    if (previousBearer === undefined) delete process.env.NODE_AUTH_TOKEN;
    else process.env.NODE_AUTH_TOKEN = previousBearer;
    rmSync(home, { recursive: true, force: true });
  });
  supervisor = new NodeWorkerSupervisor({
    ...supervisorOptions(nodeHome, root),
    forbiddenCredentialRefs: ["NODE_AUTH_TOKEN"],
    executionMode: "workspace-effects"
  });
  await supervisor.start({ ...specFor(binding, workspace), effects: true });
  const handle = supervisor.handles.get(binding.runtimeId);
  assert.ok(handle);
  const ipcToken = handle.token;
  const values = [modelSecret, ipcToken, bearerSecret];
  const emissions = [];
  const note = supervisor.note.bind(supervisor);
  supervisor.note = (runtimeId, text) => {
    emissions.push(text);
    note(runtimeId, text);
  };
  const chunks = [
    `whole model=${modelSecret};`,
    `ipc=${ipcToken};bearer=${bearerSecret}; whole-tail\n`,
    `split model=${modelSecret.slice(0, 7)}`,
    `${modelSecret.slice(7)};ipc=${ipcToken.slice(0, 11)}`,
    `${ipcToken.slice(11)};bearer=${bearerSecret.slice(0, 9)}`,
    `${bearerSecret.slice(9)};safe diagnostic survives\n`
  ];
  for (const chunk of chunks) {
    handle.child.stderr.emit("data", Buffer.from(chunk));
    const diagnostic = supervisor.inspect()[0]?.diagnostic;
    if (diagnostic) emissions.push(diagnostic);
  }
  const combined = emissions.join("");
  for (const value of values) {
    assert.equal(combined.includes(value), false);
    assert.equal(combined.includes(value.slice(0, 8)), false);
    assert.equal(combined.includes(value.slice(-8)), false);
  }
  assert.match(combined, /whole model=/);
  assert.match(combined, /whole-tail/);
  assert.match(combined, /split model=/);
  assert.match(combined, /safe diagnostic survives/);
  assert.equal(combined.match(/\[REDACTED\]/g)?.length >= values.length * 2, true);
});

test("effect receipt is durable before a failed child reply send", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-node-worker-effect-send-failure-"));
  const root = join(home, "root"), workspace = join(root, "workspace"), nodeHome = join(home, "node-home");
  mkdirSync(workspace, { recursive: true });
  let supervisor;
  const binding = bindingFor("effect-send-failure");
  const spec = { ...specFor(binding, workspace, ""), effects: true };
  t.after(async () => { await closeQuietly(supervisor); rmSync(home, { recursive: true, force: true }); });
  supervisor = new NodeWorkerSupervisor({
    ...supervisorOptions(nodeHome, root),
    executionMode: "workspace-effects"
  });
  const started = await supervisor.start(spec);
  const handle = supervisor.handles.get(binding.runtimeId);
  assert.ok(handle?.child);
  const rpcId = "rpc-child-send-failure";
  const taskId = `${binding.agentId}:write-before-send-failure`;
  const args = { path: "durable-before-send.txt", content: "written once" };
  handle.child.emit("message", {
    type: "rpc", id: rpcId, token: handle.token, agentId: binding.agentId,
    epoch: binding.epoch, method: "write_file", args, taskId
  });
  await waitFor(() => supervisor.mailbox.inspectOutbox(binding).some(({ envelope }) =>
    envelope.payload.kind === "rpc" && envelope.payload.rpcId === rpcId));
  const permitId = "effect-send-failure-permit";
  supervisor.mailbox.receive(binding, {
    binding, messageId: permitId, sequence: 1,
    payload: {
      kind: "reply", rpcId, ok: true,
      result: { effectPermit: {
        binding, descriptorHash: started.descriptorHash, taskId, method: "write_file", args, expiresAt: Date.now() + 20000
      } }
    }
  });
  const originalSend = handle.child.send;
  let failedReplySend = false;
  handle.child.send = (message, callback) => {
    if (message?.id === rpcId) {
      failedReplySend = true;
      callback(new Error("fixture child send failed"));
      return false;
    }
    return originalSend.call(handle.child, message, callback);
  };
  await supervisor.pump(binding);
  assert.equal(failedReplySend, true);
  assert.equal(supervisor.inspect()[0].state, "closed");
  assert.equal(readFileSync(join(workspace, "durable-before-send.txt"), "utf8"), "written once");
  assert.equal(supervisor.mailbox.inspectInbox(binding).find(({ envelope }) => envelope.messageId === permitId).status, "applied");
  const [receipt] = supervisor.pendingEffectReceipts();
  assert.ok(receipt);
  assert.equal(receipt.spec.taskId, taskId);
  assert.equal(receipt.receipt.status, "succeeded");
});

test("approved effects reject unsolicited, mismatched, and expired permits without an effect", async t => {
  for (const scenario of ["unsolicited", "mismatched", "expired"]) {
    const home = mkdtempSync(join(tmpdir(), `mission-control-approved-${scenario}-`));
    const root = join(home, "root"), workspace = join(root, "workspace");
    const binding = bindingFor(`approved-${scenario}`);
    mkdirSync(workspace, { recursive: true });
    const supervisor = new NodeWorkerSupervisor({
      ...supervisorOptions(join(home, "node-home"), root),
      executionMode: "workspace-effects", effectApprovals: true
    });
    t.after(async () => { await closeQuietly(supervisor); rmSync(home, { recursive: true, force: true }); });
    const started = await supervisor.start({ ...specFor(binding, workspace, ""), effects: true, effectApprovals: true });
    const handle = supervisor.handles.get(binding.runtimeId);
    assert.ok(handle?.child);
    const taskId = `${binding.agentId}:approved-${scenario}`;
    const args = { command: "printf x >> effect-marker" };
    const approvalId = `approval-${scenario}`;
    if (scenario !== "unsolicited") {
      const rpcId = `rpc-${scenario}`;
      handle.child.emit("message", {
        type: "rpc", id: rpcId, token: handle.token, agentId: binding.agentId,
        epoch: binding.epoch, method: "bash", args, taskId
      });
      await waitFor(() => supervisor.mailbox.inspectOutbox(binding).some(({ envelope }) =>
        envelope.payload.kind === "rpc" && envelope.payload.rpcId === rpcId));
      supervisor.mailbox.receive(binding, {
        binding, messageId: `pending-${scenario}`, sequence: 1,
        payload: { kind: "reply", rpcId, ok: true, result: { status: "pending", approvalId } }
      });
      await supervisor.pump(binding);
    }
    const permit = {
      binding, descriptorHash: started.descriptorHash, taskId,
      method: "bash", args, expiresAt: Date.now() + 20000
    };
    if (scenario === "mismatched") permit.args = { command: "touch unexpected" };
    if (scenario === "expired") permit.expiresAt = Date.now() - 1;
    supervisor.mailbox.receive(binding, {
      binding, messageId: `approved-command-${scenario}`, sequence: scenario === "unsolicited" ? 1 : 2,
      payload: { kind: "approved-effect", approvalId, permit }
    });
    await supervisor.pump(binding);
    assert.equal(existsSync(join(workspace, "effect-marker")), false);
    assert.equal(supervisor.inspect().find(row => row.runtimeId === binding.runtimeId).state, "closed");
  }
});

test("duplicate pending reply from a different binding is not accepted by this worker", async t => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-pending-binding-"));
  const root = join(home, "root"), workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const binding = bindingFor("pending-binding");
  let supervisor;
  t.after(async () => { await closeQuietly(supervisor); rmSync(home, { recursive: true, force: true }); });
  supervisor = new NodeWorkerSupervisor({
    ...supervisorOptions(join(home, "node-home"), root), executionMode: "workspace-effects", effectApprovals: true
  });
  await supervisor.start({ ...specFor(binding, workspace, ""), effects: true, effectApprovals: true });
  const foreign = {
    binding: { ...binding, runtimeId: "foreign-runtime" },
    descriptorHash: supervisor.db.prepare("SELECT descriptor_hash FROM node_worker_runtimes WHERE runtime_id=?")
      .get(binding.runtimeId).descriptor_hash,
    taskId: `${binding.agentId}:spoofed`, method: "bash", args: { command: "printf x >> effect-marker" }
  };
  supervisor.db.prepare("INSERT INTO node_effect_approvals(approval_id,spec_json) VALUES(?,?)")
    .run("foreign-approval", JSON.stringify(foreign));
  supervisor.db.prepare("INSERT INTO node_effect_approval_replies(rpc_id,approval_id,result_json) VALUES(?,?,?)")
    .run("foreign-rpc", "foreign-approval", JSON.stringify({ approvalId: "foreign-approval", status: "pending" }));
  supervisor.mailbox.receive(binding, {
    binding, messageId: "foreign-pending-reply", sequence: 1,
    payload: { kind: "reply", rpcId: "foreign-rpc", ok: true,
      result: { status: "pending", approvalId: "foreign-approval" } }
  });
  await supervisor.pump(binding);
  assert.equal(supervisor.inspect().find(row => row.runtimeId === binding.runtimeId).state, "closed");
  assert.equal(existsSync(join(workspace, "effect-marker")), false);
  assert.notEqual(supervisor.mailbox.inspectInbox(binding).find(item =>
    item.envelope.messageId === "foreign-pending-reply").status, "applied");
});

test("duplicate approved terminal command reuses its journal receipt and appends once", async t => {
  const home = mkdtempSync(join(tmpdir(), "mission-control-approved-duplicate-"));
  const root = join(home, "root"), workspace = join(root, "workspace");
  const nodeHome = join(home, "node-home"), binding = bindingFor("approved-duplicate");
  mkdirSync(workspace, { recursive: true });
  let supervisor;
  t.after(async () => { await closeQuietly(supervisor); rmSync(home, { recursive: true, force: true }); });
  supervisor = new NodeWorkerSupervisor({
    ...supervisorOptions(nodeHome, root), executionMode: "workspace-effects", effectApprovals: true
  });
  const started = await supervisor.start({ ...specFor(binding, workspace, ""), effects: true, effectApprovals: true });
  const handle = supervisor.handles.get(binding.runtimeId);
  assert.ok(handle?.child);
  const taskId = `${binding.agentId}:append-once`;
  const args = { command: "printf x >> effect-marker" };
  const approvalId = "approval-append-once";
  handle.child.emit("message", {
    type: "rpc", id: "rpc-append-once", token: handle.token, agentId: binding.agentId,
    epoch: binding.epoch, method: "bash", args, taskId
  });
  await waitFor(() => supervisor.mailbox.inspectOutbox(binding).some(({ envelope }) =>
    envelope.payload.kind === "rpc" && envelope.payload.rpcId === "rpc-append-once"));
  supervisor.mailbox.receive(binding, {
    binding, messageId: "pending-append-once", sequence: 1,
    payload: { kind: "reply", rpcId: "rpc-append-once", ok: true, result: { status: "pending", approvalId } }
  });
  await supervisor.pump(binding);
  const permit = {
    binding, descriptorHash: started.descriptorHash, taskId,
    method: "bash", args, expiresAt: Date.now() + 20000
  };
  supervisor.mailbox.receive(binding, {
    binding, messageId: "approved-append-once", sequence: 2,
    payload: { kind: "approved-effect", approvalId, permit }
  });
  await supervisor.pump(binding);
  supervisor.mailbox.receive(binding, {
    binding, messageId: "approved-append-once-duplicate", sequence: 3,
    payload: { kind: "approved-effect", approvalId, permit }
  });
  await supervisor.pump(binding);
  assert.equal(readFileSync(join(workspace, "effect-marker"), "utf8"), "x");
  assert.equal(supervisor.pendingEffectReceipts().length, 1);
  assert.equal(supervisor.mailbox.inspectInbox(binding)
    .filter(({ envelope }) => envelope.payload.kind === "approved-effect" && envelope.payload.approvalId === approvalId)
    .every(({ status }) => status === "applied"), true);
});

test("failed terminal journal persistence leaves the permit inbox unfinished", async t => {
  for (const caller of ["ordinary", "approved"]) {
    const home = mkdtempSync(join(tmpdir(), `mission-control-effect-journal-failure-${caller}-`));
    const root = join(home, "root"), workspace = join(root, "workspace"), nodeHome = join(home, "node-home");
    mkdirSync(workspace, { recursive: true });
    const binding = bindingFor(`terminal-journal-failure-${caller}`);
    let supervisor;
    t.after(async () => { await closeQuietly(supervisor); rmSync(home, { recursive: true, force: true }); });
    supervisor = new NodeWorkerSupervisor({
      ...supervisorOptions(nodeHome, root), executionMode: "workspace-effects", effectApprovals: true
    });
    const started = await supervisor.start({
      ...specFor(binding, workspace, ""), effects: true, effectApprovals: true
    });
    const handle = supervisor.handles.get(binding.runtimeId);
    assert.ok(handle?.child);
    const rpcId = `rpc-terminal-journal-failure-${caller}`;
    const taskId = `${binding.agentId}:terminal-journal-failure`;
    const args = { path: "journal-failure.txt", content: "executed once" };
    handle.child.emit("message", {
      type: "rpc", id: rpcId, token: handle.token, agentId: binding.agentId,
      epoch: binding.epoch, method: "write_file", taskId, args
    });
    await waitFor(() => supervisor.mailbox.inspectOutbox(binding).some(({ envelope }) =>
      envelope.payload.kind === "rpc" && envelope.payload.rpcId === rpcId));
    if (caller === "approved") {
      supervisor.mailbox.receive(binding, {
        binding, messageId: `pending-${caller}`, sequence: 1,
        payload: { kind: "reply", rpcId, ok: true, result: { status: "pending", approvalId: `approval-${caller}` } }
      });
      await supervisor.pump(binding);
    }
    supervisor.db.exec(`CREATE TRIGGER reject_terminal_effect BEFORE UPDATE OF state,receipt_json ON node_effects
      WHEN NEW.state IN ('succeeded','failed','uncertain')
      BEGIN SELECT RAISE(ABORT, 'injected terminal journal failure'); END`);
    const inboxId = `terminal-journal-failure-permit-${caller}`;
    const permit = {
      binding, descriptorHash: started.descriptorHash, taskId, method: "write_file",
      args, expiresAt: Date.now() + 20000
    };
    supervisor.mailbox.receive(binding, {
      binding, messageId: inboxId, sequence: caller === "approved" ? 2 : 1,
      payload: caller === "approved"
        ? { kind: "approved-effect", approvalId: `approval-${caller}`, permit }
        : { kind: "reply", rpcId, ok: true, result: { effectPermit: permit } }
    });
    await supervisor.pump(binding);
    const inbox = supervisor.mailbox.inspectInbox(binding).find(item => item.envelope.messageId === inboxId);
    assert.ok(["processing", "uncertain"].includes(inbox.status));
    const [entry] = supervisor.effects.inspect();
    assert.equal(entry.state, "executing");
    assert.equal(entry.receipt, null);
    assert.equal(readFileSync(join(workspace, "journal-failure.txt"), "utf8"), "executed once");
  }
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
