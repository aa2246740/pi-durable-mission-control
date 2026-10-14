import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Agent } from "./contracts.js";
import { ControlPlane, HttpError } from "./control.js";
import { remoteWorkspacePromptFlags } from "./prompts.js";
import type { RpcMessage } from "./worker.js";
import { applyWorkerNotice, parseWorkerNotice } from "./worker-events.js";
type Handle = { child: ChildProcess; token: string; epoch: number; ready: Promise<void>; close?: Promise<void>; stopping: boolean };
type QuiescenceFlight = {
  mode: "pause" | "stop";
  promise: Promise<void>;
  finished: boolean;
  fencedAgents: Set<string>;
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
  private closing = false;
  constructor(
    private readonly control: ControlPlane,
    private readonly testOnlyScripted = false,
    private readonly testOnlyToolLoop = false
  ) {}

  async startMission(missionId: string): Promise<void> {
    for (const agent of this.control.listAgents(missionId)) await this.startAgent(agent);
    await this.dispatchPending();
  }

  async recoverActiveMissions(): Promise<void> {
    const missions = this.control.state().missions.filter((mission) => mission.status === "active");
    for (const mission of missions) {
      for (const agent of this.control.listAgents(mission.id)) {
        if (agent.machineId !== "local" && this.control.remoteRuntimeForAgent(agent.id)) continue;
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
    if (this.closing || this.control.missionById(agent.missionId)?.status !== "active") return;
    const pending = this.starting.get(agent.id);
    if (pending) return pending;
    const starting = this.startAgentOnce(agent).catch(async (error: unknown) => {
      const profile = this.control.profile(agent.profileId);
      const secret = profile?.credentialEnv ? process.env[profile.credentialEnv] : undefined;
      this.control.failMissionStartup(agent.missionId, sanitizeDiagnostic(error, secret));
      await this.stopMission(agent.missionId);
      throw error;
    }).finally(() => this.starting.delete(agent.id));
    this.starting.set(agent.id, starting);
    return starting;
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
    const existing = this.handles.get(agent.id);
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
      const result = await this.control.workerCommand(request);
      await this.sendReply(agent, handle, { id: request.id, result });
      if (request.method === "InterruptAgent" && result && typeof result === "object" && "agentId" in result && typeof result.agentId === "string") {
        await this.interruptAgent(result.agentId);
      }
      await this.syncMissionLifecycle(agent.missionId).catch((error: unknown) => this.recordDetachedFailure(agent, error));
      await this.dispatchPending();
    } catch (error) {
      const profile = this.control.profile(agent.profileId);
      const secret = profile?.credentialEnv ? process.env[profile.credentialEnv] : undefined;
      await this.sendReply(agent, handle, { id: request.id, error: sanitizeDiagnostic(error, secret) });
      await this.syncMissionLifecycle(agent.missionId).catch((syncError: unknown) => this.recordDetachedFailure(agent, syncError));
    }
  }

  async dispatchPending(): Promise<void> {
    for (const row of this.control.pendingOutbox()) {
      const message = this.control.message(row.message_id);
      if (this.control.missionById(row.mission_id)?.status !== "active") continue;
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
        if (!handle) continue;
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
    if (status === "blocked") await this.pauseMission(missionId);
    else if (status === "completed" || status === "cancelled") await this.stopMission(missionId);
  }

  async pauseMission(missionId: string): Promise<void> {
    return this.quiesceMission(missionId, "pause");
  }

  private quiesceMission(missionId: string, mode: "pause" | "stop"): Promise<void> {
    const existing = this.quiescenceFlights.get(missionId);
    if (existing && !existing.finished) {
      if (mode === "stop") existing.mode = "stop";
      return existing.promise;
    }
    const flight: QuiescenceFlight = { mode, promise: Promise.resolve(), finished: false, fencedAgents: new Set() };
    this.quiescenceFlights.set(missionId, flight);
    flight.promise = this.performMissionQuiescence(missionId, flight).finally(() => {
      flight.finished = true;
      if (this.quiescenceFlights.get(missionId) === flight) this.quiescenceFlights.delete(missionId);
    });
    return flight.promise;
  }

  private async performMissionQuiescence(missionId: string, flight: QuiescenceFlight): Promise<void> {
    const agents = this.control.listAgents(missionId);
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
    try {
      await this.control.stopMissionProcesses(missionId);
    } catch (error) {
      for (const agent of agents) this.recordDetachedFailure(agent, error);
    }
    for (const [agentId, handle] of this.handles) {
      const agent = this.control.getAgentPublic(agentId);
      if (!captured.has(agentId) && agent?.missionId === missionId) {
        handle.stopping = true;
        captured.set(agentId, handle);
      }
    }
    for (const agent of agents) {
      const handle = captured.get(agent.id);
      if (!handle) continue;
      if (flight.mode === "pause" && isChildLive(handle.child)) {
        const acknowledged = await this.waitForAck(agent.id, handle, "aborted", () => sendToWorker(handle.child, { type: "abort" }));
        if (acknowledged && isChildLive(handle.child)) this.control.setAgentStatus(agent.id, handle.epoch, "idle");
        else if (isChildLive(handle.child)) {
          this.control.setAgentStatus(agent.id, handle.epoch, "error", "Worker did not acknowledge queue cancellation");
          flight.mode = "stop";
        }
      }
      await this.stopAgent(agent.id);
      if (!flight.fencedAgents.has(agent.id)) {
        flight.fencedAgents.add(agent.id);
        this.control.markAgentInterrupted(agent.id, agent.epoch);
      }
    }
    for (const [agentId, handle] of [...this.handles]) {
      const agent = this.control.getAgentPublic(agentId);
      if (agent?.missionId !== missionId || captured.has(agentId)) continue;
      handle.stopping = true;
      await this.stopAgent(agentId);
      if (!flight.fencedAgents.has(agentId)) {
        flight.fencedAgents.add(agentId);
        this.control.markAgentInterrupted(agentId, agent.epoch);
      }
    }
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
        this.control.markAgentInterrupted(agentId, agent.epoch);
        return;
      }
      this.control.setAgentStatus(agent.id, handle.epoch, "idle");
      await this.stopAgent(agent.id);
    }
    this.control.markAgentInterrupted(agentId, agent.epoch);
  }

  async stopMission(missionId: string): Promise<void> {
    return this.quiesceMission(missionId, "stop");
  }

  async stopAgent(agentId: string): Promise<void> {
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
    const closing = new Promise<void>((resolve) => {
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
    await closing;
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

  async close(): Promise<void> {
    this.closing = true;
    for (const handle of this.handles.values()) handle.stopping = true;
    await Promise.allSettled([...this.starting.values()]);
    for (const missionId of new Set(this.control.listAgents().map((agent) => agent.missionId))) await this.stopMission(missionId);
    await Promise.allSettled([...this.recoveryFlights.values()]);
  }
}
