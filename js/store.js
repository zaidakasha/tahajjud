// Storage: settings/last position in localStorage, audio files and timing corrections in IndexedDB.

const KEY = "tahajjud.v1";
const DEFAULTS = {
  theme: "auto", fontSize: 30, autoScroll: true, speed: 1,
  rangeRepeat: 1, ayahRepeat: 1, rangePause: 0, skipRepeats: true,
  recording: {},            // surah -> night chosen by the user
  last: null,               // { s, a } last ayah played or viewed
  loop: null,               // { from: [s, a], to: [s, a] }
  markDelay: 0.15,          // reaction time subtracted when marking a boundary while listening
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: keep going */ }
}

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open("tahajjud", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore("audio");
        d.createObjectStore("corrections");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r && "result" in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const audioStore = {
  get: (night) => tx("audio", "readonly", (s) => s.get(night)),
  put: (night, blob) => tx("audio", "readwrite", (s) => s.put(blob, night)),
  del: (night) => tx("audio", "readwrite", (s) => s.delete(night)),
  keys: () => tx("audio", "readonly", (s) => s.getAllKeys()),
};

export const corrections = {
  all: async () => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const out = {};
      const req = d.transaction("corrections").objectStore("corrections").openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out[c.key] = c.value; c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  },
  put: (key, v) => tx("corrections", "readwrite", (s) => s.put(v, key)),
  del: (key) => tx("corrections", "readwrite", (s) => s.delete(key)),
};

export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
  return false;
}

export async function usage() {
  try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
}
