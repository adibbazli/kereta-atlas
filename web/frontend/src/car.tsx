import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, vinPath } from "./api";
import type { CommandDef, CommandResult, DataUsage, LiveState, Notice, StatusResponse, Timer, Trip, Vehicle, VehicleStatus } from "./types";

/**
 * Data is fetched once per car and then only when the user presses Refresh: no polling.
 * Trips, inbox and data plan load lazily the first time something asks for them.
 */
type Lazy<T> = { data?: T; loading: boolean; error?: string };

type Toast = { id: number; text: string; kind: "ok" | "error" | "info" };

type CarCtx = {
  provider: string;
  accountLabel?: string;
  commands: CommandDef[];
  vehicles: Vehicle[];
  vehicle: Vehicle;
  selectVehicle: (vin: string) => void;
  status?: StatusResponse;
  statusLoading: boolean;
  statusError?: string;
  /** Toggles whose last command was only queued, so the car's state is unknown until Refresh. */
  pending: Set<string>;
  refresh: () => void;
  refreshing: boolean;
  supports: (id: string) => boolean;
  needsPin: (id: string) => boolean;
  pin: string;
  setPin: (pin: string) => void;
  /** The PIN is kept in this browser's storage (per car) instead of only in this tab. */
  rememberPin: boolean;
  setRememberPin: (on: boolean) => void;
  forgetPin: () => void;
  send: (id: string, params?: Record<string, number>) => Promise<CommandResult | null>;
  busy: string | null;
  cancelTimer: (kind: Timer["kind"]) => Promise<void>;
  live?: LiveState;
  liveBlockedReason?: string;
  startLive: () => Promise<void>;
  stopLive: () => Promise<void>;
  /** Demo car only: open/close a door, the bonnet or the trunk. */
  simulate: (part: string) => Promise<void>;
  trips: Lazy<Trip[]>;
  loadTrips: () => void;
  notices: Lazy<Notice[]>;
  loadNotices: () => void;
  usage: Lazy<DataUsage>;
  loadUsage: () => void;
  toasts: Toast[];
  toast: (text: string, kind?: Toast["kind"]) => void;
  signOut: () => Promise<void>;
};

const Ctx = createContext<CarCtx | null>(null);
export const useCar = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCar outside CarProvider");
  return c;
};

// Saved PINs: localStorage, one entry per car, only when the user ticks "Remember on this device".
const pinKey = (vin: string) => `mk.pin.${vin}`;
function readPin(vin: string) {
  try {
    const v = localStorage.getItem(pinKey(vin)) ?? "";
    return /^\d{4,8}$/.test(v) ? v : "";
  } catch {
    return "";
  }
}
function writePin(vin: string, pin: string) {
  try {
    if (/^\d{4,8}$/.test(pin)) localStorage.setItem(pinKey(vin), pin);
    else localStorage.removeItem(pinKey(vin));
  } catch {
    // storage unavailable (private mode): the PIN stays in this tab only
  }
}

/** What a confirmed command did, applied locally instead of re-fetching. */
function applyCommand(s: VehicleStatus, id: string, params: Record<string, number>): VehicleStatus {
  const all = (v: "open" | "closed") => ({ frontLeft: v, frontRight: v, rearLeft: v, rearRight: v });
  switch (id) {
    case "lock":
      return { ...s, lock: "locked", isTrunkLocked: true };
    case "unlock":
      return { ...s, lock: "unlocked" };
    case "trunk_open":
      return { ...s, isTrunkLocked: false };
    case "trunk_lock":
      return { ...s, isTrunkLocked: true };
    case "windows_open":
      return { ...s, windows: { ...s.windows, ...all("open") } };
    case "windows_close":
      return { ...s, isVentilating: false, windows: { ...s.windows, ...all("closed") } };
    case "ventilate_on":
      return {
        ...s,
        isVentilating: true,
        windows: { ...s.windows, ...all("open") },
        windowPositions: { frontLeft: 8, frontRight: 8, rearLeft: 8, rearRight: 8 },
      };
    case "ventilate_off":
      return { ...s, isVentilating: false, windows: { ...s.windows, ...all("closed") }, windowPositions: { frontLeft: 0, frontRight: 0, rearLeft: 0, rearRight: 0 } };
    case "sunroof_close":
      return { ...s, windows: { ...s.windows, sunroof: "closed" } };
    case "climate_on":
      return { ...s, climate: { ...s.climate, isOn: true, targetTempC: params.temp ?? s.climate?.targetTempC } };
    case "climate_off":
      return { ...s, climate: { ...s.climate, isOn: false } };
    case "engine_start":
      return { ...s, isEngineOn: true };
    case "engine_stop":
      return { ...s, isEngineOn: false };
    default:
      return s;
  }
}

