"""High-level Proton client used by the Flask routes. Port of src/providers/proton/index.ts."""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote

from .api import ProtonApi, ProviderError, login, md5, new_device_id, normalize_msisdn
from .mappers import coord, format_notice, format_phone, map_status, map_trip, map_vehicle, num, raw_fields
from .mqtt import ResultWatch, device_lock
from .push_device import bind_push_device, register_push_device

log = logging.getLogger("proton")

# Our command ids -> Atlas serviceKey + capability family.
CONTROLS: Dict[str, Dict[str, Any]] = {
    "lock": {"family": "RDU", "build": lambda p: {"serviceKey": "RDL-OFF"}},
    "unlock": {"family": "RDU", "build": lambda p: {"serviceKey": "RDU-ON"}},
    "climate_on": {"family": "RCE", "build": lambda p: {
        "serviceKey": "RCE-ON", "parameters": [{"key": "rce.temp", "stringVal": _temp(p.get("temp", 22))}]}},
    "climate_off": {"family": "RCE", "build": lambda p: {"serviceKey": "RCE-OFF"}},
    "horn_lights": {"family": "RHL", "build": lambda p: {"serviceKey": "RHL-HornAndLight"}},
    "lights": {"family": "RHL", "build": lambda p: {"serviceKey": "RHL-LIGHT"}},
    "windows_close": {"family": "RWS", "build": lambda p: {"serviceKey": "RWS-OFF"}},
    "windows_open": {"family": "RWS", "build": lambda p: {"serviceKey": "RWS-ON"}},
    "sunroof_close": {"family": "RWS", "build": lambda p: {"serviceKey": "RWS-SunroofOFF"}},
    # Opens every window a crack (docs/proton-integration.md); stopping it is the plain close-windows key.
    "ventilate_on": {"family": "RWS", "build": lambda p: {"serviceKey": "RWS-BreathableON"}},
    "ventilate_off": {"family": "RWS", "build": lambda p: {"serviceKey": "RWS-OFF"}},
    "trunk_open": {"family": "RDU", "build": lambda p: {"serviceKey": "RDU-TargetON"}},
    "trunk_lock": {"family": "RDU", "build": lambda p: {"serviceKey": "RDU-TargetOFF"}},
    "engine_start": {"family": "RES", "build": lambda p: {"serviceKey": "RES-Engine-ON", "duration": _engine_minutes(p.get("minutes", 10))}},
    "engine_stop": {"family": "RES", "build": lambda p: {"serviceKey": "RES-Engine-OFF"}},
    "defrost_on": {"family": "RCE", "build": lambda p: {"serviceKey": "RCE-DefrostON"}},
    "charge_start": {"family": "RCS", "build": lambda p: {"serviceKey": "RCS-ChargingStart"}},
    "charge_stop": {"family": "RCS", "build": lambda p: {"serviceKey": "RCS-ChargingStop"}},
}


def _engine_minutes(v: Any) -> int:
    """Proton Link only offers these run times; the car may refuse (or misuse) others."""
    try:
        m = int(float(v))
    except (TypeError, ValueError):
        m = -1
    if m not in (3, 5, 8, 10):
        raise ProviderError("Run time must be 3, 5, 8 or 10 minutes", 400)
    return m


def _temp(v: Any) -> str:
    t = float(v)
    if not 16 <= t <= 32:
        raise ProviderError("Temperature must be between 16 and 32 °C")
    return str(int(t)) if t.is_integer() else str(t)


COMMANDS: List[Dict[str, Any]] = [
    {"id": "lock", "label": "Lock"},
    {"id": "unlock", "label": "Unlock"},
    {"id": "climate_on", "label": "Climate", "params": [
        {"key": "temp", "label": "Temperature", "type": "number", "min": 16, "max": 32, "step": 0.5, "default": 22, "unit": "°C"}]},
    {"id": "climate_off", "label": "Climate Off"},
    {"id": "horn_lights", "label": "Honk and Flash"},
    {"id": "lights", "label": "Flash Lights"},
    {"id": "windows_close", "label": "Close Windows"},
    {"id": "windows_open", "label": "Open Windows"},
    {"id": "sunroof_close", "label": "Close Sunroof"},
    {"id": "ventilate_on", "label": "Ventilate"},
    {"id": "ventilate_off", "label": "Stop Ventilating"},
    {"id": "trunk_open", "label": "Unlock Trunk"},
    {"id": "trunk_lock", "label": "Lock Trunk"},
    {"id": "engine_start", "label": "Start Engine", "params": [
        {"key": "minutes", "label": "Run for", "type": "choice", "default": 10,
         "options": [{"label": f"{m} min", "value": m} for m in (3, 5, 8, 10)]}]},
    {"id": "engine_stop", "label": "Stop Engine", "isDestructive": True},
    {"id": "defrost_on", "label": "Defrost"},
    {"id": "charge_start", "label": "Start Charging"},
    {"id": "charge_stop", "label": "Stop Charging"},
]

