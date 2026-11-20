"""Countdowns for running features, kept in memory only (lost when the server restarts).

- engine: the car enforces the run time it was started with; this is just the countdown.
- climate: optional auto-off. When it expires the server sends climate_off once (no hold needed:
  turning things off is the safe direction), skipping it if the car is moving.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

log = logging.getLogger("mottokar.timers")

Key = Tuple[str, str]  # (session key, vin)


class Timers:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._items: Dict[Key, Dict[str, Dict[str, Any]]] = {}

    def list(self, owner: str, vin: str) -> List[Dict[str, Any]]:
        now = time.time() * 1000
        with self._lock:
            items = self._items.get((owner, vin), {})
            # Drop finished countdowns that have nothing left to report.
            for kind in [k for k, t in items.items() if t["endsAt"] < now - 60_000 and not t.get("outcome")]:
                items.pop(kind)
            return [{k: v for k, v in t.items() if k != "_timer"} for t in items.values()]

    def start(self, owner: str, vin: str, kind: str, minutes: float,
              on_expire: Optional[Callable[[], str]] = None) -> Dict[str, Any]:
        self.cancel(owner, vin, kind)
        ends = time.time() * 1000 + minutes * 60_000
        entry: Dict[str, Any] = {"kind": kind, "endsAt": ends, "minutes": minutes, "autoOff": on_expire is not None}
        if on_expire:
            def fire():
                try:
                    outcome = on_expire()
                except Exception as e:  # never let a timer thread crash silently
                    log.warning("%s auto-off failed: %s", kind, e)
                    outcome = f"Auto-off failed: {e}"
                with self._lock:
                    cur = self._items.get((owner, vin), {}).get(kind)
                    if cur is entry:
                        cur["outcome"] = outcome
                        cur.pop("_timer", None)
            t = threading.Timer(minutes * 60, fire)
            t.daemon = True
            entry["_timer"] = t
            t.start()
        with self._lock:
            self._items.setdefault((owner, vin), {})[kind] = entry
        return {k: v for k, v in entry.items() if k != "_timer"}

    def cancel(self, owner: str, vin: str, kind: str) -> bool:
        with self._lock:
            entry = self._items.get((owner, vin), {}).pop(kind, None)
        if entry and entry.get("_timer"):
            entry["_timer"].cancel()
        return entry is not None

    def forget_owner(self, owner: str) -> None:
        with self._lock:
            keys = [k for k in self._items if k[0] == owner]
            entries = [e for k in keys for e in self._items.pop(k).values()]
        for e in entries:
            if e.get("_timer"):
                e["_timer"].cancel()
