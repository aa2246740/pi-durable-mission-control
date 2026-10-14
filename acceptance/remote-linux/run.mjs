import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRealSuccess, collectRealEvidence, kinds, readConfig, readSecrets, redact as redactSecrets, scanEvidence, sha256, realMission, writeFrozenAcceptance, faultInjectionScript, nodeCredentialShell, frozenAcceptanceCommand, checkFrozenAcceptance } from "./real.mjs";
import { readSessionEvidence, refreshStoppedExport, remoteRuntimeHome, remoteSessionScript, stopNodeForEvidenceScript } from "./session-evidence.mjs";
import { delivery, deliveryName, shellQuote, startMock } from "./mock.mjs";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const containerCLI = "/opt/homebrew/bin/container";
// Concurrent runs (for example from separate checkouts) must use distinct prefixes.
const prefix = process.env.MC_ACCEPTANCE_CONTAINER_PREFIX ?? "mc-acc-";
if (!/^mc-acc-[a-z0-9-]*$/.test(prefix)) throw new Error("MC_ACCEPTANCE_CONTAINER_PREFIX must start with mc-acc- and use lowercase letters, digits and hyphens");

export function parseOptions(args) {
  const options = { keep: false, timeoutMs: 180000 };
  let explicitTimeout = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--keep") options.keep = true;
    else if (args[i] === "--real" && args[i + 1]) options.real = resolve(args[++i]);
    else if (args[i] === "--secrets-file" && args[i + 1]) options.secretsFile = resolve(args[++i]);
    else if (args[i] === "--discard") options.discard = true;
    else if (args[i] === "--out" && args[i + 1]) options.out = resolve(args[++i]);
    else if (args[i] === "--timeout-ms" && args[i + 1]) {
      explicitTimeout = true;
      options.timeoutMs = Number(args[++i]);
      assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0, "--timeout-ms must be a positive integer");
    } else throw new Error(`Unknown or incomplete option ${args[i]}`);
  }
  if (options.real) {
    assert.ok(options.secretsFile, "--real requires --secrets-file");
    if (!explicitTimeout) options.timeoutMs = 1800000;
  } else assert.ok(!options.secretsFile && !options.discard, "--secrets-file and --discard require --real");
  assert.ok(!(options.keep && options.discard), "--keep conflicts with --discard");
  return options;
}

export function normalizeFailure(error, { aborted, deadline, timeoutMs, now = Date.now() }) {
  if (aborted) return aborted;
  if (now >= deadline) return new Error(`Acceptance timed out after ${timeoutMs} ms`);
  return error;
}

export function assertCoordinatorExit(signalCode, ready) {
  // A fresh coordinator has no worker children before its ready record exists.
  assert.ok(signalCode === null || (!ready && signalCode === "SIGTERM"), "Coordinator required forced shutdown");
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

export function childProcess(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  let error;
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-2 * 1024 * 1024); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-2 * 1024 * 1024); });
  child.stdin.on("error", (value) => { error ??= value; });
  const done = new Promise((resolve) => {
    child.on("error", (value) => { error = value; resolve(); });
    child.on("close", resolve);
  });
  return { child, done, stdout: () => stdout, stderr: () => stderr, output: () => stdout + stderr, error: () => error };
}

export async function commandOutput(executable, args, env = process.env) {
  const handle = childProcess(executable, args, env);
  const timer = setTimeout(() => handle.child.kill("SIGKILL"), 20000);
  await handle.done;
  clearTimeout(timer);
  if (handle.error() || handle.child.exitCode !== 0) throw new Error(`Command failed: ${handle.error()?.message ?? handle.output()}`);
  return handle.stdout();
}

const command = (args) => commandOutput(containerCLI, args, { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR });

const containerNames = async () => (await command(["list", "--all", "--quiet"])).trim().split(/\s+/).filter((name) => name.startsWith(prefix));

export function finalizeEvidence(proof, secrets, summary, save) {
  save("summary.json", summary);
  try { scanEvidence(proof, secrets); }
  catch (error) {
    summary.status = "failed";
    summary.cleanupVerified = false;
    summary.cleanupErrors = [...(summary.cleanupErrors ?? []), "credential evidence: final scan failed"];
    save("summary.json", summary);
    scanEvidence(proof, secrets);
    throw error;
  }
}

