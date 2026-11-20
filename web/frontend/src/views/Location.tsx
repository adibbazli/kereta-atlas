import { ArrowLeft, CalendarRange, ExternalLink, Fuel, MapPin, Route } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api, vinPath } from "../api";
import { useCar } from "../car";
import { MapView } from "../components/MapView";
import { Card, Empty, Segmented, Spinner, Stat } from "../components/ui";
import { ago, dateTime, isoDate, n, rangeDays, shortDate } from "../format";
import type { Location as Loc, Trip, TripRange } from "../types";

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
  if (trip) return <TripDetail trip={trip} onBack={() => setTrip(null)} />;
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

      {trips.data && <Summary trips={trips.data} />}

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
                    {t.fuelUsedL != null && <> · {n(t.fuelUsedL, 1)} L</>}
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

function TripDetail({ trip, onBack }: { trip: Trip; onBack: () => void }) {
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
        <Stat label="Fuel used" value={`${n(trip.fuelUsedL, 2)} L`} />
        <Stat label="Avg consumption" value={`${n(trip.fuelLPer100km, 1)} L/100 km`} />
      </div>
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

/** Totals for the trips in range. Average consumption only counts trips that reported fuel, so missing data doesn't drag it down. */
function Summary({ trips }: { trips: Trip[] }) {
  const s = useMemo(() => {
    let km = 0, fuelKm = 0, litres = 0, withFuel = 0, mins = 0;
    for (const t of trips) {
      km += t.distanceKm ?? 0;
      mins += t.durationMin ?? 0;
      if (t.fuelUsedL != null) {
        litres += t.fuelUsedL;
        withFuel++;
        fuelKm += t.distanceKm ?? 0;
      }
    }
    return { km, litres, withFuel, mins, avg: withFuel && fuelKm > 0 ? (litres / fuelKm) * 100 : null };
  }, [trips]);
  if (!trips.length) return null;
  const partial = s.withFuel > 0 && s.withFuel < trips.length;

  return (
    <Card title={<><Fuel size={16} /> Fuel · this range</>}>
      <div className="grid stats">
        <Stat
          label="Avg consumption"
          value={s.avg != null ? `${n(s.avg, 1)} L/100 km` : "—"}
          sub={s.avg != null ? (partial ? `From ${s.withFuel} of ${trips.length} trips` : `${n(s.avg ? 100 / s.avg : null, 1)} km/L`) : "No fuel data for these trips"}
        />
        <Stat label="Fuel used" value={s.withFuel ? `${n(s.litres, 1)} L` : "—"} sub={partial ? `${trips.length - s.withFuel} trips without fuel data` : undefined} />
        <Stat label="Distance" value={`${n(s.km, 1)} km`} sub={`${trips.length} ${trips.length === 1 ? "trip" : "trips"}`} />
        <Stat label="Time driving" value={s.mins >= 60 ? `${Math.floor(s.mins / 60)} h ${Math.round(s.mins % 60)} min` : `${n(s.mins)} min`} />
      </div>
    </Card>
  );
}
