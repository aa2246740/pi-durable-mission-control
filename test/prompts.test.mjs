import assert from "node:assert/strict";
import { test } from "node:test";
import { ORCHESTRATOR_INSTRUCTIONS, remoteWorkspacePromptFlags, workerSystemInstructions } from "../dist/prompts.js";

const worker = { kind: "worker", instructions: "Implement the assigned task." };
const validator = { kind: "validator", instructions: "Validate independently." };
const orchestratorRole = { kind: "orchestrator", instructions: "Coordinate." };

function assertRemoteLocation(text) {
  assert.match(text, /remote node, not the coordinator host/);
  assert.match(text, /\/opt\/homebrew/);
  assert.match(text, /\/Users\//);
  assert.match(text, /acceptance files that exist only on the coordinator/);
  assert.match(text, /GetMissionState executionEnvironment \(machineId, platform, arch, node, and workspacePath\)/);
}

function assertEffectSelfCheck(text) {
  assert.match(text, /commands and files that actually exist on this node/);
  assert.match(text, /\|\| true/);
  assert.match(text, /; true/);
  assert.match(text, /2>\/dev\/null/);
  assert.match(text, /not a pass/);
  assert.match(text, /missing file is a blocker/);
  assert.match(text, /Report it to the orchestrator instead of publishing/);
  assert.match(text, /What you publish is a frozen snapshot/);
  assert.match(text, /validator on the coordinator against that snapshot/);
}

test("remote runtime instructions require honest node-local checks and coordinator snapshot acceptance", () => {
  for (const runtimeMode of ["remote-workspace-effects", "remote-metadata-only"]) {
    assertRemoteLocation(workerSystemInstructions({ role: worker, runtimeMode }));
  }

  const effects = workerSystemInstructions({
    role: worker, runtimeMode: "remote-workspace-effects", artifactTransfers: true, effectApprovals: true
  });
  assertEffectSelfCheck(effects);
  assert.match(effects, /node-local read_file, write_file, and bash effects/);
  assert.match(effects, /PublishArtifact captures and uploads a bounded frozen snapshot/);
  assert.match(effects, /pending approval/);
  assert.match(effects, /not an OS sandbox/);
  assert.match(effects, /no credential environment variables intentionally/);
  assert.equal(effects.includes("takes priority over inspecting your assigned workspace"), false);

  const closed = workerSystemInstructions({ role: worker, runtimeMode: "remote-workspace-effects" });
  assertEffectSelfCheck(closed);
  assert.match(closed, /Approval-mode write_file and bash are unavailable on this node/);

  const metadata = workerSystemInstructions({ role: worker, runtimeMode: "remote-metadata-only" });
  assert.match(metadata, /metadata-only: filesystem, shell, MCP, Git, validation execution, and artifact effects are unavailable/);
  assert.match(metadata, /run your self-checks/);
  assert.match(metadata, /takes priority over any earlier instruction to run self-checks or call PublishArtifact/);
  assert.match(metadata, /Report blockers to the orchestrator/);
  assert.match(metadata, /Do not claim a command self-check or a published snapshot/);
  assert.equal(metadata.includes("Self-checks must use commands"), false);
  assert.equal(metadata.includes("commands and files that actually exist on this node"), false);
  assert.equal(metadata.includes("|| true"), false);
  assert.equal(metadata.includes("What you publish is a frozen snapshot"), false);
  assert.equal(metadata.includes("frozen snapshot"), false);
  assert.equal(metadata.includes("validator on the coordinator against that snapshot"), false);

  const local = workerSystemInstructions({ role: worker, workspaceStrategy: "worktree" });
  assert.match(local, /independent local Git worktrees/);
  assert.equal(local.includes("remote node, not the coordinator host"), false);
  assert.equal(local.includes("|| true"), false);

  assert.match(ORCHESTRATOR_INSTRUCTIONS, /commands and paths that exist on that machine/);
  assert.match(ORCHESTRATOR_INSTRUCTIONS, /validator on the coordinator against the frozen snapshot/);
  assert.match(ORCHESTRATOR_INSTRUCTIONS, /not by the remote worker executing coordinator host paths/);
  const orchestrator = workerSystemInstructions({ role: orchestratorRole });
  assert.match(orchestrator, /commands and paths that exist on that machine/);
  assert.equal(orchestrator.includes("remote node, not the coordinator host"), false);
});

test("local validators on a remote mission accept the frozen snapshot, not their own workspace", () => {
  const text = workerSystemInstructions({ role: validator, remoteWorkspacesAuthorized: true });
  assert.match(text, /Inspect the assigned workspace before editing/);
  assert.match(text, /working directory is that frozen snapshot/);
  assert.match(text, /takes priority over inspecting your assigned workspace/);
  assert.match(text, /do not look for that delivery in your own workspace/);
  assert.match(text, /do not use the remote workspacePath/);
  assert.match(text, /paths relative to the snapshot root, for example totals\.mjs/);
  assert.match(text, /The task must be in review before RunValidation/);
  assert.match(text, /Report the actual status to the orchestrator/);
  assert.match(text, /Do not ask the user/);
  const inspectAt = text.indexOf("Inspect the assigned workspace before editing");
  const priorityAt = text.indexOf("takes priority over inspecting your assigned workspace");
  assert.ok(inspectAt >= 0 && priorityAt > inspectAt);
  assert.equal(text.includes("remote node, not the coordinator host"), false);
  assert.equal(text.includes("Self-checks must use commands"), false);

  const worktree = workerSystemInstructions({ role: validator, remoteWorkspacesAuthorized: true, workspaceStrategy: "worktree" });
  const metadataValidator = workerSystemInstructions({
    role: validator, remoteWorkspacesAuthorized: true, runtimeMode: "remote-metadata-only"
  });
  const absent = [
    workerSystemInstructions({ role: validator }),
    workerSystemInstructions({ role: validator, remoteWorkspacesAuthorized: false }),
    workerSystemInstructions({ role: worker, remoteWorkspacesAuthorized: true }),
    workerSystemInstructions({ role: orchestratorRole, remoteWorkspacesAuthorized: true }),
    worktree,
    metadataValidator,
    workerSystemInstructions({ role: validator, remoteWorkspacesAuthorized: true, runtimeMode: "remote-workspace-effects" })
  ];
  for (const prompt of absent) {
    assert.equal(prompt.includes("takes priority over inspecting your assigned workspace"), false);
    assert.equal(prompt.includes("totals.mjs"), false);
  }
  assert.match(worktree, /separate detached worktree/);
  assert.match(metadataValidator, /artifact effects are unavailable/);
  assert.match(metadataValidator, /takes priority over any earlier instruction to run self-checks or call PublishArtifact/);
});

test("remote workspace prompt flags follow a non-empty mission allowlist and validator kind", () => {
  assert.deepEqual(remoteWorkspacePromptFlags("validator", ["remote-workspace"]), { remoteWorkspacesAuthorized: true });
  assert.deepEqual(remoteWorkspacePromptFlags("validator", undefined), {});
  assert.deepEqual(remoteWorkspacePromptFlags("validator", []), {});
  assert.deepEqual(remoteWorkspacePromptFlags("worker", ["remote-workspace"]), {});
  assert.deepEqual(remoteWorkspacePromptFlags("orchestrator", ["remote-workspace"]), {});
});
