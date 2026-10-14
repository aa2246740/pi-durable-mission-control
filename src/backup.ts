import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DurableWorkerMailbox } from "./worker-mailbox.js";
import { basename, dirname, join, posix, resolve } from "node:path";
import type { WorktreeRecord } from "./contracts.js";
import { CONTROL_SCHEMA_VERSION, tryAcquireDaemonOwnership } from "./control.js";

const BACKUP_FORMAT = "mission-control-backup";
const BACKUP_FORMAT_VERSION = 1;
const COPY_BUFFER_SIZE = 64 * 1024;
const OWNER_ONLY = 0o600;
const PRIVATE_DIRECTORY = 0o700;

type FileRecord = { path: string; size: number; sha256: string };
type WorktreeMission = {
  id: string;
  repository: { path: string; gitCommonDir: string; baseCommit: string };
};
type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  appVersion: string;
  createdAt: string;
  sourceHome: string;
  controlSchemaVersion: number;
  files: FileRecord[];
  worktrees: Array<Pick<WorktreeRecord, "id" | "missionId" | "kind" | "path" | "branch" | "baseCommit" | "repositoryPath" | "gitCommonDir" | "status">>;
  worktreeMissions: WorktreeMission[];
};

type BackupSummary = { path: string; files: number; controlSchemaVersion: number; durabilityWarnings: string[] };
type RestoreSummary = { path: string; files: number; sourceHome: string; appVersion: string; durabilityWarnings: string[] };
type DaemonOfflineCheck = (home: string) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maybeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requireRegularFile(path: string, description: string): void {
  const info = maybeLstat(path);
  if (!info) throw new Error(`${description} is missing: ${path}`);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${description} must be a regular file: ${path}`);
}

function requireDirectory(path: string, description: string, optional = false): boolean {
  const info = maybeLstat(path);
  if (!info) {
    if (optional) return false;
    throw new Error(`${description} is missing: ${path}`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${description} must be a real directory: ${path}`);
  return true;
}

function safeRelativeFile(path: string): boolean {
  if (!path || path.includes("\\") || posix.isAbsolute(path)) return false;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  if (path === "control.sqlite" || path === "admin.token") return true;
  if (parts[0] === "agents") {
    return parts.length === 2 && /^[^/]+\.sqlite$/.test(parts[1]!) && !parts[1]!.endsWith(".ownership.sqlite");
  }
  return parts[0] === "artifacts" && parts.length > 1;
}

function statSourceFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error(`Expected a regular file: ${path}`);
  } finally {
    closeSync(descriptor);
  }
}

function digestOrCopyFile(source: string, destination?: string): { size: number; sha256: string } {
  const sourceDescriptor = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let destinationDescriptor: number | undefined;
  try {
    const initial = fstatSync(sourceDescriptor);
    if (!initial.isFile()) throw new Error(`Expected a regular file: ${source}`);
    if (destination) {
      destinationDescriptor = openSync(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        OWNER_ONLY
      );
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_SIZE);
    let size = 0;
    while (true) {
      const count = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      const bytes = buffer.subarray(0, count);
      digest.update(bytes);
      if (destinationDescriptor !== undefined) {
        let written = 0;
        while (written < count) written += writeSync(destinationDescriptor, bytes, written, count - written, null);
      }
      size += count;
    }
    const final = fstatSync(sourceDescriptor);
    if (size !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs) {
      throw new Error(`File changed while it was being read: ${source}`);
    }
    if (destination) {
      chmodSync(destination, OWNER_ONLY);
      fsyncSync(destinationDescriptor!);
    }
    return { size, sha256: digest.digest("hex") };
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    closeSync(sourceDescriptor);
  }
}

function syncRegularFile(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`Expected a regular file before fsync: ${path}`);
    fsyncSync(descriptor);
  } catch (error) {
    throw new Error(`Could not fsync staged file ${path}: ${errorMessage(error)}`);
  } finally {
    closeSync(descriptor);
  }
}

function directoryFsyncUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

function syncDirectory(path: string, warnings: Set<string>): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    fsyncSync(descriptor);
  } catch (error) {
    if (directoryFsyncUnsupported(error)) {
      warnings.add(`Directory fsync is unsupported on ${process.platform} (${(error as NodeJS.ErrnoException).code}); atomic rename is used, but directory-entry crash durability is not guaranteed.`);
      return;
    }
    throw new Error(`Could not fsync staged directory ${path}: ${errorMessage(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncTree(root: string, warnings: Set<string>): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Cannot fsync a staged tree containing a symlink: ${path}`);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) syncRegularFile(path);
      else throw new Error(`Cannot fsync a staged tree containing a non-regular entry: ${path}`);
    }
    syncDirectory(directory, warnings);
  };
  visit(root);
}

