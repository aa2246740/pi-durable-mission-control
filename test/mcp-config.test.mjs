import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpPermissions, parseMcpServer } from "../dist/mcp-config.js";

test("MCP config persists credential references and enforces transport boundaries", () => {
  const local = parseMcpServer({ name: "Local tools", enabled: false, transport: "stdio", command: process.execPath, args: ["server.mjs"], envRefs: { API_KEY: "MCP_API_KEY" } });
  assert.deepEqual(local.envRefs, { API_KEY: "MCP_API_KEY" });
  assert.equal(local.timeoutMs, 30000);
  assert.equal(local.enabled, false);
  const remote = parseMcpServer({ name: "Remote tools", enabled: true, transport: "http", url: "https://example.com/mcp", headerRefs: { Authorization: { env: "MCP_API_KEY", prefix: "Bearer " } } });
  assert.deepEqual(remote.headerRefs, { authorization: { env: "MCP_API_KEY", prefix: "Bearer " } });
  assert.throws(() => parseMcpServer({ name: "Unsafe", enabled: true, transport: "http", url: "http://example.com/mcp" }), /HTTPS/);
  assert.throws(() => parseMcpServer({ name: "Unsafe", enabled: true, transport: "http", url: "https://example.com/mcp?token=value" }), /credentials/);
  assert.throws(() => parseMcpServer({ name: "Unsafe", enabled: true, transport: "stdio", command: "node" }), /absolute/);
  assert.throws(() => parseMcpServer({ name: "Unsafe", enabled: true, transport: "stdio", command: process.execPath, envRefs: { NODE_OPTIONS: "MCP_API_KEY" } }), /runtime/);
  assert.throws(() => parseMcpServer({ name: "Unsafe", enabled: true, transport: "http", url: "https://example.com/mcp", headers: { Authorization: "literal" } }), /unsupported/);
});

test("MCP grants default to deny and bind exact server-tool pairs", () => {
  assert.deepEqual(parseMcpPermissions(undefined), []);
  const grant = { serverId: "one", toolName: "read_document", mode: "approve" };
  assert.deepEqual(parseMcpPermissions([grant]), [grant]);
  assert.throws(() => parseMcpPermissions([grant, grant]), /Duplicate/);
  assert.throws(() => parseMcpPermissions([{ ...grant, toolName: "*" }]), /Wildcard/);
  assert.throws(() => parseMcpPermissions([{ ...grant, mode: "deny" }]), /approve or allow/);
  assert.throws(() => parseMcpPermissions([{ ...grant, serverId: "../other" }]), /identifier/);
});
