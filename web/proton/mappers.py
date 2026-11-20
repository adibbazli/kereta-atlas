"""Atlas payloads -> app shapes. Port of src/providers/proton/mappers.ts and format.ts."""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional


def num(v: Any) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _int(v: Any) -> Optional[int]:
    n = num(v)
    return int(n) if n is not None else None


# Code tables from acosdk VehicleStatus helpers: null means "normal".
def _door(v: Any) -> str:
    n = _int(v)
    return "closed" if n is None or n == 2 else "open"


def _win(v: Any) -> str:
    n = _int(v)
    return "closed" if n is None or n == 0 else "open"


def _door_locked(v: Any) -> bool:
    n = _int(v)
    return n is None or n in (2, 3)


def _kpa(v: Any) -> Optional[float]:
    n = num(v)
    if n is None or n <= 0:
        return None
    return n * 100 if n < 10 else n


def _tyre_warn(v: Any) -> Optional[bool]:
    n = _int(v)
    return None if n is None else n != 0


def _positive(n: Optional[float]) -> Optional[float]:
    return n if n is not None and n > 0 else None


def _nonzero(n: Optional[float]) -> Optional[float]:
    return n if n is not None and n != 0 else None


CHARGING = {2, 5, 15, 24, 28, 30}


def _label(k: str) -> str:
    return re.sub(r"([A-Z])", r" \1", k).strip().capitalize()


def map_status(s: Dict[str, Any]) -> Dict[str, Any]:
    doors = {
        "frontLeft": _door(s.get("doorOpenStatusLeftFront")),
        "frontRight": _door(s.get("doorOpenStatusRightFront")),
        "rearLeft": _door(s.get("doorOpenStatusLeftRear")),
        "rearRight": _door(s.get("doorOpenStatusRightRear")),
        "trunk": _door(s.get("trunkOpenStatus")),
        "hood": _door(s.get("engineHoodOpenStatus")),
    }
    windows = {
        "frontLeft": _win(s.get("winStatusLeftFront")),
        "frontRight": _win(s.get("winStatusRightFront")),
        "rearLeft": _win(s.get("winStatusLeftRear")),
        "rearRight": _win(s.get("winStatusRightRear")),
        "sunroof": _win(s.get("sunroofOpenStatus")),
    }
    warnings: List[str] = []
    for k, v in doors.items():
        if v == "open":
            warnings.append(f"{_label('bonnet' if k == 'hood' else k)} open")
    for k, v in windows.items():
        if v == "open":
            warnings.append(f"{_label(k)} open")
    for pos in ("LeftFront", "RightFront", "LeftRear", "RightRear"):
        w = _int(s.get(f"tyrePreWarning{pos}"))
        if w is not None and w != 0:
            warnings.append(f"Tyre pressure: {_label(pos).lower()}")

    locked = all(_door_locked(s.get(k)) for k in (
        "doorLockStatusLeftFront", "doorLockStatusLeftRear", "doorLockStatusRightFront", "doorLockStatusRightRear"))
    lock = "locked" if locked else "unlocked"
    battery = num(s.get("powerBatteryLevel"))
    charger = _int(s.get("chargerState"))
    lid = _int(s.get("dcOrAcDcChargeLidStatus"))
    trunk_lock = _int(s.get("trunkLockStatus"))
    return {
        "updatedAt": num(s.get("updateTime")),
        "lock": lock,
        "isParkingBrakeOn": None if s.get("electricParkBrakeStatus") is None else s.get("electricParkBrakeStatus") == "1",
        # fuelLevel is litres, not %.
        "fuelLitres": num(s.get("fuelLevel")),
        "batteryPercent": min(100, battery) if battery is not None and battery > 0 else None,
        "isCharging": None if charger is None else charger in CHARGING,
        "isChargePortOpen": None if lid is None else _door(lid) == "open",
        "rangeKm": num(s.get("distanceToEmpty")) if num(s.get("distanceToEmpty")) is not None else num(s.get("distanceToEmptyOnBatteryOnly")),
        "odometerKm": num(s.get("odometer")),
        "avgFuelLPer100km": _positive(num(s.get("aveFuelConsumption"))),
        "avgSpeedKmh": _positive(num(s.get("avgSpeed"))),
        # Inverted: "0" means running.
        "isEngineOn": None if s.get("engineStatus") is None else s.get("engineStatus") == "0",
        "climate": {
            "isOn": s.get("preClimateActive") == "true",
            "cabinTempC": num(s.get("interiorTemp")),
            "outsideTempC": num(s.get("exteriorTemp")),
            "targetTempC": _positive(num(s.get("airConditionTemperature"))),
        },
        "doors": doors,
        "isTrunkLocked": trunk_lock == 2 if trunk_lock is not None else lock == "locked",
        "windows": windows,
        "tyres": {
            "frontLeft": _kpa(s.get("tyreStatusLeftFront")),
            "frontRight": _kpa(s.get("tyreStatusRightFront")),
            "rearLeft": _kpa(s.get("tyreStatusLeftRear")),
            "rearRight": _kpa(s.get("tyreStatusRightRear")),
        },
        "tyreWarnings": {
            "frontLeft": _tyre_warn(s.get("tyrePreWarningLeftFront")),
            "frontRight": _tyre_warn(s.get("tyrePreWarningRightFront")),
            "rearLeft": _tyre_warn(s.get("tyrePreWarningLeftRear")),
            "rearRight": _tyre_warn(s.get("tyrePreWarningRightRear")),
        },
        "warnings": warnings,
        "serviceDueKm": _nonzero(num(s.get("distanceToService"))),
        "serviceDueDays": _nonzero(num(s.get("daysToService"))),
        # 12 V battery, volts.
        "batteryVoltage": _positive(num(s.get("voltage"))),
        "speedKmh": num(s.get("speed")),
        # Only when the car flags the reading as valid (the S70 sends e.g. 1.35 °C with validity 0).
        "engineRpm": _valid(s, "engineSpeed"),
        "coolantTempC": _valid(s, "engineCoolantTemperature"),
        # 0-100, how far each window is open.
        "windowPositions": {
            "frontLeft": num(s.get("winPosLeftFront")),
            "frontRight": num(s.get("winPosRightFront")),
            "rearLeft": num(s.get("winPosLeftRear")),
            "rearRight": num(s.get("winPosRightRear")),
        },
        "isVentilating": _ventilating(s),
    }


