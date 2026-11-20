"""Mottokar web: Flask backend + static single-page frontend.

Listens on 127.0.0.1 only. The browser never sees Proton tokens: it holds an opaque session cookie,
and the server keeps the tokens (never the password) in instance/sessions.json (0600).

Public mode (MOTTOKAR_PUBLIC=1) also answers requests forwarded by a Cloudflare tunnel for
*.trycloudflare.com (or MOTTOKAR_PUBLIC_HOSTS). Those must first pass the passcode gate (gate.py);
requests to 127.0.0.1/localhost don't.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import threading
from functools import wraps
from pathlib import Path
from typing import Any, Dict, Optional

from flask import Flask, abort, g, jsonify, request, send_from_directory

import demo
from gate import Gate, RateLimiter
from live import LiveManager
from timers import Timers
from proton import client as proton
from proton.api import ProviderError

HOST = os.environ.get("MOTTOKAR_HOST", "127.0.0.1")
PORT = int(os.environ.get("MOTTOKAR_PORT", "5050"))
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}
PUBLIC = os.environ.get("MOTTOKAR_PUBLIC") == "1"
# Exact host names, or ".suffix" entries matching any subdomain.
PUBLIC_HOSTS = [h.strip().lower() for h in os.environ.get("MOTTOKAR_PUBLIC_HOSTS", ".trycloudflare.com").split(",") if h.strip()]
COOKIE = "mk_sid"
GATE_COOKIE = "mk_gate"
BASE = Path(__file__).resolve().parent
STORE = BASE / "instance" / "sessions.json"
gate = Gate(BASE / "instance") if PUBLIC else None
signin_limiter = RateLimiter(limit=5, window=900, global_limit=20)

PROVIDERS = {
    "proton": {"signIn": proton.sign_in, "client": proton.ProtonClient, "name": "Proton Link 2.0",
               "fields": [{"key": "mobilePhone", "label": "Mobile number", "type": "tel", "help": "Your Malaysian number. The +60 is added for you."},
                          {"key": "password", "label": "Password", "type": "password"}]},
    "demo": {"signIn": demo.sign_in, "client": demo.DemoClient, "name": "Demo car",
             "fields": [{"key": "name", "label": "Your name (optional)", "type": "text"}]},
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("mottokar")
app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024


# -- session store: keyed by sha256(cookie) so the file alone can't be replayed as a cookie --

_lock = threading.Lock()
_clients: Dict[str, Any] = {}
timers = Timers()
live = LiveManager(BASE / "instance" / "live.json")


def _load() -> Dict[str, Any]:
    try:
        return json.loads(STORE.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def _save(data: Dict[str, Any]) -> None:
    STORE.parent.mkdir(mode=0o700, exist_ok=True)
    tmp = STORE.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f)
    os.replace(tmp, STORE)


def _key(sid: str) -> str:
    return hashlib.sha256(sid.encode()).hexdigest()


def _record() -> Optional[Dict[str, Any]]:
    sid = request.cookies.get(COOKIE)
    if not sid:
        return None
    with _lock:
        return _load().get(_key(sid))


def _owner() -> str:
    return _key(request.cookies.get(COOKIE, ""))


def _client():
    sid = request.cookies.get(COOKIE)
    rec = _record()
    if not sid or not rec:
        abort(401)
    k = _key(sid)
    with _lock:
        c = _clients.get(k)
        if c is None:
            def save_session(session, k=k):
                with _lock:
                    data = _load()
                    if k in data:
                        data[k]["session"] = session
                        _save(data)

            c = PROVIDERS[rec["provider"]]["client"](rec["session"], save_session)
            _clients[k] = c
    return c


# -- request hardening --

def _public_host(host: str) -> bool:
    host = host.lower()
    return PUBLIC and ":" not in host and any(host == h or (h.startswith(".") and host.endswith(h)) for h in PUBLIC_HOSTS)


def is_public() -> bool:
    return request.host not in ALLOWED_HOSTS


def client_ip() -> str:
    # Behind the tunnel every request comes from 127.0.0.1; Cloudflare passes the real address.
    return (request.headers.get("Cf-Connecting-Ip") if is_public() else None) or request.remote_addr or "?"


GATE_FREE = {"/api/gate"}


@app.before_request
def guard():
    # DNS-rebinding protection: only answer to our own host names (and the tunnel's in public mode).
    public = request.host not in ALLOWED_HOSTS
    if public and not _public_host(request.host):
        abort(400)
    if request.method not in ("GET", "HEAD"):
        origin = request.headers.get("Origin")
        expected = {f"https://{request.host}"} if public else {f"http://{h}" for h in ALLOWED_HOSTS}
        if origin and origin not in expected:
            abort(403)
        # A cross-site form can't send application/json without a CORS preflight, which we never grant.
        if not request.is_json:
            abort(415)
    if public and request.path.startswith(("/api/", "/do/")) and request.path not in GATE_FREE:
        if not gate or not gate.token_ok(request.cookies.get(GATE_COOKIE)):
            return jsonify(success=False, error="Enter the access passcode", gate=True), 401


@app.after_request
def headers(resp):
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; "
        "connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Frame-Options"] = "DENY"
    if is_public():
        resp.headers["Strict-Transport-Security"] = "max-age=31536000"
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.errorhandler(ProviderError)
def provider_error(e: ProviderError):
    if e.reauth:
        return jsonify(error=str(e), reauth=True), 401
    status = e.code if isinstance(e.code, int) and 400 <= e.code < 600 else 502
    return jsonify(error=str(e), code=e.code if not isinstance(e.code, int) else None), status


@app.errorhandler(401)
def unauthorized(_):
    return jsonify(error="Not signed in", reauth=True), 401


def body() -> Dict[str, Any]:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def api(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        g.client = _client()
        return fn(*a, **kw)
    return wrapper


# -- routes --

@app.get("/")
def index():
    return send_from_directory(BASE / "static", "index.html")


@app.get("/assets/<path:name>")
def assets(name):
    resp = send_from_directory(BASE / "static" / "assets", name)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"  # hashed file names
    return resp


@app.get("/favicon.svg")
def favicon():
    return send_from_directory(BASE / "static", "favicon.svg")


@app.get("/manifest.webmanifest")
def manifest():
    resp = send_from_directory(BASE / "static", "manifest.webmanifest", mimetype="application/manifest+json")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/sw.js")
def service_worker():
    # Served from the root so it controls the whole app; always revalidated so updates land.
    resp = send_from_directory(BASE / "static", "sw.js", mimetype="text/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/icons/<name>")
def icons(name):
    return send_from_directory(BASE / "static" / "icons", name)


@app.post("/api/gate")
def pass_gate():
    if not is_public() or not gate:
        return jsonify(ok=True)
    ip = client_ip()
    if gate.limiter.blocked(ip):
        log.warning("Gate: too many attempts from %s", ip)
        return jsonify(error="Too many attempts. Try again in 15 minutes."), 429
    if not gate.check_passcode(str(body().get("passcode") or "")):
        gate.limiter.fail(ip)
        log.warning("Gate: wrong passcode from %s", ip)
        return jsonify(error="Wrong passcode"), 403
    resp = jsonify(ok=True)
    resp.set_cookie(GATE_COOKIE, gate.issue_token(), httponly=True, samesite="Strict", secure=True,
                    max_age=30 * 86400, path="/")
    return resp


@app.post("/api/gate/lock")
def lock_gate():
    if gate:
        gate.revoke(request.cookies.get(GATE_COOKIE))
    resp = jsonify(ok=True)
    resp.delete_cookie(GATE_COOKIE, path="/", secure=True, samesite="Strict")
    return resp


@app.get("/api/providers")
def providers():
    return jsonify([{"id": k, "name": v["name"], "fields": v["fields"]} for k, v in PROVIDERS.items()])


@app.get("/api/me")
def me():
    rec = _record()
    if not rec:
        return jsonify(signedIn=False)
    c = _client()
    return jsonify(signedIn=True, provider=rec["provider"], accountLabel=rec.get("accountLabel"),
                   commands=c.provider["commands"])


@app.post("/api/signin")
def signin():
    data = body()
    pid = data.get("provider")
    if pid not in PROVIDERS:
        abort(400)
    values = {k: str(v) for k, v in (data.get("values") or {}).items() if isinstance(v, (str, int))}
    ip = client_ip()
    if signin_limiter.blocked(ip):
        return jsonify(error="Too many sign-in attempts. Try again in 15 minutes."), 429
    try:
        res = PROVIDERS[pid]["signIn"](values)  # the password is used here and then dropped
    except ProviderError:
        signin_limiter.fail(ip)
        raise
    sid = secrets.token_urlsafe(32)
    with _lock:
        store = _load()
        store[_key(sid)] = {"provider": pid, "session": res["session"], "accountLabel": res.get("accountLabel")}
        _save(store)
    resp = jsonify(ok=True)
    resp.set_cookie(COOKIE, sid, httponly=True, samesite="Strict", secure=is_public(), max_age=90 * 86400, path="/")
    return resp


@app.post("/api/signout")
def signout():
    sid = request.cookies.get(COOKIE)
    if sid:
        k = _key(sid)
        with _lock:
            store = _load()
            store.pop(k, None)
            _save(store)
            _clients.pop(k, None)
        timers.forget_owner(k)
    resp = jsonify(ok=True)
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.get("/api/vehicles")
@api
def vehicles():
    return jsonify(g.client.list_vehicles())


def _own(vin: str) -> None:
    """404 unless this car belongs to the signed-in account (live feeds are shared per car)."""
    c = g.client
    try:
        c._info(vin) if hasattr(c, "_info") else c._vehicle(vin)
    except ProviderError as e:
        if e.reauth:
            raise
        abort(404)


@app.get("/api/vehicles/<vin>/status")
@api
def status(vin):
    _own(vin)
    # Manual refresh: always a fresh read, recorded for live mode's measurement.
    return jsonify({**live.read(vin, g.client, force=True), "timers": timers.list(_owner(), vin), "live": live.state(vin)})


@app.post("/api/vehicles/<vin>/live/start")
@api
def live_start(vin):
    _own(vin)
    return jsonify(live.start(vin, g.client))


@app.post("/api/vehicles/<vin>/live/stop")
@api
def live_stop(vin):
    _own(vin)
    live.stop(vin, "Turned off")
    return jsonify(live.state(vin))


@app.get("/api/vehicles/<vin>/live")
@api
def live_poll(vin):
    """Browser heartbeat (only while its tab is visible). Never calls Proton itself."""
    _own(vin)
    live.heartbeat(vin)
    out: Dict[str, Any] = {"live": live.state(vin)}
    since = request.args.get("since", type=float)
    latest = live.latest(vin)
    if latest and (since is None or (out["live"]["fetchedAt"] or 0) > since):
        out.update(latest)
        out["timers"] = timers.list(_owner(), vin)
    return jsonify(out)


MAX_AUTO_OFF_MIN = 30


@app.post("/api/vehicles/<vin>/commands")
@api
def command(vin):
    data = body()
    command_id = str(data.get("command") or "")
    pin = data.get("pin")
    pin = str(pin) if pin not in (None, "") else None
    if pin is not None and not pin.isdigit():
        abort(400)
    params = dict(data.get("params")) if isinstance(data.get("params"), dict) else {}
    auto_off = params.pop("autoOffMin", None)
    if auto_off is not None:
        try:
            auto_off = float(auto_off)
        except (TypeError, ValueError):
            abort(400)
        if not 1 <= auto_off <= MAX_AUTO_OFF_MIN or command_id != "climate_on":
            abort(400)

    client, owner = g.client, _owner()
    res = client.send_command(vin, command_id, pin, params)
    if res.get("isOk"):
        if command_id == "engine_start":
            # The car stops the engine itself after this many minutes.
            res["timer"] = timers.start(owner, vin, "engine", float(params.get("minutes", 10)))
        elif command_id == "engine_stop":
            timers.cancel(owner, vin, "engine")
        elif command_id == "climate_on":
            timers.cancel(owner, vin, "climate")
            if auto_off:
                # The PIN (if any) lives only in this closure until the timer fires or is cancelled.
                def turn_off(client=client, vin=vin, pin=pin):
                    speed = (client.get_status(vin).get("status") or {}).get("speedKmh")
                    if speed:
                        return "Skipped auto-off: the car is moving"
                    r = client.send_command(vin, "climate_off", pin, {})
                    return "Climate turned off automatically" if r.get("isOk") else f"Auto-off failed: {r.get('message')}"
                res["timer"] = timers.start(owner, vin, "climate", auto_off, turn_off)
        elif command_id == "climate_off":
            timers.cancel(owner, vin, "climate")
    return jsonify(res)


# Hands-free commands: GET /do/<command> sends it straight away and answers {"success": bool, ...}.
# Only commands that can't harm anyone are allowed (no unlock, no engine). If the car has a PIN,
# set MOTTOKAR_PIN; the request fails with success:false when it's needed and missing.
HANDS_FREE = {"horn_lights"}


@app.get("/do/<command_id>")
def do_command(command_id):
    def fail(message, status):
        return jsonify(success=False, command=command_id, message=message), status

    if command_id not in HANDS_FREE:
        return fail("Not available hands-free", 404)
    # A link on another site must not be able to trigger this (the SameSite cookie also blocks it).
    if request.headers.get("Sec-Fetch-Site", "none") not in ("none", "same-origin"):
        return fail("Cross-site request refused", 403)
    if not _record():
        return fail("Not signed in", 401)
    try:
        g.client = _client()
        cars = g.client.list_vehicles()
        car = next((v for v in cars if command_id in (v.get("commands") or [])), None)
        if not car:
            return fail("No vehicle supports this command", 400)
        pin = os.environ.get("MOTTOKAR_PIN") or None
        res = g.client.send_command(car["vin"], command_id, pin, {})
    except ProviderError as e:
        return fail(str(e), 401 if e.reauth else 502)
    log.info("hands-free %s on %s: %s", command_id, car["vin"][-4:], res.get("message"))
    return jsonify(success=bool(res.get("isOk")), command=command_id, vehicle=car.get("name"),
                   message=res.get("message"), confirmed=res.get("isConfirmed"))


@app.post("/api/vehicles/<vin>/simulate")
@api
def simulate(vin):
    # Only the simulated car has this; a real car's doors can't be opened from here.
    if not isinstance(g.client, demo.DemoClient):
        abort(404)
    g.client.simulate_part(vin, str(body().get("part") or ""))
    return jsonify(live.read(vin, g.client, force=True) | {"timers": timers.list(_owner(), vin), "live": live.state(vin)})


@app.post("/api/vehicles/<vin>/timers/<kind>/cancel")
@api
def cancel_timer(vin, kind):
    if kind not in ("engine", "climate"):
        abort(400)
    return jsonify(ok=timers.cancel(_owner(), vin, kind))


@app.post("/api/vehicles/<vin>/name")
@api
def rename(vin):
    name = str(body().get("name") or "").strip()
    if not 1 <= len(name) <= 30:
        abort(400)
    g.client.rename(vin, name)
    return jsonify(ok=True)


@app.get("/api/vehicles/<vin>/data-usage")
@api
def data_usage(vin):
    return jsonify(g.client.data_usage(vin))


@app.get("/api/vehicles/<vin>/trips")
@api
def trips(vin):
    return jsonify(g.client.trips(vin))


@app.get("/api/vehicles/<vin>/track")
@api
def track(vin):
    start = request.args.get("start", type=int)
    end = request.args.get("end", type=int)
    if not start or not end or end <= start:
        abort(400)
    return jsonify(g.client.trip_track(vin, start, end))


@app.get("/api/notices")
@api
def notices():
    return jsonify(g.client.notices())


@app.post("/api/notices/<notice_id>/read")
@api
def mark_read(notice_id):
    g.client.mark_read(notice_id)
    return jsonify(ok=True)


if __name__ == "__main__":
    if PUBLIC:
        src = "MOTTOKAR_PASSCODE" if os.environ.get("MOTTOKAR_PASSCODE") else gate.passcode_file
        log.info("Public mode: tunnel hosts %s need the access passcode (from %s)", PUBLIC_HOSTS, src)
    # threaded: a remote command holds its request open for up to ~45 s.
    app.run(host=HOST, port=PORT, threaded=True, debug=False)