function syncPublishedParent(path: string, warnings: Set<string>): void {
  try {
    syncDirectory(path, warnings);
  } catch (error) {
    warnings.add(`The staged directory was published, but its parent could not be fsynced (${errorMessage(error)}); crash durability is not guaranteed.`);
  }
}

function ensurePrivateParents(root: string, relativePath: string): string {
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const existing = maybeLstat(current);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`Backup path is not a real directory: ${current}`);
    } else {
      mkdirSync(current, { mode: PRIVATE_DIRECTORY });
      chmodSync(current, PRIVATE_DIRECTORY);
    }
  }
  return join(root, ...parts);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function vacuumInto(source: string, destination: string): void {
  const statement = `VACUUM INTO ${sqlString(destination)}`;
  try {
    const readOnly = new DatabaseSync(source, { readOnly: true });
    try {
      readOnly.exec(statement);
    } finally {
      readOnly.close();
    }
  } catch (readOnlyError) {
    if (existsSync(destination)) {
      const info = maybeLstat(destination);
      if (info?.isFile() && !info.isSymbolicLink()) rmSync(destination);
      else throw new Error(`Could not remove a failed SQLite snapshot at ${destination}`);
    }
    try {
      const writable = new DatabaseSync(source);
      try {
        writable.exec(statement);
      } finally {
        writable.close();
      }
    } catch (writableError) {
      throw new Error(`Could not create a consistent SQLite snapshot of ${source}: ${errorMessage(writableError)} (read-only attempt: ${errorMessage(readOnlyError)})`);
    }
  }
  chmodSync(destination, OWNER_ONLY);
}

function checkIntegrity(path: string, expectedVersion?: number): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed for ${path}: ${JSON.stringify(rows)}`);
    }
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (expectedVersion !== undefined && version !== expectedVersion) {
      throw new Error(`SQLite schema version mismatch for ${path}: expected ${expectedVersion}, found ${version}`);
    }
    return version;
  } finally {
    db.close();
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function readWorktreeMetadata(db: DatabaseSync): {
  worktrees: BackupManifest["worktrees"];
  worktreeMissions: WorktreeMission[];
} {
  const worktrees: BackupManifest["worktrees"] = [];
  if (tableExists(db, "worktrees")) {
    const rows = db.prepare("SELECT data FROM worktrees ORDER BY id").all() as Array<{ data: string }>;
    for (const row of rows) {
      const value: unknown = JSON.parse(row.data);
      if (!isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.missionId !== "string" ||
        (value.kind !== "agent" && value.kind !== "validation") ||
        typeof value.path !== "string" ||
        typeof value.baseCommit !== "string" ||
        typeof value.repositoryPath !== "string" ||
        typeof value.gitCommonDir !== "string" ||
        (value.status !== "pending" && value.status !== "ready" && value.status !== "error") ||
        (value.branch !== undefined && typeof value.branch !== "string")) {
        throw new Error("The control database contains an invalid worktree record; refusing to create an incomplete backup");
      }
      worktrees.push({
        id: value.id,
        missionId: value.missionId,
        kind: value.kind,
        path: value.path,
        ...(value.branch === undefined ? {} : { branch: value.branch }),
        baseCommit: value.baseCommit,
        repositoryPath: value.repositoryPath,
        gitCommonDir: value.gitCommonDir,
        status: value.status
      });
    }
  }

  const worktreeMissions: WorktreeMission[] = [];
  if (tableExists(db, "missions")) {
    const rows = db.prepare("SELECT data FROM missions ORDER BY id").all() as Array<{ data: string }>;
    for (const row of rows) {
      const value: unknown = JSON.parse(row.data);
      if (!isRecord(value) || value.workspaceStrategy !== "worktree") continue;
      const repository = value.repository;
      if (!isRecord(repository) ||
        typeof repository.path !== "string" ||
        typeof repository.gitCommonDir !== "string" ||
        typeof repository.baseCommit !== "string") {
        if (value.status === "draft") continue;
        throw new Error("The control database contains a worktree Mission without a pinned repository; refusing to create an incomplete backup");
      }
      if (typeof value.id !== "string") {
        throw new Error("The control database contains a worktree Mission without a pinned repository; refusing to create an incomplete backup");
      }
      worktreeMissions.push({
        id: value.id,
        repository: {
          path: repository.path,
          gitCommonDir: repository.gitCommonDir,
          baseCommit: repository.baseCommit
        }
      });
    }
  }
  return { worktrees, worktreeMissions };
}

function inspectControlDatabase(path: string): {
  controlSchemaVersion: number;
  worktrees: BackupManifest["worktrees"];
  worktreeMissions: WorktreeMission[];
} {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const controlSchemaVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (!Number.isSafeInteger(controlSchemaVersion) || controlSchemaVersion < 0 || controlSchemaVersion > CONTROL_SCHEMA_VERSION) {
      throw new Error(`Control database schema ${controlSchemaVersion} is not supported by this build (maximum ${CONTROL_SCHEMA_VERSION})`);
    }
    return { controlSchemaVersion, ...readWorktreeMetadata(db) };
  } finally {
    db.close();
  }
}

function acquireControlBackupLock(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
    return db;
  } catch (error) {
    db.close();
    throw new Error(`Control database is busy; cannot establish an offline backup boundary: ${errorMessage(error)}`);
  }
}

function acquireAgentLeases(home: string, databases: string[]): DatabaseSync[] {
  const leases: DatabaseSync[] = [];
  try {
    for (const relativePath of databases) {
      const storePath = join(home, ...relativePath.split("/"));
      const ownershipPath = `${storePath}.ownership.sqlite`;
      const info = maybeLstat(ownershipPath);
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Agent ownership store is not a regular file: ${ownershipPath}`);
      const lease = new DatabaseSync(ownershipPath, { timeout: 0 });
      try {
        lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
      } catch {
        lease.close();
        throw new Error(`Agent durable store is already owned by a live worker: ${relativePath}`);
      }
      leases.push(lease);
    }
    return leases;
  } catch (error) {
    releaseLeases(leases);
    throw error;
  }
}

