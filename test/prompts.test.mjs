import assert from "node:assert/strict";
import { test } from "node:test";
import { ORCHESTRATOR_INSTRUCTIONS, workerSystemInstructions } from "../dist/prompts.js";

const worker = { kind: "worker", instructions: "Implement the assigned task." };

test("remote runtime instructions require honest node-local checks and coordinator snapshot acceptance", () => {
  for (const runtimeMode of ["remote-workspace-effects", "remote-metadata-only"]) {
    const text = workerSystemInstructions({ role: worker, runtimeMode });
    assert.match(text, /remote node, not the coordinator host/);
    assert.match(text, /\/opt\/homebrew/);
    assert.match(text, /\/Users\//);
    assert.match(text, /acceptance files that exist only on the coordinator/);
    assert.match(text, /GetMissionState executionEnvironment \(machineId, platform, arch, node, and workspacePath\)/);
    assert.match(text, /commands and files that actually exist on this node/);
    assert.match(text, /\|\| true/);
    assert.match(text, /; true/);
    assert.match(text, /2>\/dev\/null/);
    assert.match(text, /not a pass/);
    assert.match(text, /missing file is a blocker/);
    assert.match(text, /Report it to the orchestrator instead of publishing/);
    assert.match(text, /frozen snapshot/);
    assert.match(text, /validator on the coordinator against that snapshot/);
  }

  const effects = workerSystemInstructions({
    role: worker, runtimeMode: "remote-workspace-effects", artifactTransfers: true, effectApprovals: true
  });
  assert.match(effects, /node-local read_file, write_file, and bash effects/);
  assert.match(effects, /PublishArtifact captures and uploads a bounded frozen snapshot/);
  assert.match(effects, /pending approval/);
  assert.match(effects, /not an OS sandbox/);
  assert.match(effects, /no credential environment variables intentionally/);

  const closed = workerSystemInstructions({ role: worker, runtimeMode: "remote-workspace-effects" });
  assert.match(closed, /Approval-mode write_file and bash are unavailable on this node/);

  const metadata = workerSystemInstructions({ role: worker, runtimeMode: "remote-metadata-only" });
  assert.match(metadata, /metadata-only: filesystem, shell, MCP, Git, validation execution, and artifact effects are unavailable/);

  const local = workerSystemInstructions({ role: worker, workspaceStrategy: "worktree" });
  assert.match(local, /independent local Git worktrees/);
  assert.equal(local.includes("remote node, not the coordinator host"), false);
  assert.equal(local.includes("|| true"), false);

  assert.match(ORCHESTRATOR_INSTRUCTIONS, /commands and paths that exist on that machine/);
  assert.match(ORCHESTRATOR_INSTRUCTIONS, /validator on the coordinator against the frozen snapshot/);
  assert.match(ORCHESTRATOR_INSTRUCTIONS, /not by the remote worker executing coordinator host paths/);
  const orchestrator = workerSystemInstructions({ role: { kind: "orchestrator", instructions: "Coordinate." } });
  assert.match(orchestrator, /commands and paths that exist on that machine/);
  assert.equal(orchestrator.includes("remote node, not the coordinator host"), false);
});
