"""Browser tests for client/pilot.js on the demo site: a fake SpeechRecognition, a fake speechSynthesis, a scripted /pilot/chat stream.
No network, no keys (tests/conftest.py)."""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from conftest import sse

ROOT = Path(__file__).resolve().parent.parent

TOUR = sse(
    ("status", {"label": "thinking"}),
    ("action", {"id": 1, "type": "navigate", "path": "/matches"}),
    ("action", {"id": 2, "type": "highlight", "target": "match-1", "caption": "Best match: 92"}),
    ("action", {"id": 3, "type": "navigate", "path": "/startups/kelpforge"}),
    ("action", {"id": 4, "type": "highlight", "target": "why", "caption": "Why it fits"}),
    ("delta", {"text": "[[1]] [[2]] The best match is Kelpforge, at 92. ", "step": 2}),
    ("delta", {"text": "[[3]] [[4]] It fits because two farms already measure carbon.", "step": 2}),
    ("done", {"text": "...", "actions": [], "steps": 2}),
)


def chat_with(stream):
    return {"/pilot/chat": lambda body: (200, "text/event-stream", stream)}


def wait_state(h, state, timeout=8000):
    h.page.wait_for_function(f"window.VoicePilot.instance.state === '{state}'", timeout=timeout)


def open_listening(h, path="/"):
    page = h.goto(path)
    page.click(".vp-launch")
    page.wait_for_function("window.__sr && window.VoicePilot.instance.state === 'listening'")
    return page


def test_a_short_pause_does_not_send_and_a_real_pause_does(harness):
    h = harness(overrides=chat_with(sse(("delta", {"text": "Hello.", "step": 1}), ("done", {"text": "Hello."}))))
    page = open_listening(h)
    assert page.evaluate("window.__sr.continuous") is True
    page.evaluate("window.__say([['show me the best', false]])")
    page.wait_for_timeout(300)
    page.evaluate("window.__say([['show me the best', true]])")      # the browser closes a phrase at a breath
    page.wait_for_timeout(800)
    assert not h.chats() and h.pilot("p.state") == "listening", "a 0.8 s breath sent the question"
    page.evaluate("window.__say([['show me the best', true], [' match and why', true]])")
    deadline = time.time() + 5
    while not h.chats() and time.time() < deadline:
        page.wait_for_timeout(100)
    sent = h.chats()
    assert len(sent) == 1 and sent[0]["messages"][-1] == {"role": "user", "content": "show me the best match and why"}
    assert sent[0]["manifest"]["page"]["path"] == "/" and any(t["id"] == "hero" for t in sent[0]["manifest"]["targets"])
    assert {p["path"] for p in sent[0]["manifest"]["pages"]} == {"/", "/matches", "/startups/:slug"}
    assert any(t["id"] == "why" for p in sent[0]["manifest"]["pages"] for t in p["targets"])     # learned by crawling the sample page


def test_tap_on_the_orb_sends_at_once_and_with_nothing_heard_stops(harness):
    h = harness(overrides=chat_with(sse(("delta", {"text": "Sure.", "step": 1}), ("done", {"text": "Sure."}))))
    page = open_listening(h)
    page.click(".vp-orb")
    page.wait_for_timeout(250)
    assert not h.chats() and h.pilot("p.state") == "idle"
    page.click(".vp-orb")
    wait_state(h, "listening")
    page.evaluate("window.__say([['who should fund saltgrid', false]])")
    page.click(".vp-orb")
    page.wait_for_timeout(400)                                   # well inside the 1.5 s pause: only the tap can have sent it
    assert len(h.chats()) == 1 and h.chats()[0]["messages"][-1]["content"] == "who should fund saltgrid"


