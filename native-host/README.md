# The Collector native host (Linux only)

Python stdlib host that converts `the-collector-export.zip` to AZW3 via
Calibre's `ebook-convert`. Called from the extension with Chrome Native
Messaging (`chrome.runtime.sendNativeMessage`).

## Prerequisites

- python3
- Calibre (`ebook-convert` on PATH, or at `/usr/bin/ebook-convert`,
  `/usr/local/bin/ebook-convert`, `/opt/calibre/bin/ebook-convert`)
- Chrome/Chromium + the extension loaded from `dist/`

## Install

1. `npm run build`, load `dist/` at `chrome://extensions` (Developer mode).
2. Copy the extension ID shown on that page.
3. Register the host:

```bash
./native-host/install.sh --extension-id <PASTE_ID_HERE>
```

This copies `the-collector-host.py` to `~/.local/bin/the-collector-host`
(make executable) and writes the host manifest to each browser channel:

- `~/.config/google-chrome/NativeMessagingHosts/com.thecollector.converter.json`
- `~/.config/chromium/NativeMessagingHosts/com.thecollector.converter.json`
- `~/.config/google-chrome-for-testing/NativeMessagingHosts/com.thecollector.converter.json`

## Protocol

Request:

```json
{"action": "convert", "zipPath": "/home/user/Downloads/the-collector-export.zip"}
```

Success:

```json
{"success": true, "outputPath": "/home/user/Downloads/reading_list_2026-09-10_14-10.azw3"}
```

Failure:

```json
{"success": false, "error": "human-readable reason"}
```

## Manual test (no Chrome)

```bash
printf '%s' '{"action":"convert","zipPath":"/path/to/the-collector-export.zip"}' \
  | python3 -c 'import json,struct,sys; p=sys.stdin.read().encode(); sys.stdout.buffer.write(struct.pack("<I",len(p))+p)' \
  | ./native-host/the-collector-host.py \
  | python3 -c 'import struct,sys,json; d=sys.stdin.buffer.read(); n=struct.unpack("<I",d[:4])[0]; print(json.loads(d[4:4+n].decode()))'
```

Or use `native-host/test-roundtrip.sh` (uses a fake zip — expects a
"does not contain combined.html" error, which proves framing works).

## Debugging

- Host logs go to stderr; watch Chrome's stderr by launching Chrome from a
  terminal. Common Chrome errors: "Specified native messaging host not
  found" (wrong ID/path/channel), "Access ... is forbidden" (allowed_origins
  mismatch), "Error when communicating" (stdout polluted — this host never
  prints to stdout except protocol frames).
- `chmod +x` on the host is required.
- If the extension ID changes (new unpacked load without a pinned `key`),
  re-run `install.sh` with the new ID.

## Uninstall

```bash
./native-host/uninstall.sh
```
