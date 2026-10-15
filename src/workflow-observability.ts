import type { MissionWorkflowRecord } from "./workflow-schema.js";

export interface WorkflowReadState {
  workflow: MissionWorkflowRecord | null;
  missionParityEnabled: boolean;
  allowedActions: [];
}

export function projectWorkflowRead(workflow: MissionWorkflowRecord | null, missionParityEnabled: boolean): WorkflowReadState {
  return { workflow, missionParityEnabled, allowedActions: [] };
}

export function projectWorkflowExport(workflow: MissionWorkflowRecord | null, controlSchemaVersion: number): {
  controlSchemaVersion: number;
  workflowFormat: "mission-workflow-v1";
  workflow: MissionWorkflowRecord | null;
} {
  return { controlSchemaVersion, workflowFormat: "mission-workflow-v1", workflow };
}