def _ventilating(s: Dict[str, Any]) -> Optional[bool]:
    """On when ventilateStatus is 1, or all four windows sit at the ventilation gap (position 8)."""
    positions = [num(s.get(f"winPos{p}")) for p in ("LeftFront", "RightFront", "LeftRear", "RightRear")]
    if str(s.get("ventilateStatus")) == "1" or (all(x is not None for x in positions) and all(x == 8 for x in positions)):
        return True
    if s.get("ventilateStatus") is None and any(x is None for x in positions):
        return None
    return False


def _valid(s: Dict[str, Any], key: str) -> Optional[float]:
    flag = s.get(f"{key}Validity")
    if flag is not None and str(flag) != "1":
        return None
    return num(s.get(key))


# Location duplicates and ids stay out of the "All data" table.
_RAW_SKIP = {"latitude", "longitude", "latitudeOriginal", "longitudeOriginal", "requestId", "vin"}


def raw_fields(s: Dict[str, Any]) -> List[List[Any]]:
    """Every non-empty field the car reported, as [key, value] pairs (strings/numbers only)."""
    out = []
    for k in sorted(s):
        v = s[k]
        if k in _RAW_SKIP or v in (None, "") or isinstance(v, (dict, list)):
            continue
        out.append([k, v])
    return out


_IMAGE = re.compile(r"^https://.+\.(png|jpe?g|webp)(\?|$)", re.I)


def https_image(url: Any) -> Optional[str]:
    return url if isinstance(url, str) and _IMAGE.match(url) else None


def https_url(url: Any) -> Optional[str]:
    """Renders from bodyPictureList are used as-is (they may lack an extension); https only, per the CSP."""
    return url if isinstance(url, str) and url.lower().startswith("https://") else None


TANKS = [(re.compile(r"\bS70\b|^P380", re.I), 50)]


