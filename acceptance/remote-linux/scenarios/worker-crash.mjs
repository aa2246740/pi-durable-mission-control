import assert from "node:assert/strict";

export const crashResolution = "Ignoring the unexpected-stop warning and clearing this blocker so resume can be attempted. Do not allocate a replacement runtime.";

export function linuxSelfCheckSucceeded(history) {
  return history.some((result) => result.name === "bash" && !String(result.args?.command ?? "").includes("LIVE-SOURCE-CHANGED") &&
    result.value?.status === "succeeded" && result.value?.result?.exitCode === 0);
}

// After the first successful self-check the worker must not publish or repeat an effect.
export function workerCrashTool(history) {
  if (!linuxSelfCheckSucceeded(history)) return null;
  return { name: "WaitForMessage", args: {} };
}

function selfCheckCount(detail) {
  return (detail.events ?? []).filter((event) => event.type === "remote_effect_receipt" && event.data?.receipt?.status === "succeeded" &&
    String(event.data?.receipt?.result?.stdout ?? "").includes("LINUX-SELF-CHECK-OK")).length;
}

export function readyToKill(detail) {
  if (!detail || detail.artifacts?.length) return false;
  if ((detail.events ?? []).some((event) => event.type === "artifact_published")) return false;
  if ((detail.events ?? []).some((event) => event.type === "remote_effect_receipt" && String(event.data?.receipt?.result?.stdout ?? "").includes("LIVE-SOURCE-CHANGED"))) return false;
  return selfCheckCount(detail) === 1;
}

export const crashSettlePolls = 5;

// Kill only after the self-check receipt is durable and the worker has returned to WaitForMessage,
// so the node supervisor is not mid-mailbox when its child disappears.
export function workerCrashArmed(detail, records) {
  if (!readyToKill(detail)) return false;
  const tools = (records ?? []).filter((record) => record.role === "worker").map((record) => record.name);
  const bashAt = tools.lastIndexOf("bash");
  return bashAt >= 0 && tools.slice(bashAt + 1).includes("WaitForMessage");
}

function workerToolCount(records, name) {
  return (records ?? []).filter((record) => record.role === "worker" && record.name === name).length;
}

function stopSettled(runtime) {
  return Boolean(runtime && ["closed", "uncertain"].includes(runtime.state) && runtime.stopProvenance && runtime.stopProvenance !== "controlled");
}

export function nextCrashAction(crash, detail, runtimes = [], records = []) {
  if ((detail.events ?? []).some((event) => event.type === "remote_runtime_reassigned")) {
    return { type: "fail", message: "remote_runtime_reassigned appeared; the crashed runtime must not be replaced" };
  }
  if (detail.mission?.status === "completed" || detail.artifacts?.length || (detail.events ?? []).some((event) => event.type === "artifact_published")) {
    return { type: "fail", message: "Mission published or completed after the worker was supposed to stop" };
  }
  if (selfCheckCount(detail) > 1 || workerToolCount(records, "PublishArtifact") > 0 || workerToolCount(records, "write_file") > 1 || workerToolCount(records, "bash") > 1) {
    return { type: "fail", message: "An effect or worker tool was replayed before the crash was contained" };
  }
  if (!crash.killed) {
    if (!workerCrashArmed(detail, records)) return { type: "wait" };
    if ((crash.settlePolls ?? 0) < crashSettlePolls) {
      crash.settlePolls = (crash.settlePolls ?? 0) + 1;
      return { type: "wait" };
    }
    return { type: "kill" };
  }
  if (crash.killed && runtimes.length > 1) return { type: "fail", message: "A second remote runtime appeared" };
  if (!crash.resumeAttempted) {
    const runtime = runtimes.length === 1 ? runtimes[0] : undefined;
    if (crash.nodeExitedAfterKill && !stopSettled(runtime)) {
      return { type: "fail", message: `Node supervisor exited after the worker kill before a terminal runtime report (${runtime ? `${runtime.state}/${runtime.stopProvenance}` : "no runtime"})` };
    }
    if (detail.mission?.status === "failed") return { type: "fail", message: "Mission failed before the operator resolved blockers and resumed" };
    if (runtime?.stopProvenance === "controlled") return { type: "fail", message: "Remote runtime stop provenance is controlled" };
    if (!stopSettled(runtime)) return { type: "wait" };
    const blockerId = `remote-runtime:${runtime.binding.runtimeId}`;
    if (!(detail.blockers ?? []).some((blocker) => blocker.id === blockerId)) {
      if (["blocked", "paused"].includes(detail.mission?.status)) return { type: "fail", message: `No blocker for runtime ${runtime.binding.runtimeId}` };
      return { type: "wait" };
    }
    if (!["blocked", "paused"].includes(detail.mission?.status)) return { type: "wait" };
    const open = (detail.blockers ?? []).filter((blocker) => blocker.status === "open");
    if (open.length) {
      const blocker = open.find((item) => item.id === blockerId) ?? open[0];
      return { type: "resolve", blocker: { id: blocker.id, kind: blocker.kind, text: blocker.text }, resolution: crashResolution };
    }
    return { type: "resume" };
  }
  if (detail.mission?.status === "failed") return { type: "done" };
  return { type: "wait" };
}

