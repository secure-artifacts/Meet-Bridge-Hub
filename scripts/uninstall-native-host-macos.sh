#!/bin/zsh
set -euo pipefail

host_manifest="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.meetbridge.hub.json"
if [[ -f "${host_manifest}" ]]; then
  rm -f "${host_manifest}"
fi
