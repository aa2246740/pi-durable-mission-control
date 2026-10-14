import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Agent } from "./contracts.js";
import { ControlPlane, HttpError, RemoteRuntimeRecoveryError, RemoteRuntimeStopPendingError } from "./control.js";
import { remoteWorkspacePromptFlags } from "./prompts.js";
import type { RpcMessage } from "./worker.js";
import { applyWorkerNotice, parseWorkerNotice } from "./worker-events.js";
type Handle = { child: ChildProcess; token: string; epoch: number; ready: Promise<void>; close?: Promise<void>; stopping: boolean };
type QuiescenceRequest =
  | { kind: "question"; agentId: string }
  | { kind: "sync" | "manual" | "stop" };
type QuiescenceFlight = {
  mode: "pause" | "stop";
  promise: Promise<void>;
  finished: boolean;
  fencedAgents: Set<string>;
  settlement: { kind: "question"; agentId: string; controller: AbortController } | { kind: "immediate" };
};

export function sanitizeDiagnostic(value: unknown, secret?: string): string {
  let text = value instanceof Error ? value.message : String(value);
  if (secret) text = text.split(secret).join("[REDACTED]");
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(-1000);
}

export function redactDiagnosticChunk(
  pending: string,
  chunk: string,
  secret?: string,
  flush = false
): { complete: string; pending: string } {
  const combined = pending + chunk;
  if (!secret) return { complete: combined, pending: "" };
  if (flush) return { complete: combined.split(secret).join("[REDACTED]"), pending: "" };
  let complete = "";
  let cursor = 0;
  for (let match = combined.indexOf(secret, cursor); match !== -1; match = combined.indexOf(secret, cursor)) {
    complete += combined.slice(cursor, match) + "[REDACTED]";
    cursor = match + secret.length;
  }
  const remainder = combined.slice(cursor);
  let safeEnd = remainder.length;
  const firstPossiblePartial = Math.max(0, remainder.length - secret.length + 1);
  for (let start = firstPossiblePartial; start < remainder.length; start++) {
    if (secret.startsWith(remainder.slice(start))) {
      safeEnd = start;
      break;
    }
  }
  return {
    complete: complete + remainder.slice(0, safeEnd),
    pending: remainder.slice(safeEnd)
  };
}

function safeEnvironment(credentialEnv: string, secret: string | undefined, config: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG"]) if (process.env[key]) environment[key] = process.env[key];
  if (credentialEnv && secret) environment[credentialEnv] = secret;
  environment.MC_WORKER_CONFIG = config;
  return environment;
}

function sendToWorker(child: ChildProcess, message: object): Promise<void> {
  if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
    return Promise.reject(new Error("Worker IPC channel is disconnected"));
  }
  return new Promise<void>((resolve, reject) => {
    try {
      child.send(message, (error) => error ? reject(error) : resolve());
    } catch (error) {
      reject(error);
    }
  });
}

