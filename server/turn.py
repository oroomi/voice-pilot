"""One voice turn: a short tool loop over the Anthropic Messages API, as a generator of events.

Events (the SSE route writes each as `event: <name>` / `data: <json>`):
  status {label}                        what Aava is doing, for the overlay ("checking the records")
  delta  {text, step}                   answer text as the model writes it; it may hold cue markers like [[2]]
  action {id, type, target?, path?, caption?, value?, ms?}   a validated UI action for the browser; id is the cue number
  error  {kind, message}                a sentence safe to show and speak; the turn ends
  done   {text, actions, steps, ms, usage, model}

The answer is spoken, so it is short (ANSWER_SHAPE). UI tools answer with a cue number and the model places [[n]] at the start of the sentence the
action belongs with; the browser fires the action as that sentence starts playing (docs/ACTIONS.md). Thinking blocks are passed back unchanged.
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Iterator

from . import config
from .registry import UI_LABELS, UI_TOOL_NAMES, UI_TOOLS, Registry, TurnContext, page_map

log = logging.getLogger("voice_pilot.turn")

ANSWER_SHAPE = (
    "Answer shape, every time: your words are read aloud, so write ONE short paragraph, no line breaks, at most 4 sentences and about 70 words "
    "(a greeting or thanks: one sentence). Lead with the direct answer, name at most 3 things, say why with one concrete fact each, and end with one "
    "next step when it helps. No markdown, no bullets, no emoji, no URLs. Never mention your tools, cues, ids, searches or what they returned, and never "
    "say 'let me highlight': say what the records show while the page shows it. Write nothing before your tool calls are done.")

TOUR_RULES = (
    "You can drive this website while you talk. When the answer is about something on a page, show it: call the UI tools (navigate, scroll_to, "
    "highlight, fill, click, wait) in the order they should happen; you may call several at once. Each valid UI call answers with a cue like [[2]]. "
    "Then write the spoken answer and put each cue at the START of the sentence it belongs with, for example: "
    "\"[[1]] Here are the matches. [[2]] The best one is Kelpforge, at 92, because ... [[3]] Its next step is ...\". "
    "The page acts as that sentence starts playing. Use only page paths and target ids from the PAGE MAP, never CSS selectors; navigate before you "
    "highlight something on another page; click only [safe] targets; fill only [fillable] ones. If a UI call is refused, fix it or skip it. "
    "A question that needs nothing on screen gets no UI calls.")

FINAL_NOTE = "This is your last round: do not call a tool. Write the spoken answer now from what you have, with the cues you already got."
SPOKEN_CUE = re.compile(r"\[\[?\s*\d{1,2}\s*\]\]?")


def system_prompt(s: config.Settings, app_name: str, app_desc: str, persona: str = "") -> str:
    who = f"You are {s.assistant_name}, the voice assistant inside {app_name or 'this web app'}."
    return "\n\n".join(x for x in [who, app_desc, persona, TOUR_RULES, ANSWER_SHAPE] if x)


def clean_messages(raw, s: config.Settings) -> list[dict]:
    """The conversation as the API wants it: user/assistant text only, the newest a user message. ValueError carries a message safe to show."""
    if not isinstance(raw, list) or not raw:
        raise ValueError("messages must be a non-empty list")
    out: list[dict] = []
    for m in raw[-s.history_turns:]:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant") or not isinstance(m.get("content"), str):
            raise ValueError("each message needs a role (user or assistant) and a text content")
        text = " ".join(m["content"].split())
        if text:
            out.append({"role": m["role"], "content": text[:2000]})
    while out and out[0]["role"] != "user":
        out.pop(0)
    if not out or out[-1]["role"] != "user":
        raise ValueError("the last message must be from the user")
    if len(out[-1]["content"]) > s.input_chars:
        raise ValueError(f"a question can be at most {s.input_chars} characters")
    merged: list[dict] = []                       # two user messages in a row (a turn that failed) become one
    for m in out:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1] = {"role": m["role"], "content": merged[-1]["content"] + " " + m["content"]}
        else:
            merged.append(m)
    return merged


def report_note(reports) -> str:
    """Actions the browser could not run last turn, as one line the model reads with the new question."""
    bad = []
    for r in (reports if isinstance(reports, list) else [])[:10]:
        if isinstance(r, dict) and r.get("ok") is False:
            what = " ".join(str(r.get(k) or "") for k in ("type", "target", "path")).strip()[:120]
            bad.append(f"{what} ({str(r.get('why') or 'failed')[:80]})")
    return ("(Note from the page: these actions from your last answer did not run: " + "; ".join(bad) + ".)") if bad else ""


def make_client(s: config.Settings):
    import anthropic
    return anthropic.Anthropic(timeout=s.timeout_s, max_retries=1)   # the SDK reads ANTHROPIC_API_KEY itself


class Turn:
    def __init__(self, messages: list[dict], manifest: dict, registry: Registry, client, s: config.Settings | None = None,
                 persona: str = "", extra: dict | None = None, reports=None):
        self.s = s or config.settings()
        self.messages: list = [dict(m) for m in messages]
        note = report_note(reports)
        if note:
            self.messages[-1] = {"role": "user", "content": self.messages[-1]["content"] + "\n\n" + note}
        self.ctx = TurnContext(manifest, extra=extra or {})
        self.registry = registry
        self.client = client
        self.persona = persona
        self.usage = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
        self.steps = 0
        self.text = ""
        self.trace: list[dict] = []
        self._no_extras = False

    # -- the request ----------------------------------------------------------------------------------------------------------------------
    def params(self, final: bool) -> dict:
        s, m = self.s, self.ctx.manifest
        system = [{"type": "text", "text": system_prompt(s, m["app"]["name"], m["app"]["description"], self.persona),
                   "cache_control": {"type": "ephemeral"}},
                  {"type": "text", "text": "PAGE MAP (what you can show)\n" + page_map(m) + (f"\n\n{FINAL_NOTE}" if final else "")}]
        kw = {"model": s.model, "max_tokens": s.max_tokens, "system": system, "messages": self.messages,
              "tools": [*UI_TOOLS, *self.registry.specs()]}
        if final:
            kw["tool_choice"] = {"type": "none"}
        if not self._no_extras:
            if s.thinking == "between_tools":
                kw["thinking"] = {"type": "between_tools"}
            else:
                kw["thinking"] = {"type": "adaptive"}
                if s.effort in ("low", "medium", "high", "xhigh", "max"):
                    kw["output_config"] = {"effort": s.effort}
            if s.fallbacks == "default":
                kw["extra_headers"] = {"anthropic-beta": "server-side-fallback-2026-07-01"}
                kw["extra_body"] = {"fallbacks": "default"}
        return kw

    def _call(self, kw: dict, step: int) -> Iterator[dict]:
        """Stream one model call: text deltas go out as they arrive; returns the final message."""
        with self.client.messages.stream(**kw) as stream:
            for ev in stream:
                t = getattr(ev, "type", "")
                if t == "content_block_start":
                    blk = getattr(ev, "content_block", None)
                    if getattr(blk, "type", "") == "tool_use":
                        name = getattr(blk, "name", "")
                        label = UI_LABELS.get(name) if name in UI_TOOL_NAMES else self.registry.label(name)
                        yield {"event": "status", "data": {"label": label, "tool": name}}
                elif t == "content_block_delta":
                    d = getattr(ev, "delta", None)
                    if getattr(d, "type", "") == "text_delta" and getattr(d, "text", ""):
                        if step > 1 and self.text and not self.text.endswith((" ", "\n")):
                            self.text += " "
                            yield {"event": "delta", "data": {"text": " ", "step": step}}
                        self.text += d.text
                        yield {"event": "delta", "data": {"text": d.text, "step": step}}
            return stream.get_final_message()

    # -- the loop -------------------------------------------------------------------------------------------------------------------------
    def events(self) -> Iterator[dict]:
        try:
            import anthropic as sdk
        except ImportError:  # a test with a fake client can run without the SDK
            sdk = None
        s = self.s
        t0 = time.monotonic()
        yield {"event": "status", "data": {"label": "thinking"}}
        final = False
        try:
            while True:
                if time.monotonic() - t0 > s.turn_deadline_s:
                    yield self._err("timeout", f"{s.assistant_name} took too long on that one.")
                    return
                self.steps += 1
                final = final or self.steps >= s.max_steps
                kw = self.params(final)
                try:
                    msg = yield from self._call(kw, self.steps)
                except Exception as e:  # noqa: BLE001
                    bad = sdk is not None and isinstance(e, sdk.BadRequestError)
                    if bad and not self._no_extras and re.search(r"thinking|effort|output_config|fallback", str(e), re.I):
                        log.warning("the API refused the thinking/fallback parameters for %s; retrying once without them: %s", s.model, str(e)[:200])
                        self._no_extras = True
                        msg = yield from self._call(self.params(final), self.steps)
                    else:
                        raise
                self._usage(getattr(msg, "usage", None))
                content = list(getattr(msg, "content", None) or [])
                stop = getattr(msg, "stop_reason", None)
                uses = [b for b in content if getattr(b, "type", "") == "tool_use"]
                self.trace.append({"step": self.steps, "stop": stop, "tools": [b.name for b in uses], "s": round(time.monotonic() - t0, 2)})
                if stop == "refusal":
                    yield self._err("refusal", f"{s.assistant_name} can't help with that one.")
                    return
                if stop == "tool_use" and uses and not final:
                    self.messages.append({"role": "assistant", "content": content})
                    results = []
                    for b in uses:
                        body, ok, act = self._run(b.name, getattr(b, "input", {}) or {})
                        if act:
                            yield {"event": "action", "data": act}
                        results.append({"type": "tool_result", "tool_use_id": b.id, "content": body, **({} if ok else {"is_error": True})})
                    self.messages.append({"role": "user", "content": results})
                    continue
                break
        except Exception as e:  # noqa: BLE001
            yield self._classify(e, sdk)
            return
        if not SPOKEN_CUE.sub("", self.text).strip():
            yield self._err("empty", f"{s.assistant_name} did not find words for that one. Try asking another way.")
            return
        ms = round((time.monotonic() - t0) * 1000)
        log.info("turn %s", json.dumps({"model": s.model, "steps": self.steps, "ms": ms, "usage": self.usage, "trace": self.trace}))
        yield {"event": "done", "data": {"text": self.text.strip(), "actions": self.ctx.actions, "steps": self.steps, "ms": ms,
                                         "usage": dict(self.usage), "model": s.model}}

    def _run(self, name: str, args: dict) -> tuple[str, bool, dict | None]:
        if name in UI_TOOL_NAMES:
            act, why = self.ctx.check(name, args, self.s.max_actions)
            if act is None:
                return why, False, None
            n = act["id"]
            return f"Queued as cue [[{n}]]. Put [[{n}]] at the start of the sentence it belongs with.", True, act
        if self.registry.has(name):
            body, ok = self.registry.run(name, args, self.ctx)
            return body, ok, None
        return f"There is no tool called {name}.", False, None

    def _usage(self, u) -> None:
        for k in self.usage:
            self.usage[k] += int(getattr(u, k, 0) or 0)

    def _err(self, kind: str, message: str) -> dict:
        log.warning("turn ended: %s", kind)
        return {"event": "error", "data": {"kind": kind, "message": message}}

    def _classify(self, e: Exception, sdk) -> dict:
        name = self.s.assistant_name
        if sdk is not None:
            if isinstance(e, sdk.APITimeoutError):
                return self._err("timeout", f"{name} took too long to answer.")
            if isinstance(e, sdk.RateLimitError):
                return self._err("busy", f"{name} is busy right now. Try again in a moment.")
            if isinstance(e, sdk.AuthenticationError):
                return self._err("auth", f"{name}'s model key was refused.")
            if isinstance(e, sdk.APIStatusError):
                log.error("Messages API answered %s", getattr(e, "status_code", "?"))
            elif isinstance(e, sdk.APIConnectionError):
                return self._err("network", f"{name} can't reach the model right now.")
        log.exception("turn failed: %s", type(e).__name__)
        return self._err("api", f"{name}'s reasoning is not available right now.")