function releaseLeases(leases: DatabaseSync[]): void {
  for (const lease of [...leases].reverse()) {
    try { lease.exec("ROLLBACK"); } catch {}
    try { lease.close(); } catch {}
  }
}

function agentDatabaseFiles(home: string): string[] {
  const directory = join(home, "agents");
  if (!requireDirectory(directory, "Agent store directory", true)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Agent store contains a symlink or non-regular entry: ${path}`);
    if (entry.endsWith(".ownership.sqlite") || entry.endsWith("-wal") || entry.endsWith("-shm")) continue;
    if (entry.endsWith(".sqlite")) files.push(`agents/${entry}`);
  }
  return files.sort();
}

function artifactFiles(home: string): string[] {
  const root = join(home, "artifacts");
  if (!requireDirectory(root, "Artifact directory", true)) return [];
  const files: string[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const relativePath = `${relativeDirectory}/${entry}`;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Artifact directory contains a symlink: ${path}`);
      if (info.isDirectory()) {
        visit(path, relativePath);
      } else if (info.isFile()) {
        if (!safeRelativeFile(relativePath)) throw new Error(`Artifact path cannot be represented safely in a backup: ${relativePath}`);
        files.push(relativePath);
      } else {
        throw new Error(`Artifact directory contains a non-regular entry: ${path}`);
      }
    }
  };
  visit(root, "artifacts");
  return files.sort();
}

