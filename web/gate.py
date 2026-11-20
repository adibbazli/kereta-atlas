"""Passcode gate for public access (e.g. through a Cloudflare quick tunnel).

- The passcode comes from MOTTOKAR_PASSCODE, or is generated once and written to
  instance/passcode.txt (0600). Only a PBKDF2 hash is kept in instance/access.json.
- Passing the gate gives the browser a random token (HttpOnly cookie); the server stores only
  its SHA-256, with an expiry, so a copied access.json can't be replayed as a cookie.
- Failed attempts are rate-limited per client IP and globally.
- Stateless mode (MOTTOKAR_SECRET_KEY set, see sealed.py): the token is its expiry plus an HMAC
  bound to the passcode, so it survives a wiped disk. Nothing is kept server-side, so "Lock this
  browser" only deletes the cookie; changing the passcode or the secret still revokes every token.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Deque, Dict

import sealed

TOKEN_DAYS = 30
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
_ITER = 300_000


class RateLimiter:
    """At most `limit` failures per `window` seconds per key, plus a global cap."""

    def __init__(self, limit: int = 5, window: float = 900, global_limit: int = 30):
        self.limit, self.window, self.global_limit = limit, window, global_limit
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)
        self._all: Deque[float] = deque()
        self._lock = threading.Lock()

    def _trim(self, q: Deque[float], now: float) -> None:
        while q and now - q[0] > self.window:
            q.popleft()

    def blocked(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            q = self._hits[key]
            self._trim(q, now)
            self._trim(self._all, now)
            return len(q) >= self.limit or len(self._all) >= self.global_limit

    def fail(self, key: str) -> None:
        now = time.time()
        with self._lock:
            self._hits[key].append(now)
            self._all.append(now)


class Gate:
    def __init__(self, instance_dir: Path, stateless: bool = False):
        self.stateless = stateless
        self.dir = instance_dir
        self.file = instance_dir / "access.json"
        self._lock = threading.Lock()
        self.limiter = RateLimiter()
        self.passcode_file = instance_dir / "passcode.txt"
        self._ensure_passcode()

    # -- storage --

    def _read(self) -> dict:
        try:
            return json.loads(self.file.read_text())
        except (FileNotFoundError, ValueError):
            return {}

    def _write(self, data: dict) -> None:
        self.dir.mkdir(mode=0o700, exist_ok=True)
        tmp = self.file.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f)
        os.replace(tmp, self.file)

    @staticmethod
    def _hash(passcode: str, salt: bytes) -> str:
        return hashlib.pbkdf2_hmac("sha256", passcode.encode(), salt, _ITER).hex()

    @staticmethod
    def _normalize(passcode: str) -> str:
        return "".join(passcode.split()).replace("-", "").upper()

    def _ensure_passcode(self) -> None:
        env = os.environ.get("MOTTOKAR_PASSCODE")
        with self._lock:
            data = self._read()
            if env:
                code = self._normalize(env)
                # Same passcode as before: keep the hash, or every restart would sign browsers out.
                if data.get("hash") and hmac.compare_digest(self._hash(code, bytes.fromhex(data["salt"])), data["hash"]):
                    self._fingerprint = self._fingerprint_for(code, data)
                    return
            elif data.get("hash"):
                self._fingerprint = data["hash"]
                return
            else:
                code = "".join(secrets.choice(_ALPHABET) for _ in range(16))  # 80 bits
                self.dir.mkdir(mode=0o700, exist_ok=True)
                fd = os.open(self.passcode_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write("-".join(code[i:i + 4] for i in range(0, 16, 4)) + "\n")
            salt = secrets.token_bytes(16)
            new_hash = self._hash(code, salt)
            # A new passcode signs out every browser that used the old one.
            data = {"salt": salt.hex(), "hash": new_hash, "tokens": {}}
            self._write(data)
            self._fingerprint = self._fingerprint_for(code if env else None, data)

    def _fingerprint_for(self, env_code: str | None, data: dict) -> str:
        """What stateless tokens are bound to. For MOTTOKAR_PASSCODE it must not depend on the
        random salt, since a serverless disk (and so the salt) is new after every cold start."""
        if env_code is not None and self.stateless:
            return sealed.sign(env_code, "gate-passcode")
        return data["hash"]

    # -- gate --

    def check_passcode(self, passcode: str) -> bool:
        data = self._read()
        if not data.get("hash"):
            return False
        candidate = self._hash(self._normalize(passcode), bytes.fromhex(data["salt"]))
        return hmac.compare_digest(candidate, data["hash"])

    def issue_token(self) -> str:
        if self.stateless:
            exp = str(int(time.time()) + TOKEN_DAYS * 86400)
            return f"{exp}.{sealed.sign(f'{exp}.{self._fingerprint}', 'gate-token')}"
        token = secrets.token_urlsafe(32)
        with self._lock:
            data = self._read()
            now = time.time()
            tokens = {k: v for k, v in data.get("tokens", {}).items() if v > now}
            tokens[hashlib.sha256(token.encode()).hexdigest()] = now + TOKEN_DAYS * 86400
            data["tokens"] = tokens
            self._write(data)
        return token

    def token_ok(self, token: str | None) -> bool:
        if not token:
            return False
        if self.stateless:
            exp, _, mac = token.partition(".")
            if not exp.isdigit() or int(exp) < time.time():
                return False
            return hmac.compare_digest(mac, sealed.sign(f"{exp}.{self._fingerprint}", "gate-token"))
        exp = self._read().get("tokens", {}).get(hashlib.sha256(token.encode()).hexdigest())
        return bool(exp and exp > time.time())

    def revoke(self, token: str | None) -> None:
        if not token or self.stateless:
            return
        with self._lock:
            data = self._read()
            data.get("tokens", {}).pop(hashlib.sha256(token.encode()).hexdigest(), None)
            self._write(data)