export async function run(options) {
  const config = options.real ? readConfig(options.real) : undefined;
  const credentials = config ? readSecrets(options.secretsFile, kinds.map((kind) => config[kind].credentialEnv)) : undefined;
  assert.ok(existsSync(join(root, "dist/cli.js")), "Build first with npm run build");
  const proof = options.out ?? join(tmpdir(), `mc-acceptance-${Date.now()}-${randomUUID().slice(0, 8)}`);
  // Never reuse an existing directory: success cleanup must not delete caller data.
  mkdirSync(proof, { mode: 0o700 });
  const startedAt = Date.now();
  const secrets = credentials ? Object.values(credentials) : [];
  const redact = (text) => redactSecrets(text, secrets);
  const save = (name, value) => writeFileSync(join(proof, name), redact(JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2)) + "\n", { mode: 0o600 });
  const name = `${prefix}${randomUUID().slice(0, 12)}`;
  const machineId = `linux-${randomUUID().slice(0, 12)}`;
  const home = join(proof, "home");
  const credential = randomUUID();
  secrets.push(credential);
  let daemon, node, mock, nodeRelay, modelRelay, detail, summary;
  let captureReal, exportedReal, mutation, acceptance, acceptanceCommand;
  const sessions = [];
  const seenReceipts = new Set();
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

    const env = { PATH: process.env.PATH, HOME: proof, TMPDIR: proof };
    if (config) {
      acceptance = writeFrozenAcceptance(proof);
      acceptance.checks = [];
      acceptance.immutable = { attempted: process.platform === "darwin", applied: false };
      if (acceptance.immutable.attempted) {
        const flags = childProcess("/bin/chflags", ["uchg", acceptance.path], env);
        await flags.done;
        acceptance.immutable.applied = !flags.error() && flags.child.exitCode === 0;
        if (!acceptance.immutable.applied) acceptance.immutable.error = "chflags uchg failed";
      }
      acceptanceCommand = frozenAcceptanceCommand(acceptance);
      save("real-config.json", config);
      save("frozen-acceptance.json", acceptance);
      for (const kind of ["orchestrator", "validator"]) env[config[kind].credentialEnv] = credentials[config[kind].credentialEnv];
    } else {
      const testPath = join(proof, "host-acceptance.test.mjs");
      writeFileSync(testPath, `import assert from 'node:assert/strict';\nimport {readFileSync,statSync} from 'node:fs';\nimport {test} from 'node:test';\nimport {join} from 'node:path';\nconst file=join(process.cwd(),${JSON.stringify(deliveryName)});\ntest('frozen Linux content',()=>assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),${JSON.stringify(delivery)}));\ntest('detached coordinator snapshot',()=>assert.match(process.cwd(),/validations\\/remote\\/[a-f0-9]{32}$/));\ntest('read-only host acceptance file',()=>assert.equal(statSync(new URL(import.meta.url)).mode & 0o222,0));\nconsole.log('FROZEN-SNAPSHOT-ACCEPTED');\n`, { mode: 0o400 });
      acceptanceCommand = `${shellQuote(process.execPath)} --test ${shellQuote(testPath)}`;
      mock = await startMock({ credential, acceptanceCommand, hostTestPath: testPath,
        record: (record) => { records.push(record); save("mock-tools.json", records); }, fail: (error) => { mockFailure = error; } });
      modelRelay = await relay(mock.address().port);
      env.MC_ACCEPTANCE_MODEL_CREDENTIAL = credential;
    }
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
    const enrolled = await api("/api/machines", { id: machineId, name: config ? "Real model Linux acceptance" : "Deterministic Linux acceptance" });
    secrets.push(enrolled.token);
    nodeRelay = await relay(daemonInfo.nodePort);
    const credentialRefs = config ? [config.worker.credentialEnv] : ["MC_ACCEPTANCE_MODEL_CREDENTIAL"];
    // Values travel only over stdin; the shell reads one value for each explicitly allowed name.
    const nodeInput = [enrolled.token, ...credentialRefs.map((ref) => config ? credentials[ref] : credential)].join("\n") + "\n";
    node = childProcess(containerCLI, ["run", "--rm", "-i", ...(config ? ["--env", "MC_ACCEPTANCE_RETAIN_CONTAINER=1"] : []), "--name", name, "--arch", "arm64", "--cpus", "2", "--memory", "512M",
      "-v", `${join(root, "dist")}:/app/dist:ro`, "-v", `${join(root, "package.json")}:/app/package.json:ro`,
      "-v", `${realpathSync(join(root, "node_modules"))}:/app/node_modules:ro`,
      "-v", `${join(root, "acceptance/remote-linux/bootstrap.mjs")}:/app/bootstrap.mjs:ro`,
      image.configuration.name, "sh", "-c", nodeCredentialShell,
      "acceptance", String(nodeRelay.port), machineId, ...credentialRefs], { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: proof });
    node.child.stdin.end(nodeInput);
    const machine = await wait(async () => (await api("/api/state")).machines.find((m) => m.id === machineId && m.status === "online"));
    assert.equal(machine.capabilities.platform, "linux");
    assert.equal(machine.capabilities.executionMode, "workspace-effects");
    assert.ok(credentialRefs.every((ref) => machine.capabilities.credentialRefs.includes(ref)));
    const probe = await api(`/api/machines/${machineId}/probe`, { requestId: randomUUID(), path: "/work" });
    await wait(async () => {
      const result = await api(`/api/machines/${machineId}/commands/${probe.id}`);
      if (result.status === "failed") throw new Error("Workspace probe failed");
      return result.status === "completed";
    });
    const remoteWorkspace = await api("/api/workspaces", { name: "Linux acceptance", machineId, probeCommandId: probe.id });
    mkdirSync(join(proof, "local-workspace"));
    const localWorkspace = await api("/api/workspaces", { name: "Coordinator acceptance", machineId: "local", path: join(proof, "local-workspace") });
    let mission;
    if (config) {
      for (const kind of kinds) {
        await api("/api/profiles", { ...config[kind], id: `acceptance-${kind}` });
        await api("/api/roles", { id: `acceptance-${kind}`, name: kind, kind, profileId: `acceptance-${kind}`,
          instructions: `You are the ${kind} for this mission.`, mcpPermissions: [] });
      }
      mission = await api("/api/missions", realMission({ acceptanceCommand, localWorkspaceId: localWorkspace.id, remoteWorkspaceId: remoteWorkspace.id, roleIds: kinds.map((kind) => `acceptance-${kind}`) }));
      // Evidence reads remain possible after timeout; they never mutate mission state.
      captureReal = async () => {
        const response = await fetch(`${base}/api/missions/${mission.id}/export`, { headers: { authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(5000) });
        assert.ok(response.ok, "Mission export failed");
        const exported = await response.json();
        detail = exported;
        exportedReal = exported;
        save("mission-export.json", exported);
        const casHashes = Object.fromEntries(exported.artifacts.map((artifact) => {
          let digest = null;
          try { digest = sha256(readFileSync(join(home, "artifacts", artifact.sha256))); } catch { /* Missing CAS remains explicit failed evidence. */ }
          return [artifact.id, digest];
        }));
        if (mutation) {
          mutation.casFinalSha256 = casHashes[mutation.artifactId];
          save("fault-injection.json", mutation);
        }
        const evidence = collectRealEvidence(exported, mutation, acceptance, casHashes, sessions);
        save("real-evidence.json", evidence);
        save("mission.json", detail);
        return evidence;
      };
    } else {
      const profile = { name: "Deterministic acceptance mock", api: "openai-completions", modelId: "acceptance-mock", credentialEnv: "MC_ACCEPTANCE_MODEL_CREDENTIAL",
        contextWindow: 128000, maxTokens: 2048, reasoning: false, toolCalling: true, vision: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      for (const [id, baseUrl] of [["acceptance-local", `http://127.0.0.1:${mock.address().port}/v1`], ["acceptance-remote", `http://192.168.64.1:${modelRelay.port}/v1`]]) {
        await api("/api/profiles", { ...profile, id, baseUrl });
      }
      const roles = ["orchestrator", "worker", "validator"].map((kind) => ({ id: `acceptance-${kind}`, name: kind, kind,
        instructions: "Follow the deterministic acceptance workflow using real tool results.", profileId: kind === "worker" ? "acceptance-remote" : "acceptance-local", mcpPermissions: [] }));
      for (const role of roles) await api("/api/roles", role);
      mission = await api("/api/missions", { title: "Deterministic remote Linux frozen acceptance", goal: "Deliver on Linux and independently accept the frozen coordinator snapshot.",
        acceptance: `Host-only, read-only acceptance command: ${acceptanceCommand}. Publish ${deliveryName} with version 1, then mutate live source to version 2 before review.`,
        workspaceId: localWorkspace.id, remoteWorkspaceIds: [remoteWorkspace.id], roleIds: roles.map((r) => r.id), maxTurns: 80, maxCost: 0, autonomy: "trusted", workspaceStrategy: "shared",
        assertions: [{ id: "LINUX-FROZEN", description: "Linux self-check and frozen delivery pass independent coordinator tests even after the live source changes." }] });
    }
    await api(`/api/missions/${mission.id}/start`, {});
    detail = await wait(async () => {
      const current = await api(`/api/missions/${mission.id}`);
      detail = current;
      if (config) for (const receipt of current.validationReceipts) {
        if (seenReceipts.has(receipt.id)) continue;
        seenReceipts.add(receipt.id);
        acceptance.checks.push(checkFrozenAcceptance(acceptance, "receipt", receipt.id));
        save("frozen-acceptance.json", acceptance);
      }
      if (config && !mutation) {
        const published = current.events.find((event) => event.type === "artifact_published" && current.agents.some((agent) => agent.id === event.agentId && agent.kind === "worker"));
        if (published) {
          acceptance.checks.push(checkFrozenAcceptance(acceptance, "publication"));
          save("frozen-acceptance.json", acceptance);
          const artifact = current.artifacts.find((value) => value.id === published.data.artifactId);
          assert.ok(artifact?.remoteProvenance?.machineId === machineId, "Publication did not come from the assigned Linux node");
          assert.equal(artifact.path, "/work/totals.mjs", "Publish totals.mjs at the Linux workspace root");
          assert.equal(published.data.sha256, artifact.sha256);
          const casPath = join(home, "artifacts", artifact.sha256);
          const casBeforeSha256 = sha256(readFileSync(casPath));
          assert.equal(casBeforeSha256, artifact.sha256);
          // container exec --help: container exec [options] <container-id> <arguments> ...
          const guest = JSON.parse(await command(["exec", name, "node", "-e", faultInjectionScript, artifact.path]));
          mutation = { artifactId: artifact.id, eventSeq: published.seq, publishedSha256: artifact.sha256, ...guest,
            casBeforeSha256, casAfterSha256: sha256(readFileSync(casPath)), completedAt: new Date().toISOString() };
          save("fault-injection.json", mutation);
          assert.equal(mutation.beforeSha256, artifact.sha256, "Live source changed before fault injection");
          assert.notEqual(mutation.beforeSha256, mutation.afterSha256);
          assert.equal(mutation.casAfterSha256, artifact.sha256, "CAS changed during fault injection");
        }
      }
      if (config && current.mission.turns >= current.mission.maxTurns) return current;
      if (["completed", "failed", "blocked"].includes(current.mission.status)) return current;
      return false;
    });
    if (config) {
      const evidence = await captureReal();
      assertRealSuccess(detail, evidence, acceptanceCommand, machineId);
    } else assert.equal(detail.mission.status, "completed");
    const runtimes = await wait(async () => {
      const current = await api(`/api/missions/${mission.id}/runtimes`);
      if (current.some((runtime) => runtime.state === "uncertain")) throw new Error("Remote runtime stop is uncertain");
      return current.length === 1 && current.every((runtime) => runtime.state === "closed") && current;
    });
    detail = await api(`/api/missions/${mission.id}`);
    save("mission.json", detail);
    save("runtimes.json", runtimes);
    if (config) {
      const evidence = await captureReal();
      assertRealSuccess(detail, evidence, acceptanceCommand, machineId);
      summary = { status: "passed", mode: "real", durationMs: Date.now() - startedAt, missionStatus: detail.mission.status,
        turns: evidence.turns, maxTurns: evidence.maxTurns, roles: evidence.roles, costKnown: evidence.costKnown,
        acceptance, mutation, tools: evidence.tools, blockers: detail.blockers, remoteRuntimeState: runtimes[0].state,
        image: { name: image.configuration.name, digest: image.id } };
    } else {
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
    }
  } catch (error) {
    error = normalizeFailure(error, { aborted, deadline, timeoutMs: options.timeoutMs });
    failure = error;
    summary = { status: "failed", durationMs: Date.now() - startedAt, error: redact(error.message), missionStatus: detail?.mission.status };
    if (captureReal) {
      try { await captureReal(); }
      catch (captureError) { summary.evidenceError = redact(captureError.message); }
    }
    if (config) Object.assign(summary, { mode: "real", turns: detail?.mission.turns, maxTurns: 60, blockers: detail?.blockers, acceptance, mutation });
    if (detail) save("mission.json", detail);
  } finally {
    const cleanupErrors = [];
    const cleanup = async (label, fn) => { try { await fn(); } catch (error) { cleanupErrors.push(`${label}: ${redact(error.message)}`); } };
    await cleanup("coordinator", async () => {
      if (!daemon) return;
      const ready = existsSync(join(home, "daemon.json"));
      if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill("SIGTERM");
      const timer = setTimeout(() => daemon.child.kill("SIGKILL"), 12000);
      await daemon.done;
      clearTimeout(timer);
      assertCoordinatorExit(daemon.child.signalCode, ready);
    });
    if (config && acceptance) {
      acceptance.checks.push(checkFrozenAcceptance(acceptance, "end"));
      save("frozen-acceptance.json", acceptance);
    }
    if (config && exportedReal) {
      await cleanup("stopped export records", async () => {
        exportedReal = refreshStoppedExport(join(home, "control.sqlite"), exportedReal);
        save("mission-export.json", exportedReal);
      });
      let remoteStopped = false;
      if (node) {
        try {
          const stopped = JSON.parse(await command(["exec", name, "node", "-e", stopNodeForEvidenceScript]));
          remoteStopped = stopped.stopped === true;
          save("node-evidence-stop.json", stopped);
        } catch { save("node-evidence-stop.json", { stopped: false, error: "Node shutdown not confirmed; remote session evidence incomplete" }); }
      }
      for (const agent of exportedReal.agents) {
        let session;
        if (agent.machineId === "local" && daemon?.child.exitCode !== null && daemon?.child.signalCode === null) {
          session = readSessionEvidence(join(home, "agents", `${agent.id}.sqlite`));
        } else if (agent.machineId === machineId && remoteStopped) {
          try {
            session = JSON.parse(await command(["exec", name, "node", "-e", remoteSessionScript, `${remoteRuntimeHome}/agents/${sha256(agent.id)}.sqlite`]));
          } catch { session = { complete: false, error: "Remote session query failed" }; }
        } else session = { complete: false, error: "Related process stop not confirmed" };
        sessions.push({ agentId: agent.id, ...session });
      }
      save("session-evidence.json", sessions);
      const casHashes = Object.fromEntries(exportedReal.artifacts.map((artifact) => {
        try { return [artifact.id, sha256(readFileSync(join(home, "artifacts", artifact.sha256)))]; }
        catch { return [artifact.id, null]; }
      }));
      if (mutation) {
        mutation.casFinalSha256 = casHashes[mutation.artifactId];
        save("fault-injection.json", mutation);
      }
      const evidence = collectRealEvidence(exportedReal, mutation, acceptance, casHashes, sessions);
      save("real-evidence.json", evidence);
      await cleanup("acceptance oracle", async () => {
        assert.deepEqual(evidence.oracleTouches, [], "Acceptance oracle was touched by a local shell command");
        assert.ok(acceptance.checks.every((check) => check.intact), "Frozen acceptance hash or permissions changed");
      });
      if (summary.status === "passed") await cleanup("final acceptance", async () => assertRealSuccess(exportedReal, evidence, acceptanceCommand, machineId));
      Object.assign(summary, { missionStatus: evidence.status, blockers: evidence.blockers, roles: evidence.roles, tools: evidence.tools, evidenceComplete: evidence.evidenceComplete, oracleTouches: evidence.oracleTouches });
    }
    if (acceptance?.immutable.applied) await cleanup("frozen acceptance flags", async () => {
      const flags = childProcess("/bin/chflags", ["nouchg", acceptance.path]);
      await flags.done;
      assert.ok(!flags.error() && flags.child.exitCode === 0, "chflags nouchg failed");
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
    try { finalizeEvidence(proof, secrets, summary, save); }
    catch (error) { failure ??= error; }
    if (summary.cleanupVerified) process.stdout.write("cleanup verified\n");
    process.stdout.write(`summary ${redact(JSON.stringify(summary))}\n`);
    if (failure || options.keep || (config && !options.discard)) process.stdout.write(`proof ${redact(proof)}\n`);
    else rmSync(proof, { recursive: true });
  }
  if (failure) throw new Error(redact(`${failure.message}; proof ${proof}`));
  return { summary, proof };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(parseOptions(process.argv.slice(2))).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