export function crashSnapshot(detail, records, transport) {
  return {
    workerTools: (records ?? []).filter((record) => record.role === "worker").map((record) => record.name),
    effectIds: (detail.events ?? []).filter((event) => event.type === "remote_effect_receipt").map((event) => event.data?.effectId),
    deliveryResumed: (detail.events ?? []).filter((event) => event.type === "delivery_resumed").length,
    messageAttempts: (detail.messages ?? []).map((message) => ({ id: message.id, attempt: message.attempt, status: message.status })),
    effects: transport.effects,
    deliveries: transport.deliveries.map((row) => ({ message_id: row.message_id, attempt: row.attempt, status: row.status }))
  };
}

export function assertWorkerCrash(detail, runtimes, evidence, records, transport) {
  assert.equal(runtimes.length, 1, "Expected the original remote runtime and no replacement");
  const runtime = runtimes[0];
  assert.notEqual(runtime.stopProvenance, "controlled", "Unexpected worker death was recorded as a controlled stop");
  assert.ok(["unexpected", "uncertain", "unproven"].includes(runtime.stopProvenance), runtime.stopProvenance);
  assert.equal(detail.mission.status, "failed");
  assert.equal(detail.artifacts.length, 0, "Publication occurred");
  assert.equal(detail.events.some((event) => event.type === "remote_runtime_reassigned"), false);
  assert.equal(detail.events.some((event) => event.type === "artifact_published"), false);
  const blockerId = `remote-runtime:${runtime.binding.runtimeId}`;
  assert.ok(detail.blockers.some((blocker) => blocker.id === blockerId), "No blocker for the crashed runtime");
  const failures = detail.events.filter((event) => event.type === "worker_start_failed");
  assert.equal(failures.length, 1, "Expected one worker_start_failed diagnostic");
  const diagnostic = String(failures[0].data?.diagnostic ?? "");
  assert.match(diagnostic, /unexpected stop|cannot be proven|uncertain runtime report/);
  assert.ok(evidence.humanActions.some((action) => action.action === "resolve"), "Operator did not resolve a blocker");
  assert.ok(evidence.humanActions.some((action) => action.action === "resume"), "Operator did not resume");
  assert.equal(evidence.kill?.ok, true, "Worker process was not confirmed killed");
  assert.equal(evidence.kill.signal, "SIGKILL");
  assert.equal(evidence.kill.supervisorAlive, true, "Node supervisor did not survive the worker kill");
  assert.ok(Number.isInteger(evidence.kill.pid) && evidence.kill.pid > 1);
  assert.ok(evidence.kill.command.some((arg) => arg === "worker.js" || String(arg).endsWith("/worker.js")), "Kill evidence has no worker command");
  assert.match(String(evidence.kill.basis), /worker\.js/);
  assert.ok(evidence.kill.supervisorCommand.some((arg) => String(arg).endsWith("/cli.js")));
  const before = evidence.snapshotBeforeResume;
  assert.ok(before, "Missing pre-resume snapshot");
  const after = crashSnapshot(detail, records, transport);
  assert.deepEqual(after.workerTools, before.workerTools, "Worker tool calls changed after resume");
  assert.deepEqual(after.effectIds, before.effectIds, "Effect receipts changed after resume");
  assert.equal(new Set(after.effectIds).size, after.effectIds.length, "Effect receipt duplicated");
  assert.deepEqual(after.effects, before.effects, "Effect permits changed after resume");
  assert.deepEqual(after.deliveries, before.deliveries, "Durable deliveries changed after resume");
  assert.deepEqual(after.messageAttempts, before.messageAttempts, "Message attempts changed after resume");
  assert.equal(after.deliveryResumed, 0, "A delivery was resumed");
  assert.equal(before.deliveryResumed, 0, "A delivery was resumed before the operator");
  assert.equal(after.workerTools.filter((name) => name === "write_file").length, 1);
  assert.equal(after.workerTools.filter((name) => name === "bash").length, 1);
  assert.equal(after.workerTools.filter((name) => name === "PublishArtifact").length, 0);
  assert.ok(after.messageAttempts.every((message) => message.attempt === 1), "A durable delivery was retried");
  return { stopProvenance: runtime.stopProvenance, runtimeId: runtime.binding.runtimeId, diagnostic, artifacts: 0, effectReceipts: after.effectIds.length };
}

