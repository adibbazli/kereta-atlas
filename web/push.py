"""Push notifications for new inbox messages, through Firebase Cloud Messaging.

A browser subscribes with its FCM token. An external scheduler then calls /cron/notify every few
minutes (Vercel's own cron can't run that often), which reads each subscribed account's inbox and
pushes the messages it hasn't pushed before.

Firestore layout (only the server touches it; client access is denied by the security rules):
  subscribers/{account}              sealedSession, provider, accountLabel, status (active|expired),
                                     subscribedAt, lastCheckedAt, baselineDone, recentIds
  subscribers/{account}/tokens/{h}   token, sid (the sign-in that added it), createdAt, userAgent
  subscribers/{account}/sent/{id}    sentAt, title: one per pushed message; never pushed twice

`account` is a hash of provider + Proton user id, so a new sign-in for the same account picks up
the same subscriber and its sent history.

The cron has no browser cookie, so the subscriber keeps a copy of the provider session (tokens),
sealed with MOTTOKAR_SECRET_KEY like the cookie is. Whoever refreshes the tokens (cron or browser)
writes the result here, and the other side adopts it when its own token stops working (see
ProtonApi._adopt_stored), so a rotated refresh token never strands either one.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from typing import Any, Callable, Dict, List, Optional

import firebase
import sealed
from proton.api import ProviderError

log = logging.getLogger("push")

SEAL = "push"
ENABLED = firebase.ENABLED and sealed.ENABLED
CRON_SECRET = os.environ.get("MOTTOKAR_CRON_SECRET") or ""
VAPID_KEY = os.environ.get("FIREBASE_VAPID_KEY") or ""
RECENT_MAX = 200
# Messages older than the subscription (minus clock slack) are never news.
SLACK_MS = 10 * 60_000
MAX_TOKENS = 20

if firebase.ENABLED and not sealed.ENABLED:
    log.warning("Push notifications need MOTTOKAR_SECRET_KEY (stored sessions are sealed with it); they are off")


def web_config() -> Optional[Dict[str, Any]]:
    try:
        cfg = json.loads(os.environ.get("FIREBASE_WEB_CONFIG") or "null")
    except ValueError:
        log.error("FIREBASE_WEB_CONFIG is not valid JSON")
        return None
    return cfg if isinstance(cfg, dict) else None


def client_config() -> Dict[str, Any]:
    cfg = web_config()
    if not (ENABLED and cfg and VAPID_KEY):
        return {"enabled": False}
    return {"enabled": True, "config": cfg, "vapidKey": VAPID_KEY}


def _h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def account_key(rec: Dict[str, Any]) -> str:
    session = rec.get("session") or {}
    return _h(f"{rec.get('provider')}:{session.get('userId') or rec.get('id') or ''}")


def _sub_path(account: str) -> str:
    return f"subscribers/{account}"


def _doc_id(notice_id: str) -> str:
    return notice_id if re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", notice_id) and notice_id not in (".", "..") else _h(notice_id)


def _now_ms() -> int:
    return int(time.time() * 1000)


# -- called from the web app --

def subscribe(rec: Dict[str, Any], token: str, user_agent: str = "") -> None:
    account = account_key(rec)
    path = _sub_path(account)
    sealed_session = sealed.seal(rec["session"], SEAL)
    common = {"sealedSession": sealed_session, "provider": rec["provider"], "accountLabel": rec.get("accountLabel") or ""}
    existing = firebase.get_doc(path)
    if existing and existing.get("status") == "active":
        firebase.update_doc(path, common)
    else:
        # New, or back after an expired session: start over from what's in the inbox now.
        firebase.set_doc(path, {**common, "status": "active", "subscribedAt": _now_ms(), "lastCheckedAt": 0,
                                "baselineDone": False, "recentIds": (existing or {}).get("recentIds") or []})
    tokens = firebase.list_docs(f"{path}/tokens")
    if len(tokens) >= MAX_TOKENS and not any(t.get("token") == token for t in tokens):
        oldest = min(tokens, key=lambda t: t.get("createdAt") or 0)
        firebase.delete_doc(f"{path}/tokens/{oldest['_id']}")
    firebase.set_doc(f"{path}/tokens/{_h(token)}", {"token": token, "sid": rec.get("id") or "",
                                                    "createdAt": _now_ms(), "userAgent": user_agent[:200]})
    log.info("Push: subscribed a device for %s…", account[:8])


def unsubscribe(rec: Dict[str, Any], token: Optional[str] = None) -> None:
    """Removes this token, or (without one) every token this sign-in added. The subscriber, and its
    stored session, goes when no device is left."""
    path = _sub_path(account_key(rec))
    if token:
        firebase.delete_doc(f"{path}/tokens/{_h(token)}")
    tokens = firebase.list_docs(f"{path}/tokens")
    sid = rec.get("id")
    left = []
    for t in tokens:
        if t["_id"] == (_h(token) if token else None):
            continue
        if not token and sid and t.get("sid") == sid:
            firebase.delete_doc(f"{path}/tokens/{t['_id']}")
        else:
            left.append(t)
    if not left:
        # Keeps sent/ (the history that prevents repeats); only the stored session goes.
        firebase.delete_doc(path)


def sync_session(rec: Dict[str, Any]) -> None:
    """The web app refreshed this account's tokens: store them for the cron."""
    firebase.update_doc(_sub_path(account_key(rec)), {"sealedSession": sealed.seal(rec["session"], SEAL)})


