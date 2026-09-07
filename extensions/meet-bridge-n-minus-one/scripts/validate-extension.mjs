import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseFiles } from "./release-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const errors = [];

if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version || "")) {
  errors.push("manifest version must use x.y.z format");
}
if (packageJson.version !== manifest.version) {
  errors.push("package.json version must match manifest.json");
}

const releaseTag = process.env.RELEASE_TAG || "";
if (releaseTag && releaseTag !== `v${manifest.version}`) {
  errors.push(`tag ${releaseTag} does not match manifest v${manifest.version}`);
}

for (const file of releaseFiles) {
  try {
    if (!(await stat(join(root, file))).isFile()) errors.push(`${file} is not a file`);
  } catch {
    errors.push(`missing release file: ${file}`);
  }
}

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
  ...(manifest.web_accessible_resources || []).flatMap(
    (entry) => entry.resources || [],
  ),
].filter(Boolean);
for (const file of referencedFiles) {
  if (!releaseFiles.includes(file)) errors.push(`manifest reference not packaged: ${file}`);
}

const forbiddenNames = [
  /meet-bridge-diagnostic-/i,
  /codex-clipboard/i,
  /(^|\/)\.env($|\.)/i,
  /\.(?:log|pem|key|p12|pfx)$/i,
];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /gh[oprsu]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "dist", "node_modules"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

for (const path of await walk(root)) {
  const name = relative(root, path);
  if (forbiddenNames.some((pattern) => pattern.test(name))) {
    errors.push(`forbidden private artifact: ${name}`);
    continue;
  }
  const info = await stat(path);
  if (info.size > 2_000_000) continue;
  const content = await readFile(path, "utf8").catch(() => "");
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    errors.push(`possible secret in: ${name}`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Validated Meet Bridge N-1 v${manifest.version}`);
console.log(`${releaseFiles.length} runtime files are explicitly allowlisted`);
