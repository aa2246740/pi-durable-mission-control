import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { readNodeJournal } from "./scenarios/node-power-loss.mjs";
import { assessKill } from "./scenarios/worker-crash.mjs";

export const localUncovered = [
  "未覆盖：容器只读挂载、独立文件系统与宿主路径不可见；同 UID 可访问彼此文件",
  "未覆盖：独立内核、硬件断电与磁盘缓存耐久性；node-power-loss 仅模拟完整节点进程崩溃",
  "未覆盖：容器 CPU/内存上限、网络隔离、跨架构与跨机网络",
  "未覆盖：独立新容器复核；使用新进程和冻结副本，同 UID 可修改运行时或 oracle"
];

export function localEnvironment() {
  const cgroup = {};
  if (process.platform === "linux") for (const path of ["/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "/sys/fs/cgroup/cpu/cpu.cfs_period_us", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try { cgroup[path] = readFileSync(path, "utf8").trim(); }
    catch { cgroup[path] = "unavailable"; }
  }
  return { platform: process.platform, architecture: process.arch, availableParallelism: availableParallelism(), hostMemoryBytes: totalmem(),
    cgroup, imposedResourceLimits: false };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const active = (entry) => entry && !/[ZX]/.test(entry.state);
export const sameProcess = (a, b) => Boolean(a && b && a.pid === b.pid && a.identity === b.identity && a.pgid === b.pgid && a.command.join("\0") === b.command.join("\0"));

// ps is available on both platforms. Linux adds the kernel start tick to avoid PID reuse.
const censusArgs = ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,args="];
const censusOptions = () => ({ env: { PATH: process.env.PATH, LC_ALL: "C" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
export function readProcesses() {
  return parseProcesses(execFileSync("ps", censusArgs, censusOptions()));
}

function parseProcesses(output) {
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:\S+\s+){4}\S+)\s+(.*)$/);
    if (!match) return [];
    const [, pid, ppid, pgid, state, started, args] = match;
    let identity = started;
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        identity = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return []; throw error; }
    }
    return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state, identity, command: args.split(/\s+/) }];
  });
}

export class ProcessTree {
  constructor(pid) {
    this.pid = pid;
    this.owned = new Map();
    this.capture();
    assert.ok(this.owned.has(pid), "Started process identity missing");
    this.scanning = false;
    // The relay and mock share this event loop. Background observation must not
    // block their HTTP exchanges; fault injection still uses fresh sync captures.
    this.timer = setInterval(() => {
      if (this.scanning) return;
      this.scanning = true;
      execFile("ps", censusArgs, censusOptions(), (error, output) => {
        this.scanning = false;
        if (error) { this.error ??= error; return; }
        try {
          if (!this.observe(parseProcesses(output)).length) clearInterval(this.timer);
        } catch (error) { this.error ??= error; }
      });
    }, 50);
    this.timer.unref();
  }
  capture() {
    return this.observe(readProcesses());
  }
  observe(entries) {
    const root = entries.find((entry) => entry.pid === this.pid);
    if (!this.owned.size && root) this.owned.set(root.pid, root);
    let changed;
    do {
      changed = false;
      for (const entry of entries) {
        const parent = this.owned.get(entry.ppid);
        if (!this.owned.has(entry.pid) && parent && sameProcess(parent, entries.find((value) => value.pid === parent.pid))) {
          this.owned.set(entry.pid, entry);
          changed = true;
        }
      }
    } while (changed);
    return entries.filter((entry) => sameProcess(entry, this.owned.get(entry.pid)) && active(entry));
  }
  signal(entry, signal) {
    assert.ok(entry.pid > 1 && entry.pid !== process.pid, "Protected process");
    const current = readProcesses().find((value) => value.pid === entry.pid);
    if (!active(current)) return false;
    assert.ok(sameProcess(entry, current), "Process identity changed before signal");
    process.kill(entry.pid, signal);
    return true;
  }
  async freeze() {
    if (this.error) throw this.error;
    // Stop parents before walking their children. Once all observed descendants are
    // stopped, none can fork away between the final census and SIGKILL.
    for (let round = 0; round < 100; round++) {
      const live = this.capture();
      for (const entry of live) if (!entry.state.includes("T")) this.signal(entry, "SIGSTOP");
      const next = this.capture();
      if (next.length === live.length && next.every((entry) => entry.state.includes("T"))) {
        await pause(20);
        const stable = this.capture();
        if (stable.length === next.length && stable.every((entry) => entry.state.includes("T"))) return stable;
      }
      await pause(10);
    }
    throw new Error("Cannot close the node descendant set; refusing incomplete fault injection");
  }
  async kill() {
    const frozen = await this.freeze();
    const groups = [...new Set(frozen.map((entry) => entry.pgid))];
    for (const pgid of groups) {
      assert.ok(pgid > 1, "Protected process group");
      const members = readProcesses().filter((entry) => entry.pgid === pgid && active(entry));
      assert.ok(members.every((entry) => sameProcess(entry, this.owned.get(entry.pid))), "Group contains an unowned process");
    }
    // Every process is stopped, so each verified group is closed to new forks.
    for (const pgid of [...groups].reverse()) {
      const members = readProcesses().filter((entry) => entry.pgid === pgid && active(entry));
      assert.ok(members.every((entry) => sameProcess(entry, this.owned.get(entry.pid))), "Process group changed before SIGKILL");
      if (members.length) process.kill(-pgid, "SIGKILL");
    }
    const deadline = Date.now() + 10000;
    while (this.capture().length && Date.now() < deadline) await pause(25);
    assert.deepEqual(this.capture(), [], "Owned descendants survived SIGKILL");
    clearInterval(this.timer);
    return { backend: "local-process", signal: "SIGKILL", processesExited: true, closedDescendantSet: true,
      processGroups: groups, processes: frozen, isolation: "whole-node-process-crash" };
  }
  async stop(handle) {
    const live = this.capture();
    const root = live.find((entry) => entry.pid === this.pid);
    if (root) this.signal(root, "SIGTERM");
    const deadline = Date.now() + 12000;
    while (this.capture().length && Date.now() < deadline) await pause(50);
    if (this.capture().length) await this.kill();
    await handle.done;
    clearInterval(this.timer);
    assert.deepEqual(this.capture(), []);
  }
}

