"""Minimal Firestore + FCM (HTTP v1) client over REST, using a service account.

REST instead of firebase-admin: that one pulls in grpc and google-cloud-firestore, which together
with pyarrow risks Vercel's function size limit. Only a handful of calls are needed here.

Configured by FIREBASE_SERVICE_ACCOUNT: the service account JSON, or base64 of it.
Without it, ENABLED is False and nothing here is used.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import threading
from typing import Any, Dict, List, Optional
from urllib.parse import quote

log = logging.getLogger("firebase")

TIMEOUT = 10
SCOPES = ["https://www.googleapis.com/auth/datastore", "https://www.googleapis.com/auth/firebase.messaging"]


def _service_account() -> Optional[Dict[str, Any]]:
    raw = (os.environ.get("FIREBASE_SERVICE_ACCOUNT") or "").strip()
    if not raw:
        return None
    try:
        return json.loads(raw if raw.startswith("{") else base64.b64decode(raw))
    except (ValueError, TypeError):
        log.error("FIREBASE_SERVICE_ACCOUNT is neither JSON nor base64 JSON; push notifications are off")
        return None


_INFO = _service_account()
ENABLED = bool(_INFO)
PROJECT = (_INFO or {}).get("project_id", "")
DOCS = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
FCM_SEND = f"https://fcm.googleapis.com/v1/projects/{PROJECT}/messages:send"

_session = None
_session_lock = threading.Lock()


class FirebaseError(Exception):
    pass


def _http():
    """An AuthorizedSession: a requests.Session that adds (and refreshes) the OAuth token."""
    global _session
    with _session_lock:
        if _session is None:
            from google.auth.transport.requests import AuthorizedSession
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_info(_INFO, scopes=SCOPES)
            _session = AuthorizedSession(creds)
        return _session


def _url(path: str) -> str:
    return DOCS + "/" + "/".join(quote(p, safe="") for p in path.split("/"))


def _check(res, what: str):
    if not res.ok:
        raise FirebaseError(f"{what}: HTTP {res.status_code} {res.text[:300]}")
    return res.json() if res.text else {}


# -- value encoding (Firestore's typed JSON) --

def _enc(v: Any) -> Dict[str, Any]:
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: _enc(x) for k, x in v.items()}}}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [_enc(x) for x in v]}}
    raise TypeError(f"Can't store {type(v).__name__} in Firestore")


def _dec(v: Dict[str, Any]) -> Any:
    if "integerValue" in v:
        return int(v["integerValue"])
    if "mapValue" in v:
        return {k: _dec(x) for k, x in (v["mapValue"].get("fields") or {}).items()}
    if "arrayValue" in v:
        return [_dec(x) for x in v["arrayValue"].get("values") or []]
    for key in ("stringValue", "doubleValue", "booleanValue", "timestampValue"):
        if key in v:
            return v[key]
    return None


def _fields(data: Dict[str, Any]) -> Dict[str, Any]:
    return {"fields": {k: _enc(v) for k, v in data.items()}}


def _doc(raw: Dict[str, Any]) -> Dict[str, Any]:
    out = {k: _dec(v) for k, v in (raw.get("fields") or {}).items()}
    out["_id"] = raw.get("name", "").rsplit("/", 1)[-1]
    return out


# -- documents --

def get_doc(path: str) -> Optional[Dict[str, Any]]:
    res = _http().get(_url(path), timeout=TIMEOUT)
    if res.status_code == 404:
        return None
    return _doc(_check(res, f"get {path}"))


def set_doc(path: str, data: Dict[str, Any]) -> None:
    """Replaces the whole document (creating it if needed)."""
    _check(_http().patch(_url(path), json=_fields(data), timeout=TIMEOUT), f"set {path}")


def update_doc(path: str, data: Dict[str, Any], must_exist: bool = True) -> bool:
    """Merges these fields. With must_exist, returns False instead of creating a missing document."""
    params: List[tuple] = [("updateMask.fieldPaths", k) for k in data]
    if must_exist:
        params.append(("currentDocument.exists", "true"))
    res = _http().patch(_url(path), params=params, json=_fields(data), timeout=TIMEOUT)
    if must_exist and res.status_code in (400, 404, 409, 412) and "NOT_FOUND" in res.text:
        return False
    _check(res, f"update {path}")
    return True


def create_doc(path: str, data: Dict[str, Any]) -> bool:
    """Creates the document only if it doesn't exist yet (atomic). False if it already existed."""
    parent, doc_id = path.rsplit("/", 1)
    res = _http().post(_url(parent), params={"documentId": doc_id}, json=_fields(data), timeout=TIMEOUT)
    if res.status_code == 409:
        return False
    _check(res, f"create {path}")
    return True


def delete_doc(path: str) -> None:
    res = _http().delete(_url(path), timeout=TIMEOUT)
    if res.status_code != 404:
        _check(res, f"delete {path}")


def list_docs(collection: str, page_size: int = 300) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    token = None
    while True:
        params = {"pageSize": page_size, **({"pageToken": token} if token else {})}
        data = _check(_http().get(_url(collection), params=params, timeout=TIMEOUT), f"list {collection}")
        out += [_doc(d) for d in data.get("documents") or []]
        token = data.get("nextPageToken")
        if not token:
            return out


# -- FCM --

class TokenGone(Exception):
    """FCM says this registration token is no longer valid: delete it."""


def send_fcm(token: str, data: Dict[str, str], ttl_s: int = 86400) -> None:
    """A data-only web push. The service worker (sw.js) shows it, so no Firebase code runs there."""
    message = {
        "token": token,
        "data": {k: str(v) for k, v in data.items()},
        "webpush": {"headers": {"Urgency": "high", "TTL": str(ttl_s)}},
    }
    res = _http().post(FCM_SEND, json={"message": message}, timeout=TIMEOUT)
    if res.ok:
        return
    try:
        err = res.json().get("error") or {}
    except ValueError:
        err = {}
    codes = {d.get("errorCode") for d in err.get("details") or [] if isinstance(d, dict)}
    message_text = (err.get("message") or "").lower()
    # A malformed message is also INVALID_ARGUMENT; only a bad token should cost us the token.
    if res.status_code == 404 or "UNREGISTERED" in codes or (res.status_code == 400 and "registration token" in message_text):
        raise TokenGone(err.get("message") or f"HTTP {res.status_code}")
    raise FirebaseError(f"FCM send: HTTP {res.status_code} {err.get('message') or res.text[:200]}")
