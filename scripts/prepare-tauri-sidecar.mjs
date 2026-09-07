#!/usr/bin/env node
/**
 * Builds the native messaging broker for the host platform and stages it as a
 * Tauri resource. Kept platform-neutral so `cargo tauri build` works on both
 * macOS and Windows runners.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDirectory);
const binaryName = process.platform === "win32"
  ? "meet-bridge-native-broker.exe"
  : "meet-bridge-native-broker";
const brokerPath = join(projectRoot, "target", "release", binaryName);
const resourceDirectory = join(
  projectRoot,
  "apps",
  "tauri-app",
  "src-tauri",
  "resources",
);
const stagedPath = join(resourceDirectory, binaryName);

execFileSync(
  "cargo",
  ["build", "--release", "-p", "meet-bridge-native-broker"],
  { cwd: projectRoot, stdio: "inherit" },
);

if (!existsSync(brokerPath)) {
  throw new Error(`Native Broker build did not produce an executable: ${brokerPath}`);
}

mkdirSync(resourceDirectory, { recursive: true });
copyFileSync(brokerPath, stagedPath);
