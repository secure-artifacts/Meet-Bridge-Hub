#!/bin/zsh
# Build the Native Messaging broker and stage it under Tauri's required
# architecture-qualified sidecar name. The staged file is intentionally
# generated at build time and is not source-controlled.
set -euo pipefail

script_dir="${0:A:h}"
project_root="${script_dir:h}"
tauri_dir="${project_root}/apps/tauri-app/src-tauri"
resource_dir="${tauri_dir}/resources"
broker_name="meet-bridge-native-broker"
target_triple="${MEET_BRIDGE_TARGET_TRIPLE:-$(rustc -vV | awk '/^host: / { print $2 }')}"

if [[ -z "${target_triple}" ]]; then
  print -u2 "Unable to determine the Rust target triple."
  exit 1
fi

if [[ -n "${MEET_BRIDGE_TARGET_TRIPLE:-}" ]]; then
  cargo build --release --target "${target_triple}" -p "${broker_name}"
  broker_path="${project_root}/target/${target_triple}/release/${broker_name}"
else
  cargo build --release -p "${broker_name}"
  broker_path="${project_root}/target/release/${broker_name}"
fi

if [[ ! -x "${broker_path}" ]]; then
  print -u2 "Native Broker build did not produce an executable: ${broker_path}"
  exit 1
fi

mkdir -p "${resource_dir}"
install -m 755 "${broker_path}" "${resource_dir}/${broker_name}"
