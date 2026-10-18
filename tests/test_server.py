"""Server unit tests: the tool loop with a fake Anthropic client, target validation, the SSE route, rate limits, and the TTS cap and cache.
No network and no keys: the model is server.fake.FakeClient and the voice upstream is a fake coroutine."""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import config
from server.fake import FakeClient, rehearsal_client, reply, text, tool
from server.registry import Registry, clean_manifest, match_page, page_map
from server.router import make_router
from server.turn import Turn

MANIFEST = {
    "app": {"name": "Sample app", "description": "A test app."},
    "page": {"path": "/", "title": "Home"},
    "targets": [{"id": "hero", "desc": "The hero"}, {"id": "apply", "desc": "Apply button", "safe": True},
                {"id": "sector", "desc": "Sector filter", "fill": {"kind": "select", "options": ["Aquaculture", "Energy"]}}],
    "pages": [{"path": "/", "title": "Home", "targets": []},
              {"path": "/matches", "title": "Matches", "targets": [{"id": "match-1", "desc": "Top match"}]},
              {"path": "/startups/:slug", "title": "Startup", "targets": [{"id": "why", "desc": "Why it fits"}]}],
}


def _events(turn):
    return [(e["event"], e["data"]) for e in turn.events()]


def _turn(script, reg=None, **kw):
    s = config.settings()
    m = clean_manifest(MANIFEST)
    client = FakeClient(script)
    return Turn([{"role": "user", "content": "show me the best match"}], m, reg or Registry(), client, s, **kw), client


def test_tool_loop_runs_data_tools_then_ui_tools_then_streams_the_answer_with_cues():
    reg = Registry()
    seen = {}

    @reg.tool("list_matches", "matches", label="reading the list")
    def list_matches(args):
        seen["args"] = args
        return {"top": "Kelpforge"}

    script = [reply(tool("list_matches", limit=3)),
              reply(tool("navigate", path="/matches"), tool("highlight", target="match-1", caption="Best match")),
              reply(text("[[1]] Here are the matches. [[2]] Kelpforge is the best one."))]
    turn, client = _turn(script, reg)
    ev = _events(turn)
    kinds = [k for k, _ in ev]
    assert kinds[0] == "status" and kinds[-1] == "done"
    acts = [d for k, d in ev if k == "action"]
    assert [(a["id"], a["type"]) for a in acts] == [(1, "navigate"), (2, "highlight")]
    assert acts[1]["target"] == "match-1" and acts[1]["caption"] == "Best match"
    said = "".join(d["text"] for k, d in ev if k == "delta")
    assert said == "[[1]] Here are the matches. [[2]] Kelpforge is the best one."
    assert seen["args"] == {"limit": 3}
    # the data tool's result and the cue numbers went back to the model as tool results
    r2 = client.calls[1]["messages"][-1]["content"][0]
    assert r2["type"] == "tool_result" and "Kelpforge" in r2["content"]
    r3 = client.calls[2]["messages"][-1]["content"]
    assert "[[1]]" in r3[0]["content"] and "[[2]]" in r3[1]["content"]
    done = ev[-1][1]
    assert done["steps"] == 3 and len(done["actions"]) == 2
    # the request: UI tools + data tools, the page map in the system prompt, adaptive thinking at the configured effort
    kw = client.calls[0]
    names = [t["name"] for t in kw["tools"]]
    assert {"navigate", "scroll_to", "highlight", "click", "fill", "wait", "list_matches"} <= set(names)
    assert "match-1" in kw["system"][1]["text"] and "/startups/:slug" in kw["system"][1]["text"]
    assert kw["thinking"] == {"type": "adaptive"} and kw["output_config"] == {"effort": "low"}
    assert kw["model"] == "claude-sonnet-5-5"
    assert "ONE short paragraph" in kw["system"][0]["text"] and "Never mention your tools" in kw["system"][0]["text"]


def test_unknown_targets_and_unsafe_clicks_are_refused_back_to_the_model_and_never_reach_the_page():
    script = [reply(tool("highlight", target="nope"), tool("click", target="hero"), tool("click", target="apply"),
                    tool("fill", target="sector", value="energy"), tool("navigate", path="https://evil.example/")),
              reply(text("[[1]] Applied. [[2]] Energy only."))]
    turn, client = _turn(script)
    ev = _events(turn)
    acts = [d for k, d in ev if k == "action"]
    assert [(a["type"], a.get("target")) for a in acts] == [("click", "apply"), ("fill", "sector")]
    assert acts[1]["value"] == "Energy"                       # matched to the option's own spelling
    results = client.calls[1]["messages"][-1]["content"]
    errs = [r for r in results if r.get("is_error")]
    assert len(errs) == 3
    assert "Unknown target 'nope'" in errs[0]["content"] and "hero" in errs[0]["content"]
    assert "not marked safe" in errs[1]["content"]
    assert "starts with /" in errs[2]["content"]


