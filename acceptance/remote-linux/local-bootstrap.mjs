import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [cli, port, machineId, home, workspace, ...refs] = process.argv.slice(2);
const lines = [];
for await (const line of createInterface({ input: process.stdin })) lines.push(line);
if (lines.length !== refs.length + 1) throw new Error("Incomplete node credentials on stdin");
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, LANG: "C", MC_ACCEPTANCE_NODE_TOKEN: lines[0] };
for (const [index, ref] of refs.entries()) env[ref] = lines[index + 1];
const child = spawn(process.execPath, [cli, "node", "--coordinator", `http://127.0.0.1:${port}`, "--machine-id", machineId,
  "--token-env", "MC_ACCEPTANCE_NODE_TOKEN", "--home", home, "--root", workspace,
  ...refs.flatMap((ref) => ["--credential-ref", ref]), "--execution-mode", "workspace-effects"], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", () => { process.stderr.write("Local node spawn failed\n"); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
