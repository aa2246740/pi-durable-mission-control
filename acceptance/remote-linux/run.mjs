import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { delivery, deliveryName, shellQuote, startMock } from "./mock.mjs";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const containerCLI = "/opt/homebrew/bin/container";
const prefix = "mc-acc-e-gpt-";

export function parseOptions(args) {
  const options = { keep: false, timeoutMs: 180000 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keep") options.keep = true;
    else if (args[i] === "--out" && args[i + 1]) options.out = resolve(args[++i]);
    else if (args[i] === "--timeout-ms" && args[i + 1]) {
      options.timeoutMs = Number(args[++i]);
      assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0, "--timeout-ms must be a positive integer");
    } else throw new Error(`Unknown or incomplete option ${args[i]}`);
  }
  return options;
}

async function relay(targetPort) {
  const sockets = new Set();
  const server = createServer((socket) => {
    const upstream = connect(targetPort, "127.0.0.1");
    for (const stream of [socket, upstream]) {
      sockets.add(stream);
      stream.on("close", () => sockets.delete(stream));
      stream.on("error", () => { socket.destroy(); upstream.destroy(); });
    }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "192.168.64.1", resolve); });
  return { port: server.address().port, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  } };
}

function childProcess(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let error;
  child.stdout.on("data", (chunk) => { output = (output + chunk.toString()).slice(-2 * 1024 * 1024); });
  child.stderr.on("data", (chunk) => { output = (output + chunk.toString()).slice(-2 * 1024 * 1024); });
  child.stdin.on("error", (value) => { error ??= value; });
  const done = new Promise((resolve) => {
    child.on("error", (value) => { error = value; resolve(); });
    child.on("close", resolve);
  });
  return { child, done, output: () => output, error: () => error };
}

async function command(args) {
  const handle = childProcess(containerCLI, args);
  const timer = setTimeout(() => handle.child.kill("SIGKILL"), 20000);
  await handle.done;
  clearTimeout(timer);
  if (handle.error() || handle.child.exitCode !== 0) throw new Error(`container ${args[0]} failed: ${handle.error()?.message ?? handle.output()}`);
  return handle.output();
}

const containerNames = async () => (await command(["list", "--all", "--quiet"])).trim().split(/\s+/).filter((name) => name.startsWith(prefix));

