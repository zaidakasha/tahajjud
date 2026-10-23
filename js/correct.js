// Correction mode: listen to one ayah, move its start/end, save the fix on this phone.

import { D, surah, ayahText, source, timings, reapplyFix, key, cmp } from "./data.js";
import { corrections } from "./store.js";

const RATE = 16000;

function wavBlob(int16) {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); h.setUint32(4, 36 + int16.byteLength, true); w(8, "WAVE"); w(12, "fmt ");
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, RATE, true); h.setUint32(28, RATE * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  w(36, "data"); h.setUint32(40, int16.byteLength, true);
  return new Blob([h.buffer, int16.buffer], { type: "audio/wav" });
}

const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;

// Ayat whose timing was flagged and not yet fixed, in mushaf order.
export async function flaggedList(S) {
  const out = [];
  for (const n of D.nights) {
    const t = await timings(n.night);
    for (const it of t.items) {
      if (it.type !== "ayah" || !it.flags.includes("check") || it.fixed) continue;
      const src = await source(it.s, it.a, S);
      if (src && src.night === n.night) out.push({ s: it.s, a: it.a, night: n.night });
    }
  }
  return out.sort((x, y) => cmp([x.s, x.a], [y.s, y.a]));
}

export async function openCorrection(s, a, ctx) {
  const { S, engine, openSheet, closeSheet, toast, run } = ctx;
  const src = await source(s, a, S);
  if (!src) { toast(`There is no recording of ${s}:${a}.`); return; }
  const { night, t, i } = src;
  const it = t.items[i];
  const prev = t.items[i - 1], next = t.items[i + 1];
  engine.pause();

  let st = { start: it.start, end: it.end, step: 0.05 };
  const w0 = Math.max(0, Math.min(it.start - 2, prev ? prev.end - 0.5 : it.start - 2));
  const w1 = Math.min(t.duration, Math.max(it.end + 2, next ? Math.min(next.start + 0.5, it.end + 4) : it.end + 2));
  const su = surah(s);
  const { body } = ayahText(s, a);

  openSheet(`<h2>Fix the timing of ${su.tname} ${s}:${a}</h2>
    <div class="ayah-preview" dir="rtl" lang="ar">${body}</div>
    <p id="cState">Loading the audio for night ${night}</p>
    <div class="wave-wrap" id="wave"><canvas></canvas></div>
    <div class="times"><span id="tStart"></span><span id="tLen"></span><span id="tEnd"></span></div>
    <h3>Step</h3>
    <div class="chips" id="stepC">${[[0.01, "10 ms"], [0.05, "50 ms"], [0.2, "200 ms"]].map(([v, l]) => `<button class="chip" data-v="${v}" aria-pressed="${v === 0.05}">${l}</button>`).join("")}</div>
    <div class="nudge"><button class="btn" data-n="start:-1" aria-label="Start earlier">Earlier</button><span class="lbl">Start <b id="vStart"></b></span><button class="btn" data-n="start:1" aria-label="Start later">Later</button></div>
    <div class="nudge"><button class="btn" data-n="end:-1" aria-label="End earlier">Earlier</button><span class="lbl">End <b id="vEnd"></b></span><button class="btn" data-n="end:1" aria-label="End later">Later</button></div>
    <div class="btn-row">
      <button class="btn primary" id="pAyah">Play the ayah</button>
      <button class="btn" id="pStart">Hear the start</button>
      <button class="btn" id="pEnd">Hear the end</button>
    </div>
    <div class="btn-row">
      <button class="btn" id="listen">Listen and mark</button>
      <button class="btn" id="mStart" hidden>Mark start now</button>
      <button class="btn" id="mEnd" hidden>Mark end now</button>
    </div>
    <p>Tip: drag the start or end line on the waveform, or tap the waveform to hear from that point. Marking while listening subtracts ${Math.round(S.markDelay * 1000)} ms for reaction time.</p>
    <div class="btn-row">
      <button class="btn primary" id="save">Save</button>
      <button class="btn" id="reset" ${it.fixed ? "" : "disabled"}>Back to the original</button>
      <button class="btn" id="nextChk">Next ayah to check</button>
      <button class="btn" id="export">Export all fixes</button>
    </div>`,
  async (root) => {
    const $ = (sel) => root.querySelector(sel);
    const canvas = $("#wave canvas");
    const preview = new Audio();
    let pcm = null, pStart = 0, playFrom = null, drag = null, raf = 0;
    root.addEventListener("sheetclose", () => { preview.pause(); cancelAnimationFrame(raf); });

    const show = () => {
      $("#vStart").textContent = fmt(st.start); $("#vEnd").textContent = fmt(st.end);
      $("#tStart").textContent = fmt(st.start); $("#tEnd").textContent = fmt(st.end);
      $("#tLen").textContent = `${(st.end - st.start).toFixed(2)} s`;
      draw();
    };

    // decode the window around the ayah
    try {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const dec = await engine.decodeSpan(new OAC(1, 2, RATE), { night, t, d0: w0 + t.offset, d1: w1 + t.offset }, RATE, () => {});
      pcm = dec.pcm; pStart = dec.start - t.offset;      // clean time of pcm[0]
      $("#cState").textContent = [`Night ${night}.`, it.flags.includes("check") ? "This ayah was flagged to check." : it.fixed ? "You fixed this ayah before." : ""].join(" ").trim();
    } catch (e) {
      $("#cState").textContent = e.night ? `Night ${night} isn't on this phone yet. Add it under Settings, Audio on this phone.` : e.message;
      return;
    }

    const x2t = (x) => w0 + (x / canvas.clientWidth) * (w1 - w0);
    const t2x = (tt) => ((tt - w0) / (w1 - w0)) * canvas.clientWidth;

    function draw() {
      if (!pcm) return;
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      const g = canvas.getContext("2d");
      g.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement);
      const lamp = css.getPropertyValue("--lamp").trim(), dim = css.getPropertyValue("--dim").trim(), text = css.getPropertyValue("--text").trim();
      g.clearRect(0, 0, W, H);
      g.fillStyle = css.getPropertyValue("--lamp-wash").trim();
      g.fillRect(t2x(st.start), 0, t2x(st.end) - t2x(st.start), H);
      const per = (w1 - w0) * RATE / W;
      const peaks = new Float32Array(W);
      let top = 1;
      for (let x = 0; x < W; x++) {
        const a = Math.floor((x2t(x) - pStart) * RATE), b = Math.min(pcm.length, a + Math.ceil(per));
        let e = 0, c = 0;
        for (let k = Math.max(0, a); k < b; k++) { e += pcm[k] * pcm[k]; c++; }
        const m = c ? Math.sqrt(e / c) : 0;
        peaks[x] = m; if (m > top) top = m;
      }
      for (let x = 0; x < W; x++) {
        // loudness over the 30 dB below the loudest point: the masjid's echo stays high, so a
        // narrow range is what makes the pauses between words show as dips
        const db = 20 * Math.log10(Math.max(peaks[x], 1) / top);
        const h = Math.max(1, Math.max(0, 1 + db / 30) * (H - 10));
        const tt = x2t(x);
        g.fillStyle = tt >= st.start && tt <= st.end ? text : dim;
        g.fillRect(x, (H - h) / 2, 1, h);
      }
      for (const [tt, c] of [[st.start, lamp], [st.end, lamp]]) {
        g.fillStyle = c; g.fillRect(t2x(tt) - 1, 0, 3, H);
        g.beginPath(); g.arc(t2x(tt), 10, 7, 0, Math.PI * 2); g.fill();
      }
      if (playFrom != null && !preview.paused) {
        g.fillStyle = text; g.fillRect(t2x(playFrom + preview.currentTime), 0, 1.5, H);
      }
    }

    function play(c0, c1) {
      const a = Math.max(0, Math.round((c0 - pStart) * RATE)), b = Math.min(pcm.length, Math.round((c1 - pStart) * RATE));
      const old = preview.src;
      preview.src = URL.createObjectURL(wavBlob(pcm.slice(a, b)));
      if (old) URL.revokeObjectURL(old);
      playFrom = pStart + a / RATE;
      preview.play().catch(() => {});
      const loop = () => { draw(); if (!preview.paused) raf = requestAnimationFrame(loop); else draw(); };
      cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
    }
    preview.addEventListener("ended", () => { $("#mStart").hidden = true; $("#mEnd").hidden = true; draw(); });

    const clampSt = () => {
      const lo = prev ? prev.start + 0.1 : 0, hi = next ? next.end - 0.1 : t.duration;
      st.start = Math.max(lo, Math.min(st.start, st.end - 0.2));
      st.end = Math.min(hi, Math.max(st.end, st.start + 0.2));
    };

    $("#stepC").addEventListener("click", (e) => {
      const b = e.target.closest(".chip"); if (!b) return;
      st.step = +b.dataset.v;
      $("#stepC").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
    });
    root.addEventListener("click", (e) => {
      const b = e.target.closest("[data-n]"); if (!b) return;
      const [which, dir] = b.dataset.n.split(":");
      st[which] = Math.round((st[which] + dir * st.step) * 1000) / 1000;
      clampSt(); show();
      if (which === "start") play(st.start, st.start + 2.5); else play(Math.max(w0, st.end - 2.5), st.end);
    });
    $("#pAyah").onclick = () => play(st.start, st.end);
    $("#pStart").onclick = () => play(Math.max(w0, st.start - 1), st.start + 2.5);
    $("#pEnd").onclick = () => play(Math.max(w0, st.end - 2.5), Math.min(w1, st.end + 1));
    $("#listen").onclick = () => {
      $("#mStart").hidden = false; $("#mEnd").hidden = false;
      play(Math.max(w0, st.start - 2), Math.min(w1, st.end + 1.5));
    };
    const mark = (which) => {
      if (preview.paused || playFrom == null) return;
      st[which] = Math.round((playFrom + preview.currentTime - S.markDelay) * 1000) / 1000;
      clampSt(); show();
    };
    $("#mStart").onclick = () => mark("start");
    $("#mEnd").onclick = () => mark("end");

    canvas.addEventListener("pointerdown", (e) => {
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left;
      const ds = Math.abs(x - t2x(st.start)), de = Math.abs(x - t2x(st.end));
      if (Math.min(ds, de) < 18) { drag = ds <= de ? "start" : "end"; canvas.setPointerCapture(e.pointerId); }
      else play(x2t(x), Math.min(w1, x2t(x) + 4));
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = canvas.getBoundingClientRect();
      st[drag] = Math.round(x2t(e.clientX - r.left) * 1000) / 1000; clampSt(); show();
    });
    canvas.addEventListener("pointerup", () => {
      if (!drag) return;
      const which = drag; drag = null;
      if (which === "start") play(st.start, st.start + 2.5); else play(Math.max(w0, st.end - 2.5), st.end);
    });

    $("#save").onclick = async () => {
      const v = { start: st.start, end: st.end, saved: Date.now() };
      await corrections.put(`${night}:${key(s, a)}`, v);
      reapplyFix(night, s, a, v);
      $("#reset").disabled = false;
      ctx.paintFlags(); ctx.restartLoopIfPlaying();
      toast(`Saved the timing of ${s}:${a}.`);
    };
    $("#reset").onclick = async () => {
      await corrections.del(`${night}:${key(s, a)}`);
      reapplyFix(night, s, a, null);
      const o = t.items[i];
      st.start = o.start; st.end = o.end; show();
      $("#reset").disabled = true;
      ctx.paintFlags(); ctx.restartLoopIfPlaying();
      toast(`Back to the original timing of ${s}:${a}.`);
    };
    $("#nextChk").onclick = async () => {
      const list = await flaggedList(S);
      const nxt = list.find((x) => cmp([x.s, x.a], [s, a]) > 0) || list[0];
      if (!nxt) { toast("No ayat are waiting to be checked."); return; }
      closeSheet();
      if (nxt.s !== ctx.ui.shown) ctx.showSurah(nxt.s, nxt.a);
      openCorrection(nxt.s, nxt.a, ctx);
    };
    $("#export").onclick = async () => {
      const all = await corrections.all();
      const blob = new Blob([JSON.stringify({ app: "tahajjud", exported: new Date().toISOString(), fixes: all }, null, 1)], { type: "application/json" });
      const file = new File([blob], "tahajjud-timing-fixes.json", { type: "application/json" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: "Timing fixes" }); return; } catch {}
      }
      const aEl = document.createElement("a");
      aEl.href = URL.createObjectURL(blob); aEl.download = file.name; aEl.click();
      setTimeout(() => URL.revokeObjectURL(aEl.href), 5000);
    };
    show();
    window.addEventListener("resize", draw, { once: true });
  });
}
