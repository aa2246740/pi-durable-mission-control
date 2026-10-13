import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { devNull } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface RepositoryIdentity {
  path: string;
  gitCommonDir: string;
  baseCommit: string;
}

export interface WorktreeRegistration {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
}

const timeout = 30_000;
const maxBuffer = 32 * 1024 * 1024;

function git(root: string, args: string[], input?: Buffer): Buffer {
  try {
    return execFileSync("git", [
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=" + devNull,
      "-c", "credential.helper=",
      "-c", "protocol.allow=never",
      ...args
    ], {
      cwd: root,
      encoding: "buffer",
      timeout,
      maxBuffer,
      input,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: devNull,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1"
      }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Git command failed";
    throw new Error(`Local Git operation failed: ${detail.slice(0, 500)}`);
  }
}

function gitText(root: string, args: string[]): string {
  return git(root, args).toString("utf8").trim();
}

function realDirectory(path: string): string {
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error("Repository path is not a directory");
  return canonical;
}

function rejectUnsupportedTrackedContent(root: string): void {
  const index = git(root, ["ls-files", "--stage", "-z"]).toString("utf8");
  for (const record of index.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab > 0 && record.slice(0, tab).startsWith("160000 ")) {
      throw new Error("Git submodules are not supported for worktree Missions");
    }
  }
  const files = git(root, ["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
  if (files.length) {
    const attributes = git(root, ["check-attr", "-z", "filter", "--stdin"], Buffer.from(`${files.join("\0")}\0`))
      .toString("utf8").split("\0");
    for (let index = 0; index + 2 < attributes.length; index += 3) {
      const value = attributes[index + 2];
      if (value && value !== "unspecified" && value !== "unset") {
        throw new Error(`Required Git checkout filter is not supported (${attributes[index]})`);
      }
    }
  }
}

export function inspectRepository(path: string): RepositoryIdentity {
  let root: string;
  try {
    root = realDirectory(path);
  } catch {
    throw new Error("Worktree mode requires an existing local Git repository directory");
  }
  try {
    if (gitText(root, ["rev-parse", "--is-bare-repository"]) !== "false") {
      throw new Error("Bare repositories cannot be used for worktree Missions");
    }
    const topLevel = realDirectory(gitText(root, ["rev-parse", "--show-toplevel"]));
    if (root !== topLevel) throw new Error("Worktree mode requires the repository root, not a subdirectory");
    const baseCommit = gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[a-f0-9]{40,64}$/i.test(baseCommit)) throw new Error("Repository HEAD is not a full commit SHA");
    const rawCommonDir = gitText(root, ["rev-parse", "--git-common-dir"]);
    const gitCommonDir = realpathSync(isAbsolute(rawCommonDir) ? rawCommonDir : resolve(root, rawCommonDir));
    const status = git(root, ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"]).toString("utf8");
    if (status) throw new Error("Worktree mode requires a clean repository (tracked and non-ignored untracked files)");
    rejectUnsupportedTrackedContent(root);
    return { path: root, gitCommonDir, baseCommit: baseCommit.toLowerCase() };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Local Git operation failed:")) {
      throw new Error("Worktree mode requires a valid, local Git repository with an existing commit");
    }
    throw error;
  }
}

export function repositoryHead(repositoryPath: string): string {
  const head = gitText(repositoryPath, ["rev-parse", "--verify", "HEAD^{commit}"]).toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Git HEAD is not a full commit SHA");
  return head;
}

export function repositoryCommonDir(repositoryPath: string): string {
  const raw = gitText(repositoryPath, ["rev-parse", "--git-common-dir"]);
  return realpathSync(isAbsolute(raw) ? raw : resolve(repositoryPath, raw));
}

export function ensureWorktreeParent(home: string, targetPath: string): void {
  const daemonHome = resolve(home);
  if (realpathSync(daemonHome) !== daemonHome) throw new Error("Daemon home directory is redirected");
  const root = resolve(daemonHome, "worktrees");
  const target = resolve(targetPath);
  const parent = dirname(target);
  const relativeParent = relative(root, parent);
  if (!relativeParent || relativeParent === ".." || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
    throw new Error("Worktree directory escaped the daemon worktrees directory");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root || !statSync(root).isDirectory()) throw new Error("Daemon worktrees directory is redirected or unavailable");
  let current = root;
  for (const component of relativeParent.split(sep)) {
    current = resolve(current, component);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== current || !statSync(current).isDirectory()) {
      throw new Error("Worktree parent directory is redirected or is not a directory");
    }
  }
}

export function isWorktreeClean(repositoryPath: string): boolean {
  return git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"]).length === 0;
}

export function isTrackedSnapshotClean(repositoryPath: string, commit: string): boolean {
  try {
    git(repositoryPath, ["diff", "--quiet", commit, "--"]);
    return repositoryHead(repositoryPath) === commit;
  } catch {
    return false;
  }
}

