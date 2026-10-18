"""A stand-in for anthropic.Anthropic with the same `messages.stream(**kw)` surface: used by the unit tests and by rehearsal mode.

Rehearsal mode (PILOT_REHEARSAL=1) runs the real tool loop, validation and SSE stream with a scripted "model" built from the host's plan function,
so a demo still works on a dead network. It is labelled as rehearsal in /pilot/status and in the overlay; it is never presented as the live model.
"""
from __future__ import annotations

import itertools
from types import SimpleNamespace as NS
from typing import Callable

_ids = itertools.count(1)


def text(t: str, chunks: list[str] | None = None) -> NS:
    """A text block; `chunks` streams it in exactly those pieces (the real API splits mid-word)."""
    return NS(type="text", text=t, chunks=chunks)


def tool(name: str, **inp) -> NS:
    return NS(type="tool_use", id=f"toolu_fake_{next(_ids)}", name=name, input=inp)


def reply(*blocks, stop: str | None = None) -> dict:
    stop = stop or ("tool_use" if any(b.type == "tool_use" for b in blocks) else "end_turn")
    return {"content": list(blocks), "stop_reason": stop}


class FakeStream:
    def __init__(self, r: dict, chunk_words: int = 3) -> None:
        self.r, self.chunk = r, chunk_words

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        for i, b in enumerate(self.r["content"]):
            yield NS(type="content_block_start", index=i, content_block=b)
            if b.type == "text" and getattr(b, "chunks", None):
                for piece in b.chunks:
                    yield NS(type="content_block_delta", index=i, delta=NS(type="text_delta", text=piece))
            elif b.type == "text":
                words = b.text.split(" ")
                for j in range(0, len(words), self.chunk):
                    piece = " ".join(words[j:j + self.chunk]) + (" " if j + self.chunk < len(words) else "")
                    yield NS(type="content_block_delta", index=i, delta=NS(type="text_delta", text=piece))
            yield NS(type="content_block_stop", index=i)

    def get_final_message(self):
        return NS(content=self.r["content"], stop_reason=self.r["stop_reason"],
                  usage=NS(input_tokens=100, output_tokens=40, cache_creation_input_tokens=0, cache_read_input_tokens=0))


class FakeClient:
    """`script` is a list of replies used in order, or a callable(kw) -> reply. Every request is kept in `.calls`."""

    def __init__(self, script) -> None:
        self.calls: list[dict] = []
        self._script = script
        outer = self

        class _Messages:
            def stream(self, **kw):
                kw = {**kw, "messages": list(kw.get("messages") or [])}   # a snapshot: the turn keeps appending to its own list
                outer.calls.append(kw)
                r = outer._script(kw) if callable(outer._script) else outer._script.pop(0)
                if isinstance(r, Exception):
                    raise r
                return FakeStream(r)

        self.messages = _Messages()


# ---- rehearsal: a plan becomes tool calls, then the answer with the cues the real validator handed out --------------------------------
Plan = Callable[[str, dict], list[dict]]          # (question, manifest) -> [{"say": "...", "do": [("highlight", {"target": "x"}), ...]}, ...]


def rehearsal_client(plan: Plan | None, question: str, manifest: dict, name: str = "Aava") -> FakeClient:
    beats = (plan(question, manifest) if plan else None) or [
        {"say": f"Rehearsal mode is on, and I have no rehearsed answer for that. Try asking for the best match.", "do": []}]
    calls: list[tuple[int, NS]] = []                        # (beat index, tool_use block)
    for i, b in enumerate(beats):
        for name_, args in b.get("do", []):
            calls.append((i, tool(name_, **args)))

    def script(kw):
        last = kw["messages"][-1]
        results = last["content"] if isinstance(last.get("content"), list) else None
        if calls and results is None:
            return reply(*[c for _, c in calls])
        cue_of = {}
        for r in results or []:
            if isinstance(r, dict) and r.get("type") == "tool_result" and not r.get("is_error"):
                import re
                m = re.search(r"\[\[(\d+)\]\]", r["content"])
                if m:
                    cue_of[r["tool_use_id"]] = m.group(1)
        parts = []
        for i, b in enumerate(beats):
            cues = "".join(f"[[{cue_of[c.id]}]] " for bi, c in calls if bi == i and c.id in cue_of)
            parts.append(cues + b["say"])
        return reply(text(" ".join(parts)))

    return FakeClient(script)
