"""Tools: the host app's data tools (a registry it fills) and the built-in UI tools (validated against the page manifest).

Data tools run on the server and return facts to the model. UI tools never run on the server: a valid call becomes an `action` event that the
browser executes (client/pilot.js), and the model gets back a cue number to place in its spoken answer. A call naming an unknown page or target is
refused with an error result listing what does exist, so the model can correct itself in the same turn; the browser never sees it.
"""
from __future__ import annotations

import inspect
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$")
PATH_RE = re.compile(r"^/(?!/)[A-Za-z0-9._~%!$&'()*+,;=:@/?#-]{0,300}$")
MAX_TARGETS, MAX_PAGES = 80, 24


# ---- the host app's data tools ----------------------------------------------------------------------------------------------------------
@dataclass
class DataTool:
    name: str
    description: str
    schema: dict
    fn: Callable
    label: str = ""          # shown in the overlay while it runs ("checking the records")
    takes_ctx: bool = False


class Registry:
    """The host app registers read-only data tools here:

        registry = Registry()

        @registry.tool("list_matches", "Ranked matches, best first.", {"type": "object", "properties": {"limit": {"type": "integer"}}})
        def list_matches(args):            # or (args, ctx): ctx.manifest is what the page sent this turn
            return {"matches": [...]}       # a str, or anything json.dumps can write
    """

    def __init__(self) -> None:
        self._tools: dict[str, DataTool] = {}

    def tool(self, name: str, description: str, schema: dict | None = None, label: str = ""):
        if name in UI_TOOL_NAMES:
            raise ValueError(f"{name} is a built-in UI tool name")
        if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", name):
            raise ValueError("tool names are 1-64 letters, digits, _ or -")

        def deco(fn: Callable) -> Callable:
            takes_ctx = len(inspect.signature(fn).parameters) >= 2
            self._tools[name] = DataTool(name, description, schema or {"type": "object", "properties": {}}, fn, label, takes_ctx)
            return fn
        return deco

    def names(self) -> list[str]:
        return list(self._tools)

    def has(self, name: str) -> bool:
        return name in self._tools

    def label(self, name: str) -> str:
        t = self._tools.get(name)
        return (t.label if t and t.label else "checking the records")

    def specs(self) -> list[dict]:
        return [{"name": t.name, "description": t.description, "input_schema": t.schema} for t in self._tools.values()]

    def run(self, name: str, args: dict, ctx: "TurnContext") -> tuple[str, bool]:
        t = self._tools[name]
        try:
            out = t.fn(args or {}, ctx) if t.takes_ctx else t.fn(args or {})
        except Exception as e:  # noqa: BLE001  (a broken tool is reported to the model, never crashes the turn)
            return f"The tool failed: {type(e).__name__}: {str(e)[:200]}", False
        body = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, default=str)
        return body[:12000], True


# ---- the UI tools ------------------------------------------------------------------------------------------------------------------------
_T = {"type": "string", "description": "A target id from the PAGE MAP (never a CSS selector)."}
UI_TOOLS: list[dict] = [
    {"name": "navigate", "description": "Open another page of this site. The conversation and your voice continue. `path` is a page path from the PAGE MAP; "
                                        "replace :params with values you saw in links (for example /startups/kelpforge).",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}},
    {"name": "scroll_to", "description": "Scroll a target into view.",
     "input_schema": {"type": "object", "properties": {"target": _T}, "required": ["target"], "additionalProperties": False}},
    {"name": "highlight", "description": "Dim the page and spotlight one target with a short caption (at most 8 words). Use it on the thing your sentence is about.",
     "input_schema": {"type": "object", "properties": {"target": _T, "caption": {"type": "string"}}, "required": ["target"], "additionalProperties": False}},
    {"name": "click", "description": "Press a target marked [safe] in the PAGE MAP (a filter chip, a tab, show more). Nothing else can be clicked.",
     "input_schema": {"type": "object", "properties": {"target": _T}, "required": ["target"], "additionalProperties": False}},
    {"name": "fill", "description": "Set the value of a target marked [fillable] (an input or a select, such as a filter). For a select, use one of its options.",
     "input_schema": {"type": "object", "properties": {"target": _T, "value": {"type": "string"}}, "required": ["target", "value"], "additionalProperties": False}},
    {"name": "wait", "description": "Pause the tour before the next action, 100 to 3000 ms.",
     "input_schema": {"type": "object", "properties": {"ms": {"type": "integer"}}, "required": ["ms"], "additionalProperties": False}},
]
UI_TOOL_NAMES = {t["name"] for t in UI_TOOLS}
UI_LABELS = {"navigate": "opening the page", "scroll_to": "finding it on the page", "highlight": "getting it ready to show",
             "click": "setting it up", "fill": "setting the filters", "wait": "setting it up"}


