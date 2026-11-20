"""Live mode: one shared, rate-limited status poller per car.

Only `get_status` (Proton's getVehicleStatus, a read of what the cloud holds) is ever repeated:
never position requests, commands, trips, inbox or data plan.

Measure first. Each read records (fetched at, the car's updateTime). While parked:
  - two reads >= 45 s apart with the same updateTime  -> "cached": reads don't wake the car.
  - two reads >= 45 s apart whose updateTime each sits within 20 s of the read -> "wakes".
Until known, live mode runs a short measuring phase (reads 60 s apart, at most 3), then uses:
  cached: 30 s driving, 120 s parked (backing off to 300 s while nothing changes)
  wakes / unknown: 60 s driving, 300 s parked
The result is saved per VIN in instance/live.json.

Stops by itself when: the 12 V battery leaves green (< 12.4 V), 30 minutes pass, 3 reads in a
row fail, or the session expires. Pauses (no Proton reads) while no browser is watching:
browsers send a heartbeat every few seconds while the tab is visible.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from proton.api import ProviderError

log = logging.getLogger("mottokar.live")

GREEN_VOLTS = 12.4
MIN_PLAN_FRACTION = 0.10
MAX_RUN_S = 30 * 60
HEARTBEAT_TIMEOUT_S = 30
MAX_ERRORS = 3
RETRY_S = 60  # after a failed read
MEASURE_GAP_S = 60
MEASURE_READS = 3
CLASSIFY_GAP_S = 45      # reads this far apart can tell "cached" from "wakes"
WAKE_WINDOW_MS = 20_000  # updateTime this close to the read time means the read woke the car
INTERVALS = {
    "cached": {"driving": 30, "parked": 120, "parked_idle": 300},
    "wakes": {"driving": 60, "parked": 300, "parked_idle": 300},
}
INTERVALS["unknown"] = INTERVALS["wakes"]
# The server never reads Proton more often than this for one car, whatever asks.
MIN_GAP_S = 25


def _now() -> float:
    return time.time()


class CarFeed:
    """Latest status for one car plus the reads used to measure."""

    def __init__(self) -> None:
        self.status: Optional[Dict[str, Any]] = None
        self.fetched_at: float = 0
        self.reads: List[Dict[str, Any]] = []  # {at, updateTime, parked}


class LiveManager:
    def __init__(self, store: Path, clock: Callable[[], float] = _now):
        self.store = store
        self.clock = clock
        self._lock = threading.RLock()
        self._feeds: Dict[str, CarFeed] = {}
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._modes: Dict[str, str] = self._load()

    # -- persistence of the measured mode --

    def _load(self) -> Dict[str, str]:
        try:
            return json.loads(self.store.read_text()).get("modes", {})
        except (FileNotFoundError, ValueError):
            return {}

    def _save(self) -> None:
        self.store.parent.mkdir(mode=0o700, exist_ok=True)
        tmp = self.store.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"modes": self._modes}, f)
        os.replace(tmp, self.store)

    def mode(self, vin: str) -> str:
        return self._modes.get(vin, "unknown")

    # -- reads (manual refresh and live polling both come through here) --

    def read(self, vin: str, client: Any, force: bool = False) -> Dict[str, Any]:
        """Status for the car; reuses a read younger than MIN_GAP_S unless `force` (manual refresh)."""
        with self._lock:
            feed = self._feeds.setdefault(vin, CarFeed())
            if not force and feed.status and self.clock() - feed.fetched_at < MIN_GAP_S:
                return feed.status
        res = client.get_status(vin)
        at = self.clock()
        with self._lock:
            feed.status, feed.fetched_at = res, at
            st = res.get("status") or {}
            parked = not st.get("isEngineOn") and not (st.get("speedKmh") or 0)
            feed.reads = (feed.reads + [{"at": at, "updateTime": st.get("updatedAt"), "parked": parked}])[-10:]
            self._classify(vin, feed)
        return res

    def _classify(self, vin: str, feed: CarFeed) -> None:
        if self._modes.get(vin) in ("cached", "wakes"):
            return
        parked = [r for r in feed.reads if r["parked"] and r["updateTime"]]
        for a, b in zip(parked, parked[1:]):
            if b["at"] - a["at"] < CLASSIFY_GAP_S:
                continue
            if a["updateTime"] == b["updateTime"]:
                verdict = "cached"
            elif abs(a["at"] * 1000 - a["updateTime"]) < WAKE_WINDOW_MS and abs(b["at"] * 1000 - b["updateTime"]) < WAKE_WINDOW_MS:
                verdict = "wakes"
            else:
                continue
            self._modes[vin] = verdict
            log.info("Live: %s reads %s", vin[-4:], "come from the cloud cache" if verdict == "cached" else "wake the car")
            self._save()
            return

    # -- live sessions --

    def eligibility(self, vin: str, client: Any) -> Optional[str]:
        """None if live mode may start, else the reason it can't."""
        status = (self.read(vin, client).get("status") or {})
        volts = status.get("batteryVoltage")
        if volts is None:
            return "Your car doesn’t report its 12 V battery voltage"
        if volts < GREEN_VOLTS:
            return f"12 V battery is {volts:.1f} V; live mode needs {GREEN_VOLTS} V or more"
        try:
            usage = client.data_usage(vin)
        except ProviderError:
            usage = None
        if usage and usage.get("usedBytes") is not None and usage.get("remainingBytes") is not None:
            total = usage["usedBytes"] + usage["remainingBytes"]
            if total > 0 and usage["remainingBytes"] / total < MIN_PLAN_FRACTION:
                return "The car’s data plan is below 10%"
        return None

    def start(self, vin: str, client: Any) -> Dict[str, Any]:
        reason = self.eligibility(vin, client)
        if reason:
            return {**self.state(vin), "active": False, "phase": "off", "reason": reason}
        with self._lock:
            cur = self._sessions.get(vin)
            if cur and cur["phase"] in ("measuring", "live", "paused"):
                cur["heartbeat"] = self.clock()
                return self.state(vin)
            now = self.clock()
            sess = {
                "phase": "measuring" if self.mode(vin) == "unknown" else "live",
                "startedAt": now, "endsAt": now + MAX_RUN_S, "heartbeat": now, "errors": 0,
                "measureReads": 0, "unchanged": 0, "nextAt": now, "reason": None, "client": client, "stop": threading.Event(),
            }
            self._sessions[vin] = sess
            threading.Thread(target=self._run, args=(vin, sess), daemon=True).start()
        log.info("Live: started for %s (%s)", vin[-4:], sess["phase"])
        return self.state(vin)

    def stop(self, vin: str, reason: str = "Stopped") -> None:
        with self._lock:
            sess = self._sessions.get(vin)
            if sess and sess["phase"] not in ("stopped",):
                sess["phase"], sess["reason"] = "stopped", reason
                sess["stop"].set()
                log.info("Live: stopped for %s: %s", vin[-4:], reason)

    def heartbeat(self, vin: str) -> None:
        with self._lock:
            sess = self._sessions.get(vin)
            if sess:
                sess["heartbeat"] = self.clock()
                if sess["phase"] == "paused":
                    sess["phase"] = "measuring" if self.mode(vin) == "unknown" else "live"
                    sess["nextAt"] = min(sess["nextAt"], self.clock())
                    sess["stop"].set()  # wake the loop
                    sess["stop"] = threading.Event()

    def state(self, vin: str) -> Dict[str, Any]:
        with self._lock:
            sess = self._sessions.get(vin)
            feed = self._feeds.get(vin)
            base = {"mode": self.mode(vin), "fetchedAt": feed.fetched_at * 1000 if feed and feed.status else None}
            if not sess:
                return {**base, "active": False, "phase": "off", "reason": None}
            return {
                **base,
                "active": sess["phase"] in ("measuring", "live", "paused"),
                "phase": sess["phase"],
                "reason": sess["reason"],
                "nextAt": sess["nextAt"] * 1000,
                "endsAt": sess["endsAt"] * 1000,
                "intervalS": sess.get("intervalS"),
            }

    def latest(self, vin: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            feed = self._feeds.get(vin)
            return feed.status if feed else None

    # -- the poller --

    def _interval(self, vin: str, sess: Dict[str, Any], status: Dict[str, Any]) -> float:
        if sess["phase"] == "measuring":
            return MEASURE_GAP_S
        table = INTERVALS[self.mode(vin)]
        driving = bool(status.get("isEngineOn")) or bool(status.get("speedKmh"))
        if driving:
            return table["driving"]
        return table["parked_idle"] if sess["unchanged"] >= 3 else table["parked"]

    def _run(self, vin: str, sess: Dict[str, Any]) -> None:
        last_update = None
        while True:
            with self._lock:
                if sess["phase"] == "stopped":
                    return
                now = self.clock()
                if now >= sess["endsAt"]:
                    self.stop(vin, "30-minute limit reached")
                    return
                if now - sess["heartbeat"] > HEARTBEAT_TIMEOUT_S:
                    sess["phase"] = "paused"  # nobody is looking: no Proton reads
                wait = sess["nextAt"] - now if sess["phase"] != "paused" else 5
                event = sess["stop"]
            if wait > 0:
                event.wait(min(wait, 5))
                continue
            try:
                res = self.read(vin, sess["client"], force=True)
                sess["errors"] = 0
            except ProviderError as e:
                if e.reauth:
                    self.stop(vin, "Your session expired. Sign in again.")
                    return
                sess["errors"] += 1
                log.warning("Live: read failed for %s (%d): %s", vin[-4:], sess["errors"], e)
                if sess["errors"] >= MAX_ERRORS:
                    self.stop(vin, "Stopped after 3 failed reads")
                    return
                sess["nextAt"] = self.clock() + RETRY_S
                continue
            status = res.get("status") or {}
            volts = status.get("batteryVoltage")
            if volts is not None and volts < GREEN_VOLTS:
                self.stop(vin, f"12 V battery dropped to {volts:.1f} V")
                return
            with self._lock:
                upd = status.get("updatedAt")
                sess["unchanged"] = sess["unchanged"] + 1 if upd == last_update else 0
                last_update = upd
                if sess["phase"] == "measuring":
                    sess["measureReads"] += 1
                    if self.mode(vin) != "unknown" or sess["measureReads"] >= MEASURE_READS:
                        sess["phase"] = "live"  # unknown after 3 reads: keep the strict intervals
                sess["intervalS"] = self._interval(vin, sess, status)
                sess["nextAt"] = self.clock() + sess["intervalS"]
