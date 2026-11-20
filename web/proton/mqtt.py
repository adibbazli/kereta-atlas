"""Minimal MQTT 3.1.1 client for Proton's command results. Port of src/providers/proton/mqtt.ts
and plugins/native/ProtonCarClient.swift.

TLS: the broker presents EMQX's default self-signed leaf (CN=Server). Its key is public, so it
can't truly authenticate the server; we pin that exact leaf anyway and check it before sending
a single byte, instead of disabling checks as the Proton app does.
"""

from __future__ import annotations

import base64
import json
import logging
import socket
import ssl
import struct
import threading
import time
from typing import Dict, Optional, Set

log = logging.getLogger("proton.mqtt")

BROKERS = {
    "prod": ("prodinfomq-atlas.acotech.my", 55883),
    "uat": ("uatinfomq-atlas.acotech.my", 61883),
    "qa": ("qainfomq-atlas.acotech.my", 45883),
}
USERNAME = "Proton Link"
PASSWORD = {
    "prod": "Y7ZlUtuG)YDiNMF_BzjpnpCb[VtH#Tf[",
    "uat": "8u8yK\"bc,].a3l'>w?e;@_A%.vKWh}?6",
    "qa": "8u8yK\"bc,].a3l'>w?e;@_A%.vKWh}?6",
}
# Same leaf as plugins/native/ProtonCarClient.swift (EMQ "Server", valid to 2030-05-06).
PINNED_CERT = base64.b64decode(
    "MIIDEzCCAfugAwIBAgIBAjANBgkqhkiG9w0BAQsFADA/MQswCQYDVQQGEwJDTjERMA8GA1UECAwIaGFuZ3pob3UxDDAKBgNVBAoMA0VNUTEPMA0GA1UEAwwGUm9vdENBMB4XDTIwMDUwODA4MDcwNVoXDTMwMDUwNjA4MDcwNVowPzELMAkGA1UEBhMCQ04xETAPBgNVBAgMCGhhbmd6aG91MQwwCgYDVQQKDANFTVExDzANBgNVBAMMBlNlcnZlcjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALNeWT3pE+QFfiRJzKmnAMUrWo3K2j/Tm3+Xnl6WLz67/0rcYrJbbKvS3uyRP/stXyXEKw9CepyQ1ViBVFkWAoy8qQEOWFDsZc/5UzhXUnb6LXr3qTkFEjNmhj+7uzv/lbBxlUG1NlYzSeOB6/RT8zH/lhOeKhLnWYPXdXKsa1FL6ij4X8DeDO1kY7fvAGmBn/THh1uTpDizM4YmeI+74dmayA5xXvARte5h4Vu5SIze7iC057N+vymToMk2Jgk+ZZFpyXrnq+yo6RaD3ANclrc4FbeUQZ5a5s5Sxgs9a0Y3WMG+7c5VnVXcbjBRz/aq2NtOnQQjikKKQA8GF080BQkCAwEAAaMaMBgwCQYDVR0TBAIwADALBgNVHQ8EBAMCBeAwDQYJKoZIhvcNAQELBQADggEBAJefnMZpaRDHQSNUIEL3iwGXE9c6PmIsQVE2ustr+CakBp3TZ4l0enLtiGMfEVFju69cO4oyokWv+hl5eCMkHBf14Kv51vj448jowYnF1zmzn7SEzm5UzlsasqjtAprnLyof69WtLU1j5rYWBuFX86yOTwRAFNjm9fvhAcrEONBsQtqipBWkMROpiUYMkRqbKcQMdwxov+lHBYKq9zbWRoqLROAn54SRqgQk6c15JdEfgOOjShbsOkIHUhqcwRkQic7n1zwHVGVDgNIZVgmJ2IdIWBlPEC7oLrRrBD/X1iEEXtKab6p5o22nKB5mN+iQaE+Oe2cpGKZJiJRdM+IqDDQ="
)


def _string(s: str) -> bytes:
    b = s.encode("utf-8")
    return struct.pack("!H", len(b)) + b


def _packet(header: int, body: bytes) -> bytes:
    n, length = len(body), bytearray()
    while True:
        byte, n = n % 128, n // 128
        length.append(byte | (0x80 if n else 0))
        if not n:
            break
    return bytes([header]) + bytes(length) + body