def test_actions_run_in_order_each_just_before_its_sentence_and_navigation_keeps_the_session(harness):
    h = harness(overrides=chat_with(TOUR))
    page = h.goto("/")
    page.evaluate("window.__marker = 'same page, no reload'")
    page.evaluate("window.VoicePilot.instance.open({ask: 'show me the best match and why'})")
    wait_state(h, "done", 15000)
    log = h.pilot("p.log.filter(e => e.kind === 'action' || e.kind === 'speak')")
    acts = [e for e in log if e["kind"] == "action"]
    assert [(a["id"], a["ok"]) for a in acts] == [(1, True), (2, True), (3, True), (4, True)], acts
    order = [("a%d" % e["id"]) if e["kind"] == "action" else ("s:" + e["text"][:20]) for e in log]
    assert order == ["a1", "a2", "s:The best match is Ke", "a3", "a4", "s:It fits because two "], order
    assert page.evaluate("window.__spoken") == ["The best match is Kelpforge, at 92.", "It fits because two farms already measure carbon."]
    # navigation swapped the page in place: same document, new path, the overlay still there (docked)
    assert page.evaluate("window.__marker") == "same page, no reload"
    assert page.evaluate("location.pathname") == "/startups/kelpforge"
    assert page.evaluate("document.querySelector('main h1').textContent") == "Kelpforge"
    assert page.evaluate("document.title").startswith("Kelpforge")
    assert h.pilot("p.mode") == "docked" and page.is_visible(".vp-orb") and page.is_visible(".vp-bubble")
    assert page.evaluate("document.querySelector('.top nav a[aria-current]').textContent") == "Matches"   # the nav region swapped too
    # the conversation goes on from the new page
    page.evaluate("window.VoicePilot.instance.ask('and the next step?')")
    page.wait_for_function("window.VoicePilot.instance.state === 'done' && window.__spoken.length >= 4", timeout=15000)
    second = h.chats()[1]
    assert [m["role"] for m in second["messages"]] == ["user", "assistant", "user"]
    assert second["manifest"]["page"]["path"] == "/startups/kelpforge" and any(t["id"] == "next-step" for t in second["manifest"]["targets"])


def test_the_spotlight_sits_on_the_target_with_its_caption(harness):
    stream = sse(("action", {"id": 1, "type": "highlight", "target": "stats", "caption": "Headline numbers"}),
                 ("delta", {"text": "[[1]] Eight startups are on the board this week.", "step": 1}), ("done", {}))
    h = harness(overrides=chat_with(stream))
    page = h.goto("/")
    page.evaluate("window.__synthMs = 1500")
    page.evaluate("window.VoicePilot.instance.open({ask: 'what is on the board?'})")
    wait_state(h, "speaking")
    page.wait_for_timeout(700)
    box = page.evaluate("(() => { const s = document.querySelector('.vp-spot').getBoundingClientRect(), t = document.querySelector('[data-pilot=stats]').getBoundingClientRect();"
                        " return {dx: Math.abs(s.left - t.left + 8), dy: Math.abs(s.top - t.top + 8), dw: Math.abs(s.width - t.width - 16)}; })()")
    assert max(box.values()) < 3, box
    assert page.is_visible(".vp-spot-label") and page.text_content(".vp-spot-label") == "Headline numbers"


def test_unknown_targets_are_skipped_safely_and_reported_with_the_next_question(harness):
    stream = sse(("action", {"id": 1, "type": "highlight", "target": "ghost", "unverified": True}),
                 ("action", {"id": 2, "type": "click", "target": "hero"}),          # not data-pilot-safe: refused in the browser too
                 ("action", {"id": 3, "type": "highlight", "target": "hero", "caption": "Start here"}),
                 ("delta", {"text": "[[1]] This one is missing. [[2]] [[3]] This one is here.", "step": 1}), ("done", {}))
    h = harness(overrides=chat_with(stream))
    page = h.goto("/")
    page.evaluate("window.VoicePilot.instance.open({ask: 'show me something'})")
    wait_state(h, "done", 15000)
    acts = h.pilot("p.log.filter(e => e.kind === 'action')")
    assert [(a["target"], a["ok"], a["why"]) for a in acts] == [("ghost", False, "not on this page"), ("hero", False, "not marked data-pilot-safe"), ("hero", True, "")]
    assert page.evaluate("window.__spoken") == ["This one is missing.", "This one is here."]       # the voice carried on
    page.evaluate("window.VoicePilot.instance.ask('ok, next')")
    page.wait_for_function("window.__spoken.length >= 3", timeout=15000)
    reports = h.chats()[1]["reports"]
    assert [(r["target"], r["ok"]) for r in reports] == [("ghost", False), ("hero", False)]


