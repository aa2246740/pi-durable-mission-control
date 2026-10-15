import assert from "node:assert/strict";
import { test } from "node:test";
import { rpcRequest } from "../dist/worker.js";

test("remote PublishArtifact normalizes absolute paths before IPC and refuses unsafe paths without RPC", async t => {
  const original = process.send;
  const connected = process.connected;
  process.connected = true;
  t.after(() => { process.send = original; process.connected = connected; });
  const sent = [];
  process.send = (message, callback) => {
    sent.push(message);
    queueMicrotask(() => process.emit("message", { id: message.id, result: { accepted: true } }));
    callback?.();
    return true;
  };
  const config = { agentId: "worker", epoch: 1, token: "unit-token", workspacePath: "/work", runtimeMode: "remote-workspace-effects" };
  for (const path of ["totals.mjs", "/work/totals.mjs", "/work/nested/totals.mjs"]) {
    const result = await rpcRequest(config, "PublishArtifact", { name: "Totals", path, taskId: "owned" }, path);
    assert.deepEqual(result, { accepted: true });
    assert.equal(sent.at(-1).args.path, path.replace(/^\/work\//, ""));
  }
  for (const path of ["/outside/totals.mjs", "/work-other/totals.mjs", "../totals.mjs", "/work/a/../totals.mjs", "a\\totals.mjs", "totals\u0000.mjs", "/work", "a//b", "./totals.mjs"]) {
    await assert.rejects(async () => rpcRequest(config, "PublishArtifact", { name: "Totals", path, taskId: "owned" }, "bad"), /path.*workspace/);
  }
  assert.equal(sent.length, 3);
  await rpcRequest({ ...config, runtimeMode: undefined }, "PublishArtifact", { path: "/local/file" }, "local");
  assert.equal(sent.at(-1).args.path, "/local/file");
});
