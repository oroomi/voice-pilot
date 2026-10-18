"""Live end-to-end check against a running server (real Claude + real ElevenLabs): ask the demo question in a real browser and print what happened.

    python3 tools/live_check.py http://127.0.0.1:8151 "Show me the best match and why" [--no-tts]

Speech recognition is skipped (the question is typed through the page's own ask chip API); the server voice is used, and speechSynthesis is a
recorder, so a fallback to the browser voice shows up in the output.
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from conftest import FAKE_SYNTH  # noqa: E402

args = [a for a in sys.argv[1:] if not a.startswith("--")]
base = args[0] if args else "http://127.0.0.1:8151"
question = args[1] if len(args) > 1 else "Show me the best match and why"
no_tts = "--no-tts" in sys.argv                     # the browser voice only: spends no ElevenLabs characters
from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    page = b.new_context(viewport={"width": 1440, "height": 900}).new_page()
    page.add_init_script(FAKE_SYNTH)
    if no_tts:
        page.add_init_script("window.PILOT_TEST_OPTS = {voice: 'browser'};")
    tts = []
    page.on("response", lambda r: tts.append((r.status, r.headers.get("x-pilot-cache"))) if "/pilot/tts" in r.url else None)
    page.goto(base + "/")
    page.wait_for_function("window.VoicePilot && window.VoicePilot.instance && window.VoicePilot.instance.status")
    t0 = time.time()
    page.evaluate(f"window.VoicePilot.instance.open({{ask: {json.dumps(question)}}})")
    page.wait_for_function("window.VoicePilot.instance.state === 'speaking'", timeout=60000)
    first = time.time() - t0
    page.wait_for_timeout(1500)
    page.screenshot(path=str(ROOT / "docs" / "screens" / "live-tour.png"))
    page.wait_for_function("window.VoicePilot.instance.state === 'done'", timeout=90000)
    total = time.time() - t0
    log = page.evaluate("window.VoicePilot.instance.log")
    print(f"first words after {first:.1f}s, answer done after {total:.1f}s, ended on {page.evaluate('location.pathname')}")
    for e in log:
        if e["kind"] in ("action", "speak", "tts-fallback", "ask"):
            print(" ", {k: v for k, v in e.items() if k in ("kind", "id", "type", "target", "path", "ok", "why", "voice", "text")})
    print("tts responses:", tts, " browser-voice lines:", len(page.evaluate("window.__spoken")))
    b.close()
