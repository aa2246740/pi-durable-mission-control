import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertCoordinatorExit, normalizeFailure, parseOptions } from "../acceptance/remote-linux/run.mjs";
import { assertRealSuccess, collectRealEvidence, faultInjectionScript, nodeCredentialShell, parseSecrets, readConfig, readSecrets, realMission, redact, scanEvidence, sha256, validateConfig, writeFrozenAcceptance } from "../acceptance/remote-linux/real.mjs";
import { modelResponseEvidence, modelUsageEvidence } from "../dist/worker.js";

const temporary = (t) => {
  const path = mkdtempSync(join(tmpdir(), "mc-real-unit-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const example = () => readConfig(new URL("../acceptance/remote-linux/real-minimax.json", import.meta.url));
const fakeKey = "unit-only-key=with-space '$()'";

test("real CLI requires a secrets file, defaults to thirty minutes and preserves mock defaults", () => {
  assert.deepEqual(parseOptions([]), { keep: false, timeoutMs: 180000 });
  assert.equal(parseOptions(["--real", "config.json", "--secrets-file", "unit.env"]).timeoutMs, 1800000);
  assert.equal(parseOptions(["--timeout-ms", "123", "--real", "config.json", "--secrets-file", "unit.env", "--discard"]).timeoutMs, 123);
  for (const args of [["--real"], ["--real", "a"], ["--secrets-file", "b"], ["--discard"], ["--real", "a", "--secrets-file", "b", "--discard", "--keep"]]) assert.throws(() => parseOptions(args));
});

test("real config examples retain unknown prices and specified role APIs", () => {
  const mini = example();
  assert.equal(mini.orchestrator.modelId, "MiniMax-M2.5");
  assert.equal(mini.validator.api, "anthropic-messages");
  assert.equal(mini.worker.modelId, "MiniMax-M2.7");
  assert.equal(mini.worker.api, "openai-completions");
  const glm = readConfig(new URL("../acceptance/remote-linux/real-glm.json", import.meta.url));
  for (const profile of Object.values(glm)) {
    assert.equal(profile.modelId, "glm-4.7");
    assert.equal(profile.baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");
    assert.equal(profile.credentialEnv, "ZHIPU_API_KEY");
  }
  for (const profile of [...Object.values(mini), ...Object.values(glm)]) assert.equal(profile.cost, undefined);
});

test("real config rejects invalid fields, credentials, endpoints and rates without echoing input", (t) => {
  const root = temporary(t);
  for (const patch of [{api:"bad"}, {apiKey:fakeKey}, {credentialEnv:"NODE_OPTIONS"}, {credentialEnv:"MC_WORKER_CONFIG"}, {credentialEnv:"KEY=BAD"}, {toolCalling:false}, {reasoning:1}, {maxTokens:0}, {contextWindow:1.2}, {baseUrl:`https://user:${encodeURIComponent(fakeKey)}@example.invalid`}, {baseUrl:"https://example.invalid/?key=unsafe"}, {cost:{input:0,output:0}}, {cost:{input:-1,output:0,cacheRead:0,cacheWrite:0}}]) {
    const config = example();
    Object.assign(config.worker, patch);
    assert.throws(() => validateConfig(config));
    const path = join(root, "bad.json");
    writeFileSync(path, JSON.stringify(config));
    assert.throws(() => readConfig(path), (error) => !error.message.includes(fakeKey));
  }
  assert.throws(() => validateConfig({orchestrator:example().orchestrator}));
});

test("secrets parser reads only referenced names and preserves literal values", () => {
  const values = parseSecrets(`# comment\nUNUSED=ignored\nMINIMAX_CN=${fakeKey}\r\ninvalid unrelated line\nOTHER=ignored\n`, ["MINIMAX_CN", "MINIMAX_CN"]);
  assert.deepEqual(Object.keys(values), ["MINIMAX_CN"]);
  assert.equal(values.MINIMAX_CN, fakeKey);
  for (const text of ["OTHER=x", "MINIMAX_CN=", "MINIMAX_CN=x\nMINIMAX_CN=y", "MINIMAX_CN=bad\0value", "MINIMAX_CN=bad\rvalue"]) {
    assert.throws(() => parseSecrets(text, ["MINIMAX_CN"]), (error) => !error.message.includes(text));
  }
});

test("secrets file enforces current owner, exact 0600, regular inode and no symlink", (t) => {
  const root = temporary(t);
  const path = join(root, "unit.env");
  writeFileSync(path, `MINIMAX_CN=${fakeKey}\n`, {mode:0o600});
  assert.equal(readSecrets(path, ["MINIMAX_CN"]).MINIMAX_CN, fakeKey);
  assert.throws(() => readSecrets(path, ["MINIMAX_CN"], process.getuid()+1), /Secrets file rejected/);
  for (const mode of [0o400,0o640,0o644,0o700,0o1600]) {
    chmodSync(path, mode);
    assert.throws(() => readSecrets(path, ["MINIMAX_CN"]), /Secrets file rejected/);
  }
  chmodSync(path, 0o600);
  const link = join(root, "link.env");
  symlinkSync(path, link);
  assert.throws(() => readSecrets(link, ["MINIMAX_CN"]), /Secrets file rejected/);
  assert.throws(() => readSecrets(root, ["MINIMAX_CN"]), /Secrets file rejected/);
  const fifo = join(root, "fifo.env");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  chmodSync(fifo, 0o600);
  assert.throws(() => readSecrets(fifo, ["MINIMAX_CN"]), /Secrets file rejected/);
  assert.throws(() => readSecrets(join(root,"missing"), ["MINIMAX_CN"]), /Secrets file rejected/);
});

test("redaction handles overlapping credentials and scanning catches nested binary leaks", (t) => {
  const root = temporary(t);
  const secrets = [fakeKey, "unit-only-key", "another-unit-credential"];
  assert.equal(redact(`${fakeKey} another-unit-credential`, secrets), "[REDACTED] [REDACTED]");
  const nested = join(root,"nested");
  mkdirSync(nested);
  const path = join(nested,"evidence.bin");
  writeFileSync(path, redact(`log=${fakeKey}`,secrets));
  assert.doesNotThrow(() => scanEvidence(root,secrets));
  writeFileSync(path, Buffer.concat([Buffer.from([0,255]),Buffer.from(fakeKey)]));
  assert.throws(() => scanEvidence(root,secrets), (error) => error.message === "Credential found in evidence directory");
  const escapedKey = 'unit-only-"quoted"\\credential';
  const encoded = JSON.stringify({key:escapedKey});
  assert.deepEqual(JSON.parse(redact(encoded,[escapedKey])),{key:"[REDACTED]"});
  writeFileSync(path,encoded);
  assert.throws(() => scanEvidence(root,[escapedKey]), /Credential found in evidence directory/);
  writeFileSync(path,redact(encoded,[escapedKey]));
  assert.doesNotThrow(() => scanEvidence(root,[escapedKey]));
});

test("node credential stdin shell preserves fake values and exports only explicitly named refs", (t) => {
  const root = temporary(t);
  const node = join(root,"node");
  writeFileSync(node, `#!/bin/sh\nprintf '%s\\n' "$MC_ACCEPTANCE_NODE_TOKEN" "$UNIT_MODEL" "$UNSET_MODEL" "$@"\n`, {mode:0o700});
  const result = spawnSync("/bin/sh", ["-c",nodeCredentialShell,"acceptance","123","machine","UNIT_MODEL"], {
    env:{PATH:root},input:`unit-node-token\n${fakeKey}\n`,encoding:"utf8"
  });
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(result.stdout.split("\n"), ["unit-node-token",fakeKey,"","/app/bootstrap.mjs","123","machine","UNIT_MODEL",""]);
  const incomplete = spawnSync("/bin/sh", ["-c",nodeCredentialShell,"acceptance","123","machine","UNIT_MODEL"], {env:{PATH:root},input:"unit-node-token\n",encoding:"utf8"});
  assert.equal(incomplete.status,1);
  assert.equal(incomplete.stdout,"");
});

const goodTotals = `export function totalCents(lines) {
  let total = 0;
  for (const {quantity,unitPriceCents} of lines) {
    if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(unitPriceCents) || quantity < 0 || unitPriceCents < 0) throw new Error('invalid');
    const amount = quantity * unitPriceCents;
    total += amount;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total)) throw new Error('overflow');
  }
  return total;
}\n`;

test("four frozen host tests pass detached totals after source fault and reject faulty implementations", (t) => {
  const root = temporary(t);
  const frozen = writeFrozenAcceptance(root);
  assert.equal(statSync(frozen.path).mode & 0o777,0o400);
  assert.equal(sha256(readFileSync(frozen.path)),frozen.sha256);
  const live = join(root,"live"), snapshot = join(root,"snapshot");
  mkdirSync(live); mkdirSync(snapshot);
  const source = join(live,"totals.mjs"), cas = join(snapshot,"totals.mjs");
  writeFileSync(source,goodTotals); copyFileSync(source,cas); chmodSync(cas,0o400);
  const before = sha256(readFileSync(cas));
  const mutation = JSON.parse(execFileSync(process.execPath,["-e",faultInjectionScript,source],{encoding:"utf8"}));
  assert.equal(mutation.beforeSha256,before);
  assert.notEqual(mutation.afterSha256,before);
  assert.equal(readFileSync(source,"utf8"),'throw new Error("mutated after publish");\n');
  assert.equal(sha256(readFileSync(cas)),before);
  const accepted = spawnSync(process.execPath,["--test","--test-reporter=tap",frozen.path],{cwd:snapshot,encoding:"utf8",env:{PATH:process.env.PATH}});
  assert.equal(accepted.status,0,accepted.stdout+accepted.stderr);
  assert.match(accepted.stdout,/# tests 4/);
  assert.match(accepted.stdout,/# pass 4/);
  const corrupted = spawnSync(process.execPath,["--test","--test-reporter=tap",frozen.path],{cwd:live,encoding:"utf8",env:{PATH:process.env.PATH}});
  assert.equal(corrupted.status,1);
  for (const faulty of ["export const totalCents = () => 0;", "export const totalCents = lines => lines.reduce((sum,line)=>sum+line.quantity*line.unitPriceCents,0);"]) {
    writeFileSync(source,faulty);
    assert.equal(spawnSync(process.execPath,["--test","--test-reporter=tap",frozen.path],{cwd:live,encoding:"utf8",env:{PATH:process.env.PATH}}).status,1);
  }
});

test("real mission binds one remote workspace and explicit business contract with sixty turns", () => {
  const mission = realMission({acceptanceCommand:"node --test /host/frozen",localWorkspaceId:"local",remoteWorkspaceId:"linux",roleIds:["o","w","v"]});
  assert.deepEqual(mission.remoteWorkspaceIds,["linux"]);
  assert.equal(mission.maxTurns,60);
  assert.equal(mission.workspaceStrategy,"shared");
  assert.equal(mission.autonomy,"trusted");
  assert.match(mission.goal,/nonnegative safe integers/);
  assert.match(mission.assertions[0].description,/nonnegative safe integers/);
  assert.match(mission.acceptance,/node --test \/host\/frozen/);
});

const usage = {input:11,output:7,cacheRead:3,cacheWrite:2,totalTokens:23,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
test("worker evidence includes tool names and token counters without reasoning, arguments or unknown cost", () => {
  const response = modelResponseEvidence({role:"assistant",model:"unit-model",content:[{type:"thinking",thinking:fakeKey},{type:"toolCall",name:"PublishArtifact",arguments:{secret:fakeKey}},{type:"toolCall",name:"Report",arguments:{}}]});
  assert.deepEqual(response,{modelId:"unit-model",tools:["PublishArtifact","Report"]});
  assert.equal(JSON.stringify(response).includes(fakeKey),false);
  assert.equal(modelResponseEvidence({role:"user",content:"text"}),undefined);
  assert.deepEqual(modelUsageEvidence({models:{one:usage,two:usage},tools:{bash:usage}}),{input:22,output:14,cacheRead:6,cacheWrite:4,totalTokens:46});
});

test("export evidence counts admitted calls including auxiliary requests and orders model tools", () => {
  const exported = {mission:{status:"blocked",turns:3,maxTurns:60,costKnown:false,cost:0}, agents:[{id:"o",kind:"orchestrator"},{id:"w",kind:"worker"}],
    generationAdmissions:[{agent_id:"o"},{agent_id:"o",generation_id:"auxiliary:unit"},{agent_id:"w"}],
    transcripts:[{agentId:"o",entries:[{id:"o:model",role:"model",text:JSON.stringify({tools:["SpawnAgent","CreateTask"]}),createdAt:"2026-10-14T00:00:00.001Z"},{role:"model_usage",text:JSON.stringify({input:11,output:7,cacheRead:3,cacheWrite:2,totalTokens:23})}]},
      {agentId:"w",entries:[{id:"w:model",role:"model",text:JSON.stringify({tools:["GetMissionState"]}),createdAt:"2026-10-14T00:00:00.002Z"}]}], artifacts:[],validationReceipts:[],blockers:[{kind:"user_input"}]};
  const result = collectRealEvidence(exported,undefined,{sha256:"unit"});
  assert.equal(result.roles.orchestrator.modelCalls,2);
  assert.equal(result.roles.orchestrator.modelResponses,1);
  assert.equal(result.roles.worker.modelCalls,1);
  assert.equal(result.roles.worker.usage,null);
  assert.equal(result.roles.validator.modelCalls,0);
  assert.deepEqual(result.roles.orchestrator.usage,{input:11,output:7,cacheRead:3,cacheWrite:2,totalTokens:23});
  assert.deepEqual(result.tools.map((tool)=>tool.name),["SpawnAgent","CreateTask","GetMissionState"]);
  assert.equal(result.cost,null);
  assert.deepEqual(result.blockers,[{kind:"user_input"}]);
});

test("real success gate rejects absent injection, changed CAS, wrong receipts and premature validation", () => {
  const digest = "a".repeat(64);
  const detail = {mission:{status:"completed"},tasks:[{status:"accepted"}],blockers:[],artifacts:[{id:"a",sha256:digest,agentId:"w",remoteProvenance:{machineId:"linux"}}],
    agents:[{id:"w",kind:"worker",machineId:"linux"},{id:"v",kind:"validator",machineId:"local"}],
    validationReceipts:[{validatorId:"v",command:"unit-command",artifactIds:["a"],artifactDigests:{a:digest},exitCode:0,snapshotIntegrity:true,workspaceKind:"remote-snapshot",stdout:"# tests 4\n# pass 4\n# fail 0",createdAt:"2026-10-14T00:00:02Z"}]};
  const evidence = {tools:[],mutation:{artifactId:"a",beforeSha256:digest,afterSha256:"b".repeat(64),casBeforeSha256:digest,casAfterSha256:digest,casFinalSha256:digest,completedAt:"2026-10-14T00:00:01Z"}};
  assert.doesNotThrow(()=>assertRealSuccess(detail,evidence,"unit-command","linux"));
  for (const patch of [{mutation:undefined},{mutation:{...evidence.mutation,casAfterSha256:"bad"}},{mutation:{...evidence.mutation,completedAt:"2026-10-14T00:00:03Z"}},{tools:[{name:"RequestUserInput"}]}]) assert.throws(()=>assertRealSuccess(detail,{...evidence,...patch},"unit-command","linux"));
  assert.throws(()=>assertRealSuccess({...detail,validationReceipts:[{...detail.validationReceipts[0],exitCode:1}]},evidence,"unit-command","linux"));
});

test("deadline timeout normalization preserves interruption and earlier command errors", () => {
  const native = new Error("The operation was aborted due to timeout");
  const interrupted = new Error("Interrupted by SIGINT");
  const clock = {deadline:100,timeoutMs:2000,now:100};
  assert.equal(normalizeFailure(native,clock).message,"Acceptance timed out after 2000 ms");
  assert.equal(normalizeFailure(native,{...clock,aborted:interrupted}),interrupted);
  assert.equal(normalizeFailure(native,{...clock,now:99}),native);
});

test("cold coordinator SIGTERM confirms process exit while ready coordinators require graceful exit", () => {
  const stopped = spawnSync(process.execPath,["-e","process.kill(process.pid, 'SIGTERM')"],{env:{PATH:process.env.PATH}});
  assert.equal(stopped.signal,"SIGTERM");
  assert.doesNotThrow(() => assertCoordinatorExit(stopped.signal,false));
  assert.throws(() => assertCoordinatorExit(stopped.signal,true),/forced shutdown/);
  const forced = spawnSync(process.execPath,["-e","process.kill(process.pid, 'SIGKILL')"],{env:{PATH:process.env.PATH}});
  assert.equal(forced.signal,"SIGKILL");
  for (const ready of [true,false]) assert.throws(() => assertCoordinatorExit(forced.signal,ready),/forced shutdown/);
  assert.doesNotThrow(() => assertCoordinatorExit(null,true));
});
