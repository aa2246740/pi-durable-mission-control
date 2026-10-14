import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRuntimeProvider } from "../../dist/worker.js";
import { kinds, readConfig, readSecrets, redact } from "./real.mjs";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const containerCLI = "/opt/homebrew/bin/container";
const probeMaxTokens = 64;
const defaultTimeoutMs = 20000;
const containerStartupMs = 30000;

export function containerPrefix() {
  const prefix = process.env.MC_ACCEPTANCE_CONTAINER_PREFIX ?? "mc-acc-i2-grok-";
  if (!/^mc-acc-[a-z0-9-]*$/.test(prefix)) throw new Error("MC_ACCEPTANCE_CONTAINER_PREFIX must start with mc-acc- and use lowercase letters, digits and hyphens");
  return prefix;
}

export function parseOptions(args) {
  const options = { fromContainer: false, timeoutMs: defaultTimeoutMs, maxTokens: probeMaxTokens };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--from-container") options.fromContainer = true;
    else if (arg === "--real" && args[index + 1]) options.configPath = args[++index];
    else if (arg === "--secrets-file" && args[index + 1]) options.secretsFile = args[++index];
    else if (arg === "--timeout-ms" && args[index + 1]) {
      options.timeoutMs = Number(args[++index]);
      if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
    } else throw new Error(`Unknown or incomplete option ${arg}`);
  }
  if (!options.configPath || !options.secretsFile) throw new Error("--real and --secrets-file are required");
  return options;
}

const combinationKey = (profile) => JSON.stringify([profile.api, profile.baseUrl, profile.modelId, profile.credentialEnv]);

export function uniqueTargets(config) {
  const targets = [];
  for (const role of kinds) {
    const profile = config[role];
    const key = combinationKey(profile);
    const existing = targets.find((target) => target.key === key);
    if (existing) existing.roles.push(role);
    else targets.push({ key, roles: [role], profile });
  }
  return targets;
}

export function toolChoiceFor(api) {
  if (api === "anthropic-messages") return { type: "tool", name: "ping" };
  if (api === "openai-responses") return { type: "function", name: "ping" };
  return { type: "function", function: { name: "ping" } };
}

export function classifyProbe({ httpStatus, error, httpOk, toolCalled }) {
  if (httpOk && toolCalled) return null;
  const text = error ?? "";
  if (httpStatus === 401 || httpStatus === 403 || /\b401\b|\b403\b|unauthorized|authentication|invalid[_ ]api[_ ]key|permission denied/i.test(text)) return "auth";
  if (/timeout|timed out|aborted|ETIMEDOUT|AbortError/i.test(text)) return "timeout";
  if (Number.isInteger(httpStatus) && httpStatus >= 400) return "http";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|ECONNRESET|getaddrinfo|network/i.test(text)) return "network";
  if (httpOk && !toolCalled) return "no-tool-call";
  if (!Number.isInteger(httpStatus)) return "network";
  return "provider";
}

function clip(text) {
  if (text == null) return null;
  const value = String(text);
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function redactValue(value, secrets) {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = redactValue(item, secrets);
    return copy;
  }
  return value;
}

export function publishReport(report, secrets) {
  return redact(JSON.stringify(redactValue(report, secrets)), secrets);
}

function usageOf(message) {
  const usage = message?.usage;
  if (!usage || !["stop", "length", "toolUse"].includes(message.stopReason)) return null;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens
  };
}

function statusOf(error) {
  return typeof error?.status === "number" ? error.status : undefined;
}

