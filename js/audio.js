// Playback engine.
//
// Everything goes through ONE <audio> element, because that is what iOS keeps playing with the
// screen locked and what drives the lock-screen controls.
//  - "stream": the night's MP3 plays as-is from an ayah onwards.
//  - "loop":   the chosen range is cut out of the night's MP3 at the ayah boundaries (decoded with
//              Web Audio, exact to the sample), assembled with the repeats and pauses into a WAV,
//              and that WAV is what the <audio> element loops. The loop points are in the audio
//              itself, so they stay exact in the background where timers are unreliable.

import { D, key, source, nextKey, cmp, nightInfo, surah } from "./data.js";
import { audioStore } from "./store.js";

const GAP_CUT = 0.45;        // silence where a skipped repeat was cut out
const GAP_NIGHTS = 0.6;      // silence between two recordings
const NATURAL_MAX = 0.7;     // longest stretch of the recording's own pause kept after an ayah
const BAKE_MAX = 12 * 60;    // finite repeats are written into the clip up to this length
const CLIP_MAX = 30 * 60;

export class NoAudioError extends Error {
  constructor(night) { super(`Night ${night} audio is not on this device`); this.night = night; }
}

function wav(int16, rate) {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); h.setUint32(4, 36 + int16.byteLength, true); w(8, "WAVE"); w(12, "fmt ");
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  w(36, "data"); h.setUint32(40, int16.byteLength, true);
  return new Blob([h.buffer, int16.buffer], { type: "audio/wav" });
}

function decode(ctx, buf) {
  return new Promise((resolve, reject) => ctx.decodeAudioData(buf, resolve, reject));
}

function once(el, ev, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { el.removeEventListener(ev, ok); reject(new Error(`${ev} timed out`)); }, ms);
    const ok = () => { clearTimeout(t); resolve(); };
    el.addEventListener(ev, ok, { once: true });
  });
}

export class Engine {
  constructor(el, settings, hooks) {
    this.el = el; this.settings = settings; this.hooks = hooks;
    this.mode = "idle"; this.cur = null; this.clip = null; this.stream = null;
    this.blobs = new Map(); this.urls = new Map(); this.primed = false; this.lastT = 0;
    el.preservesPitch = true; el.webkitPreservesPitch = true; el.mozPreservesPitch = true;
    el.addEventListener("timeupdate", () => this.tick());
    el.addEventListener("seeked", () => this.tick());
    el.addEventListener("playing", () => this.hooks.onState("playing"));
    el.addEventListener("pause", () => { if (!this.busy) this.hooks.onState("paused"); });
    el.addEventListener("ended", () => this.ended());
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
    const frame = () => { if (!document.hidden && !el.paused) this.tick(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    this.mediaSession();
  }

  // iOS only lets a media element start from a tap. Call this synchronously inside the tap handler;
  // later play() calls on the same element are then allowed even after awaits.
  prime() {
    if (this.primed) return;
    this.primed = true;
    if (!this.el.src) {
      const silent = wav(new Int16Array(800), 8000);
      this.el.src = URL.createObjectURL(silent);
    }
    const p = this.el.play();
    if (p) p.then(() => { if (this.mode === "idle") this.el.pause(); }).catch(() => { this.primed = false; });
  }

  // the silent primer doesn't count as playing
  get playing() { return !this.el.paused && this.mode !== "idle"; }

  setSpeed(r) {
    this.settings.speed = r;
    this.el.defaultPlaybackRate = r; this.el.playbackRate = r;
    this.positionState();
  }

  // ---- audio files ----

  async blob(night) {
    if (this.blobs.has(night)) return this.blobs.get(night);
    let b = null;
    try { b = await audioStore.get(night); } catch {}
    if (!b) b = await this.download(night);
    this.blobs.set(night, b);
    return b;
  }

  async download(night, quiet = false) {
    const info = nightInfo(night);
    let res;
    try { res = await fetch(info.audio, { cache: "no-store" }); } catch { throw new NoAudioError(night); }
    const type = res.headers.get("content-type") || "";
    if (!res.ok || type.includes("text/html")) throw new NoAudioError(night);
    const total = +res.headers.get("content-length") || info.bytes;
    const chunks = []; let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      if (!quiet) this.hooks.onProgress(`Downloading night ${night}`, got / total);
    }
    if (!quiet) this.hooks.onProgress(null);
    const blob = new Blob(chunks, { type: "audio/mpeg" });
    if (blob.size < info.bytes * 0.99) throw new Error(`Night ${night} download was cut short`);
    try { await audioStore.put(night, blob); } catch { this.hooks.onError("Storage is full: this night will play but is not saved for offline use."); }
    return blob;
  }

  async url(night) {
    if (!this.urls.has(night)) this.urls.set(night, URL.createObjectURL(await this.blob(night)));
    return this.urls.get(night);
  }

  async load(src) {
    if (this.el.src !== src) {
      this.el.src = src;
      await once(this.el, "loadedmetadata");
    }
    this.el.defaultPlaybackRate = this.settings.speed; this.el.playbackRate = this.settings.speed;
  }

  // ---- stream: play the night from an ayah onwards ----

  async playFrom(s, a) {
    this.busy = true; this.hooks.onState("busy");
    try {
      const src = await source(s, a, this.settings);
      if (!src) throw new Error(`There is no recording of ${s}:${a}`);
      const u = await this.url(src.night);
      this.revokeClip();
      this.mode = "stream"; this.clip = null; this.stream = { night: src.night, t: src.t };
      this.el.loop = false;
      await this.load(u);
      const it = src.item;
      const prev = src.t.items[src.i - 1];
      // a surah's basmala is part of its first ayah's opening
      const startAt = prev && prev.type === "basmala" && it.a === 1 ? prev.start : it.start;
      this.el.currentTime = startAt + src.t.offset;
      this.setCur(s, a, src.night);
      await this.el.play();
    } finally {
      this.busy = false;
      this.hooks.onState(this.el.paused ? "paused" : "playing");
    }
  }

  itemAt(t, d) {
    let lo = 0, hi = t.items.length - 1, best = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (t.items[m].start <= d + 0.02) { best = m; lo = m + 1; } else hi = m - 1;
    }
    return best;
  }

