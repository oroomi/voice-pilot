"""The HTTP surface, as one APIRouter a host FastAPI app includes:

    from server.router import make_router, mount_client
    from server.registry import Registry

    registry = Registry()                              # register the app's read-only data tools on it
    app.include_router(make_router(registry, app_name="My app", app_description="What it does, one sentence."))
    mount_client(app)                                  # serves client/pilot.js and pilot.css at /pilot/client/

  GET  /pilot/status  {llm, mode, model, tts, tts_chars_left, name}   booleans and names only, never a key
  POST /pilot/chat    {messages, manifest, reports} -> text/event-stream: status, delta, action, error, done
  POST /pilot/tts     {text} -> audio/mpeg (ElevenLabs), or 404/429/502 JSON so the browser uses its own voice
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import config
from .fake import Plan, rehearsal_client
from .limits import Limiter, client_ip
from .registry import Registry, clean_manifest
from .tts import Voice
from .turn import Turn, clean_messages, make_client

log = logging.getLogger("voice_pilot.http")
SSE_HEADERS = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
CLIENT_DIR = Path(__file__).resolve().parent.parent / "client"


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@dataclass
class PilotState:
    registry: Registry
    app_name: str = ""
    app_description: str = ""
    persona: str = ""
    rehearsal_plan: Plan | None = None
    extra: Callable[[Request], dict] | None = None
    limiter: Limiter = field(default_factory=Limiter)
    voice: Voice | None = None
    # (settings, question, manifest) -> a client with .messages.stream(**kw). Tests replace it with a fake.
    client_factory: Callable | None = None

    def mode(self, s: config.Settings) -> str:
        if s.rehearsal:
            return "rehearsal"
        return "live" if config.anthropic_key_present() else "off"

    def client(self, s: config.Settings, question: str, manifest: dict):
        if self.client_factory is not None:
            return self.client_factory(s, question, manifest)
        if s.rehearsal:
            return rehearsal_client(self.rehearsal_plan, question, manifest, s.assistant_name)
        return make_client(s)


def make_router(registry: Registry, *, prefix: str = "/pilot", app_name: str = "", app_description: str = "", persona: str = "",
                rehearsal_plan: Plan | None = None, extra: Callable[[Request], dict] | None = None) -> APIRouter:
    router = APIRouter()
    st = PilotState(registry, app_name, app_description, persona, rehearsal_plan, extra)
    st.voice = Voice(st.limiter)
    router.pilot = st  # type: ignore[attr-defined]   (tests and hosts reach the state here)

    @router.get(f"{prefix}/status")
    def status():
        s = config.settings()
        tts = bool(config.elevenlabs_key() and s.tts_voice_id)
        return JSONResponse({"name": s.assistant_name, "mode": st.mode(s), "llm": st.mode(s) != "off", "model": s.model if st.mode(s) == "live" else None,
                             "tts": tts, "tts_chars_left": st.limiter.tts_left(s.tts_daily_chars) if tts else 0},
                            headers={"Cache-Control": "no-store"})

    def refuse(kind: str, message: str, code: int, headers: dict | None = None):
        def gen():
            yield sse("error", {"kind": kind, "message": message})
        return StreamingResponse(gen(), status_code=code, media_type="text/event-stream", headers={**SSE_HEADERS, **(headers or {})})

    @router.post(f"{prefix}/chat")
    async def chat(request: Request):
        s = config.settings()
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError
        except Exception:  # noqa: BLE001
            return JSONResponse({"error": "send a JSON body {messages, manifest}"}, status_code=400)
        try:
            messages = clean_messages(body.get("messages"), s)
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        manifest = clean_manifest(body.get("manifest"))
        if st.app_name and not manifest["app"]["name"]:
            manifest["app"]["name"] = st.app_name
        if st.app_description and not manifest["app"]["description"]:
            manifest["app"]["description"] = st.app_description
        if st.mode(s) == "off" and st.client_factory is None:
            return refuse("no_key", f"{s.assistant_name}'s reasoning is not switched on yet: the server needs ANTHROPIC_API_KEY.", 200)
        refused = st.limiter.check(client_ip(request), s.rate_per_min, s.daily_turns)
        if refused == "rate":
            return refuse("rate", "That is a lot of questions in a minute. Give me a moment and ask again.", 429, {"Retry-After": "30"})
        if refused == "cap":
            return refuse("cap", f"{s.assistant_name} has answered all the questions it can for today.", 429, {"Retry-After": "3600"})
        question = messages[-1]["content"]
        try:
            client = st.client(s, question, manifest)
        except Exception:  # noqa: BLE001
            log.exception("could not build the model client")
            return refuse("api", f"{s.assistant_name}'s reasoning is not available right now.", 200)
        turn = Turn(messages, manifest, st.registry, client, s, persona=st.persona, extra=(st.extra(request) if st.extra else {}),
                    reports=body.get("reports"))

        def gen():
            try:
                for ev in turn.events():
                    yield sse(ev["event"], ev["data"])
            except Exception:  # noqa: BLE001
                log.exception("stream failed")
                yield sse("error", {"kind": "internal", "message": f"{s.assistant_name} hit a snag."})

        return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)

    @router.post(f"{prefix}/tts")
    async def tts(request: Request):
        try:
            body = await request.json()
            text = body.get("text") if isinstance(body, dict) else None
        except Exception:  # noqa: BLE001
            text = None
        if not isinstance(text, str):
            return JSONResponse({"error": "send {text}"}, status_code=400)
        return await st.voice.respond(text)

    return router


def mount_client(app, prefix: str = "/pilot") -> None:
    """Serve client/pilot.js, pilot.global.js and pilot.css at {prefix}/client/."""
    from fastapi.staticfiles import StaticFiles
    app.mount(f"{prefix}/client", StaticFiles(directory=str(CLIENT_DIR)), name="pilot-client")
