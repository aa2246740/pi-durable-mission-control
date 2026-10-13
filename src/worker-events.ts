import type { Agent, Message } from "./contracts.js";
import type { ControlPlane } from "./control.js";

export type WorkerNoticeBody =
  | { type: "ready" }
  | { type: "closed" }
  | { type: "aborted" }
  | {
      type: "admitted";
      messageId: string;
      requestId: string;
      attempt: number;
      submissionId: string;
    }
  | {
      type: "settled";
      messageId: string;
      requestId: string;
      attempt: number;
      submissionId: string;
      status: "done" | "unanswered";
      result?: unknown;
      error?: string;
    }
  | {
      type: "delivery_error";
      messageId: string;
      requestId: string;
      attempt: number;
      error: string;
    }
  | {
      type: "turn_end";
      turnId: string;
      generationId?: string;
    }
  | {
      type: "error";
      message: string;
    };

export type WorkerNotice = WorkerNoticeBody & {
  agentId: string;
  epoch: number;
};

export type WorkerNoticeApplication = {
  applied: boolean;
  ready: boolean;
  lifecycleSync: boolean;
};

const ignored: WorkerNoticeApplication = { applied: false, ready: false, lifecycleSync: false };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function has(recordValue: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(recordValue, key);
}

function exactKeys(recordValue: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(recordValue).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveAttempt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function optionalString(recordValue: Record<string, unknown>, key: string): string | undefined | false {
  if (!has(recordValue, key) || recordValue[key] === undefined) return undefined;
  return typeof recordValue[key] === "string" ? recordValue[key] as string : false;
}

function parseBody(value: Record<string, unknown>): WorkerNoticeBody | undefined {
  if (typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "ready":
    case "closed":
    case "aborted":
      return exactKeys(value, ["type"]) ? { type: value.type } : undefined;
    case "error":
      return exactKeys(value, ["type", "message"]) && typeof value.message === "string"
        ? { type: "error", message: value.message }
        : undefined;
    case "turn_end": {
      if (!exactKeys(value, ["type", "turnId", "generationId"]) || !nonEmptyString(value.turnId)) return undefined;
      const generationId = optionalString(value, "generationId");
      return generationId === false
        ? undefined
        : { type: "turn_end", turnId: value.turnId, ...(generationId === undefined ? {} : { generationId }) };
    }
    case "admitted":
      return exactKeys(value, ["type", "messageId", "requestId", "attempt", "submissionId"])
        && nonEmptyString(value.messageId)
        && nonEmptyString(value.requestId)
        && positiveAttempt(value.attempt)
        && nonEmptyString(value.submissionId)
        ? {
            type: "admitted",
            messageId: value.messageId,
            requestId: value.requestId,
            attempt: value.attempt,
            submissionId: value.submissionId
          }
        : undefined;
    case "delivery_error":
      return exactKeys(value, ["type", "messageId", "requestId", "attempt", "error"])
        && nonEmptyString(value.messageId)
        && nonEmptyString(value.requestId)
        && positiveAttempt(value.attempt)
        && typeof value.error === "string"
        ? {
            type: "delivery_error",
            messageId: value.messageId,
            requestId: value.requestId,
            attempt: value.attempt,
            error: value.error
          }
        : undefined;
    case "settled": {
      if (
        !exactKeys(value, ["type", "messageId", "requestId", "attempt", "submissionId", "status", "result", "error"])
        || !nonEmptyString(value.messageId)
        || !nonEmptyString(value.requestId)
        || !positiveAttempt(value.attempt)
        || !nonEmptyString(value.submissionId)
        || (value.status !== "done" && value.status !== "unanswered")
      ) return undefined;
      const error = optionalString(value, "error");
      if (error === false) return undefined;
      return {
        type: "settled",
        messageId: value.messageId,
        requestId: value.requestId,
        attempt: value.attempt,
        submissionId: value.submissionId,
        status: value.status,
        ...(has(value, "result") && value.result !== undefined ? { result: value.result } : {}),
        ...(error === undefined ? {} : { error })
      };
    }
    default:
      return undefined;
  }
}

export function parseWorkerNotice(value: unknown): WorkerNotice | undefined {
  const input = record(value);
  if (
    !input
    || !exactKeys(input, [
      "type", "agentId", "epoch", "messageId", "requestId", "attempt", "submissionId",
      "status", "result", "error", "turnId", "generationId", "message"
    ])
    || !nonEmptyString(input.agentId)
    || !Number.isSafeInteger(input.epoch)
    || (input.epoch as number) <= 0
  ) return undefined;
  const { agentId, epoch, ...bodyInput } = input;
  const body = parseBody(bodyInput);
  return body ? { ...body, agentId, epoch: epoch as number } : undefined;
}

function currentOwner(control: ControlPlane, owner: Agent, notice: WorkerNotice): Agent | undefined {
  if (notice.agentId !== owner.id || notice.epoch !== owner.epoch) return undefined;
  const current = control.getAgentPublic(owner.id);
  if (!current || current.id !== owner.id || current.epoch !== owner.epoch || current.missionId !== owner.missionId) return undefined;
  return current;
}

function ownedMessage(control: ControlPlane, owner: Agent, messageId: string): Message | undefined {
  const message = control.message(messageId);
  return message && message.recipientId === owner.id && message.missionId === owner.missionId ? message : undefined;
}

function settlementEvidence(
  notice: Extract<WorkerNotice, { type: "settled" }>,
  diagnosticSanitizer: (value: unknown) => string
): string | undefined {
  const hasResult = notice.result !== undefined;
  const hasError = notice.error !== undefined;
  if (!hasResult && !hasError) return undefined;
  const error = hasError ? diagnosticSanitizer(notice.error) : undefined;
  if (hasResult && hasError) return JSON.stringify({ result: notice.result, error });
  return JSON.stringify(hasResult ? notice.result : error);
}

export function applyWorkerNotice(
  control: ControlPlane,
  owner: Agent,
  notice: WorkerNotice,
  diagnosticSanitizer: (value: unknown) => string
): WorkerNoticeApplication {
  if (!currentOwner(control, owner, notice) || !control.missionById(owner.missionId)) return ignored;
  switch (notice.type) {
    case "ready": {
      const applied = control.setAgentStatus(owner.id, owner.epoch, "idle");
      return { applied, ready: applied, lifecycleSync: false };
    }
    case "closed":
      return { applied: control.setAgentStatus(owner.id, owner.epoch, "offline"), ready: false, lifecycleSync: false };
    case "aborted":
      return ignored;
    case "error": {
      const diagnostic = diagnosticSanitizer(notice.message) || "Worker runtime failed";
      const applied = control.setAgentStatus(owner.id, owner.epoch, "error", diagnostic);
      control.recordWorkerDiagnostic(owner.id, owner.epoch, diagnostic);
      return { applied, ready: false, lifecycleSync: false };
    }
    case "admitted": {
      if (!ownedMessage(control, owner, notice.messageId)) return ignored;
      const applied = control.ackOutbox(notice.messageId, notice.requestId, notice.attempt, notice.epoch, "admitted");
      if (applied) control.setAgentStatus(owner.id, owner.epoch, "running");
      return { applied, ready: false, lifecycleSync: false };
    }
    case "settled": {
      if (!ownedMessage(control, owner, notice.messageId)) return ignored;
      const status = notice.status === "done" ? "completed" : "uncertain";
      const applied = control.ackOutbox(
        notice.messageId,
        notice.requestId,
        notice.attempt,
        notice.epoch,
        status,
        settlementEvidence(notice, diagnosticSanitizer)
      );
      if (applied && status === "completed") control.setAgentStatus(owner.id, owner.epoch, "idle");
      return { applied, ready: false, lifecycleSync: applied && status === "uncertain" };
    }
    case "delivery_error": {
      if (!ownedMessage(control, owner, notice.messageId)) return ignored;
      const diagnostic = diagnosticSanitizer(notice.error) || "Worker delivery failed";
      const applied = control.retryOutboxForMessage(notice.messageId, diagnostic, notice.requestId, notice.attempt, notice.epoch);
      return { applied, ready: false, lifecycleSync: false };
    }
    case "turn_end":
      control.recordTurn(owner.id, owner.epoch, notice.turnId, notice.generationId);
      {
        const missionStatus = control.missionById(owner.missionId)?.status;
        return {
          applied: true,
          ready: false,
          lifecycleSync: missionStatus === "blocked" || missionStatus === "completed" || missionStatus === "cancelled"
        };
      }
  }
}
