import { isoDate, rangeMs } from "./format";
import type { FuelPrices, Trip, TripRange } from "./types";

/** Average used to estimate refuel trips. The car's own figure first, else the measured trips in range. */
export type FuelBasis = { lPer100km: number; source: "car" | "range" };
const plausible = (v?: number | null) => v != null && v >= 3 && v <= 30;

function measuredAvg(trips: Trip[]) {
  let litres = 0, km = 0;
  for (const t of trips) if (t.fuelUsedL != null && t.distanceKm) { litres += t.fuelUsedL; km += t.distanceKm; }
  return km > 0 ? (litres / km) * 100 : null;
}

export function fuelBasis(carAvg: number | null | undefined, trips: Trip[] | undefined): FuelBasis | null {
  if (plausible(carAvg)) return { lPer100km: carAvg!, source: "car" };
  const r = trips ? measuredAvg(trips) : null;
  return plausible(r) ? { lPer100km: r!, source: "range" } : null;
}

/**
 * Fuel to show for a trip. A refuel during the trip ruins the car's reading ("refuel", "low"), so those
 * trips are estimated as distance × average consumption. A "high" reading is a glitch, not a refuel: left empty.
 */
export function tripFuel(t: Trip, basis: FuelBasis | null) {
  if (t.fuelUsedL != null) return { litres: t.fuelUsedL, lPer100km: t.fuelLPer100km ?? null, estimated: false };
  if ((t.fuelFlag === "refuel" || t.fuelFlag === "low") && basis && t.distanceKm)
    return { litres: (t.distanceKm * basis.lPer100km) / 100, lPer100km: basis.lPer100km, estimated: true };
  return null;
}

type Week = FuelPrices["weeks"][number];

/**
 * The pump price on a day: the latest weekly row on or before it. BUDI95 when it existed (from 30 Sep 2025);
 * before that, the RON95 price, which was the subsidised pump price then. Null before the data starts.
 */
export function priceOn(weeks: Week[], day: string): { week: Week; price: number; budi95: boolean } | null {
  let lo = 0, hi = weeks.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (weeks[mid].date <= day) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (at < 0) return null;
  const week = weeks[at];
  if (week.budi95 != null) return { week, price: week.budi95, budi95: true };
  if (week.ron95 != null) return { week, price: week.ron95, budi95: false };
  return null;
}

export type MonthCost = {
  /** YYYY-MM */
  month: string;
  litres: number;
  cost: number;
  /** Same litres at the unsubsidised RON95 price that week. */
  costRon95: number;
  trips: number;
  estimatedTrips: number;
  /** Trips with fuel but no price for their date. */
  unpriced: number;
  /** Share of the month the selected range covers so far (0–1). Below 1 the month is scaled up. */
  coverage: number;
  /** Cost scaled to the whole month when only part of it is covered; equals cost otherwise. */
  projected: number;
  /** Covered days start/end (local YYYY-MM-DD). */
  from: string;
  to: string;
  daysInMonth: number;
};

const DAY = 86_400_000;

/** Fuel cost per calendar month for the trips in range, newest month first. */
export function monthlyCost(trips: Trip[], range: TripRange, basis: FuelBasis | null, weeks: Week[], now = Date.now()): MonthCost[] {
  const { start, end } = rangeMs(range, now);
  const months = new Map<string, MonthCost>();

  const monthOf = (ms: number) => isoDate(new Date(ms)).slice(0, 7);
  // Every month the range touches gets a row, even with no trips (it really cost RM 0).
  for (let d = new Date(start); d.getTime() <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const y = d.getFullYear(), m = d.getMonth();
    const first = new Date(y, m, 1).getTime();
    const next = new Date(y, m + 1, 1).getTime();
    const from = Math.max(first, start), to = Math.min(next - 1, end);
    const daysInMonth = Math.round((next - first) / DAY);
    months.set(monthOf(first), {
      month: monthOf(first), litres: 0, cost: 0, costRon95: 0, trips: 0, estimatedTrips: 0, unpriced: 0,
      coverage: Math.min(1, (to - from + 1) / (next - first)),
      projected: 0, from: isoDate(new Date(from)), to: isoDate(new Date(to)), daysInMonth,
    });
  }

  for (const t of trips) {
    const row = months.get(monthOf(t.startedAt));
    const f = tripFuel(t, basis);
    if (!row || !f) continue;
    const p = priceOn(weeks, isoDate(new Date(t.startedAt)));
    row.trips++;
    if (f.estimated) row.estimatedTrips++;
    if (!p) { row.unpriced++; continue; }
    row.litres += f.litres;
    row.cost += f.litres * p.price;
    row.costRon95 += f.litres * (p.week.ron95 ?? p.price);
  }
  for (const r of months.values()) r.projected = r.coverage > 0 ? r.cost / r.coverage : r.cost;
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month));
}
