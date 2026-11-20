// Mottokar service worker: makes the app installable and opens the app shell offline.
// It never caches /api/* — car data, sign-in and commands always go to the server.
const CACHE = "mottokar-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icons/apple-touch-icon.png", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  // Hashed build files never change: cache first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
            return res;
          }),
      ),
    );
    return;
  }

  // The page itself: network first so updates show up, cached copy when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put("/", res.clone()));
          return res;
        })
        .catch(() => caches.match("/")),
    );
  }
});

// Push notifications (FCM, sent by the server's /cron/notify; see web/push.py). The server sends
// data-only messages, so this worker decides what to show and no Firebase code runs here.
// Bump to tell an installed app's old worker apart from this one (shown when a push can't be read).
const SW_VERSION = "push-3";

/** Pulls title/body/image/url out of whatever shape the push came in. */
function readPush(msg) {
  const n = msg.notification || {};
  const d = msg.data || {};
  const wp = (msg.webpush && msg.webpush.notification) || {};
  const pick = (...keys) => {
    for (const k of keys) for (const src of [d, n, wp, msg]) if (src && typeof src[k] === "string" && src[k]) return src[k];
    return "";
  };
  return {
    // Our server: data.title/body. Firebase console: notification.title/body (+ custom data).
    // Older FCM payloads flatten them into data as "gcm.notification.*".
    title: pick("title", "gcm.notification.title"),
    body: pick("body", "gcm.notification.body"),
    image: pick("image", "gcm.notification.image"),
    icon: pick("icon", "gcm.notification.icon"),
    url: pick("url", "link", "click_action", "gcm.notification.click_action"),
    tag: pick("tag"),
  };
}

self.addEventListener("push", (event) => {
  let msg = {};
  let raw = "";
  try {
    raw = event.data ? event.data.text() : "";
    msg = raw ? JSON.parse(raw) : {};
  } catch {
    msg = {};
  }
  const p = readPush(msg);
  // Couldn't find a title: show what arrived, so the payload format can be seen on the device.
  const body = p.title ? p.body : `[${SW_VERSION}] ${raw.slice(0, 300) || "empty push"}`;
  const options = {
    body,
    icon: p.icon || "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: p.url || "/#/inbox" },
  };
  if (p.tag) options.tag = p.tag;
  if (p.image) options.image = p.image; // Chrome/Android show it; Safari ignores it
  event.waitUntil(self.registration.showNotification(p.title || "Mottokar", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) return win.focus().then((w) => (w || win).navigate(url)).catch(() => self.clients.openWindow(url));
      return self.clients.openWindow(url);
    }),
  );
});
