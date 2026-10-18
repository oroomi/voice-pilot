"""Screenshots of the demo for the README and for review: desktop 1440x900 and phone 390x844, overlay open, docked orb, spotlight.

    python3 tools/shots.py            # writes docs/screens/*.png

Same in-process harness as the tests (no server, no network, no keys): the chat answer is a scripted stream, the voices are fakes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from conftest import FAKE_SR, FAKE_SYNTH, ORIGIN, sse  # noqa: E402

OUT = ROOT / "docs" / "screens"
TOUR = sse(
    ("action", {"id": 1, "type": "navigate", "path": "/matches"}),
    ("action", {"id": 2, "type": "highlight", "target": "match-1", "caption": "Best match: Kelpforge, 92"}),
    ("action", {"id": 3, "type": "navigate", "path": "/startups/kelpforge"}),
    ("action", {"id": 4, "type": "highlight", "target": "why", "caption": "Why it fits"}),
    ("delta", {"text": "[[1]] [[2]] The best match is Kelpforge with Blue Current Fund, at 92 out of 100. ", "step": 2}),
    ("delta", {"text": "[[3]] [[4]] It fits because two farms already measure carbon, and two buyers have signed offtake letters.", "step": 2}),
    ("done", {}),
)
LEVEL = "window.__vpFakeLevel = function (t) { return 0.35 + 0.3 * Math.abs(Math.sin(t * 3.1)) * Math.abs(Math.sin(t * 1.3)); };"


def main() -> None:
    from fastapi.testclient import TestClient
    from playwright.sync_api import sync_playwright

    import os
    for k in ("ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "PILOT_REHEARSAL"):
        os.environ.pop(k, None)
    from server.app import app
    client = TestClient(app)
    OUT.mkdir(parents=True, exist_ok=True)

    def route(r):
        req = r.request
        path = req.url[len(ORIGIN):] or "/"
        if path.startswith("/pilot/status"):
            return r.fulfill(status=200, headers={"Content-Type": "application/json"}, body=json.dumps({"name": "Aava", "mode": "live", "llm": True, "tts": False}))
        if path.startswith("/pilot/chat"):
            return r.fulfill(status=200, headers={"Content-Type": "text/event-stream"}, body=TOUR)
        resp = client.request(req.method, path, content=req.post_data_buffer, headers={"Content-Type": req.headers.get("content-type", "application/json")})
        r.fulfill(status=resp.status_code, headers={k: v for k, v in resp.headers.items() if k.lower() not in ("content-length", "content-encoding")}, body=resp.content)

    with sync_playwright() as p:
        b = p.chromium.launch()
        for name, vp, scale in (("desktop", {"width": 1440, "height": 900}, 1), ("phone", {"width": 390, "height": 844}, 2)):
            ctx = b.new_context(viewport=vp, device_scale_factor=scale, is_mobile=name == "phone", has_touch=name == "phone")
            page = ctx.new_page()
            for s in (FAKE_SR, FAKE_SYNTH, LEVEL, "window.__synthMs = 60000; window.PILOT_TEST_OPTS = {pauseMs: 60000};"):
                page.add_init_script(s)
            page.route(ORIGIN + "/**", route)

            def ready(path="/"):
                page.goto(ORIGIN + path)
                page.wait_for_function("window.VoicePilot && window.VoicePilot.instance && window.VoicePilot.instance.status")
                page.wait_for_timeout(200)

            ready("/")
            page.screenshot(path=str(OUT / f"{name}-home.png"))
            ready("/matches")
            page.screenshot(path=str(OUT / f"{name}-matches.png"))
            ready("/startups/kelpforge")
            page.screenshot(path=str(OUT / f"{name}-startup.png"))
            # the overlay, listening, with words coming in
            ready("/")
            page.click(".vp-launch")
            page.wait_for_function("window.VoicePilot.instance.state === 'listening'")
            page.evaluate("window.__say([['Aava, show me the best match', true], [' and why', false]])")
            page.wait_for_timeout(900)
            page.screenshot(path=str(OUT / f"{name}-overlay.png"))
            # the tour: docked orb + spotlight on the best match while the first sentence plays
            page.evaluate("window.VoicePilot.instance.close()")
            page.evaluate("window.VoicePilot.instance.open({ask: 'Show me the best match and why'})")
            page.wait_for_function("window.VoicePilot.instance.state === 'speaking'", timeout=15000)
            page.wait_for_timeout(1400)
            page.screenshot(path=str(OUT / f"{name}-spotlight.png"))
            ctx.close()
        b.close()
    for f in sorted(OUT.glob("*.png")):
        print(f.relative_to(ROOT))


if __name__ == "__main__":
    main()
