#!/usr/bin/env python3
"""The Collector native messaging host (Linux).

Reads length-prefixed UTF-8 JSON messages on stdin, converts the exported
ZIP via Calibre's `ebook-convert`, and writes length-prefixed JSON responses
on stdout. stdout is protocol-only; diagnostics go to stderr.
"""

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

EBOOK_CONVERT_FALLBACKS = [
    "/usr/bin/ebook-convert",
    "/usr/local/bin/ebook-convert",
    "/opt/calibre/bin/ebook-convert",
    str(Path.home() / ".local" / "bin" / "ebook-convert"),
    "/opt/calibre/ebook-convert",
]

CONVERT_TIMEOUT_S = 300


def log(msg: str) -> None:
    print(f"[the-collector-host] {msg}", file=sys.stderr, flush=True)


def read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        return None  # EOF
    if len(raw_len) < 4:
        raise ValueError("truncated message length prefix")
    (length,) = struct.unpack("<I", raw_len)
    if length == 0:
        raise ValueError("empty message")
    payload = b""
    while len(payload) < length:
        chunk = sys.stdin.buffer.read(length - len(payload))
        if not chunk:
            raise ValueError("truncated message payload")
        payload += chunk
    return json.loads(payload.decode("utf-8"))


def write_message(obj: dict) -> None:
    payload = json.dumps(obj).encode("utf-8")
    if len(payload) > 1024 * 1024:
        # Chrome caps host -> browser messages at 1 MiB. Truncate error text.
        obj = {"success": False, "error": str(obj.get("error", "response too large"))[:900]}
        payload = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def find_ebook_convert() -> str | None:
    found = shutil.which("ebook-convert")
    if found:
        return found
    for candidate in EBOOK_CONVERT_FALLBACKS:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    dest_resolved = dest.resolve()
    for member in zf.infolist():
        target = (dest_resolved / member.filename).resolve()
        if not str(target).startswith(str(dest_resolved) + os.sep) and target != dest_resolved:
            raise ValueError(f"unsafe zip entry: {member.filename}")
    zf.extractall(dest_resolved)


def find_combined_html(workdir: Path) -> Path | None:
    direct = workdir / "combined.html"
    if direct.is_file():
        return direct
    matches = sorted(workdir.rglob("combined.html"))
    for m in matches:
        if m.is_file():
            return m
    return None


def handle_convert(zip_path_raw: object) -> dict:
    if not isinstance(zip_path_raw, str) or not zip_path_raw:
        return {"success": False, "error": "Invalid zipPath."}
    zip_path = Path(zip_path_raw)
    if not zip_path.is_absolute():
        return {"success": False, "error": "ZIP path must be absolute."}
    if not zip_path.is_file():
        return {"success": False, "error": "The downloaded ZIP no longer exists."}
    if zip_path.suffix.lower() != ".zip":
        return {"success": False, "error": "Expected a .zip export file."}

    ebook_convert = find_ebook_convert()
    if not ebook_convert:
        return {
            "success": False,
            "error": "Calibre is required to convert the reading list. "
            "Install Calibre (ebook-convert) and try again.",
        }

    # Single timestamp used for both filename and book title.
    now = datetime.now()
    stamp = now.strftime("%Y-%m-%d_%H-%M")
    title_stamp = now.strftime("%Y-%m-%d %H:%M")
    output_path = zip_path.parent / f"reading_list_{stamp}.azw3"
    if output_path.exists():
        i = 2
        while (zip_path.parent / f"reading_list_{stamp}-{i}.azw3").exists():
            i += 1
        output_path = zip_path.parent / f"reading_list_{stamp}-{i}.azw3"

    tmpdir = Path(tempfile.mkdtemp(prefix="the-collector-"))
    try:
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                safe_extract(zf, tmpdir)
        except (zipfile.BadZipFile, ValueError, OSError) as e:
            log(f"extract failed: {e}")
            return {"success": False, "error": "Could not extract the export ZIP."}

        combined = find_combined_html(tmpdir)
        if combined is None:
            return {"success": False, "error": "The export does not contain combined.html."}

        cmd = [
            ebook_convert,
            str(combined),
            str(output_path),
            "--title",
            f"My Reading List {title_stamp}",
            "--authors",
            "Various",
        ]
        log(f"running: {' '.join(cmd)}")
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=CONVERT_TIMEOUT_S,
                cwd=str(tmpdir),
            )
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "Conversion timed out."}
        except OSError as e:
            log(f"spawn failed: {e}")
            return {"success": False, "error": f"Could not start ebook-convert: {e}"}

        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()
            log(f"ebook-convert failed rc={proc.returncode}: {detail[:2000]}")
            short = detail[-500:] if detail else f"exit code {proc.returncode}"
            return {"success": False, "error": f"Conversion failed: {short}"}

        if not output_path.is_file() or output_path.stat().st_size == 0:
            return {"success": False, "error": "Conversion failed: output file was not created."}

        # Success: remove the source ZIP, keep the AZW3.
        try:
            zip_path.unlink()
        except OSError as e:
            log(f"could not delete zip: {e}")
            # Output exists; report success but mention the leftover zip.
            return {
                "success": True,
                "outputPath": str(output_path),
                "warning": f"Converted, but could not delete the ZIP: {e}",
            }
        return {"success": True, "outputPath": str(output_path)}
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def dispatch(request: dict) -> dict:
    action = request.get("action")
    if action == "convert":
        return handle_convert(request.get("zipPath"))
    return {"success": False, "error": f"Unknown action: {action!r}"}


def main() -> int:
    try:
        origin = sys.argv[1] if len(sys.argv) > 1 else ""
        if origin:
            log(f"caller origin: {origin}")
    except Exception:
        pass
    # Loop until EOF so both sendNativeMessage (one message) and
    # connectNative (many messages) work.
    while True:
        try:
            request = read_message()
        except ValueError as e:
            log(f"protocol error: {e}")
            try:
                write_message({"success": False, "error": f"Protocol error: {e}"})
            except OSError:
                pass
            return 1
        if request is None:
            return 0  # EOF
        if not isinstance(request, dict):
            write_message({"success": False, "error": "Invalid request."})
            continue
        response = dispatch(request)
        try:
            write_message(response)
        except OSError as e:
            log(f"write failed: {e}")
            return 1
        # For sendNativeMessage Chrome uses the first response and ignores
        # the rest; keep looping so connectNative also works. The process
        # exits when Chrome closes the pipe (EOF).


if __name__ == "__main__":
    sys.exit(main())
