export const REMOTE_RPC_METHODS = new Set([
  "AdmitTurn", "Transcript", "Usage", "ListAgents", "GetMissionState",
  "SendMessage", "CreateTask", "UpdateTask", "Report", "RequestUserInput",
  "RecordEffectReceipt"
]);
export const REMOTE_EFFECT_METHODS = new Set(["read_file", "write_file", "bash", "PublishArtifact"]);
