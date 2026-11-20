import { ArrowLeft, CalendarRange, ExternalLink, Fuel, MapPin, Route } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api, vinPath } from "../api";
import { useCar } from "../car";
import { MapView } from "../components/MapView";
import { Card, Empty, Segmented, Spinner, Stat } from "../components/ui";
import { ago, dateTime, isoDate, n, rangeDays, shortDate } from "../format";
import type { Location as Loc, Trip, TripRange } from "../types";

/** Readings the server set aside (see web/proton/mappers.py check_trip_fuel). "missing" is just no data. */
const FUEL_FLAG: Record<"refuel" | "low" | "high", { tag: string; why: string }> = {
  refuel: {
    tag: "refuelled",
    why: "The car reported a negative amount, which happens when you refuel with the engine running. It measures fuel as tank level at the start minus tank level at the end.",
  },
  low: {
    tag: "fuel reading too low",
    why: "The car reported less fuel than this distance could use. That usually means a top-up during the trip cancelled out part of what was burnt.",
  },
  high: {
    tag: "fuel reading too high",
    why: "The car reported more fuel than this distance and time could use, so the reading is likely a sensor glitch.",
  },
};
const fuelFlag = (t: Trip) => (t.fuelFlag && t.fuelFlag !== "missing" ? FUEL_FLAG[t.fuelFlag] : null);

/** Average used to estimate refuel trips. The car's own figure first, else the measured trips in range. */
type FuelBasis = { lPer100km: number; source: "car" | "range" };
const plausible = (v?: number | null) => v != null && v >= 3 && v <= 30;

function measuredAvg(trips: Trip[]) {
  let litres = 0, km = 0;
  for (const t of trips) if (t.fuelUsedL != null && t.distanceKm) { litres += t.fuelUsedL; km += t.distanceKm; }
  return km > 0 ? (litres / km) * 100 : null;
}

function fuelBasis(carAvg: number | null | undefined, trips: Trip[] | undefined): FuelBasis | null {
  if (plausible(carAvg)) return { lPer100km: carAvg!, source: "car" };
  const r = trips ? measuredAvg(trips) : null;
  return plausible(r) ? { lPer100km: r!, source: "range" } : null;
}

const basisLabel = (b: FuelBasis) =>
  `${n(b.lPer100km, 1)} L/100 km (${b.source === "car" ? "the car’s average" : "this range’s measured average"})`;

/**
 * Fuel to show for a trip. A refuel during the trip ruins the car's reading ("refuel", "low"), so those
 * trips are estimated as distance × average consumption. A "high" reading is a glitch, not a refuel: left empty.
 */
function tripFuel(t: Trip, basis: FuelBasis | null) {
  if (t.fuelUsedL != null) return { litres: t.fuelUsedL, lPer100km: t.fuelLPer100km ?? null, estimated: false };
  if ((t.fuelFlag === "refuel" || t.fuelFlag === "low") && basis && t.distanceKm)
    return { litres: (t.distanceKm * basis.lPer100km) / 100, lPer100km: basis.lPer100km, estimated: true };
  return null;
}

const PRESETS: { value: TripRange["preset"]; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "custom", label: "Custom" },
];
const MAX_DAYS = 366;

