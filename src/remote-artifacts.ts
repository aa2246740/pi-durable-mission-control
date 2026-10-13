import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Artifact } from "./contracts.js";
import { parseNodeEffectSpec, type NodeEffectSpec } from "./node-effects.js";

export const REMOTE_ARTIFACT_CHUNK_BYTES = 192 * 1024;
export const REMOTE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

export interface RemoteArtifactManifest {
  sourcePath: string;
  relativePath: string;
  size: number;
  sha256: string;
}

type TransferRow = {
  transfer_id: string;
  spec_json: string;
  manifest_json: string;
  next_offset: number;
  status: "uploading" | "complete";
  artifact_json: string | null;
};

type ChunkRow = { byte_offset: number; sha256: string; bytes: Uint8Array };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function remoteArtifactTransferId(rawSpec: unknown, rawManifest: unknown): string {
  const spec = parseNodeEffectSpec(rawSpec);
  const manifest = parseRemoteArtifactManifest(rawManifest);
  if (!spec || spec.method !== "PublishArtifact" || !manifest) fail("Invalid remote artifact transfer identity");
  return digest(canonical(spec));
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseRemoteArtifactManifest(value: unknown): RemoteArtifactManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (Reflect.ownKeys(item).length !== 4 || !["sourcePath", "relativePath", "size", "sha256"].every((key) => Object.hasOwn(item, key))) return undefined;
  if (typeof item.sourcePath !== "string" || !item.sourcePath.startsWith("/") || item.sourcePath.length > 4096 || /\p{Cc}/u.test(item.sourcePath)) return undefined;
  if (typeof item.relativePath !== "string" || !item.relativePath || item.relativePath.length > 4096 ||
      item.relativePath.includes("\\") || item.relativePath.startsWith("/") || /\p{Cc}/u.test(item.relativePath) ||
      item.relativePath.split("/").some((part) => !part || part === "." || part === "..")) return undefined;
  if (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > REMOTE_ARTIFACT_MAX_BYTES) return undefined;
  if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) return undefined;
  return { sourcePath: item.sourcePath, relativePath: item.relativePath, size: item.size, sha256: item.sha256 };
}

function checkedSpec(value: unknown): NodeEffectSpec {
  const spec = parseNodeEffectSpec(value);
  if (!spec || spec.method !== "PublishArtifact") return fail("Remote artifact transfer requires a PublishArtifact effect");
  return spec;
}

export class RemoteArtifactStore {
  constructor(private readonly db: DatabaseSync, private readonly home: string) {
    RemoteArtifactStore.migrate(db);
  }

