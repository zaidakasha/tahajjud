import { D, load, surah, ayahText, arNum, key, cmp, nextKey, juzOf, timings, source, recordingFor, nightInfo } from "./data.js";
import { loadSettings, saveSettings, audioStore, persist, usage } from "./store.js";
import { Engine, NoAudioError } from "./audio.js";
import { openCorrection, flaggedList } from "./correct.js";

const $ = (id) => document.getElementById(id);
const S = loadSettings();
const ui = { shown: 0, spans: new Map(), picking: null, userScrollAt: 0, saveT: 0 };
let engine;

// ---------- boot ----------

async function boot() {
  applyLook();
  try {
    await load();
  } catch (e) {
    $("page").innerHTML = `<p class="juz-mark">The app could not load its data (${e.message}). Check your connection and reopen it.</p>`;
    return;
  }
  engine = new Engine($("audio"), S, {
    onAyah, onState, onProgress, onError: toast, onLoopDone: () => toast("Loop finished."),
    command: (c) => ({ play: playPause, pause: () => engine.pause(), next: () => step(1), prev: () => step(-1) }[c]()),
  });
  const last = S.last || [1, 1];
  showSurah(last[0], last[1], false);
  wire();
  updateLoopStrip();
  $("speedBtn").textContent = fmtSpeed(S.speed);
  // offline cache; left off while testing on this computer unless ?sw=1
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !location.search.includes("sw=1");
  if ("serviceWorker" in navigator && !local) navigator.serviceWorker.register("sw.js").catch(() => {});
}

function save() {
  clearTimeout(ui.saveT);
  ui.saveT = setTimeout(() => saveSettings(S), 400);
}

function applyLook() {
  document.documentElement.dataset.theme = S.theme;
  document.documentElement.style.setProperty("--quran-size", `${S.fontSize}px`);
}

// ---------- reader ----------

function showSurah(s, focusA = 1, smooth = true) {
  const su = surah(s);
  ui.shown = s; ui.spans.clear();
  $("surahAr").textContent = su.name;
  $("surahEn").textContent = `${s}. ${su.tname}`;
  const page = $("page");
  page.textContent = "";
  const head = document.createElement("div");
  head.className = "surah-head";
  head.innerHTML = `<span class="name">سورة ${su.name}</span><span class="info">${su.ayas} ayat, ${su.type === "Meccan" ? "Makki" : "Madani"}</span>`;
  page.append(head);
  const juzStarts = new Map(D.meta.juz.map((p, i) => [key(p[0], p[1]), i + 1]));
  const frag = document.createDocumentFragment();
  for (let a = 1; a <= su.ayas; a++) {
    const j = juzStarts.get(key(s, a));
    if (j && !(s === 1 && a === 1)) {
      const m = document.createElement("span");
      m.className = "juz-mark"; m.textContent = `Juz ${j}`;
      frag.append(m);
    }
    const { basmala, body } = ayahText(s, a);
    if (basmala) {
      const b = document.createElement("div");
      b.className = "basmala"; b.dataset.s = s; b.dataset.a = 0; b.textContent = basmala;
      frag.append(b);
      ui.spans.set(key(s, 0), b);
    }
    const sp = document.createElement("span");
    sp.className = "ayah"; sp.dataset.s = s; sp.dataset.a = a;
    sp.append(body + " ");
    const n = document.createElement("span");
    n.className = "num"; n.textContent = `۝${arNum(a)}`;
    sp.append(n, " ");
    frag.append(sp);
    ui.spans.set(key(s, a), sp);
  }
  page.append(frag);
  paintRange(); paintNow(); paintFlags();
  updateNightChip(s);
  const target = ui.spans.get(key(s, focusA));
  if (target && focusA > 1) target.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  else $("reader").scrollTop = 0;
}

