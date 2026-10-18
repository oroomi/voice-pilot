"""Record docs/screens/demo.gif: the whole moment in the real client (overlay, transcript, tour with navigation and spotlights).

    python3 tools/record_gif.py

The answer is a scripted stream (the same SSE the server sends) so the recording is repeatable and needs no keys; the voice is a silent
stand-in timed like speech. tools/live_check.py is the run with the real model and the real voice.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
from conftest import FAKE_SR, ORIGIN, sse  # noqa: E402

TIMED_SYNTH = """
window.__spoken = [];
(function () {
  var synth = { speaking: false, pending: false, getVoices: function () { return []; }, cancel: function () { this.speaking = false; },
    speak: function (u) {
      if (!u.text || !u.text.trim()) return;
      window.__spoken.push(u.text); var self = this; self.speaking = true; var ms = Math.max(1200, u.text.length * 58);
      setTimeout(function () { u.onstart && u.onstart(); }, 5);
      var t0 = performance.now(), words = u.text.split(' '), i = 0;
      var tick = setInterval(function () {             /* boundary events, so the words light up as they are "said" */
        var f = (performance.now() - t0) / ms, k = Math.floor(f * words.length);
        while (i < k && i < words.length) { var idx = words.slice(0, i).join(' ').length; u.onboundary && u.onboundary({ charIndex: idx, charLength: words[i].length }); i++; }
      }, 60);
      setTimeout(function () { clearInterval(tick); self.speaking = false; u.onend && u.onend(); }, ms);
    } };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
})();
window.__vpFakeLevel = function (t) { return 0.3 + 0.35 * Math.abs(Math.sin(t * 3.3)) * Math.abs(Math.sin(t * 1.7)); };
"""
STREAM = sse(
    ("status", {"label": "thinking"}),
    ("delta", {"text": "Let me pull that up.", "step": 1}), ("delta", {"text": " ", "step": 1}),
    ("status", {"label": "reading the match list"}),
    ("action", {"id": 1, "type": "navigate", "path": "/matches"}),
    ("action", {"id": 2, "type": "highlight", "target": "match-1", "caption": "Best match: Kelpforge, 92"}),
    ("action", {"id": 3, "type": "navigate", "path": "/startups/kelpforge"}),
    ("action", {"id": 4, "type": "highlight", "target": "why", "caption": "Why it fits"}),
    ("action", {"id": 5, "type": "highlight", "target": "next-step", "caption": "Do this week"}),
    ("delta", {"text": "[[1]] [[2]] The best match is Kelpforge with Blue Current Fund, at 92 out of 100. ", "step": 3}),
    ("delta", {"text": "[[3]] [[4]] It fits because two farms already measure carbon, and two buyers signed offtake letters. ", "step": 3}),
    ("delta", {"text": "[[5]] Next step: send Blue Current the sensor data this week.", "step": 3}),
    ("done", {}),
)


def main() -> None:
    from fastapi.testclient import TestClient
    from playwright.sync_api import sync_playwright

    for k in ("ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "PILOT_REHEARSAL"):
        os.environ.pop(k, None)
    from server.app import app
    client = TestClient(app)
    tmp = ROOT / "docs" / "screens" / "_tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)

    def route(r):
        req = r.request
        path = req.url[len(ORIGIN):] or "/"
        if path.startswith("/pilot/status"):
            return r.fulfill(status=200, headers={"Content-Type": "application/json"}, body=json.dumps({"name": "Aava", "mode": "live", "llm": True, "tts": False}))
        if path.startswith("/pilot/chat"):
            time.sleep(1.3)                                     # the model's first step
            return r.fulfill(status=200, headers={"Content-Type": "text/event-stream"}, body=STREAM)
        resp = client.request(req.method, path, content=req.post_data_buffer, headers={"Content-Type": req.headers.get("content-type", "application/json")})
        r.fulfill(status=resp.status_code, headers={k: v for k, v in resp.headers.items() if k.lower() not in ("content-length", "content-encoding")}, body=resp.content)

    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 1280, "height": 760}, record_video_dir=str(tmp), record_video_size={"width": 1280, "height": 760})
        page = ctx.new_page()
        for s in (FAKE_SR, TIMED_SYNTH):
            page.add_init_script(s)
        page.route(ORIGIN + "/**", route)
        page.goto(ORIGIN + "/")
        page.wait_for_function("window.VoicePilot && window.VoicePilot.instance && window.VoicePilot.instance.status")
        page.wait_for_timeout(1200)
        page.click(".talk")
        page.wait_for_function("window.VoicePilot.instance.state === 'listening'")
        said = ""
        for w in "Aava, show me the best match and why".split():
            said = (said + " " + w).strip()
            page.evaluate(f"window.__say([[{json.dumps(said)}, false]])")
            page.wait_for_timeout(230)
        page.evaluate(f"window.__say([[{json.dumps(said)}, true]])")
        page.wait_for_function("window.VoicePilot.instance.state === 'done'", timeout=60000)
        page.wait_for_timeout(1800)
        video = page.video.path()
        ctx.close()
        b.close()
    out = ROOT / "docs" / "screens" / "demo.gif"
    vf = "fps=10,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", "0.8", "-i", str(video), "-vf", vf, str(out)], check=True)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"{out.relative_to(ROOT)} {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
