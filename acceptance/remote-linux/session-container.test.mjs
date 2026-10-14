// Explicit cached Apple Container check, outside npm test's glob.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { commandOutput } from "./run.mjs";
import { readSessionEvidence, remoteRuntimeHome, remoteSessionScript, stopNodeForEvidenceScript } from "./session-evidence.mjs";
import { sha256 } from "./real.mjs";

test("cached Linux Node reads a stopped real pi-durable store through stdout only", { timeout: 60000 }, async () => {
  const prefix = process.env.MC_ACCEPTANCE_CONTAINER_PREFIX ?? "mc-acc-";
  assert.match(prefix, /^mc-acc-[a-z0-9-]*$/);
  const cli = "/opt/homebrew/bin/container";
  const command = (args) => commandOutput(cli, args);
  const names = async () => (await command(["list","--all","--quiet"])).trim().split(/\s+/).filter((name)=>name.startsWith(prefix));
  assert.deepEqual(await names(), []);
  const images = JSON.parse(await command(["image","list","--format","json"]));
  const image = images.find((item)=>/^(docker\.io\/library\/)?node:22-bookworm-slim$/.test(item.configuration.name));
  assert.ok(image?.variants.some((item)=>item.platform.architecture === "arm64" && item.platform.os === "linux"),"Cached arm64 Node image required; no pull");
  const parent = join(process.cwd(),".acceptance-proof"); mkdirSync(parent,{recursive:true});
  const directory = mkdtempSync(join(parent,"session-linux-"));
  const path = join(directory,"session.sqlite");
  const name = `${prefix}session-${randomUUID().slice(0,8)}`;
  try {
    const faux = fauxProvider(); faux.setResponses([fauxAssistantMessage("Local fixture response")]);
    const models = createModels(); models.setProvider(faux.provider);
    const harness = await Harness.open(await openNodeSqliteStorage(path),{models,registry:createRegistry()},BACKGROUND_CONTEXT);
    try {
      const root = await harness.root(BACKGROUND_CONTEXT,{agent:{model:{provider:"faux",modelId:"faux-1"}}});
      const input = await root.submit({type:"input",content:"Unit fixture"},BACKGROUND_CONTEXT);
      assert.equal((await input.wait(BACKGROUND_CONTEXT)).status,"done");
      await root.waitForIdle(BACKGROUND_CONTEXT);
    } finally {await harness.close(BACKGROUND_CONTEXT);}
    const expected = readSessionEvidence(path);
    assert.equal(expected.complete,true); assert.equal(expected.modelCalls,1);
    const digest = sha256(readFileSync(path));
    const script = `(async()=>{
      const fs=require('node:fs');fs.mkdirSync('/work',{recursive:true});
      const {NodeWorkerSupervisor}=await import('/app/dist/node-workers.js');
      const supervisor=new NodeWorkerSupervisor({home:${JSON.stringify(remoteRuntimeHome)},machineId:'unit',sessionId:'unit-session',sessionEpoch:1,roots:['/work'],credentialRefs:[],isLeaseCurrent:()=>true,executionEnabled:true,executionMode:'workspace-effects'});
      await supervisor.close();
      fs.writeFileSync('/node-home/acceptance-node-stopped.json',JSON.stringify({stopped:true,exitCode:0}));
      console.error('fixture stderr diagnostic');
      {${stopNodeForEvidenceScript}}
      {${remoteSessionScript}}
    })().catch(error=>{console.error(error);process.exit(1)});`;
    const root = process.cwd();
    const stdout = await command(["run","--rm","--name",name,"--arch","arm64","--cpus","1","--memory","256M",
      "-v",`${path}:${remoteRuntimeHome}/agents/fixture.sqlite:ro`,
      "-v",`${join(root,"dist")}:/app/dist:ro`,"-v",`${join(root,"package.json")}:/app/package.json:ro`,
      "-v",`${realpathSync(join(root,"node_modules"))}:/app/node_modules:ro`,
      image.configuration.name,"node","-e",script,`${remoteRuntimeHome}/agents/fixture.sqlite`]);
    const [stopped,session] = stdout.trim().split("\n").map((line)=>JSON.parse(line));
    assert.deepEqual(stopped,{stopped:true,exitCode:0,runtimes:[]});
    assert.deepEqual(session,expected);
    assert.ok(expected.usage.totalTokens > 0);
    assert.equal(sha256(readFileSync(path)),digest);
  } finally {
    for (const operation of ["stop","delete"]) if ((await names()).includes(name)) {
      try {await command([operation,name]);}
      catch(error) {if ((await names()).includes(name)) throw error;}
    }
    rmSync(directory,{recursive:true,force:true});
  }
  assert.deepEqual(await names(), []);
});