async function updateNightChip(s) {
  const chip = $("nightChip");
  const info = D.surahs[s];
  chip.dataset.alt = info.nights.filter((n) => n.complete).length > 1 || (S.recording[s] && S.recording[s] !== info.default) ? "1" : "0";
  const nights = new Set();
  const first = recordingFor(s, S);
  chip.textContent = `Night ${first}`;
  // which nights this surah will actually play from (it can run across nights)
  const su = surah(s);
  for (let a = 1; a <= su.ayas; a++) {
    const src = await source(s, a, S);
    if (ui.shown !== s) return;
    if (src) nights.add(src.night);
  }
  const ns = [...nights].sort((x, y) => x - y);
  chip.textContent = ns.length > 1 ? `Nights ${ns[0]}–${ns[ns.length - 1]}` : `Night ${ns[0] ?? first}`;
}

function paintNow() {
  document.querySelectorAll(".ayah.now, .basmala.now").forEach((e) => e.classList.remove("now"));
  if (!engine || !engine.cur) return;
  const el = ui.spans.get(key(engine.cur[0], engine.cur[1]));
  if (el) el.classList.add("now");
}

function paintRange() {
  document.querySelectorAll(".in-range").forEach((e) => e.classList.remove("in-range"));
  if (!S.loop) return;
  for (const [k, el] of ui.spans) {
    const [s, a] = k.split(":").map(Number);
    if (a && cmp([s, a], S.loop.from) >= 0 && cmp([s, a], S.loop.to) <= 0) el.classList.add("in-range");
  }
}

async function paintFlags() {
  document.querySelectorAll(".flagged").forEach((e) => e.classList.remove("flagged"));
  if (!S.showFlags) return;
  const s = ui.shown;
  for (const [k, el] of ui.spans) {
    const [ss, a] = k.split(":").map(Number);
    if (!a) continue;
    const src = await source(ss, a, S);
    if (ui.shown !== s) return;
    if (src && src.item.flags.includes("check") && !src.item.fixed) el.classList.add("flagged");
  }
}