CAR_REFUSALS = {"2048": "Remote start limit reached. Drive the car once, then try again."}
COMMAND_TIMEOUT = 40


def _families(tree: Any) -> set:
    out: set = set()

    def walk(nodes):
        for n in nodes or []:
            if not isinstance(n, dict):
                continue
            code = n.get("itemCode") or ""
            if "-" in code:
                out.add(code.split("-")[1])
            walk(n.get("child"))

    walk(tree)
    return out


# Command id -> (service families, name pattern) a capability item must match. Items look like
# {"itemCode": "A001X001Y003-RWS", "itemName": "Remote window open1.0/2.0/3.0 远程车窗打开1.0/2.0/3.0"};
# one family covers several commands, so the name tells e.g. window open from sunroof apart.
_WINDOW = r"window|车窗"
CAPABILITY_RULES: Dict[str, Any] = {
    "lock": ({"RDL"}, r"lock|锁"),
    "unlock": ({"RDU"}, r"unlock|解锁"),
    "horn_lights": ({"RHL"}, r"honk|horn|鸣笛"),
    "lights": ({"RHL"}, r"^(?!.*(honk|horn|鸣笛)).*(light|flash|闪)"),
    "windows_open": ({"RWS"}, rf"^(?!.*(sunroof|天窗|ventilat|透气)).*({_WINDOW}).*(open|打开)"),
    "windows_close": ({"RWS"}, rf"^(?!.*(sunroof|天窗)).*({_WINDOW}).*(close|关闭)"),
    "sunroof_close": ({"RWS"}, r"sunroof|天窗"),
    "ventilate_on": ({"RWS"}, r"ventilat|breath|透气"),
    "ventilate_off": ({"RWS"}, r"ventilat|breath|透气"),
    # The trunk latch: RDU-TargetON/OFF in the control body, RTU in the capability list.
    "trunk_open": ({"RTU", "RDU"}, r"^(?=.*(trunk|tailgate|后备箱)).*(unlock|open|解锁|开)"),
    # Only an explicit trunk lock/close entry counts; "trunk unlock" doesn't imply it (the S70 has none).
    "trunk_lock": ({"RTU", "RDU"}, r"^(?=.*(trunk|tailgate|后备箱)).*((?<!un)lock|close|锁上|关闭)"),
    "climate_on": ({"RCE"}, r"^(?!.*(defrost|除霜)).*(open|start|\bon\b|开启)"),
    "climate_off": ({"RCE"}, r"close|stop|\boff\b|关闭"),
    "defrost_on": ({"RCE"}, r"defrost|除霜"),
    "engine_start": ({"RES"}, r"engine|引擎"),
    "engine_stop": ({"RES"}, r"engine|引擎"),
    "charge_start": ({"RCS"}, r"charg|充电"),
    "charge_stop": ({"RCS"}, r"charg|充电"),
}


def supported_commands(items: List[Dict[str, Any]]) -> List[str]:
    """Command ids backed by at least one capability item (family suffix + matching name)."""
    out = []
    for cid, (fams, pattern) in CAPABILITY_RULES.items():
        regex = re.compile(pattern, re.I)
        for i in items:
            code = str(i.get("itemCode") or "")
            fam = code.rsplit("-", 1)[1] if "-" in code else ""
            if fam in fams and regex.search(str(i.get("itemName") or "")):
                out.append(cid)
                break
    return out


def _inbox_succeeded(text: str) -> bool:
    if re.search(r"success|succeeded|started|completed|executed|turned on|is on\b", text, re.I):
        return True
    return not re.search(r"fail|unable|cannot|can't|limit reached|exceed|error|timed? ?out|rejected|"
                         r"not (?:been )?(?:executed|completed|started|possible)", text, re.I)


