"""The Node/Next.js port (server-node/) against the Python reference: its own node:test suite must pass, and its prompts, tool schemas and
validation must give the same answers as server/*.py on shared fixtures. No network and no keys: the Node side runs with every PILOT_,
ELEVENLABS_ and ANTHROPIC_ variable removed from its environment."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


def _node_version() -> tuple[int, int]:
    try:
        out = subprocess.run([NODE, "--version"], capture_output=True, text=True, timeout=20).stdout.strip()
        major, minor = out.lstrip("v").split(".")[:2]
        return int(major), int(minor)
    except Exception:  # noqa: BLE001
        return (0, 0)


pytestmark = pytest.mark.skipif(NODE is None or _node_version() < (22, 6), reason="needs node >= 22.6 (native TypeScript type stripping)")


def _flags() -> list[str]:
    """Type stripping is on by default from Node 22.18 / 23.6; before that it sits behind a flag."""
    v = _node_version()
    return ["--experimental-strip-types"] if v < (22, 18) or (v[0] == 23 and v[1] < 6) else []


def _env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if not re.match(r"(PILOT_|ELEVENLABS_|ANTHROPIC_)", k)}


def test_node_port_suite_passes():
    r = subprocess.run([NODE, *_flags(), "--test", "server-node/test/"], cwd=ROOT, capture_output=True, text=True, timeout=120, env=_env())
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr)
    assert r.returncode == 0


# ---- parity: the same fixtures through both ports ---------------------------------------------------------------------------------------------
MANIFEST = {
    "app": {"name": "Sample app", "description": "A test app."},
    "page": {"path": "/", "title": "Home"},
    "targets": [{"id": "hero", "desc": "The hero"}, {"id": "apply", "desc": "Apply button", "safe": True, "href": "/matches?x=1"},
                {"id": "sector", "desc": "Sector filter", "fill": {"kind": "select", "options": ["Aquaculture", "Energy"], "value": "Energy"}},
                {"id": "size", "desc": "Size", "text": "  two\n lines ", "fill": {"options": [1, 2.5, "x", None]}}],
    "pages": [{"path": "/", "title": "Home", "targets": []},
              {"path": "/matches", "title": "Matches", "desc": "The list", "targets": [{"id": "match-1", "desc": "Top match"}]},
              {"path": "/startups/:slug", "title": "Startup", "targets": [{"id": "why", "desc": "Why it fits"}]},
              {"path": "/files/{id}", "title": "File", "targets": [{"id": "file", "desc": "File"}]}],
}
JUNK = {"page": {"path": "javascript:alert(1)"}, "targets": [{"id": "ok-1", "desc": "x" * 500}, {"id": "bad id"}, {"id": "ok-1"}, "str", {"id": "n", "desc": 0},
                                                              {"id": "m", "desc": 123, "safe": "yes", "href": "javascript:x"}],
        "pages": [{"path": "/startups/:slug"}, {"path": "//evil"}, {"path": "/ok", "targets": "nope"}]}

CHECKS = [
    ["highlight", {"target": "nope"}], ["click", {"target": "hero"}], ["click", {"target": "apply"}], ["fill", {"target": "sector", "value": "energy"}],
    ["fill", {"target": "sector", "value": "Mining"}], ["fill", {"target": "hero", "value": "x"}], ["navigate", {"path": "https://evil.example/"}],
    ["scroll_to", {"target": "bad id"}], ["scroll_to", {}], ["highlight", {"target": "hero", "caption": "  A   caption  "}],
    ["wait", {"ms": 99999}], ["wait", {"ms": "250"}], ["wait", {"ms": 5}], ["wait", {"ms": "abc"}], ["wait", {"ms": None}], ["wait", {}],
    ["navigate", {"path": "/admin"}], ["navigate", {"path": "/matches"}], ["highlight", {"target": "match-1"}], ["highlight", {"target": "hero"}],
    ["navigate", {"path": "/startups/kelpforge#top"}], ["highlight", {"target": "why", "caption": "Because"}], ["scroll_to", {"target": "why"}],
    ["navigate", {"path": "/files/42"}], ["highlight", {"target": "nothing"}], ["navigate", {"path": "/"}], ["highlight", {"target": "hero"}],
    ["click", "not a dict"],
]
REPORTS = [None, [], "x", [{"ok": True}], [{"type": "highlight", "target": "why", "ok": False, "why": "not on the page"}, {"id": 1, "ok": True}],
           [{"ok": False}], [{"type": "navigate", "path": "/x" * 100, "ok": False, "why": "w" * 200}] + [{"ok": False, "type": f"t{i}"} for i in range(12)]]
MESSAGES = [
    [], "x", [{"role": "user", "content": "  hello \n there "}], [{"role": "assistant", "content": "stale"}, {"role": "user", "content": "q"}],
    [{"role": "user", "content": "one"}, {"role": "user", "content": "two"}, {"role": "assistant", "content": "a"}, {"role": "user", "content": "three"}],
    [{"role": "assistant", "content": "x"}], [{"role": "system", "content": "x"}], [{"role": "user", "content": 5}], [{"role": "user", "content": "x" * 601}],
    [{"role": "user", "content": "   "}], [{"role": "user", "content": f"m{i}"} for i in range(15)],
]
SPOKEN = ["[[1]] Hello **there**, `friend`!", "[2] See [the docs](https://x.example/a?b=1) at https://example.com/path now.",
          "# Title\n> quote_with_underscores\n\n  spaced   out ", "", "[[12]]Ok", "[[123]] stays", "[ 3 ] and [[ 4]]", "a_b*c__d"]


def test_python_and_node_ports_agree_on_prompts_schemas_and_validation(monkeypatch):
    for k in [k for k in os.environ if re.match(r"(PILOT_|ELEVENLABS_|ANTHROPIC_)", k)]:
        monkeypatch.delenv(k)
    from server import config
    from server import registry as reg
    from server import turn
    from server.tts import spoken

    fixtures = {"spoken": SPOKEN, "manifests": [MANIFEST, JUNK, {}, "junk"], "check_manifest": MANIFEST, "checks": CHECKS, "max_actions": 8,
                "reports": REPORTS, "messages": MESSAGES}
    r = subprocess.run([NODE, *_flags(), "server-node/test/parity_dump.ts"], cwd=ROOT, input=json.dumps(fixtures), capture_output=True, text=True,
                       timeout=120, env=_env())
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout)

    assert got["constants"] == {"ANSWER_SHAPE": turn.ANSWER_SHAPE, "TOUR_RULES": turn.TOUR_RULES, "FINAL_NOTE": turn.FINAL_NOTE,
                                "UI_TOOLS": reg.UI_TOOLS, "UI_LABELS": reg.UI_LABELS}
    assert got["spoken"] == [spoken(t) for t in SPOKEN]
    for g, raw in zip(got["manifests"], fixtures["manifests"]):
        m = reg.clean_manifest(raw)
        assert g["manifest"] == json.loads(json.dumps(m))
        assert g["page_map"] == reg.page_map(m)
    ctx = reg.TurnContext(reg.clean_manifest(MANIFEST))
    for g, (name, args) in zip(got["checks"], CHECKS):
        act, why = ctx.check(name, args, 8)
        assert g == [act, why], (name, args)
    assert got["reports"] == [turn.report_note(x) for x in REPORTS]
    s = config.settings()
    for g, raw in zip(got["messages"], MESSAGES):
        try:
            want = turn.clean_messages(raw, s)
        except ValueError as e:
            want = {"error": str(e)}
        assert g == want, raw
    assert got["prompt"] == turn.system_prompt(s, "The App", "It does things.", "Be kind.")