def test_actions_without_cues_are_spread_over_the_sentences_in_order(harness):
    stream = sse(("action", {"id": 1, "type": "scroll_to", "target": "funders"}),
                 ("action", {"id": 2, "type": "highlight", "target": "funders", "caption": "Funders"}),
                 ("action", {"id": 3, "type": "highlight", "target": "stats", "caption": "Numbers"}),
                 ("delta", {"text": "There are three funders. Each backs a different part of the ocean economy.", "step": 1}), ("done", {}))
    h = harness(overrides=chat_with(stream))
    page = h.goto("/")
    page.evaluate("window.VoicePilot.instance.open({ask: 'who are the funders?'})")
    wait_state(h, "done", 15000)
    log = h.pilot("p.log.filter(e => e.kind === 'action' || e.kind === 'speak').map(e => e.kind === 'action' ? 'a' + e.id + (e.ok ? '' : '!') : 's')")
    assert log == ["a1", "a2", "s", "a3", "s"], log      # each sentence takes the next actions up to one highlight


def test_tts_failure_falls_back_to_the_browser_voice(harness, site):
    calls = []

    def tts(body):
        calls.append(body["text"])
        return 500, "application/json", '{"error": "upstream down"}'
    overrides = {"/pilot/status": lambda b: (200, "application/json", '{"name": "Aava", "mode": "live", "llm": true, "tts": true}'),
                 "/pilot/tts": tts,
                 "/pilot/chat": lambda b: (200, "text/event-stream", sse(("delta", {"text": "First sentence here. Second one follows.", "step": 1}), ("done", {})))}
    h = harness(overrides=overrides)
    page = h.goto("/")
    page.evaluate("window.VoicePilot.instance.open({ask: 'hello'})")
    wait_state(h, "done", 15000)
    assert calls == ["First sentence here."]                     # the first failure switches the session to the browser voice
    assert page.evaluate("window.__spoken") == ["First sentence here.", "Second one follows."]
    assert h.pilot("p.log.some(e => e.kind === 'tts-fallback')")


def test_escape_closes_and_a_chat_error_is_spoken(harness):
    h = harness(overrides=chat_with(sse(("status", {"label": "thinking"}), ("error", {"kind": "rate", "message": "That is a lot of questions in a minute."}))))
    page = h.goto("/")
    page.evaluate("window.VoicePilot.instance.open({ask: 'hi'})")
    wait_state(h, "done", 15000)
    assert page.evaluate("window.__spoken") == ["That is a lot of questions in a minute."]
    page.keyboard.press("Escape")
    assert h.pilot("p.mode") == "closed" and not page.is_visible(".vp-overlay") and page.is_visible(".vp-launch")


def test_rehearsal_mode_end_to_end_through_the_real_server_route(harness, site, monkeypatch):
    monkeypatch.setenv("PILOT_REHEARSAL", "1")
    h = harness()
    page = h.goto("/")
    assert h.pilot("p.status.mode") == "rehearsal" and page.is_visible(".vp-launch")
    page.click("[data-pilot-ask='Show me the best match and why']")
    wait_state(h, "done", 20000)
    acts = h.pilot("p.log.filter(e => e.kind === 'action').map(e => [e.type, e.target || e.path, e.ok])")
    assert acts == [["navigate", "/matches", True], ["highlight", "match-1", True], ["navigate", "/startups/kelpforge", True],
                    ["highlight", "why", True], ["highlight", "next-step", True]]
    assert page.evaluate("location.pathname") == "/startups/kelpforge"
    assert page.evaluate("window.__spoken")[0].startswith("The best match is Kelpforge with Blue Current Fund")


def test_the_script_tag_build_is_in_sync_with_the_module():
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "build_client.py"), "--check"])
    assert r.returncode == 0, "run: python3 tools/build_client.py"


