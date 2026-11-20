import { AlertTriangle, Fan, Fuel, Gauge, Lock, LockOpen, Power, Thermometer, Wrench } from "lucide-react";

import { useCar, useNow } from "../car";
import { CarTopView } from "../components/CarTopView";
import { Bar, Card, Dot, Stat } from "../components/ui";
import { ActiveTimers } from "../components/Timers";
import { fuelLevel, fuelPercent, n, serviceLevel } from "../format";
import type { Tab } from "../App";

export function Overview({ go }: { go: (t: Tab) => void }) {
  const { status, vehicle, pending } = useCar();
  useNow(30_000);
  if (!status) return null;
  const s = status.status;
  const fuel = fuelPercent(s.fuelLitres, vehicle.fuelTankLitres, s.fuelPercent);
  const anyWindowOpen = Object.values(s.windows ?? {}).some((w) => w === "open");
  const anyDoorOpen = Object.values(s.doors ?? {}).some((d) => d === "open");
  const locked = s.lock === "locked";

  return (
    <div className="stack">
      <div className="hero">
        {vehicle.imageUrl && <img src={vehicle.imageUrl} alt="" referrerPolicy="no-referrer" />}
        <div className="hero-chips">
          <button className="chip" onClick={() => go("controls")}>
            {locked ? <Lock size={15} /> : <LockOpen size={15} />}
            {pending.has("lock") ? "Lock state pending" : locked ? "Locked" : "Unlocked"}
            <Dot level={pending.has("lock") ? "none" : locked ? "good" : "warn"} />
          </button>
          <button className="chip" onClick={() => go("controls")}>
            <Power size={15} />
            Engine {s.isEngineOn ? "running" : "off"}
            <Dot level={s.isEngineOn ? "warn" : "good"} />
          </button>
          <button className="chip" onClick={() => go("climate")}>
            <Fan size={15} />
            Climate {s.climate?.isOn ? "on" : "off"}
          </button>
          {(anyWindowOpen || anyDoorOpen) && (
            <span className={`chip ${anyDoorOpen ? "bad" : "warn"}`}>
              <AlertTriangle size={15} />
              {anyDoorOpen ? "Door open" : "Window open"}
            </span>
          )}
        </div>
      </div>

      <ActiveTimers />

      {!!s.warnings?.length && (
        <Card title="Attention">
          <ul className="warnings">
            {s.warnings.map((w) => (
              <li key={w} className={isPartWarning(w) ? "bad" : ""}>
                <Dot level={isPartWarning(w) ? "bad" : "warn"} /> {w}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid stats">
        <button className="stat-card" onClick={() => go("health")}>
          <Stat
            icon={<Fuel size={15} />}
            label="Fuel"
            level={fuelLevel(fuel.pct)}
            value={fuel.pct != null ? `${n(fuel.pct)}%` : s.fuelLitres != null ? `${n(s.fuelLitres, 1)} L` : "—"}
            sub={s.fuelLitres != null && vehicle.fuelTankLitres ? `${n(s.fuelLitres, 1)} of ${vehicle.fuelTankLitres} L${fuel.estimated ? " · est." : ""}` : undefined}
          />
          <Bar pct={fuel.pct} level={fuelLevel(fuel.pct)} />
        </button>
        <Stat icon={<Gauge size={15} />} label="Range" value={s.rangeKm != null ? `${n(s.rangeKm)} km` : "—"} />
        <button className="stat-card" onClick={() => go("climate")}>
          <Stat
            icon={<Thermometer size={15} />}
            label="Outside"
            value={s.climate?.outsideTempC != null ? `${n(s.climate.outsideTempC, 1)}°C` : "—"}
            sub={s.climate?.cabinTempC != null ? `Cabin ${n(s.climate.cabinTempC, 1)}°C` : "Cabin not reported"}
          />
        </button>
        <button className="stat-card" onClick={() => go("health")}>
          <Stat
            icon={<Wrench size={15} />}
            label="Next service"
            level={serviceLevel(s.serviceDueKm, s.serviceDueDays)}
            value={s.serviceDueKm != null ? `${n(s.serviceDueKm)} km` : s.serviceDueDays != null ? `${s.serviceDueDays} days` : "—"}
            sub={s.serviceDueKm != null && s.serviceDueKm < 0 ? "Overdue" : undefined}
          />
        </button>
      </div>

      <Card title="Doors">
        <CarTopView status={s} />
      </Card>

      <div className="grid stats">
        <Stat label="Odometer" value={s.odometerKm != null ? `${n(s.odometerKm, 1)} km` : "—"} />
        <Stat label="Avg consumption" value={s.avgFuelLPer100km != null ? `${n(s.avgFuelLPer100km, 1)} L/100km` : "—"} />
        <Stat label="Avg speed" value={s.avgSpeedKmh != null ? `${n(s.avgSpeedKmh)} km/h` : "—"} />
        <Stat label="Parking brake" value={s.isParkingBrakeOn == null ? "—" : s.isParkingBrakeOn ? "On" : "Off"} level={s.isParkingBrakeOn === false ? "warn" : "none"} />
      </div>
    </div>
  );
}

/** Door, bonnet and trunk warnings are red; windows and the rest are amber. */
const isPartWarning = (w: string) => /^(front|rear) (left|right) open$|^(bonnet|trunk) open$/i.test(w);
