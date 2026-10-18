"""The spoken voice: an ElevenLabs streaming proxy with a daily character cap and an in-memory cache of identical text.

The browser falls back to its own voice (speechSynthesis) on any non-200 answer, so every failure here is a clean status code, never a 200 with
an empty body: the upstream answer is opened first and only a 200 is streamed through.
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading
from collections import OrderedDict
from typing import AsyncIterator, Awaitable, Callable
from urllib.parse import quote

from . import config
from .limits import Limiter

log = logging.getLogger("voice_pilot.tts")

_CUE = re.compile(r"\[\[\s*\d{1,2}\s*\]\]")
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")


def spoken(text: str) -> str:
    """Text as it should be said: cue markers, markdown and URLs off, whitespace collapsed."""
    t = _CUE.sub("", text or "")
    t = _MD_LINK.sub(r"\1", t)
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"[*_`#>]+", "", t)
    return " ".join(t.split())


# An upstream returns (status, chunks, close). Tests replace Voice.upstream with a fake; production uses ElevenLabs.
Upstream = Callable[[str, config.Settings, str], Awaitable[tuple[int, AsyncIterator[bytes], Callable[[], Awaitable[None]]]]]


async def elevenlabs(text: str, s: config.Settings, key: str):
    import httpx

    url = (f"https://api.elevenlabs.io/v1/text-to-speech/{quote(s.tts_voice_id, safe='')}/stream"
           f"?output_format={quote(s.tts_format, safe='')}")
    payload = {"text": text, "model_id": s.tts_model, "voice_settings": {"stability": 0.5, "similarity_boost": 0.8}}
    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0))
    try:
        req = client.build_request("POST", url, json=payload, headers={"xi-api-key": key, "Accept": "audio/mpeg"})
        resp = await client.send(req, stream=True)
    except Exception as e:  # noqa: BLE001
        await client.aclose()
        log.warning("ElevenLabs request failed: %s", type(e).__name__)
        return 599, _empty(), _noop

    async def close():
        await resp.aclose()
        await client.aclose()

    if resp.status_code != 200:
        log.warning("ElevenLabs answered %s", resp.status_code)
    return resp.status_code, resp.aiter_bytes(), close


async def _empty():
    if False:  # pragma: no cover
        yield b""


async def _noop():
    return None


class Voice:
    def __init__(self, limiter: Limiter, upstream: Upstream | None = None) -> None:
        self.limiter = limiter
        self.upstream: Upstream = upstream or elevenlabs
        self.cache: OrderedDict[str, bytes] = OrderedDict()
        self.lock = threading.Lock()

    def key(self, text: str, s: config.Settings) -> str:
        return hashlib.sha256(f"{s.tts_voice_id}|{s.tts_model}|{s.tts_format}|{text}".encode()).hexdigest()

    def cached(self, k: str) -> bytes | None:
        with self.lock:
            b = self.cache.get(k)
            if b is not None:
                self.cache.move_to_end(k)
            return b

    def store(self, k: str, b: bytes, s: config.Settings) -> None:
        with self.lock:
            self.cache[k] = b
            self.cache.move_to_end(k)
            while len(self.cache) > max(1, s.tts_cache_items):
                self.cache.popitem(last=False)

    async def respond(self, raw_text):
        """A Starlette response for {text}: audio/mpeg (streamed, or from the cache) or a JSON error the browser falls back on."""
        from fastapi.responses import JSONResponse, Response, StreamingResponse

        s, key = config.settings(), config.elevenlabs_key()
        if not key or not s.tts_voice_id:
            return JSONResponse({"error": "the server voice is not configured; the browser voice is used"}, status_code=404)
        text = spoken(str(raw_text or ""))[: s.tts_max_chars]
        if not text:
            return JSONResponse({"error": "no text"}, status_code=400)
        k = self.key(text, s)
        hit = self.cached(k)
        if hit is not None:                                     # identical text: no new characters are spent
            return Response(hit, media_type="audio/mpeg", headers={"Cache-Control": "no-store", "X-Pilot-Cache": "hit"})
        if not self.limiter.charge_tts(len(text), s.tts_daily_chars):
            return JSONResponse({"error": "the daily limit of spoken characters is used up; the browser voice is used"}, status_code=429)
        status, chunks, close = await self.upstream(text, s, key)
        if status != 200:
            await close()
            self.limiter.refund_tts(len(text))
            return JSONResponse({"error": f"the voice service answered {status}"}, status_code=502)

        async def body():
            buf: list[bytes] = []
            done = False
            try:
                async for c in chunks:
                    buf.append(c)
                    yield c
                done = True
            finally:
                await close()
                if done and buf:
                    self.store(k, b"".join(buf), s)

        return StreamingResponse(body(), media_type="audio/mpeg", headers={"Cache-Control": "no-store", "X-Pilot-Cache": "miss"})