export async function probeOnce({ profile, credential, timeoutMs = defaultTimeoutMs, maxTokens = probeMaxTokens }) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Preflight timed out after ${timeoutMs} ms`)), timeoutMs);
  timer.unref?.();
  let httpStatus;
  let errorBody = "";
  let message;
  let thrown;
  try {
    const models = createModels({
      authContext: {
        env: async (name) => name === profile.credentialEnv && credential ? credential : undefined,
        fileExists: async () => false
      }
    });
    // Reasoning stays off so the cheap tool probe does not send provider thinking fields.
    const provider = createRuntimeProvider({
      id: "preflight",
      revision: 0,
      name: profile.name,
      api: profile.api,
      modelId: profile.modelId,
      baseUrl: profile.baseUrl,
      credentialEnv: profile.credentialEnv,
      contextWindow: profile.contextWindow,
      maxTokens,
      reasoning: false,
      toolCalling: true,
      vision: false
    });
    models.setProvider(provider);
    const [model] = provider.getModels();
    message = await models.completeSimple(model, {
      systemPrompt: "Call the ping tool once. Do not answer with prose.",
      messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
      tools: [{
        name: "ping",
        description: "Confirm this endpoint accepts a tool call.",
        parameters: Type.Object({}, { additionalProperties: false })
      }]
    }, {
      maxTokens,
      timeoutMs,
      maxRetries: 0,
      maxRetryDelayMs: 0,
      cacheRetention: "none",
      signal: controller.signal,
      toolChoice: toolChoiceFor(profile.api),
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init);
        httpStatus ??= response.status;
        if (!response.ok) {
          try { errorBody = (await response.clone().text()).slice(0, 8000); } catch { /* The provider still reads the original body. */ }
        }
        return response;
      },
      onResponse: (response) => { httpStatus ??= response.status; }
    });
  } catch (error) {
    thrown = error;
    httpStatus ??= statusOf(error);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - started));
  const providerError = message?.stopReason === "error" || message?.stopReason === "aborted"
    ? (message.errorMessage || message.stopReason)
    : thrown ? (thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)) : null;
  const combined = [providerError, errorBody].filter((item) => item).join("\n");
  const httpOk = Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus < 300;
  const toolCalled = message?.content?.some((block) => block.type === "toolCall" && block.name === "ping") === true;
  const error = !httpOk || !toolCalled
    ? combined || (httpOk ? "Model response did not call the ping tool" : "Preflight request failed")
    : null;
  return {
    httpOk,
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    latencyMs,
    toolCalled,
    usage: usageOf(message),
    errorCategory: classifyProbe({ httpStatus, error, httpOk, toolCalled }),
    error: clip(error)
  };
}

export function containerArgs({ name, image }) {
  const mount = (file, target) => ["-v", `${file}:${target}:ro`];
  return ["run", "--rm", "-i", "--name", name, "--arch", "arm64", "--cpus", "1", "--memory", "512M",
    ...mount(join(root, "dist"), "/app/dist"),
    ...mount(realpathSync(join(root, "node_modules")), "/app/node_modules"),
    ...mount(fileURLToPath(new URL("./preflight.mjs", import.meta.url)), "/app/acceptance/remote-linux/preflight.mjs"),
    ...mount(fileURLToPath(new URL("./real.mjs", import.meta.url)), "/app/acceptance/remote-linux/real.mjs"),
    ...mount(fileURLToPath(new URL("./mock.mjs", import.meta.url)), "/app/acceptance/remote-linux/mock.mjs"),
    image, "node", "/app/acceptance/remote-linux/preflight.mjs", "--container-probe"];
}

export function containerEnv() {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp" };
}

export function containerStdin({ profile, credential, timeoutMs, maxTokens }) {
  return `${JSON.stringify({
    profile: {
      name: profile.name,
      api: profile.api,
      modelId: profile.modelId,
      baseUrl: profile.baseUrl,
      credentialEnv: profile.credentialEnv,
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
      reasoning: profile.reasoning,
      toolCalling: profile.toolCalling,
      vision: profile.vision
    },
    credential,
    timeoutMs,
    maxTokens
  })}\n`;
}

function failedProbe(errorCategory, error) {
  return { httpOk: false, httpStatus: null, latencyMs: null, toolCalled: false, usage: null, errorCategory, error: clip(error) };
}

async function commandOutput(args) {
  const child = spawn(containerCLI, args, { env: containerEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `container ${args[0]} failed`);
  return stdout;
}

async function defaultContainerRun({ profile, credential, timeoutMs, maxTokens }) {
  const prefix = containerPrefix();
  const listed = (await commandOutput(["list", "--all", "--quiet"])).trim().split(/\s+/).filter((name) => name.startsWith(prefix));
  if (listed.length > 0) throw new Error(`Existing ${prefix} containers require their owner's cleanup`);
  const images = JSON.parse(await commandOutput(["image", "list", "--format", "json"]));
  const image = images.find((item) => /^(docker\.io\/library\/)?node:22-bookworm-slim$/.test(item.configuration?.name));
  if (!image?.variants?.some((variant) => variant.platform?.architecture === "arm64" && variant.platform?.os === "linux")) {
    throw new Error("Required cached node:22-bookworm-slim arm64 image missing; pulling is forbidden");
  }
  const name = `${prefix}${randomUUID().slice(0, 12)}`;
  const args = containerArgs({ name, image: image.configuration.name });
  const stdin = containerStdin({ profile, credential, timeoutMs, maxTokens });
  if (args.join("\n").includes(credential) || Object.values(containerEnv()).some((value) => value.includes(credential))) {
    throw new Error("Refusing to place a credential in container arguments or environment");
  }
  return runProbeProcess(containerCLI, args, stdin, credential, timeoutMs + containerStartupMs);
}

