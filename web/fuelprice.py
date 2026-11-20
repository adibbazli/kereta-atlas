"""Malaysian weekly pump prices from data.gov.my (OpenDOSM), for trip fuel cost estimates.

Source: https://storage.data.gov.my/commodities/fuelprice.parquet (CC BY 4.0). One row per week and
series_type: "level" rows are prices in RM/litre, "change_weekly" rows are deltas, which we skip.
Fetched at most every few hours and cached in instance/, so the app keeps working if the source is down.
"""

from __future__ import annotations

import io
import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

log = logging.getLogger("fuelprice")

URL = "https://storage.data.gov.my/commodities/fuelprice.parquet"
TTL_S = 6 * 3600
RETRY_S = 10 * 60  # after a failed download, serve the cached copy this long before trying again
TIMEOUT_S = 20
MAX_BYTES = 5 * 1024 * 1024


class FuelPriceError(Exception):
    pass


def _parse(blob: bytes) -> List[Dict[str, Any]]:
    try:
        import pyarrow.parquet as pq  # imported here so the rest of the app runs without it
    except ImportError:
        raise FuelPriceError("Fuel prices need the pyarrow package (pip install -r requirements.txt)") from None
    table = pq.read_table(io.BytesIO(blob), columns=["series_type", "date", "ron95", "ron95_budi95"])
    weeks = []
    for r in table.to_pylist():
        if r.get("series_type") != "level" or r.get("date") is None:
            continue
        weeks.append({
            "date": r["date"].isoformat(),  # first day the price applies (weekly, Thursdays)
            "budi95": r.get("ron95_budi95"),
            "ron95": r.get("ron95"),
        })
    weeks.sort(key=lambda w: w["date"])
    if not weeks:
        raise FuelPriceError("Fuel price file had no price rows")
    return weeks


class FuelPrices:
    def __init__(self, cache_file: Path):
        self.cache_file = cache_file
        self.lock = threading.Lock()
        self.data: Optional[Dict[str, Any]] = None
        self.retry_at = 0.0
        try:
            self.data = json.loads(cache_file.read_text())
        except (OSError, ValueError):
            pass

    def get(self) -> Dict[str, Any]:
        with self.lock:
            now = time.time()
            if self.data and now - self.data.get("fetchedAt", 0) / 1000 < TTL_S:
                return self.data
            if self.data and now < self.retry_at:
                return {**self.data, "stale": True}
            try:
                self.data = self._fetch()
                try:
                    self.cache_file.write_text(json.dumps(self.data))
                except OSError as e:
                    log.warning("Couldn't cache fuel prices: %s", e)
                return self.data
            except FuelPriceError as e:
                self.retry_at = now + RETRY_S
                if self.data:
                    log.warning("Fuel price refresh failed, serving cached copy: %s", e)
                    return {**self.data, "stale": True}
                raise

    def _fetch(self) -> Dict[str, Any]:
        try:
            res = requests.get(URL, timeout=TIMEOUT_S, stream=True)
            res.raise_for_status()
            blob = res.raw.read(MAX_BYTES + 1, decode_content=True)
        except requests.RequestException as e:
            raise FuelPriceError(f"Couldn't download fuel prices: {type(e).__name__}") from None
        if len(blob) > MAX_BYTES:
            raise FuelPriceError("Fuel price file is unexpectedly large")
        weeks = _parse(blob)
        log.info("Fuel prices: %d weeks, latest %s", len(weeks), weeks[-1]["date"])
        return {"source": URL, "fetchedAt": int(time.time() * 1000), "weeks": weeks}