function ensureOutputLocation(output: string): void {
  if (maybeLstat(output)) throw new Error(`Backup output already exists: ${output}`);
  const parent = dirname(output);
  const info = maybeLstat(parent);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Backup output parent must already exist as a real directory: ${parent}`);
  }
}

export async function backupHome(
  home: string,
  output: string,
  appVersion: string,
  assertDaemonOffline: DaemonOfflineCheck
): Promise<BackupSummary> {
  const sourceHomePath = resolve(home);
  const sourceHomeInfo = maybeLstat(sourceHomePath);
  if (!sourceHomeInfo || sourceHomeInfo.isSymbolicLink() || !sourceHomeInfo.isDirectory()) {
    throw new Error(`Mission Control home must exist as a real directory: ${sourceHomePath}`);
  }
  const sourceHome = realpathSync(sourceHomePath);
  const outputPath = resolve(output);
  ensureOutputLocation(outputPath);
  const ownership = tryAcquireDaemonOwnership(sourceHome);
  if (!ownership) throw new Error("Cannot back up while the daemon ownership lock is held by a live coordinator or another backup; stop the daemon first");
  let controlLease: DatabaseSync | undefined;
  let agentLeases: DatabaseSync[] = [];
  let temporary: string | undefined;
  const durabilityWarnings = new Set<string>();
  try {
    await assertDaemonOffline(sourceHome);
    const controlPath = join(sourceHome, "control.sqlite");
    requireRegularFile(controlPath, "Control database");
    const databaseMetadata = inspectControlDatabase(controlPath);
    requireRegularFile(join(sourceHome, "admin.token"), "Administrative token");
    controlLease = acquireControlBackupLock(controlPath);
    const lockedMetadata = inspectControlDatabase(controlPath);
    if (lockedMetadata.controlSchemaVersion !== databaseMetadata.controlSchemaVersion) {
      throw new Error("Control database schema changed while establishing the offline backup boundary");
    }
    const agentDatabases = agentDatabaseFiles(sourceHome);
    const artifacts = artifactFiles(sourceHome);
    const sourceFiles = [
      "control.sqlite",
      "admin.token",
      ...agentDatabases,
      ...artifacts
    ].sort();
    for (const relativePath of sourceFiles) {
      if (!safeRelativeFile(relativePath)) throw new Error(`Source path cannot be represented safely in a backup: ${relativePath}`);
      if (relativePath.startsWith("agents/") || relativePath.startsWith("artifacts/") || relativePath === "admin.token") {
        statSourceFile(join(sourceHome, ...relativePath.split("/")));
      }
    }
    agentLeases = acquireAgentLeases(sourceHome, agentDatabases);
    temporary = mkdtempSync(`${outputPath}.partial-`);
    chmodSync(temporary, PRIVATE_DIRECTORY);
    const records: FileRecord[] = [];
    for (const relativePath of sourceFiles) {
      const source = join(sourceHome, ...relativePath.split("/"));
      const destination = ensurePrivateParents(temporary, relativePath);
      if (relativePath === "control.sqlite" || relativePath.startsWith("agents/")) {
        vacuumInto(source, destination);
        const schemaVersion = checkIntegrity(destination, relativePath === "control.sqlite" ? lockedMetadata.controlSchemaVersion : undefined);
        if (relativePath === "control.sqlite" && schemaVersion !== lockedMetadata.controlSchemaVersion) {
          throw new Error("Control database schema changed while its backup was being created");
        }
        syncRegularFile(destination);
        const digest = digestOrCopyFile(destination);
        records.push({ path: relativePath, ...digest });
      } else {
        const digest = digestOrCopyFile(source, destination);
        records.push({ path: relativePath, ...digest });
      }
    }
    records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion,
      createdAt: new Date().toISOString(),
      sourceHome,
      controlSchemaVersion: lockedMetadata.controlSchemaVersion,
      files: records,
      worktrees: lockedMetadata.worktrees,
      worktreeMissions: lockedMetadata.worktreeMissions
    };
    const manifestPath = join(temporary!, "manifest.json");
    const manifestDescriptor = openSync(manifestPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, OWNER_ONLY);
    try {
      writeFileSync(manifestDescriptor, `${JSON.stringify(manifest, null, 2)}\n`);
      fsyncSync(manifestDescriptor);
    } finally {
      closeSync(manifestDescriptor);
    }
    chmodSync(manifestPath, OWNER_ONLY);
    syncTree(temporary!, durabilityWarnings);
    if (maybeLstat(outputPath)) throw new Error(`Backup output was created during backup: ${outputPath}`);
    renameSync(temporary!, outputPath);
    temporary = undefined;
    syncPublishedParent(dirname(outputPath), durabilityWarnings);
    return { path: outputPath, files: records.length, controlSchemaVersion: lockedMetadata.controlSchemaVersion, durabilityWarnings: [...durabilityWarnings] };
  } catch (error) {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    throw error;
  } finally {
    releaseLeases(agentLeases);
    releaseLeases(controlLease ? [ownership, controlLease] : [ownership]);
  }
}

function validateWorktreeRecord(value: unknown): BackupManifest["worktrees"][number] {
  if (!isRecord(value) ||
    !exactKeys(value, ["id", "missionId", "kind", "path", "baseCommit", "repositoryPath", "gitCommonDir", "status"], ["branch"]) ||
    typeof value.id !== "string" ||
    typeof value.missionId !== "string" ||
    (value.kind !== "agent" && value.kind !== "validation") ||
    typeof value.path !== "string" ||
    typeof value.baseCommit !== "string" ||
    typeof value.repositoryPath !== "string" ||
    typeof value.gitCommonDir !== "string" ||
    (value.status !== "pending" && value.status !== "ready" && value.status !== "error") ||
    (value.branch !== undefined && typeof value.branch !== "string")) {
    throw new Error("Backup manifest has an invalid worktree record");
  }
  return {
    id: value.id,
    missionId: value.missionId,
    kind: value.kind,
    path: value.path,
    ...(value.branch === undefined ? {} : { branch: value.branch }),
    baseCommit: value.baseCommit,
    repositoryPath: value.repositoryPath,
    gitCommonDir: value.gitCommonDir,
    status: value.status
  };
}

function validateWorktreeMission(value: unknown): WorktreeMission {
  if (!isRecord(value) || !exactKeys(value, ["id", "repository"]) || typeof value.id !== "string" || !isRecord(value.repository) ||
    !exactKeys(value.repository, ["path", "gitCommonDir", "baseCommit"]) ||
    typeof value.repository.path !== "string" ||
    typeof value.repository.gitCommonDir !== "string" ||
    typeof value.repository.baseCommit !== "string") {
    throw new Error("Backup manifest has an invalid worktree Mission record");
  }
  return {
    id: value.id,
    repository: {
      path: value.repository.path,
      gitCommonDir: value.repository.gitCommonDir,
      baseCommit: value.repository.baseCommit
    }
  };
}

function parseManifest(value: unknown): BackupManifest {
  if (!isRecord(value) || !exactKeys(value, [
    "format", "formatVersion", "appVersion", "createdAt", "sourceHome", "controlSchemaVersion", "files", "worktrees", "worktreeMissions"
  ])) throw new Error("Backup manifest has an unsupported structure");
  if (value.format !== BACKUP_FORMAT || value.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup format or version: ${String(value.format)} v${String(value.formatVersion)}`);
  }
  if (typeof value.appVersion !== "string" || !value.appVersion ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.sourceHome !== "string" || !posix.isAbsolute(value.sourceHome) || resolve(value.sourceHome) !== value.sourceHome ||
    typeof value.controlSchemaVersion !== "number" || !Number.isSafeInteger(value.controlSchemaVersion) ||
    value.controlSchemaVersion < 0 || value.controlSchemaVersion > CONTROL_SCHEMA_VERSION ||
    !Array.isArray(value.files) || !Array.isArray(value.worktrees) || !Array.isArray(value.worktreeMissions)) {
    throw new Error("Backup manifest has invalid metadata or an unsupported control schema version");
  }
  const files: FileRecord[] = [];
  for (const file of value.files) {
    if (!isRecord(file) || !exactKeys(file, ["path", "size", "sha256"]) ||
      typeof file.path !== "string" || !safeRelativeFile(file.path) ||
      typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 ||
      typeof file.sha256 !== "string" || !/^[a-f\d]{64}$/.test(file.sha256)) {
      throw new Error("Backup manifest has an invalid file entry");
    }
    files.push({ path: file.path, size: file.size, sha256: file.sha256 });
  }
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1]!.path >= files[index]!.path) throw new Error("Backup manifest file entries must be unique and sorted by path");
  }
  const paths = new Set(files.map((file) => file.path));
  if (paths.size !== files.length || !paths.has("control.sqlite") || !paths.has("admin.token") || paths.has("manifest.json")) {
    throw new Error("Backup manifest is missing required files or contains duplicate paths");
  }
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: value.appVersion,
    createdAt: value.createdAt,
    sourceHome: value.sourceHome,
    controlSchemaVersion: value.controlSchemaVersion,
    files,
    worktrees: value.worktrees.map(validateWorktreeRecord),
    worktreeMissions: value.worktreeMissions.map(validateWorktreeMission)
  };
}