  static migrate(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS remote_artifact_transfers(
      transfer_id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, manifest_json TEXT NOT NULL,
      next_offset INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('uploading','complete')),
      artifact_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS remote_artifact_chunks(
      transfer_id TEXT NOT NULL REFERENCES remote_artifact_transfers(transfer_id),
      byte_offset INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY(transfer_id,byte_offset)
    )`);
  }

  private atomic<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT remote_artifact_store");
    try {
      const value = fn();
      this.db.exec("RELEASE remote_artifact_store");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK TO remote_artifact_store"); } finally { this.db.exec("RELEASE remote_artifact_store"); }
      throw error;
    }
  }

  private identity(rawSpec: unknown, rawManifest: unknown): {
    spec: NodeEffectSpec; manifest: RemoteArtifactManifest; specJson: string; manifestJson: string; transferId: string;
  } {
    const spec = checkedSpec(rawSpec);
    const manifest = parseRemoteArtifactManifest(rawManifest);
    if (!manifest) fail("Invalid remote artifact manifest");
    const specJson = canonical(spec), manifestJson = canonical(manifest);
    return { spec, manifest, specJson, manifestJson, transferId: remoteArtifactTransferId(spec, manifest) };
  }

  private ensure(identity: ReturnType<RemoteArtifactStore["identity"]>): TransferRow {
    let row = this.db.prepare("SELECT * FROM remote_artifact_transfers WHERE transfer_id=?").get(identity.transferId) as TransferRow | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO remote_artifact_transfers(transfer_id,spec_json,manifest_json,next_offset,status,artifact_json,created_at,updated_at) VALUES(?,?,?,0,'uploading',NULL,?,?)")
        .run(identity.transferId, identity.specJson, identity.manifestJson, Date.now(), Date.now());
      row = this.db.prepare("SELECT * FROM remote_artifact_transfers WHERE transfer_id=?").get(identity.transferId) as TransferRow;
    }
    if (row.spec_json !== identity.specJson || row.manifest_json !== identity.manifestJson) fail("Remote artifact transfer identity conflicts");
    return row;
  }

  chunk(rawSpec: unknown, rawManifest: unknown, offset: number, bytes: Buffer): { transferId: string; offset: number; bytes: number; duplicate: boolean } {
    const identity = this.identity(rawSpec, rawManifest);
    if (!Number.isSafeInteger(offset) || offset < 0 || bytes.length < 1 || bytes.length > REMOTE_ARTIFACT_CHUNK_BYTES ||
        offset + bytes.length > identity.manifest.size) fail("Invalid remote artifact chunk");
    return this.atomic(() => {
      const row = this.ensure(identity);
      const sha = digest(bytes);
      const previous = this.db.prepare("SELECT sha256,bytes FROM remote_artifact_chunks WHERE transfer_id=? AND byte_offset=?")
        .get(identity.transferId, offset) as ChunkRow | undefined;
      if (previous) {
        if (previous.sha256 !== sha || !Buffer.from(previous.bytes).equals(bytes)) fail("Conflicting remote artifact chunk retransmission");
        return { transferId: identity.transferId, offset, bytes: bytes.length, duplicate: true };
      }
      if (row.status !== "uploading" || offset !== row.next_offset) fail("Remote artifact chunk has a gap, overlap, or terminal transfer");
      this.db.prepare("INSERT INTO remote_artifact_chunks(transfer_id,byte_offset,sha256,bytes) VALUES(?,?,?,?)")
        .run(identity.transferId, offset, sha, bytes);
      this.db.prepare("UPDATE remote_artifact_transfers SET next_offset=?,updated_at=? WHERE transfer_id=?")
        .run(offset + bytes.length, Date.now(), identity.transferId);
      return { transferId: identity.transferId, offset, bytes: bytes.length, duplicate: false };
    });
  }

  complete(rawSpec: unknown, rawManifest: unknown, create: (casPath: string, transferId: string) => Artifact, save: (artifact: Artifact) => void): Artifact {
    const identity = this.identity(rawSpec, rawManifest);
    return this.atomic(() => {
      const row = this.ensure(identity);
      if (row.status === "complete") {
        if (!row.artifact_json) fail("Completed remote artifact has no durable record");
        return JSON.parse(row.artifact_json) as Artifact;
      }
      if (row.next_offset !== identity.manifest.size) fail("Remote artifact upload is incomplete");
      const casPath = this.installCas(identity.transferId, identity.manifest);
      const artifact = create(casPath, identity.transferId);
      save(artifact);
      this.db.prepare("UPDATE remote_artifact_transfers SET status='complete',artifact_json=?,updated_at=? WHERE transfer_id=?")
        .run(JSON.stringify(artifact), Date.now(), identity.transferId);
      return artifact;
    });
  }

  private installCas(transferId: string, manifest: RemoteArtifactManifest): string {
    this.verifyIncomingChunks(transferId, manifest);
    const casDir = join(resolve(this.home), "artifacts");
    const staging = join(resolve(this.home), "remote-artifact-staging");
    mkdirSync(casDir, { recursive: true, mode: 0o700 });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    chmodSync(casDir, 0o700);
    chmodSync(staging, 0o700);
    const casPath = join(casDir, manifest.sha256);
    const casStat = (() => {
      try { return lstatSync(casPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      }
    })();
    if (casStat) {
      if (casStat.isSymbolicLink() || !casStat.isFile()) fail("Existing CAS entry is not a regular file");
      const fd = openSync(casPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const hash = createHash("sha256");
      let size = 0;
      const chunk = Buffer.alloc(REMOTE_ARTIFACT_CHUNK_BYTES);
      try {
        const before = fstatSync(fd);
        if (!before.isFile() || before.size !== manifest.size) fail("Existing CAS entry is not a regular file of the expected size");
        let count = 0;
        while ((count = readSync(fd, chunk, 0, Math.min(chunk.length, manifest.size - size + 1), null)) > 0) {
          size += count;
          if (size > manifest.size) fail("Existing CAS entry grew beyond the expected size");
          hash.update(chunk.subarray(0, count));
        }
        const after = fstatSync(fd);
        if (after.size !== manifest.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
          fail("Existing CAS entry changed while being verified");
        }
      } finally { closeSync(fd); }
      if (size !== manifest.size || hash.digest("hex") !== manifest.sha256) fail("Existing CAS content does not match its digest");
      chmodSync(casPath, 0o400);
      return casPath;
    }
    const tempPath = join(staging, `${transferId}.${randomUUID()}.tmp`);
    const fd = openSync(tempPath, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      const rows = this.db.prepare("SELECT byte_offset,sha256,bytes FROM remote_artifact_chunks WHERE transfer_id=? ORDER BY byte_offset")
        .iterate(transferId) as Iterable<ChunkRow>;
      for (const row of rows) {
        const bytes = Buffer.from(row.bytes);
        if (row.byte_offset !== size || bytes.length < 1 || bytes.length > REMOTE_ARTIFACT_CHUNK_BYTES ||
            bytes.length > manifest.size - size || digest(bytes) !== row.sha256) {
          fail("Persisted remote artifact chunks are not contiguous or valid");
        }
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) fail("CAS staging write made no progress");
          offset += written;
        }
        size += bytes.length;
        hash.update(bytes);
      }
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      try { unlinkSync(tempPath); } catch {}
      throw error;
    }
    closeSync(fd);
    if (size !== manifest.size || hash.digest("hex") !== manifest.sha256) {
      unlinkSync(tempPath);
      fail("Remote artifact size or digest did not match the manifest");
    }
    try {
      linkSync(tempPath, casPath);
      unlinkSync(tempPath);
      chmodSync(casPath, 0o400);
      const finalFd = openSync(casPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { fsyncSync(finalFd); } finally { closeSync(finalFd); }
      const directoryFd = openSync(casDir, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) {
      try { unlinkSync(tempPath); } catch {}
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.installCas(transferId, manifest);
    }
    return casPath;
  }

  private verifyIncomingChunks(transferId: string, manifest: RemoteArtifactManifest): void {
    const hash = createHash("sha256");
    let size = 0;
    const rows = this.db.prepare("SELECT byte_offset,sha256,bytes FROM remote_artifact_chunks WHERE transfer_id=? ORDER BY byte_offset")
      .iterate(transferId) as Iterable<ChunkRow>;
    for (const row of rows) {
      const bytes = Buffer.from(row.bytes);
      if (row.byte_offset !== size || bytes.length < 1 || bytes.length > REMOTE_ARTIFACT_CHUNK_BYTES ||
          bytes.length > manifest.size - size || digest(bytes) !== row.sha256) {
        fail("Persisted remote artifact chunks are not contiguous or valid");
      }
      size += bytes.length;
      hash.update(bytes);
    }
    if (size !== manifest.size || hash.digest("hex") !== manifest.sha256) {
      fail("Remote artifact size or digest did not match the manifest");
    }
  }
}
