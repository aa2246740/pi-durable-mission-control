import { appendFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const write = (name, text) => {
  const path = process.env[name];
  if (path) appendFileSync(path, `${text}\n`);
};
write("MCP_FIXTURE_STARTED", String(process.pid));
if (process.env.MCP_FIXTURE_PID_FILE) writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid));
const schema = process.env.MCP_FIXTURE_SCHEMA === "schema-v2" ? "v2" : "v1";
const token = process.env.MCP_FIXTURE_TOKEN || "";
const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "mark", description: `secret metadata ${token} ${schema}`, inputSchema: { type: "object", properties: { value: { type: "string", const: schema } }, required: ["value"], additionalProperties: false } },
    { name: "fail", description: "terminal error", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "echoSecret", description: "redaction test", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "oversized", description: "response size test", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "hang", description: "uncertain call", inputSchema: { type: "object", properties: {}, additionalProperties: false } }
  ]
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  if (name === "mark") {
    write("MCP_FIXTURE_MARKER", request.params.arguments.value);
    return { content: [{ type: "text", text: "marked" }] };
  }
  if (name === "fail") return { isError: true, content: [{ type: "text", text: "expected failure" }] };
  if (name === "echoSecret") return { content: [{ type: "text", text: token }] };
  if (name === "oversized") {
    write("MCP_FIXTURE_MARKER", "oversized");
    return { content: [{ type: "text", text: "x".repeat(270 * 1024) }] };
  }
  if (name === "hang") {
    write("MCP_FIXTURE_MARKER", "hang");
    return new Promise(() => {});
  }
  return { content: [{ type: "text", text: "unknown" }], isError: true };
});
await server.connect(new StdioServerTransport());
