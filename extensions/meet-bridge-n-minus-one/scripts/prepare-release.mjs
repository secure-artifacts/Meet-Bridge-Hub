import { cp, mkdir, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseFiles } from "./release-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "extension");
const reproducibleTime = new Date("1980-01-01T00:00:00.000Z");

await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of releaseFiles) {
  const target = join(output, file);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, file), target);
  await utimes(target, reproducibleTime, reproducibleTime);
}

console.log(`Prepared ${releaseFiles.length} files in dist/extension`);
