"""In-memory limits (a restart resets them): requests per IP per minute, chat turns per UTC day, spoken characters per UTC day."""
from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime, timezone


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


class Limiter:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        self.hits: dict[str, deque] = {}
        self.day, self.turns = "", 0
        self.tts_day, self.tts_chars = "", 0

    def check(self, ip: str, rate_per_min: int, daily_turns: int, now: float | None = None) -> str | None:
        """None when allowed (and counted); 'rate' or 'cap' when refused."""
        now = time.monotonic() if now is None else now
        with self.lock:
            if self.day != _today():
                self.day, self.turns = _today(), 0
            q = self.hits.setdefault(ip, deque())
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= rate_per_min:
                return "rate"
            if self.turns >= daily_turns:
                return "cap"
            q.append(now)
            self.turns += 1
            if len(self.hits) > 5000:
                for k in [k for k, v in self.hits.items() if not v or now - v[-1] > 60]:
                    self.hits.pop(k, None)
            return None

    def charge_tts(self, chars: int, cap: int) -> bool:
        with self.lock:
            if self.tts_day != _today():
                self.tts_day, self.tts_chars = _today(), 0
            if self.tts_chars + chars > cap:
                return False
            self.tts_chars += chars
            return True

    def refund_tts(self, chars: int) -> None:
        with self.lock:
            self.tts_chars = max(0, self.tts_chars - chars)

    def tts_left(self, cap: int) -> int:
        with self.lock:
            return cap if self.tts_day != _today() else max(0, cap - self.tts_chars)


def client_ip(request) -> str:
    h = request.headers
    return (h.get("cf-connecting-ip") or (h.get("x-forwarded-for") or "").split(",")[0].strip()
            or (request.client.host if request.client else "?"))[:64]
