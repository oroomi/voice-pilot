"""Build client/pilot.global.js (script-tag build) from client/pilot.js (the ES module): drop the export lines, wrap in an IIFE.

    python3 tools/build_client.py          # writes the file
    python3 tools/build_client.py --check  # exit 1 when the built file is out of date (the test suite runs this)
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC, OUT = ROOT / "client" / "pilot.js", ROOT / "client" / "pilot.global.js"


def build() -> str:
    body = "\n".join(l for l in SRC.read_text(encoding="utf-8").splitlines() if not l.startswith("export "))
    return ("/* voice-pilot, script-tag build: generated from client/pilot.js by tools/build_client.py; do not edit by hand.\n"
            "   <script src=\"/pilot/client/pilot.global.js\"></script> then VoicePilot.init({...}). */\n"
            "(function () {\n\"use strict\";\n" + body + "\n})();\n")


if __name__ == "__main__":
    out = build()
    if "--check" in sys.argv:
        sys.exit(0 if OUT.exists() and OUT.read_text(encoding="utf-8") == out else 1)
    OUT.write_text(out, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(out)} bytes)")
