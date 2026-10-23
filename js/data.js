// Quran text (Tanzil, verbatim), metadata, recordings and per-night ayah timings.

import { corrections } from "./store.js";

export const D = { meta: null, text: new Map(), nights: [], surahs: {}, timings: new Map(), fixes: {} };

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
export const arNum = (n) => String(n).replace(/\d/g, (d) => AR_DIGITS[d]);
export const key = (s, a) => `${s}:${a}`;

async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function load() {
  const [meta, nights, surahs, txt, fixes] = await Promise.all([
    json("data/meta.json"), json("data/nights.json"), json("data/surahs.json"),
    fetch("data/quran-uthmani.txt").then((r) => r.text()), corrections.all().catch(() => ({})),
  ]);
  D.meta = meta; D.nights = nights; D.surahs = surahs; D.fixes = fixes;
  for (const line of txt.split("\n")) {
    const m = /^(\d+)\|(\d+)\|(.+)$/.exec(line.trim());
    if (m) D.text.set(key(+m[1], +m[2]), m[3]);
  }
}

export const surah = (s) => D.meta.suras[s - 1];

// Tanzil keeps each surah's basmala as the first four words of ayah 1 (all surahs but 1 and 9);
// the page shows it as the surah's opening line instead.
export function ayahText(s, a) {
  const t = D.text.get(key(s, a)) || "";
  if (a !== 1 || s === 1 || s === 9) return { basmala: null, body: t };
  const w = t.split(" ");
  return { basmala: w.slice(0, 4).join(" "), body: w.slice(4).join(" ") };
}

export function nextKey(s, a) {
  if (a < surah(s).ayas) return [s, a + 1];
  return s < 114 ? [s + 1, 1] : null;
}
export function prevKey(s, a) {
  if (a > 1) return [s, a - 1];
  return s > 1 ? [s - 1, surah(s - 1).ayas] : null;
}
export const cmp = (x, y) => x[0] - y[0] || x[1] - y[1];

export function juzOf(s, a) {
  let j = 0;
  D.meta.juz.forEach((p, i) => { if (cmp(p, [s, a]) <= 0) j = i + 1; });
  return j;
}

// ---- timings ----

export async function timings(night) {
  if (D.timings.has(night)) return D.timings.get(night);
  const t = await json(`data/timings/night-${String(night).padStart(2, "0")}.json`);
  const idx = await json(`data/audio-index/night-${String(night).padStart(2, "0")}.json`);
  t.index = idx;
  applyFixes(t);
  D.timings.set(night, t);
  return t;
}

function applyFixes(t) {
  t.byKey = new Map();
  t.items.forEach((it, i) => {
    const k = it.type === "ayah" ? key(it.s, it.a) : `b${it.s}`;
    const f = it.type === "ayah" && D.fixes[`${t.night}:${k}`];
    if (f) { it.orig = it.orig || [it.start, it.end]; it.start = f.start; it.end = f.end; it.fixed = true; }
    if (it.type === "ayah") t.byKey.set(k, i);
  });
}

export function reapplyFix(night, s, a, value) {
  const k = `${night}:${key(s, a)}`;
  if (value) D.fixes[k] = value; else delete D.fixes[k];
  const t = D.timings.get(night);
  if (!t) return;
  const it = t.items[t.byKey.get(key(s, a))];
  if (!value && it.orig) { [it.start, it.end] = it.orig; it.fixed = false; }
  applyFixes(t);
}

export function recordingFor(s, settings) {
  const info = D.surahs[s];
  const chosen = settings.recording[s];
  return chosen && info.nights.some((n) => n.night === chosen) ? chosen : info.default;
}

// Where an ayah can be heard: the chosen recording of its surah, else any night that has it.
export async function source(s, a, settings) {
  const info = D.surahs[s];
  if (!info) return null;
  const first = recordingFor(s, settings);
  const order = [first, ...info.nights.map((n) => n.night).filter((n) => n !== first)];
  for (const night of order) {
    if (!night) continue;
    const t = await timings(night);
    const i = t.byKey.get(key(s, a));
    if (i !== undefined) return { night, t, i, item: t.items[i] };
  }
  return null;
}

export const nightInfo = (n) => D.nights.find((x) => x.night === n);
