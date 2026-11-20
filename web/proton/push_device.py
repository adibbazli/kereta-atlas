"""Server-issued push device ids. Python port of src/providers/proton/push-device.ts.

Proton only delivers MQTT messages to device ids it issued itself:
  1. GET  information/mobileSync/generateDeviceId with X-UPLOAD-ID = encrypted device info.
  2. POST information/mobileSync/integrated/replenish binds that id to the signed-in user.
Encryption: AES/ECB/PKCS5, key = UTF-8(appSecret + 10-digit timestamp),
output "timestamp=<t>;value=<url-safe base64, no padding>".
"""

from __future__ import annotations

import base64
import json
import logging
import time
import uuid
from typing import Optional

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from .api import APP_VERSION, DEVICE, ProtonApi, ProviderError

log = logging.getLogger("proton.push")

APP_SECRET = {
    "prod": "eG[llZO)N0vw2+,%A&6KHX",
    "uat": "KrRn@{dn#%&BdOvi@!=9$@",
    "qa": "KrRn@{dn#%&BdOvi@!=9$@",
}

# Proton answers rapid repeats with "trigger frequency control".
RETRY_AFTER_S = 600
_last_failure = 0.0


def encrypt_upload(env: str, content: str, timestamp: Optional[int] = None) -> str:
    ts = int(time.time()) if timestamp is None else timestamp
    key = (APP_SECRET[env] + str(ts)).encode("utf-8")
    if len(key) not in (16, 24, 32):
        raise ValueError(f"AES key is {len(key)} bytes")
    padder = padding.PKCS7(128).padder()
    padded = padder.update(content.encode("utf-8")) + padder.finalize()
    enc = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    data = enc.update(padded) + enc.finalize()
    value = base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")
    return f"timestamp={ts};value={value}"


def device_info(install_id: str) -> dict:
    return {
        "appVersion": APP_VERSION["name"],
        "appVersionCode": int(APP_VERSION["code"]),
        "deviceSystem": "Android",
        "deviceBrand": DEVICE["brand"],
        "deviceModel": DEVICE["model"],
        "deviceSystemVersion": DEVICE["osVersion"],
        "uniquelyId": install_id[:16],
        "installId": install_id,
        "channel": "FCM",
    }


def register_push_device(api: ProtonApi) -> Optional[str]:
    global _last_failure
    if time.time() - _last_failure < RETRY_AFTER_S:
        log.info("Skipping push device registration (last attempt failed recently)")
        return None
    install_id = api.device_id or uuid.uuid4().hex
    try:
        info = json.dumps(device_info(install_id), separators=(",", ":"))
        res = api.atlas("information/mobileSync/generateDeviceId",
                        headers={"X-UPLOAD-ID": encrypt_upload(api.env, info), "X-AGENT-TYPE": "Android"},
                        no_auth=True)
    except ProviderError as e:
        _last_failure = time.time()
        log.warning("generateDeviceId rejected: %s", e)
        return None
    res = res if isinstance(res, dict) else {}
    device_id = res.get("deviceId") or next((v for v in res.values() if isinstance(v, str) and len(v) >= 16), None)
    if not device_id:
        _last_failure = time.time()
        log.warning("No device id in the reply")
        return None
    bind_push_device(api, device_id)
    return device_id


def bind_push_device(api: ProtonApi, device_id: str) -> None:
    """A binding can lapse, leaving MQTT connected but silent, so this runs before each command."""
    try:
        api.atlas("information/mobileSync/integrated/replenish", "POST",
                  body={"deviceId": device_id, "uniquelyId": (api.device_id or "")[:16]})
    except ProviderError as e:
        log.warning("Binding the push device failed: %s", e)
