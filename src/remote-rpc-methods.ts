export const REMOTE_RPC_METHODS = new Set([
  "AdmitTurn", "Transcript", "Usage", "ListAgents", "GetMissionState",
  "SendMessage", "CreateTask", "UpdateTask", "Report",
  "RecordEffectReceipt"
]);
export const REMOTE_ORCHESTRATOR_RPC_METHODS = new Set(["RequestUserInput"]);
export const REMOTE_EFFECT_METHODS = new Set(["read_file", "write_file", "bash", "PublishArtifact"]);

/**
 * Replies that do not carry execution authorization.
 *
 * An uncertain reply may be ignored when closing a fenced mailbox only if the
 * request inbox row is already `applied` and the method is in this set. The
 * reply row stays `uncertain`: settlement does not acknowledge, replay, or
 * rebind it. Every other method is fail-closed, including a reply that merely
 * might contain an effect permit, approval, task assignment, publish receipt,
 * or other business result.
 *
 * - Transcript: append-only transcript record. The reply is `{recorded:true}`
 *   (or the late-evidence variant). Losing it grants nothing.
 * - Usage: cost accounting record. The reply is `{recorded:true}`.
 * - ListAgents: read-only agent snapshot. Discarding it grants nothing.
 * - GetMissionState: read-only mission snapshot. Discarding it grants nothing.
 *
 * Not included: AdmitTurn authorizes a model turn. SendMessage, Report,
 * CreateTask, UpdateTask, SpawnAgent, ValidateTask, CompleteMission,
 * RequestUserInput, and RecordEffectReceipt commit business results.
 * read_file, write_file, bash, and PublishArtifact replies can carry an
 * effect permit or publish receipt. RunValidation and CallMcpTool can carry
 * an approval. Durable `deliver` and `approved-effect` downlinks are not RPCs
 * and stay fail-closed.
 */
export const REMOTE_NONAUTHORIZING_RPC_METHODS = new Set([
  "Transcript",
  "Usage",
  "ListAgents",
  "GetMissionState"
]);
