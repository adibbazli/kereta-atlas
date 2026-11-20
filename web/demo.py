"""Simulated car shaped like a Proton S70 (same fields, same supported commands). No account needed."""

from __future__ import annotations

import copy
import time
from typing import Any, Dict, List, Optional

from proton.api import ProviderError
from proton.client import COMMANDS as PROTON_COMMANDS
from proton.mappers import _label, map_trip

DEMO_PIN = "1234"
# Commands that need the PIN in the demo, to exercise the PIN step.
PIN_COMMANDS = {"unlock", "engine_start"}
SUPPORTED = ["lock", "unlock", "horn_lights", "windows_open", "windows_close", "ventilate_on", "ventilate_off", "trunk_open",
             "climate_on", "climate_off", "engine_start", "engine_stop"]
COMMANDS = [{**c, "isPinRequired": c["id"] in PIN_COMMANDS} for c in PROTON_COMMANDS if c["id"] in SUPPORTED]

_POSITIONS = ("frontLeft", "frontRight", "rearLeft", "rearRight")
_STATE: Dict[str, Any] = {
    "lock": "locked",
    "isParkingBrakeOn": True,
    "fuelLitres": 15.5,
    "rangeKm": 167,
    "odometerKm": 1042.2,
    "avgFuelLPer100km": 7.67,
    "avgSpeedKmh": 34,
    "isEngineOn": False,
    "climate": {"isOn": False, "cabinTempC": None, "outsideTempC": 25, "targetTempC": None},
    "doors": {p: "closed" for p in _POSITIONS} | {"trunk": "closed", "hood": "closed"},
    "isTrunkLocked": True,
    "windows": {p: "closed" for p in _POSITIONS} | {"sunroof": "closed"},
    "windowPositions": {p: 0 for p in _POSITIONS},
    "tyres": {"frontLeft": 212.8, "frontRight": 210.1, "rearLeft": 215.6, "rearRight": 215.6},
    "tyreWarnings": {p: None for p in _POSITIONS},
    "warnings": [],
    "serviceDueKm": 7476,
    "serviceDueDays": None,
    "batteryVoltage": 12.6,
    "speedKmh": 0,
    "engineRpm": None,
    "coolantTempC": None,
    "isVentilating": False,
}


# Messages made by demo commands, newest first. Module-level, so every client in this process (a
# browser's, or the push cron's) sees the same inbox. Lost on restart, like the rest of the demo.
_COMMAND_NOTICES: List[Dict[str, Any]] = []
_NOTICE_TEXT = {"lock": "was locked", "unlock": "was unlocked", "horn_lights": "flashed its lights and sounded the horn",
                "engine_start": "engine started", "engine_stop": "engine stopped", "climate_on": "climate turned on",
                "climate_off": "climate turned off", "windows_close": "windows closed", "windows_open": "windows opened"}


def sign_in(values: Dict[str, str]) -> Dict[str, Any]:
    return {"session": {"token": "demo"}, "accountLabel": (values.get("name") or "").strip()[:40] or "Demo driver"}