function readRegularText(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`Expected a regular file: ${path}`);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function backupTree(root: string): { files: Set<string>; directories: Set<string> } {
  const files = new Set<string>();
  const directories = new Set<string>();
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) throw new Error(`Backup contains a symlink: ${relativePath}`);
      if (info.isDirectory()) {
        directories.add(relativePath);
        visit(absolute, relativePath);
      } else if (info.isFile()) {
        files.add(relativePath);
      } else {
        throw new Error(`Backup contains a non-regular entry: ${relativePath}`);
      }
    }
  };
  visit(root, "");
  return { files, directories };
}

function expectedDirectories(paths: string[]): Set<string> {
  const result = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) result.add(parts.slice(0, index).join("/"));
  }
  return result;
}

function verifyBackupTree(root: string, manifest: BackupManifest): void {
  const expectedFiles = new Set(["manifest.json", ...manifest.files.map((file) => file.path)]);
  const expectedDirs = expectedDirectories([...expectedFiles]);
  const actual = backupTree(root);
  for (const path of actual.files) {
    if (!expectedFiles.has(path)) throw new Error(`Backup contains an unlisted file: ${path}`);
  }
  for (const path of expectedFiles) {
    if (!actual.files.has(path)) throw new Error(`Backup file is missing: ${path}`);
  }
  for (const path of actual.directories) {
    if (!expectedDirs.has(path)) throw new Error(`Backup contains an unlisted directory: ${path}`);
  }
  for (const path of expectedDirs) {
    if (!actual.directories.has(path)) throw new Error(`Backup directory is missing: ${path}`);
  }
}