def load_session(rec: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    doc = firebase.get_doc(_sub_path(account_key(rec)))
    return sealed.unseal(doc.get("sealedSession"), SEAL) if doc else None


# -- the cron --

def run_cron(providers: Dict[str, Any], budget_s: float = 8.0) -> Dict[str, int]:
    started = time.time()
    stats = {"subscribers": 0, "checked": 0, "sent": 0, "baseline": 0, "expired": 0, "deferred": 0, "errors": 0,
             "tokensRemoved": 0}
    subs = [d for d in firebase.list_docs("subscribers") if d.get("status") == "active"]
    stats["subscribers"] = len(subs)
    # Least recently checked first, so a run cut short by the budget doesn't starve anyone.
    for sub in sorted(subs, key=lambda d: d.get("lastCheckedAt") or 0):
        if time.time() - started > budget_s:
            stats["deferred"] += 1
            continue
        try:
            _check(sub, providers, stats)
        except Exception as e:  # one account's failure mustn't stop the others
            stats["errors"] += 1
            log.warning("Push: checking %s… failed: %s", sub["_id"][:8], e)
    log.info("Push cron: %s", stats)
    return stats


def _check(sub: Dict[str, Any], providers: Dict[str, Any], stats: Dict[str, int]) -> None:
    account = sub["_id"]
    path = _sub_path(account)
    provider = providers.get(sub.get("provider"))
    session = sealed.unseal(sub.get("sealedSession"), SEAL)
    if not provider or not session:
        _expire(path, stats)
        return

    def save(new_session: Dict[str, Any]) -> None:
        firebase.update_doc(path, {"sealedSession": sealed.seal(new_session, SEAL)})

    def reload() -> Optional[Dict[str, Any]]:
        doc = firebase.get_doc(path)
        return sealed.unseal(doc.get("sealedSession"), SEAL) if doc else None

    client = provider["client"](session, save, reload)
    try:
        notices = client.notices()
    except ProviderError as e:
        if e.reauth:
            _expire(path, stats)
            return
        raise
    stats["checked"] += 1
    recent: List[str] = list(sub.get("recentIds") or [])

    if not sub.get("baselineDone"):
        # The first look only records what's already there: old messages aren't news.
        recent = [n["id"] for n in notices] + [i for i in recent if i not in {n["id"] for n in notices}]
        firebase.update_doc(path, {"baselineDone": True, "lastCheckedAt": _now_ms(), "recentIds": recent[:RECENT_MAX]})
        stats["baseline"] += 1
        return

    since = (sub.get("subscribedAt") or 0) - SLACK_MS
    new = [n for n in notices
           if n["id"] not in recent and not n.get("isRead") and (n.get("createdAt") or 0) >= since]
    tokens = firebase.list_docs(f"{path}/tokens") if new else []
    for n in sorted(new, key=lambda n: n.get("createdAt") or 0):  # oldest first
        recent.insert(0, n["id"])
        # The atomic claim: whichever run creates this record pushes the message; the others skip it.
        if not firebase.create_doc(f"{path}/sent/{_doc_id(n['id'])}", {"sentAt": _now_ms(), "title": n.get("title") or ""}):
            continue
        payload = {"title": n.get("title") or "Mottokar", "body": n.get("body") or "", "noticeId": n["id"],
                   "url": "/#/inbox", "tag": f"notice-{n['id']}"}
        tokens = _send_all(path, tokens, payload, stats)
        stats["sent"] += 1
    firebase.update_doc(path, {"lastCheckedAt": _now_ms(), "recentIds": recent[:RECENT_MAX]})


def broadcast(title: str, body: str, url: str = "/#/inbox") -> Dict[str, int]:
    """Sends one message to every device of every subscriber, active or not. Not recorded in sent/."""
    stats = {"subscribers": 0, "devices": 0, "sent": 0, "errors": 0, "tokensRemoved": 0}
    payload = {"title": title, "body": body, "url": url, "tag": f"test-{_now_ms()}"}
    for sub in firebase.list_docs("subscribers"):
        path = _sub_path(sub["_id"])
        tokens = firebase.list_docs(f"{path}/tokens")
        stats["subscribers"] += 1
        stats["devices"] += len(tokens)
        before = stats["errors"] + stats["tokensRemoved"]
        _send_all(path, tokens, payload, stats)
        stats["sent"] += len(tokens) - (stats["errors"] + stats["tokensRemoved"] - before)
    log.info("Push broadcast: %s", stats)
    return stats


def _send_all(path: str, tokens: List[Dict[str, Any]], payload: Dict[str, str], stats: Dict[str, int]) -> List[Dict[str, Any]]:
    """Sends to every device; drops tokens FCM says are gone. Returns the tokens still valid."""
    alive = []
    for t in tokens:
        try:
            firebase.send_fcm(t["token"], payload)
            alive.append(t)
        except firebase.TokenGone:
            firebase.delete_doc(f"{path}/tokens/{t['_id']}")
            stats["tokensRemoved"] += 1
        except firebase.FirebaseError as e:
            alive.append(t)
            stats["errors"] += 1
            log.warning("Push: sending failed: %s", e)
    return alive


def _expire(path: str, stats: Dict[str, int]) -> None:
    """The stored session no longer works (expired, or replaced by a sign-in elsewhere). Stop
    polling and tell the devices once; subscribing again after the next sign-in resumes it."""
    firebase.update_doc(path, {"status": "expired", "sealedSession": ""})
    stats["expired"] += 1
    _send_all(path, firebase.list_docs(f"{path}/tokens"), {
        "title": "Mottokar notifications paused",
        "body": "Your Proton session ended. Open Mottokar and sign in again to keep getting alerts.",
        "url": "/", "tag": "session-expired"}, stats)
