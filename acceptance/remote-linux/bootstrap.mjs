import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";

const [relayPort, machineId, ...credentialRefs] = process.argv.slice(2);
mkdirSync("/work", { recursive: true });
const sockets = new Set();
const relay = createServer((socket) => {
  const upstream = connect(Number(relayPort), "192.168.64.1");
  for (const stream of [socket, upstream]) {
    sockets.add(stream);
    stream.on("close", () => sockets.delete(stream));
    stream.on("error", () => { socket.destroy(); upstream.destroy(); });
  }
  socket.pipe(upstream).pipe(socket);
});
await new Promise((resolve, reject) => { relay.once("error", reject); relay.listen(14311, "127.0.0.1", resolve); });
const child = spawn(process.execPath, ["/app/dist/cli.js", "node", "--coordinator", "http://127.0.0.1:14311",
  "--machine-id", machineId, "--token-env", "MC_ACCEPTANCE_NODE_TOKEN", "--home", process.env.MC_ACCEPTANCE_NODE_HOME ?? "/node-home", "--root", "/work",
  ...((credentialRefs.length ? credentialRefs : ["MC_ACCEPTANCE_MODEL_CREDENTIAL"]).flatMap((name) => ["--credential-ref", name])), "--execution-mode", "workspace-effects"], { stdio: "inherit" });
const retainForEvidence = process.env.MC_ACCEPTANCE_RETAIN_CONTAINER === "1";
if (retainForEvidence) {
  mkdirSync("/node-home", { recursive: true });
  writeFileSync("/node-home/acceptance-node.pid", String(child.pid), { mode: 0o600 });
}
let evidenceWait;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (child.exitCode !== null || child.signalCode !== null) {
    clearInterval(evidenceWait);
    process.exitCode = 0;
  } else child.kill(signal);
});
child.on("error", () => { process.stderr.write("Container node spawn failed\n"); process.exitCode = 1; relay.close(); });
child.on("exit", (code) => {
  for (const socket of sockets) socket.destroy();
  relay.close();
  if (retainForEvidence) {
    writeFileSync("/node-home/acceptance-node-stopped.json", JSON.stringify({ stopped: true, exitCode: code }), { mode: 0o600 });
    // Keep only the container alive until the stopped workers' databases are read.
    evidenceWait = setInterval(() => {}, 1000);
  } else process.exitCode = code ?? 1;
});
