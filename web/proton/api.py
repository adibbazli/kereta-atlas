"""Proton Link HTTP client. Python port of src/providers/proton/api.ts.

Two backends share one token:
  - "legacy" ECARX gateway: login, token refresh, data usage. Sends `AUTHORIZATION: <token>`.
  - "atlas" gateway: vehicles, status, remote control, trips, inbox. Sends `Authorization: Bearer <token>`.
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional

import requests

log = logging.getLogger("proton.http")

HOSTS = {
    "prod": {"legacy": "https://app.acotech.my:8443/", "atlas": "https://app-atlas.acotech.my:8443/"},
    "uat": {"legacy": "https://appuat.acotech.my:60033/", "atlas": "https://uatapp-atlas.acotech.my:60012/"},
    "qa": {"legacy": "https://app.acotech.my:50011/", "atlas": "https://qaapp-atlas.acotech.my:50012/"},
}

APP_VERSION = {"name": "2.1.0", "code": "210"}
# The app sends the Android API level here; the login gateway rejects requests without it.
AGENT_VERSION = "34"
# The atlas gateway expects Android-shaped device values regardless of the real client.
DEVICE = {"brand": "google", "model": "Pixel 7", "osVersion": "14"}
TOKEN_EXPIRED = 40006
TIMEOUT = 20


class ProviderError(Exception):
    def __init__(self, message: str, code: Any = None, reauth: bool = False):
        super().__init__(message)
        self.code = code
        self.reauth = reauth


def md5(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest().lower()


def new_device_id() -> str:
    """32 hex chars, the same shape as Proton's device ids."""
    return uuid.uuid4().hex


def normalize_msisdn(raw: str, country_code: str = "60") -> str:
    """Proton expects "60" + the number without its leading 0 (E.164 without the plus)."""
    n = re.sub(r"[\s()-]", "", raw)
    n = re.sub(r"^\+", "", n)
    if n.startswith(country_code):
        return n
    if n.startswith("0"):
        n = n[1:]
    return country_code + n


def legacy_headers(token: Optional[str] = None) -> Dict[str, str]:
    return {
        "X-AGENT-TYPE": "android",
        "Accept-Language": "en",
        "Connection": "close",
        "APP-NAME": "Proton Link",
        "Version-Name": APP_VERSION["name"],
        "Version-Code": APP_VERSION["code"],
        "X-APP-ID": "protonlink_01",
        "X-EQUIPMENT-TYPE": "proton link",
        "X-AGENT-VERSION": AGENT_VERSION,
        "AUTHORIZATION": token or "",
    }


def atlas_headers(token: str) -> Dict[str, str]:
    return {
        "ACCEPT-LANGUAGE": "en",
        "VERSION-NAME": APP_VERSION["name"],
        "VERSION-CODE": APP_VERSION["code"],
        "X-EQUIPMENT-TYPE": "Proton_Link",
        "X-EQUIPMENT-BRAND": DEVICE["brand"],
        "X-EQUIPMENT-MODEL": DEVICE["model"],
        "X-EQUIPMENT-OS-VERSION": DEVICE["osVersion"],
        "X-AGENT-VERSION": AGENT_VERSION,
        "CLIENT-ID": "android",
        "TENANT-ID": "acotech",
        "APP-NAME": "Proton Link",
        "REQUEST-ID": uuid.uuid4().hex,
        "Authorization": f"Bearer {token}",
    }


def _unwrap(env: Any) -> Any:
    if not isinstance(env, dict) or "code" not in env:
        raise ProviderError("Unexpected reply from Proton")
    try:
        code = int(env["code"])
    except (TypeError, ValueError):
        code = env["code"]
    if code == 200:
        return env.get("data")
    if code == TOKEN_EXPIRED:
        raise ProviderError("Session expired", TOKEN_EXPIRED, True)
    raise ProviderError(env.get("msg") or f"Proton error {env['code']}", env["code"])


