export type Level = "good" | "warn" | "bad" | "none";

export const n = (v: number | null | undefined, digits = 0) =>
  v == null ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });

export function ago(ms?: number | null, now = Date.now()) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export const dateTime = (ms?: number | null) =>
  ms ? new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";

export function countdown(endsAt: number, now = Date.now()) {
  const s = Math.max(0, Math.round((endsAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const bytes = (b?: number | null) =>
  b == null ? "—" : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${Math.round(b / 1024 ** 2)} MB`;

export const label = (k: string) =>
  k
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bhood\b/i, "Bonnet");

// Colour cues. Thresholds are shown in the Health legend so derived colours aren't mistaken for car alarms.
export const THRESHOLDS = {
  fuel: "Fuel: green ≥ 30%, yellow 15–30%, red < 15%",
  service: "Service: green > 1,000 km, yellow ≤ 1,000 km, red overdue",
  battery: "12 V battery (resting): green ≥ 12.4 V, yellow 12.0–12.4 V, red < 12.0 V",
  tyres: "Tyres: red only when the car raises a pressure warning",
};

export const fuelLevel = (pct?: number | null): Level => (pct == null ? "none" : pct >= 30 ? "good" : pct >= 15 ? "warn" : "bad");
export const serviceLevel = (km?: number | null, days?: number | null): Level => {
  if (km == null && days == null) return "none";
  if ((km != null && km < 0) || (days != null && days < 0)) return "bad";
  if ((km != null && km <= 1000) || (days != null && days <= 30)) return "warn";
  return "good";
};
export const batteryLevel = (v?: number | null): Level => (v == null ? "none" : v >= 12.4 ? "good" : v >= 12.0 ? "warn" : "bad");
export const percentLevel = (pct?: number | null): Level => fuelLevel(pct);

export function fuelPercent(litres?: number | null, tank?: number | null, reported?: number | null) {
  if (reported != null) return { pct: reported, estimated: false };
  if (litres != null && tank) return { pct: Math.min(100, (litres / tank) * 100), estimated: true };
  return { pct: null, estimated: false };
}