def test_after_navigate_the_targets_of_the_destination_page_are_the_valid_ones():
    script = [reply(tool("navigate", path="/startups/kelpforge"), tool("highlight", target="why"), tool("highlight", target="match-1")),
              reply(text("[[1]] [[2]] It fits."))]
    turn, client = _turn(script)
    ev = _events(turn)
    assert [a["type"] for k, a in ev if k == "action"] == ["navigate", "highlight"]
    err = [r for r in client.calls[1]["messages"][-1]["content"] if r.get("is_error")][0]
    assert "match-1" in err["content"] and "/startups/kelpforge" in err["content"]


def test_unknown_page_is_refused():
    turn, client = _turn([reply(tool("navigate", path="/admin")), reply(text("Sorry."))])
    ev = _events(turn)
    assert not [1 for k, _ in ev if k == "action"]
    assert "Unknown page" in client.calls[1]["messages"][-1]["content"][0]["content"]


def test_the_last_step_forbids_tools_and_an_empty_answer_is_an_error(monkeypatch):
    monkeypatch.setenv("PILOT_MAX_STEPS", "2")
    turn, client = _turn([reply(tool("wait", ms=200)), reply(text("Done waiting."))])
    ev = _events(turn)
    assert client.calls[1]["tool_choice"] == {"type": "none"} and ev[-1][0] == "done"
    turn, _ = _turn([reply(text("  "))])
    ev = _events(turn)
    assert ev[-1][0] == "error" and ev[-1][1]["kind"] == "empty"


def test_failed_actions_from_last_turn_are_reported_to_the_model():
    turn, client = _turn([reply(text("Ok."))], reports=[{"id": 2, "type": "highlight", "target": "why", "ok": False, "why": "not on the page"},
                                                         {"id": 1, "type": "navigate", "ok": True}])
    _events(turn)
    sent = client.calls[0]["messages"][-1]["content"]
    assert "did not run: highlight why (not on the page)" in sent


def test_between_tools_and_fallbacks_settings(monkeypatch):
    monkeypatch.setenv("PILOT_THINKING", "between_tools")
    turn, client = _turn([reply(text("Hi."))])
    _events(turn)
    kw = client.calls[0]
    assert kw["thinking"] == {"type": "between_tools"} and "output_config" not in kw
    assert kw["extra_body"] == {"fallbacks": "default"} and kw["extra_headers"]["anthropic-beta"] == "server-side-fallback-2026-07-01"
    monkeypatch.setenv("PILOT_FALLBACKS", "off")
    turn, client = _turn([reply(text("Hi."))])
    _events(turn)
    assert "extra_body" not in client.calls[0]


def test_a_broken_data_tool_is_reported_not_raised():
    reg = Registry()

    @reg.tool("boom", "fails")
    def boom(args):
        raise RuntimeError("db down")

    turn, client = _turn([reply(tool("boom")), reply(text("The records are unavailable."))], reg)
    ev = _events(turn)
    assert ev[-1][0] == "done"
    r = client.calls[1]["messages"][-1]["content"][0]
    assert r["is_error"] and "db down" in r["content"]


def test_manifest_cleaning_and_page_patterns():
    m = clean_manifest({"page": {"path": "javascript:alert(1)"}, "targets": [{"id": "ok-1", "desc": "x" * 500}, {"id": "bad id"}, {"id": "ok-1"}],
                        "pages": [{"path": "/startups/:slug"}, {"path": "//evil"}]})
    assert m["page"]["path"] == "/" and [t["id"] for t in m["targets"]] == ["ok-1"] and len(m["targets"][0]["desc"]) == 160
    assert [p["path"] for p in m["pages"]] == ["/startups/:slug"]
    assert match_page("/startups/kelpforge?x=1", m["pages"]) and not match_page("/startups/a/b", m["pages"])
    pm = page_map(clean_manifest(MANIFEST))
    assert "[safe]" in pm and "[fillable: select, options Aquaculture | Energy]" in pm


# ---- the HTTP routes ----------------------------------------------------------------------------------------------------------------------
@pytest.fixture()
def app_client(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("PILOT_REHEARSAL", raising=False)
    app = FastAPI()
    router = make_router(Registry(), app_name="Test app")
    app.include_router(router)
    return TestClient(app), router.pilot


def _sse(body: str) -> list[tuple[str, dict]]:
    out = []
    for block in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.split("\n") if ": " in line)
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_status_and_chat_without_a_key_say_so_without_leaking_anything(app_client):
    c, st = app_client
    s = c.get("/pilot/status").json()
    assert s == {"name": "Aava", "mode": "off", "llm": False, "model": None, "tts": False, "tts_chars_left": 0}
    r = c.post("/pilot/chat", json={"messages": [{"role": "user", "content": "hi"}], "manifest": MANIFEST})
    assert r.status_code == 200 and _sse(r.text)[0][0] == "error"
    assert c.post("/pilot/chat", json={"messages": []}).status_code == 400


