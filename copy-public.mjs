import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const source = new URL("./public/", import.meta.url);
const destination = new URL("./dist/public/", import.meta.url);

try {
  const entries = await readdir(source);
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    await cp(new URL(entry, source), new URL(entry, destination), { recursive: true });
  }
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    process.exit(0);
  }
  throw error;
}
