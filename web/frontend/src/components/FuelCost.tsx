import { Banknote } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api } from "../api";
import { isoDate, n } from "../format";
import { monthlyCost, priceOn, type FuelBasis, type MonthCost } from "../fuel";
import type { FuelPrices, Trip, TripRange } from "../types";
import { Card, Spinner } from "./ui";

/** Months covered for fewer days than this aren't projected: a weekend's driving says little about a month. */
const MIN_DAYS_TO_PROJECT = 7;

// The price list changes weekly; one fetch per page load is plenty.
let cached: Promise<FuelPrices> | null = null;
const loadPrices = () => (cached ??= api<FuelPrices>("/api/fuel-prices").catch((e) => ((cached = null), Promise.reject(e))));

const rm = (v: number) => `RM ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthName = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};
const dayMonth = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

export function FuelCost({ trips, range, basis }: { trips: Trip[]; range: TripRange; basis: FuelBasis | null }) {
  const [prices, setPrices] = useState<FuelPrices>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    loadPrices().then(setPrices, (e) => setError((e as Error).message));
  }, []);

  const months = useMemo(() => (prices ? monthlyCost(trips, range, basis, prices.weeks) : []), [prices, trips, range, basis]);
  const today = prices ? priceOn(prices.weeks, isoDate(new Date())) : null;

  const total = months.reduce(
    (a, m) => ({ cost: a.cost + m.cost, ron95: a.ron95 + m.costRon95, litres: a.litres + m.litres, est: a.est + m.estimatedTrips, unpriced: a.unpriced + m.unpriced }),
    { cost: 0, ron95: 0, litres: 0, est: 0, unpriced: 0 },
  );

  return (
    <Card title={<><Banknote size={16} /> Fuel cost · BUDI95</>}>
      {error ? (
        <p className="error">{error}</p>
      ) : !prices ? (
        <Spinner />
      ) : (
        <div className="stack-sm">
          {today && (
            <p className="muted small">
              This week: {today.budi95 ? <>BUDI95 <b>{rm(today.price)}/L</b></> : <>RON95 <b>{rm(today.price)}/L</b></>}
              {today.budi95 && today.week.ron95 != null && <> · unsubsidised RON95 {rm(today.week.ron95)}/L</>}
            </p>
          )}

          <div className="cost-table" role="table" aria-label="Fuel cost by month">
            {months.map((m) => (
              <MonthRow key={m.month} m={m} />
            ))}
            {months.length > 1 && (
              <div className="cost-row total" role="row">
                <span role="cell">Selected range</span>
                <span role="cell" className="muted">{total.est ? "≈ " : ""}{n(total.litres, 1)} L</span>
                <span role="cell" className="cost">{total.est ? "≈ " : ""}{rm(total.cost)}</span>
              </div>
            )}
          </div>

          {total.ron95 > total.cost + 0.005 && (
            <p className="small">
              At the unsubsidised RON95 price this would have been {rm(total.ron95)}, so BUDI95 saved you about <b>{rm(total.ron95 - total.cost)}</b>.
            </p>
          )}
          {total.unpriced > 0 && <p className="warn-text small">{total.unpriced} trips are older than the price data and aren’t costed.</p>}
          <p className="muted small">
            Cost is each trip’s litres × the pump price for that week, from data.gov.my’s weekly fuel prices. Trips before
            BUDI95 started (30 Sep 2025) use the RON95 price at the time. “≈” means the figure includes refuel trips with
            estimated fuel. BUDI95’s monthly litre quota isn’t applied.
            {prices.stale && " The price list couldn’t be refreshed just now, so the last downloaded copy is shown."}
          </p>
        </div>
      )}
    </Card>
  );
}

function MonthRow({ m }: { m: MonthCost }) {
  const partial = m.coverage < 1;
  const coveredDays = Math.round(m.coverage * m.daysInMonth);
  const canProject = partial && coveredDays >= MIN_DAYS_TO_PROJECT && m.cost > 0;
  const approx = m.estimatedTrips ? "≈ " : "";
  return (
    <div className="cost-row" role="row">
      <span role="cell">
        {monthName(m.month)}
        {partial && (
          <small className="muted">
            {dayMonth(m.from)}–{dayMonth(m.to)} ({coveredDays} of {m.daysInMonth} days)
          </small>
        )}
      </span>
      <span role="cell" className="muted">
        {approx}
        {n(m.litres, 1)} L
        <small>{m.trips} {m.trips === 1 ? "trip" : "trips"}</small>
      </span>
      <span role="cell" className="cost">
        {approx}
        {rm(m.cost)}
        {canProject && <small className="muted">≈ {rm(m.projected)} for the month</small>}
        {partial && !canProject && m.cost > 0 && <small className="muted">too few days to project</small>}
      </span>
    </div>
  );
}
