import type { Trip } from "@/core/types";

/** "34 min", "1 h 12 min". */
export function formatDuration(min?: number) {
  if (min == null || !Number.isFinite(min)) return undefined;
  const total = Math.round(min);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const formatTime = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "Today", "Yesterday", or "Mon, 21 Sep". */
export function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** A session is every trip that starts less than this long after the previous one: a 3 h stop is the same outing, 6 h starts a new session. */
export const SESSION_GAP_MS = 6 * 3_600_000;

export type TripSession = {
  key: string;
  startedAt: number;
  endedAt?: number;
  /** Oldest first, in the order they were driven. */
  trips: Trip[];
  km: number;
  /** Engine-on time across the trips, not the wall-clock span. */
  minutes: number;
};

/** Groups trips (one per engine on/off cycle, as the car reports them) into sessions. Newest session first. */
export function groupBySession(trips: Trip[], gapMs = SESSION_GAP_MS): TripSession[] {
  const sessions: TripSession[] = [];
  for (const t of [...trips].sort((a, b) => a.startedAt - b.startedAt)) {
    let s = sessions.at(-1);
    if (!s || t.startedAt - s.trips[s.trips.length - 1].startedAt >= gapMs)
      sessions.push((s = { key: t.id, startedAt: t.startedAt, trips: [], km: 0, minutes: 0 }));
    s.trips.push(t);
    s.km += t.distanceKm ?? 0;
    s.minutes += t.durationMin ?? 0;
    const end = t.endedAt ?? (t.durationMin != null ? t.startedAt + t.durationMin * 60_000 : undefined);
    if (end != null) s.endedAt = Math.max(s.endedAt ?? 0, end);
  }
  return sessions.reverse();
}
