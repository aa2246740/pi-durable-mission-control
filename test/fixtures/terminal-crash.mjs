import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { fixture } from "./completion.mjs";

const f = await fixture({ after() {} }, { settleOnShutdown: false });
writeFileSync(join(f.home, "state", "admin.token"), "terminal-crash-test-token\n", { mode: 0o600 });
if (process.argv[2] === "completed") {
  void f.complete();
  assert.equal((await f.reply).result.status, "completed");
} else {
  f.control.missionAction(f.mission.id, "cancel");
  void f.workers.syncMissionLifecycle(f.mission.id);
}
await nextImmediate();
assert.equal(f.sent.some((message) => message.type === "shutdown"), false);
assert.equal(f.control.message(f.row.message_id).status, "admitted");
process.send({ home: f.home, missionId: f.mission.id, agentId: f.agent.id, row: f.row });
