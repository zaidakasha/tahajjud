// Offline support: the app, the Quran text and all timings are cached here.
// The audio itself lives in IndexedDB (saved by the app), so it is never cached twice.
const VERSION = "tahajjud-v1";
const pad = (n) => String(n).padStart(2, "0");
const NIGHTS = Array.from({ length: 29 }, (_, i) => pad(i + 1));
const SHELL = [
  "./", "index.html", "manifest.webmanifest", "css/app.css",
  "js/main.js", "js/data.js", "js/audio.js", "js/store.js", "js/correct.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/maskable-512.png",
  "data/meta.json", "data/nights.json", "data/surahs.json", "data/quran-uthmani.txt",
  ...NIGHTS.map((n) => `data/timings/night-${n}.json`),
  ...NIGHTS.map((n) => `data/audio-index/night-${n}.json`),
];
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

const FONT_CSS = "https://fonts.googleapis.com/css2?family=Amiri+Quran&family=Amiri:wght@400;700&family=Atkinson+Hyperlegible:wght@400;700&display=swap";

// fonts too, so the text renders offline from the very first launch
async function cacheFonts() {
  try {
    const c = await caches.open("fonts");
    const res = await fetch(FONT_CSS);
    if (!res.ok) return;
    const css = await res.clone().text();
    await c.put(FONT_CSS, res);
    const urls = [...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
    await Promise.all(urls.map((u) => fetch(u).then((r) => r.ok && c.put(u, r)).catch(() => {})));
  } catch {}
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(cacheFonts).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== "fonts").map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (FONTS.test(req.url)) {
    e.respondWith(caches.open("fonts").then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin || url.pathname.endsWith(".mp3")) return;
  // app files: answer from the cache, refresh it in the background
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || (req.mode === "navigate" ? c.match("index.html") : Response.error());
  }));
});
