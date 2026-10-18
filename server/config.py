"""Settings, read from the environment on every call (so tests can monkeypatch and a restart picks up a new EnvironmentFile).

Keys are only ever read from os.environ and are never returned, logged or echoed. Every name is listed in .env.example.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

log = logging.getLogger("voice_pilot")


def _get(name: str, default, cast=str):
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return cast(str(raw).strip())
    except (TypeError, ValueError):
        log.warning("%s=%r is not a valid %s; using %r", name, raw, cast.__name__, default)
        return default


@dataclass(frozen=True)
class Settings:
    assistant_name: str
    model: str
    effort: str
    thinking: str            # "adaptive" (default) or "between_tools" (Sonnet 5.5 only: no extended thinking, lowest latency)
    fallbacks: str           # "default" sends the server-side refusal fallback (Claude API); "off" sends nothing
    max_tokens: int
    max_steps: int
    timeout_s: float
    turn_deadline_s: float
    rate_per_min: int
    daily_turns: int
    max_actions: int
    input_chars: int
    history_turns: int
    rehearsal: bool
    tts_voice_id: str
    tts_model: str
    tts_format: str
    tts_daily_chars: int
    tts_max_chars: int
    tts_cache_items: int


def settings() -> Settings:
    return Settings(
        assistant_name=_get("PILOT_ASSISTANT_NAME", "Aava"),
        model=_get("PILOT_MODEL", "claude-sonnet-5-5"),
        effort=_get("PILOT_EFFORT", "low"),
        thinking=_get("PILOT_THINKING", "adaptive"),
        fallbacks=_get("PILOT_FALLBACKS", "default"),
        max_tokens=_get("PILOT_MAX_TOKENS", 4096, int),
        max_steps=_get("PILOT_MAX_STEPS", 5, int),
        timeout_s=_get("PILOT_TIMEOUT_S", 30.0, float),
        turn_deadline_s=_get("PILOT_TURN_DEADLINE_S", 45.0, float),
        rate_per_min=_get("PILOT_RATE_PER_MIN", 12, int),
        daily_turns=_get("PILOT_DAILY_TURNS", 400, int),
        max_actions=_get("PILOT_MAX_ACTIONS", 8, int),
        input_chars=_get("PILOT_INPUT_CHARS", 600, int),
        history_turns=_get("PILOT_HISTORY_TURNS", 10, int),
        rehearsal=_get("PILOT_REHEARSAL", "0") in ("1", "true", "yes", "on"),
        tts_voice_id=_get("ELEVENLABS_VOICE_ID", ""),
        tts_model=_get("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
        tts_format=_get("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128"),
        tts_daily_chars=_get("PILOT_TTS_DAILY_CHARS", 20000, int),
        tts_max_chars=_get("PILOT_TTS_MAX_CHARS", 600, int),
        tts_cache_items=_get("PILOT_TTS_CACHE_ITEMS", 200, int),
    )


def anthropic_key_present() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())


def elevenlabs_key() -> str:
    return os.environ.get("ELEVENLABS_API_KEY", "").strip()