function runProbeProcess(command, args, stdin, credential, deadlineMs) {
  const child = spawn(command, args, { env: containerEnv(), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-1024 * 1024); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-1024 * 1024); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, deadlineMs);
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin);
  return new Promise((resolve) => {
    const finish = (error) => {
      clearTimeout(timer);
      const secrets = credential ? [credential] : [];
      const safeOut = redact(stdout, secrets);
      const safeErr = redact(stderr, secrets);
      if (error || timedOut) {
        resolve(failedProbe(timedOut ? "timeout" : "container", error?.message || safeErr || "Container probe failed"));
        return;
      }
      try { resolve(JSON.parse(safeOut.trim())); }
      catch { resolve(failedProbe("container", safeErr || safeOut || "Container probe returned no JSON")); }
    };
    child.on("error", finish);
    child.on("close", (code) => finish(code === 0 ? undefined : new Error(`Container probe exited ${code}`)));
  });
}

export async function runPreflight(options) {
  const secrets = [];
  const fail = (error) => ({ pass: false, error: clip(redact(error, secrets)), checks: [] });
  let config;
  try { config = readConfig(options.configPath); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  let credentials;
  try { credentials = readSecrets(options.secretsFile, kinds.map((role) => config[role].credentialEnv), options.uid); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  secrets.push(...Object.values(credentials));
  const checks = [];
  for (const target of uniqueTargets(config)) {
    const transport = options.fromContainer && target.roles.includes("worker") ? "container" : "host";
    const credential = credentials[target.profile.credentialEnv];
    let result;
    try {
      if (transport === "host") result = await probeOnce({ profile: target.profile, credential, timeoutMs: options.timeoutMs, maxTokens: options.maxTokens });
      else if (options.containerRun) {
        result = await options.containerRun({
          args: containerArgs({ name: `${containerPrefix()}preview`, image: "node:22-bookworm-slim" }),
          env: containerEnv(),
          stdin: containerStdin({ profile: target.profile, credential, timeoutMs: options.timeoutMs, maxTokens: options.maxTokens })
        });
      } else result = await defaultContainerRun({ profile: target.profile, credential, timeoutMs: options.timeoutMs, maxTokens: options.maxTokens });
    } catch (error) {
      result = failedProbe(transport === "container" ? "container" : "provider", error instanceof Error ? error.message : String(error));
    }
    checks.push({
      roles: target.roles,
      api: target.profile.api,
      modelId: target.profile.modelId,
      baseUrl: target.profile.baseUrl,
      credentialEnv: target.profile.credentialEnv,
      transport,
      httpOk: result.httpOk === true,
      httpStatus: Number.isInteger(result.httpStatus) ? result.httpStatus : null,
      latencyMs: Number.isFinite(result.latencyMs) ? Math.max(0, Math.round(result.latencyMs)) : null,
      toolCalled: result.toolCalled === true,
      usage: result.usage ?? null,
      errorCategory: result.errorCategory ?? null,
      error: clip(result.error ?? null)
    });
  }
  const report = { pass: checks.length > 0 && checks.every((check) => check.httpOk && check.toolCalled && check.errorCategory == null), checks };
  return JSON.parse(publishReport(report, secrets));
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function containerProbeMain() {
  let credential = "";
  const emit = (result) => {
    process.stdout.write(`${publishReport(result, credential ? [credential] : [])}\n`);
  };
  try {
    const payload = JSON.parse(await readStdin());
    credential = typeof payload.credential === "string" ? payload.credential : "";
    emit(await probeOnce({
      profile: payload.profile,
      credential,
      timeoutMs: payload.timeoutMs,
      maxTokens: payload.maxTokens
    }));
  } catch (error) {
    emit(failedProbe("container", error instanceof Error ? error.message : String(error)));
  }
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseOptions(args); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ pass: false, error: error.message, checks: [] })}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const report = await runPreflight(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.pass) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ pass: false, error: "Preflight failed", checks: [] })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entry = process.argv[2] === "--container-probe" ? containerProbeMain() : main();
  entry.catch(() => {
    process.stdout.write(`${JSON.stringify({ pass: false, error: "Preflight failed", checks: [] })}\n`);
    process.exitCode = 1;
  });
}
