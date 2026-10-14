import { DatabaseSync } from "node:sqlite";

export const remoteRuntimeHome = "/node-home/worker-runtime";

// This function is also serialized for container exec. It must stay self-contained.
export function querySession(path, Database) {
  const db = new Database(path, { readOnly: true });
  try {
    if (db.prepare("SELECT version FROM durable_schema WHERE singleton=1").get()?.version !== 1) throw new Error("Unsupported pi-durable schema");
    const tools = [];
    let modelCalls = 0;
    const entries = db.prepare("SELECT id,commit_seq,record FROM entries ORDER BY commit_seq,id").all();
    for (const row of entries) {
      const entry = JSON.parse(row.record);
      if (entry.kind !== "pi.assistant") continue;
      const message = entry.model?.[0];
      if (message?.role !== "assistant" || !Array.isArray(message.content)) throw new Error("Invalid assistant evidence");
      modelCalls++;
      for (const [index, part] of message.content.entries()) {
        if (part.type === "toolCall") tools.push({ entryId: String(row.id), commitSeq: row.commit_seq, index, name: part.name });
      }
    }
    // pi.usage checkpoints every change and retains only the latest base revision.
    const documents = db.prepare("SELECT id FROM documents WHERE kind=? AND retired_at IS NULL ORDER BY id").all(JSON.stringify("pi.usage"));
    if (documents.length === 0) throw new Error("Missing pi.usage ledger");
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    for (const document of documents) {
      const revision = db.prepare("SELECT kind,version,content FROM document_revisions WHERE document_id=? ORDER BY seq DESC LIMIT 1").get(document.id);
      if (revision?.kind !== "base" || revision.version !== 1) throw new Error("Unsupported pi.usage revision");
      const state = JSON.parse(revision.content);
      if (!state.models || typeof state.models !== "object") throw new Error("Invalid pi.usage ledger");
      for (const model of Object.values(state.models)) for (const key of Object.keys(usage)) {
        if (!Number.isFinite(model[key]) || model[key] < 0) throw new Error("Invalid token counter");
        usage[key] += model[key];
      }
    }
    return { complete: true, modelCalls, modelCallsScope: "committed assistant responses, including error/retry responses; auxiliary admissions counted separately", tools, usage };
  } finally { db.close(); }
}

export function readSessionEvidence(path) {
  try { return querySession(path, DatabaseSync); }
  catch { return { complete: false, error: "Session database unreadable or incompatible", modelCalls: null, usage: null, tools: [] }; }
}

export const remoteSessionScript = `
  const {DatabaseSync}=require('node:sqlite');
  try { console.log(JSON.stringify((${querySession.toString()})(process.argv[1],DatabaseSync))); }
  catch { console.log(JSON.stringify({complete:false,error:'Session database unreadable or incompatible',modelCalls:null,usage:null,tools:[]})); }
`;

export const stopNodeForEvidenceScript = `
  const fs=require('node:fs');
  const stopped='/node-home/acceptance-node-stopped.json';
  if (!fs.existsSync(stopped)) process.kill(Number(fs.readFileSync('/node-home/acceptance-node.pid','utf8')),'SIGTERM');
  const deadline=Date.now()+15000;
  const poll=()=>{
    if(fs.existsSync(stopped)) {
      const result=JSON.parse(fs.readFileSync(stopped,'utf8'));
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(${JSON.stringify(`${remoteRuntimeHome}/node-workers.sqlite`)},{readOnly:true});
      try {
        const runtimes=db.prepare('SELECT state,pid,confirmed_stopped FROM node_worker_runtimes').all();
        result.stopped=result.exitCode!==null && runtimes.every(row=>{
          if(row.confirmed_stopped!==1) return false;
          if(!row.pid) return true;
          try {process.kill(row.pid,0);return false;} catch(error) {return error.code==='ESRCH';}
        });
        result.runtimes=runtimes;
        return console.log(JSON.stringify(result));
      } finally {db.close();}
    }
    if(Date.now()>=deadline) { console.error('Node shutdown not confirmed'); process.exit(1); }
    setTimeout(poll,100);
  };
  poll();
`;

export function refreshStoppedExport(path, exported) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const id = exported.mission.id;
    const mission = JSON.parse(db.prepare("SELECT data FROM missions WHERE id=?").get(id).data);
    const agents = db.prepare("SELECT data FROM agents WHERE mission_id=? ORDER BY rowid").all(id).map((row) => JSON.parse(row.data));
    const events = db.prepare("SELECT seq,data FROM events WHERE mission_id=? ORDER BY seq").all(id).map((row) => ({ ...JSON.parse(row.data), seq: row.seq }));
    const transcripts = agents.map((agent) => ({ agentId: agent.id, entries: db.prepare("SELECT id,role,text,created_at FROM transcript WHERE agent_id=? ORDER BY rowid").all(agent.id).map((row) => ({id:row.id,role:row.role,text:row.text,createdAt:row.created_at})) }));
    const generationAdmissions = db.prepare("SELECT * FROM generation_admissions WHERE mission_id=? ORDER BY turn_number").all(id);
    const related = (table) => db.prepare(`SELECT data FROM ${table} WHERE mission_id=? ORDER BY rowid`).all(id).map((row) => JSON.parse(row.data));
    return { ...exported, mission, agents, tasks: related("tasks"), artifacts: related("artifacts"), validationReceipts: related("validation_receipts"), blockers: related("blockers"), events, transcripts, generationAdmissions, stoppedRecordsReadAt: new Date().toISOString() };
  } finally { db.close(); }
}
