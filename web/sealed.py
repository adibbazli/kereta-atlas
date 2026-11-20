"""Stateless cookies for hosts without durable disk (Vercel, other serverless platforms).

With MOTTOKAR_SECRET_KEY set, the server keeps no session or gate state on disk:
- the session record (Proton tokens included) travels in the cookie, encrypted and authenticated
  with AES-256-GCM, so the browser can neither read nor alter it;
- gate tokens are an expiry plus an HMAC, checked without any lookup.

Every key is derived from the one secret with a distinct label, so a value made for one purpose
can't be accepted for another. Changing the secret signs out every browser.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
from typing import Any, Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SECRET = os.environ.get("MOTTOKAR_SECRET_KEY") or ""
ENABLED = bool(SECRET)


def derive(label: str) -> bytes:
    return hmac.new(SECRET.encode(), label.encode(), hashlib.sha256).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def seal(obj: Any, label: str) -> str:
    nonce = secrets.token_bytes(12)
    ct = AESGCM(derive(label)).encrypt(nonce, json.dumps(obj, separators=(",", ":")).encode(), label.encode())
    return _b64(nonce + ct)


def unseal(token: Optional[str], label: str) -> Optional[Any]:
    """The sealed value, or None if the token is missing, malformed, or wasn't made with this key."""
    if not token:
        return None
    try:
        raw = _unb64(token)
        return json.loads(AESGCM(derive(label)).decrypt(raw[:12], raw[12:], label.encode()))
    except (ValueError, InvalidTag):
        return None


def sign(message: str, label: str) -> str:
    return _b64(hmac.new(derive(label), message.encode(), hashlib.sha256).digest())