  // ---- loop: exact range loops ----

  async playLoop(from, to, startAt = null) {
    this.busy = true; this.hooks.onState("busy");
    try {
      const keys = [];
      for (let k = from; k && cmp(k, to) <= 0; k = nextKey(k[0], k[1])) {
        keys.push(k);
        if (keys.length > 700) throw new Error("That loop is too long. Choose up to a few pages.");
      }
      const srcs = (await Promise.all(keys.map((k) => source(k[0], k[1], this.settings)))).filter(Boolean);
      if (!srcs.length) throw new Error("There is no recording for that range.");
      for (const n of new Set(srcs.map((x) => x.night))) await this.blob(n);
      const plan = this.plan(srcs);
      const clip = await this.render(plan);
      this.revokeClip();
      this.mode = "loop"; this.stream = null; this.clip = clip; clip.done = 0;
      this.el.loop = clip.loopAttr;
      await this.load(clip.url);
      let t0 = 0;
      if (startAt) {
        const e = clip.map.find((m) => m.s === startAt[0] && m.a === startAt[1]);
        if (e) t0 = e.c0;
      }
      this.el.currentTime = t0; this.lastT = t0;
      const first = clip.map.find((m) => m.c0 >= t0 - 0.01 && m.a) || clip.map[0];
      this.setCur(first.s, first.a, first.night);
      await this.el.play();
    } finally {
      this.busy = false;
      this.hooks.onState(this.el.paused ? "paused" : "playing");
    }
  }