function onAyah(s, a) {
  if (s !== ui.shown) showSurah(s, a || 1, false);
  paintNow();
  if (a) { S.last = [s, a]; save(); }
  const el = ui.spans.get(key(s, a));
  if (!el) return;
  const recent = Date.now() - ui.userScrollAt < 5000;
  if (S.autoScroll && !recent) {
    const r = el.getBoundingClientRect();
    const dockTop = window.innerHeight - $("app").querySelector(".dock").offsetHeight;
    if (r.top < 70 || r.bottom > dockTop - 20) el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  checkBackToNow();
}

function checkBackToNow() {
  const btn = $("backToNow");
  if (!engine || !engine.cur || !engine.playing) { btn.hidden = true; return; }
  const el = ui.spans.get(key(engine.cur[0], engine.cur[1]));
  if (!el) { btn.hidden = false; return; }
  const r = el.getBoundingClientRect();
  btn.hidden = r.bottom > 60 && r.top < window.innerHeight - 140;
}

// ---------- transport ----------

function onState(st) {
  $("playBtn").dataset.state = st;
  $("playBtn").setAttribute("aria-label", st === "playing" ? "Pause" : "Play");
  if (st !== "busy") checkBackToNow();
}

function onProgress(text, frac) {
  const p = $("progress");
  const inSheet = document.getElementById("sheetProgress");   // the dock is under an open sheet
  if (inSheet) inSheet.textContent = text ? (frac != null ? `${text}, ${Math.round(frac * 100)}%` : text) : "";
  if (!text) { p.hidden = true; return; }
  p.hidden = false;
  $("progressText").textContent = frac != null ? `${text} ${Math.round(frac * 100)}%` : text;
  $("progressBar").style.width = `${Math.round((frac || 0) * 100)}%`;
}

async function run(fn) {
  try {
    await fn();
  } catch (e) {
    onProgress(null);
    onState(engine.playing ? "playing" : "paused");
    if (e instanceof NoAudioError) {
      toast(`Night ${e.night} isn't on this phone yet.`, "Add audio", openLibrary);
    } else toast(e.message || String(e));
  }
}

function playPause() {
  engine.prime();
  if (engine.playing) { engine.pause(); return; }
  if (engine.mode !== "idle" && $("audio").currentTime > 0 && !engine.busy) { run(() => engine.resume()); return; }
  if (S.loop) { run(() => engine.playLoop(S.loop.from, S.loop.to)); return; }
  const [s, a] = S.last && S.last[0] === ui.shown ? S.last : [ui.shown, 1];
  run(() => engine.playFrom(s, a));
}

function step(dir) { engine.prime(); run(() => engine.step(dir)); }

function playAyah(s, a) {
  engine.prime();
  if (S.loop && cmp([s, a], S.loop.from) >= 0 && cmp([s, a], S.loop.to) <= 0) {
    if (engine.mode === "loop" && engine.clip) {
      const e = engine.clip.map.find((m) => m.s === s && m.a === a);
      if (e) {
        const base = Math.floor($("audio").currentTime / engine.clip.cycleDur) * engine.clip.cycleDur;
        $("audio").currentTime = base + e.c0;
        if (!engine.playing) run(() => engine.resume());
        return;
      }
    }
    run(() => engine.playLoop(S.loop.from, S.loop.to, [s, a]));
    return;
  }
  run(() => engine.playFrom(s, a));
}

function restartLoopIfPlaying() {
  if (engine && engine.mode === "loop" && S.loop) {
    const at = engine.cur && engine.cur[1] ? engine.cur : null;
    const was = engine.playing;
    run(async () => { await engine.playLoop(S.loop.from, S.loop.to, at); if (!was) engine.pause(); });
  }
}

// ---------- loop ----------

function fmtRef(k) { return `${k[0]}:${k[1]}`; }
function repeatText() {
  const r = S.rangeRepeat === 0 ? "repeating" : S.rangeRepeat === 1 ? "once" : `${S.rangeRepeat} times`;
  const k = S.ayahRepeat > 1 ? `, each ayah ${S.ayahRepeat} times` : "";
  return `${r}${k}`;
}

function updateLoopStrip() {
  const strip = $("loopStrip");
  $("loopBtn").setAttribute("aria-pressed", S.loop ? "true" : "false");
  if (!S.loop) { strip.hidden = true; return; }
  strip.hidden = false;
  const same = cmp(S.loop.from, S.loop.to) === 0;
  $("loopLabel").textContent = `Loop ${same ? fmtRef(S.loop.from) : `${fmtRef(S.loop.from)} to ${fmtRef(S.loop.to)}`}, ${repeatText()}`;
}

function setLoop(from, to) {
  if (cmp(from, to) > 0) [from, to] = [to, from];
  S.loop = { from, to }; save();
  updateLoopStrip(); paintRange();
  engine.prime();
  run(() => engine.playLoop(from, to));
}

function clearLoop() {
  S.loop = null; save();
  updateLoopStrip(); paintRange();
  if (engine.mode === "loop") {
    const cur = engine.cur;
    const was = engine.playing;
    engine.pause();
    if (cur && cur[1] && was) run(() => engine.playFrom(cur[0], cur[1]));
  }
}

function startPicking() {
  ui.picking = { step: 0 };
  const b = $("pickBanner");
  b.hidden = false; b.textContent = "Tap the first ayah of the loop";
}

function pick(s, a) {
  const b = $("pickBanner");
  if (ui.picking.step === 0) {
    ui.picking = { step: 1, from: [s, a] };
    ui.spans.get(key(s, a)).classList.add("pick-start");
    b.textContent = "Now tap the last ayah (tap the same one to loop just it)";
    return;
  }
  const from = ui.picking.from;
  document.querySelectorAll(".pick-start").forEach((e) => e.classList.remove("pick-start"));
  ui.picking = null; b.hidden = true;
  setLoop(from, [s, a]);
}

// ---------- gestures on the text ----------

function wire() {
  const page = $("page"), reader = $("reader");
  let press = null;
  page.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".ayah, .basmala");
    if (!el) return;
    press = { el, x: e.clientX, y: e.clientY, long: false,
      t: setTimeout(() => { press.long = true; ayahMenu(+el.dataset.s, +el.dataset.a || 1); }, 520) };
  });
  const cancel = () => { if (press) clearTimeout(press.t); press = null; };
  page.addEventListener("pointermove", (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancel(); });
  page.addEventListener("pointercancel", cancel);
  page.addEventListener("pointerup", () => {
    if (!press) return;
    clearTimeout(press.t);
    const { el, long } = press; press = null;
    if (long) return;
    const s = +el.dataset.s, a = +el.dataset.a || 1;
    if (ui.picking) pick(s, a); else playAyah(s, a);
  });
  page.addEventListener("contextmenu", (e) => e.preventDefault());
  const userScroll = () => { ui.userScrollAt = Date.now(); };
  reader.addEventListener("touchmove", userScroll, { passive: true });
  reader.addEventListener("wheel", userScroll, { passive: true });
  reader.addEventListener("scroll", () => requestAnimationFrame(checkBackToNow), { passive: true });

  $("playBtn").addEventListener("click", playPause);
  $("prevBtn").addEventListener("click", () => step(-1));
  $("nextBtn").addEventListener("click", () => step(1));
  $("loopBtn").addEventListener("click", () => {
    if (ui.picking) { ui.picking = null; $("pickBanner").hidden = true; document.querySelectorAll(".pick-start").forEach((e) => e.classList.remove("pick-start")); return; }
    if (S.loop) loopSheet(); else startPicking();
  });
  $("loopLabel").addEventListener("click", loopSheet);
  $("loopClear").addEventListener("click", clearLoop);
  $("speedBtn").addEventListener("click", speedSheet);
  $("surahBtn").addEventListener("click", surahSheet);
  $("nightChip").addEventListener("click", recordingSheet);
  $("settingsBtn").addEventListener("click", settingsSheet);
  $("backToNow").addEventListener("click", () => {
    ui.userScrollAt = 0;
    if (!engine.cur) return;
    if (engine.cur[0] !== ui.shown) showSurah(engine.cur[0], engine.cur[1]);
    const el = ui.spans.get(key(engine.cur[0], engine.cur[1]));
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  $("scrim").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSheet();
    if (e.target.closest("input, select, textarea") || !$("sheet").hidden) return;
    if (e.key === " ") { e.preventDefault(); playPause(); }
    if (e.key === "ArrowLeft") step(1);
    if (e.key === "ArrowRight") step(-1);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applyLook);
}