def open_pinned_tls(host: str, port: int, timeout: float = 8.0) -> ssl.SSLSocket:
    """TLS socket whose leaf certificate is byte-for-byte the pinned one, or an exception."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # Replaced by the exact-leaf comparison below.
    raw = socket.create_connection((host, port), timeout=timeout)
    tls = ctx.wrap_socket(raw, server_hostname=host)
    if tls.getpeercert(binary_form=True) != PINNED_CERT:
        tls.close()
        raise ssl.SSLError("MQTT broker certificate does not match the pinned certificate")
    return tls


def parse_control_result(payload: bytes) -> Optional[dict]:
    """`{messageCategory, content}`; content (object or JSON string) is `{taskId, serviceResult, ...}`."""
    try:
        msg = json.loads(payload.decode("utf-8"))
        raw = json.loads(msg["content"]) if isinstance(msg.get("content"), str) else msg.get("content")
        if not isinstance(raw, dict) or not raw.get("taskId"):
            return None
        if msg.get("messageCategory") and msg["messageCategory"] != "VEHICLE_CONTROL":
            return None
        outcome = str(raw.get("serviceResult") or "")
        task = str(raw["taskId"])
        if outcome == "ISSUED_SUCCESS":
            return {"taskId": task, "delivered": True}
        if outcome == "EXECUTION_SUCCESS":
            return {"taskId": task, "isOk": True, "code": raw.get("code")}
        if outcome == "EXECUTION_FAIL":
            return {"taskId": task, "isOk": False, "code": raw.get("code"),
                    "message": raw.get("body") or raw.get("message") or None}
    except (ValueError, KeyError, AttributeError, UnicodeDecodeError):
        pass
    return None


class ResultWatch:
    """Subscribes to mobile/<deviceId>/{message,notify} and collects command results by taskId.

    `start()` returns only once SUBACK arrived, so a fast car's reply isn't missed.
    """

    def __init__(self, env: str, device_id: str):
        self.env = env
        self.device_id = device_id
        self._sock: Optional[ssl.SSLSocket] = None
        self._results: Dict[str, dict] = {}
        self._delivered: Set[str] = set()
        self._cond = threading.Condition()
        self._closed = False
        self._write_lock = threading.Lock()

    def start(self) -> bool:
        host, port = BROKERS[self.env]
        try:
            self._sock = open_pinned_tls(host, port)
            log.info("TLS connected to %s:%s (pinned certificate matched)", host, port)
            self._send(_packet(0x10, _string("MQTT") + bytes([4, 0xC2, 0, 60]) + _string(self.device_id)
                               + _string(USERNAME) + _string(PASSWORD[self.env])))
            self._sock.settimeout(8)
            header, body = self._read_packet()
            if header >> 4 != 2 or len(body) < 2 or body[1] != 0:
                raise ConnectionError(f"broker refused (CONNACK {body.hex()})")
            topics = [f"mobile/{self.device_id}/message", f"mobile/{self.device_id}/notify"]
            self._send(_packet(0x82, b"\x00\x01" + b"".join(_string(t) + b"\x01" for t in topics)))
            while True:
                header, body = self._read_packet()
                if header >> 4 == 9:
                    break
                self._handle(header, body)
        except (OSError, ConnectionError, ssl.SSLError) as e:
            log.warning("MQTT setup failed: %s", e)
            self.close()
            return False
        self._sock.settimeout(None)
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._pinger, daemon=True).start()
        return True

    def wait_for(self, task_id: str, timeout: float) -> Optional[dict]:
        deadline = time.time() + timeout
        with self._cond:
            while task_id not in self._results and not self._closed:
                left = deadline - time.time()
                if left <= 0:
                    return None
                self._cond.wait(left)
            return self._results.get(task_id)

    def delivered(self, task_id: str) -> bool:
        return task_id in self._delivered

    def close(self) -> None:
        with self._cond:
            if self._closed:
                return
            self._closed = True
            self._cond.notify_all()
        if self._sock:
            try:
                self._send(b"\xe0\x00")  # DISCONNECT
            except OSError:
                pass
            try:
                self._sock.close()
            except OSError:
                pass

    # -- internals --

    def _send(self, data: bytes) -> None:
        with self._write_lock:
            assert self._sock is not None
            self._sock.sendall(data)

    def _read_exact(self, n: int) -> bytes:
        assert self._sock is not None
        buf = b""
        while len(buf) < n:
            chunk = self._sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("socket closed")
            buf += chunk
        return buf

    def _read_packet(self):
        header = self._read_exact(1)[0]
        mult, length = 1, 0
        for _ in range(4):
            b = self._read_exact(1)[0]
            length += (b & 0x7F) * mult
            mult *= 128
            if not b & 0x80:
                break
        return header, self._read_exact(length) if length else b""

    def _handle(self, header: int, body: bytes) -> None:
        if header >> 4 != 3:  # only PUBLISH matters
            return
        qos = (header >> 1) & 3
        tlen = struct.unpack("!H", body[:2])[0]
        at = 2 + tlen
        if qos:
            self._send(bytes([0x40, 0x02]) + body[at:at + 2])  # PUBACK
            at += 2
        parsed = parse_control_result(body[at:])
        if not parsed:
            return
        with self._cond:
            if parsed.get("delivered"):
                self._delivered.add(parsed["taskId"])
            else:
                self._results[parsed["taskId"]] = parsed
            self._cond.notify_all()

    def _reader(self) -> None:
        try:
            while not self._closed:
                self._handle(*self._read_packet())
        except (OSError, ConnectionError, struct.error):
            pass
        finally:
            self.close()

    def _pinger(self) -> None:
        while not self._closed:
            time.sleep(45)
            try:
                if not self._closed:
                    self._send(b"\xc0\x00")  # PINGREQ
            except OSError:
                return


# The broker allows a client id only once, so one command per device id at a time.
_device_locks: Dict[str, threading.Lock] = {}
_device_locks_guard = threading.Lock()


def device_lock(device_id: str) -> threading.Lock:
    with _device_locks_guard:
        return _device_locks.setdefault(device_id, threading.Lock())