class DemoClient:
    provider = {"id": "demo", "name": "Demo car", "commands": COMMANDS}

    def __init__(self, session: Dict[str, Any], save_session=None, reload_session=None):
        self.state = copy.deepcopy(_STATE)
        # Like Proton's cloud copy: the timestamp only moves when the car "uploads" (a change).
        self.uploaded_at = time.time() * 1000
        self.vehicles = [{
            "id": "DEMO00000000001", "vin": "DEMO00000000001", "name": "Demo S70", "model": "P380-1.5-7DCT-2WD",
            "isDefault": True, "isPinRequired": False, "fuelTankLitres": 50, "commands": SUPPORTED,
        }]

    def _vehicle(self, vin: str) -> Dict[str, Any]:
        v = next((x for x in self.vehicles if x["vin"] == vin), None)
        if not v:
            raise ProviderError("Unknown vehicle", 404)
        return v

    def list_vehicles(self) -> List[Dict[str, Any]]:
        time.sleep(0.3)
        return self.vehicles

    def get_status(self, vin: str) -> Dict[str, Any]:
        self._vehicle(vin)
        time.sleep(0.3)
        now = time.time() * 1000
        s = copy.deepcopy(self.state)
        s["updatedAt"] = self.uploaded_at
        # Same wording as the real mapper (proton/mappers.py map_status).
        name = lambda k: _label("bonnet" if k == "hood" else k)
        s["warnings"] = ([f"{name(k)} open" for k, v in s["doors"].items() if v == "open"]
                         + [f"{name(k)} open" for k, v in s["windows"].items() if v == "open"])
        raw = [["exteriorTemp", "25"], ["fuelLevel", str(s["fuelLitres"])], ["voltage", "12.6"],
               ["distanceToService", "7476"], ["engineStatus", "0" if s["isEngineOn"] else "1"],
               ["odometer", "1042.2"], ["transimissionGearPostion", "1"]]
        return {"status": s, "location": {"latitude": 3.139, "longitude": 101.6869, "updatedAt": self.uploaded_at}, "raw": raw}

    def send_command(self, vin: str, command: str, pin: Optional[str], params: Dict[str, Any]) -> Dict[str, Any]:
        self._vehicle(vin)
        if command not in SUPPORTED:
            raise ProviderError("Your car doesn’t support this command", 400)
        time.sleep(1.2)
        if command in PIN_COMMANDS and pin != DEMO_PIN:
            return {"isOk": False, "message": "Wrong PIN (demo PIN is 1234)", "isConfirmed": True}
        s = self.state
        if command == "lock":
            s["lock"], s["isTrunkLocked"] = "locked", True
            s["doors"]["trunk"] = "closed"
        elif command == "unlock":
            s["lock"] = "unlocked"
        elif command == "trunk_open":
            s["isTrunkLocked"] = False
        elif command == "climate_on":
            temp = float(params.get("temp", 22))
            if not 16 <= temp <= 32:
                raise ProviderError("Temperature must be between 16 and 32 °C", 400)
            s["climate"] = {**s["climate"], "isOn": True, "targetTempC": temp}
            s["isEngineOn"] = True  # remote climate runs the engine on this car
        elif command == "climate_off":
            s["climate"] = {**s["climate"], "isOn": False, "targetTempC": None}
        elif command == "engine_start":
            if int(params.get("minutes", 10)) not in (3, 5, 8, 10):
                raise ProviderError("Run time must be 3, 5, 8 or 10 minutes", 400)
            s["isEngineOn"] = True
        elif command == "engine_stop":
            s["isEngineOn"] = False
            s["climate"] = {**s["climate"], "isOn": False}
        elif command in ("windows_open", "windows_close", "ventilate_off"):
            opening = command == "windows_open"
            s["windows"] = {p: "open" if opening else "closed" for p in _POSITIONS} | {"sunroof": "closed"}
            s["windowPositions"] = {p: 100 if opening else 0 for p in _POSITIONS}
            s["isVentilating"] = False
        elif command == "ventilate_on":
            # Like the real car: every window opens to the ventilation gap (position 8).
            s["windows"] = {p: "open" for p in _POSITIONS} | {"sunroof": "closed"}
            s["windowPositions"] = {p: 8 for p in _POSITIONS}
            s["isVentilating"] = True
        self.uploaded_at = time.time() * 1000
        if command in _NOTICE_TEXT:
            now = time.time() * 1000
            _COMMAND_NOTICES.insert(0, {"id": f"cmd-{int(now)}", "title": "Remote control",
                                        "body": f"Demo S70 {_NOTICE_TEXT[command]}.", "createdAt": now,
                                        "kind": "security", "isRead": False})
            del _COMMAND_NOTICES[20:]
        return {"isOk": True, "message": "Done", "isConfirmed": True}

    def simulate_part(self, vin: str, part: str) -> None:
        """Demo only: flip a door, the bonnet or the trunk between open and closed."""
        self._vehicle(vin)
        doors = self.state["doors"]
        if part not in doors:
            raise ProviderError("Unknown part", 400)
        doors[part] = "closed" if doors[part] == "open" else "open"
        self.uploaded_at = time.time() * 1000

    def rename(self, vin: str, name: str) -> None:
        self._vehicle(vin)["name"] = name

    def data_usage(self, vin: str):
        return {"usedBytes": 1.2 * 1024 ** 3, "remainingBytes": 3.8 * 1024 ** 3}

    def trips(self, vin: str, range_start: int, range_end: int) -> List[Dict[str, Any]]:
        now = min(time.time() * 1000, range_end)
        out = []
        for i in range(200):
            start = now - (i + 1) * 9 * 3600_000
            if start < range_start:
                break
            mins = 12 + (i * 17) % 50
            km = round(mins * 0.7, 1)
            litres = round(km * (6.2 + (i * 7) % 30 / 10) / 100, 2)
            # Refuelled with the engine running: the car reports fuel level start - end.
            if i % 11 == 4:
                litres = round(litres - 32.0, 2)   # filled up: negative
            elif i % 11 == 9:
                litres = round(litres - 0.9 * litres, 2)   # topped up a little: too small
            trip = map_trip({
                "tripStartTime": start, "tripEndTime": start + mins * 60_000, "tripUseTimes": str(mins * 60_000),
                "tripUseMiles": km, "avgSpeed": 42, "tripPowerCns": litres,
                "tripStartLatitude": 3.139, "tripStartLongitude": 101.6869,
                "tripEndLatitude": 3.139 + 0.002 * mins, "tripEndLongitude": 101.6869 + 0.0015 * mins,
            }, i)
            if trip:
                out.append(trip)
        return out

    def trip_track(self, vin: str, start: int, end: int) -> List[Dict[str, float]]:
        return [{"latitude": 3.139 + 0.0006 * i + 0.002 * (i % 7 == 0), "longitude": 101.6869 + 0.0004 * i * (1 + (i > 20))}
                for i in range(40)]

    def notices(self) -> List[Dict[str, Any]]:
        now = time.time() * 1000
        return [
            *(dict(n) for n in _COMMAND_NOTICES),
            {"id": "n1", "title": "Service due soon", "body": "Your next service is in 800 km.", "createdAt": now - 3600_000, "kind": "service", "isRead": False},
            {"id": "n2", "title": "Vehicle locked", "body": "Demo S70 was locked remotely.", "createdAt": now - 86_400_000, "isRead": True, "kind": "security"},
        ]

    def mark_read(self, notice_id: str) -> None:
        for n in _COMMAND_NOTICES:
            if n["id"] == notice_id:
                n["isRead"] = True
