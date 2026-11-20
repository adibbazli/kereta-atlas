// Push notifications for new inbox messages (Firebase Cloud Messaging).
// The browser gets an FCM token for our own service worker (/sw.js, which shows the pushes) and
// hands it to the server; the server's cron does the rest. See web/push.py.

import type { Messaging } from "firebase/messaging";

import { api } from "./api";

// Firebase is loaded only when notifications are used, keeping it out of the main bundle.
const fb = () => Promise.all([import("firebase/app"), import("firebase/messaging")]).then(([app, messaging]) => ({ ...app, ...messaging }));

type PushConfig = { enabled: false } | { enabled: true; config: Record<string, string>; vapidKey: string };
export type PushState = "unavailable" | "needs-install" | "denied" | "off" | "on";

// Whether this browser wants pushes: survives an expired session, so they resume after signing in.
const WANT = "mk.push";
const TOKEN = "mk.push.token";

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // private mode: the preference just isn't remembered
    }
  },
};

let configP: Promise<PushConfig> | null = null;
function pushConfig(): Promise<PushConfig> {
  configP ??= api<PushConfig>("/api/push/config").catch(() => {
    configP = null;
    return { enabled: false } as const;
  });
  return configP;
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

async function messaging(cfg: Extract<PushConfig, { enabled: true }>): Promise<Messaging> {
  const { getApps, initializeApp, getMessaging } = await fb();
  return getMessaging(getApps()[0] ?? initializeApp(cfg.config));
}

export async function pushState(): Promise<PushState> {
  const cfg = await pushConfig();
  if (!cfg.enabled) return "unavailable";
  // iOS only offers web push to apps added to the Home Screen.
  if (isIOS() && !isStandalone()) return "needs-install";
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return "unavailable";
  if (!(await fb().then((f) => f.isSupported()).catch(() => false)))
    return "unavailable";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && store.get(WANT) === "1" ? "on" : "off";
}

/** Must run from a tap: browsers (iOS especially) only show the permission prompt for one. */
export async function enablePush(): Promise<void> {
  const cfg = await pushConfig();
  if (!cfg.enabled) throw new Error("Notifications aren't set up on this server");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site. Allow them in the browser settings.");
  const registration = await navigator.serviceWorker.ready;
  const { getToken } = await fb();
  const token = await getToken(await messaging(cfg), { vapidKey: cfg.vapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error("Couldn't register this device for notifications");
  await api("/api/push/subscribe", { method: "POST", body: { token } });
  store.set(WANT, "1");
  store.set(TOKEN, token);
}

export async function disablePush(): Promise<void> {
  const token = store.get(TOKEN);
  if (!token && store.get(WANT) !== "1") return; // never turned on here: nothing to undo
  store.set(WANT, null);
  store.set(TOKEN, null);
  const cfg = await pushConfig();
  if (cfg.enabled) {
    const { deleteToken } = await fb();
    await deleteToken(await messaging(cfg)).catch(() => {});
  }
  if (token) await api("/api/push/unsubscribe", { method: "POST", body: { token } }).catch(() => {});
}

/** After a sign-in: if this browser had notifications on, subscribe the new session without asking again. */
export async function resumePush(subscribed: boolean): Promise<void> {
  if (subscribed || store.get(WANT) !== "1") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  await enablePush().catch(() => {});
}