def _call(base: str, path: str, method: str = "GET", headers=None, query=None, body=None) -> Any:
    url = base + path.lstrip("/")
    started = time.time()
    try:
        # TLS verification stays on; requests sends list values as repeated keys (a=1&a=2).
        res = requests.request(method, url, headers={"Accept": "application/json", **(headers or {})},
                               params=query, json=body, timeout=TIMEOUT)
    except requests.RequestException as e:
        log.warning("%s %s failed: %s", method, path, type(e).__name__)
        raise ProviderError(f"Network error: {type(e).__name__}") from None
    log.info("%s %s -> %s (%d ms)", method, path, res.status_code, (time.time() - started) * 1000)
    try:
        parsed = res.json() if res.text else None
    except ValueError:
        parsed = None
    if res.status_code == 401:
        raise ProviderError("Session expired", 401, True)
    if not res.ok:
        if isinstance(parsed, dict) and "code" in parsed:
            _unwrap(parsed)
        raise ProviderError(f"HTTP {res.status_code}", res.status_code)
    return _unwrap(parsed)


def login(env: str, mobile_phone: str, password: str, device_id: str) -> Dict[str, Any]:
    return _call(HOSTS[env]["legacy"], "app/v1/member/login", "POST", legacy_headers(), body={
        "mobilePhone": normalize_msisdn(mobile_phone),
        "password": md5(password),
        "type": "1",
        "clientType": "phone",
        "deviceId": device_id,
    })


class ProtonApi:
    """Authenticated calls with one shared, lock-guarded token refresh."""

    def __init__(self, session: Dict[str, Any], on_session: Callable[[Dict[str, Any]], None]):
        self.session = session
        self._on_session = on_session
        self._lock = threading.Lock()

    @property
    def env(self) -> str:
        return self.session["env"]

    @property
    def user_id(self) -> str:
        return self.session["userId"]

    @property
    def device_id(self) -> str:
        return self.session["deviceId"]

    def set_push_device_id(self, push_id: str) -> None:
        self.session = {**self.session, "pushDeviceId": push_id}
        self._on_session(self.session)

    def legacy(self, path: str, method: str = "GET", query=None, body=None, headers=None) -> Any:
        def go():
            h = {**legacy_headers(self.session["accessToken"]), **(headers or {})}
            return _call(HOSTS[self.env]["legacy"], path, method, h, query, body)
        return self._with_refresh(go)

    def atlas(self, path: str, method: str = "GET", query=None, body=None, headers=None, no_auth: bool = False) -> Any:
        def go():
            h = {**atlas_headers(self.session["accessToken"]), **(headers or {})}
            if no_auth:
                h.pop("Authorization", None)
            return _call(HOSTS[self.env]["atlas"], path, method, h, query, body)
        return self._with_refresh(go)

    def _with_refresh(self, fn: Callable[[], Any]) -> Any:
        token = self.session["accessToken"]
        try:
            return fn()
        except ProviderError as e:
            if not e.reauth:
                raise
        self._refresh(token)
        return fn()

    def _refresh(self, stale_token: str) -> None:
        with self._lock:
            # Another thread already refreshed while we waited.
            if self.session["accessToken"] != stale_token:
                return
            s = self.session
            try:
                res = _call(HOSTS[s["env"]]["legacy"], "app/v1/member/tokenRefresh", "POST", legacy_headers(), body={
                    "userId": s["userId"],
                    "refreshToken": s["refreshToken"],
                    "clientType": "phone",
                    "deviceId": s["deviceId"],
                })
            except ProviderError:
                raise ProviderError("Your Proton session expired. Sign in again.", "refresh", True) from None
            # Keep a rotated refresh token too, or the next refresh would use a dead one.
            self.session = {**s, "accessToken": res["accessToken"],
                            "refreshToken": res.get("refreshToken") or s["refreshToken"]}
            self._on_session(self.session)
