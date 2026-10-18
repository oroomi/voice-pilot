"""The reference server: the pilot endpoints plus the 3-page demo site.

    python3 -m uvicorn server.app:app --host 127.0.0.1 --port 8151

Keys come from the environment only (ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID); see .env.example for every setting.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from demo import site

from .router import make_router, mount_client

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

app = FastAPI(title="voice-pilot demo", docs_url=None, redoc_url=None)
pilot = make_router(site.registry, app_name=site.APP_NAME, app_description=site.APP_DESC, rehearsal_plan=site.plan)
app.include_router(pilot)
mount_client(app)
app.mount("/demo-static", StaticFiles(directory=str(site.HERE / "static")), name="demo-static")
app.include_router(site.router)