// ---------- sheets ----------

export function openSheet(html, onMount) {
  $("sheetBody").innerHTML = html;
  $("sheet").hidden = false; $("scrim").hidden = false;
  if (onMount) onMount($("sheetBody"));
}
export function closeSheet() {
  if ($("sheet").hidden) return;
  $("sheet").hidden = true; $("scrim").hidden = true;
  $("sheetBody").dispatchEvent(new Event("sheetclose"));
  $("sheetBody").innerHTML = "";
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function toast(msg, action, fn) {
  const t = $("toast");
  t.innerHTML = `${esc(msg)}${action ? ` <button class="btn" style="height:34px;margin-left:8px">${esc(action)}</button>` : ""}`;
  t.hidden = false;
  if (action) t.querySelector("button").onclick = () => { t.hidden = true; fn(); };
  clearTimeout(ui.toastT);
  ui.toastT = setTimeout(() => { t.hidden = true; }, action ? 8000 : 3500);
}

function chips(name, options, value) {
  return `<div class="chips" data-name="${name}">${options.map(([v, label]) =>
    `<button class="chip" data-v="${v}" aria-pressed="${String(v) === String(value)}">${label}</button>`).join("")}</div>`;
}
function bindChips(root, name, fn) {
  const box = root.querySelector(`.chips[data-name="${name}"]`);
  box.addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    box.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
    fn(b.dataset.v);
  });
}
const REPEAT_OPTS = [[1, "1"], [2, "2"], [3, "3"], [5, "5"], [7, "7"], [10, "10"], [0, "∞"]];
const AYAH_OPTS = [[1, "Off"], [2, "2"], [3, "3"], [5, "5"], [7, "7"], [10, "10"]];
const PAUSE_OPTS = [[0, "None"], [1, "1 s"], [2, "2 s"], [3, "3 s"], [5, "5 s"], [10, "10 s"]];

