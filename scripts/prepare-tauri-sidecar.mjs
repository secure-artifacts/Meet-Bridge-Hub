import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const requestedTarget = process.env.MEET_BRIDGE_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET;
const executableName = process.platform === "win32"
  ? "meet-bridge-native-broker.exe"
  : "meet-bridge-native-broker";
const cargoArgs = ["build", "--release", "-p", "meet-bridge-native-broker"];
if (requestedTarget) cargoArgs.push("--target", requestedTarget);

const cargo = process.env.CARGO || "cargo";
const build = spawnSync(cargo, cargoArgs, {
  cwd: projectRoot,
  stdio: "inherit",
  shell: false,
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const brokerPath = requestedTarget
  ? join(projectRoot, "target", requestedTarget, "release", executableName)
  : join(projectRoot, "target", "release", executableName);
if (!existsSync(brokerPath)) {
  throw new Error(`Native Broker build did not produce an executable: ${brokerPath}`);
}

const resourceDir = join(projectRoot, "apps", "tauri-app", "src-tauri", "resources");
mkdirSync(resourceDir, { recursive: true });
copyFileSync(brokerPath, join(resourceDir, executableName));