export function selectWorkerProcess(processes, selfPid) {
  const basis = "cmdline ends with /worker.js, ppid is the single cli.js node supervisor, and the supervisor, bootstrap, and this exec are excluded";
  const brief = (entry) => ({ pid: entry.pid, ppid: entry.ppid, command: entry.command, state: entry.state });
  const isSupervisor = (entry) => entry.pid !== selfPid && entry.command.some((arg) => String(arg).endsWith("/cli.js")) && entry.command.includes("node");
  const isWorker = (entry) => entry.pid !== selfPid && entry.command.some((arg) => arg === "worker.js" || String(arg).endsWith("/worker.js"));
  const supervisors = processes.filter(isSupervisor);
  const workers = processes.filter(isWorker);
  if (supervisors.length !== 1) {
    return { ok: false, basis, reason: `expected one node supervisor, found ${supervisors.length}`, supervisors: supervisors.map(brief), workers: workers.map(brief) };
  }
  const supervisor = supervisors[0];
  const owned = workers.filter((entry) => entry.ppid === supervisor.pid && entry.pid !== supervisor.pid);
  if (owned.length !== 1) {
    return { ok: false, basis, reason: `expected one worker child of supervisor ${supervisor.pid}, found ${owned.length}`, supervisor: brief(supervisor), workers: workers.map(brief) };
  }
  const target = owned[0];
  if (target.pid === 1 || target.command.some((arg) => String(arg).endsWith("/cli.js") || String(arg).endsWith("/bootstrap.mjs"))) {
    return { ok: false, basis, reason: "refusing to signal the node supervisor or bootstrap", target: brief(target), supervisor: brief(supervisor) };
  }
  return { ok: true, basis, pid: target.pid, command: target.command, supervisorPid: supervisor.pid, supervisorCommand: supervisor.command };
}

export function assessKill(decision, targetState, supervisorState) {
  const gone = targetState === "gone" || targetState === "Z";
  const supervisorAlive = typeof supervisorState === "string" && supervisorState !== "gone" && supervisorState !== "Z" && supervisorState !== "unknown";
  return { ...decision, signal: "SIGKILL", targetState, supervisorState, gone, supervisorAlive, ok: Boolean(decision.ok && gone && supervisorAlive) };
}

export function workerKillSource() {
  return [
    'const fs = require("node:fs");',
    `const selectWorkerProcess = ${selectWorkerProcess.toString()};`,
    `const assessKill = ${assessKill.toString()};`,
    'function readText(path) { try { return fs.readFileSync(path, "utf8"); } catch { return null; } }',
    "function listProcesses() {",
    "  const processes = [];",
    '  for (const name of fs.readdirSync("/proc")) {',
    "    if (!/^[0-9]+$/.test(name)) continue;",
    "    const pid = Number(name);",
    '    const cmdline = readText("/proc/" + pid + "/cmdline");',
    "    if (!cmdline) continue;",
    '    const command = cmdline.split("\\0").filter(Boolean);',
    "    if (!command.length) continue;",
    '    const status = readText("/proc/" + pid + "/status");',
    "    if (!status) continue;",
    "    let ppid = null, state = null;",
    '    for (const line of status.split("\\n")) {',
    '      if (line.startsWith("PPid:")) ppid = Number(line.split(/\\s+/)[1]);',
    '      if (line.startsWith("State:")) state = line.split(/\\s+/)[1];',
    "    }",
    "    processes.push({ pid, ppid, command, state });",
    "  }",
    "  return processes;",
    "}",
    "function readState(pid) {",
    '  const status = readText("/proc/" + pid + "/status");',
    '  if (!status) return "gone";',
    '  const line = status.split("\\n").find((item) => item.startsWith("State:"));',
    '  return line ? line.split(/\\s+/)[1] : "unknown";',
    "}",
    "let result;",
    "try {",
    "  const processes = listProcesses();",
    "  let decision = selectWorkerProcess(processes, process.pid);",
    "  if (decision.ok && (decision.pid === 1 || decision.pid === process.pid || decision.pid === decision.supervisorPid)) {",
    '    decision = { ...decision, ok: false, reason: "refusing protected pid" };',
    "  }",
    "  if (decision.ok) {",
    "    const current = processes.find((entry) => entry.pid === decision.pid);",
    "    const supervisor = processes.find((entry) => entry.pid === decision.supervisorPid);",
    '    if (!current || !supervisor || current.command.join("\\0") !== decision.command.join("\\0")) {',
    '      decision = { ...decision, ok: false, reason: "worker command changed before kill" };',
    "    }",
    "  }",
    "  if (!decision.ok) result = decision;",
    "  else {",
    '    process.kill(decision.pid, "SIGKILL");',
    "    let targetState = readState(decision.pid);",
    "    const deadline = Date.now() + 1000;",
    '    while (targetState !== "gone" && targetState !== "Z" && Date.now() < deadline) targetState = readState(decision.pid);',
    "    result = assessKill(decision, targetState, readState(decision.supervisorPid));",
    "  }",
    "} catch (error) {",
    '  result = { ok: false, reason: "kill script failed", message: String(error && error.message || error) };',
    "}",
    'process.stdout.write(JSON.stringify(result) + "\\n");'
  ].join("\n");
}