function repeatControls() {
  return `<h3>Repeat the range</h3>${chips("rr", REPEAT_OPTS, S.rangeRepeat)}
    <h3>Repeat each ayah before moving on</h3>${chips("ar", AYAH_OPTS, S.ayahRepeat)}
    <h3>Extra pause before the range repeats</h3>${chips("rp", PAUSE_OPTS, S.rangePause)}`;
}
function bindRepeat(root) {
  bindChips(root, "rr", (v) => { S.rangeRepeat = +v; save(); updateLoopStrip(); restartLoopIfPlaying(); });
  bindChips(root, "ar", (v) => { S.ayahRepeat = +v; save(); updateLoopStrip(); restartLoopIfPlaying(); });
  bindChips(root, "rp", (v) => { S.rangePause = +v; save(); restartLoopIfPlaying(); });
}

function surahOptions(sel) {
  return D.meta.suras.map((x) => `<option value="${x.n}" ${x.n === sel ? "selected" : ""}>${x.n}. ${esc(x.tname)}</option>`).join("");
}

function loopSheet() {
  const L = S.loop || { from: [ui.shown, 1], to: [ui.shown, Math.min(surah(ui.shown).ayas, 5)] };
  openSheet(`<h2>Loop</h2>
    <div class="field"><label>From</label><select id="lfS">${surahOptions(L.from[0])}</select><input id="lfA" type="number" min="1" inputmode="numeric" value="${L.from[1]}" style="width:84px"></div>
    <div class="field"><label>To</label><select id="ltS">${surahOptions(L.to[0])}</select><input id="ltA" type="number" min="1" inputmode="numeric" value="${L.to[1]}" style="width:84px"></div>
    ${repeatControls()}
    <div class="btn-row"><button class="btn primary" id="lGo">Start the loop</button>${S.loop ? `<button class="btn danger" id="lClear">Clear the loop</button>` : ""}</div>`,
  (root) => {
    bindRepeat(root);
    const clamp = (sid, aid) => { const s = +root.querySelector(sid).value; const a = Math.max(1, Math.min(surah(s).ayas, +root.querySelector(aid).value || 1)); return [s, a]; };
    root.querySelector("#lGo").onclick = () => { const f = clamp("#lfS", "#lfA"), t = clamp("#ltS", "#ltA"); closeSheet(); setLoop(f, t); };
    const c = root.querySelector("#lClear"); if (c) c.onclick = () => { closeSheet(); clearLoop(); };
  });
}

function ayahMenu(s, a) {
  const su = surah(s);
  openSheet(`<h2>${esc(su.tname)} ${s}:${a}</h2>
    <button class="menu-btn" data-act="play">Play from here</button>
    <button class="menu-btn" data-act="one">Loop this ayah</button>
    <button class="menu-btn" data-act="from">Start the loop here</button>
    <button class="menu-btn" data-act="to">End the loop here</button>
    <button class="menu-btn" data-act="fix">Fix this ayah's timing</button>
    <button class="menu-btn" data-act="copy">Copy the text</button>`,
  (root) => root.addEventListener("click", (e) => {
    const b = e.target.closest(".menu-btn"); if (!b) return;
    const act = b.dataset.act;
    closeSheet();
    if (act === "play") { engine.prime(); run(() => engine.playFrom(s, a)); }
    if (act === "one") setLoop([s, a], [s, a]);
    if (act === "from") setLoop([s, a], S.loop && cmp(S.loop.to, [s, a]) >= 0 ? S.loop.to : [s, a]);
    if (act === "to") setLoop(S.loop && cmp(S.loop.from, [s, a]) <= 0 ? S.loop.from : [s, a], [s, a]);
    if (act === "fix") openCorrection(s, a, ctx());
    if (act === "copy") {
      const { basmala, body } = ayahText(s, a);
      navigator.clipboard?.writeText(`${basmala ? basmala + " " : ""}${body} (${su.tname} ${s}:${a})`).then(() => toast("Copied."), () => toast("Copying isn't allowed here."));
    }
  }));
}