  // The cut list for one cycle of the loop. Times are in each night's cleaned timeline.
  plan(srcs) {
    const S = this.settings;
    const K = Math.max(1, S.ayahRepeat | 0);
    const pieces = [];            // { night, t, t0, t1, map: [{t0, t1, s, a}] } | { gap }
    const repeatsIn = (t, a, b) => t.repeats.filter((r) => r.start >= a - 0.01 && r.end <= b + 0.01);
    const naturalAfter = (src) => {
      const nxt = src.t.items[src.i + 1];
      const end = src.item.end;
      if (!nxt) return null;
      if (S.skipRepeats && src.t.repeats.some((r) => r.start <= end + 0.01 && r.end > end + 0.01)) return null;
      const stop = Math.min(nxt.start - 0.03, end + NATURAL_MAX);
      return stop > end + 0.05 ? stop : null;
    };
    const basmalaBefore = (src) => {
      const p = src.t.items[src.i - 1];
      return src.item.a === 1 && p && p.type === "basmala" ? p : null;
    };

    if (K === 1) {
      // contiguous groups: same night, consecutive items (a basmala may sit between)
      const groups = [];
      for (const x of srcs) {
        const g = groups[groups.length - 1];
        const last = g && g[g.length - 1];
        const next = last && last.night === x.night &&
          (x.i === last.i + 1 || (x.i === last.i + 2 && x.t.items[last.i + 1].type === "basmala"));
        if (next) g.push(x); else groups.push([x]);
      }
      groups.forEach((g, gi) => {
        if (gi) pieces.push({ gap: GAP_NIGHTS });
        const t = g[0].t, night = g[0].night;
        const b = basmalaBefore(g[0]);
        const a0 = b ? b.start : g[0].item.start;
        const a1 = g[g.length - 1].item.end;
        const map = [];
        if (b) map.push({ t0: b.start, t1: g[0].item.start, s: g[0].item.s, a: 0 });
        g.forEach((x, i) => {
          const nxt = g[i + 1];
          map.push({ t0: x.item.start, t1: nxt ? nxt.t.items[nxt.i - (nxt.item.a === 1 && nxt.t.items[nxt.i - 1].type === "basmala" ? 1 : 0)].start : a1, s: x.item.s, a: x.item.a });
        });
        // cut the imam's repeats out of the group (they sit in the gaps between ayat)
        let cursor = a0;
        const cuts = S.skipRepeats ? repeatsIn(t, a0, a1) : [];
        for (const r of cuts) {
          pieces.push({ night, t, t0: cursor, t1: r.start, map });
          pieces.push({ gap: GAP_CUT });
          cursor = r.end;
        }
        pieces.push({ night, t, t0: cursor, t1: a1, map });
      });
      const last = srcs[srcs.length - 1];
      const nat = naturalAfter(last);
      if (nat) pieces.push({ night: last.night, t: last.t, t0: last.item.end, t1: nat, map: [] });
      else pieces.push({ gap: GAP_NIGHTS });
    } else {
      srcs.forEach((x) => {
        const b = basmalaBefore(x);
        if (b) pieces.push({ night: x.night, t: x.t, t0: b.start, t1: x.item.start, map: [{ t0: b.start, t1: x.item.start, s: x.item.s, a: 0 }] });
        const nat = naturalAfter(x);
        for (let k = 0; k < K; k++) {
          const t1 = nat || x.item.end;
          pieces.push({ night: x.night, t: x.t, t0: x.item.start, t1, map: [{ t0: x.item.start, t1, s: x.item.s, a: x.item.a }] });
          if (!nat) pieces.push({ gap: GAP_CUT });
        }
      });
    }
    if (S.rangePause > 0) pieces.push({ gap: S.rangePause });
    return pieces;
  }

  async render(pieces) {
    const S = this.settings;
    const cycle = pieces.reduce((s, p) => s + (p.gap || (p.t1 - p.t0)), 0);
    if (cycle > CLIP_MAX) throw new Error("That loop is longer than 30 minutes. Choose a shorter range.");
    const rate = cycle <= 600 ? 32000 : 22050;
    const R = S.rangeRepeat === 0 ? Infinity : Math.max(1, S.rangeRepeat | 0);
    const bake = R !== Infinity && R * cycle <= BAKE_MAX ? R : 1;
    this.hooks.onProgress("Preparing the loop", 0);

    // decode what each night needs, as few slices as possible
    const spans = [];
    for (const p of pieces) {
      if (p.gap) continue;
      const d0 = p.t0 + p.t.offset, d1 = p.t1 + p.t.offset;
      const sp = spans.find((x) => x.night === p.night && d0 <= x.d1 + 3 && d1 >= x.d0 - 3);
      if (sp) { sp.d0 = Math.min(sp.d0, d0); sp.d1 = Math.max(sp.d1, d1); } else spans.push({ night: p.night, t: p.t, d0, d1 });
    }
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 2, rate);
    let doneSec = 0; const totalSec = spans.reduce((s, x) => s + x.d1 - x.d0, 0);
    for (const sp of spans) {
      Object.assign(sp, await this.decodeSpan(ctx, sp, rate, (sec) => this.hooks.onProgress("Preparing the loop", (doneSec + sec) / totalSec)));
      doneSec += sp.d1 - sp.d0;
    }