export function branchExists(repositoryPath: string, branch: string): boolean {
  try {
    git(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export function listWorktrees(repositoryPath: string): WorktreeRegistration[] {
  const output = git(repositoryPath, ["worktree", "list", "--porcelain", "-z"]).toString("utf8");
  const result: WorktreeRegistration[] = [];
  let item: Partial<WorktreeRegistration> = {};
  const fields = output.split("\0");
  for (const field of fields) {
    if (!field) {
      if (item.path && item.head) result.push(item as WorktreeRegistration);
      item = {};
      continue;
    }
    if (field.startsWith("worktree ")) item.path = field.slice("worktree ".length);
    else if (field.startsWith("HEAD ")) item.head = field.slice("HEAD ".length).toLowerCase();
    else if (field.startsWith("branch refs/heads/")) item.branch = field.slice("branch refs/heads/".length);
    else if (field === "detached") item.detached = true;
  }
  if (item.path && item.head) result.push(item as WorktreeRegistration);
  return result;
}

export function verifyWorktree(
  repository: RepositoryIdentity,
  path: string,
  expected: { branch?: string; commit?: string; detached?: boolean }
): WorktreeRegistration {
  const expectedPath = resolve(path);
  if (lstatSync(expectedPath).isSymbolicLink()) throw new Error("Recorded worktree path was replaced by a symlink");
  const actualPath = realDirectory(expectedPath);
  if (actualPath !== expectedPath) throw new Error("Recorded worktree path resolves outside its recorded directory");
  if (repositoryCommonDir(actualPath) !== repository.gitCommonDir) throw new Error("Worktree belongs to a different Git repository");
  const registration = listWorktrees(repository.path).find((item) => resolve(item.path) === expectedPath);
  if (!registration) throw new Error("Worktree path is not registered with the pinned Git common directory");
  const branch = (() => {
    try {
      return gitText(actualPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    } catch {
      return undefined;
    }
  })();
  if (expected.branch !== undefined && (branch !== expected.branch || registration.branch !== expected.branch)) {
    throw new Error("Worktree branch does not match its durable record");
  }
  if (expected.detached && (branch !== undefined || !registration.detached)) throw new Error("Validation worktree is not detached");
  const head = repositoryHead(actualPath);
  if (expected.commit && head !== expected.commit) throw new Error("Worktree HEAD does not match its durable record");
  return { ...registration, path: actualPath, head, ...(branch ? { branch } : {}) };
}

export function addAgentWorktree(repository: RepositoryIdentity, path: string, branch: string): void {
  const target = resolve(path);
  try { lstatSync(target); throw new Error("Predetermined worktree path already exists and will not be overwritten"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (branchExists(repository.path, branch)) throw new Error("Predetermined worktree branch is already occupied");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  git(repository.path, ["worktree", "add", "-b", branch, target, repository.baseCommit]);
}

export function addDetachedWorktree(repository: RepositoryIdentity, path: string, commit: string): void {
  const target = resolve(path);
  try { lstatSync(target); throw new Error("Predetermined validation path already exists and will not be overwritten"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  git(repository.path, ["worktree", "add", "--detach", target, commit]);
}

export function trackedBlobAt(repositoryPath: string, commit: string, relativePath: string): { mode: string; objectId: string; bytes: Buffer } {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === ".." || part === ".")) {
    throw new Error("Artifact path is not a repository-relative file path");
  }
  const records = git(repositoryPath, ["ls-tree", "-z", "--full-tree", commit, "--", relativePath]).toString("utf8").split("\0").filter(Boolean);
  const matching = records.map((record) => {
    const tab = record.indexOf("\t");
    const [mode, type, objectId] = record.slice(0, tab).split(" ");
    return { mode, type, objectId, path: record.slice(tab + 1) };
  }).find((item) => item.path === relativePath);
  if (!matching || matching.type !== "blob" || !["100644", "100755"].includes(matching.mode ?? "")) {
    throw new Error("Artifact must be a tracked regular Git blob");
  }
  return { mode: matching.mode!, objectId: matching.objectId!, bytes: git(repositoryPath, ["cat-file", "blob", matching.objectId!]) };
}

export function trackedArtifactPath(repositoryPath: string, worktreePath: string, filePath: string): { relativePath: string; bytes: Buffer } {
  const canonicalWorkspace = realDirectory(worktreePath);
  const candidate = resolve(filePath);
  if (lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile()) throw new Error("Artifact must be a regular file, not a symlink");
  const canonicalFile = realpathSync(candidate);
  const rel = relative(canonicalWorkspace, canonicalFile);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Artifact path escaped the recorded worktree");
  const relativePath = rel.split(sep).join("/");
  const bytes = readFileSync(canonicalFile);
  const committed = trackedBlobAt(repositoryPath, repositoryHead(worktreePath), relativePath);
  if (!committed.bytes.equals(bytes)) throw new Error("Artifact bytes do not match the committed Git blob");
  return { relativePath, bytes };
}

export function isAncestor(repositoryPath: string, ancestor: string, descendant: string): boolean {
  try {
    git(repositoryPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}
