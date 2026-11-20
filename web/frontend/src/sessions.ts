import type { Trip } from "./types";

/** A session is every trip that starts less than this long after the previous one: a 3 h stop is the same outing, 6 h starts a new session. */
export const SESSION_GAP_MS = 6 * 3_600_000;

export type TripSession = {
  key: string;
  startedAt: number;
  endedAt: number | null;
  /** Oldest first, in the order they were driven. */
  trips: Trip[];
  km: number;
  /** Engine-on time across the trips, not the wall-clock span. */
  minutes: number;
};

/** Groups trips (one per engine on/off cycle, as the car reports them) into sessions. Newest session first. */
export function groupBySession(trips: Trip[], gapMs = SESSION_GAP_MS): TripSession[] {
  const groups: Trip[][] = [];
  for (const t of [...trips].sort((a, b) => a.startedAt - b.startedAt)) {
    const g = groups.at(-1);
    if (g && t.startedAt - g[g.length - 1].startedAt < gapMs) g.push(t);
    else groups.push([t]);
  }
  return groups.map(build).reverse();
}

/** Totals for one session's trips, oldest first. */
function build(trips: Trip[]): TripSession {
  const s: TripSession = { key: trips[0]?.id ?? "", startedAt: trips[0]?.startedAt ?? 0, endedAt: null, trips, km: 0, minutes: 0 };
  for (const t of trips) {
    if (!t) continue;
    s.km += t.distanceKm ?? 0;
    s.minutes += t.durationMin ?? 0;
    const end = t.endedAt ?? (t.durationMin != null ? t.startedAt + t.durationMin * 60_000 : null);
    if (end != null) s.endedAt = Math.max(s.endedAt ?? 0, end);
  }
  return s;
}

/**
 * Sessions are saved in localStorage, one entry per car, as groups of trip ids. On the next page load the saved
 * grouping is reused as long as the trip list is the same; only a changed list is grouped again.
 */
const storeKey = (vin: string) => `mk.sessions.${vin}`;
type Stored = { v: 1; gap: number; ids: string; groups: string[][] };

export function cachedSessions(vin: string, trips: Trip[]): TripSession[] {
  const ids = trips.map((t) => t.id).join(",");
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey(vin)) ?? "null") as Stored | null;
    if (saved?.v === 1 && saved.gap === SESSION_GAP_MS && saved.ids === ids) {
      const byId = new Map(trips.map((t) => [t.id, t]));
      const sessions = saved.groups.map((g) => build(g.map((id) => byId.get(id)!)));
      if (sessions.every((s) => s.trips.every(Boolean))) return sessions;
    }
  } catch {
    // Unreadable or blocked storage: fall through and group again.
  }
  const sessions = groupBySession(trips);
  try {
    const stored: Stored = { v: 1, gap: SESSION_GAP_MS, ids, groups: sessions.map((s) => s.trips.map((t) => t.id)) };
    localStorage.setItem(storeKey(vin), JSON.stringify(stored));
  } catch {
    // Storage full or blocked: the sessions still show, they just aren't kept.
  }
  return sessions;
}
