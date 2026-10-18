"""Browser test harness: no sockets, no network, no keys.

Chromium loads pages from a fake origin (http://voice-pilot.test). Every request is answered in-process by the demo FastAPI app through
Starlette's TestClient, except the paths a test overrides (a scripted /pilot/chat stream, a failing /pilot/tts, a different /pilot/status).
Speech recognition is a fake the test drives (window.__say), and speechSynthesis is a fake that records what it was asked to say.
"""
from __future__ import annotations

import json

import pytest

ORIGIN = "http://voice-pilot.test"

FAKE_SR = """
window.__sr = null; window.__srStarts = 0;
function FakeSR() { window.__sr = this; this.continuous = false; this.interimResults = false; }
FakeSR.prototype.start = function () { window.__srStarts += 1; };
FakeSR.prototype.abort = function () { this.aborted = true; };
FakeSR.prototype.stop = function () {};
window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
window.__say = function (parts) {   /* [[transcript, isFinal], ...]: the whole session so far, as the browser reports it */
  var res = parts.map(function (p) { var r = [{ transcript: p[0], confidence: 0.9 }]; r.isFinal = p[1]; return r; });
  if (window.__sr && window.__sr.onresult) window.__sr.onresult({ resultIndex: 0, results: res });
};
"""

FAKE_SYNTH = """
window.__spoken = [];
(function () {
  var synth = { speaking: false, pending: false, getVoices: function () { return []; },
    cancel: function () { this.speaking = false; },
    speak: function (u) {
      if (!u.text || !u.text.trim()) return;
      window.__spoken.push(u.text); var self = this; self.speaking = true;
      setTimeout(function () { u.onstart && u.onstart(); }, 5);
      setTimeout(function () { self.speaking = false; u.onend && u.onend(); }, window.__synthMs || 250);
    } };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
})();
"""


def sse(*events) -> str:
    return "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in events)


@pytest.fixture(scope="session")
def browser():
    sync_api = pytest.importorskip("playwright.sync_api")
    p = sync_api.sync_playwright().start()
    b = None
    for kw in ({}, {"executable_path": "/opt/pw-browsers/chromium"}):
        try:
            b = p.chromium.launch(**kw)
            break
        except Exception as e:  # noqa: BLE001
            err = e
    if b is None:
        p.stop()
        pytest.skip(f"chromium unavailable: {err}")
    yield b
    b.close()
    p.stop()


@pytest.fixture()
def site(monkeypatch):
    for k in ("ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "PILOT_REHEARSAL"):
        monkeypatch.delenv(k, raising=False)
    from fastapi.testclient import TestClient

    from server.app import app, pilot
    pilot.pilot.limiter.reset()
    return TestClient(app), pilot.pilot


class Harness:
    def __init__(self, browser, site, viewport, overrides, scripts):
        self.client, self.state = site
        self.requests: list[dict] = []
        self.overrides = overrides
        self.ctx = browser.new_context(viewport=viewport, device_scale_factor=1)
        self.page = self.ctx.new_page()
        for s in scripts:
            self.page.add_init_script(s)
        self.page.route(ORIGIN + "/**", self._handle)

    def _handle(self, route):
        req = route.request
        path = req.url[len(ORIGIN):] or "/"
        body = req.post_data_buffer
        self.requests.append({"method": req.method, "path": path, "body": body})
        for prefix, fn in self.overrides.items():
            if path.startswith(prefix):
                status, ctype, out = fn(json.loads(body) if body else None)
                return route.fulfill(status=status, headers={"Content-Type": ctype}, body=out)
        r = self.client.request(req.method, path, content=body, headers={"Content-Type": req.headers.get("content-type", "application/json"),
                                                                         "Accept": req.headers.get("accept", "*/*")})
        headers = {k: v for k, v in r.headers.items() if k.lower() not in ("content-length", "content-encoding", "transfer-encoding")}
        route.fulfill(status=r.status_code, headers=headers, body=r.content)

    def chats(self) -> list[dict]:
        return [json.loads(r["body"]) for r in self.requests if r["path"].startswith("/pilot/chat")]

    def goto(self, path="/"):
        self.page.goto(ORIGIN + path)
        self.page.wait_for_function("window.VoicePilot && window.VoicePilot.instance && window.VoicePilot.instance.status")
        return self.page

    def pilot(self, expr):
        return self.page.evaluate(f"(() => {{ const p = window.VoicePilot.instance; return {expr}; }})()")

    def close(self):
        self.ctx.close()


@pytest.fixture()
def harness(browser, site):
    made = []

    def make(viewport=None, overrides=None, scripts=(FAKE_SR, FAKE_SYNTH)):
        h = Harness(browser, site, viewport or {"width": 1280, "height": 800}, overrides or {}, scripts)
        made.append(h)
        return h
    yield make
    for h in made:
        h.close()
