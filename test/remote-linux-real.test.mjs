import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertCoordinatorExit, commandOutput, finalizeEvidence, normalizeFailure, parseOptions } from "../acceptance/remote-linux/run.mjs";
import { assertRealSuccess, collectRealEvidence, faultInjectionScript, nodeCredentialShell, parseSecrets, readConfig, readSecrets, realMission, redact, scanEvidence, sha256, validateConfig, writeFrozenAcceptance, frozenAcceptanceCommand, checkFrozenAcceptance, touchedOracle, oracleTouches } from "../acceptance/remote-linux/real.mjs";
import { readSessionEvidence, refreshStoppedExport, remoteSessionScript } from "../acceptance/remote-linux/session-evidence.mjs";
import { ControlPlane } from "../dist/control.js";
import { shellQuote } from "../acceptance/remote-linux/mock.mjs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

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
  const text = JSON.stringify(mission);
  for (const forbidden of ["move the task", "Assign distinct", "human intervention", "corrupt", "republish", "existing mission state", "CompleteMission", "RunValidation", "review"]) assert.equal(text.includes(forbidden),false);
});

test("stopped pi-durable SQLite evidence retains assistant tool order and cumulative model usage", async (t) => {
  const directory = temporary(t);
  const path = join(directory, "session.sqlite");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([{type:"thinking",thinking:fakeKey}, fauxToolCall("Probe",{secret:fakeKey})], {stopReason:"toolUse"}),
    fauxAssistantMessage([{type:"text",text:"completed"},fauxToolCall("Finish",{})], {stopReason:"toolUse"})
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry();
  const extension = defineExtension({name:"unit-evidence-tools",tools:[
    defineTool({name:"Probe",description:"Unit probe",parameters:Type.Object({secret:Type.String()}),execute:async()=>({content:[{type:"text",text:"probe"}],usage:{input:9999,output:9999,cacheRead:0,cacheWrite:0,totalTokens:19998,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}})}),
    defineTool({name:"Finish",description:"Unit finish",parameters:Type.Object({}),execute:async()=>({content:[{type:"text",text:"done"}],control:{terminate:true}})})
  ]});
  registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(path), {models,registry}, BACKGROUND_CONTEXT);
  let expected;
  try {
    const root = await harness.root(BACKGROUND_CONTEXT, {agent:{model:{provider:"faux",modelId:"faux-1"},extensions:[extension],tools:extension.tools}});
    const submitted = await root.submit({type:"input",content:"Exercise two tools"},BACKGROUND_CONTEXT);
    assert.equal((await submitted.wait(BACKGROUND_CONTEXT)).status,"done");
    await root.waitForIdle(BACKGROUND_CONTEXT);
    expected = (await harness.usage(BACKGROUND_CONTEXT)).models["faux/faux-1"];
    assert.equal(faux.state.callCount,2);
  } finally { await harness.close(BACKGROUND_CONTEXT); }
  const before = sha256(readFileSync(path));
  chmodSync(path,0o400);
  const session = readSessionEvidence(path);
  assert.equal(session.complete,true);
  assert.equal(session.modelCalls,2);
  assert.deepEqual(session.tools.map((tool)=>tool.name),["Probe","Finish"]);
  assert.ok(session.tools[0].commitSeq < session.tools[1].commitSeq);
  assert.deepEqual(session.usage,Object.fromEntries(["input","output","cacheRead","cacheWrite","totalTokens"].map((key)=>[key,expected[key]])));
  assert.ok(session.usage.totalTokens > 0 && session.usage.totalTokens < 19998);
  assert.equal(JSON.stringify(session).includes(fakeKey),false);
  const remote = JSON.parse(await commandOutput(process.execPath,["-e",remoteSessionScript,path],{PATH:process.env.PATH}));
  assert.deepEqual(remote,session);
  assert.equal(sha256(readFileSync(path)),before,"the read-only query must leave the actual database unchanged");
  const exported = {mission:{status:"blocked",turns:3,maxTurns:60,costKnown:false,cost:0},agents:[{id:"o",kind:"orchestrator",machineId:"local"},{id:"w",kind:"worker",machineId:"linux"}],
    generationAdmissions:[{agent_id:"o"},{agent_id:"o",generation_id:"auxiliary:unit"},{agent_id:"w"}],transcripts:[],artifacts:[],validationReceipts:[],blockers:[{kind:"user_input"}],events:[]};
  const evidence = collectRealEvidence(exported,undefined,{path:"/host/totals.acceptance.test.mjs"},{},[{agentId:"o",...session},{agentId:"w",...readSessionEvidence(join(directory,"missing.sqlite"))}]);
  assert.equal(evidence.roles.orchestrator.modelCalls,2);
  assert.equal(evidence.roles.orchestrator.admittedModelCalls,2);
  assert.deepEqual(evidence.roles.orchestrator.usage,session.usage);
  assert.equal(evidence.roles.worker.modelCalls,null);
  assert.equal(evidence.roles.worker.usage,null);
  assert.equal(evidence.evidenceComplete,false);
  assert.deepEqual(evidence.tools.map((tool)=>tool.name),["Probe","Finish"]);
  assert.equal(evidence.cost,null);
  assert.deepEqual(evidence.blockers,[{kind:"user_input"}]);
  assert.equal(statSync(path).mode & 0o777,0o400);
  assert.equal(readSessionEvidence(join(directory,"missing.sqlite")).complete,false);
  writeFileSync(join(directory,"invalid.sqlite"),"invalid database");
  assert.equal(JSON.parse(await commandOutput(process.execPath,["-e",remoteSessionScript,join(directory,"invalid.sqlite")])).complete,false);
});