def test_a_lead_in_said_while_tools_run_takes_no_action_and_cues_still_time_the_tour(harness):
    stream = sse(("delta", {"text": "Let me pull that up.", "step": 1}), ("delta", {"text": " ", "step": 1}),
                 ("action", {"id": 1, "type": "highlight", "target": "stats", "caption": "Numbers"}),
                 ("action", {"id": 2, "type": "highlight", "target": "funders", "caption": "Funders"}),
                 ("delta", {"text": "[[1]] Eight startups are scored. [[2]] Three funders back them.", "step": 2}), ("done", {}))
    h = harness(overrides=chat_with(stream))
    page = h.goto("/")
    page.evaluate("window.VoicePilot.instance.open({ask: 'what is here?'})")
    wait_state(h, "done", 15000)
    log = h.pilot("p.log.filter(e => e.kind === 'action' || e.kind === 'speak').map(e => e.kind === 'action' ? 'a' + e.id : e.text.split(' ')[0])")
    assert log == ["Let", "a1", "Eight", "a2", "Three"], log


def test_a_spotlight_at_the_bottom_of_the_page_is_scrolled_clear_of_the_docked_bubble(harness):
    stream = sse(("action", {"id": 1, "type": "highlight", "target": "next-step", "caption": "Do this week"}),
                 ("delta", {"text": "[[1]] Next step: send Blue Current the sensor dataset and book a partner call this week.", "step": 1}), ("done", {}))
    h = harness(overrides=chat_with(stream))
    page = h.goto("/startups/kelpforge")
    page.evaluate("window.__synthMs = 2500")
    page.evaluate("window.VoicePilot.instance.open({ask: 'what next?'})")
    wait_state(h, "speaking")
    page.wait_for_timeout(600)
    r = page.evaluate("(() => { const s = document.querySelector('.vp-spot').getBoundingClientRect(), b = document.querySelector('.vp-bubble').getBoundingClientRect();"
                      " return {spotBottom: s.bottom, bubbleTop: b.top, spotTop: s.top}; })()")
    assert r["spotTop"] > 60 and r["spotBottom"] <= r["bubbleTop"], r


def test_closing_mid_answer_cancels_the_actions_still_queued(harness):
    stream = sse(("action", {"id": 1, "type": "highlight", "target": "matches-noop"}),
                 ("action", {"id": 2, "type": "wait", "ms": 1500}),
                 ("action", {"id": 3, "type": "click", "target": "filter-80"}),
                 ("delta", {"text": "Filtering now.", "step": 1}), ("done", {}))
    h = harness(overrides=chat_with(stream))
    page = h.goto("/matches")
    page.evaluate("window.__clicks = 0; document.querySelector('[data-pilot=filter-80]').addEventListener('click', () => window.__clicks++)")
    page.evaluate("window.__synthMs = 200")
    page.evaluate("window.VoicePilot.instance.open({ask: 'only the high scores'})")
    page.wait_for_timeout(700)                                 # inside the wait action
    page.keyboard.press("Escape")
    page.wait_for_timeout(2200)
    assert h.pilot("p.mode") == "closed" and page.evaluate("window.__clicks") == 0


def test_a_navigate_path_that_resolves_off_site_is_refused_in_the_browser_too(harness):
    stream = sse(("action", {"id": 1, "type": "navigate", "path": "/.//evil.invalid/x"}),
                 ("delta", {"text": "[[1]] Going somewhere.", "step": 1}), ("done", {}))
    h = harness(overrides=chat_with(stream))
    seen = []
    page = h.goto("/")
    page.on("request", lambda r: seen.append(r.url) if "evil" in r.url else None)
    page.evaluate("window.VoicePilot.instance.open({ask: 'go'})")
    wait_state(h, "done", 15000)
    acts = h.pilot("p.log.filter(e => e.kind === 'action').map(e => [e.ok, e.why])")
    assert acts == [[False, "not a path on this site"]] and not seen and page.evaluate("location.pathname") == "/"