function targetState(target: string): "absent" | "empty" {
  const info = maybeLstat(target);
  if (!info) return "absent";
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Restore target must not exist or must be an empty directory: ${target}`);
  if (readdirSync(target).length !== 0) throw new Error(`Restore target is not empty; refusing to overwrite: ${target}`);
  return "empty";
}

function ensureTargetParent(target: string): void {
  const parent = dirname(target);
  let info: ReturnType<typeof statSync> | undefined;
  try {
    info = statSync(parent);
  } catch {}
  if (!info || !info.isDirectory()) {
    throw new Error(`Restore target parent must already exist as a directory: ${parent}`);
  }
}

function readDatabaseWorktreeMetadata(path: string): ReturnType<typeof readWorktreeMetadata> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return readWorktreeMetadata(db);
  } finally {
    db.close();
  }
}

function sameWorktreeMetadata(left: ReturnType<typeof readWorktreeMetadata>, right: ReturnType<typeof readWorktreeMetadata>): boolean {
  return JSON.stringify(left.worktrees) === JSON.stringify(right.worktrees) &&
    JSON.stringify(left.worktreeMissions) === JSON.stringify(right.worktreeMissions);
}

function insertRestoreBlocker(db: DatabaseSync, id: string, missionId: string, kind: "approval" | "unsafe_execution", text: string, createdAt: string): void {
  if (db.prepare("SELECT 1 FROM blockers WHERE id=?").get(id)) return;
  const blocker = { id, missionId, kind, status: "open", text, createdAt };
  db.prepare("INSERT INTO blockers(id,mission_id,status,data) VALUES(?,?,?,?)").run(id, missionId, "open", JSON.stringify(blocker));
}

function quarantineRestoredControl(path: string, manifest: BackupManifest, targetHome: string): void {
  const db = new DatabaseSync(path);
  const restoredAt = new Date().toISOString();
  const messageText = `Restored from backup created at ${manifest.createdAt}. Outside effects may have happened since that backup; compare the real workspace and never replay uncertain operations. Review the evidence before explicit human resolution and resume.`;
  try {
    db.exec("BEGIN IMMEDIATE");
    if (tableExists(db, "remote_machines")) {
      const remoteRows = db.prepare("SELECT id,data FROM remote_machines").all() as Array<{ id: string; data: string }>;
      for (const row of remoteRows) {
        const machine = JSON.parse(row.data) as Record<string, unknown>;
        const sessionEpoch = typeof machine.sessionEpoch === "number" ? machine.sessionEpoch + 1 : 1;
        machine.status = "revoked";
        machine.sessionEpoch = sessionEpoch;
        delete machine.sessionId;
        delete machine.registrationId;
        delete machine.capabilitiesHash;
        delete machine.leaseExpiresAt;
        machine.capabilities = undefined;
        db.prepare("UPDATE remote_machines SET token_hash=?,data=? WHERE id=?").run(
          createHash("sha256").update(randomBytes(32)).digest("hex"),
          JSON.stringify(machine),
          row.id
        );
      }
      if (tableExists(db, "node_commands")) {
        db.prepare("UPDATE node_commands SET status='cancelled',error=?,updated_at=? WHERE status='queued'")
          .run("Restored backup revoked node authority before this command was claimed", Date.now());
        db.prepare("UPDATE node_commands SET status='uncertain',error=?,updated_at=? WHERE status='dispatched'")
          .run("Restored backup revoked node authority while this command was dispatched; outcome is unknown and it will not be replayed", Date.now());
      }
    }
    if (tableExists(db, "worker_mailbox_meta")) new DurableWorkerMailbox(db, "coordinator").recover();
    const artifacts = tableExists(db, "artifacts")
      ? db.prepare("SELECT id,data FROM artifacts").all() as Array<{ id: string; data: string }>
      : [];
    const filesByPath = new Map(manifest.files.map((file) => [file.path, file]));
    for (const row of artifacts) {
      const artifact = JSON.parse(row.data) as Record<string, unknown>;
      if (artifact.snapshotPath === undefined) continue;
      if (typeof artifact.sha256 !== "string" || !/^[a-f\d]{64}$/.test(artifact.sha256) ||
        artifact.snapshotPath !== join(manifest.sourceHome, "artifacts", artifact.sha256)) {
        throw new Error(`Artifact ${row.id} has a snapshotPath outside the daemon-owned content-addressed artifact store`);
      }
      const snapshot = filesByPath.get(`artifacts/${artifact.sha256}`);
      if (!snapshot || snapshot.sha256 !== artifact.sha256 || typeof artifact.size !== "number" || snapshot.size !== artifact.size) {
        throw new Error(`Artifact ${row.id} snapshot is missing from the backup or does not match its SHA-256`);
      }
      if (resolve(targetHome) !== manifest.sourceHome) {
        artifact.snapshotPath = join(targetHome, "artifacts", artifact.sha256);
        db.prepare("UPDATE artifacts SET data=? WHERE id=?").run(JSON.stringify(artifact), row.id);
      }
    }

    const missions = tableExists(db, "missions")
      ? db.prepare("SELECT id,status,data FROM missions WHERE status IN ('active','validating','paused','blocked','failed')").all() as Array<{ id: string; status: string; data: string }>
      : [];
    if (missions.length && ["blockers", "events", "outbox", "messages", "approvals"].some((table) => !tableExists(db, table))) {
      throw new Error("Cannot safely quarantine restored Missions because required control tables are missing");
    }
    const hasDeadlineAt = tableHasColumn(db, "outbox", "deadline_at");
    const updateOutboxUncertain = db.prepare(hasDeadlineAt
      ? "UPDATE outbox SET status='uncertain',deadline_at=NULL WHERE id=?"
      : "UPDATE outbox SET status='uncertain' WHERE id=?");
    for (const row of missions) {
      const mission = JSON.parse(row.data) as Record<string, unknown>;
      mission.status = "blocked";
      mission.updatedAt = restoredAt;
      db.prepare("UPDATE missions SET status='blocked',data=? WHERE id=?").run(JSON.stringify(mission), row.id);

      const blockerId = `restore-reconciliation:${randomUUID()}`;
      insertRestoreBlocker(db, blockerId, row.id, "unsafe_execution", messageText, restoredAt);

      const approvals = db.prepare("SELECT id,data FROM approvals WHERE mission_id=? AND status IN ('pending','approved','running')").all(row.id) as Array<{ id: string; data: string }>;
      for (const approvalRow of approvals) {
        const approval = JSON.parse(approvalRow.data);
        if (!isRecord(approval)) throw new Error(`Approval ${approvalRow.id} has invalid stored data; refusing to publish the restore`);
        const previousStatus = approval.status;
        approval.status = "uncertain";
        db.prepare("UPDATE approvals SET status='uncertain',data=? WHERE id=?").run(JSON.stringify(approval), approvalRow.id);
        insertRestoreBlocker(
          db,
          `approval:${approvalRow.id}`,
          row.id,
          "approval",
          `Approval ${approvalRow.id} was ${String(previousStatus)} in the backup and may have taken effect outside Mission Control. Review its receipt and real workspace; never replay it. Backup created at ${manifest.createdAt}.`,
          restoredAt
        );
      }

      const pending = db.prepare("SELECT id,message_id FROM outbox WHERE mission_id=? AND status IN ('queued','dispatching','admitted')").all(row.id) as Array<{ id: string; message_id: string }>;
      for (const outbox of pending) {
        updateOutboxUncertain.run(outbox.id);
        const messageRow = db.prepare("SELECT status,data FROM messages WHERE id=?").get(outbox.message_id) as { status: string; data: string } | undefined;
        if (messageRow && !["delivered", "failed", "uncertain"].includes(messageRow.status)) {
          const message = JSON.parse(messageRow.data) as Record<string, unknown>;
          message.status = "uncertain";
          message.error = messageText;
          db.prepare("UPDATE messages SET status='uncertain',data=? WHERE id=?").run(JSON.stringify(message), outbox.message_id);
        }
      }

      const abortedMessages = db.prepare("SELECT id,data FROM messages WHERE mission_id=? AND status='aborted'").all(row.id) as Array<{ id: string; data: string }>;
      for (const messageRow of abortedMessages) {
        const message = JSON.parse(messageRow.data) as Record<string, unknown>;
        message.status = "uncertain";
        message.error = messageText;
        db.prepare("UPDATE messages SET status='uncertain',data=? WHERE id=?").run(JSON.stringify(message), messageRow.id);
      }
      const abortedOutbox = db.prepare(`
        SELECT o.id FROM outbox o
        JOIN messages m ON m.id=o.message_id
        WHERE o.mission_id=? AND o.status='aborted' AND m.status='uncertain'
      `).all(row.id) as Array<{ id: string }>;
      for (const outbox of abortedOutbox) updateOutboxUncertain.run(outbox.id);

      const event = { missionId: row.id, type: "restore_reconciliation_required", text: messageText, createdAt: restoredAt, data: { blockerId, backupCreatedAt: manifest.createdAt } };
      db.prepare("INSERT INTO events(mission_id,type,data) VALUES(?,?,?)").run(row.id, event.type, JSON.stringify(event));
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

export function restoreHome(from: string, targetHome: string): RestoreSummary {
  const backupPath = resolve(from);
  requireDirectory(backupPath, "Backup source");
  const requestedTarget = resolve(targetHome);
  ensureTargetParent(requestedTarget);
  const target = join(realpathSync(dirname(requestedTarget)), basename(requestedTarget));
  const initialTargetState = targetState(target);
  const manifestPath = join(backupPath, "manifest.json");
  requireRegularFile(manifestPath, "Backup manifest");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(readRegularText(manifestPath));
  } catch (error) {
    throw new Error(`Backup manifest cannot be read: ${errorMessage(error)}`);
  }
  const manifest = parseManifest(manifestValue);
  verifyBackupTree(backupPath, manifest);
  for (const file of manifest.files) {
    const actual = digestOrCopyFile(join(backupPath, ...file.path.split("/")));
    if (actual.size !== file.size || actual.sha256 !== file.sha256) {
      throw new Error(`Backup file failed size or SHA-256 verification: ${file.path}`);
    }
  }
  const controlVersion = checkIntegrity(join(backupPath, "control.sqlite"));
  if (controlVersion !== manifest.controlSchemaVersion || controlVersion > CONTROL_SCHEMA_VERSION) {
    throw new Error(`Backup control database schema ${controlVersion} does not match its manifest or exceeds this build's maximum ${CONTROL_SCHEMA_VERSION}`);
  }
  const databaseWorktrees = readDatabaseWorktreeMetadata(join(backupPath, "control.sqlite"));
  const manifestWorktrees = { worktrees: manifest.worktrees, worktreeMissions: manifest.worktreeMissions };
  if (!sameWorktreeMetadata(databaseWorktrees, manifestWorktrees)) {
    throw new Error("Backup manifest worktree metadata does not match the verified control database");
  }
  const hasWorktrees = databaseWorktrees.worktrees.length > 0 || databaseWorktrees.worktreeMissions.length > 0;
  if (hasWorktrees && target !== manifest.sourceHome) {
    throw new Error(`This backup contains absolute worktree paths bound to ${manifest.sourceHome}; restore there after moving the old home aside`);
  }

  let temporary: string | undefined = mkdtempSync(`${target}.partial-`);
  chmodSync(temporary, PRIVATE_DIRECTORY);
  let removedEmptyTarget = false;
  const durabilityWarnings = new Set<string>();
  try {
    for (const file of manifest.files) {
      const source = join(backupPath, ...file.path.split("/"));
      const destination = ensurePrivateParents(temporary, file.path);
      const actual = digestOrCopyFile(source, destination);
      if (actual.size !== file.size || actual.sha256 !== file.sha256) {
        throw new Error(`Backup file changed during restore: ${file.path}`);
      }
    }
    quarantineRestoredControl(join(temporary, "control.sqlite"), manifest, target);
    const restoredVersion = checkIntegrity(join(temporary, "control.sqlite"), manifest.controlSchemaVersion);
    if (restoredVersion !== controlVersion) throw new Error("Restored control database has an unexpected schema version");
    syncTree(temporary, durabilityWarnings);
    const currentTargetState = targetState(target);
    if (initialTargetState === "empty" && currentTargetState !== "empty") {
      throw new Error(`Restore target changed during restore: ${target}`);
    }
    if (currentTargetState === "empty") {
      rmdirSync(target);
      removedEmptyTarget = true;
    }
    if (maybeLstat(target)) throw new Error(`Restore target was created during restore: ${target}`);
    renameSync(temporary, target);
    temporary = undefined;
    syncPublishedParent(dirname(target), durabilityWarnings);
    return { path: target, files: manifest.files.length, sourceHome: manifest.sourceHome, appVersion: manifest.appVersion, durabilityWarnings: [...durabilityWarnings] };
  } catch (error) {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    if (removedEmptyTarget && !maybeLstat(target)) {
      try { mkdirSync(target, { mode: PRIVATE_DIRECTORY }); } catch {}
    }
    throw error;
  }
}
