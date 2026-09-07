#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
project_root="${script_dir:h}"
broker_path="${project_root}/target/release/meet-bridge-native-broker"
host_dir="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
host_manifest="${host_dir}/com.meetbridge.hub.json"

if [[ ! -x "${broker_path}" ]]; then
  print -u2 "Native Broker not found: ${broker_path}"
  exit 1
fi

mkdir -p "${host_dir}"
umask 077
cat > "${host_manifest}" <<EOF
{
  "name": "com.meetbridge.hub",
  "description": "Meet Bridge Hub native broker",
  "path": "${broker_path}",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://ancoaojdjchmllenalcmmkgndahancgp/"]
}
EOF
chmod 600 "${host_manifest}"
print "Installed ${host_manifest}"
