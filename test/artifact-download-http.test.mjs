import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "artifact-download-http-"));
  const service = await startServer({ home: join(home, "state"), port: 0 });
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  const control = service.control;
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath);
  control.upsertProfile({
    id: "download-profile", name: "Download fixture", api: "openai-completions", modelId: "fixture",
    baseUrl: "http://127.0.0.1:9999", credentialEnv: "", contextWindow: 16000, maxTokens: 512,
    reasoning: false, toolCalling: true, vision: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  });
  const roles = ["orchestrator", "worker", "validator"];
  for (const kind of roles) control.upsertRole({ id: kind, name: kind, kind, instructions: kind, profileId: "download-profile" });
  const workspace = control.addWorkspace("Downloads", workspacePath);
  const mission = control.createMission({
    title: "Downloads", goal: "Preserve filenames", acceptance: "Safe download names",
    workspaceId: workspace.id, roleIds: roles, maxTurns: 10, maxCost: 0, autonomy: "trusted"
  });
  const started = control.missionAction(mission.id, "start");
  const publisher = control.getAgentPublic(started.orchestratorId);
  const base = `http://127.0.0.1:${service.port}`;
  const page = await fetch(base);
  const cookie = page.headers.get("set-cookie").split(";")[0];
  await page.text();
  const headers = { cookie };
  const bytes = Buffer.from("export const total = 42;\n");
  const sourcePath = join(workspacePath, "totals.mjs");
  writeFileSync(sourcePath, bytes);
  let nextId = 0;
  const publish = ({ path = sourcePath, name = "Display label", relativePath } = {}) => {
    const artifact = control.publishArtifact(publisher.id, publisher.epoch, `publish-${++nextId}`, name, path, bytes);
    if (relativePath !== undefined) {
      artifact.relativePath = relativePath;
      control.db.prepare("UPDATE artifacts SET data=? WHERE id=?").run(JSON.stringify(artifact), artifact.id);
    }
    return artifact;
  };
  return { control, mission, base, headers, bytes, publish };
}

test("artifact HTTP downloads and mission detail share safe ASCII and UTF-8 filenames", async t => {
  const f = await fixture(t);
  const cases = [
    { title: "local source basename", input: {}, expected: "totals.mjs", ascii: "totals.mjs", encoded: "totals.mjs" },
    { title: "relative path takes precedence", input: { relativePath: "src/preferred.mjs" },
      expected: "preferred.mjs", ascii: "preferred.mjs", encoded: "preferred.mjs" },
    { title: "remote-style absolute path", input: { path: "/home/x/work/totals.mjs" },
      expected: "totals.mjs", ascii: "totals.mjs", encoded: "totals.mjs" },
    { title: "Windows basename", input: { path: "C:\\work\\windows.mjs" },
      expected: "windows.mjs", ascii: "windows.mjs", encoded: "windows.mjs" },
    { title: "Chinese filename", input: { path: "/work/统计报告.mjs" },
      expected: "统计报告.mjs", ascii: "____.mjs", encoded: "%E7%BB%9F%E8%AE%A1%E6%8A%A5%E5%91%8A.mjs" },
    { title: "quoted source filename", input: { path: "/work/\"quoted'.txt" },
      expected: "quoted.txt", ascii: "quoted.txt", encoded: "quoted.txt" },
    { title: "CRLF injection in fallback name", input: { path: "", name: "报\"告'\r\nX-Injected: yes.txt" },
      expected: "报告X-Injected yes.txt", ascii: "__X-Injected yes.txt", encoded: "%E6%8A%A5%E5%91%8AX-Injected%20yes.txt" },
    { title: "control characters and lone surrogate", input: { path: "", name: "sa\u0000fe\u007f\u0085\ud800.txt" },
      expected: "safe.txt", ascii: "safe.txt", encoded: "safe.txt" },
    { title: "fallback name removes both separators", input: { path: "", name: "folder/report\\final.txt" },
      expected: "folderreportfinal.txt", ascii: "folderreportfinal.txt", encoded: "folderreportfinal.txt" },
    { title: "RFC 5987 punctuation and percent", input: { path: "/work/budget%20!(draft)*.txt" },
      expected: "budget%20!(draft).txt", ascii: "budget_20!(draft).txt", encoded: "budget%2520%21%28draft%29.txt" },
    { title: "empty relative basename falls back to path", input: { relativePath: "/\"\r\n" },
      expected: "totals.mjs", ascii: "totals.mjs", encoded: "totals.mjs" },
    { title: "empty names fall back to artifact ID", input: { path: "/", name: "\"'\r\n\\/" } }
  ];
  for (const entry of cases) await t.test(entry.title, async () => {
    const artifact = f.publish(entry.input);
    const expected = entry.expected ?? `artifact-${artifact.id}`;
    const response = await fetch(`${f.base}/api/artifacts/${artifact.id}/content`, { headers: f.headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-disposition"),
      `attachment; filename="${entry.ascii ?? expected}"; filename*=UTF-8''${entry.encoded ?? expected}`);
    assert.equal(response.headers.get("x-injected"), null);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("content-length"), String(f.bytes.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
    const detailResponse = await fetch(`${f.base}/api/missions/${f.mission.id}`, { headers: f.headers });
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.artifacts.find(item => item.id === artifact.id).downloadName, expected);
    assert.equal(f.control.artifact(artifact.id).downloadName, undefined, "download name is a view field, not persisted metadata");
  });
});

test("artifact downloads still require authentication and verified snapshots", async t => {
  const f = await fixture(t);
  const artifact = f.publish();
  const url = `${f.base}/api/artifacts/${artifact.id}/content`;
  const unauthorized = await fetch(url);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("content-disposition"), null);
  await unauthorized.text();
  chmodSync(artifact.snapshotPath, 0o600);
  writeFileSync(artifact.snapshotPath, "tampered snapshot");
  const tampered = await fetch(url, { headers: f.headers });
  assert.equal(tampered.status, 409);
  assert.deepEqual(await tampered.json(), { error: "Artifact digest changed" });
  assert.equal(tampered.headers.get("content-disposition"), null);
  delete artifact.snapshotPath;
  f.control.db.prepare("UPDATE artifacts SET data=? WHERE id=?").run(JSON.stringify(artifact), artifact.id);
  const missingSnapshot = await fetch(url, { headers: f.headers });
  assert.equal(missingSnapshot.status, 409);
  assert.deepEqual(await missingSnapshot.json(), { error: "Artifact snapshot is unavailable" });
  assert.equal(missingSnapshot.headers.get("content-disposition"), null);
});