    // assemble one cycle
    const n = Math.round(cycle * rate) + rate;
    const out = new Int16Array(n);
    const map = [];
    let pos = 0;
    const fade = (o, len, up) => {
      for (let i = 0; i < len && o + i < n; i++) {
        const g = up ? i / len : 1 - i / len;
        out[o + i] = Math.round(out[o + i] * Math.sin(g * Math.PI / 2));
      }
    };
    for (const p of pieces) {
      if (p.gap) { pos += Math.round(p.gap * rate); continue; }
      const sp = spans.find((x) => x.night === p.night && p.t0 + p.t.offset >= x.d0 - 1e-6 && p.t1 + p.t.offset <= x.d1 + 1e-6);
      const from = Math.round((p.t0 + p.t.offset - sp.start) * rate);
      const len = Math.round((p.t1 - p.t0) * rate);
      out.set(sp.pcm.subarray(from, from + len), pos);
      fade(pos, Math.round(0.008 * rate), true);
      fade(pos + len - Math.round(0.012 * rate), Math.round(0.012 * rate), false);
      for (const m of p.map) {
        const a = Math.max(m.t0, p.t0), b = Math.min(m.t1, p.t1);
        if (b > a) map.push({ c0: (pos + (a - p.t0) * rate) / rate, c1: (pos + (b - p.t0) * rate) / rate, s: m.s, a: m.a, night: p.night });
      }
      pos += len;
    }
    const cyc = out.subarray(0, pos);
    const cycleDur = pos / rate;
    let pcm = cyc;
    if (bake > 1) {
      // the extra pause before repeating is not needed after the last time through
      const tail = S.rangePause > 0 ? Math.round(S.rangePause * rate) : 0;
      pcm = new Int16Array(pos * bake - tail);
      for (let k = 0; k < bake; k++) pcm.set(k < bake - 1 ? cyc : cyc.subarray(0, pos - tail), k * pos);
    }
    this.hooks.onProgress(null);
    map.sort((x, y) => x.c0 - y.c0);
    return { url: URL.createObjectURL(wav(pcm, rate)), map, cycleDur, cycles: R, baked: bake,
             loopAttr: R === Infinity || (bake === 1 && R > 1) };
  }

  // Decode [d0, d1] of a night's MP3 (decoded timeline). Every frame of these MP3s decodes on
  // its own, so slices can start at any indexed frame; the first frames of each slice are thrown
  // away because a decoder needs a few frames to settle.
  async decodeSpan(ctx, sp, rate, progress) {
    const idx = sp.t.index;
    const fsec = idx.samples_per_frame / idx.sample_rate;
    const step = idx.step, warm = step;
    const blob = await this.blob(sp.night);
    let f0 = Math.max(0, Math.floor(sp.d0 / fsec) - warm - 2);
    f0 -= f0 % step;
    let f1 = Math.min(idx.frames, Math.ceil(sp.d1 / fsec) + 4);
    const start = f0 * fsec;
    const pcm = new Int16Array(Math.ceil((f1 - f0) * fsec * rate) + 4);
    const CH = step * 96;                                  // ~80 s per slice
    for (let a = f0; a < f1; a += CH) {
      const b = Math.min(f1, a + CH);
      const sa = a === f0 ? a : a - warm;
      const bb = Math.min(idx.frames, Math.ceil(b / step) * step + step);
      const byteA = idx.offsets[sa / step];
      const byteB = bb >= idx.frames ? idx.bytes : idx.offsets[bb / step];
      const buf = await decode(ctx, await blob.slice(byteA, byteB).arrayBuffer());
      const ch = buf.getChannelData(0);
      const skip = Math.round((a - sa) * fsec * rate);
      const want = Math.round((b - a) * fsec * rate);
      const at = Math.round((a - f0) * fsec * rate);
      for (let i = 0; i < want && skip + i < ch.length && at + i < pcm.length; i++) {
        const v = ch[skip + i];
        pcm[at + i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
      }
      progress((b - f0) * fsec);
    }
    return { pcm, start };
  }

  revokeClip() {
    if (this.clip) { const u = this.clip.url; setTimeout(() => URL.revokeObjectURL(u), 3000); this.clip = null; }
  }

  // ---- position tracking ----

  tick() {
    const el = this.el;
    if (this.mode === "stream" && this.stream) {
      const t = this.stream.t;
      const d = el.currentTime - t.offset;
      if (this.settings.skipRepeats && !el.paused) {
        const r = t.repeats.find((r) => d >= r.start + 0.02 && d < r.end - 0.05);
        if (r) { el.currentTime = r.end + t.offset; return; }
      }
      const i = this.itemAt(t, d);
      const it = t.items[i];
      if (it && it.type === "ayah") this.setCur(it.s, it.a, this.stream.night);
      else if (it && it.type === "basmala") this.setCur(it.s, 0, this.stream.night);
    } else if (this.mode === "loop" && this.clip) {
      const c = el.currentTime, clip = this.clip;
      if (clip.baked === 1 && clip.cycles !== Infinity && c + 1 < this.lastT) {
        clip.done++;
        if (clip.done >= clip.cycles - 1) el.loop = false;
      }
      this.lastT = c;
      const pos = c % clip.cycleDur;
      const m = clip.map.find((e) => pos >= e.c0 - 0.01 && pos < e.c1) ||
        [...clip.map].reverse().find((e) => e.c0 <= pos);
      if (m) this.setCur(m.s, m.a, m.night);
    }
  }

  setCur(s, a, night) {
    const k = `${s}:${a}:${night}`;
    if (k === this.curKey) return;
    this.curKey = k; this.cur = [s, a]; this.curNight = night;
    this.hooks.onAyah(s, a, night);
    this.metadata();
  }

  async ended() {
    if (this.mode === "stream" && this.stream && this.settings.continueNights !== false) {
      const t = this.stream.t;
      const last = [...t.items].reverse().find((x) => x.type === "ayah");
      const nk = last && nextKey(last.s, last.a);
      if (nk) {
        const src = await source(nk[0], nk[1], this.settings);
        if (src && src.night !== this.stream.night) { this.playFrom(nk[0], nk[1]).catch((e) => this.hooks.onError(e.message)); return; }
      }
    }
    if (this.mode === "loop") this.hooks.onLoopDone();
    this.hooks.onState("paused");
  }

  // ---- transport ----

  pause() { this.el.pause(); }
  async resume() { await this.el.play(); }

  async step(dir) {
    if (!this.cur) return;
    if (this.mode === "loop" && this.clip) {
      const clip = this.clip, el = this.el;
      const base = Math.floor(el.currentTime / clip.cycleDur) * clip.cycleDur;
      const pos = el.currentTime - base;
      const list = clip.map.filter((m) => m.a > 0);
      const cur = list.filter((m) => m.c0 <= pos + 0.05).pop() || list[0];
      const i = list.indexOf(cur);
      const target = dir > 0 ? list[i + 1] : (pos - cur.c0 > 1.5 ? cur : list[i - 1]);
      el.currentTime = target ? base + target.c0 : (dir > 0 ? base + clip.cycleDur - 0.05 : base);
      return;
    }
    const [s, a] = this.cur;
    if (this.mode === "stream" && this.stream) {
      const t = this.stream.t;
      const i = t.byKey.get(key(s, Math.max(1, a)));
      const it = t.items[i];
      const d = this.el.currentTime - t.offset;
      if (dir < 0 && it && d - it.start > 1.5) { this.el.currentTime = it.start + t.offset; return; }
    }
    const k = dir > 0 ? nextKey(s, Math.max(1, a)) : (a > 1 ? [s, a - 1] : (s > 1 ? [s - 1, surah(s - 1).ayas] : null));
    if (k) await this.playFrom(k[0], k[1]);
  }

  // ---- lock screen ----

  mediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
    set("play", () => this.hooks.command("play"));
    set("pause", () => this.hooks.command("pause"));
    set("previoustrack", () => this.hooks.command("prev"));
    set("nexttrack", () => this.hooks.command("next"));
    set("seekbackward", null); set("seekforward", null);
  }

  metadata() {
    if (!("mediaSession" in navigator) || !this.cur) return;
    const [s, a] = this.cur;
    const su = surah(s);
    const loop = this.mode === "loop" ? "Loop, " : "";
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: a ? `${su.tname} ${s}:${a}` : `${su.tname}, basmala`,
        artist: `${loop}Night ${this.curNight}`,
        album: "Tahajjud 1446",
        artwork: [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }],
      });
    } catch {}
    this.positionState();
  }

  positionState() {
    const el = this.el;
    try {
      if (navigator.mediaSession && navigator.mediaSession.setPositionState && isFinite(el.duration) && el.duration > 0)
        navigator.mediaSession.setPositionState({ duration: el.duration, position: Math.min(el.currentTime, el.duration), playbackRate: el.playbackRate || 1 });
    } catch {}
  }
}
