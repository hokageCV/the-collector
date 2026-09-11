#!/usr/bin/env bash
# Install The Collector native messaging host (Linux only).
# Usage: ./install.sh --extension-id <ID> [--host-path <path>] [--chrome-only|--chromium-only|--brave-only]
set -euo pipefail

EXTENSION_ID=""
HOST_PATH="$HOME/.local/bin/the-collector-host"
# Full config-dir prefixes; manifest goes in <prefix>/NativeMessagingHosts/.
CHANNELS=("google-chrome" "chromium" "google-chrome-for-testing" "BraveSoftware/Brave-Browser")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id) EXTENSION_ID="${2:-}"; shift 2 ;;
    --host-path) HOST_PATH="${2:-}"; shift 2 ;;
    --chrome-only) CHANNELS=("google-chrome"); shift ;;
    --chromium-only) CHANNELS=("chromium"); shift ;;
    --brave-only) CHANNELS=("BraveSoftware/Brave-Browser"); shift ;;
    -h|--help)
      echo "Usage: $0 --extension-id <ID> [--host-path <path>]"
      echo "Find the ID at chrome://extensions (Developer mode) for The Collector."
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$EXTENSION_ID" ]]; then
  echo "Missing --extension-id. Find it at chrome://extensions (Developer mode)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/the-collector-host.py"

mkdir -p "$(dirname "$HOST_PATH")"
cp "$SRC" "$HOST_PATH"
chmod +x "$HOST_PATH"

for channel in "${CHANNELS[@]}"; do
  dest="$HOME/.config/$channel/NativeMessagingHosts/com.thecollector.converter.json"
  mkdir -p "$(dirname "$dest")"
  sed -e "s#__HOST_PATH__#$HOST_PATH#" -e "s#__EXTENSION_ID__#$EXTENSION_ID#" \
    "$SCRIPT_DIR/com.thecollector.converter.json.template" > "$dest"
  echo "wrote $dest"
done

echo "Host installed at $HOST_PATH for extension $EXTENSION_ID"
echo "Requirements: python3, Calibre (ebook-convert on PATH)."