def test_chat_streams_sse_from_the_tool_loop_and_rate_limits(app_client, monkeypatch):
    c, st = app_client
    monkeypatch.setenv("PILOT_RATE_PER_MIN", "2")
    st.client_factory = lambda s, q, m: FakeClient([reply(tool("highlight", target="hero", caption="Hello")), reply(text("[[1]] Hello there."))])
    r = c.post("/pilot/chat", json={"messages": [{"role": "user", "content": "hi"}], "manifest": MANIFEST})
    ev = _sse(r.text)
    assert r.headers["content-type"].startswith("text/event-stream")
    assert [k for k, _ in ev if k != "status"] == ["action", "delta", "delta", "done"] or [k for k, _ in ev][-1] == "done"
    assert [d for k, d in ev if k == "action"][0] == {"type": "highlight", "caption": "Hello", "target": "hero", "id": 1}
    c.post("/pilot/chat", json={"messages": [{"role": "user", "content": "hi"}], "manifest": MANIFEST})
    r3 = c.post("/pilot/chat", json={"messages": [{"role": "user", "content": "hi"}], "manifest": MANIFEST})
    assert r3.status_code == 429 and _sse(r3.text)[0][1]["kind"] == "rate"


def test_rehearsal_mode_runs_the_real_loop_with_a_scripted_plan(monkeypatch):
    from demo import site
    m = clean_manifest({"page": {"path": "/", "title": "Home"}, "targets": [{"id": "hero"}],
                        "pages": [{"path": "/matches", "targets": [{"id": "match-1"}]}, {"path": "/startups/:slug", "targets": [{"id": "why"}, {"id": "next-step"}]}]})
    client = rehearsal_client(site.plan, "show me the best match and why", m)
    turn = Turn([{"role": "user", "content": "show me the best match and why"}], m, site.registry, client, config.settings())
    ev = _events(turn)
    acts = [d for k, d in ev if k == "action"]
    assert [a["type"] for a in acts] == ["navigate", "highlight", "navigate", "highlight", "highlight"]
    said = ev[-1][1]["text"]
    assert said.startswith("[[1]] [[2]] The best match is Kelpforge") and "[[3]] [[4]] Why:" in said and "[[5]] Next step:" in said


# ---- TTS ------------------------------------------------------------------------------------------------------------------------------------
def _fake_upstream(calls, status=200):
    async def up(text, s, key):
        calls.append(text)

        async def chunks():
            yield b"ID3fake-"
            yield text.encode()

        async def close():
            return None
        return status, chunks(), close
    return up


def test_tts_streams_caches_identical_text_and_enforces_the_daily_cap(app_client, monkeypatch):
    c, st = app_client
    monkeypatch.setenv("ELEVENLABS_API_KEY", "test-not-a-key")
    monkeypatch.setenv("ELEVENLABS_VOICE_ID", "voice123")
    monkeypatch.setenv("PILOT_TTS_DAILY_CHARS", "40")
    calls: list = []
    st.voice.upstream = _fake_upstream(calls)
    r = c.post("/pilot/tts", json={"text": "[[1]] Hello **there**, friend."})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.headers["x-pilot-cache"] == "miss"
    assert calls == ["Hello there, friend."] and r.content == b"ID3fake-Hello there, friend."
    r2 = c.post("/pilot/tts", json={"text": "Hello there, friend."})            # same spoken text: from the cache, no new characters
    assert r2.headers["x-pilot-cache"] == "hit" and len(calls) == 1 and r2.content == r.content
    assert c.get("/pilot/status").json()["tts_chars_left"] == 40 - 20
    r3 = c.post("/pilot/tts", json={"text": "This sentence is far too long for what is left of the cap."})
    assert r3.status_code == 429 and len(calls) == 1
    st.voice.upstream = _fake_upstream(calls, status=401)
    r4 = c.post("/pilot/tts", json={"text": "Short one."})
    assert r4.status_code == 502 and c.get("/pilot/status").json()["tts_chars_left"] == 20    # refunded


def test_tts_without_a_key_is_404_so_the_browser_voice_takes_over(app_client):
    c, _ = app_client
    assert c.post("/pilot/tts", json={"text": "Hello"}).status_code == 404
    assert c.post("/pilot/tts", json={"nope": 1}).status_code == 400
