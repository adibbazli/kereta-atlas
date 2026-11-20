import { BatteryMedium, ChevronDown, Fuel, Gauge, Info, Signal, Wrench } from "lucide-react";
import { useEffect } from "react";

import { useCar } from "../car";
import { CarTopView } from "../components/CarTopView";
import { Bar, Card, Dot, Spinner, Stat } from "../components/ui";
import { batteryLevel, bytes, fuelLevel, fuelPercent, label, n, percentLevel, serviceLevel, THRESHOLDS, type Level } from "../format";
import type { Position } from "../types";

const POSITIONS: Position[] = ["frontLeft", "frontRight", "rearLeft", "rearRight"];

export function Health() {
  const { status, vehicle, usage, loadUsage, provider, simulate } = useCar();
  useEffect(() => {
    if (usage.data === undefined && !usage.loading && !usage.error) loadUsage();
  }, [usage, loadUsage]);
  if (!status) return null;
  const s = status.status;
  const fuel = fuelPercent(s.fuelLitres, vehicle.fuelTankLitres, s.fuelPercent);
  const used = usage.data?.usedBytes ?? null;
  const left = usage.data?.remainingBytes ?? null;
  const planPct = used != null && left != null && used + left > 0 ? (left / (used + left)) * 100 : null;
  const tyreLevel = (p: Position): Level => {
    const w = s.tyreWarnings?.[p];
    return w == null ? "none" : w ? "bad" : "good";
  };
  const hasTyreFlags = POSITIONS.some((p) => s.tyreWarnings?.[p] != null);

  return (
    <div className="stack">
      <div className="grid two">
        <Card title={<><Fuel size={16} /> Fuel</>}>
          <div className="big-row">
            <span className="big">{fuel.pct != null ? `${n(fuel.pct)}%` : "—"}</span>
            <Dot level={fuelLevel(fuel.pct)} />
          </div>
          <Bar pct={fuel.pct} level={fuelLevel(fuel.pct)} />
          <p className="muted small">
            {s.fuelLitres != null ? `${n(s.fuelLitres, 1)} L` : "—"}
            {vehicle.fuelTankLitres ? ` of ${vehicle.fuelTankLitres} L` : ""} · {s.rangeKm != null ? `${n(s.rangeKm)} km range` : "range —"}
            {fuel.estimated && " · % estimated from the tank size"}
          </p>
        </Card>

        <Card title={<><Wrench size={16} /> Service</>}>
          <div className="big-row">
            <span className="big">{s.serviceDueKm != null ? `${n(s.serviceDueKm)} km` : s.serviceDueDays != null ? `${s.serviceDueDays} d` : "—"}</span>
            <Dot level={serviceLevel(s.serviceDueKm, s.serviceDueDays)} />
          </div>
          <p className="muted small">
            {s.serviceDueKm != null && s.serviceDueKm < 0 ? "Overdue" : "Until the next service"}
            {s.serviceDueDays != null ? ` · ${s.serviceDueDays} days` : " · the car doesn’t report days"}
          </p>
        </Card>

        <Card title={<><BatteryMedium size={16} /> 12 V battery</>}>
          <div className="big-row">
            <span className="big">{s.batteryVoltage != null ? `${n(s.batteryVoltage, 1)} V` : "—"}</span>
            <Dot level={batteryLevel(s.batteryVoltage)} />
          </div>
          <p className="muted small">{s.isEngineOn ? "Engine running: charging voltage is higher" : "Resting voltage"}</p>
        </Card>

        <Card title={<><Signal size={16} /> Car data plan</>}>
          {usage.loading ? (
            <Spinner />
          ) : usage.error ? (
            <p className="muted small">{usage.error}</p>
          ) : usage.data ? (
            <>
              <div className="big-row">
                <span className="big">{bytes(left)}</span>
                <Dot level={percentLevel(planPct)} />
              </div>
              <Bar pct={planPct} level={percentLevel(planPct)} />
              <p className="muted small">left · {bytes(used)} used</p>
            </>
          ) : (
            <p className="muted small">Not available</p>
          )}
        </Card>
      </div>

      <Card title="Tyres">
        <div className="tyres">
          {POSITIONS.map((p) => (
            <div key={p} className={`tyre tyre-${p}`}>
              <span className="tyre-name">{label(p)}</span>
              <span className="tyre-value">
                {s.tyres?.[p] != null ? `${n(s.tyres[p], 0)} kPa` : "—"}
                <Dot level={tyreLevel(p)} />
              </span>
              <span className="muted small">{s.tyres?.[p] != null ? `${n(s.tyres[p]! / 100, 2)} bar · ${n(s.tyres[p]! * 0.145038, 0)} psi` : ""}</span>
            </div>
          ))}
          <div className="tyre-car" aria-hidden />
        </div>
        {!hasTyreFlags && <p className="muted small">Your car doesn’t send tyre-pressure warnings, so no colour is shown.</p>}
      </Card>

      <Card title={<><Gauge size={16} /> Driving</>}>
        <div className="grid stats">
          <Stat label="Odometer" value={s.odometerKm != null ? `${n(s.odometerKm, 1)} km` : "—"} />
          <Stat label="Avg consumption" value={s.avgFuelLPer100km != null ? `${n(s.avgFuelLPer100km, 2)} L/100km` : "—"} />
          <Stat label="Avg speed" value={s.avgSpeedKmh != null ? `${n(s.avgSpeedKmh)} km/h` : "—"} />
          <Stat label="Speed now" value={s.speedKmh != null ? `${n(s.speedKmh)} km/h` : "—"} />
          <Stat label="Engine" value={s.isEngineOn == null ? "—" : s.isEngineOn ? "Running" : "Off"} />
          <Stat label="Engine speed" value={s.engineRpm != null ? `${n(s.engineRpm)} rpm` : "—"} sub={s.engineRpm == null ? "Not valid right now" : undefined} />
          <Stat label="Coolant" value={s.coolantTempC != null ? `${n(s.coolantTempC)}°C` : "—"} sub={s.coolantTempC == null ? "Not valid right now" : undefined} />
          <Stat label="Parking brake" value={s.isParkingBrakeOn == null ? "—" : s.isParkingBrakeOn ? "On" : "Off"} />
        </div>
      </Card>

      <Card title="Doors" action={provider === "demo" ? <span className="muted small">Demo: tap a door to open it</span> : undefined}>
        <CarTopView status={s} onPartClick={provider === "demo" ? simulate : undefined} />
      </Card>

      <Card title="Windows">
        <ul className="kv">
          {Object.entries(s.windows ?? {}).map(([k, v]) => {
            const pos = s.windowPositions?.[k as Position];
            return (
              <li key={k}>
                <span>{label(k)}</span>
                <span>
                  {v}
                  {pos != null && pos > 0 ? ` · ${n(pos)}%` : ""} <Dot level={v === "open" ? "warn" : "good"} />
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      <details className="card raw">
        <summary>
          <span>All data from the car</span>
          <ChevronDown size={16} />
        </summary>
        <p className="muted small">Every field your car reported, as sent. Codes without a known meaning are shown raw.</p>
        <table>
          <tbody>
            {(status.raw ?? []).map(([k, v]) => (
              <tr key={k}>
                <th>{label(k)}</th>
                <td>{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <div className="legend">
        <Info size={14} />
        <ul>
          {Object.values(THRESHOLDS).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
