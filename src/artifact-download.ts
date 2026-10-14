import type { Artifact } from "./contracts.js";

function safeName(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Cs}<>:"/\\|?*'`]/gu, "").trim();
}

export function artifactDownloadName(artifact: Pick<Artifact, "id" | "relativePath" | "path" | "name">): string {
  for (const path of [artifact.relativePath, artifact.path]) {
    const name = safeName(path?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "");
    if (name && name !== "." && name !== "..") return name;
  }
  const name = safeName(artifact.name);
  if (name && name !== "." && name !== "..") return name;
  return `artifact-${safeName(artifact.id) || "unknown"}`;
}

export function artifactContentDisposition(artifact: Pick<Artifact, "id" | "relativePath" | "path" | "name">): string {
  const name = artifactDownloadName(artifact);
  // Percent escapes in filename are interpreted inconsistently by browsers.
  const asciiName = name.replace(/[^\x20-\x7e]|%/gu, "_");
  const encodedName = encodeURIComponent(name).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}
