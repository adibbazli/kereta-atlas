import { ArrowLeft, ExternalLink, MapPin, Route } from "lucide-react";
import { useEffect, useState } from "react";

import { api, vinPath } from "../api";
import { useCar } from "../car";
import { MapView } from "../components/MapView";
import { Card, Empty, Spinner, Stat } from "../components/ui";
import { ago, dateTime, n } from "../format";
import type { Location as Loc, Trip } from "../types";

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

      <Card title={<><Route size={16} /> Trips · last 30 days</>}>
        {trips.loading && !trips.data ? (
          <Spinner />
        ) : trips.error ? (
          <p className="error">{trips.error}</p>
        ) : !trips.data?.length ? (
          <Empty>No trips in the last 30 days.</Empty>
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