function speedSheet() {
  const presets = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5];
  openSheet(`<h2>Playback speed</h2>
    <input type="range" id="spd" min="0.5" max="2" step="0.05" value="${S.speed}" aria-label="Playback speed">
    <p id="spdV">${fmtSpeed(S.speed)}</p>
    ${chips("sp", presets.map((p) => [p, fmtSpeed(p)]), S.speed)}`,
  (root) => {
    const set = (v) => { engine.setSpeed(+v); $("speedBtn").textContent = fmtSpeed(+v); root.querySelector("#spdV").textContent = fmtSpeed(+v); save(); };
    root.querySelector("#spd").addEventListener("input", (e) => set(e.target.value));
    bindChips(root, "sp", (v) => { root.querySelector("#spd").value = v; set(v); });
  });
}
function fmtSpeed(v) { return `${(+v).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}×`; }

function surahSheet() {
  openSheet(`<h2>Go to</h2>
    <div class="field"><input type="search" id="q" placeholder="Surah name or number, or 2:255" style="flex:1" autocomplete="off"></div>
    <h3>Juz</h3><div class="chips" id="juz">${D.meta.juz.map((p, i) => `<button class="chip" data-s="${p[0]}" data-a="${p[1]}">${i + 1}</button>`).join("")}</div>
    <h3>Surahs</h3><div id="list"></div>`,
  (root) => {
    const list = root.querySelector("#list");
    const render = (q) => {
      q = q.trim().toLowerCase();
      list.innerHTML = D.meta.suras.filter((x) => !q || String(x.n) === q || x.tname.toLowerCase().includes(q) || x.ename.toLowerCase().includes(q) || x.name.includes(q))
        .map((x) => `<button class="row" data-s="${x.n}" style="width:100%;text-align:left"><span class="surah-num">${x.n}</span><span class="grow">${esc(x.tname)}<span class="sub">${esc(x.ename)}, ${x.ayas} ayat, night ${D.surahs[x.n].default ?? "none"}</span></span><span class="list-ar">${x.name}</span></button>`).join("");
    };
    render("");
    const q = root.querySelector("#q");
    q.addEventListener("input", () => render(q.value));
    q.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const m = /^(\d{1,3})\s*[:. ]\s*(\d{1,3})$/.exec(q.value.trim());
      if (m && D.meta.suras[+m[1] - 1]) { closeSheet(); showSurah(+m[1], Math.min(+m[2], surah(+m[1]).ayas)); flash(+m[1], +m[2]); }
    });
    list.addEventListener("click", (e) => { const b = e.target.closest("[data-s]"); if (b) { closeSheet(); showSurah(+b.dataset.s, 1); } });
    root.querySelector("#juz").addEventListener("click", (e) => { const b = e.target.closest("[data-s]"); if (b) { closeSheet(); showSurah(+b.dataset.s, +b.dataset.a); flash(+b.dataset.s, +b.dataset.a); } });
  });
}

function flash(s, a) {
  const el = ui.spans.get(key(s, a));
  if (!el) return;
  el.classList.add("pick-start");
  setTimeout(() => el.classList.remove("pick-start"), 1600);
}

function recordingSheet() {
  const s = ui.shown, su = surah(s), info = D.surahs[s];
  const cur = recordingFor(s, S);
  openSheet(`<h2>Recording of ${esc(su.tname)}</h2>
    <p>${info.nights.length > 1 ? "This surah was recited on more than one night. Choose which recording to play; ayat it doesn't have come from the other nights." : "This surah was recited on one night."}</p>
    ${info.nights.map((n) => `<button class="row" data-n="${n.night}" style="width:100%;text-align:left">
      <span class="grow">Night ${n.night}<span class="sub">${n.complete ? "The whole surah" : `${n.ayat} of ${su.ayas} ayat`}</span></span>
      ${n.night === cur ? `<span class="status-on">Playing this one</span>` : ""}</button>`).join("")}
    <p><a href="${nightInfo(cur).video}" target="_blank" rel="noopener">Open night ${cur} on YouTube</a></p>`,
  (root) => root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-n]"); if (!b) return;
    S.recording[s] = +b.dataset.n; save(); closeSheet();
    updateNightChip(s); paintFlags(); restartLoopIfPlaying();
    toast(`Playing night ${b.dataset.n} for ${su.tname}.`);
  }));
}

