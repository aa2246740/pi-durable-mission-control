import { posix } from "node:path";

export const REMOTE_ARTIFACT_PATH_ERROR = "PublishArtifact path must be a safe file path inside the remote workspace, for example totals.mjs or /work/totals.mjs. Do not use .., backslashes, empty components, or control characters.";

export function normalizeRemoteArtifactPath(path: string, workspacePath: string): string {
  const root = posix.resolve(workspacePath);
  let relative = path;
  if (path.startsWith("/")) {
    const prefix = root === "/" ? root : `${root}/`;
    if (!path.startsWith(prefix)) throw new Error(REMOTE_ARTIFACT_PATH_ERROR);
    relative = path.slice(prefix.length);
  }
  if (!relative.trim() || path.length > 4096 || path.includes("\\") || /\p{Cc}/u.test(path) ||
      relative.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(REMOTE_ARTIFACT_PATH_ERROR);
  }
  return relative;
}