def sign_in(values: Dict[str, str]) -> Dict[str, Any]:
    phone = (values.get("mobilePhone") or "").strip()
    password = values.get("password") or ""
    if not phone or not password:
        raise ProviderError("Enter your mobile number and password")
    env = "prod"
    device_id = new_device_id()
    res = login(env, phone, password, device_id)
    session = {
        "userId": res["userId"],
        "accessToken": res["accessToken"],
        "refreshToken": res["refreshToken"],
        "deviceId": device_id,
        "env": env,
        "signedInAt": int(time.time() * 1000),
    }
    return {"session": session, "accountLabel": format_phone("+" + normalize_msisdn(phone))}


class ProtonClient:
    provider = {"id": "proton", "name": "Proton Link 2.0", "commands": COMMANDS}

    def __init__(self, session: Dict[str, Any], save_session: Callable[[Dict[str, Any]], None]):
        self.api = ProtonApi(session, save_session)
        self._infos: Dict[str, Dict[str, Any]] = {}
        self._supported_cache: Dict[str, Optional[List[str]]] = {}
        self._pool = ThreadPoolExecutor(max_workers=4)

    # -- vehicles --

    def _load_infos(self) -> List[Dict[str, Any]]:
        items = self.api.atlas("basic/user/vehicle/list") or []
        for v in items:
            self._infos[v["vin"]] = v
        return items

    def _info(self, vin: str) -> Dict[str, Any]:
        if vin not in self._infos:
            self._load_infos()
        info = self._infos.get(vin)
        if not info:
            raise ProviderError("Unknown vehicle", 404)
        return info

    def _image(self, v: Dict[str, Any]) -> Optional[str]:
        if not (v.get("matCode") and v.get("modelCode") and v.get("bodyColorCode")):
            return None
        try:
            res = self.api.atlas("basic/mat/model/bodyPictureList", "POST", body={
                "matCode": v["matCode"], "modelCode": v["modelCode"],
                "bodyColorCode": v["bodyColorCode"], "topColorCode": v.get("topColorCode")})
            return next((f["url"] for f in (res or {}).get("fileUrls") or [] if f.get("url")), None)
        except ProviderError:
            return None

    def _capability_items(self, vin: str) -> Optional[List[Dict[str, Any]]]:
        """The car's capability list (app/v1/vehicle/capability/service/app), or None if unavailable."""
        try:
            data = self.api.legacy("app/v1/vehicle/capability/service/app",
                                   query={"userId": self.api.user_id, "vin": vin}) or {}
        except ProviderError as e:
            log.warning("Capability list unavailable: %s", e)
            return None
        items = [i for i in data.get("list") or [] if isinstance(i, dict) and i.get("itemCode")]
        return items or None

    def _supported(self, vin: str) -> Optional[List[str]]:
        """Command ids the car lists as capabilities; None means unknown (show everything)."""
        items = self._capability_items(vin)
        if items:
            return supported_commands(items)
        # Fallback: the Atlas tree only gives families, so it can't tell e.g. window open from sunroof.
        try:
            fams = _families(self.api.atlas(f"basic/ability/vehicle/{quote(vin, safe='')}"))
        except ProviderError:
            return None
        if not fams:
            return None
        return [cid for cid, c in CONTROLS.items() if c["family"] in fams]

    def supported_for(self, vin: str) -> Optional[List[str]]:
        if vin not in self._supported_cache:
            self._supported_cache[vin] = self._supported(vin)
        return self._supported_cache[vin]

    def list_vehicles(self) -> List[Dict[str, Any]]:
        def build(v):
            img = self._pool.submit(self._image, v)
            # Re-read on each list so a capability change (e.g. a dealer update) shows up.
            self._supported_cache.pop(v["vin"], None)
            cmds = self._pool.submit(self.supported_for, v["vin"])
            return {**map_vehicle(v, img.result()), "commands": cmds.result()}

        vehicles = [build(v) for v in self._load_infos()]
        return sorted(vehicles, key=lambda x: not x.get("isDefault"))

    def _raw_status(self, vin: str) -> Dict[str, Any]:
        return self.api.atlas("iot/function/getVehicleStatus", "POST", body={"vin": vin}) or {}

    def get_status(self, vin: str) -> Dict[str, Any]:
        s = self._raw_status(vin)
        loc = coord(s.get("latitude"), s.get("longitude"))
        if loc and num(s.get("updateTime")) is not None:
            loc["updatedAt"] = num(s.get("updateTime"))
        return {"status": map_status(s), "location": loc, "raw": raw_fields(s)}

    def rename(self, vin: str, name: str) -> None:
        self.api.atlas("basic/vehicle/setVehicleName", "POST", body={"vin": vin, "vehicleName": name})
        if vin in self._infos:
            self._infos[vin]["vehicleName"] = name

    def data_usage(self, vin: str) -> Optional[Dict[str, Any]]:
        res = self.api.legacy("app/v1/vehicle/flow", query={"userId": self.api.user_id, "vin": vin}) or {}

        def to_bytes(kb):
            try:
                return float(kb) * 1024
            except (TypeError, ValueError):
                return None

        usage = {"usedBytes": to_bytes(res.get("usedFlow")), "remainingBytes": to_bytes(res.get("residueFlow"))}
        return None if usage["usedBytes"] is None and usage["remainingBytes"] is None else usage

    # -- trips --

    TRIP_PAGE = 50
    TRIP_MAX_PAGES = 20  # 1,000 trips per range

    def trips(self, vin: str, start: int, end: int) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        for page in range(1, self.TRIP_MAX_PAGES + 1):
            batch = self.api.atlas("bigdata/vehicle/trip/queryList/app/v1", "POST", body={
                "startTime": start, "endTime": end, "vin": vin,
                "isPage": True, "currentPage": page, "pageSize": self.TRIP_PAGE}) or []
            items.extend(batch)
            if len(batch) < self.TRIP_PAGE:
                break
        trips = [t for t in (map_trip(t, i) for i, t in enumerate(items)) if t]
        # Drop repeats (in case the server ignores paging) and anything outside the range.
        seen, out = set(), []
        for t in trips:
            if t["startedAt"] in seen or not start <= t["startedAt"] <= end:
                continue
            seen.add(t["startedAt"])
            out.append(t)
        return sorted(out, key=lambda t: t["startedAt"], reverse=True)

    def trip_track(self, vin: str, start: int, end: int) -> List[Dict[str, float]]:
        points = self.api.atlas("bigdata/vehicle/trip/queryTrackList/app/v1", "POST", body={
            "startTime": start, "endTime": end, "currentPage": 0, "pageSize": 1000, "vin": vin}) or []
        return [c for c in (coord(p.get("latitude"), p.get("longitude")) for p in points) if c]

    # -- inbox --

    def _labels(self) -> List[Dict[str, Any]]:
        return [l for l in (self.api.atlas("information/mobileLog/queryLabelList") or []) if l.get("labelId")]

    def _messages(self, label_ids: List[str], size: int) -> List[Dict[str, Any]]:
        return self.api.atlas("information/mobileLog/queryPageList",
                              query={"labelIdList": label_ids, "currentPage": 1, "pageSize": size}) or []

    def notices(self) -> List[Dict[str, Any]]:
        labels = self._labels()
        if not labels:
            return []
        names = {l["labelId"]: l.get("labelName") for l in labels}
        out = []
        for n in self._messages(list(names), 30):
            created = n.get("createTimeInt")
            if not created:
                try:
                    created = time.mktime(time.strptime(str(n.get("createTime")), "%Y-%m-%d %H:%M:%S")) * 1000
                except ValueError:
                    created = time.time() * 1000
            out.append({
                "id": str(n.get("id")),
                **format_notice(n.get("messageTitle"), n.get("messageContent"), names.get(n.get("templateLabelId"))),
                "createdAt": created,
                "isRead": n.get("readStatus") != 0,
            })
        return out

    def mark_read(self, notice_id: str) -> None:
        self.api.atlas("information/mobileLog/markReadByLogId", "POST", body={"logIds": [notice_id]})

    # -- commands --

    def _push_device_id(self) -> str:
        push_id = self.api.session.get("pushDeviceId")
        if not push_id:
            push_id = register_push_device(self.api)
            if push_id:
                self.api.set_push_device_id(push_id)
        else:
            bind_push_device(self.api, push_id)
        return push_id or self.api.device_id

    def send_command(self, vin: str, command: str, pin: Optional[str], params: Dict[str, Any]) -> Dict[str, Any]:
        control = CONTROLS.get(command)
        if not control:
            raise ProviderError(f"Unsupported command {command}", 400)
        info = self._info(vin)
        supported = self.supported_for(vin)
        if supported is not None and command not in supported:
            raise ProviderError("Your car doesn’t support this command", 400)
        if info.get("enablePin"):
            if not pin:
                raise ProviderError("Enter your vehicle PIN", "pin")
            # Proton Link sends md5(md5(pin) + userId); the PIN is checked before each command.
            self.api.atlas("basic/vehicle/checkPinCode", "POST", body={
                "vin": vin, "pinCode": md5(md5(pin) + self.api.user_id), "type": "VEHICLE_CONTROL"})
        req = control["build"](params or {})

        mqtt_id = self._push_device_id()
        with device_lock(mqtt_id):
            # Snapshot the inbox and subscribe before sending: a fast car can answer first.
            labels = [l["labelId"] for l in self._safe(self._labels, [])]
            seen = {self._msg_key(m) for m in (self._safe(lambda: self._messages(labels, 10), []) if labels else [])}
            watch = ResultWatch(self.api.env, mqtt_id)
            watching = watch.start()
            try:
                res = self.api.atlas("iot/function/vehicleControl", "POST", body={
                    "vin": vin, "scheduledTime": None, "endTime": None, "duration": None,
                    "parameters": None, "timerData": None, **req}) or {}
                request_id = res.get("requestId")
                queued = {"isOk": True, "message": "Sent to your car", "requestId": request_id, "isConfirmed": False}
                if not request_id:
                    return queued
                result = self._race(watch if watching else None, request_id, labels, seen)
                if not result:
                    return {**queued, "deliveredToCar": watching and watch.delivered(request_id)}
                if not result.get("isOk"):
                    msg = CAR_REFUSALS.get(str(result.get("code"))) or result.get("message") or "The car couldn’t do that"
                    return {"isOk": False, "message": msg, "requestId": request_id, "isConfirmed": True}
                return {"isOk": True, "message": "Done", "requestId": request_id, "isConfirmed": True}
            finally:
                watch.close()

    @staticmethod
    def _safe(fn, default):
        try:
            return fn()
        except ProviderError:
            return default

    @staticmethod
    def _msg_key(m: Dict[str, Any]) -> str:
        return str(m.get("id") or f"{m.get('createTimeInt')}:{m.get('messageContent')}")

    def _race(self, watch: Optional[ResultWatch], request_id: str, labels: List[str], seen: set) -> Optional[dict]:
        """First answer from MQTT or the inbox (Proton also files each outcome there)."""
        done = threading.Event()
        box: Dict[str, Any] = {}

        def finish(r):
            if r and not done.is_set():
                box["r"] = r
                done.set()

        if watch:
            threading.Thread(target=lambda: finish(watch.wait_for(request_id, COMMAND_TIMEOUT)), daemon=True).start()

        def poll_inbox():
            deadline = time.time() + COMMAND_TIMEOUT
            while labels and not done.is_set() and time.time() < deadline:
                done.wait(5)
                for m in self._safe(lambda: self._messages(labels, 10), []):
                    if self._msg_key(m) in seen:
                        continue
                    if not re.search(r"vehicle\s*control|remote|control",
                                     f"{m.get('messageTitle')} {m.get('templatesCategoryCode')}", re.I):
                        continue
                    try:
                        data = json.loads(m["businessData"]) if m.get("businessData") else {}
                    except ValueError:
                        data = {}
                    if data.get("taskId") and data["taskId"] != request_id:
                        continue
                    if data.get("serviceResult") == "ISSUED_SUCCESS":
                        continue
                    text = (m.get("messageContent") or "").strip()
                    sr = data.get("serviceResult")
                    ok = True if sr == "EXECUTION_SUCCESS" else False if sr == "EXECUTION_FAIL" else _inbox_succeeded(text)
                    return finish({"isOk": ok, "code": data.get("code"), "message": text or None})

        threading.Thread(target=poll_inbox, daemon=True).start()
        done.wait(COMMAND_TIMEOUT + 2)
        done.set()
        return box.get("r")