export function createLocalBackend({ root, proof, childProcess, commandOutput }) {
  assert.ok(["linux", "darwin"].includes(process.platform), "local-process requires Linux or macOS");
  readProcesses(); // Fail the ps prerequisite before starting any owned process.
  const runtime = join(proof, "local-runtime");
  mkdirSync(runtime, { mode: 0o700 });
  const workspace = join(runtime, "remote-workspace"), home = join(runtime, "node-home", "state");
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const trees = [];
  let handle, tree;
  const supervisor = () => tree.capture().find((entry) => entry.command.some((arg) => arg.endsWith("/cli.js")) && entry.command.includes("node"));
  return {
    workspace, home, platform: process.platform, uncovered: [...localUncovered],
    start({ port, machineId, credentialRefs, input }) {
      handle = childProcess(process.execPath, [join(root, "acceptance/remote-linux/local-bootstrap.mjs"), join(root, "dist/cli.js"),
        String(port), machineId, home, workspace, ...credentialRefs], { PATH: process.env.PATH, HOME: home, TMPDIR: runtime }, { detached: true });
      tree = new ProcessTree(handle.child.pid);
      trees.push({ tree, handle });
      handle.child.stdin.end(input);
      return handle;
    },
    nodeState() { const entry = supervisor(); return { pid: entry?.pid, alive: Boolean(entry), home }; },
    readFile(path) { assert.ok(path.startsWith(workspace + "/")); return readFileSync(path, "utf8"); },
    eval(source, args = []) { return commandOutput(process.execPath, ["-e", source, ...args], { PATH: process.env.PATH, HOME: home, TMPDIR: runtime }); },
    async killWorker() {
      const parent = supervisor();
      assert.ok(parent, "Assigned node supervisor missing");
      const workers = tree.capture().filter((entry) => entry.ppid === parent.pid && entry.command.some((arg) => arg.endsWith("/worker.js")));
      assert.equal(workers.length, 1, "Expected one worker of this node supervisor");
      const worker = workers[0];
      tree.signal(worker, "SIGKILL");
      const deadline = Date.now() + 2000;
      while (tree.capture().some((entry) => entry.pid === worker.pid) && Date.now() < deadline) await pause(20);
      const entries = tree.capture();
      return assessKill({ backend: "local-process", ok: true, pid: worker.pid, command: worker.command, supervisorPid: parent.pid, supervisorCommand: parent.command,
        basis: "worker.js child of this run's supervisor; start identity and process group rechecked" },
      entries.some((entry) => entry.pid === worker.pid) ? "alive" : "gone", entries.find((entry) => entry.pid === parent.pid)?.state ?? "gone");
    },
    freezeNode() { return tree.freeze(); },
    async killNode() { const evidence = await tree.kill(); await handle.done; return evidence; },
    nodeEvidence() { return { journal: readNodeJournal(home), processes: tree.capture().filter((entry) => ["cli.js", "worker.js"].some((name) => entry.command[1]?.endsWith("/" + name))) }; },
    async stop() { for (const owned of trees) await owned.tree.stop(owned.handle); },
    async cleanup() {
      for (const owned of trees) { if (owned.tree.capture().length) await owned.tree.kill(); clearInterval(owned.tree.timer); }
      for (const owned of trees) assert.deepEqual(owned.tree.capture(), []);
      rmSync(runtime, { recursive: true });
      assert.equal(existsSync(runtime), false);
      return { processGroups: [...new Set(trees.flatMap(({ tree }) => [...tree.owned.values()].map((entry) => entry.pgid)))], processesExited: true, temporaryDirectoryRemoved: true };
    }
  };
}
