export const REMOTE_RPC_METHODS = new Set([
  "AdmitTurn", "Transcript", "Usage", "ListAgents", "GetMissionState",
  "SendMessage", "CreateTask", "UpdateTask", "Report",
  "RecordEffectReceipt"
]);
export const REMOTE_ORCHESTRATOR_RPC_METHODS = new Set(["RequestUserInput"]);
export const REMOTE_EFFECT_METHODS = new Set(["read_file", "write_file", "bash", "PublishArtifact"]);
