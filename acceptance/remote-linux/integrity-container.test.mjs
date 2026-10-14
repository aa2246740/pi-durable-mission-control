// Uses only the cached image and a host-local model stub; no production credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandOutput, childProcess } from "./run.mjs";
import { independentReview, sha256, writeFrozenAcceptance } from "./real.mjs";
import { correctTotals, forgedPrefixTotals } from "../../test/fixtures/remote-linux-totals.mjs";

const cli="/opt/homebrew/bin/container", prefix=process.env.MC_ACCEPTANCE_CONTAINER_PREFIX;
assert.match(prefix??"",/^mc-acc-[a-z0-9-]+-$/, "Set this worktree's isolated container prefix");
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR};
const command=args=>commandOutput(cli,args,env);
const names=async()=> (await command(["list","--all","--quiet"])).trim().split(/\s+/).filter(name=>name.startsWith(prefix));
const proof=mkdtempSync(join(tmpdir(),"mc-h2-integrity-"));
const save=(name,value)=>writeFileSync(join(proof,name),JSON.stringify(value,null,2)+"\n",{mode:0o600});
async function remove(name) {
  assert.ok(name.startsWith(prefix));
  for(const action of ["stop","delete"]) if((await names()).includes(name)) {
    try {await command([action,name]);} catch(error) {if((await names()).includes(name))throw error;}
  }
}

test("fresh container accepts correct totals and rejects forged result bytes", {timeout:180000}, async()=>{
  assert.deepEqual(await names(),[]);
  const images=JSON.parse(await command(["image","list","--format","json"]));
  const image=images.find(item=>/^(docker\.io\/library\/)?node:22-bookworm-slim$/.test(item.configuration?.name));
  assert.ok(image?.variants?.some(v=>v.platform?.architecture==="arm64"&&v.platform?.os==="linux"),"cached image required; never pull");
  const oracle=join(proof,"oracle");mkdirSync(oracle);const acceptance=writeFrozenAcceptance(oracle);
  for(const [index,source] of [correctTotals,forgedPrefixTotals].entries()) {
    const dir=join(proof,`totals-${index}`);mkdirSync(dir);
    const casPath=join(dir,"cas");writeFileSync(casPath,source);
    const name=`${prefix}integrity-${index}-${Date.now()}`;
    const review=await independentReview({proof:dir,acceptance,casPath,name,image:image.configuration.name,
      artifact:{id:"totals",path:"/work/totals.mjs",sha256:sha256(source)},receipt:{id:"receipt",exitCode:0,stdout:"# tests 4\n# pass 4\n# fail 0\n"},
      execute:async args=>{
        const handle=childProcess(cli,args,env),timer=setTimeout(()=>handle.child.kill("SIGKILL"),60000);
        try {await handle.done;return {exitCode:handle.child.exitCode,stdout:handle.stdout(),stderr:handle.stderr()};}
        finally {clearTimeout(timer);await remove(name);}
      }});
    save(`totals-${index}.json`,review);
    assert.equal(review.passed,index===0,JSON.stringify(review));
    assert.equal(review.exitCode,index===0?0:1);
    assert.equal(review.agreesWithReceipt,index===0);
  }
  assert.deepEqual(await names(),[]);
});

for(const mode of ["timeout","SIGINT"]) test(`container preflight ${mode} removes its guest`,{timeout:90000},async()=>{
  assert.deepEqual(await names(),[]);
  let observed;
  const requestSeen=new Promise(resolve=>{observed=resolve;});
  let requests=0;
  const server=createServer(async(req)=>{for await(const chunk of req) {void chunk;} requests++;observed();});
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"192.168.64.1",resolve);});
  const profile={name:"local-stub",api:"openai-completions",modelId:"local-stub",baseUrl:`http://192.168.64.1:${server.address().port}/v1`,credentialEnv:"UNIT_KEY",contextWindow:128000,maxTokens:8192,reasoning:false,toolCalling:true,vision:false};
  const configPath=join(proof,`${mode}.json`),secretsPath=join(proof,`${mode}.env`);
  writeFileSync(configPath,JSON.stringify({orchestrator:profile,worker:profile,validator:profile}));
  writeFileSync(secretsPath,"UNIT_KEY=h2-fake-only-credential\n",{mode:0o600});
  const args=["acceptance/remote-linux/preflight.mjs","--real",configPath,"--secrets-file",secretsPath,"--from-container","--timeout-ms",mode==="timeout"?"2000":"60000"];
  const child=spawn(process.execPath,args,{cwd:process.cwd(),env:{...env,MC_ACCEPTANCE_CONTAINER_PREFIX:prefix},stdio:["ignore","pipe","pipe"]});
  let stdout="",stderr="";
  child.stdout.on("data",chunk=>{stdout+=chunk;});child.stderr.on("data",chunk=>{stderr+=chunk;});
  const done=new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));});
  let timer;
  try {
    await Promise.race([requestSeen,done.then(()=>{throw Error("Probe exited before contacting stub");}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("No stub request")),30000);})]);
    clearTimeout(timer);
    if(mode==="SIGINT")child.kill("SIGINT");
    const exit=await Promise.race([done,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Probe cleanup timed out")),35000);})]);
    clearTimeout(timer);
    const report=JSON.parse(stdout.trim()),residue=await names();
    save(`preflight-${mode}.json`,{args,exit,requests,report,residue,stderr});
    assert.deepEqual(exit,{code:1,signal:null});
    assert.equal(requests,1);
    assert.equal(report.pass,false);
    assert.equal(report.checks[0].cleanupVerified,true);
    assert.equal(report.checks[0].errorCategory,mode==="timeout"?"timeout":"container");
    if(mode==="SIGINT")assert.match(report.checks[0].error,/Interrupted by SIGINT/);
    assert.deepEqual(residue,[]);
  } catch(error) {
    save(`preflight-${mode}-failure.json`,{error:error.message,stdout,stderr,requests,residue:await names()});
    throw error;
  } finally {
    clearTimeout(timer);
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");
    await done;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    // The prefix was empty at entry and this suite creates one probe at a time.
    for(const name of await names())await remove(name);
  }
});

test("integrity regression leaves no owned containers",async()=>{
  const residue=await names();save("residue.json",residue);assert.deepEqual(residue,[]);
  console.log(`H2 proof ${proof}`);
});