export async function run(options) {
  assert.ok(existsSync(join(root, "dist/cli.js")), "Build first with npm run build");
  const proof = options.out ?? join(tmpdir(), `mc-acceptance-${Date.now()}-${randomUUID().slice(0, 8)}`);
  // Never reuse an existing directory: success cleanup must not delete caller data.
  mkdirSync(proof, { mode: 0o700 });
  const startedAt = Date.now();
  const secrets = [];
  const redact = (text) => secrets.reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), String(text));
  const save = (name, value) => writeFileSync(join(proof, name), redact(JSON.stringify(value, null, 2)) + "\n", { mode: 0o600 });
  const name = `${prefix}${randomUUID().slice(0, 12)}`;
  const machineId = `linux-${randomUUID().slice(0, 12)}`;
  const home = join(proof, "home");
  const credential = randomUUID();
  secrets.push(credential);
  let daemon, node, mock, nodeRelay, modelRelay, detail, summary;
  let failure;
  let mockFailure;
  let aborted;
  const abort = (signal) => { aborted = new Error(`Interrupted by ${signal}`); };
  const onInt = () => abort("SIGINT");
  const onTerm = () => abort("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const deadline = startedAt + options.timeoutMs;
  const check = () => {
    if (aborted) throw aborted;
    if (mockFailure) throw mockFailure;
    if (Date.now() >= deadline) throw new Error(`Acceptance timed out after ${options.timeoutMs} ms`);
    for (const handle of [daemon, node]) if (handle && (handle.error() || handle.child.exitCode !== null || handle.child.signalCode !== null)) {
      throw new Error(`Acceptance subprocess exited early: ${redact(handle.error()?.message ?? handle.output())}`);
    }
  };
  const wait = async (predicate) => {
    for (;;) {
      check();
      const value = await predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const records = [];
  try {
    assert.deepEqual(await containerNames(), [], `Existing ${prefix} containers require their owner's cleanup`);
    const images = JSON.parse(await command(["image", "list", "--format", "json"]));
    const image = images.find((i) => /^(docker\.io\/library\/)?node:22-bookworm-slim$/.test(i.configuration.name));
    assert.ok(image?.variants.some((v) => v.platform.architecture === "arm64" && v.platform.os === "linux"), "Required cached node:22-bookworm-slim arm64 image missing; pulling is forbidden");
    const testPath = join(proof, "host-acceptance.test.mjs");
    writeFileSync(testPath, `import assert from 'node:assert/strict';\nimport {readFileSync,statSync} from 'node:fs';\nimport {test} from 'node:test';\nimport {join} from 'node:path';\nconst file=join(process.cwd(),${JSON.stringify(deliveryName)});\ntest('frozen Linux content',()=>assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),${JSON.stringify(delivery)}));\ntest('detached coordinator snapshot',()=>assert.match(process.cwd(),/validations\\/remote\\/[a-f0-9]{32}$/));\ntest('read-only host acceptance file',()=>assert.equal(statSync(new URL(import.meta.url)).mode & 0o222,0));\nconsole.log('FROZEN-SNAPSHOT-ACCEPTED');\n`, { mode: 0o400 });
    const acceptanceCommand = `${shellQuote(process.execPath)} --test ${shellQuote(testPath)}`;
    mock = await startMock({ credential, acceptanceCommand, hostTestPath: testPath,
      record: (record) => { records.push(record); save("mock-tools.json", records); }, fail: (error) => { mockFailure = error; } });
    modelRelay = await relay(mock.address().port);
    // The coordinator receives only the deliberately fake model credential.
    const env = { PATH: process.env.PATH, HOME: proof, TMPDIR: proof, MC_ACCEPTANCE_MODEL_CREDENTIAL: credential };
    daemon = childProcess(process.execPath, [join(root, "dist/cli.js"), "serve", "--home", home, "--port", "0", "--node-port", "0"], env);
    const daemonInfo = await wait(() => existsSync(join(home, "daemon.json")) && JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")));
    const adminToken = readFileSync(join(home, "admin.token"), "utf8").trim();
    secrets.push(adminToken);
    const base = `http://127.0.0.1:${daemonInfo.port}`;
    const api = async (path, body) => {
      check();
      const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
      const value = await response.json();
      assert.ok(response.ok, redact(`${path}: ${response.status} ${JSON.stringify(value)}`));
      return value;
    };
    const enrolled = await api("/api/machines", { id: machineId, name: "Deterministic Linux acceptance" });
    secrets.push(enrolled.token);
    nodeRelay = await relay(daemonInfo.nodePort);
    node = childProcess(containerCLI, ["run", "--rm", "-i", "--name", name, "--arch", "arm64", "--cpus", "2", "--memory", "512M",
      "-v", `${join(root, "dist")}:/app/dist:ro`, "-v", `${join(root, "package.json")}:/app/package.json:ro`,
      "-v", `${realpathSync(join(root, "node_modules"))}:/app/node_modules:ro`,
      "-v", `${join(root, "acceptance/remote-linux/bootstrap.mjs")}:/app/bootstrap.mjs:ro`,
      image.configuration.name, "sh", "-c", 'IFS= read -r MC_ACCEPTANCE_NODE_TOKEN; IFS= read -r MC_ACCEPTANCE_MODEL_CREDENTIAL; export MC_ACCEPTANCE_NODE_TOKEN MC_ACCEPTANCE_MODEL_CREDENTIAL; exec node /app/bootstrap.mjs "$@"',
      "acceptance", String(nodeRelay.port), machineId], { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: proof });
    // No credential values are part of argv, a mount, an env-file or evidence.
    node.child.stdin.end(`${enrolled.token}\n${credential}\n`);
    const machine = await wait(async () => (await api("/api/state")).machines.find((m) => m.id === machineId && m.status === "online"));
    assert.equal(machine.capabilities.platform, "linux");
    assert.equal(machine.capabilities.executionMode, "workspace-effects");
    assert.ok(machine.capabilities.credentialRefs.includes("MC_ACCEPTANCE_MODEL_CREDENTIAL"));
    const probe = await api(`/api/machines/${machineId}/probe`, { requestId: randomUUID(), path: "/work" });
    await wait(async () => {
      const result = await api(`/api/machines/${machineId}/commands/${probe.id}`);
      if (result.status === "failed") throw new Error("Workspace probe failed");
      return result.status === "completed";
    });
    const remoteWorkspace = await api("/api/workspaces", { name: "Linux acceptance", machineId, probeCommandId: probe.id });
    mkdirSync(join(proof, "local-workspace"));
    const localWorkspace = await api("/api/workspaces", { name: "Coordinator acceptance", machineId: "local", path: join(proof, "local-workspace") });
    const profile = { name: "Deterministic acceptance mock", api: "openai-completions", modelId: "acceptance-mock", credentialEnv: "MC_ACCEPTANCE_MODEL_CREDENTIAL",
      contextWindow: 128000, maxTokens: 2048, reasoning: false, toolCalling: true, vision: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    for (const [id, baseUrl] of [["acceptance-local", `http://127.0.0.1:${mock.address().port}/v1`], ["acceptance-remote", `http://192.168.64.1:${modelRelay.port}/v1`]]) {
      await api("/api/profiles", { ...profile, id, baseUrl });
    }
    const roles = ["orchestrator", "worker", "validator"].map((kind) => ({ id: `acceptance-${kind}`, name: kind, kind,
      instructions: "Follow the deterministic acceptance workflow using real tool results.", profileId: kind === "worker" ? "acceptance-remote" : "acceptance-local", mcpPermissions: [] }));
    for (const role of roles) await api("/api/roles", role);
    const mission = await api("/api/missions", { title: "Deterministic remote Linux frozen acceptance", goal: "Deliver on Linux and independently accept the frozen coordinator snapshot.",
      acceptance: `Host-only, read-only acceptance command: ${acceptanceCommand}. Publish ${deliveryName} with version 1, then mutate live source to version 2 before review.`,
      workspaceId: localWorkspace.id, remoteWorkspaceIds: [remoteWorkspace.id], roleIds: roles.map((r) => r.id), maxTurns: 80, maxCost: 0, autonomy: "trusted", workspaceStrategy: "shared",
      assertions: [{ id: "LINUX-FROZEN", description: "Linux self-check and frozen delivery pass independent coordinator tests even after the live source changes." }] });
    await api(`/api/missions/${mission.id}/start`, {});
    detail = await wait(async () => {
      const current = await api(`/api/missions/${mission.id}`);
      detail = current;
      if (["completed", "failed", "blocked"].includes(current.mission.status)) return current;
      return false;
    });
    assert.equal(detail.mission.status, "completed");
    const runtimes = await wait(async () => {
      const current = await api(`/api/missions/${mission.id}/runtimes`);
      if (current.some((runtime) => runtime.state === "uncertain")) throw new Error("Remote runtime stop is uncertain");
      return current.length === 1 && current.every((runtime) => runtime.state === "closed") && current;
    });
    detail = await api(`/api/missions/${mission.id}`);
    save("mission.json", detail);
    save("runtimes.json", runtimes);
    assert.equal(detail.mission.status, "completed");
    assert.equal(detail.tasks.length, 1);
    assert.equal(detail.tasks[0].status, "accepted");
    assert.deepEqual(detail.blockers, []);
    const artifact = detail.artifacts[0];
    assert.equal(detail.artifacts.length, 1);
    assert.equal(artifact.remoteProvenance.machineId, machineId);
    const receipt = detail.validationReceipts[0];
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.snapshotIntegrity, true);
    assert.equal(receipt.workspaceKind, "remote-snapshot");
    assert.equal(receipt.command, acceptanceCommand);
    const worker = detail.agents.find((a) => a.kind === "worker");
    const validator = detail.agents.find((a) => a.kind === "validator");
    assert.equal(worker.machineId, machineId);
    assert.equal(validator.machineId, "local");
    assert.notEqual(worker.id, validator.id);
    assert.equal(receipt.validatorId, validator.id);
    const effects = detail.events.filter((e) => e.type === "remote_effect_receipt" && e.agentId === worker.id).map((e) => e.data.receipt).filter((r) => r.status === "succeeded").map((r) => r.result);
    assert.ok(effects.some((r) => r.exitCode === 0 && r.stdout?.includes("/usr/local/bin/node") && r.stdout.includes("LINUX-SELF-CHECK-OK")), "No successful Linux PATH/self-check receipt");
    assert.ok(effects.some((r) => r.exitCode === 0 && r.stdout?.includes("LIVE-SOURCE-CHANGED")), "No live source mutation receipt");
    assert.ok(records.some((r) => r.role === "validator" && r.name === "RunValidation"));
    assert.equal(records.some((r) => r.role === "validator" && r.name === "RequestUserInput"), false);
    const response = await fetch(`${base}/api/artifacts/${artifact.id}/content`, { headers: { authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const disposition = response.headers.get("content-disposition");
    assert.equal(disposition, `attachment; filename="${deliveryName}"; filename*=UTF-8''${deliveryName}`);
    assert.deepEqual(JSON.parse(await response.text()), delivery);
    summary = { status: "passed", durationMs: Date.now() - startedAt, missionStatus: detail.mission.status, taskStatus: detail.tasks[0].status,
      exitCode: receipt.exitCode, snapshotIntegrity: receipt.snapshotIntegrity, workspaceKind: receipt.workspaceKind,
      machineId, platform: machine.capabilities.platform, node: machine.capabilities.node, remoteProvenance: artifact.remoteProvenance,
      contentDisposition: disposition, linuxNodePath: "/usr/local/bin/node", liveSourceChanged: true, blockers: detail.blockers.length,
      validatorRequestedUserInput: false, remoteRuntimeState: runtimes[0].state, mockCost: 0, image: { name: image.configuration.name, digest: image.id },
      tools: records.map(({ role, name }) => ({ role, name })) };
  } catch (error) {
    failure = error;
    summary = { status: "failed", durationMs: Date.now() - startedAt, error: redact(error.message), missionStatus: detail?.mission.status };
    if (detail) save("mission.json", detail);
  } finally {
    const cleanupErrors = [];
    const cleanup = async (label, fn) => { try { await fn(); } catch (error) { cleanupErrors.push(`${label}: ${redact(error.message)}`); } };
    await cleanup("coordinator", async () => {
      if (!daemon) return;
      if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill("SIGTERM");
      const timer = setTimeout(() => daemon.child.kill("SIGKILL"), 12000);
      await daemon.done;
      clearTimeout(timer);
      assert.equal(daemon.child.signalCode, null, "Coordinator required forced shutdown");
    });
    await cleanup("container", async () => {
      if (!node) return;
      if ((await containerNames()).includes(name)) {
        try { await command(["stop", name]); }
        catch (error) { if ((await containerNames()).includes(name)) throw error; }
      }
      if ((await containerNames()).includes(name)) {
        try { await command(["delete", name]); }
        catch (error) { if ((await containerNames()).includes(name)) throw error; }
      }
      const timer = setTimeout(() => node.child.kill("SIGKILL"), 10000);
      await node.done;
      clearTimeout(timer);
    });
    for (const [label, server] of [["node relay", nodeRelay], ["model relay", modelRelay]]) if (server) await cleanup(label, () => server.close());
    if (mock) await cleanup("mock", async () => { mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); });
    if (daemon) writeFileSync(join(proof, "coordinator.log"), redact(daemon.output()), { mode: 0o600 });
    if (node) writeFileSync(join(proof, "container.log"), redact(node.output()), { mode: 0o600 });
    rmSync(join(home, "admin.token"), { force: true });
    await cleanup("credential evidence", async () => {
      const scan = (path) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const file = join(path, entry.name);
          if (entry.isDirectory()) scan(file);
          else if (entry.isFile()) {
            const bytes = readFileSync(file);
            assert.ok(secrets.every((secret) => !bytes.includes(Buffer.from(secret))), `Credential found in ${file}`);
          }
        }
      };
      scan(proof);
    });
    await cleanup("container residue", async () => assert.deepEqual(await containerNames(), []));
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    summary ??= { status: "failed" };
    summary.cleanupVerified = cleanupErrors.length === 0;
    if (cleanupErrors.length) {
      summary.status = "failed";
      summary.cleanupErrors = cleanupErrors;
      failure ??= new Error(cleanupErrors.join("; "));
    }
    summary.durationMs = Date.now() - startedAt;
    save("summary.json", summary);
    if (summary.cleanupVerified) process.stdout.write("cleanup verified\n");
    process.stdout.write(`summary ${JSON.stringify(summary)}\n`);
    if (failure || options.keep) process.stdout.write(`proof ${proof}\n`);
    else rmSync(proof, { recursive: true });
  }
  if (failure) throw new Error(redact(`${failure.message}; proof ${proof}`));
  return { summary, proof };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(parseOptions(process.argv.slice(2))).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