function settingsSheet() {
  openSheet(`<h2>Settings</h2>
    <h3>Text size</h3><input type="range" id="fs" min="22" max="46" step="1" value="${S.fontSize}" aria-label="Text size">
    <h3>Theme</h3>${chips("th", [["auto", "Match phone"], ["dark", "Dark"], ["light", "Light"]], S.theme)}
    <div class="row"><span class="grow">Follow the recitation<span class="sub">Scrolls to the ayah being recited</span></span><input type="checkbox" class="switch" id="as" ${S.autoScroll ? "checked" : ""}></div>
    <div class="row"><span class="grow">Skip the imam's repeats<span class="sub">Jumps over places where he repeated or corrected himself</span></span><input type="checkbox" class="switch" id="sr" ${S.skipRepeats ? "checked" : ""}></div>
    ${repeatControls()}
    <h3>Timings</h3>
    <div class="row"><span class="grow">Mark ayat to check<span class="sub">Underlines ayat whose timing may be off</span></span><input type="checkbox" class="switch" id="sf" ${S.showFlags ? "checked" : ""}></div>
    <div class="btn-row"><button class="btn" id="chk">Check flagged ayat</button></div>
    <h3>More</h3>
    <button class="menu-btn" id="lib">Audio on this phone</button>
    <button class="menu-btn" id="about">About and credits</button>`,
  (root) => {
    root.querySelector("#fs").addEventListener("input", (e) => { S.fontSize = +e.target.value; applyLook(); save(); });
    bindChips(root, "th", (v) => { S.theme = v; applyLook(); save(); });
    root.querySelector("#as").onchange = (e) => { S.autoScroll = e.target.checked; save(); };
    root.querySelector("#sr").onchange = (e) => { S.skipRepeats = e.target.checked; save(); restartLoopIfPlaying(); };
    root.querySelector("#sf").onchange = (e) => { S.showFlags = e.target.checked; save(); paintFlags(); };
    bindRepeat(root);
    root.querySelector("#chk").onclick = async () => {
      const list = await flaggedList(S);
      if (!list.length) { toast("No ayat are waiting to be checked."); return; }
      const f = list.find((x) => x.s === ui.shown) || list[0];
      openCorrection(f.s, f.a, ctx());
    };
    root.querySelector("#lib").onclick = openLibrary;
    root.querySelector("#about").onclick = aboutSheet;
  });
}

