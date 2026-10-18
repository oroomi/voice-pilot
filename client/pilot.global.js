/* voice-pilot, script-tag build: generated from client/pilot.js by tools/build_client.py; do not edit by hand.
   <script src="/pilot/client/pilot.global.js"></script> then VoicePilot.init({...}). */
(function () {
"use strict";
/* voice-pilot client: a voice assistant that talks AND drives the page. Zero dependencies, ES module (this file) or script tag (pilot.global.js).

     import VoicePilot from "/pilot/client/pilot.js";
     VoicePilot.init({ endpoint: "/pilot", manifest: "/pilot.manifest.json" });

   Talk: the mic button opens a translucent overlay with an orb that follows the audio. Speech recognition (Web Speech API, continuous) waits for a
   real pause (pauseMs, default 1.5 s) before it sends; a tap on the orb sends at once; Escape closes. The answer streams from POST {endpoint}/chat
   (Server-Sent Events: status, delta, action, error, done) and is spoken sentence group by sentence group ("beats") with the server voice
   (POST {endpoint}/tts, ElevenLabs) or, when that fails or is off, the browser's speechSynthesis.

   Drive: the model calls UI tools and the server turns each valid call into an `action` event with a cue number n; the answer text carries [[n]] at
   the start of the sentence the action belongs with. Timing rule (docs/ACTIONS.md): an action fires immediately before the beat that holds its cue
   starts playing; actions always run in the order the model called them (an earlier action that has not run yet is pulled forward); actions whose
   cue never appears are spread over the beats not yet spoken. Built-in actions: navigate (fetch the page and swap [data-pilot-main], so the voice
   session survives; or the host's SPA router through opts.navigate), scroll_to, highlight (dimmed spotlight with a caption), click (only
   [data-pilot-safe] elements), fill, wait. Targets are data-pilot ids declared in the page, never CSS from the model; a target that is not on the
   page is skipped and reported back to the model with the next question. */

const VERSION = "0.1.0";
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA=";
const CUE = /\[\[?\s*(\d{1,2})\s*\]\]?/g;
const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+/g;
const DEFAULTS = {
  endpoint: "/pilot",            // POST {endpoint}/chat, POST {endpoint}/tts, GET {endpoint}/status
  name: null,                    // the assistant's name; null = what /status says (PILOT_ASSISTANT_NAME), else "Aava"
  manifest: null,                // URL of pilot.manifest.json, or the object itself: {app:{name,description}, pages:[{path,title,desc,targets?,sample?}]}
  regions: "[data-pilot-main], [data-pilot-region]",   // what navigate swaps
  navigate: null,                // async (path) => {} for SPA routers (Next.js router.push, React Router navigate); resolve when the new page is on screen
  pauseMs: 1500,                 // this much quiet ends the question
  lang: "en-US",
  voice: "auto",                 // "auto" (server voice when /status says so, else browser), "browser", "off"
  launcher: true,                // the floating mic button
  autoDock: true,                // shrink the overlay to a floating orb when the tour starts moving the page
  crawl: true,                   // fetch the manifest's pages once to learn their data-pilot targets
  interceptLinks: true,          // while the pilot is open, same-origin link clicks swap the page instead of reloading it
  history: 8,                    // conversation turns sent with each question
  listenAfterAnswer: false,      // open the microphone again when an answer ends
  holdSpotlightMs: 3500,         // how long the last spotlight stays after the answer ends
  mount: null                    // element to mount into (default document.body)
};

let instance = null;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = (n) => new Promise((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
const clean = (s) => String(s || "").replace(CUE, "").replace(/\s+/g, " ").trim();
const estMs = (text) => Math.max(1400, clean(text).length * 62);
function sameOriginPath(href) {
  try {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) return null;
    return u.pathname + u.search + u.hash;
  } catch (e) { return null; }
}
const ICON_MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 1 0-7 0v5A3.5 3.5 0 0 0 12 15Z"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_DOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 20h6v-6M20 20l-7-7M4 10V4h6"/></svg>';
const ICON_EXPAND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10V4h6M4 4l7 7M20 14v6h-6"/></svg>';

/* ================================================================================================================================ */
/* Manifest: what the model can show. The live page's [data-pilot] elements plus the pages of pilot.manifest.json (and their targets). */
/* ================================================================================================================================ */
function describe(node, live) {
  const d = node.dataset || {};
  const t = { id: d.pilot, desc: d.pilotDesc || node.getAttribute("aria-label") || node.getAttribute("title") || "" };
  const txt = (live ? node.innerText : node.textContent) || "";
  const text = txt.replace(/\s+/g, " ").trim();
  if (text && !/^(input|select|textarea)$/i.test(node.tagName)) t.text = text.slice(0, 200);
  const a = node.matches("a[href]") ? node : node.querySelector("a[href]");
  const href = a && sameOriginPath(a.getAttribute("href"));
  if (href) t.href = href;
  if (node.hasAttribute("data-pilot-safe") && d.pilotSafe !== "false") t.safe = true;
  if (/^(input|select|textarea)$/i.test(node.tagName)) {
    const f = { kind: node.tagName.toLowerCase() === "select" ? "select" : (node.getAttribute("type") || node.tagName).toLowerCase() };
    if (f.kind === "select") f.options = [...node.options].map((o) => (o.textContent || o.value).trim()).filter(Boolean).slice(0, 30);
    if (live && node.value) f.value = node.tagName.toLowerCase() === "select" && node.selectedOptions[0] ? node.selectedOptions[0].textContent.trim() : node.value;
    t.fill = f;
  }
  return t;
}
function visible(node) { return !node.closest("[hidden]") && node.getClientRects().length > 0; }
function collect(root, live) {
  const seen = new Set();
  return [...root.querySelectorAll("[data-pilot]")].filter((n) => !live || visible(n)).map((n) => describe(n, live))
    .filter((t) => t.id && !seen.has(t.id) && seen.add(t.id)).slice(0, 80);
}

/* ================================================================================================================================ */
/* The voice out: server clips (ElevenLabs via /tts) or the browser voice, an analyser for the orb, a token so a stop wins every race.   */
/* ================================================================================================================================ */
class Speaker {
  constructor(p) {
    this.p = p; this.audio = null; this.ctx = null; this.an = null; this.buf = null; this.token = 0; this.kick = 0; this.synthOn = false;
    this.synth = "speechSynthesis" in window ? window.speechSynthesis : null;
    this.server = null;                         // null = not known yet; false after a failure (the rest of the session uses the browser voice)
  }
  ensure() {
    if (this.audio) return;
    this.audio = el("audio"); this.audio.preload = "auto"; this.audio.setAttribute("playsinline", ""); this.audio.hidden = true;
    document.body.appendChild(this.audio);
  }
  unlock() {                                    /* inside a tap: mobile browsers only start audio and speech from a gesture */
    this.ensure();
    const C = window.AudioContext || window.webkitAudioContext;
    if (!this.ctx && C) { try { this.ctx = new C(); } catch (e) { this.ctx = null; } }
    if (this.ctx && this.ctx.state === "suspended" && this.ctx.resume) this.ctx.resume().catch(() => {});
    try { this.audio.onended = null; this.audio.src = SILENT; const pr = this.audio.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
    try { if (this.synth && !this.synth.speaking) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; this.synth.speak(u); } } catch (e) {}
  }
  tap() {                                       /* the clip through an analyser, once (an element can be a source only once); never while suspended */
    if (this.an || !this.ctx || this.ctx.state !== "running") return;
    try {
      const src = this.ctx.createMediaElementSource(this.audio);
      this.an = this.ctx.createAnalyser(); this.an.fftSize = 256; this.an.smoothingTimeConstant = 0.6;
      src.connect(this.an); this.an.connect(this.ctx.destination); this.buf = new Uint8Array(this.an.fftSize);
    } catch (e) { this.an = null; }
  }
  level() {
    const now = performance.now();
    if (this.an && this.audio && !this.audio.paused) {
      this.an.getByteTimeDomainData(this.buf);
      let s = 0;
      for (let i = 0; i < this.buf.length; i++) { const v = (this.buf[i] - 128) / 128; s += v * v; }
      return Math.min(1, Math.sqrt(s / this.buf.length) * 4.2);
    }
    if (this.synthOn || (this.audio && !this.audio.paused)) { this.kick = Math.max(this.kick * 0.92, 0.45 + 0.4 * Math.sin(now / 160)); return 0.2 + 0.6 * this.kick * (0.7 + 0.3 * Math.sin(now / 53)); }
    return 0;
  }
  async clip(text) {                            /* a server clip for this text, or null (then the browser voice speaks) */
    const mode = this.p.opts.voice;
    if (mode === "off" || mode === "browser" || this.server === false) return null;
    if (this.server === null && this.p.status && this.p.status.tts === false && mode === "auto") return null;
    const spoken = clean(text);
    if (!spoken) return null;
    try {
      const r = await fetch(this.p.url("/tts"), { method: "POST", headers: { "Content-Type": "application/json", Accept: "audio/mpeg" }, body: JSON.stringify({ text: spoken }) });
      if (!r.ok) throw new Error("tts " + r.status);
      const b = await r.blob();
      if (!b.size) throw new Error("tts empty");
      this.server = true;
      return URL.createObjectURL(b);
    } catch (e) {
      this.server = false;
      this.p.trace("tts-fallback", { why: String(e && e.message || e) });
      return null;
    }
  }
  stop() {
    this.token += 1; this.synthOn = false;
    try { if (this.synth && (this.synth.speaking || this.synth.pending)) this.synth.cancel(); } catch (e) {}
    if (this.audio) { this.audio.onended = null; this.audio.onerror = null; try { this.audio.pause(); } catch (e) {} }
  }
  /* Speak one beat. onProgress(0..1) drives the word-by-word caption. Resolves when it is over (or stopped). */
  say(text, url, onProgress) {
    const my = ++this.token;
    return new Promise((resolve) => {
      let over = false;
      const end = () => { if (over) return; over = true; this.synthOn = false; if (onProgress) onProgress(1); resolve(my === this.token); };
      const byTime = () => {                    /* no voice at all: the words are still written, at reading pace */
        const t0 = performance.now(), ms = estMs(text);
        const tick = () => { if (my !== this.token) return end(); const f = (performance.now() - t0) / ms; if (onProgress) onProgress(Math.min(1, f)); if (f >= 1) end(); else requestAnimationFrame(tick); };
        tick();
      };
      const synth = () => {
        if (my !== this.token) return end();
        if (!this.synth || this.p.opts.voice === "off") return byTime();
        const u = new SpeechSynthesisUtterance(clean(text)), v = this.pickVoice();
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = this.p.opts.lang;
        u.rate = 1; u.pitch = 1.02;
        let started = false;
        u.onstart = () => { started = true; this.synthOn = true; };
        u.onboundary = (e) => { if (my === this.token && onProgress) { this.kick = 1; onProgress(Math.min(1, ((e.charIndex || 0) + 4) / Math.max(1, u.text.length))); } };
        u.onend = end; u.onerror = () => { if (!over) end(); };
        this.p.trace("speak", { voice: "browser", text: clean(text) });
        try { this.synth.speak(u); } catch (e) { return byTime(); }
        const t0 = performance.now(), ms = estMs(text);
        const follow = () => {                  /* browsers without boundary events: progress by the clock */
          if (over || my !== this.token) return;
          if (started && onProgress) onProgress(Math.min(0.98, (performance.now() - t0) / ms));
          requestAnimationFrame(follow);
        };
        follow();
        setTimeout(() => { if (!over && !started && my === this.token) { this.synthOn = true; } }, 1200);
        setTimeout(() => { if (!over) end(); }, ms * 2 + 3000);        /* some browsers never fire onend */
      };
      if (!url) return synth();
      this.ensure(); this.tap();
      const a = this.audio;
      a.onended = () => { if (my === this.token) end(); };
      a.onerror = () => { if (my === this.token) { a.onended = null; a.onerror = null; this.server = false; synth(); } };
      a.src = url;
      this.p.trace("speak", { voice: "server", text: clean(text) });
      const pr = a.play();
      if (pr && pr.catch) pr.catch((err) => { if (my === this.token && (!err || err.name !== "AbortError")) { this.server = false; synth(); } });
      const follow = () => {
        if (over || my !== this.token) return;
        if (onProgress && a.duration && isFinite(a.duration)) onProgress(Math.min(1, a.currentTime / a.duration));
        requestAnimationFrame(follow);
      };
      follow();
    });
  }
  pickVoice() {
    const vs = this.synth ? this.synth.getVoices() : [];
    const lang = (this.p.opts.lang || "en").slice(0, 2).toLowerCase();
    const mine = vs.filter((v) => (v.lang || "").toLowerCase().startsWith(lang));
    const nice = /natural|neural|premium|enhanced|samantha|serena|aria|jenny|libby|sonia|google uk english female|google us english/i;
    return mine.sort((a, b) => (nice.test(b.name) ? 1 : 0) - (nice.test(a.name) ? 1 : 0))[0] || null;
  }
}

/* ================================================================================================================================ */
/* The orb: one canvas, drawn from the skin's tokens (--vp-accent, --vp-accent-2, --vp-ink), level from the mic or the voice.          */
/* ================================================================================================================================ */
class Orb {
  constructor(p, canvas) { this.p = p; this.cv = canvas; this.cx = canvas.getContext("2d"); this.raf = 0; this.lvl = 0; this.ripples = []; this.lastPeak = 0; }
  colors() {
    const cs = getComputedStyle(this.p.root);
    const rgb = (s, d) => {
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = d; c.fillStyle = String(s || "").trim() || d;
      const v = c.fillStyle;
      if (v[0] === "#") return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
      const m = v.match(/[\d.]+/g) || [0, 0, 0]; return [+m[0], +m[1], +m[2]];
    };
    this.c = { a: rgb(cs.getPropertyValue("--vp-accent"), "#22d3ee"), b: rgb(cs.getPropertyValue("--vp-accent-2"), "#6366f1"), ink: rgb(cs.getPropertyValue("--vp-ink"), "#e6f6ff") };
  }
  start() {
    this.colors();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = this.cv.height = Math.round(240 * dpr);
    cancelAnimationFrame(this.raf); this.t0 = performance.now();
    const frame = (now) => { this.raf = requestAnimationFrame(frame); this.draw(now); };
    this.raf = requestAnimationFrame(frame);
  }
  stop() { cancelAnimationFrame(this.raf); this.ripples = []; }
  draw(now) {
    const p = this.p, st = p.state, motion = !p.reduced();
    const want = st === "listening" ? p.micLevel() : st === "speaking" ? p.speaker.level() : 0;
    this.lvl += (want - this.lvl) * (want > this.lvl ? 0.35 : 0.08);
    const t = (now - this.t0) / 1000, breathe = motion ? Math.sin(t * 1.6) * 0.5 + 0.5 : 0;
    const base = st === "thinking" ? 0.22 : st === "listening" ? 0.12 : st === "speaking" ? 0.1 : 0.05;
    const e = motion ? Math.min(1, base + this.lvl * 0.9 + breathe * 0.06) : (st === "listening" || st === "speaking" ? 0.5 : 0.25);
    p.root.style.setProperty("--vp-level", Math.min(1, this.lvl + (st === "thinking" ? 0.15 : 0.04)).toFixed(3));
    const { a, b, ink } = this.c, cx = this.cx, W = this.cv.width, c = W / 2, R = W / 2;
    const rgba = (k, al) => `rgba(${k[0]},${k[1]},${k[2]},${Math.max(0, Math.min(1, al))})`;
    const mix = (x, y, k) => x.map((v, i) => Math.round(v * (1 - k) + y[i] * k));
    cx.clearRect(0, 0, W, W);
    const core = R * 0.52 * (1 + (motion ? 0.16 * e : 0));
    const halo = cx.createRadialGradient(c, c, core * 0.6, c, c, R);
    halo.addColorStop(0, rgba(a, 0.28 + 0.3 * e)); halo.addColorStop(0.6, rgba(b, 0.08 + 0.08 * e)); halo.addColorStop(1, rgba(a, 0));
    cx.fillStyle = halo; cx.fillRect(0, 0, W, W);
    if (motion && (st === "listening" || st === "speaking") && this.lvl > 0.38 && now - this.lastPeak > 360) { this.ripples.push(now); this.lastPeak = now; }
    this.ripples = this.ripples.filter((r) => now - r < 1500);
    for (const r of this.ripples) {
      const k = (now - r) / 1500;
      cx.beginPath(); cx.arc(c, c, core * 1.04 + (R * 0.96 - core * 1.04) * k, 0, 6.2832);
      cx.strokeStyle = rgba(mix(a, ink, 0.4), 0.45 * (1 - k)); cx.lineWidth = 2; cx.stroke();
    }
    cx.save(); cx.beginPath(); cx.arc(c, c, core, 0, 6.2832); cx.clip();
    const body = cx.createRadialGradient(c - core * 0.3, c - core * 0.35, core * 0.1, c, c, core);
    body.addColorStop(0, rgba(mix(a, ink, 0.55), 0.96)); body.addColorStop(0.55, rgba(a, 0.95)); body.addColorStop(1, rgba(mix(b, [0, 0, 0], 0.25), 0.98));
    cx.fillStyle = body; cx.fillRect(0, 0, W, W);
    cx.globalCompositeOperation = "lighter";
    const spin = motion ? t * (st === "thinking" ? 1.8 : 0.5) : 0.7, tints = [mix(a, ink, 0.5), b, a];
    for (let i = 0; i < 3; i++) {
      const ang = spin + i * 2.094, off = core * (0.16 + 0.3 * e);
      const bx = c + Math.cos(ang) * off, by = c + Math.sin(ang * 1.1 + i) * off * 0.9, br = core * (0.95 - i * 0.07);
      const g = cx.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, rgba(tints[i], 0.26 + 0.14 * e)); g.addColorStop(1, rgba(tints[i], 0));
      cx.fillStyle = g; cx.fillRect(0, 0, W, W);
    }
    cx.globalCompositeOperation = "source-over";
    const hl = cx.createRadialGradient(c - core * 0.32, c - core * 0.42, 0, c - core * 0.32, c - core * 0.42, core * 0.6);
    hl.addColorStop(0, rgba([255, 255, 255], 0.36)); hl.addColorStop(1, rgba([255, 255, 255], 0));
    cx.fillStyle = hl; cx.fillRect(0, 0, W, W);
    cx.restore();
    cx.beginPath(); cx.arc(c, c, core, 0, 6.2832); cx.strokeStyle = rgba(ink, 0.25); cx.lineWidth = 1.5; cx.stroke();
    if (st === "thinking") {
      cx.beginPath();
      if (motion) cx.arc(c, c, core * 1.17, t * 3.2, t * 3.2 + 1.4); else { cx.setLineDash([6, 8]); cx.arc(c, c, core * 1.17, 0, 6.2832); }
      cx.strokeStyle = rgba(mix(a, ink, 0.4), 0.9); cx.lineWidth = 3; cx.lineCap = "round"; cx.stroke(); cx.setLineDash([]);
    }
  }
}

/* ================================================================================================================================ */
/* The narrator: streamed text -> sentences -> beats (groups that play as one clip), each with the actions whose cues it holds.          */
/* ================================================================================================================================ */
class Narrator {
  constructor(p) { this.p = p; this.gen = 0; this.reset(); }
  reset() {
    this.gen += 1; this.raw = ""; this.used = 0; this.step = 0; this.beats = []; this.actions = new Map(); this.done = false;
    this.next = 0; this.running = false; this.audioChain = Promise.resolve(); this.finishedOnce = false; this.closedTo = -1;
  }
  action(a) { if (a && a.id != null) this.actions.set(Number(a.id), Object.assign({}, a, { id: Number(a.id), state: "pending", at: this.raw.length })); }
  delta(text, step) {
    if (step != null && step !== this.step) { if (this.raw && !/\s$/.test(this.raw)) this.raw += " "; this.step = step; }
    this.raw += text;
    this.cut(false);
  }
  end() { this.done = true; this.cut(true); this.spreadUnanchored(); this.closeTo(this.beats.length - 1); this.pump(); }
  cut(final) {
    const rest = this.raw.slice(this.used);
    let m, last = 0;
    const out = [];
    SENTENCE_END.lastIndex = 0;
    while ((m = SENTENCE_END.exec(rest))) { out.push([rest.slice(last, m.index + m[0].length), this.used + last]); last = m.index + m[0].length; }
    if (final && rest.slice(last).trim()) { out.push([rest.slice(last), this.used + last]); last = rest.length; }
    this.used += last;
    out.forEach(([s, start]) => this.sentence(s, start));
  }
  sentence(s, start) {
    const ids = [];
    s.replace(CUE, (_, n) => { if (this.actions.has(Number(n))) ids.push(Number(n)); return ""; });
    const text = clean(s);
    if (!text && !ids.length) return;
    const cur = this.beats[this.beats.length - 1];
    const canJoin = cur && !cur.started && !ids.length && this.beats.length > 1 && (cur.text.length + text.length) < 260;
    if (canJoin) { cur.text += " " + text; return; }
    if (cur && !text && ids.length && !cur.started) { cur.actions.push(...ids); return; }   /* a cue alone ("[[3]]") joins the beat before it */
    this.beats.push({ i: this.beats.length, text, actions: ids, started: false, audio: null, start: start || 0 });
    if (this.beats.length === 1) this.closeTo(0);              /* the first sentence plays as soon as it is written */
    else this.closeTo(this.beats.length - 2);
    this.pump();
  }
  closeTo(i) {                                                  /* beats up to i are complete: fetch their audio, in order */
    for (let k = this.closedTo + 1; k <= i; k++) {
      const b = this.beats[k];
      if (!b) continue;
      b.closed = true;
      const gen = this.gen;
      this.audioChain = this.audioChain.then(() => (gen === this.gen ? this.p.speaker.clip(b.text) : null));
      b.audio = this.audioChain;
      this.closedTo = k;
    }
  }
  spreadUnanchored() {                                          /* actions whose cue never appeared: one per beat not yet spoken, in order */
    const anchored = new Set(this.beats.flatMap((b) => b.actions));
    const loose = [...this.actions.keys()].filter((id) => !anchored.has(id) && this.actions.get(id).state === "pending").sort((x, y) => x - y);
    if (!loose.length) return;
    const open = this.beats.filter((b) => !b.started);
    if (!open.length) { this.p.runActions(loose.map((id) => this.actions.get(id))); return; }
    loose.forEach((id, k) => open[Math.min(k, open.length - 1)].actions.push(id));
  }
  pump() {
    if (this.running) return;
    const b = this.beats[this.next];
    if (!b) { if (this.done && !this.finishedOnce) { this.finishedOnce = true; this.p.answerEnded(); } return; }
    if (!b.closed) return;
    this.running = true;
    const gen = this.gen;
    this.play(b).then(() => { if (gen !== this.gen) return; this.running = false; this.next += 1; this.pump(); });
  }
  async play(b) {
    const gen = this.gen, p = this.p;
    b.started = true;
    if (!b.actions.length && !/\[\[?\s*\d{1,2}\s*\]\]?/.test(this.raw)) {
      /* the model wrote no cues at all (so far): this beat takes the next pending actions, up to and including one highlight. Only actions
         that arrived before this beat's words began: a lead-in said while the tools ran ("Let me pull that up.") takes none. */
      for (const a of [...this.actions.values()].filter((x) => x.state === "pending" && x.at <= b.start).sort((x, y) => x.id - y.id)) {
        b.actions.push(a.id);
        if (a.type === "highlight") break;
      }
    }
    /* every pending action called before this beat's own runs first, then the beat's: the model's order always holds */
    const top = b.actions.length ? Math.max(...b.actions) : 0;
    const due = [...this.actions.values()].filter((a) => a.state === "pending" && (a.id <= top || b.actions.includes(a.id))).sort((x, y) => x.id - y.id);
    due.forEach((a) => { a.state = "queued"; });
    const firstSpot = due.findIndex((a) => a.type === "highlight");
    const pre = firstSpot < 0 ? due : due.slice(0, firstSpot), timed = firstSpot < 0 ? [] : due.slice(firstSpot);
    p.trace("beat", { i: b.i, text: b.text, actions: due.map((a) => a.id) });
    for (const a of pre) { if (gen !== this.gen) return; await p.exec(a); }
    const url = await b.audio;
    if (gen !== this.gen) return;
    const ms = estMs(b.text);
    let chain = Promise.resolve();
    timed.forEach((a, k) => {
      const at = performance.now() + (k === 0 ? 0 : (ms * k) / timed.length);
      chain = chain.then(() => sleep(Math.max(0, at - performance.now()))).then(() => (gen === this.gen ? p.exec(a) : null));
    });
    if (timed.length) await Promise.race([chain, sleep(700)]);   /* the first spotlight lands (scroll) before the words start */
    if (gen !== this.gen) return;
    if (!b.text) { await chain; return; }
    p.setState("speaking");
    const words = p.showBeat(b.text);
    await p.speaker.say(b.text, url, (f) => words(f));
    await chain;
    if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
  }
}

/* ================================================================================================================================ */
/* The pilot                                                                                                                        */
/* ================================================================================================================================ */
class Pilot {
  constructor(opts) {
    this.opts = Object.assign({}, DEFAULTS, opts || {});
    this.state = "idle"; this.mode = "closed"; this.status = null; this.messages = []; this.reports = []; this.log = [];
    this.listeners = {}; this.seq = 0; this.rec = null; this.mic = null; this.micKick = 0; this.pages = null; this.spotTarget = null;
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.touch = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
    this.speaker = new Speaker(this);
    this.narrator = new Narrator(this);
    this.build();
    this.wire();
    this.fetchStatus();
  }
  url(path) { return this.opts.endpoint.replace(/\/$/, "") + path; }
  reduced() { return !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches); }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return () => { this.listeners[ev] = this.listeners[ev].filter((f) => f !== fn); }; }
  emit(ev, detail) {
    (this.listeners[ev] || []).forEach((fn) => { try { fn(detail); } catch (e) { console.error(e); } });
    document.dispatchEvent(new CustomEvent("pilot:" + ev, { detail }));
  }
  trace(kind, data) { const e = Object.assign({ kind, t: Math.round(performance.now()) }, data || {}); this.log.push(e); if (this.log.length > 400) this.log.shift(); }
  get name() { return this.opts.name || (this.status && this.status.name) || "Aava"; }

  /* ---- DOM --------------------------------------------------------------------------------------------------------------------- */
  build() {
    const root = this.root = el("div", "vp");
    root.dataset.mode = "closed"; root.dataset.state = "idle";
    const launch = this.launchBtn = el("button", "vp-launch"); launch.type = "button";
    launch.innerHTML = ICON_MIC; launch.setAttribute("aria-label", "Talk to the assistant"); launch.hidden = !this.opts.launcher;
    const ov = this.ov = el("div", "vp-overlay");
    ov.setAttribute("role", "dialog"); ov.setAttribute("aria-label", "Voice assistant"); ov.hidden = true;
    ov.appendChild(el("div", "vp-backdrop"));
    const top = el("div", "vp-top");
    this.elName = el("span", "vp-name", "Aava"); this.elBadge = el("span", "vp-badge"); this.elBadge.hidden = true;
    const who = el("div", "vp-who"); who.append(this.elName, this.elBadge);
    this.dockBtn = el("button", "vp-icon vp-dock"); this.dockBtn.type = "button"; this.dockBtn.innerHTML = ICON_DOCK; this.dockBtn.setAttribute("aria-label", "Shrink to the corner");
    this.closeBtn = el("button", "vp-icon vp-close"); this.closeBtn.type = "button"; this.closeBtn.innerHTML = ICON_X; this.closeBtn.setAttribute("aria-label", "Close");
    const btns = el("div", "vp-btns"); btns.append(this.dockBtn, this.closeBtn);
    top.append(who, btns);
    const stage = el("div", "vp-stage");
    this.elState = el("p", "vp-state"); this.elState.setAttribute("aria-live", "polite");
    this.elHeard = el("p", "vp-heard");
    this.elSay = el("p", "vp-say"); this.elSay.setAttribute("aria-live", "polite");
    this.typeForm = el("form", "vp-type"); this.typeForm.hidden = true;
    this.typeIn = el("input"); this.typeIn.type = "text"; this.typeIn.placeholder = "Type a question"; this.typeIn.setAttribute("aria-label", "Type a question"); this.typeIn.maxLength = 500;
    const send = el("button", "vp-send", "Ask"); send.type = "submit";
    this.typeForm.append(this.typeIn, send);
    this.typeBtn = el("button", "vp-link", "Type instead"); this.typeBtn.type = "button";
    stage.append(this.elState, this.elHeard, this.elSay, this.typeForm, this.typeBtn);
    ov.append(top, stage);
    const orb = this.orbBtn = el("button", "vp-orb"); orb.type = "button"; orb.setAttribute("aria-label", "Tap to talk"); orb.hidden = true;
    const cv = el("canvas"); cv.setAttribute("aria-hidden", "true"); orb.appendChild(cv);
    this.orb = new Orb(this, cv);
    const bubble = this.bubble = el("div", "vp-bubble"); bubble.hidden = true;
    this.bubText = el("p", "vp-bubble-text"); this.bubState = el("span", "vp-bubble-state");
    this.expandBtn = el("button", "vp-icon vp-expand"); this.expandBtn.type = "button"; this.expandBtn.innerHTML = ICON_EXPAND; this.expandBtn.setAttribute("aria-label", "Open the full view");
    const bubClose = this.bubClose = el("button", "vp-icon vp-bclose"); bubClose.type = "button"; bubClose.innerHTML = ICON_X; bubClose.setAttribute("aria-label", "Close");
    const bhead = el("div", "vp-bubble-head"); bhead.append(this.bubState, this.expandBtn, bubClose);
    bubble.append(bhead, this.bubText);
    const spot = this.spot = el("div", "vp-spot"); spot.hidden = true;
    this.spotLabel = el("div", "vp-spot-label"); this.spotLabel.hidden = true;
    root.append(spot, this.spotLabel, ov, bubble, orb, launch);
    (this.opts.mount || document.body).appendChild(root);
  }
  wire() {
    this.launchBtn.addEventListener("click", () => this.open());
    this.closeBtn.addEventListener("click", () => this.close());
    this.bubClose.addEventListener("click", () => this.close());
    this.dockBtn.addEventListener("click", () => this.dock(true));
    this.expandBtn.addEventListener("click", () => this.dock(false));
    this.orbBtn.addEventListener("click", () => this.orbTap());
    this.typeBtn.addEventListener("click", () => { this.stopAll(); this.setState("idle", "Type your question."); this.showType(); });
    this.typeForm.addEventListener("submit", (e) => { e.preventDefault(); const v = this.typeIn.value; this.typeIn.value = ""; this.speaker.unlock(); this.ask(v); });
    document.addEventListener("keydown", (e) => {
      if (this.mode === "closed") return;
      if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
      if (e.key === "Tab" && this.mode === "full") {            /* focus stays inside the dialog */
        const f = [...this.root.querySelectorAll(".vp-overlay button, .vp-overlay input, .vp-orb")].filter((n) => !n.hidden && !n.closest("[hidden]") && n.getClientRects().length);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }, true);
    document.addEventListener("click", (e) => {                 /* [data-pilot-open] and [data-pilot-ask="question"] anywhere on the page */
      const t = e.target.closest && e.target.closest("[data-pilot-open], [data-pilot-ask]");
      if (t && !this.root.contains(t)) { e.preventDefault(); this.open({ ask: t.getAttribute("data-pilot-ask") || null }); return; }
      if (!this.opts.interceptLinks || this.mode === "closed" || this.opts.navigate || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest("a[href]");
      if (!a || this.root.contains(a) || a.target === "_blank" || a.hasAttribute("download")) return;
      const path = sameOriginPath(a.getAttribute("href"));
      if (!path || (path.split("#")[0] === location.pathname + location.search && path.includes("#"))) return;
      e.preventDefault();
      this.navigate(path).then((r) => { if (!r.ok) location.assign(path); });
    });
    window.addEventListener("popstate", () => {
      if (!this.swapped) return;
      this.swap(location.pathname + location.search, false).then((r) => { if (!r.ok) location.reload(); });
    });
    window.addEventListener("resize", () => { this.place(); this.trackSpot(); });
    window.addEventListener("scroll", () => this.trackSpot(), { passive: true });
    window.addEventListener("pagehide", () => this.stopAll());
  }
  fetchStatus() {
    this.statusReady = fetch(this.url("/status"), { headers: { Accept: "application/json" } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((s) => { this.status = s || { mode: "off", tts: false }; this.elName.textContent = this.name;
        if (this.status.mode === "rehearsal") { this.elBadge.hidden = false; this.elBadge.textContent = "Rehearsal"; }
        else if (this.status.mode === "off") { this.elBadge.hidden = false; this.elBadge.textContent = "No model key"; }
        return this.status; });
  }

  /* ---- open, close, dock ------------------------------------------------------------------------------------------------------- */
  open(o) {
    o = o || {};
    this.speaker.unlock();                                      /* inside the tap: audio and speech may start later */
    if (this.mode === "closed") {
      this.lastFocus = document.activeElement;
      this.ov.hidden = false; this.orbBtn.hidden = false; this.launchBtn.hidden = true;
      this.mode = "full"; this.root.dataset.mode = "full";
      document.documentElement.classList.add("vp-open");
      this.place(); this.orb.start();
      requestAnimationFrame(() => this.root.classList.add("vp-in"));
      this.closeBtn.focus({ preventScroll: true });
      this.emit("open", {});
    }
    if (o.ask) this.ask(o.ask); else if (!o.quiet) this.listen();
  }
  close() {
    if (this.mode === "closed") return;
    this.stopAll(); this.clearSpot(true); this.orb.stop();
    this.mode = "closed"; this.root.dataset.mode = "closed"; this.root.classList.remove("vp-in");
    this.ov.hidden = true; this.orbBtn.hidden = true; this.bubble.hidden = true; this.launchBtn.hidden = !this.opts.launcher;
    document.documentElement.classList.remove("vp-open");
    this.setState("idle");
    if (this.lastFocus && this.lastFocus.focus && document.contains(this.lastFocus)) this.lastFocus.focus({ preventScroll: true });
    this.emit("close", {});
  }
  dock(on) {
    if (this.mode === "closed") return;
    const want = on ? "docked" : "full";
    if (this.mode === want) return;
    this.mode = want; this.root.dataset.mode = want;
    this.ov.hidden = on; this.bubble.hidden = !on;
    document.documentElement.classList.toggle("vp-open", !on);
    this.place();
    this.syncBubble();
    this.emit("dock", { docked: on });
  }
  place() {                                                    /* the orb's box, as custom properties the CSS transitions between */
    const W = window.innerWidth, H = window.innerHeight, small = W < 640;
    const s = this.mode === "docked" ? (small ? 60 : 72) : Math.min(small ? 190 : 240, Math.round(H * 0.32));
    const x = this.mode === "docked" ? W - s - (small ? 14 : 24) : (W - s) / 2;
    const y = this.mode === "docked" ? H - s - (small ? 14 : 24) : Math.max(56, H * (small ? 0.2 : 0.24) - s / 2 + 40);
    const r = this.root.style;
    r.setProperty("--vp-orb-size", s + "px"); r.setProperty("--vp-orb-x", Math.round(x) + "px"); r.setProperty("--vp-orb-y", Math.round(y) + "px");
    r.setProperty("--vp-stage-top", Math.round(y + s + 16) + "px");
  }
  setState(s, label) {
    this.state = s; this.root.dataset.state = s;
    const L = { idle: "Tap the orb to talk", listening: "Listening", thinking: "Thinking", speaking: "", done: "Tap the orb to ask something else", error: "" };
    this.elState.textContent = label != null ? label : L[s];
    this.orbBtn.setAttribute("aria-label", s === "listening" ? "Tap to send now" : s === "speaking" ? "Tap to interrupt" : "Tap to talk");
    this.syncBubble();
    this.emit("state", { state: s });
  }
  syncBubble() {
    if (this.mode !== "docked") return;
    const s = this.state;
    this.bubState.textContent = s === "listening" ? "Listening" : s === "thinking" ? (this.elState.textContent || "Thinking") : s === "speaking" ? this.name : s === "done" ? "Tap the orb to ask again" : this.elState.textContent || this.name;
    if (s === "listening") this.bubText.textContent = this.elHeard.textContent || "Go ahead, I'm listening.";
    if (s === "error") this.bubText.textContent = this.elState.textContent;
  }
  showType(msg) { this.typeForm.hidden = false; this.typeBtn.hidden = true; if (msg) this.elState.textContent = msg; if (this.mode === "docked") this.dock(false); this.typeIn.focus(); }
  orbTap() {
    this.speaker.unlock();
    if (this.state === "listening") { if (!(this.sendNow && this.sendNow())) { this.stopRec(); this.setState("idle"); } return; }
    if (this.state === "thinking") return;
    this.listen();                                             /* speaking: barge in; idle/done: listen again */
  }

  /* ---- listening --------------------------------------------------------------------------------------------------------------- */
  stopRec() {
    clearTimeout(this.silenceT); this.sendNow = null;
    if (this.rec) { const r = this.rec; this.rec = null; r.onend = r.onerror = r.onresult = null; try { r.abort(); } catch (e) {} }
  }
  stopMic() {
    if (this.mic && this.mic.stream) this.mic.stream.getTracks().forEach((t) => t.stop());
    if (this.mic && this.mic.ctx) { try { this.mic.ctx.close(); } catch (e) {} }
    this.mic = null;
  }
  startMic() {                                                 /* laptop only: on phones recognition and an analyser on one mic can break each other */
    if (this.touch || this.mic || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    this.mic = { pending: true };
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const C = window.AudioContext || window.webkitAudioContext;
      if (this.state !== "listening" || !C) { stream.getTracks().forEach((t) => t.stop()); this.mic = null; return; }
      const ctx = new C(), an = ctx.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = 0.8;
      ctx.createMediaStreamSource(stream).connect(an);
      this.mic = { stream, ctx, an, buf: new Uint8Array(256) };
    }).catch(() => { this.mic = null; });
  }
  micLevel() {
    if (typeof window.__vpFakeLevel === "function") return window.__vpFakeLevel(performance.now() / 1000);   /* screenshots and tests */
    const m = this.mic;
    if (!m || !m.an) { this.micKick *= 0.93; return 0.1 + 0.65 * this.micKick; }
    m.an.getByteTimeDomainData(m.buf);
    let s = 0;
    for (let i = 0; i < m.buf.length; i++) { const v = (m.buf[i] - 128) / 128; s += v * v; }
    return Math.min(1, Math.sqrt(s / m.buf.length) * 5);
  }
  stopAll() {
    this.seq += 1; this.stopRec(); this.stopMic(); this.speaker.stop(); this.narrator.reset();
    if (this.ctl) { try { this.ctl.abort(); } catch (e) {} this.ctl = null; }
  }
  listen() {
    this.stopAll(); this.clearSpot(false);
    this.elHeard.textContent = ""; this.elHeard.classList.remove("is-final"); this.typeForm.hidden = true; this.typeBtn.hidden = false;
    if (!this.SR) { this.setState("idle", "Voice input is not available in this browser. Type your question instead."); this.showType(); return; }
    this.setState("listening");
    let fin = "", interim = "";
    const send = () => {
      const t = (fin + " " + interim).replace(/\s+/g, " ").trim();
      if (!t || this.state !== "listening") return false;
      this.ask(t);
      return true;
    };
    this.sendNow = send;
    const rec = this.rec = new this.SR();
    rec.lang = this.opts.lang; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    rec.onresult = (e) => {                                    /* continuous: the result list is the whole session, read from the start */
      this.micKick = 1;
      let f = "", i2 = "";
      for (let i = 0; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) f += r[0].transcript; else i2 += r[0].transcript; }
      fin = f; interim = i2;
      this.elHeard.textContent = (f + i2).trim(); this.elHeard.classList.toggle("is-final", !i2);
      this.syncBubble();
      clearTimeout(this.silenceT); this.silenceT = setTimeout(send, this.opts.pauseMs);
    };
    rec.onerror = (e) => {
      const why = e && e.error;
      if (why === "aborted") return;
      if (send()) return;
      this.stopRec();
      const msg = why === "not-allowed" || why === "service-not-allowed" ? "The microphone is blocked. Type your question instead."
        : why === "audio-capture" ? "No microphone was found. Type your question instead."
        : why === "no-speech" ? "I didn't hear anything. Tap the orb to try again."
        : why === "network" ? "Voice input needs a connection in this browser. Type your question instead." : "Voice input stopped. Tap the orb to try again.";
      this.setState("error", msg);
      if (why !== "no-speech") this.showType(msg);
    };
    rec.onend = () => {
      if (this.state !== "listening" || this.rec !== rec) return;
      if (!send()) { this.rec = null; this.setState("idle", "I didn't catch that. Tap the orb to try again."); }
    };
    try { rec.start(); this.startMic(); } catch (err) { this.setState("error", "Voice input could not start. Type your question instead."); this.showType(); }
  }

  /* ---- asking -------------------------------------------------------------------------------------------------------------------- */
  async manifest() {
    let base = this.opts.manifest;
    if (typeof base === "string") {
      if (!this.manifestFetch) this.manifestFetch = fetch(base, { headers: { Accept: "application/json" } }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      base = await this.manifestFetch;
    }
    base = base || {};
    if (!this.pages) this.pages = this.crawl(base.pages || []);
    const pages = await this.pages;
    return { app: base.app || { name: document.title, description: "" }, page: { path: location.pathname + location.search, title: document.title },
             targets: collect(document, true), pages };
  }
  crawl(pages) {                                               /* pages without declared targets: fetch once and read their data-pilot elements */
    return Promise.all(pages.slice(0, 20).map(async (p) => {
      const out = { path: p.path, title: p.title || "", desc: p.desc || "", targets: p.targets || [] };
      const src = p.sample || (p.path.includes(":") ? null : p.path);
      if (this.opts.crawl && !out.targets.length && src) {
        try {
          const r = await fetch(src, { headers: { Accept: "text/html" } });
          if (r.ok) out.targets = collect(new DOMParser().parseFromString(await r.text(), "text/html"), false);
          if (p.path.includes(":")) out.targets = out.targets.map((t) => { const c = Object.assign({}, t); delete c.text; delete c.href; return c; });   /* a sample page's own words would mislead */
        } catch (e) {}
      }
      return out;
    }));
  }
  async ask(text) {
    text = String(text || "").trim();
    if (!text) return;
    if (this.mode === "closed") { this.open({ quiet: true }); }
    this.stopAll();
    const my = this.seq;
    this.elHeard.textContent = text; this.elHeard.classList.add("is-final");
    this.elSay.textContent = ""; this.typeForm.hidden = true; this.typeBtn.hidden = false;
    if (this.mode === "docked") this.bubText.textContent = text;
    this.setState("thinking");
    this.trace("ask", { text });
    this.emit("ask", { text });
    this.messages.push({ role: "user", content: text });
    const n = this.narrator;
    let answer = "", failed = false;
    try {
      await this.statusReady;
      const manifest = await this.manifest();
      if (my !== this.seq) return;
      this.ctl = new AbortController();
      const r = await fetch(this.url("/chat"), { method: "POST", signal: this.ctl.signal, headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ messages: this.messages.slice(-this.opts.history * 2), manifest, reports: this.reports.splice(0) }) });
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("text/event-stream")) {
        let msg = "Something went wrong. Try again.";
        try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      await this.readSSE(r, {
        status: (d) => { if (my === this.seq && this.state === "thinking" && d.label) { this.elState.textContent = d.label[0].toUpperCase() + d.label.slice(1); this.syncBubble(); } },
        action: (d) => { if (my === this.seq) { n.action(d); this.trace("action-in", { id: d.id, type: d.type }); } },
        delta: (d) => { if (my === this.seq) { answer += d.text; n.delta(d.text, d.step); } },
        error: (d) => { if (my === this.seq) { failed = true; answer = d.message || "Something went wrong."; n.delta(answer, -1); } },
        done: (d) => { if (my === this.seq && d && d.text) answer = d.text; }
      });
    } catch (e) {
      if (my !== this.seq || (e && e.name === "AbortError")) return;
      failed = true; answer = (e && e.message && !/fetch|network/i.test(e.message)) ? e.message : `${this.name} can't be reached right now.`;
      n.delta(answer, -1);
    }
    if (my !== this.seq) return;
    if (failed) this.messages.pop(); else this.messages.push({ role: "assistant", content: clean(answer) });
    n.end();
  }
  readSSE(resp, on) {
    const reader = resp.body.getReader(), dec = new TextDecoder("utf-8");
    let buf = "";
    const flush = (block) => {
      let ev = "message"; const data = [];
      block.split("\n").forEach((l) => { if (l.startsWith("event:")) ev = l.slice(6).trim(); else if (l.startsWith("data:")) data.push(l.slice(5).replace(/^ /, "")); });
      let d = null; try { d = JSON.parse(data.join("\n")); } catch (e) { return; }
      if (on[ev]) on[ev](d);
    };
    const pump = () => reader.read().then((r) => {
      if (r.done) { if (buf.trim()) flush(buf); return; }
      buf += dec.decode(r.value, { stream: true }).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 2); }
      return pump();
    });
    return pump();
  }
  /* The beat's words, appended to the transcript and to the docked bubble; returns the reveal function the voice drives. */
  showBeat(text) {
    const words = clean(text).split(" ").filter(Boolean);
    const add = (host, fresh) => {
      if (fresh) host.textContent = ""; else if (host.childNodes.length) host.appendChild(document.createTextNode(" "));
      return words.map((w, i) => { if (i) host.appendChild(document.createTextNode(" ")); const s = el("span", "vp-w", w); host.appendChild(s); return s; });
    };
    const a = add(this.elSay, false), b = add(this.bubText, true);
    if (this.mode === "docked") this.syncBubble();
    const reveal = (f) => {
      const k = this.reduced() ? words.length : Math.ceil(f * words.length);
      for (let i = 0; i < k; i++) { a[i].classList.add("is-in"); b[i].classList.add("is-in"); }
    };
    reveal(0.001);
    return reveal;
  }
  answerEnded() {
    this.setState("done");
    this.emit("answer", { text: clean(this.narrator.raw) });
    clearTimeout(this.spotHold);
    this.spotHold = setTimeout(() => { if (this.state === "done") this.clearSpot(false); }, this.opts.holdSpotlightMs);
    if (this.opts.listenAfterAnswer && this.mode !== "closed") setTimeout(() => { if (this.state === "done") this.listen(); }, 400);
  }

  /* ---- actions ------------------------------------------------------------------------------------------------------------------ */
  find(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(id)) return null;
    const all = [...document.querySelectorAll("[data-pilot]")].filter((n) => n.dataset.pilot === id && !this.root.contains(n));
    return all.find(visible) || null;
  }
  runActions(list) { list.reduce((c, a) => c.then(() => this.exec(a)), Promise.resolve()); }
  report(a, ok, why) {
    a.state = ok ? "done" : "failed";
    const r = { id: a.id, type: a.type, target: a.target, path: a.path, ok, why: why || "" };
    if (a.entry) Object.assign(a.entry, r, { ms: Math.round(performance.now()) - a.entry.t });   /* the log entry was written when it started */
    else this.trace("action", r);
    if (!ok) this.reports.push(r);
    this.emit("action", r);
    return r;
  }
  async exec(a) {
    if (!a || a.state === "done" || a.state === "failed" || a.state === "running") return null;
    a.state = "running";
    this.trace("action", { id: a.id, type: a.type, target: a.target, path: a.path, ok: null, why: "" });
    a.entry = this.log[this.log.length - 1];
    const visual = a.type !== "wait";
    if (visual && this.opts.autoDock && this.mode === "full") this.dock(true);
    try {
      if (typeof this.opts.onAction === "function") {           /* the host can take over (or veto) any action */
        const r = await this.opts.onAction(a, this);
        if (r === false) return this.report(a, false, "refused by the host app");
        if (r === true) return this.report(a, true);
      }
      if (a.type === "wait") { await sleep(Math.max(100, Math.min(3000, +a.ms || 600))); return this.report(a, true); }
      if (a.type === "navigate") { const r = await this.navigate(a.path); return this.report(a, r.ok, r.why); }
      const t = this.find(a.target);
      if (!t) return this.report(a, false, "not on this page");
      if (a.type === "scroll_to") { await this.scrollTo(t); return this.report(a, true); }
      if (a.type === "highlight") { await this.highlight(t, a.caption); return this.report(a, true); }
      if (a.type === "click") {
        if (!t.hasAttribute("data-pilot-safe") || t.dataset.pilotSafe === "false") return this.report(a, false, "not marked data-pilot-safe");
        await this.scrollTo(t); this.pulse(t); await sleep(160); t.click(); await frames(2);
        return this.report(a, true);
      }
      if (a.type === "fill") { await this.scrollTo(t); const ok = this.fill(t, a.value); this.pulse(t); await frames(2); return this.report(a, ok, ok ? "" : "no such option"); }
      return this.report(a, false, "unknown action");
    } catch (e) {
      return this.report(a, false, String(e && e.message || e).slice(0, 80));
    }
  }
  fill(t, value) {
    const v = String(value == null ? "" : value);
    const target = /^(input|select|textarea)$/i.test(t.tagName) ? t : t.querySelector("input, select, textarea");
    if (!target) return false;
    if (target.tagName.toLowerCase() === "select") {
      const o = [...target.options].find((o) => o.value.toLowerCase() === v.toLowerCase() || o.textContent.trim().toLowerCase() === v.toLowerCase());
      if (!o) return false;
      target.value = o.value;
    } else if (target.type === "checkbox" || target.type === "radio") target.checked = /^(1|true|yes|on|checked)$/i.test(v);
    else {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value");   /* React-controlled inputs see the change too */
      if (setter && setter.set) setter.set.call(target, v); else target.value = v;
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  pulse(t) { t.classList.remove("vp-pulse"); void t.offsetWidth; t.classList.add("vp-pulse"); setTimeout(() => t.classList.remove("vp-pulse"), 1200); }
  async scrollTo(t) {
    const r = t.getBoundingClientRect(), H = window.innerHeight;
    if (r.top >= 70 && r.bottom <= H - 110) return;
    t.scrollIntoView({ behavior: this.reduced() ? "auto" : "smooth", block: r.height > H * 0.6 ? "start" : "center" });
    let last = -1, still = 0;
    for (let i = 0; i < 60 && still < 4; i++) { await frames(1); const y = window.scrollY; still = y === last ? still + 1 : 0; last = y; }
  }
  async highlight(t, caption) {
    clearTimeout(this.spotHold);
    await this.scrollTo(t);
    this.spotTarget = t;
    this.spot.hidden = false; this.spotLabel.hidden = !caption;
    this.spotLabel.textContent = caption || "";
    this.root.classList.add("vp-spotting");
    this.trackSpot();
    requestAnimationFrame(() => { this.spot.classList.add("is-on"); this.spotLabel.classList.add("is-on"); });
    if (!this.spotLoop) {
      const loop = () => { if (!this.spotTarget) { this.spotLoop = 0; return; } this.trackSpot(); this.spotLoop = requestAnimationFrame(loop); };
      this.spotLoop = requestAnimationFrame(loop);
    }
    await sleep(this.reduced() ? 0 : 260);
  }
  trackSpot() {
    const t = this.spotTarget;
    if (!t) return;
    if (!document.contains(t)) { this.clearSpot(false); return; }
    const r = t.getBoundingClientRect(), pad = 8, s = this.spot.style;
    s.transform = `translate(${Math.round(r.left - pad)}px, ${Math.round(r.top - pad)}px)`;
    s.width = Math.round(r.width + pad * 2) + "px"; s.height = Math.round(r.height + pad * 2) + "px";
    const L = this.spotLabel, lw = Math.min(L.offsetWidth || 220, window.innerWidth - 24);
    const below = r.top < 64;
    const lx = Math.max(12, Math.min(window.innerWidth - lw - 12, r.left - pad));
    const ly = below ? r.bottom + pad + 10 : r.top - pad - (L.offsetHeight || 34) - 10;
    L.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
    L.dataset.side = below ? "below" : "above";
  }
  clearSpot(now) {
    this.spotTarget = null; this.root.classList.remove("vp-spotting");
    this.spot.classList.remove("is-on"); this.spotLabel.classList.remove("is-on");
    const done = () => { if (!this.spotTarget) { this.spot.hidden = true; this.spotLabel.hidden = true; } };
    if (now || this.reduced()) done(); else setTimeout(done, 320);
  }
  /* navigate without a page load: the host's router, or fetch the page and swap the declared regions */
  async navigate(path) {
    const p = sameOriginPath(path || "/");
    if (!p) return { ok: false, why: "not a path on this site" };
    this.clearSpot(true);
    if (typeof this.opts.navigate === "function") {
      try { await this.opts.navigate(p); } catch (e) { return { ok: false, why: "the router refused" }; }
      await this.settle();
      this.emit("navigated", { path: p });
      return { ok: true };
    }
    return this.swap(p, true);
  }
  async swap(p, push) {
    let html;
    try {
      const r = await fetch(p, { headers: { Accept: "text/html", "X-Pilot-Navigate": "1" } });
      if (!r.ok) return { ok: false, why: "the page answered " + r.status };
      html = await r.text();
    } catch (e) { return { ok: false, why: "the page could not be fetched" }; }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const cur = [...document.querySelectorAll(this.opts.regions)].filter((n) => !this.root.contains(n));
    if (!cur.length) return { ok: false, why: "no [data-pilot-main] region to swap" };
    let swapped = 0;
    for (const old of cur) {
      const key = old.getAttribute("data-pilot-region");
      const next = key ? doc.querySelector(`[data-pilot-region="${CSS.escape(key)}"]`) : doc.querySelector("[data-pilot-main]");
      if (!next) continue;
      const fresh = document.importNode(next, true);
      fresh.querySelectorAll("script").forEach((s) => {     /* scripts in the new region run, as they would on a page load */
        const n = document.createElement("script");
        [...s.attributes].forEach((at) => n.setAttribute(at.name, at.value));
        n.textContent = s.textContent; s.replaceWith(n);
      });
      old.replaceWith(fresh); swapped += 1;
    }
    if (!swapped) return { ok: false, why: "the new page has no matching region" };
    if (doc.title) document.title = doc.title;
    if (push) history.pushState({ vp: true }, "", p);
    this.swapped = true;
    const hash = p.includes("#") ? p.split("#")[1] : "";
    const anchor = hash && document.getElementById(hash);
    if (anchor) anchor.scrollIntoView(); else window.scrollTo(0, 0);
    await this.settle();
    this.emit("navigated", { path: p });
    return { ok: true };
  }
  async settle() {                                             /* the new page has painted and stopped changing for a moment */
    await frames(2);
    await new Promise((res) => {
      let t = setTimeout(done, 120);
      const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 120); });
      const cap = setTimeout(done, 1500);
      function done() { mo.disconnect(); clearTimeout(cap); res(); }
      mo.observe(document.body, { childList: true, subtree: true });
    });
  }
}

/* ================================================================================================================================ */
function init(opts) {
  if (instance) return instance;
  instance = new Pilot(opts);
  VoicePilot.instance = instance;
  return instance;
}
const VoicePilot = {
  version: VERSION, init, instance: null,
  /* a scripted demo moment without the model: run actions and words as if they had come from /chat */
  play(script) { const p = instance || init(); return p.play ? p.play(script) : null; }
};
Pilot.prototype.play = function (script) {
  /* script: {text: "[[1]] Here ... [[2]] ...", actions: [{id:1, type:"navigate", path:"/x"}, ...]} */
  if (this.mode === "closed") this.open({ quiet: true });
  this.stopAll();
  (script.actions || []).forEach((a) => this.narrator.action(a));
  this.setState("thinking");
  this.narrator.delta(script.text || "", 1);
  this.narrator.end();
};
if (typeof window !== "undefined") window.VoicePilot = VoicePilot;

})();