# ---- the manifest the page sends each turn ------------------------------------------------------------------------------------------------
def _s(v: Any, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def _clean_target(t: Any) -> dict | None:
    if not isinstance(t, dict) or not isinstance(t.get("id"), str) or not ID_RE.match(t["id"]):
        return None
    out = {"id": t["id"], "desc": _s(t.get("desc"), 160), "text": _s(t.get("text"), 220)}
    if isinstance(t.get("href"), str) and PATH_RE.match(t["href"]):
        out["href"] = t["href"][:200]
    if t.get("safe") is True:
        out["safe"] = True
    f = t.get("fill")
    if isinstance(f, dict):
        out["fill"] = {"kind": _s(f.get("kind"), 20) or "text",
                       "options": [_s(o, 60) for o in (f.get("options") or [])[:30] if isinstance(o, (str, int, float))]}
        if f.get("value") is not None:
            out["fill"]["value"] = _s(f.get("value"), 60)
    return out


def _clean_targets(ts: Any) -> list[dict]:
    seen, out = set(), []
    for t in (ts if isinstance(ts, list) else [])[:MAX_TARGETS]:
        c = _clean_target(t)
        if c and c["id"] not in seen:
            seen.add(c["id"])
            out.append(c)
    return out


def clean_manifest(raw: Any) -> dict:
    """What the browser sent, trimmed to known fields and sizes. Never trusted beyond being a description of the page."""
    raw = raw if isinstance(raw, dict) else {}
    app = raw.get("app") if isinstance(raw.get("app"), dict) else {}
    page = raw.get("page") if isinstance(raw.get("page"), dict) else {}
    path = page.get("path") if isinstance(page.get("path"), str) and PATH_RE.match(page.get("path") or "") else "/"
    pages = []
    for p in (raw.get("pages") if isinstance(raw.get("pages"), list) else [])[:MAX_PAGES]:
        if isinstance(p, dict) and isinstance(p.get("path"), str) and PATH_RE.match(p["path"]):
            pages.append({"path": p["path"][:200], "title": _s(p.get("title"), 80), "desc": _s(p.get("desc"), 200),
                          "targets": _clean_targets(p.get("targets"))})
    return {"app": {"name": _s(app.get("name"), 80), "description": _s(app.get("description"), 400)},
            "page": {"path": path, "title": _s(page.get("title"), 120)},
            "targets": _clean_targets(raw.get("targets")), "pages": pages}


def _pattern(path: str) -> re.Pattern:
    parts = [("[^/]+" if seg.startswith(":") or (seg.startswith("{") and seg.endswith("}")) else re.escape(seg)) for seg in path.split("/")]
    return re.compile("^" + "/".join(parts) + "/?$")


def match_page(path: str, pages: list[dict]) -> dict | None:
    bare = path.split("?")[0].split("#")[0] or "/"
    for p in pages:                                      # an exact page first, then a :param pattern
        if p["path"] == bare:
            return p
    for p in pages:
        if (":" in p["path"] or "{" in p["path"]) and _pattern(p["path"]).match(bare):
            return p
    return None


def page_map(m: dict) -> str:
    """The manifest as the model reads it (the dynamic part of the system prompt)."""
    def line(t: dict) -> str:
        bits = [f"- {t['id']}: {t['desc'] or 'element'}"]
        if t.get("text"):
            bits.append(f'shows "{t["text"]}"')
        if t.get("href"):
            bits.append(f"links to {t['href']}")
        if t.get("safe"):
            bits.append("[safe]")
        if t.get("fill"):
            f = t["fill"]
            bits.append("[fillable" + (f": {f['kind']}, options " + " | ".join(f["options"]) if f.get("options") else f": {f['kind']}") + "]")
            if f.get("value"):
                bits.append(f"now {f['value']!r}")
        return "; ".join(bits)

    out = []
    if m["app"]["name"]:
        out.append(f"APP: {m['app']['name']}. {m['app']['description']}".strip())
    out.append(f"CURRENT PAGE: {m['page']['path']} ({m['page']['title'] or 'untitled'})")
    out.append("Targets on the current page:" if m["targets"] else "Targets on the current page: none declared.")
    out += [line(t) for t in m["targets"]]
    others = [p for p in m["pages"] if p["path"] != m["page"]["path"]]
    if others:
        out.append("OTHER PAGES you can navigate to:")
        for p in others:
            out.append(f"* {p['path']} ({p['title'] or 'page'}){': ' + p['desc'] if p['desc'] else ''}")
            out += ["  " + line(t) for t in p["targets"]]
    return "\n".join(out)


# ---- one turn's view of the page: which page the tour is on, which targets exist there -----------------------------------------------
@dataclass
class TurnContext:
    manifest: dict
    extra: dict = field(default_factory=dict)            # anything the host's router passes (user, tenant); data tools read it
    path: str = "/"
    actions: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.path = self.manifest["page"]["path"]

    def _targets_here(self) -> list[dict] | None:
        """The targets the tour can use where it is now: the live page's, or after a navigate the declared page's. None when unknown."""
        if self.path == self.manifest["page"]["path"]:
            return self.manifest["targets"]
        p = match_page(self.path, self.manifest["pages"])
        return p["targets"] if p and p["targets"] else None

    def check(self, name: str, args: Any, max_actions: int) -> tuple[dict | None, str]:
        """(action, '') when the UI call is valid, else (None, why). A valid action is recorded with the next cue number."""
        args = args if isinstance(args, dict) else {}
        if len(self.actions) >= max_actions:
            return None, f"At most {max_actions} UI actions per answer. Write the answer now."
        act: dict = {"type": name}
        if name == "navigate":
            path = args.get("path")
            if not isinstance(path, str) or not PATH_RE.match(path):
                return None, "path must be a site path that starts with / (no other site)."
            pages = self.manifest["pages"]
            if pages and not match_page(path, pages) and path.split("?")[0] != self.manifest["page"]["path"]:
                return None, "Unknown page. Pages: " + ", ".join(p["path"] for p in pages)
            act["path"] = path
            self.path = path.split("#")[0]
        elif name == "wait":
            try:
                act["ms"] = max(100, min(3000, int(args.get("ms", 600))))
            except (TypeError, ValueError):
                return None, "ms must be a number of milliseconds."
        else:
            tid = args.get("target")
            if not isinstance(tid, str) or not ID_RE.match(tid):
                return None, "target must be a target id from the PAGE MAP."
            here = self._targets_here()
            t = next((x for x in here if x["id"] == tid), None) if here is not None else None
            if here is not None and t is None:
                names = ", ".join(x["id"] for x in here[:40]) or "none"
                return None, f"Unknown target {tid!r} on {self.path}. Targets there: {names}."
            if name == "click" and t is not None and not t.get("safe"):
                return None, f"{tid!r} is not marked safe to click. Use highlight or scroll_to instead."
            if name == "fill":
                if t is not None and not t.get("fill"):
                    return None, f"{tid!r} is not fillable."
                value = _s(args.get("value"), 120)
                opts = (t or {}).get("fill", {}).get("options") or []
                if opts and value not in opts:
                    low = {o.lower(): o for o in opts}
                    if value.lower() not in low:
                        return None, f"{value!r} is not an option of {tid!r}. Options: " + " | ".join(opts)
                    value = low[value.lower()]
                act["value"] = value
            if name == "highlight":
                act["caption"] = _s(args.get("caption"), 80)
            act["target"] = tid
            if here is None:
                act["unverified"] = True                # a page the manifest did not describe: the browser checks it
        act["id"] = len(self.actions) + 1
        self.actions.append(act)
        return act, ""