export function Location() {
  const { status, trips, loadTrips } = useCar();
  const [trip, setTrip] = useState<Trip | null>(null);
  useEffect(() => {
    if (!trips.data && !trips.loading && !trips.error) loadTrips();
  }, [trips, loadTrips]);
  if (!status) return null;
  const basis = fuelBasis(status?.status.avgFuelLPer100km, trips.data);
  if (trip) return <TripDetail trip={trip} basis={basis} onBack={() => setTrip(null)} />;
  const loc = status.location;

  return (
    <div className="stack">
      <Card title={<><MapPin size={16} /> Parked at</>}>
        {loc ? (
          <div className="stack-sm">
            <div className="coords">
              {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
            </div>
            <p className="muted small">Position from {ago(loc.updatedAt)} · {dateTime(loc.updatedAt)}</p>
            <MapView points={[loc]} />
            <div className="row">
              <a className="btn" href={`https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`} target="_blank" rel="noopener noreferrer">
                Google Maps <ExternalLink size={14} />
              </a>
              <a className="btn" href={`https://maps.apple.com/?ll=${loc.latitude},${loc.longitude}&q=Car`} target="_blank" rel="noopener noreferrer">
                Apple Maps <ExternalLink size={14} />
              </a>
            </div>
            <p className="muted small">The map loads tiles from OpenStreetMap, and the buttons share the car’s coordinates with that map service.</p>
          </div>
        ) : (
          <Empty>No position fix from the car.</Empty>
        )}
      </Card>

      <RangePicker range={trips.range} onChange={loadTrips} />

      {trips.data && <Summary trips={trips.data} basis={basis} />}

      <Card title={<><Route size={16} /> Trips · {rangeLabel(trips.range)}</>}>
        {trips.loading && !trips.data ? (
          <Spinner />
        ) : trips.error ? (
          <p className="error">{trips.error}</p>
        ) : !trips.data?.length ? (
          <Empty>No trips in this range.</Empty>
        ) : (
          <ul className="list">
            {trips.data.map((t) => (
              <li key={t.id}>
                <button className="list-row" onClick={() => setTrip(t)}>
                  <span>{dateTime(t.startedAt)}</span>
                  <span className="muted">
                    {n(t.distanceKm, 1)} km · {n(t.durationMin)} min
                    <TripFuelText trip={t} basis={basis} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function TripFuelText({ trip, basis }: { trip: Trip; basis: FuelBasis | null }) {
  const f = tripFuel(trip, basis);
  const flag = fuelFlag(trip);
  return (
    <>
      {f && <> · {f.estimated ? "≈ " : ""}{n(f.litres, 1)} L</>}
      {flag && <> · <span className="warn-text">{flag.tag}</span></>}
    </>
  );
}

function TripDetail({ trip, basis, onBack }: { trip: Trip; basis: FuelBasis | null; onBack: () => void }) {
  const { vehicle } = useCar();
  const [points, setPoints] = useState<Loc[] | null>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const end = trip.endedAt ?? (trip.durationMin != null ? trip.startedAt + trip.durationMin * 60_000 : null);
    if (!end) return setPoints([]);
    api<Loc[]>(vinPath(vehicle.vin, `/track?start=${Math.round(trip.startedAt)}&end=${Math.round(end)}`))
      .then(setPoints)
      .catch((e) => setError((e as Error).message));
  }, [trip, vehicle.vin]);
  const fuel = tripFuel(trip, basis);
  const flag = fuelFlag(trip);

  return (
    <div className="stack">
      <button className="link" onClick={onBack}>
        <ArrowLeft size={16} /> Trips
      </button>
      <h2 className="title">{dateTime(trip.startedAt)}</h2>
      <div className="grid stats">
        <Stat label="Distance" value={`${n(trip.distanceKm, 1)} km`} />
        <Stat label="Duration" value={`${n(trip.durationMin)} min`} />
        <Stat label="Avg speed" value={`${n(trip.avgSpeedKmh)} km/h`} />
        <Stat
          label="Fuel used"
          value={fuel ? `${fuel.estimated ? "≈ " : ""}${n(fuel.litres, 2)} L` : "— L"}
          sub={flag ? `${fuel?.estimated ? "Estimated · " : ""}car reported ${n(trip.fuelReportedL, 2)} L` : undefined}
        />
        <Stat label="Avg consumption" value={fuel?.lPer100km != null ? `${fuel.estimated ? "≈ " : ""}${n(fuel.lPer100km, 1)} L/100 km` : "—"} />
      </div>
      {flag && (
        <p className="note warn-text small">
          {flag.why}{" "}
          {fuel?.estimated
            ? `Fuel used is estimated from the distance at ${basisLabel(basis!)}.`
            : trip.fuelFlag === "high"
              ? "It’s left out of the range totals."
              : "There’s no average consumption to estimate from yet, so it’s left out of the range totals."}
        </p>
      )}
      <Card>{error ? <p className="error">{error}</p> : !points ? <Spinner /> : points.length > 1 ? <MapView points={points} route /> : <Empty>No route for this trip.</Empty>}</Card>
    </div>
  );
}

function rangeLabel(r: TripRange) {
  if (r.preset !== "custom") return `last ${r.preset} days`;
  return r.from === r.to ? shortDate(r.from) : `${shortDate(r.from)} – ${shortDate(r.to)}`;
}

function RangePicker({ range, onChange }: { range: TripRange; onChange: (r: TripRange) => void }) {
  const today = isoDate(new Date());
  // Custom dates are edited here and applied together, so half-typed ranges don't trigger loads.
  const [draft, setDraft] = useState(() => rangeDays(range));
  useEffect(() => setDraft(rangeDays(range)), [range]);
  const [custom, setCustom] = useState(range.preset === "custom");

  const days = draft.from && draft.to ? Math.round((Date.parse(draft.to) - Date.parse(draft.from)) / 86_400_000) + 1 : 0;
  const problem = !draft.from || !draft.to
    ? "Pick both dates."
    : draft.from > draft.to
      ? "The start date is after the end date."
      : draft.to > today
        ? "The end date is in the future."
        : days > MAX_DAYS
          ? `Pick ${MAX_DAYS} days or fewer.`
          : null;
  const unchanged = range.preset === "custom" && draft.from === range.from && draft.to === range.to;

  return (
    <Card title={<><CalendarRange size={16} /> Date range</>}>
      <div className="stack-sm">
        <Segmented
          ariaLabel="Date range"
          value={custom ? "custom" : range.preset}
          options={PRESETS}
          onChange={(p) => {
            if (p === "custom") return setCustom(true);
            setCustom(false);
            onChange({ preset: p, from: "", to: "" });
          }}
        />
        {custom && (
          <form
            className="range-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!problem) onChange({ preset: "custom", ...draft });
            }}
          >
            <label className="field">
              <span>From</span>
              <input type="date" value={draft.from} max={draft.to || today} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
            </label>
            <label className="field">
              <span>To</span>
              <input type="date" value={draft.to} min={draft.from} max={today} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
            </label>
            <button className="btn primary" type="submit" disabled={!!problem || unchanged}>
              Apply
            </button>
            {problem && <p className="error small range-note">{problem}</p>}
          </form>
        )}
      </div>
    </Card>
  );
}

/**
 * Totals for the trips in range. Fuel used includes refuel trips at their estimate. Average consumption counts
 * measured trips only: estimates come from an average, so folding them back in would just pull it toward itself.
 */
function Summary({ trips, basis }: { trips: Trip[]; basis: FuelBasis | null }) {
  const s = useMemo(() => {
    let km = 0, fuelKm = 0, measured = 0, withFuel = 0, mins = 0, estimatedL = 0, estimatedN = 0;
    for (const t of trips) {
      km += t.distanceKm ?? 0;
      mins += t.durationMin ?? 0;
      const f = tripFuel(t, basis);
      if (!f) continue;
      if (f.estimated) {
        estimatedL += f.litres;
        estimatedN++;
      } else {
        measured += f.litres;
        withFuel++;
        fuelKm += t.distanceKm ?? 0;
      }
    }
    return { km, measured, withFuel, mins, estimatedL, estimatedN, avg: withFuel && fuelKm > 0 ? (measured / fuelKm) * 100 : null };
  }, [trips, basis]);
  if (!trips.length) return null;
  const partial = s.withFuel > 0 && s.withFuel < trips.length;
  const uncounted = trips.length - s.withFuel - s.estimatedN;
  const fuelSub = [
    s.estimatedN > 0 && `Incl. ≈ ${n(s.estimatedL, 1)} L estimated for ${s.estimatedN} refuel ${s.estimatedN === 1 ? "trip" : "trips"}`,
    uncounted > 0 && `${uncounted} ${uncounted === 1 ? "trip" : "trips"} not counted (no usable reading)`,
  ].filter(Boolean).join(" · ");

  return (
    <Card title={<><Fuel size={16} /> Fuel · this range</>}>
      <div className="grid stats">
        <Stat
          label="Avg consumption"
          value={s.avg != null ? `${n(s.avg, 1)} L/100 km` : "—"}
          sub={s.avg != null ? (partial ? `From ${s.withFuel} of ${trips.length} trips` : `${n(s.avg ? 100 / s.avg : null, 1)} km/L`) : "No fuel data for these trips"}
        />
        <Stat
          label="Fuel used"
          value={s.withFuel || s.estimatedN ? `${s.estimatedN ? "≈ " : ""}${n(s.measured + s.estimatedL, 1)} L` : "—"}
          sub={fuelSub || undefined}
        />
        <Stat label="Distance" value={`${n(s.km, 1)} km`} sub={`${trips.length} ${trips.length === 1 ? "trip" : "trips"}`} />
        <Stat label="Time driving" value={s.mins >= 60 ? `${Math.floor(s.mins / 60)} h ${Math.round(s.mins % 60)} min` : `${n(s.mins)} min`} />
      </div>
    </Card>
  );
}
