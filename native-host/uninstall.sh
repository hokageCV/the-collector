#!/usr/bin/env bash
# Remove The Collector native messaging host registrations (Linux only).
set -euo pipefail

for channel in google-chrome chromium google-chrome-for-testing BraveSoftware/Brave-Browser; do
  target="$HOME/.config/$channel/NativeMessagingHosts/com.thecollector.converter.json"
  if [[ -f "$target" ]]; then
    rm "$target"
    echo "removed $target"
  fi
done

if [[ -f "$HOME/.local/bin/the-collector-host" ]]; then
  echo "Keep $HOME/.local/bin/the-collector-host? Delete it manually if unwanted."
fi
