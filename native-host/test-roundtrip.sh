#!/usr/bin/env bash
# Framing smoke test: sends a convert request for a fake zip through the host
# and prints the decoded response. Expects success:false (missing combined.html
# or missing zip), which proves stdin/stdout framing works without Chrome.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$SCRIPT_DIR/.tmp-test"
mkdir -p "$TMP"
FAKE_ZIP="$TMP/fake-export.zip"
python3 -c "import zipfile; zipfile.ZipFile('$FAKE_ZIP','w').writestr('hello.txt','hi')"
REQ=$(printf '{"action":"convert","zipPath":"%s"}' "$FAKE_ZIP")
printf '%s' "$REQ" \
  | python3 -c 'import struct,sys; p=sys.stdin.read().encode(); sys.stdout.buffer.write(struct.pack("<I",len(p))+p)' \
  | python3 "$SCRIPT_DIR/the-collector-host.py" \
  | python3 -c 'import struct,sys,json; d=sys.stdin.buffer.read(); n=struct.unpack("<I",d[:4])[0]; print(json.dumps(json.loads(d[4:4+n].decode()),indent=2))'
rm -rf "$TMP"