test("real success gate rejects absent injection, changed CAS, wrong receipts and oracle touches without guest clock ordering", () => {
  const digest = "a".repeat(64);
  const detail = {mission:{status:"completed"},tasks:[{status:"accepted"}],blockers:[],artifacts:[{id:"a",sha256:digest,agentId:"w",remoteProvenance:{machineId:"linux"}}],
    agents:[{id:"w",kind:"worker",machineId:"linux"},{id:"v",kind:"validator",machineId:"local"}],
    validationReceipts:[{id:"receipt-1",validatorId:"v",command:"unit-command",artifactIds:["a"],artifactDigests:{a:digest},exitCode:0,snapshotIntegrity:true,workspaceKind:"remote-snapshot",stdout:"# tests 4\n# pass 4\n# fail 0",createdAt:"2026-10-14T00:00:02Z"}]};
  const evidence = {tools:[],oracleTouches:[],acceptance:{checks:[{phase:"publication",intact:true},{phase:"receipt",receiptId:"receipt-1",intact:true}]},mutation:{artifactId:"a",beforeSha256:digest,afterSha256:"b".repeat(64),casBeforeSha256:digest,casAfterSha256:digest,casFinalSha256:digest,completedAt:"2026-10-14T00:00:01Z"}};
  assert.doesNotThrow(()=>assertRealSuccess(detail,evidence,"unit-command","linux"));
  for (const patch of [{mutation:undefined},{mutation:{...evidence.mutation,casAfterSha256:"bad"}},{oracleTouches:[{command:"chmod"}]},{acceptance:{checks:[{phase:"end",intact:false}]}},{tools:[{name:"RequestUserInput"}]}]) assert.throws(()=>assertRealSuccess(detail,{...evidence,...patch},"unit-command","linux"));
  assert.doesNotThrow(()=>assertRealSuccess(detail,{...evidence,mutation:{...evidence.mutation,completedAt:"2026-10-14T00:00:03Z"}},"unit-command","linux"));
  for (const patch of [{exitCode:1},{command:"changed"},{workspaceKind:"local"},{snapshotIntegrity:false},{artifactDigests:{a:"bad"}}]) {
    assert.throws(()=>assertRealSuccess({...detail,validationReceipts:[{...detail.validationReceipts[0],...patch}]},evidence,"unit-command","linux"));
  }
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


test("command JSON parsing uses stdout while successful stderr diagnostics stay separate", async () => {
  const output = await commandOutput(process.execPath,["-e",`process.stderr.write('SQLite warning\\n');console.log(JSON.stringify({beforeSha256:'before',afterSha256:'after'}));`],{PATH:process.env.PATH});
  assert.deepEqual(JSON.parse(output),{beforeSha256:"before",afterSha256:"after"});
  await assert.rejects(()=>commandOutput(process.execPath,["-e","console.error('unit command failure');process.exit(3)"]),/unit command failure/);
});

test("frozen command checks its embedded digest before tests, including paths with shell quotes", (t) => {
  const directory = temporary(t);
  const proof = join(directory,"host 'quoted"); mkdirSync(proof);
  const acceptance = writeFrozenAcceptance(proof);
  const workspace = join(directory,"workspace"); mkdirSync(workspace);
  writeFileSync(join(workspace,"totals.mjs"),goodTotals);
  const command = frozenAcceptanceCommand(acceptance);
  const invoke = () => spawnSync("/bin/sh",["-c",command],{cwd:workspace,encoding:"utf8",env:{PATH:process.env.PATH}});
  const intact = checkFrozenAcceptance(acceptance,"publication");
  assert.equal(intact.intact,true);
  assert.equal(invoke().status,0);
  chmodSync(acceptance.path,0o600);
  writeFileSync(acceptance.path,"console.log('TAMPERED-TEST-RAN');\n");
  const tampered = invoke();
  assert.notEqual(tampered.status,0);
  assert.match(tampered.stderr,/Frozen acceptance hash mismatch/);
  assert.equal(tampered.stdout.includes("TAMPERED-TEST-RAN"),false);
  assert.equal(checkFrozenAcceptance(acceptance,"receipt","r").intact,false);
});

test("oracle audit detects all local shell records and proof-directory mutations", () => {
  const path = "/host/proof/totals.acceptance.test.mjs";
  for (const command of [`cat '${path}'`,"cat totals.acceptance.test.mjs", "chmod -R u+w /host/proof", "chflags nouchg '/host/proof'", "cd /host/proof && printf bad > other", "chmod -R u+w $HOME", "chflags nouchg ${TMPDIR}", "echo x > ~/other"]) assert.equal(touchedOracle(command,path),true,command);
  for (const command of ["node --test totals.unit.test.mjs", "chmod 600 /work/totals.mjs", "ls /host/proof"]) assert.equal(touchedOracle(command,path),false,command);
  const exported = {agents:[{id:"o",machineId:"local"},{id:"v",machineId:"local"},{id:"w",machineId:"linux"}],
    events:[{type:"shell_evidence",agentId:"o",seq:1,data:{command:`chflags nouchg '${path}'`}},{type:"shell_evidence",agentId:"w",seq:2,data:{command:`cat ${path}`}}],
    transcripts:[{agentId:"v",entries:[{id:"t",role:"tool",text:JSON.stringify({command:"chmod -R u+w /host/proof",exitCode:0})},{role:"tool",text:"plain tool result"},{role:"assistant",text:JSON.stringify({command:`cat ${path}`})}]}]};
  assert.deepEqual(oracleTouches(exported,path).map((record)=>record.agentId),["o","v"]);
});

test("final evidence scan runs after summary and every late file and fails the run on leakage", (t) => {
  const directory = temporary(t);
  const summary = {status:"passed",cleanupVerified:true};
  const save = (name,value) => writeFileSync(join(directory,name),JSON.stringify(value));
  finalizeEvidence(directory,[fakeKey],summary,save);
  assert.equal(JSON.parse(readFileSync(join(directory,"summary.json"))).status,"passed");
  const lateSave = (name,value) => { save(name,value); writeFileSync(join(directory,"late.bin"),fakeKey); };
  assert.throws(()=>finalizeEvidence(directory,[fakeKey],summary,lateSave),/Credential found/);
  assert.equal(summary.status,"failed");
  assert.equal(JSON.parse(readFileSync(join(directory,"summary.json"))).cleanupVerified,false);
  rmSync(join(directory,"late.bin"));
  assert.throws(()=>finalizeEvidence(directory,[fakeKey],{status:"passed",secret:fakeKey},save),/Credential found/);
});


test("stopped export reads the product's actual late shell events and tool transcript", async (t) => {
  const directory = temporary(t);
  const acceptance = writeFrozenAcceptance(directory);
  const state = join(directory,"state"), workspace = join(directory,"workspace"); mkdirSync(workspace);
  const control = new ControlPlane(state);
  let before;
  try {
    control.upsertProfile({...example().worker,id:"unit",credentialEnv:"",baseUrl:"http://127.0.0.1:9999"});
    for (const kind of ["orchestrator","worker","validator"]) control.upsertRole({id:kind,name:kind,kind,instructions:"Unit",profileId:"unit"});
    const mission = control.createMission({title:"Unit",goal:"Unit",acceptance:"Unit",workspaceId:control.addWorkspace("unit",workspace).id,roleIds:["orchestrator","worker","validator"],maxTurns:10,maxCost:0,autonomy:"trusted"});
    control.missionAction(mission.id,"start");
    const [agent] = control.listAgents(mission.id);
    before = control.exportMission(mission.id);
    const command = `chmod 600 ${shellQuote(acceptance.path)}; chmod 400 ${shellQuote(acceptance.path)}`;
    const receipt = await control.workerCommand({id:"oracle-unit",token:"internal",agentId:agent.id,epoch:agent.epoch,method:"bash",args:{command},taskId:"oracle-unit"});
    assert.equal(receipt.exitCode,0);
    assert.equal(checkFrozenAcceptance(acceptance,"end").intact,true,"restore hides the touch from a final hash check");
    assert.deepEqual(oracleTouches(before,acceptance.path),[]);
  } finally { control.close(); }
  const refreshed = refreshStoppedExport(join(state,"control.sqlite"),before);
  assert.deepEqual(oracleTouches(refreshed,acceptance.path).map((record)=>record.source),["shell_evidence","tool transcript"]);
});


test("secrets rejections distinguish metadata, missing references and format without values", (t) => {
  const directory = temporary(t), path = join(directory,"unit.env");
  writeFileSync(path,`MINIMAX_CN=${fakeKey}\n`,{mode:0o600});
  chmodSync(path,0o644);
  assert.throws(()=>readSecrets(path,["MINIMAX_CN"]),/Secrets file rejected: owner, type or permissions/);
  chmodSync(path,0o600);
  assert.throws(()=>readSecrets(path,["MISSING"]),/Secrets file rejected: missing referenced credential/);
  writeFileSync(path,`MINIMAX_CN=${fakeKey}\nMINIMAX_CN=${fakeKey}\n`);
  assert.throws(()=>readSecrets(path,["MINIMAX_CN"]),(error)=>error.message==="Secrets file rejected: referenced KEY=VALUE format" && !error.message.includes(fakeKey));
});
