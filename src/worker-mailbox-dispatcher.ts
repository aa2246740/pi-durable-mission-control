import type {
  DurableWorkerMailbox,
  WorkerBinding,
  WorkerDownlinkPayload,
  WorkerRpcPayload
} from "./worker-mailbox.js";
import type { WorkerNotice } from "./worker-events.js";

export type WorkerRpcReply = Extract<WorkerDownlinkPayload, { kind: "reply" }>;

export interface WorkerMailboxDispatcherOptions {
  mailbox: DurableWorkerMailbox;
  isCurrent(binding: WorkerBinding): boolean;
  canDispatch(binding: WorkerBinding): boolean;
  rpc(binding: WorkerBinding, request: WorkerRpcPayload): Promise<WorkerRpcReply>;
  notice(binding: WorkerBinding, notice: WorkerNotice): void;
}

const CLAIMS_PER_DRAIN = 16;

export class WorkerMailboxDispatcher {
  private readonly flights = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly options: WorkerMailboxDispatcherOptions) {}

  drain(binding: WorkerBinding): Promise<void> {
    if (this.closed) return Promise.resolve();
    const existing = this.flights.get(binding.runtimeId);
    if (existing) return existing;
    const flight = Promise.resolve()
      .then(() => this.run(binding))
      .finally(() => {
        if (this.flights.get(binding.runtimeId) === flight) this.flights.delete(binding.runtimeId);
      });
    this.flights.set(binding.runtimeId, flight);
    return flight;
  }

  drainAll(): Promise<void> {
    if (this.closed) return Promise.resolve();
    try {
      const bindings = this.options.mailbox.inspectBindings()
        .filter((binding) => binding.status === "open")
        .map(({ runtimeId, machineId, sessionId, sessionEpoch, agentId, epoch }) => ({
          runtimeId, machineId, sessionId, sessionEpoch, agentId, epoch
        }));
      return Promise.all(bindings.map((binding) => this.drain(binding))).then(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.flights.values()]);
  }

  private fence(binding: WorkerBinding): void {
    try {
      this.options.mailbox.fence(binding);
    } catch {
      // A concurrent fence or terminal binding already preserves the evidence.
    }
  }

  private async run(binding: WorkerBinding): Promise<void> {
    let claimedCount = 0;
    try {
      while (!this.closed && claimedCount < CLAIMS_PER_DRAIN) {
        if (!this.options.isCurrent(binding)) {
          this.fence(binding);
          return;
        }
        if (!this.options.canDispatch(binding)) return;
        const next = this.options.mailbox.received(binding, 1)[0];
        if (!next) return;
        const envelope = this.options.mailbox.claim(binding, next.messageId);
        if (!envelope) continue;
        claimedCount += 1;
        const payload = envelope.payload;
        if (payload.kind === "notice") {
          this.options.notice(binding, payload.notice);
          if (!this.options.isCurrent(binding)) {
            this.fence(binding);
            return;
          }
          if (!this.options.mailbox.finish(binding, envelope.messageId)) throw new Error("Worker notice completion was not accepted");
          continue;
        }
        if (payload.kind !== "rpc") throw new Error("Unexpected worker uplink payload");
        const reply = await this.options.rpc(binding, payload);
        if (!this.options.isCurrent(binding)) {
          this.fence(binding);
          return;
        }
        if (reply.kind !== "reply" || reply.rpcId !== payload.rpcId) throw new Error("Worker RPC reply does not match its request");
        this.options.mailbox.finishWithReply(binding, envelope.messageId, reply);
      }
    } catch {
      this.fence(binding);
    }
  }
}
