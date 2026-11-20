import { Bell, Car, Fan, Gamepad2, HeartPulse, LayoutGrid, LogOut, MapPin, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { api, setGateHandler, setSignedOutHandler } from "./api";
import { CarProvider, useCar, useNow } from "./car";
import { Inbox } from "./components/Inbox";
import { LiveToggle } from "./components/LiveToggle";
import { Spinner } from "./components/ui";
import { ago } from "./format";
import type { Me, Vehicle } from "./types";
import { Climate } from "./views/Climate";
import { Controls } from "./views/Controls";
import { Health } from "./views/Health";
import { Location } from "./views/Location";
import { Overview } from "./views/Overview";
import { QuickAction } from "./views/QuickAction";
import { Gate } from "./views/Gate";
import { SignIn } from "./views/SignIn";

export type Tab = "overview" | "controls" | "climate" | "health" | "location";
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <LayoutGrid size={20} /> },
  { id: "controls", label: "Controls", icon: <Gamepad2 size={20} /> },
  { id: "climate", label: "Climate", icon: <Fan size={20} /> },
  { id: "health", label: "Health", icon: <HeartPulse size={20} /> },
  { id: "location", label: "Location", icon: <MapPin size={20} /> },
];

/** "#/do/unlock" -> "unlock": a deep link that opens the hold-to-send page for one command. */
const actionFromHash = () => /^#\/do\/([a-z_]+)$/.exec(location.hash)?.[1] ?? null;

