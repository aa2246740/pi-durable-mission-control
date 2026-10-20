#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  callMissionTool,
  MISSION_TOOLS,
  resolveCanonicalToolName,
  startStdioMcpServer
} from "./mcp-server.mjs";

/**
 * Parse command-line arguments for `t3-mission/bridge/cli.mjs`.
 *
 * Supported invocation:
 *   `node t3-mission/bridge/cli.mjs <command> --mission-dir <dir> [--json <payload>]`
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @returns {{
 *   command: string,
 *   missionDir: string,
 *   payload: Record<string, unknown>,
 *   help: boolean
 * }}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? [...argv] : [];
  let command = "";
  let missionDir = "";
  let rawJson = "";
  let help = false;
  const extraFlags = {};

  for (let i = 0; i < args.length; i++) {
    const token = String(args[i]);

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    if (token === "--mission-dir" || token === "--dir" || token === "-d") {
      missionDir = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--mission-dir=")) {
      missionDir = token.slice("--mission-dir=".length).trim();
      continue;
    }
    if (token.startsWith("--dir=")) {
      missionDir = token.slice("--dir=".length).trim();
      continue;
    }

    if (token === "--json" || token === "-j") {
      rawJson = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--json=")) {
      rawJson = token.slice("--json=".length).trim();
      continue;
    }

    if (token === "--repo-path") {
      extraFlags.repoPath = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--repo-path=")) {
      extraFlags.repoPath = token.slice("--repo-path=".length).trim();
      continue;
    }

    if (token === "--worktree-path") {
      extraFlags.worktreePath = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--worktree-path=")) {
      extraFlags.worktreePath = token.slice("--worktree-path=".length).trim();
      continue;
    }

    if (token === "--feature-id") {
      extraFlags.featureId = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--feature-id=")) {
      extraFlags.featureId = token.slice("--feature-id=".length).trim();
      continue;
    }

    if (token === "--run-id") {
      extraFlags.runId = String(args[++i] ?? "").trim();
      continue;
    }
    if (token.startsWith("--run-id=")) {
      extraFlags.runId = token.slice("--run-id=".length).trim();
      continue;
    }

    if (!token.startsWith("-") && !command) {
      command = token.trim();
      continue;
    }
  }

  let parsedJson = {};
  if (rawJson) {
    try {
      const candidate = JSON.parse(rawJson);
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("--json payload must be a JSON object");
      }
      parsedJson = candidate;
    } catch (error) {
      throw new Error(
        `Invalid --json payload: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const resolvedMissionDir =
    missionDir ||
    (typeof parsedJson.missionDir === "string" ? parsedJson.missionDir : "") ||
    process.cwd();

  const payload = {
    ...parsedJson,
    ...extraFlags,
    missionDir: resolvedMissionDir
  };

  return {
    command,
    missionDir: resolvedMissionDir,
    payload,
    help
  };
}

/**
 * Execute a CLI command against the Mission Bridge / Kernel (`VAL-BRIDGE-003`).
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {Record<string, unknown>} [context={}]
 * @returns {Promise<{ exitCode: number, result?: any, error?: string }>}
 */
export async function runCli(argv = process.argv.slice(2), context = {}) {
  const stdout = context.stdout ?? process.stdout;
  const stderr = context.stderr ?? process.stderr;

  try {
    const { command, missionDir, payload, help } = parseCliArgs(argv);

    if (help || !command) {
      const usage = {
        usage: "node t3-mission/bridge/cli.mjs <command> --mission-dir <dir> [--json <payload>]",
        commands: MISSION_TOOLS.map((t) => t.name)
      };
      stdout.write(`${JSON.stringify(usage, null, 2)}\n`);
      return { exitCode: help ? 0 : 1, result: usage };
    }

    const normalizedCmd = command.toLowerCase();
    if (normalizedCmd === "mcp" || normalizedCmd === "serve" || normalizedCmd === "stdio") {
      startStdioMcpServer(context);
      return { exitCode: 0, result: { mode: "stdio" } };
    }

    if (
      normalizedCmd === "tools/list" ||
      normalizedCmd === "list-tools" ||
      normalizedCmd === "tools"
    ) {
      const listResult = { tools: MISSION_TOOLS };
      stdout.write(`${JSON.stringify(listResult, null, 2)}\n`);
      return { exitCode: 0, result: listResult };
    }

    const canonicalTool = resolveCanonicalToolName(command);
    if (!canonicalTool) {
      const message = `Unknown command "${command}". Available commands: ${MISSION_TOOLS.map((t) => t.name).join(", ")}`;
      stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      return { exitCode: 1, error: message };
    }

    const result = await callMissionTool(canonicalTool, payload, {
      ...context,
      missionDir
    });

    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return { exitCode: 0, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error
        ? /** @type {any} */ (error).code
        : "CLI_ERROR";
    stderr.write(`${JSON.stringify({ ok: false, code, error: message })}\n`);
    return { exitCode: 1, error: message };
  }
}

function resolveRealOrAbs(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function isExecutedAsMain(metaUrl, argv1 = process.argv[1]) {
  return Boolean(
    argv1 && resolveRealOrAbs(argv1) === resolveRealOrAbs(fileURLToPath(metaUrl))
  );
}

const isMainModule = isExecutedAsMain(import.meta.url);

if (isMainModule) {
  runCli(process.argv.slice(2)).then(({ exitCode }) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}

export default {
  parseCliArgs,
  runCli,
  isExecutedAsMain
};