def map_vehicle(v: Dict[str, Any], image_url: Optional[str] = None) -> Dict[str, Any]:
    names = " ".join(x for x in (v.get("matName"), v.get("modelName"), v.get("vehicleName")) if x)
    tank = next((t for re_, t in TANKS if re_.search(names) or re_.search(v.get("modelName") or "")), None)
    return {
        "id": v["vin"],
        "vin": v["vin"],
        "name": (v.get("vehicleName") or "").strip() or "Proton",
        "model": v.get("modelName") or v.get("matName"),
        "imageUrl": https_url(image_url) or https_image(v.get("vehicleModelUrl")),
        "isDefault": bool(v.get("isDefault")),
        "isPinRequired": bool(v.get("enablePin")),
        "fuelTankLitres": tank,
    }


def coord(lat: Any, lng: Any) -> Optional[Dict[str, float]]:
    la, ln = num(lat), num(lng)
    if la is None or ln is None or (la == 0 and ln == 0):
        return None
    return {"latitude": la, "longitude": ln}


def _minutes(v: Any) -> Optional[float]:
    if not v:
        return None
    v = str(v)
    if ":" in v:
        parts = [float(p or 0) for p in v.split(":")] + [0, 0]
        return parts[0] * 60 + parts[1] + parts[2] / 60
    ms = num(v)
    return ms / 60_000 if ms is not None else None


def map_trip(t: Dict[str, Any], i: int) -> Optional[Dict[str, Any]]:
    start = num(t.get("tripStartTime"))
    if start is None:
        return None
    end = num(t.get("tripEndTime"))
    dur = _minutes(t.get("tripUseTimes"))
    if dur is None and end:
        dur = (end - start) / 60_000
    km = num(t.get("tripUseMiles"))
    # tripPowerCns: litres of fuel used on the trip. 0 means the car didn't report it.
    litres = num(t.get("tripPowerCns"))
    if litres is not None and litres <= 0:
        litres = None
    return {
        "id": f"{int(start)}-{i}",
        "startedAt": start,
        "endedAt": end,
        "distanceKm": km,
        "durationMin": dur,
        "avgSpeedKmh": num(t.get("avgSpeed")),
        "fuelUsedL": litres,
        "fuelLPer100km": round(litres / km * 100, 1) if litres is not None and km else None,
        "start": coord(t.get("tripStartLatitude"), t.get("tripStartLongitude")),
        "end": coord(t.get("tripEndLatitude"), t.get("tripEndLongitude")),
    }


def format_phone(raw: str) -> str:
    digits = re.sub(r"[^\d+]", "", raw)
    m = re.match(r"^\+?60(1\d)(\d{7,8})$", digits)
    if not m:
        return raw
    prefix, rest = m.groups()
    head = rest[:4] if len(rest) == 8 else rest[:3]
    return f"+60 {prefix}-{head} {rest[len(head):]}"


def _kind(label: Optional[str], title: str, body: str) -> Optional[str]:
    text = f"{label or ''} {title} {body}"
    if re.search(r"vehicle\s*control|remote (?:engine|start|lock|unlock|control|command)|command (?:sent|executed|failed)", text, re.I):
        return "command"
    if re.search(r"login|security|password|account", text, re.I):
        return "security"
    if re.search(r"service|maintenance|appointment", text, re.I):
        return "service"
    return None


def _title(label: Optional[str], title: str, body: str) -> str:
    if title:
        spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", title).strip()
        return title if spaced == title else spaced[0] + spaced[1:].lower()
    text = f"{label or ''} {body}"
    if re.search(r"logged in|login|sign(ed)? in", text, re.I):
        return "New login"
    if re.search(r"service|maintenance|appointment", text, re.I):
        return "Service reminder"
    return "Message"


def format_notice(title: Optional[str], body: Optional[str], label: Optional[str]) -> Dict[str, Any]:
    t, b = (title or "").strip(), (body or "").strip()
    b = re.sub(r"\bANDROID\b", "Android", re.sub(r"\bIOS\b", "iOS", b))
    return {"title": _title(label, t, b), "body": b or None, "kind": _kind(label, t, b)}