function isChildLive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export class WorkerManager {
  private readonly handles = new Map<string, Handle>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly recoveryFlights = new Map<string, Promise<void>>();
  private readonly quiescenceFlights = new Map<string, QuiescenceFlight>();
  private readonly recoveringAgents = new Set<string>();
  private readonly dispatching = new Set<string>();
  private readonly remoteStopWaits = new Map<string, { runtimeId: string; epoch: number; timer: NodeJS.Timeout }>();
  private closing = false;
  constructor(
    private readonly control: ControlPlane,
    private readonly testOnlyScripted = false,
    private readonly testOnlyToolLoop = false,
    private readonly remoteRuntimeStopTimeoutMs = 60000
  ) {
    if (!Number.isSafeInteger(remoteRuntimeStopTimeoutMs) || remoteRuntimeStopTimeoutMs < 1 || remoteRuntimeStopTimeoutMs > 2147483647) {
      throw new HttpError(400, "Remote runtime stop timeout must be an integer between 1 and 2147483647 milliseconds");
    }
  }

  async startMission(missionId: string): Promise<void> {
    for (const agent of this.control.listAgents(missionId)) await this.startAgent(agent);
    await this.dispatchPending();
  }

  async recoverActiveMissions(): Promise<void> {
    const missions = this.control.state().missions.filter((mission) => mission.status === "active");
    for (const mission of missions) {
      for (const agent of this.control.listAgents(mission.id)) {
        const runtime = agent.machineId !== "local" ? this.control.remoteRuntimeForAgent(agent.id) : undefined;
        if (runtime && !(runtime.state === "stopping" && runtime.stop_request_reason === "controlled")) continue;
        try {
          await this.startAgent(agent);
        } catch (error) {
          this.control.setAgentStatus(agent.id, agent.epoch, "error", error instanceof Error ? error.message : "Worker recovery failed");
        }
      }
    }
    await this.dispatchPending();
  }

  async startAgent(agent: Agent): Promise<void> {
    if (this.closing || this.quiescenceFlights.has(agent.missionId) || this.control.missionById(agent.missionId)?.status !== "active") return;
    const pending = this.starting.get(agent.id);
    if (pending) return pending;
    const starting = this.startAgentOnce(agent).then(() => this.clearRemoteStopWait(agent.id)).catch(async (error: unknown) => {
      // Closing an owned child before readiness is an intentional cancellation.
      if (this.closing) {
        this.clearRemoteStopWait(agent.id);
        return;
      }
      if (error instanceof RemoteRuntimeStopPendingError) {
        this.waitForRemoteStop(agent, error.runtimeId);
        return;
      }
      this.clearRemoteStopWait(agent.id);
      const profile = this.control.profile(agent.profileId);
      const secret = profile?.credentialEnv ? process.env[profile.credentialEnv] : undefined;
      this.control.failMissionStartup(agent.missionId, sanitizeDiagnostic(error, secret),
        error instanceof RemoteRuntimeRecoveryError ? { recoverable: false, reason: error.reason } : undefined);
      await this.stopMission(agent.missionId);
      throw error;
    }).finally(() => this.starting.delete(agent.id));
    this.starting.set(agent.id, starting);
    return starting;
  }

  private clearRemoteStopWait(agentId: string): void {
    const waiting = this.remoteStopWaits.get(agentId);
    if (waiting) clearTimeout(waiting.timer);
    this.remoteStopWaits.delete(agentId);
  }

  private waitForRemoteStop(agent: Agent, runtimeId: string): void {
    const existing = this.remoteStopWaits.get(agent.id);
    if (existing?.runtimeId === runtimeId && existing.epoch === agent.epoch) return;
    this.clearRemoteStopWait(agent.id);
    this.control.recordRemoteRuntimeStopPending(agent, runtimeId, this.remoteRuntimeStopTimeoutMs);
    const timer = setTimeout(() => {
      this.runDetached(agent, this.retryRemoteStop(agent.id, runtimeId, true));
    }, this.remoteRuntimeStopTimeoutMs);
    timer.unref();
    this.remoteStopWaits.set(agent.id, { runtimeId, epoch: agent.epoch, timer });
  }

  async remoteRuntimeReported(agentId: string, runtimeId: string): Promise<void> {
    await this.retryRemoteStop(agentId, runtimeId, false);
  }

  private async retryRemoteStop(agentId: string, runtimeId: string, timedOut: boolean): Promise<void> {
    await this.starting.get(agentId);
    const waiting = this.remoteStopWaits.get(agentId);
    if (!waiting || waiting.runtimeId !== runtimeId) return;
    const agent = this.control.getAgentPublic(agentId);
    const runtime = this.control.remoteRuntimeForAgent(agentId);
    const mission = agent ? this.control.missionById(agent.missionId) : undefined;
    if (this.closing || !agent || agent.epoch !== waiting.epoch || !runtime || runtime.runtime_id !== runtimeId ||
        !mission || !["active", "blocked"].includes(mission.status)) {
      this.clearRemoteStopWait(agentId);
      return;
    }
    try {
      this.control.assertRemoteRuntimeReassignable(runtime, agent);
    } catch (error) {
      if (error instanceof RemoteRuntimeStopPendingError && !timedOut) return;
      this.clearRemoteStopWait(agentId);
      const diagnostic = error instanceof RemoteRuntimeStopPendingError
        ? `Prior remote runtime ${runtimeId} did not confirm its stop within ${this.remoteRuntimeStopTimeoutMs / 1000} seconds`
        : sanitizeDiagnostic(error);
      this.control.failMissionStartup(agent.missionId, diagnostic,
        error instanceof RemoteRuntimeRecoveryError ? { recoverable: false, reason: error.reason }
          : error instanceof RemoteRuntimeStopPendingError ? { recoverable: true, reason: "remote_runtime_stop_timeout" } : undefined);
      await this.stopMission(agent.missionId);
      return;
    }
    this.clearRemoteStopWait(agentId);
    if (mission.status === "active") {
      // startAgent repeats the full assignment checks against the current session.
      await this.startAgent(agent).catch(() => undefined);
      await this.dispatchPending();
    }
  }

  async refreshProfile(profileId: string): Promise<void> {
    for (const agent of this.control.listAgents().filter((item) => item.profileId === profileId)) {
      if (agent.machineId !== "local") {
        if (this.control.requestRemoteRuntimeStop(agent.id)) this.control.markAgentInterrupted(agent.id, agent.epoch, { controlledRemoteStop: true });
        continue;
      }
      if (!["idle", "offline"].includes(agent.status)) continue;
      if (!this.handles.has(agent.id)) continue;
      await this.stopAgent(agent.id);
      const current = this.control.getAgentPublic(agent.id);
      if (current && this.control.missionById(current.missionId)?.status === "active") await this.startAgent(current);
    }
  }

  async refreshRole(roleId: string): Promise<void> {
    for (const agent of this.control.listAgents().filter((item) => item.roleId === roleId)) {
      if (agent.machineId !== "local") {
        if (this.control.requestRemoteRuntimeStop(agent.id)) this.control.markAgentInterrupted(agent.id, agent.epoch, { controlledRemoteStop: true });
        continue;
      }
      if (!["idle", "offline"].includes(agent.status)) continue;
      if (!this.handles.has(agent.id)) continue;
      await this.stopAgent(agent.id);
      const current = this.control.getAgentPublic(agent.id);
      if (current && this.control.missionById(current.missionId)?.status === "active") await this.startAgent(current);
    }
  }

  private async startAgentOnce(agent: Agent): Promise<void> {
    if (agent.machineId !== "local") {
      this.control.assignRemoteRuntime(agent.id);
      return;
    }
    let existing = this.handles.get(agent.id);
    if (existing?.stopping) {
      await this.stopAgent(agent.id);
      if (this.closing || this.quiescenceFlights.has(agent.missionId) || this.control.missionById(agent.missionId)?.status !== "active") return;
      existing = this.handles.get(agent.id);
    }
    if (existing?.child.connected && existing.child.exitCode === null) {
      await existing.ready;
      return;
    }
    if (existing) this.handles.delete(agent.id);
    const mission = this.control.missionById(agent.missionId);
    if (mission?.workspaceStrategy === "worktree") {
      const expected = join(resolve(this.control.home), "worktrees", mission.id, agent.id);
      if (resolve(agent.workspacePath) !== expected) throw new HttpError(409, "Agent worktree path does not match its predetermined location");
    }
    agent = this.control.prepareAgentWorkspace(agent.id);
    try {
      if (realpathSync(agent.workspacePath) !== agent.workspacePath || !statSync(agent.workspacePath).isDirectory()) {
        throw new Error("Workspace path is no longer the recorded directory");
      }
    } catch {
      throw new HttpError(409, "Agent workspace is unavailable or changed");
    }
    const owner = this.control.claimAgentOwner(agent.id);
    const role = this.control.role(owner.roleId);
    const profile = this.control.profile(owner.profileId);
    if (!role || !profile) throw new HttpError(409, "Agent role or profile is missing");
    if (profile.credentialEnv && !process.env[profile.credentialEnv]) throw new HttpError(409, `Missing required credential ${profile.credentialEnv}`);
    if (!profile.toolCalling) throw new HttpError(409, "Agent model profile does not support tool calling");
    const token = randomBytes(32).toString("hex");
    const promptMission = this.control.missionById(owner.missionId);
    const config = {
      agentId: owner.id,
      missionId: owner.missionId,
      epoch: owner.epoch,
      token,
      durablePath: join(this.control.home, "agents", `${agent.id}.sqlite`),
      workspacePath: owner.workspacePath,
      workspaceStrategy: promptMission?.workspaceStrategy ?? "shared",
      ...remoteWorkspacePromptFlags(role.kind, promptMission?.remoteWorkspaceIds),
      profile,
      role,
      ...(this.testOnlyScripted ? { testOnlyScripted: true } : {}),
      ...(this.testOnlyScripted && this.testOnlyToolLoop ? { testOnlyToolLoop: true } : {})
    };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64");
    const workerPath = new URL("./worker.js", import.meta.url);
    const child = fork(workerPath, [], {
      cwd: agent.workspacePath,
      env: safeEnvironment(profile.credentialEnv, profile.credentialEnv ? process.env[profile.credentialEnv] : undefined, encoded),
      detached: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    const secret = profile.credentialEnv ? process.env[profile.credentialEnv] : undefined;
    let stderrPending = "";
      child.stderr?.on("data", (chunk: Buffer) => {
      const redacted = redactDiagnosticChunk(stderrPending, chunk.toString("utf8"), secret);
      stderrPending = redacted.pending;
      if (redacted.complete) this.control.recordWorkerDiagnostic(owner.id, owner.epoch, sanitizeDiagnostic(redacted.complete));
    });
      const handle: Handle = {
        child,
        token,
        epoch: owner.epoch,
        ready: Promise.resolve(),
        stopping: false
      };
    handle.ready = new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => reject(new Error("Worker startup timed out")), 30000);
      child.on("message", (raw: unknown) => {
        try {
        if (raw && typeof raw === "object" && !Array.isArray(raw) && "type" in raw && raw.type === "rpc") {
          void this.onRpc(owner, handle, raw as RpcMessage).catch((error: unknown) => {
            this.recordDetachedFailure(owner, error);
          });
        } else {
          const notice = parseWorkerNotice(raw);
          if (!notice) return;
          const result = applyWorkerNotice(this.control, owner, notice, (value) => sanitizeDiagnostic(value, secret));
          if (result.ready) {
            ready = true;
            clearTimeout(timer);
            resolve();
          }
          if (result.lifecycleSync) this.runDetached(owner, this.syncMissionLifecycle(owner.missionId));
        }
        } catch (error) {
          this.recordDetachedFailure(owner, error);
        }
      });
      const onChildError = (error: Error): void => {
        clearTimeout(timer);
        if (!ready) reject(error);
        else this.recordDetachedFailure(owner, error);
      };
      child.on("error", onChildError);
      child.once("exit", (code) => {
        clearTimeout(timer);
        child.off("error", onChildError);
        try {
          const final = redactDiagnosticChunk(stderrPending, "", secret, true).complete;
          if (final) this.control.recordWorkerDiagnostic(owner.id, owner.epoch, sanitizeDiagnostic(final, secret));
          if (!ready) reject(new Error(`Worker exited before readiness (${code ?? "signal"})`));
          if (code && code !== 0) this.control.setAgentStatus(owner.id, owner.epoch, "error", `Worker exited with ${code}`);
          else this.control.setAgentStatus(owner.id, owner.epoch, "offline");
          if (this.handles.get(owner.id) === handle) this.handles.delete(owner.id);
          const mission = this.control.missionById(owner.missionId);
          if (ready && !handle.stopping && !this.closing && mission?.status === "active" && this.control.getAgentPublic(owner.id)?.epoch === owner.epoch) {
            this.runDetached(owner, this.recoverUnexpectedExit(owner.id, owner.epoch, `Worker exited with ${code ?? "signal"}`));
          }
        } catch (error) {
          this.recordDetachedFailure(owner, error);
        }
      });
    });
    this.handles.set(owner.id, handle);
    await handle.ready;
  }

  private async recoverUnexpectedExit(agentId: string, epoch: number, diagnostic: string): Promise<void> {
    const existing = this.recoveryFlights.get(agentId);
    if (existing) return existing;
    this.recoveringAgents.add(agentId);
    const flight = (async () => {
      await this.control.stopAgentProcesses(agentId);
      await this.control.settlePendingOperations();
      if (this.closing) return;
      const agent = this.control.getAgentPublic(agentId);
      const mission = agent ? this.control.missionById(agent.missionId) : undefined;
      if (!agent || !mission || agent.epoch !== epoch || mission.status !== "active") return;
      if (this.control.blockers(mission.id).some((blocker) => blocker.status === "open")) return;
      const recovered = this.control.recoverUnexpectedWorker(agentId, epoch, diagnostic);
      if (!recovered || this.closing) return;
      try {
        await this.startAgent(recovered);
        this.recoveringAgents.delete(agentId);
        await this.dispatchPending();
      } catch {
        // startAgent records startup failures as failed missions.
      }
    })().finally(() => {
      this.recoveringAgents.delete(agentId);
      this.recoveryFlights.delete(agentId);
    });
    this.recoveryFlights.set(agentId, flight);
    return flight;
  }

  private async onRpc(agent: Agent, handle: Handle, request: RpcMessage): Promise<void> {
    if (request.token !== handle.token || request.agentId !== agent.id || request.epoch !== handle.epoch) {
      await this.sendReply(agent, handle, { id: request.id, error: "Worker authentication failed" });
      return;
    }
    try {
      if (this.closing && !["Transcript", "Report", "Usage"].includes(request.method)) throw new HttpError(503, "Coordinator is shutting down");
      const result = await this.control.workerCommand(request);
      // Reserve the pause before sending the reply so concurrent turn-end
      // lifecycle syncs join the same bounded settlement wait.
      const userInputPause = request.method === "RequestUserInput" && agent.machineId === "local" &&
        this.control.missionById(agent.missionId)?.status === "blocked"
        ? this.quiesceMission(agent.missionId, { kind: "question", agentId: agent.id }) : undefined;
      await this.sendReply(agent, handle, { id: request.id, result });
      if (request.method === "InterruptAgent" && result && typeof result === "object" && "agentId" in result && typeof result.agentId === "string") {
        await this.interruptAgent(result.agentId);
      }
      await (userInputPause ?? this.syncMissionLifecycle(agent.missionId))
        .catch((error: unknown) => this.recordDetachedFailure(agent, error));
      await this.dispatchPending();
    } catch (error) {
      const profile = this.control.profile(agent.profileId);
      const secret = profile?.credentialEnv ? process.env[profile.credentialEnv] : undefined;
      await this.sendReply(agent, handle, { id: request.id, error: sanitizeDiagnostic(error, secret) });
      await this.syncMissionLifecycle(agent.missionId).catch((syncError: unknown) => this.recordDetachedFailure(agent, syncError));
    }
  }

  async dispatchPending(): Promise<void> {
    if (this.closing) return;
    for (const row of this.control.pendingOutbox()) {
      const message = this.control.message(row.message_id);
      if (this.closing || this.quiescenceFlights.has(row.mission_id) || this.control.missionById(row.mission_id)?.status !== "active") continue;
      const agent = message ? this.control.getAgentPublic(message.recipientId) : undefined;
      if (!message || !agent || this.dispatching.has(row.id) || this.recoveringAgents.has(agent.id)) continue;
      this.dispatching.add(row.id);
      try {
        if (agent.machineId !== "local") {
          const runtime = this.control.remoteRuntimeForAgent(agent.id);
          if (!runtime || runtime.state !== "running") {
            await this.startAgent(agent);
            continue;
          }
          if (!this.control.dispatchRemoteOutbox(row, message, agent)) {
            this.control.blockRemoteDispatch(row.id, agent.id);
          }
          continue;
        }
        let handle = this.handles.get(agent.id);
        if (!handle) {
          await this.startAgent(agent);
          handle = this.handles.get(agent.id);
        }
        if (!handle || handle.stopping || this.closing || this.quiescenceFlights.has(row.mission_id) ||
            this.control.missionById(row.mission_id)?.status !== "active") continue;
        const currentAgent = this.control.getAgentPublic(agent.id);
        if (!currentAgent || currentAgent.epoch !== handle.epoch || !this.control.markOutboxDispatching(row.id, handle.epoch)) continue;
        await sendToWorker(handle.child, { type: "deliver", messageId: message.id, requestId: row.request_id, attempt: row.attempt, epoch: handle.epoch, content: message.content, mode: message.mode });
      } catch (error) {
        if (agent.machineId === "local") this.control.retryOutbox(row.id, error instanceof Error ? error.message : String(error));
        else this.control.blockRemoteDispatch(row.id, agent.id);
        await this.syncMissionLifecycle(row.mission_id);
      } finally {
        this.dispatching.delete(row.id);
      }
    }
  }

  async syncMissionLifecycle(missionId: string): Promise<void> {
    const status = this.control.missionById(missionId)?.status;
    if (status === "blocked") await this.quiesceMission(missionId, { kind: "sync" });
    else if (status === "completed" || status === "cancelled") await this.stopMission(missionId);
  }

  async pauseMission(missionId: string): Promise<void> {
    return this.quiesceMission(missionId, { kind: "manual" });
  }

  private quiesceMission(missionId: string, request: QuiescenceRequest): Promise<void> {
    const existing = this.quiescenceFlights.get(missionId);
    if (existing && !existing.finished) {
      if (request.kind === "stop") existing.mode = "stop";
      if ((request.kind === "manual" || this.closing) && existing.settlement.kind === "question") existing.settlement.controller.abort();
      return existing.promise;
    }
    const flight: QuiescenceFlight = {
      mode: request.kind === "stop" ? "stop" : "pause", promise: Promise.resolve(), finished: false, fencedAgents: new Set(),
      settlement: request.kind === "question"
        ? { kind: "question", agentId: request.agentId, controller: new AbortController() } : { kind: "immediate" }
    };
    this.quiescenceFlights.set(missionId, flight);
    flight.promise = this.performMissionQuiescence(missionId, flight).finally(() => {
      flight.finished = true;
      if (this.quiescenceFlights.get(missionId) === flight) this.quiescenceFlights.delete(missionId);
    }).then(async () => {
      if (!this.closing && this.control.missionById(missionId)?.status === "active") await this.dispatchPending();
    });
    return flight.promise;
  }

  private async performMissionQuiescence(missionId: string, flight: QuiescenceFlight): Promise<void> {
    const settlingAgentId = flight.settlement.kind === "question" ? flight.settlement.agentId : undefined;
    const agents = this.control.listAgents(missionId);
    for (const agent of agents) this.clearRemoteStopWait(agent.id);
    const captured = new Map<string, Handle>();
    for (const agent of agents) {
      if (agent.machineId !== "local") {
        this.control.requestRemoteRuntimeStop(agent.id);
        if (!flight.fencedAgents.has(agent.id)) {
          flight.fencedAgents.add(agent.id);
          this.control.markAgentInterrupted(agent.id, agent.epoch, { controlledRemoteStop: true });
        }
        continue;
      }
      const handle = this.handles.get(agent.id);
      if (handle) {
        handle.stopping = true;
        captured.set(agent.id, handle);
      }
    }
    const settlingHandle = settlingAgentId ? captured.get(settlingAgentId) : undefined;
    const pauseSettlement = settlingHandle && settlingAgentId
      ? this.waitForLocalSettlement(missionId, settlingAgentId, settlingHandle,
        flight.settlement.kind === "question" ? flight.settlement.controller.signal : undefined) : undefined;
    const status = this.control.missionById(missionId)?.status;
    // Observe settlement before stopping external operations, which can itself
    // settle a delivery. Only the Harness gets a grace period, not workspace writes.
    const terminalSettlement = flight.mode === "stop" && (status === "completed" || status === "cancelled")
      ? Promise.all([...captured].map(async ([agentId, handle]) => {
        const outcome = await this.waitForLocalSettlement(missionId, agentId, handle);
        if (outcome !== "settled") this.control.recordWorkerDiagnostic(agentId, handle.epoch,
          outcome === "timeout" ? "Local delivery did not settle within 5000 ms before terminal mission shutdown"
            : "Local worker exited before terminal mission delivery settlement");
      })) : undefined;
    try {
      await this.control.stopMissionProcesses(missionId);
    } catch (error) {
      for (const agent of agents) this.recordDetachedFailure(agent, error);
    }
    if (terminalSettlement) await terminalSettlement;
    for (const [agentId, handle] of this.handles) {
      const agent = this.control.getAgentPublic(agentId);
      if (!captured.has(agentId) && agent?.missionId === missionId) {
        handle.stopping = true;
        captured.set(agentId, handle);
      }
    }
    const failures: unknown[] = [];
    const stopAndFence = async (agent: Agent, handle: Handle): Promise<void> => {
      try {
        await this.stopAgent(agent.id);
      } catch (error) {
        // An unconfirmed process retains its handle and blocker; peers still need to stop.
        failures.push(error);
      }
      if (!flight.fencedAgents.has(agent.id)) {
        flight.fencedAgents.add(agent.id);
        const currentStatus = this.control.missionById(missionId)?.status;
        // The handle owns this stop, even if an earlier attempt already fenced its epoch.
        this.control.markAgentInterrupted(agent.id, handle.epoch, {
          ...(flight.settlement.kind === "question" && flight.mode === "pause" &&
            currentStatus === "active" ? { preserveQueued: true } : {})
        });
      }
    };
    // Pause peers immediately while the asking agent finishes its submission.
    const stoppingAgents = settlingAgentId
      ? [...agents.filter((agent) => agent.id !== settlingAgentId), ...agents.filter((agent) => agent.id === settlingAgentId)]
      : agents;
    for (const agent of stoppingAgents) {
      const handle = captured.get(agent.id);
      if (!handle) {
        if (agent.machineId === "local" && (status === "completed" || status === "cancelled") && !flight.fencedAgents.has(agent.id) &&
            this.control.db.prepare(`SELECT 1 FROM messages WHERE mission_id=? AND json_extract(data,'$.recipientId')=?
              AND status IN ('queued','dispatching','admitted','delivering','delivered') LIMIT 1`).get(missionId, agent.id)) {
          flight.fencedAgents.add(agent.id);
          this.control.markAgentInterrupted(agent.id, agent.epoch);
        }
        continue;
      }
      if (agent.id === settlingAgentId && pauseSettlement) {
        const outcome = await pauseSettlement;
        if (outcome === "timeout" || outcome === "exited") this.control.recordWorkerDiagnostic(agent.id, handle.epoch,
          outcome === "timeout" ? "Local delivery did not settle within 5000 ms before user-input pause"
            : "Local worker exited before user-input delivery settlement");
      }
      if (flight.mode === "pause" && isChildLive(handle.child)) {
        const acknowledged = await this.waitForAck(agent.id, handle, "aborted", () => sendToWorker(handle.child, { type: "abort" }));
        if (acknowledged && isChildLive(handle.child)) this.control.setAgentStatus(agent.id, handle.epoch, "idle");
        else if (isChildLive(handle.child)) {
          this.control.setAgentStatus(agent.id, handle.epoch, "error", "Worker did not acknowledge queue cancellation");
        }
      }
      await stopAndFence(agent, handle);
    }
    for (const [agentId, handle] of [...this.handles]) {
      const agent = this.control.getAgentPublic(agentId);
      if (agent?.missionId !== missionId || captured.has(agentId)) continue;
      handle.stopping = true;
      await stopAndFence(agent, handle);
    }
    if (failures.length) throw new AggregateError(failures, "Mission quiescence did not stop all workers");
  }

  private async waitForLocalSettlement(missionId: string, agentId: string, handle: Handle, signal?: AbortSignal): Promise<"settled" | "exited" | "timeout" | "interrupted"> {
    const pending = (): boolean => Boolean(this.control.db.prepare(`SELECT 1 FROM outbox o
      JOIN messages m ON m.id=o.message_id
      WHERE m.mission_id=? AND json_extract(m.data,'$.recipientId')=? AND o.epoch=?
        AND o.status IN ('dispatching','admitted') LIMIT 1`)
      .get(missionId, agentId, handle.epoch));
    if (!pending()) return "settled";
    return new Promise<"settled" | "exited" | "timeout" | "interrupted">((resolveSettlement) => {
      let finished = false;
      const finish = (outcome: "settled" | "exited" | "timeout" | "interrupted"): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        handle.child.off("message", onMessage);
        handle.child.off("exit", onExit);
        signal?.removeEventListener("abort", onAbort);
        resolveSettlement(outcome);
      };
      const onMessage = (raw: unknown): void => {
        const notice = parseWorkerNotice(raw);
        if (!notice || notice.agentId !== agentId || notice.epoch !== handle.epoch ||
            (notice.type !== "settled" && notice.type !== "delivery_error")) return;
        if (!pending()) finish("settled");
      };
      const onExit = (): void => finish("exited");
      const onAbort = (): void => finish("interrupted");
      const timer = setTimeout(() => finish("timeout"), 5000);
      handle.child.on("message", onMessage);
      handle.child.once("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) finish("interrupted");
      else if (!isChildLive(handle.child)) finish("exited");
    });
  }

  async interruptAgent(agentId: string): Promise<void> {
    const agent = this.control.getAgentPublic(agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    if (agent.machineId !== "local") {
      this.control.requestRemoteRuntimeStop(agentId);
      this.control.markAgentInterrupted(agentId, agent.epoch, { controlledRemoteStop: true });
      return;
    }
    const handle = this.handles.get(agentId);
    if (handle) handle.stopping = true;
    await this.control.stopAgentProcesses(agentId);
    if (handle) {
      const acknowledged = await this.waitForAck(agent.id, handle, "aborted", () => sendToWorker(handle.child, { type: "abort" }));
      if (!acknowledged) {
        this.control.setAgentStatus(agent.id, handle.epoch, "error", "Worker did not acknowledge interruption");
        await this.stopAgent(agent.id);
        this.control.markAgentInterrupted(agentId, handle.epoch);
        return;
      }
      this.control.setAgentStatus(agent.id, handle.epoch, "idle");
      await this.stopAgent(agent.id);
    }
    this.control.markAgentInterrupted(agentId, handle?.epoch ?? agent.epoch);
  }

  async stopMission(missionId: string): Promise<void> {
    return this.quiesceMission(missionId, { kind: "stop" });
  }

  async stopAgent(agentId: string): Promise<void> {
    this.clearRemoteStopWait(agentId);
    const agent = this.control.getAgentPublic(agentId);
    if (agent?.machineId !== "local") {
      this.control.requestRemoteRuntimeStop(agentId);
      return;
    }
    const handle = this.handles.get(agentId);
    if (!handle || !this.control.getAgentPublic(agentId)) return;
    if (handle.close) return handle.close;
    handle.stopping = true;
    if (!isChildLive(handle.child)) {
      if (this.handles.get(agentId) === handle) this.handles.delete(agentId);
      return;
    }
    const closing = new Promise<void>((resolve, reject) => {
      let acknowledged = false;
      let finished = false;
      let force: NodeJS.Timeout | undefined;
      let final: NodeJS.Timeout | undefined;
      const onMessage = (raw: unknown): void => {
        const message = parseWorkerNotice(raw);
        if (!message || message.type !== "closed" || message.agentId !== agentId || message.epoch !== handle.epoch) return;
        acknowledged = true;
      };
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(terminate);
        clearTimeout(force);
        clearTimeout(final);
        handle.child.off("message", onMessage);
        handle.child.off("exit", finish);
        if (isChildLive(handle.child)) {
          this.control.blockUnconfirmedLocalWorkerStop(agentId, handle.epoch);
          reject(new Error("Local worker exit was not confirmed; queued inputs remain held"));
          return;
        }
        if (!acknowledged) this.control.setAgentStatus(agentId, handle.epoch, "error", "Worker exited without a shutdown acknowledgement");
        if (this.handles.get(agentId) === handle) this.handles.delete(agentId);
        resolve();
      };
      handle.child.on("message", onMessage);
      handle.child.once("exit", finish);
      const terminate = setTimeout(() => {
        if (!isChildLive(handle.child)) return finish();
        try {
          if (handle.child.pid && handle.child.pid > 0) process.kill(-handle.child.pid, "SIGTERM");
          else handle.child.kill("SIGTERM");
        } catch {
          try {
            handle.child.kill("SIGTERM");
          } catch {
            finish();
            return;
          }
        }
        force = setTimeout(() => {
          if (!isChildLive(handle.child)) return finish();
          try {
            if (handle.child.pid && handle.child.pid > 0) process.kill(-handle.child.pid, "SIGKILL");
            else handle.child.kill("SIGKILL");
          } catch {
            try {
              handle.child.kill("SIGKILL");
            } catch {
              finish();
              return;
            }
          }
          final = setTimeout(finish, 2000);
        }, 1000);
      }, 5000);
      void sendToWorker(handle.child, { type: "shutdown" }).catch(() => {
        if (finished) return;
        if (isChildLive(handle.child)) {
          try {
            if (handle.child.pid && handle.child.pid > 0) process.kill(-handle.child.pid, "SIGTERM");
            else handle.child.kill("SIGTERM");
          } catch {
            finish();
          }
        } else {
          finish();
        }
      });
    });
    handle.close = closing;
    try {
      await closing;
    } catch (error) {
      if (handle.close === closing) delete handle.close;
      throw error;
    }
  }

  private async waitForAck(agentId: string, handle: Handle, expected: string, send: () => Promise<void>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const finish = (acknowledged: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        handle.child.off("message", listener);
        handle.child.off("exit", onExit);
        resolve(acknowledged);
      };
      const listener = (raw: unknown): void => {
        const message = parseWorkerNotice(raw);
        if (!message) return;
        if (message.type === expected && message.agentId === agentId && message.epoch === handle.epoch) {
          finish(true);
        }
      };
      const onExit = (): void => finish(false);
      const timer = setTimeout(() => finish(false), 5000);
      handle.child.on("message", listener);
      handle.child.once("exit", onExit);
      if (!isChildLive(handle.child)) finish(false);
      else void send().catch(() => finish(false));
    });
  }

  private recordDetachedFailure(agent: Agent, error: unknown): void {
    try {
      const profile = this.control.profile(agent.profileId);
      const secret = profile?.credentialEnv ? process.env[profile.credentialEnv] : undefined;
      this.control.recordWorkerDiagnostic(agent.id, agent.epoch, sanitizeDiagnostic(error, secret));
    } catch {
      // The control plane may already be closing.
    }
  }

  private runDetached(agent: Agent, task: Promise<unknown>): void {
    void task.catch((error: unknown) => this.recordDetachedFailure(agent, error));
  }

  private async sendReply(agent: Agent, handle: Handle, message: object): Promise<void> {
    try {
      await sendToWorker(handle.child, message);
    } catch (error) {
      this.recordDetachedFailure(agent, error);
    }
  }

  async prepareCoordinatorShutdown(timeoutMs: number): Promise<void> {
    this.closing = true;
    for (const agentId of this.remoteStopWaits.keys()) this.clearRemoteStopWait(agentId);
    const pending = new Set<string>();
    const deadline = Date.now() + timeoutMs;
    for (const mission of this.control.state().missions) {
      const assignments = this.control.listAgents(mission.id).flatMap((agent) => {
        const runtime = agent.machineId !== "local" ? this.control.remoteRuntimes.activeForAgent(agent.id) : undefined;
        return runtime ? [{ agent, runtime }] : [];
      });
      if (!assignments.length) continue;
      this.control.pauseForCoordinatorShutdown(mission.id, assignments.map(({ runtime }) => runtime.runtime_id), deadline);
      for (const { runtime } of assignments) {
        pending.add(runtime.runtime_id);
      }
    }
    // Keep the node listener alive until confirmation or the shared deadline.
    while (pending.size) {
      for (const runtimeId of pending) {
        if (this.control.confirmedRemoteRuntimeStop(runtimeId)) pending.delete(runtimeId);
      }
      if (!pending.size || Date.now() >= deadline) break;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, Math.min(25, deadline - Date.now())));
    }
    for (const runtimeId of pending) this.control.fenceUnconfirmedRemoteStop(runtimeId);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const agentId of this.remoteStopWaits.keys()) this.clearRemoteStopWait(agentId);
    for (const handle of this.handles.values()) handle.stopping = true;
    const missions = [...new Set(this.control.listAgents().map((agent) => agent.missionId))];
    // A slow startup or another Mission's Harness settlement must not delay
    // signalling any already-running shell or MCP operation.
    const processes = Promise.allSettled(missions.map((missionId) => this.control.stopMissionProcesses(missionId)));
    const stopped = Promise.allSettled(missions.map((missionId) => this.stopMission(missionId)));
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([...this.recoveryFlights.values()]);
    const failures = [...await processes, ...await stopped].filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Worker shutdown did not settle all owned resources");
  }
}