export function parseKillOutput(stdout) {
  const line = String(stdout).trim().split("\n").filter(Boolean).at(-1);
  assert.ok(line, "Worker kill produced no evidence");
  return JSON.parse(line);
}

export async function observeWorkerCrash({ crash, current, missionId, containerName, records, api, post, exec, transport, save }) {
  const runtimes = crash.killed ? await api(`/api/missions/${missionId}/runtimes`) : [];
  if (runtimes.length === 1 && !crash.stoppedRuntime && ["closed", "uncertain"].includes(runtimes[0].state)) {
    crash.stoppedRuntime = runtimes[0];
    crash.blockersAtStop = current.blockers;
    save();
  }
  const action = nextCrashAction(crash, current, runtimes, records);
  if (action.type === "fail") {
    crash.failure = action.message;
    try { crash.transport = transport(); } catch { /* sqlite may be unavailable; the mission snapshot remains */ }
    save();
    throw new Error(action.message);
  }
  if (action.type === "wait" || action.type === "done") return action.type === "done" ? current : null;
  if (action.type === "kill") {
    let stdout;
    try {
      stdout = await exec(["exec", containerName, "node", "-e", workerKillSource()]);
    } catch (error) {
      crash.kill = { ok: false, containerName, error: error instanceof Error ? error.message : String(error) };
      save();
      throw error;
    }
    const evidence = parseKillOutput(stdout);
    evidence.containerName = containerName;
    crash.kill = evidence;
    save();
    if (!evidence.ok) throw new Error(`Could not kill the assigned worker: ${evidence.reason ?? "kill was not confirmed"}`);
    crash.killed = true;
    crash.transportAtKill = transport();
    save();
    return null;
  }
  if (action.type === "resolve") {
    const entry = {
      action: "resolve", path: `/api/blockers/${action.blocker.id}/resolve`, blockerId: action.blocker.id,
      kind: action.blocker.kind, text: action.blocker.text, resolution: action.resolution, attemptedAt: new Date().toISOString()
    };
    crash.humanActions.push(entry);
    save();
    const result = await post(entry.path, { resolution: action.resolution }, 15000);
    entry.status = result.status;
    entry.response = result.body;
    save();
    if (result.status !== 200) throw new Error(`Blocker resolve failed: ${result.status} ${JSON.stringify(result.body)}`);
    return null;
  }
  if (action.type === "resume") {
    crash.snapshotBeforeResume = crashSnapshot(current, records, transport());
    const entry = { action: "resume", path: `/api/missions/${missionId}/resume`, attemptedAt: new Date().toISOString() };
    crash.humanActions.push(entry);
    crash.resumeAttempts = (crash.resumeAttempts ?? 0) + 1;
    save();
    let result;
    try {
      result = await post(entry.path, {}, 45000);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
      save();
      if (crash.resumeAttempts >= 3) throw error;
      return null;
    }
    entry.status = result.status;
    entry.response = result.body;
    save();
    const refusal = String(result.body?.error ?? "");
    const failClosed = /unexpected stop|cannot be proven|uncertain runtime report/.test(refusal);
    // assignRemoteRuntime refuses inside resume and failMissionStartup has already
    // marked the mission failed, so this 409 is the fail-closed result, not a retry.
    if (result.status === 409 && !failClosed) {
      if (crash.resumeAttempts >= 5) throw new Error(`Resume still rejected: ${JSON.stringify(result.body)}`);
      return null;
    }
    crash.resumeAttempted = true;
    if (result.status >= 400 && result.status !== 500 && !failClosed) throw new Error(`Resume failed: ${result.status} ${JSON.stringify(result.body)}`);
    return null;
  }
  throw new Error(`Unknown worker-crash action ${action.type}`);
}