const tabFromHash = (): Tab => {
  const h = location.hash.replace(/^#\/?/, "") as Tab;
  return TABS.some((t) => t.id === h) ? h : "overview";
};

function SignedInApp() {
  const [me, setMe] = useState<Me | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[] | null>(null);
  const [error, setError] = useState<string>();
  const [gated, setGated] = useState(false);
  const [signedOutNotice, setSignedOutNotice] = useState<string>();

  const boot = useCallback(async () => {
    setError(undefined);
    setGated(false);
    try {
      const m = await api<Me>("/api/me");
      setMe(m);
      if (m.signedIn) setVehicles(await api<Vehicle[]>("/api/vehicles"));
    } catch (e) {
      if (!(e as { status?: number }).status || (e as { status?: number }).status !== 401) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    setGateHandler(() => {
      setGated(true);
      setMe(null);
      setVehicles(null);
    });
    setSignedOutHandler((reason) => {
      setSignedOutNotice(reason);
      setMe({ signedIn: false });
      setVehicles(null);
    });
    boot();
  }, [boot]);

  if (gated) return <Gate onPassed={boot} />;
  if (error)
    return (
      <div className="center-screen">
        <p className="error">{error}</p>
        <button className="btn" onClick={boot}>
          Try again
        </button>
      </div>
    );
  if (!me) return <div className="center-screen"><Spinner /></div>;
  if (!me.signedIn)
    return (
      <SignIn
        notice={signedOutNotice}
        onSignedIn={() => {
          setSignedOutNotice(undefined);
          boot();
        }}
      />
    );
  if (!vehicles) return <div className="center-screen"><Spinner /></div>;
  if (!vehicles.length) return <div className="center-screen"><p>No vehicles on this account.</p></div>;

  return (
    <CarProvider
      provider={me.provider}
      accountLabel={me.accountLabel}
      commands={me.commands}
      vehicles={vehicles}
      onSignedOut={() => {
        setMe({ signedIn: false });
        setVehicles(null);
      }}
    >
      <Shell />
    </CarProvider>
  );
}

function Shell() {
  const car = useCar();
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [action, setAction] = useState<string | null>(actionFromHash);
  const [inbox, setInbox] = useState(false);
  const [menu, setMenu] = useState(false);
  const now = useNow(30_000);

  useEffect(() => {
    const on = () => {
      setTab(tabFromHash());
      setAction(actionFromHash());
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (t: Tab) => {
    location.hash = `/${t}`;
    window.scrollTo({ top: 0 });
  };
  const s = car.status;
  const unread = car.notices.data?.filter((n) => !n.isRead).length ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="car-pick">
          <Car size={20} />
          {car.vehicles.length > 1 ? (
            <select value={car.vehicle.vin} onChange={(e) => car.selectVehicle(e.target.value)} aria-label="Vehicle">
              {car.vehicles.map((v) => (
                <option key={v.vin} value={v.vin}>
                  {v.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{car.vehicle.name}</strong>
          )}
        </div>
        <div className="top-actions">
          <LiveToggle />
          <button className="refresh" onClick={car.refresh} disabled={car.refreshing} aria-label="Refresh car data">
            <RefreshCw size={16} className={car.refreshing ? "spin" : ""} />
            <span>{car.refreshing ? "Refreshing…" : s ? `Updated ${ago(s.status.updatedAt, now)}` : "Refresh"}</span>
          </button>
          <button className="icon-btn" onClick={() => setInbox(true)} aria-label="Inbox">
            <Bell size={18} />
            {unread > 0 && <span className="badge">{unread}</span>}
          </button>
          <div className="menu-wrap">
            <button className="avatar" onClick={() => setMenu((m) => !m)} aria-label="Account" aria-expanded={menu}>
              {(car.accountLabel || "?").replace(/[^A-Za-z0-9]/g, "").slice(-2) || "Me"}
            </button>
            {menu && (
              <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <div className="menu-head">
                  <strong>{car.accountLabel}</strong>
                  <span className="muted small">{car.provider === "demo" ? "Demo car" : "Proton Link"}</span>
                </div>
                <button
                  role="menuitem"
                  onClick={() => {
                    car.forgetPin();
                    car.toast(car.rememberPin ? "Saved PIN removed from this device" : "PIN cleared");
                    setMenu(false);
                  }}
                >
                  {car.rememberPin ? "Forget saved PIN" : "Clear PIN"}
                </button>
                <button
                  role="menuitem"
                  onClick={() => api("/api/gate/lock", { method: "POST" }).finally(() => location.reload())}
                  title="On the public URL, this browser will need the passcode again"
                >
                  Lock this browser
                </button>
                <button role="menuitem" className="danger" onClick={car.signOut}>
                  <LogOut size={16} /> Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} className={t.id === tab && !action ? "on" : ""} onClick={() => go(t.id)} aria-current={t.id === tab && !action ? "page" : undefined}>
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      <main className="content">
        <div>
          <h1 className="title">{action ? "Quick action" : TABS.find((t) => t.id === tab)!.label}</h1>
          {s && (
            <p className="muted small">
              Car data from {ago(s.status.updatedAt, now)} ·{" "}
              {car.live?.active ? "live mode is updating it automatically" : "updates only when you press Refresh or turn on Live"}
            </p>
          )}
        </div>
        {car.statusError && !s && (
          <div className="card">
            <p className="error">{car.statusError}</p>
            <button className="btn" onClick={car.refresh}>
              Try again
            </button>
          </div>
        )}
        {car.statusError && s && <p className="error small">Refresh failed: {car.statusError}. Showing earlier data.</p>}
        {!s && !car.statusError ? (
          <div className="center-pad">
            <Spinner />
          </div>
        ) : (
          <>
            {action ? (
              <QuickAction command={action} onDone={() => go("overview")} />
            ) : (
              <>
            {tab === "overview" && <Overview go={go} />}
            {tab === "controls" && <Controls />}
            {tab === "climate" && <Climate />}
            {tab === "health" && <Health />}
            {tab === "location" && <Location />}
              </>
            )}
          </>
        )}
      </main>

      <div className="toasts" role="status" aria-live="polite">
        {car.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
      {inbox && <Inbox onClose={() => setInbox(false)} />}
    </div>
  );
}

/** "#/do/horn_lights" sends the command from the server and shows its JSON ({"success": true|false}). */
const HANDS_FREE = ["horn_lights"];
// Module-level so React StrictMode's double effect can't send the command twice.
const sent = new Map<string, Promise<string>>();

function HandsFree({ command }: { command: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!sent.has(command))
      sent.set(
        command,
        fetch(`/do/${command}`, { cache: "no-store" })
          .then((r) => r.text())
          .then((t) => {
            try {
              return JSON.stringify(JSON.parse(t), null, 2);
            } catch {
              return JSON.stringify({ success: false, message: "Unexpected response" }, null, 2);
            }
          })
          .catch(() => JSON.stringify({ success: false, message: "Server unreachable" }, null, 2)),
      );
    sent.get(command)!.then(setText);
  }, [command]);
  return <pre>{text}</pre>;
}

export default function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const command = /^#\/do\/([a-z_]+)$/.exec(hash)?.[1];
  if (command && HANDS_FREE.includes(command)) return <HandsFree command={command} />;
  return <SignedInApp />;
}