/** Which toggle a command belongs to (for the "pending" state). */
export const TOGGLE_OF: Record<string, string> = {
  lock: "lock",
  unlock: "lock",
  windows_open: "windows",
  windows_close: "windows",
  ventilate_on: "ventilate",
  ventilate_off: "ventilate",
  trunk_open: "trunk",
  trunk_lock: "trunk",
  climate_on: "climate",
  climate_off: "climate",
  engine_start: "engine",
  engine_stop: "engine",
};

export function CarProvider(props: {
  provider: string;
  accountLabel?: string;
  commands: CommandDef[];
  vehicles: Vehicle[];
  onSignedOut: () => void;
  children: ReactNode;
}) {
  const { vehicles } = props;
  const [vin, setVin] = useState(() => {
    const saved = (() => {
      try {
        return localStorage.getItem("mk.vin");
      } catch {
        return null;
      }
    })();
    return vehicles.find((v) => v.vin === saved)?.vin ?? vehicles[0].vin;
  });
  const vehicle = vehicles.find((v) => v.vin === vin) ?? vehicles[0];

  const [statusByVin, setStatusByVin] = useState<Record<string, StatusResponse>>({});
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string>();
  const [pendingByVin, setPendingByVin] = useState<Record<string, Set<string>>>({});
  const [tripsByVin, setTrips] = useState<Record<string, Lazy<Trip[]>>>({});
  const [usageByVin, setUsage] = useState<Record<string, Lazy<DataUsage>>>({});
  const [notices, setNotices] = useState<Lazy<Notice[]>>({ loading: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [pin, setPinState] = useState(() => readPin(vin));
  const [rememberPin, setRememberState] = useState(() => readPin(vin) !== "");
  // Switching cars loads that car's saved PIN (if any).
  useEffect(() => {
    const saved = readPin(vin);
    setPinState(saved);
    setRememberState(saved !== "");
  }, [vin]);
  const setPin = useCallback(
    (p: string) => {
      setPinState(p);
      if (rememberPin) writePin(vin, p);
    },
    [rememberPin, vin],
  );
  const setRememberPin = useCallback(
    (on: boolean) => {
      setRememberState(on);
      writePin(vin, on ? pin : "");
    },
    [vin, pin],
  );
  const forgetPin = useCallback(() => {
    setPinState("");
    setRememberState(false);
    writePin(vin, "");
  }, [vin]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [liveByVin, setLiveByVin] = useState<Record<string, LiveState>>({});
  const toastId = useRef(0);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const loadStatus = useCallback(
    async (target: string) => {
      setStatusLoading(true);
      setStatusError(undefined);
      try {
        const res = await api<StatusResponse>(vinPath(target, "/status"));
        setStatusByVin((m) => ({ ...m, [target]: res }));
        if (res.live) setLiveByVin((m) => ({ ...m, [target]: res.live! }));
        setPendingByVin((m) => ({ ...m, [target]: new Set() }));
      } catch (e) {
        setStatusError((e as Error).message);
      } finally {
        setStatusLoading(false);
      }
    },
    [],
  );

  // Once per car: on first view only.
  useEffect(() => {
    try {
      localStorage.setItem("mk.vin", vin);
    } catch {
      // storage unavailable: fine
    }
    if (!statusByVin[vin]) loadStatus(vin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vin]);

  const lazyLoad = useCallback(
    async <T,>(set: (fn: (m: Record<string, Lazy<T>>) => Record<string, Lazy<T>>) => void, target: string, path: string) => {
      set((m) => ({ ...m, [target]: { ...m[target], loading: true, error: undefined } }));
      try {
        const data = await api<T>(path);
        set((m) => ({ ...m, [target]: { data, loading: false } }));
      } catch (e) {
        set((m) => ({ ...m, [target]: { ...m[target], loading: false, error: (e as Error).message } }));
      }
    },
    [],
  );

  const loadTrips = useCallback(() => lazyLoad<Trip[]>(setTrips, vin, vinPath(vin, "/trips")), [lazyLoad, vin]);
  const loadUsage = useCallback(() => lazyLoad<DataUsage>(setUsage, vin, vinPath(vin, "/data-usage")), [lazyLoad, vin]);
  const loadNotices = useCallback(async () => {
    setNotices((n) => ({ ...n, loading: true, error: undefined }));
    try {
      setNotices({ data: await api<Notice[]>("/api/notices"), loading: false });
    } catch (e) {
      setNotices((n) => ({ ...n, loading: false, error: (e as Error).message }));
    }
  }, []);

  const refreshing = statusLoading || !!tripsByVin[vin]?.loading || !!usageByVin[vin]?.loading || notices.loading;
  const refresh = useCallback(() => {
    loadStatus(vin);
    // Only reload what has already been opened.
    if (tripsByVin[vin]?.data) loadTrips();
    if (usageByVin[vin]?.data !== undefined) loadUsage();
    if (notices.data) loadNotices();
  }, [loadStatus, vin, tripsByVin, usageByVin, notices.data, loadTrips, loadUsage, loadNotices]);

  const supports = useCallback(
    (id: string) => props.commands.some((c) => c.id === id) && (!vehicle.commands || vehicle.commands.includes(id)),
    [props.commands, vehicle.commands],
  );
  const needsPin = useCallback(
    (id: string) => !!vehicle.isPinRequired || !!props.commands.find((c) => c.id === id)?.isPinRequired,
    [props.commands, vehicle.isPinRequired],
  );

  const send = useCallback(
    async (id: string, params: Record<string, number> = {}) => {
      if (busy) return null;
      setBusy(id);
      const target = vin;
      try {
        const res = await api<CommandResult>(vinPath(target, "/commands"), {
          method: "POST",
          body: { command: id, params, pin: needsPin(id) ? pin : undefined },
        });
        const toggle = TOGGLE_OF[id];
        if (res.isOk && res.isConfirmed) {
          setStatusByVin((m) => {
            const cur = m[target];
            if (!cur) return m;
            let timers = cur.timers;
            if (res.timer) timers = [...timers.filter((t) => t.kind !== res.timer!.kind), res.timer];
            if (id === "engine_stop") timers = timers.filter((t) => t.kind !== "engine");
            if (id === "climate_off") timers = timers.filter((t) => t.kind !== "climate");
            return { ...m, [target]: { ...cur, status: applyCommand(cur.status, id, params), timers } };
          });
          if (toggle) setPendingByVin((m) => ({ ...m, [target]: new Set([...(m[target] ?? [])].filter((x) => x !== toggle)) }));
          toast(res.message === "Done" ? "Done" : res.message || "Done", "ok");
        } else if (res.isOk) {
          if (toggle) setPendingByVin((m) => ({ ...m, [target]: new Set([...(m[target] ?? []), toggle]) }));
          if (res.timer) {
            setStatusByVin((m) => {
              const cur = m[target];
              return cur ? { ...m, [target]: { ...cur, timers: [...cur.timers.filter((t) => t.kind !== res.timer!.kind), res.timer!] } } : m;
            });
          }
          toast("Sent to your car. No confirmation yet, so press Refresh to check.", "info");
        } else {
          if (needsPin(id) && /\bpin\b/i.test(res.message ?? "")) forgetPin();
          toast(res.message || "The car couldn’t do that", "error");
        }
        return res;
      } catch (e) {
        toast((e as Error).message, "error");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [busy, vin, pin, needsPin, toast, forgetPin],
  );

  const cancelTimer = useCallback(
    async (kind: Timer["kind"]) => {
      const target = vin;
      try {
        await api(vinPath(target, `/timers/${kind}/cancel`), { method: "POST" });
        setStatusByVin((m) => {
          const cur = m[target];
          return cur ? { ...m, [target]: { ...cur, timers: cur.timers.filter((t) => t.kind !== kind) } } : m;
        });
        toast("Auto-off cancelled");
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },
    [vin, toast],
  );

  const simulate = useCallback(
    async (part: string) => {
      const target = vin;
      try {
        const res = await api<StatusResponse>(vinPath(target, "/simulate"), { method: "POST", body: { part } });
        setStatusByVin((m) => ({ ...m, [target]: res }));
      } catch (e) {
        toast((e as Error).message, "error");
      }
    },
    [vin, toast],
  );

  // ----- live mode -----
  const live = liveByVin[vin];
  const volts = statusByVin[vin]?.status.batteryVoltage;
  const liveBlockedReason =
    volts == null ? "Your car doesn’t report its 12 V battery" : volts < 12.4 ? `Needs a green 12 V battery (now ${volts.toFixed(1)} V)` : undefined;

  const startLive = useCallback(async () => {
    const target = vin;
    try {
      const st = await api<LiveState>(vinPath(target, "/live/start"), { method: "POST" });
      setLiveByVin((m) => ({ ...m, [target]: st }));
      if (!st.active && st.reason) toast(st.reason, "error");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [vin, toast]);

  const stopLive = useCallback(async () => {
    const target = vin;
    try {
      setLiveByVin((m) => ({ ...m, [target]: { ...(m[target] ?? { mode: "unknown" }), active: false, phase: "off", reason: null } }));
      await api(vinPath(target, "/live/stop"), { method: "POST" });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }, [vin, toast]);

  // Heartbeat while live and this tab is visible. It only asks this server for the shared feed;
  // the server decides when to read Proton, and pauses when no tab is watching.
  const liveActive = !!live?.active;
  const latestFetched = useRef<number | null>(null);
  latestFetched.current = live?.fetchedAt ?? null;
  useEffect(() => {
    if (!liveActive) return;
    const target = vin;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        try {
          const since = latestFetched.current ?? 0;
          const res = await api<Partial<StatusResponse> & { live: LiveState }>(vinPath(target, `/live?since=${since}`));
          setLiveByVin((m) => ({ ...m, [target]: res.live }));
          if (res.status) {
            setStatusByVin((m) => ({ ...m, [target]: res as StatusResponse }));
            setPendingByVin((m) => ({ ...m, [target]: new Set() }));
          }
          if (!res.live.active && res.live.reason) toast(`Live mode stopped: ${res.live.reason}`, "info");
          if (!res.live.active) return;
        } catch {
          // transient; try again next tick
        }
      }
      timer = setTimeout(tick, 5000);
    };
    tick();
    const onVis = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [liveActive, vin, toast]);

  const signOut = useCallback(async () => {
    await api("/api/signout", { method: "POST" }).catch(() => {});
    props.onSignedOut();
  }, [props]);

  const value = useMemo<CarCtx>(
    () => ({
      provider: props.provider,
      accountLabel: props.accountLabel,
      commands: props.commands,
      vehicles,
      vehicle,
      selectVehicle: (v) => {
        setVin(v);
        setStatusError(undefined);
      },
      status: statusByVin[vin],
      statusLoading,
      statusError,
      pending: pendingByVin[vin] ?? new Set(),
      refresh,
      refreshing,
      supports,
      needsPin,
      pin,
      setPin,
      rememberPin,
      setRememberPin,
      forgetPin,
      send,
      busy,
      cancelTimer,
      live,
      liveBlockedReason,
      startLive,
      stopLive,
      simulate,
      trips: tripsByVin[vin] ?? { loading: false },
      loadTrips,
      notices,
      loadNotices,
      usage: usageByVin[vin] ?? { loading: false },
      loadUsage,
      toasts,
      toast,
      signOut,
    }),
    [props.provider, props.accountLabel, props.commands, vehicles, vehicle, statusByVin, vin, statusLoading, statusError, pendingByVin,
     refresh, refreshing, supports, needsPin, pin, rememberPin, setRememberPin, forgetPin, send, busy, cancelTimer, live, liveBlockedReason, startLive, stopLive, simulate, tripsByVin, loadTrips, notices, loadNotices, usageByVin,
     loadUsage, toasts, toast, signOut],
  );
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

/** Re-renders every `ms` so countdowns and "x min ago" stay current. Purely local: no requests. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
