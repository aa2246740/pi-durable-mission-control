import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../../dist/server.js";

const home = process.argv[2];
const root = join(home, "workspace");
mkdirSync(root);
const service = await startServer({ home: join(home, "control"), port: 0, nodePort: 0, remoteShutdownTimeoutMs: 5000, testOnlyScripted: true });
const c = service.control;
const enrolled = c.enrollMachine("shutdown-node", "Shutdown node");
process.send({ type: "ready", port: service.nodePort, root, ...enrolled });
process.on("message", message => {
  if (message !== "assign") return;
  const machine = c.machineRegistry.get(enrolled.machine.id);
  const probe = c.probeMachine(machine.id, crypto.randomUUID(), root);
  c.nodePoll(machine.id, enrolled.token, machine.sessionId, machine.sessionEpoch);
  c.nodeEvent(machine.id, enrolled.token, machine.sessionId, machine.sessionEpoch, probe.id,
    { ok: true, result: { requestedPath: root, path: root, isDirectory: true } });
  const local = c.addWorkspace("Local", root);
  const remote = c.addRemoteWorkspace("Remote", machine.id, probe.id);
  c.upsertProfile({ id: "shutdown-profile", name: "Fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "http://127.0.0.1:1", credentialEnv: "", contextWindow: 4096, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false, revision: 1 });
  const roleIds = ["orchestrator", "worker", "validator"].map(kind => {
    const id = `shutdown-${kind}`;
    c.upsertRole({ id, name: kind, kind, instructions: "fixture", profileId: "shutdown-profile" });
    return id;
  });
  const mission = c.createMission({ title: "Shutdown", goal: "Stop safely", acceptance: "No replay",
    workspaceId: local.id, remoteWorkspaceIds: [remote.id], roleIds, maxTurns: 20, maxCost: 0,
    autonomy: "trusted", workspaceStrategy: "shared" });
  c.missionAction(mission.id, "start");
  const agent = c.createAgent(mission.id, "Remote worker", roleIds[1], "fixture", crypto.randomUUID(), remote.id);
  const assignment = c.assignRemoteRuntime(agent.id);
  process.send({ type: "assigned", missionId: mission.id, ...assignment });
});
process.on("SIGTERM", () => {
  void service.close().then(() => { process.disconnect(); }, error => {
    process.stderr.write(String(error)); process.exit(1);
  });
});