async function openLibrary() {
  const have = new Set(await audioStore.keys().catch(() => []));
  const est = await usage();
  // is the audio on this website, or does it have to be imported from the phone's files?
  if (ui.served === undefined) {
    ui.served = await fetch(D.nights[0].audio, { method: "HEAD", cache: "no-store" })
      .then((r) => r.ok && !(r.headers.get("content-type") || "").includes("html")).catch(() => false);
  }
  const total = D.nights.reduce((s, n) => s + n.bytes, 0);
  const mb = (b) => `${Math.round(b / 2 ** 20)} MB`;
  const covers = (n) => {
    const names = n.surahs.map((s) => surah(s).tname);
    const consecutive = n.surahs.every((s, i) => !i || s === n.surahs[i - 1] + 1);
    return names.length <= 2 ? names.join(", ") : consecutive ? `${names[0]} to ${names[names.length - 1]}` : names.join(", ");
  };
  openSheet(`<h2>Audio on this phone</h2>
    <p>${have.size} of ${D.nights.length} nights saved${est ? `, using ${mb(est.usage || 0)}` : ""}. Saved nights play offline.</p>
    ${ui.served ? `<p>A night downloads the first time you play it, or download them all now.</p>`
      : `<p>Copy the files night-01.mp3 to night-29.mp3 to this phone (AirDrop or iCloud Drive), then import them here. Select all 29 at once in the file picker.</p>`}
    <div class="btn-row">${ui.served ? `<button class="btn primary" id="all">Download all (${mb(total)})</button>` : ""}<label class="btn ${ui.served ? "" : "primary"}" style="display:inline-grid;place-items:center">Import MP3 files<input type="file" id="imp" accept=".mp3,audio/mpeg" multiple hidden></label></div>
    <p id="sheetProgress" class="status-on" aria-live="polite"></p>
    <div id="nights">${D.nights.map((n) => `<div class="row" data-n="${n.night}"><span class="grow">Night ${n.night}<span class="sub">${esc(covers(n))}, ${mb(n.bytes)}</span></span>
      ${have.has(n.night) ? `<span class="status-on">Saved</span> <button class="btn" data-del="${n.night}" style="height:34px">Remove</button>` : ui.served ? `<button class="btn" data-get="${n.night}" style="height:34px">Download</button>` : `<span class="sub">Not on this phone</span>`}</div>`).join("")}</div>`,
  (root) => {
    persist();
    const refresh = () => { if (!$("sheet").hidden && $("sheetBody").querySelector("#nights")) openLibrary(); };
    root.querySelector("#nights").addEventListener("click", async (e) => {
      const g = e.target.closest("[data-get]"), d = e.target.closest("[data-del]");
      if (g) { g.disabled = true; g.textContent = "Downloading"; await run(() => engine.blob(+g.dataset.get)); refresh(); }
      if (d) { await audioStore.del(+d.dataset.del); engine.blobs.delete(+d.dataset.del); refresh(); }
    });
    const allBtn = root.querySelector("#all");
    if (allBtn) allBtn.onclick = async (e) => {
      e.target.disabled = true;
      for (const n of D.nights) {
        if (have.has(n.night)) continue;
        try { await engine.blob(n.night); have.add(n.night); } catch (err) {
          onProgress(null);
          toast(err instanceof NoAudioError ? "The audio files aren't on the server. Import them from your phone's Files instead." : err.message);
          break;
        }
      }
      refresh();
    };
    root.querySelector("#imp").onchange = async (e) => {
      let ok = 0; const bad = [];
      const files = [...e.target.files];
      persist();
      for (const [i, f] of files.entries()) {
        onProgress(`Importing ${i + 1} of ${files.length}`, i / files.length);
        const m = /night-(\d{2})\.mp3$/i.exec(f.name);
        const n = m && nightInfo(+m[1]);
        if (!n || f.size !== n.bytes) { bad.push(f.name); continue; }
        try {
          // copy the bytes in: a File from the picker can stop being readable once the picker is gone
          const blob = new Blob([await f.arrayBuffer()], { type: "audio/mpeg" });
          await audioStore.put(n.night, blob); engine.blobs.delete(n.night); ok++;
        } catch (err) {
          bad.push(`${f.name} (${err.name === "QuotaExceededError" ? "phone storage is full" : err.message})`);
        }
      }
      onProgress(null);
      toast(`Imported ${ok} night${ok === 1 ? "" : "s"}.${bad.length ? ` Skipped ${bad.join(", ")}.` : ""}`);
      refresh();
    };
  });
}

function aboutSheet() {
  openSheet(`<h2>About and credits</h2>
    <p>Recitation from the Tahajjud nights of Ramadan 1446 (2025) at Alfurqan Islamic Centre, Manchester, from their
      <a href="https://www.youtube.com/playlist?list=PLSFZjjKC3qPawxyw0lFeBnO7g1MTBs-pc" target="_blank" rel="noopener">YouTube playlist</a>.
      For personal listening and memorization. Takbirs, ruku and sujood, the Fatiha after each night's first, and the duas were cut out; the recitation itself is unchanged.</p>
    <p>Quran text: <a href="https://tanzil.net" target="_blank" rel="noopener">Tanzil Project</a>, Uthmani text version 1.1, used verbatim under Tanzil's terms of use. Surah, juz and page data: Tanzil.info, CC BY.</p>
    <p>Ayah timings were made by aligning the audio against the Tanzil text with a Quran speech model. A few may be off by a fraction of a second; use "Fix this ayah's timing" to correct them.</p>
    <p>Fonts: Amiri Quran and Amiri by Khaled Hosny, Atkinson Hyperlegible by the Braille Institute (SIL Open Font License).</p>`);
}

export function ctx() {
  return { S, engine, save, toast, run, openSheet, closeSheet, showSurah, paintFlags, restartLoopIfPlaying, ui };
}

boot();
