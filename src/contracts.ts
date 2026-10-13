import type { McpPermission, McpServerConfig } from "./mcp-config.js";

export type MissionStatus = 'draft' | 'active' | 'paused' | 'blocked' | 'validating' | 'completed' | 'failed' | 'cancelled';
export type AgentStatus = 'idle' | 'running' | 'waiting_approval' | 'waiting_user' | 'recovering' | 'offline' | 'error';
export type TaskStatus = 'ready' | 'assigned' | 'running' | 'review' | 'accepted' | 'blocked';
export interface ModelProfile {
  id: string; name: string; api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  modelId: string; baseUrl: string; credentialEnv: string; contextWindow: number; maxTokens: number;
  reasoning: boolean; toolCalling: boolean; vision: boolean; revision: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  available?: boolean;
}
export interface RoleProfile { id: string; name: string; kind: 'orchestrator' | 'worker' | 'validator'; instructions: string; profileId: string; mcpPermissions?: McpPermission[]; }
export interface Workspace {
  id: string; name: string; path: string; machineId: string;
  probe?: { commandId: string; sessionEpoch: number; requestedPath: string; verifiedAt: number };
}
export interface NodeCapabilities {
  protocol: number;
  version: string;
  platform: string;
  arch: string;
  node: string;
  piDurable: string;
  roots: string[];
  credentialRefs: string[];
  executionEnabled: boolean;
  executionMode?: "metadata-only";
}
export interface RemoteMachine {
  id: string; name: string; kind: 'remote';
  status: 'enrolled' | 'online' | 'offline' | 'revoked';
  sessionEpoch: number; sessionId?: string; lastSeenAt?: number; leaseExpiresAt?: number;
  capabilities?: NodeCapabilities; createdAt: string;
}
export interface Machine { id: string; name: string; kind: 'local' | 'remote'; status: string; host?: string; }
export interface Mission {
  id: string; title: string; goal: string; acceptance: string; status: MissionStatus; workspaceId: string;
  remoteWorkspaceIds?: string[];
  orchestratorId?: string; createdAt: string; updatedAt: string; maxTurns: number; turns: number;
  maxCost: number; cost: number; costKnown: boolean; autonomy: 'approve' | 'trusted'; roleIds: string[];
  contractRevision?: number;
  workspaceStrategy?: 'shared' | 'worktree';
  repository?: { path: string; gitCommonDir: string; baseCommit: string };
}
export interface Requirement { id: string; description: string; revision: number; }
export interface ValidationContract { missionId: string; revision: number; assertions: Requirement[]; createdAt: string; }
export interface AssertionResult { assertionId: string; status: 'passed' | 'failed' | 'untested'; evidence: string; }
export interface RequirementCoverage {
  assertion: Requirement; taskId?: string; status: 'unassigned' | 'pending' | 'passed' | 'failed';
  validationId?: string; receiptId?: string;
}
export type CreateMissionInput = Omit<Mission, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'turns' | 'cost' | 'costKnown' | 'contractRevision' | 'repository'> & {
  assertions?: Array<Pick<Requirement, 'id' | 'description'>>;
};
export interface Agent {
  id: string; missionId: string; title: string; roleId: string; kind: RoleProfile['kind']; profileId: string;
  profileRevision?: number; status: AgentStatus; epoch: number; workspacePath: string; workspaceId?: string; machineId: string; error?: string;
  createdAt: string; updatedAt: string; worktreeId?: string;
}
export interface Task {
  id: string; missionId: string; title: string; description: string; acceptance: string; status: TaskStatus;
  dependencies: string[]; ownerId?: string; validatorId?: string; attempt: number; revision?: number; evidence?: string;
  fulfills?: string[]; integration?: boolean;
}
export interface Message {
  id: string; missionId: string; senderId: string; recipientId: string; content: string; mode: 'steer' | 'followUp';
  status: string; attempt: number; createdAt: string; error?: string;
}
export interface MissionEvent { seq: number; missionId: string; type: string; agentId?: string; text: string; createdAt: string; data?: unknown; }
export interface Approval {
  id: string; missionId: string; agentId: string; tool: string; args: unknown;
  status: 'pending' | 'approved' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'denied' | 'consumed';
  createdAt: string; receipt?: { stdout: string; stderr: string; exitCode: number | null };
  mcpBinding?: {
    serverId: string; serverRevision: number; roleRevision: number; actorEpoch: number; toolName: string;
    definitionHash: string; commandId: string; permissionMode: "approve" | "allow";
  };
  authorizationSource?: "role-permission" | "user-approval";
}
export interface Artifact {
  id: string; missionId: string; agentId: string; name: string; path: string; sha256: string; size: number; createdAt: string;
  snapshotPath?: string; taskId?: string;
  workspaceCommit?: string; relativePath?: string;
}
export interface ValidationReceipt {
  id: string; missionId: string; taskId: string; validatorId: string; command: string; stdout: string; stderr: string;
  exitCode: number | null; attempt: number; taskRevision: number; artifactIds: string[];
  artifactDigests: Record<string, string>; createdAt: string;
  contractRevision?: number; requirementRevisions?: Record<string, number>;
  workspaceCommit?: string; workspaceBranch?: string; workspacePath?: string;
  snapshotIntegrity?: boolean; snapshotError?: string;
}
export interface Validation {
  id: string; missionId: string; taskId: string; agentId: string; passed: boolean; evidence: string; createdAt: string;
  receiptId?: string; attempt?: number; taskRevision?: number; artifactIds?: string[];
  requirementRevisions?: Record<string, number>; assertionResults?: AssertionResult[];
}
export interface MissionStateView {
  mission: Mission; tasks: Task[]; roles: Array<{ roleId: string; name: string; kind: RoleProfile['kind']; profileId: string; modelName: string; modelId: string; profileRevision: number }>;
  agents: Agent[]; approvals: Approval[]; worktrees?: WorktreeRecord[];
  remoteWorkspaces: Array<{ id: string; name: string; machineId: string; path: string; executionEnabled: boolean; executionMode?: "metadata-only" }>;
  mcpServers?: Array<{ id: string; name: string; revision: number; tools: Array<{ toolName: string; mode: 'approve' | 'allow' }> }>;
  validationContract?: ValidationContract; requirementCoverage?: RequirementCoverage[];
}
export interface Blocker {
  id: string; missionId: string; agentId?: string; taskId?: string; kind: 'user_input' | 'unsafe_execution' | 'delivery' | 'limit' | 'approval';
  status: 'open' | 'resolved'; text: string; createdAt: string; resolvedAt?: string;
}
export type ScheduleSpec = { kind: 'once'; at: string } | { kind: 'cron'; expression: string; timeZone: string };
export interface MissionSchedule {
  id: string; missionId: string; name: string; prompt: string; schedule: ScheduleSpec;
  status: 'enabled' | 'held' | 'finished' | 'deleted'; revision: number;
  nextRunAt?: string; lastOccurrenceId?: string; reason?: string; createdAt: string; updatedAt: string;
}
export interface ScheduleOccurrence {
  id: string; missionId: string; scheduleId: string; scheduleRevision: number;
  scheduledFor: string; observedAt: string; outcome: 'queued' | 'skipped'; reason?: string;
  messageId?: string; requestId?: string; attempt?: number; deliveryStatus?: string; deliveryError?: string;
}
export interface TranscriptEntry { id: string; role: string; text: string; createdAt?: string; }
export type WatchdogDiagnosis = 'not_observed' | 'mission_inactive' | 'waiting_user' | 'waiting_approval' | 'blocked' | 'offline' | 'running' | 'running_no_progress' | 'delivery_pending' | 'budget_exhausted' | 'no_pending_tasks' | 'observing' | 'stalled' | 'wake_queued' | 'needs_attention' | 'observation_error';
export interface MissionWatchdog {
  missionId: string; autoWake: boolean; revision: number; diagnosis: WatchdogDiagnosis;
  fingerprint?: string; progressSince?: string; eligibleSince?: string; runningSince?: string; checkedAt?: string;
  pendingTaskIds: string[]; idleThresholdMs: number; runningThresholdMs: number;
}
export interface WatchdogWake {
  id: string; missionId: string; fingerprint: string; messageId: string; requestId: string;
  attempt: number; createdAt: string; deliveryStatus?: string; deliveryError?: string;
}
export interface WorktreeRecord {
  id: string; missionId: string; kind: 'agent' | 'validation'; agentId?: string; path: string; branch?: string;
  baseCommit: string; repositoryPath: string; gitCommonDir: string; status: 'pending' | 'ready' | 'error';
  error?: string; createdAt: string; checkedAt?: string;
}
export interface MissionDetail {
  mission: Mission; agents: Agent[]; tasks: Task[]; messages: Message[]; events: MissionEvent[];
  approvals: Approval[]; artifacts: Artifact[]; validations: Validation[];
  validationReceipts?: ValidationReceipt[]; blockers?: Blocker[];
  validationContract?: ValidationContract; requirementCoverage?: RequirementCoverage[];
  validationContractHistory?: ValidationContract[];
  schedules?: MissionSchedule[]; scheduleOccurrences?: ScheduleOccurrence[];
  watchdog?: MissionWatchdog; watchdogWakes?: WatchdogWake[];
  worktrees?: WorktreeRecord[];
}
export interface AppState {
  missions: Mission[]; profiles: ModelProfile[]; roles: RoleProfile[]; workspaces: Workspace[];
  machines: Machine[]; version: string; mcpServers?: McpServerConfig[];
}
