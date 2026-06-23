// Trading dashboard - reads sanitized data.json from this repo + live prices from Binance WS.
// Public-by-data, gated-by-URL-token in JS. Token check is cosmetic; real privacy comes from URL obscurity.

// === Audio ===
let _audioCtx = null;
function _ctx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === "suspended") _audioCtx.resume();
  return _audioCtx;
}
function _tone(ctx, freq, start, dur, vol = 0.18, type = "sine") {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(vol, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, start + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(start); o.stop(start + dur + 0.05);
}
function playSound(type) {
  try {
    const ctx = _ctx();
    const t = ctx.currentTime;
    if (type === "bloomberg") {
      // Three-note descending news chime (D→A→E)
      _tone(ctx, 587, t,       0.35, 0.20);
      _tone(ctx, 440, t + 0.3, 0.35, 0.20);
      _tone(ctx, 330, t + 0.6, 0.55, 0.22);
    } else if (type === "tp1") {
      // Rising success: C→E→G→C
      _tone(ctx, 523, t,        0.18, 0.18);
      _tone(ctx, 659, t + 0.12, 0.18, 0.18);
      _tone(ctx, 784, t + 0.24, 0.18, 0.18);
      _tone(ctx, 1047,t + 0.36, 0.40, 0.20);
    } else if (type === "win") {
      // Full celebration: rapid ascending fanfare
      [523, 659, 784, 880, 1047].forEach((f, i) =>
        _tone(ctx, f, t + i * 0.10, 0.25, 0.18));
      _tone(ctx, 1319, t + 0.55, 0.60, 0.22);
    } else if (type === "loss") {
      // Descending minor — sad trombone style
      _tone(ctx, 330, t,        0.40, 0.18, "triangle");
      _tone(ctx, 277, t + 0.35, 0.40, 0.18, "triangle");
      _tone(ctx, 220, t + 0.70, 0.65, 0.20, "triangle");
    } else if (type === "open") {
      // Clean double-ping (entry confirmed)
      _tone(ctx, 880, t,       0.20, 0.16);
      _tone(ctx, 1047,t + 0.22, 0.20, 0.16);
    } else if (type === "signal") {
      // Single soft ping (new signal)
      _tone(ctx, 660, t, 0.30, 0.14);
    }
  } catch (e) { console.warn("sound error", e); }
}

const URL_TOKEN = "BUKTYYvc1SELHNeI";
const DATA_URL  = "data.json";
const REFRESH_MS = 60_000;
const ROTATE_MS  = 15_000;
const STALE_MS   = 5 * 60 * 60_000;

// ── Set this to your Cloudflare Worker URL once deployed ──────────────────
// e.g. "https://mexc-proxy.yourname.workers.dev"
// Leave empty to rely on the 5-minute GHA snapshot fallback.
const MEXC_WORKER_URL      = "https://mexc-proxy.braamdeclerk.workers.dev";
const BLOOMBERG_WORKER_URL = "https://bloomberg-news.braamdeclerk.workers.dev";
// ─────────────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
if (params.get("k") !== URL_TOKEN) {
  throw new Error("blocked");
}
document.getElementById("gate").remove();
document.getElementById("app").hidden = false;

// Force-clear any overlay left open by a previous broken session
{ const _ov = document.getElementById("overlay"); if (_ov) { _ov.hidden = true; _ov.classList.remove("out","sulk"); } }
const _cf = document.getElementById("confetti"); if (_cf) _cf.innerHTML = "";

const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2);
const fmtPct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";

// Read a CSS variable from the root — allows themes to control JS-injected colors
const _rootStyle = getComputedStyle(document.documentElement);
const cssVar = (name) => _rootStyle.getPropertyValue(name).trim();
const cls = (n) => (n >= 0 ? "pos" : "neg");

// ── Voice — Professional TTS alerts ──────────────────────────────────────────
// Uses Web Speech API. All alerts deduplicated by key in localStorage.

const MUTE_KEY  = "dashMute_v1";
const VSEEN_KEY = "dashVoiceSeen_v1";
let _voiceMuted = localStorage.getItem(MUTE_KEY) === "1";
let _selVoice   = null;
const _ttsQueue = [];
let _ttsBusy    = false;

// Voice priority: female voices on Chrome OS / desktop
const VOICE_PREFS = [
  "Google UK English Female",
  "Google US English Female",
  "Microsoft Zira",
  "Samantha",
  "Google UK English Male",
  "Google US English",
];

function _pickVoice() {
  if (_selVoice) return _selVoice;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  for (const pref of VOICE_PREFS) {
    const v = voices.find(v => v.name.includes(pref));
    if (v) { _selVoice = v; console.log("[voice]", v.name); return v; }
  }
  _selVoice = voices.find(v => v.lang.startsWith("en")) || null;
  return _selVoice;
}

if (window.speechSynthesis) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = _pickVoice;
}

function _ttsNext() {
  if (_ttsBusy || !_ttsQueue.length || _voiceMuted) return;
  _ttsBusy = true;
  const text = _ttsQueue.shift();
  const utt = new SpeechSynthesisUtterance(text);
  const v = _pickVoice();
  if (v) utt.voice = v;
  utt.rate = 0.92; utt.pitch = 1.0; utt.volume = 1.0;
  utt.onend = utt.onerror = () => { _ttsBusy = false; setTimeout(_ttsNext, 250); };
  try { speechSynthesis.speak(utt); } catch { _ttsBusy = false; }
}

function speak(text) {
  if (!window.speechSynthesis || _voiceMuted || !text) return;
  _ttsQueue.push(text);
  _ttsNext();
}

// Dedup: each alert key fires only once (persists across reloads)
let vseen = new Set(JSON.parse(localStorage.getItem(VSEEN_KEY) || "[]"));
function saveVseen() {
  localStorage.setItem(VSEEN_KEY, JSON.stringify([...vseen].slice(-800)));
}
function maybeSpeak(key, text) {
  // Voice/TTS announcements DISABLED per user request (2026-06-17) — no spoken
  // win/loss/entry/TP alerts. To re-enable, remove the early return below.
  return false;
  if (vseen.has(key)) return false;
  vseen.add(key); saveVseen();
  speak(text);
  return true;
}

// Coin name helper: strip USDT suffix
function coinName(t) { return t.coin.replace(/USDT$/i, ""); }

// ── TTS formatters ──
// Format a price so the speech synth pronounces it cleanly. For big numbers
// (BTC, ETH) it speaks "seventy-seven thousand, two hundred fifty"; for low-
// priced coins (DOGE, XRP) it speaks the decimal value.
function _priceForTts(p) {
  if (p == null || isNaN(p)) return "";
  if (p >= 1000) return Math.round(p).toLocaleString("en-US");
  if (p >= 100)  return p.toFixed(0);
  if (p >= 1)    return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  return p.toPrecision(2);
}
// Format a P&L amount: rounded to whole dollars for natural speech.
function _amountForTts(usd) {
  if (usd == null || isNaN(usd)) return "";
  const rounded = Math.round(Math.abs(usd));
  return rounded === 1 ? "1 dollar" : `${rounded} dollars`;
}

// Mute toggle wired to header button
function toggleMute() {
  _voiceMuted = !_voiceMuted;
  localStorage.setItem(MUTE_KEY, _voiceMuted ? "1" : "0");
  const btn = document.getElementById("mute-btn");
  if (btn) btn.textContent = _voiceMuted ? "🔇" : "🔊";
  if (_voiceMuted) {
    speechSynthesis.cancel();
  } else {
    setTimeout(() => {
      const v = _pickVoice();
      _showVoiceToast(v ? v.name.replace("Google ","") : "Voice active");
      speak("Voice alerts active.");
    }, 200);
  }
}

function _showVoiceToast(msg) {
  let t = document.getElementById("voice-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "voice-toast";
    t.style.cssText = `
      position:fixed; bottom:60px; left:50%; transform:translateX(-50%);
      background:rgba(0,201,167,0.92); color:#fff; font-size:13px; font-weight:700;
      padding:8px 18px; border-radius:20px; z-index:200; white-space:nowrap;
      box-shadow:0 4px 16px rgba(0,0,0,0.4); pointer-events:none;
      transition:opacity 0.4s ease;
    `;
    document.body.appendChild(t);
  }
  t.textContent = `🔊 ${msg}`;
  t.style.opacity = "1";
  clearTimeout(t._hide);
  t._hide = setTimeout(() => { t.style.opacity = "0"; }, 3000);
}

// Real-time level monitoring — runs on every WS price tick.
// Detects TP1, SL, and entry zone hits without waiting for the 4H GHA job.
function checkLiveLevels() {
  const now = Date.now();
  for (const t of state.trades) {
    if (t.track_only) continue;
    const live = state.prices[t.coin];
    if (!live) continue;
    const isLong = t.direction === "Long";

    if (t.status === "PENDING") {
      const atEntry = isLong ? live <= t.entry_price : live >= t.entry_price;
      if (atEntry) {
        maybeSpeak(`voice:entry:${t.trade_id}`,
          `${coinName(t)} ${t.direction}. Entry hit at ${_priceForTts(t.entry_price)}. Trade is now live.`);
      }

    } else if (t.status === "OPEN") {
      // TP1 — real-time, before data.json updates
      if (!t.tp1_hit && t.tp1) {
        const tp1Hit = isLong ? live >= t.tp1 : live <= t.tp1;
        if (tp1Hit) {
          const tp1PricePct = isLong ? (t.tp1 - t.entry_price) / t.entry_price : (t.entry_price - t.tp1) / t.entry_price;
          const estBanked = (t.capital_usd || 100) * 0.8 * tp1PricePct * (t.leverage || 1);
          maybeSpeak(`voice:tp1live:${t.trade_id}`,
            `${coinName(t)} ${t.direction}. Take profit one hit. Eighty percent banked. ${_amountForTts(estBanked)} locked in.`);
        }
      }
      // SL hit
      if (t.sl) {
        const slHit = isLong ? live <= t.sl : live >= t.sl;
        if (slHit) {
          const remaining = t.tp1_hit ? 0.2 : 1.0;
          const pricePct = isLong ? (live - t.entry_price) / t.entry_price : (t.entry_price - live) / t.entry_price;
          const estPnl = (t.capital_usd || 100) * remaining * pricePct * (t.leverage || 1);
          maybeSpeak(`voice:sllive:${t.trade_id}`,
            `${coinName(t)} ${t.direction}. Stop loss hit. Lost ${_amountForTts(Math.abs(estPnl))} dollars.`);
        }
      }
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Animated number counter — smoothly transitions displayed value over ~600ms
const _animTargets = new Map();
// PERF: when true, animateValue sets the value immediately instead of tweening.
// Flipped on for renders driven by the high-frequency WS price stream; the 2s
// tween was designed for cron-driven refreshes, not 25Hz ticks.
let _animSkip = false;
function animateValue(el, toVal, formatter) {
  if (!el) return;
  if (_animSkip) {
    _animTargets.set(el, toVal);
    el.dataset.rawVal = toVal;
    el.textContent = formatter(toVal);
    return;
  }
  const prev = _animTargets.get(el) ?? toVal;
  _animTargets.set(el, toVal);
  const start = performance.now();
  const dur = 2000;
  const from = parseFloat(el.dataset.rawVal ?? toVal);
  el.dataset.rawVal = toVal;
  if (Math.abs(toVal - from) < 0.005) { el.textContent = formatter(toVal); return; }
  function step(now) {
    if (_animTargets.get(el) !== toVal) return; // superseded
    const t = Math.min(1, (now - start) / dur);
    const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out
    el.textContent = formatter(from + (toVal - from) * ease);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// Tile glow: applies glow-green / glow-red based on sign
function setTileGlow(tileEl, val) {
  tileEl.classList.toggle("glow-green", val > 0.005);
  tileEl.classList.toggle("glow-red",   val < -0.005);
}

let state = { trades: [], stats: {}, prices: {}, lastFetch: 0, lastCronIso: null, recentCloses: [], mexcAccount: null };

// Seen-events memory (so we don't replay celebrations on every refresh)
const SEEN_KEY = "dashSeenEvents_v1";
const FIRST_RUN_KEY = "dashFirstRun_v1";
function loadSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveSeen(set) {
  // Cap at last 200 events to keep storage bounded.
  const arr = [...set].slice(-200);
  localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
}
let seen = loadSeen();
let firstRun = !localStorage.getItem(FIRST_RUN_KEY);

// Set correct mute icon on load
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("mute-btn");
  if (btn) btn.textContent = _voiceMuted ? "🔇" : "🔊";
});

async function fetchData() {
  try {
    const r = await fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" });
    const d = await r.json();
    const newTrades = d.active_trades || [];
    const newCloses = d.recent_closes || [];
    const recentOpens = d.recent_opens || [];
    const testEvents = d.test_events || [];
    detectEvents(newTrades, newCloses, testEvents);
    state.trades = newTrades;
    state.recentCloses = newCloses;
    state.recentOpens = recentOpens;
    state.recentSignals = d.recent_signals || [];
    state.recentCancels = d.recent_cancels || [];
    state.tp1HitsOpen = d.tp1_hits_open || [];
    checkBloombergNews(d.bloomberg_news || []);
    state.stats = d.stats || {};
    state.mexcAccount = d.mexc_account || null;
    state.apiKeys = d.api_keys || [];
    state.lastCronIso = d.last_updated_iso || null;
    state.lastFetch = Date.now();

    // Voice test events — injected via data.json for testing, always unique IDs (timestamp-type-step)
    const _testPhrases = {
      signal: "New trade signal. Ethereum Long. John system.",
      entry:  "Bitcoin Short. Entry hit at 77,250. Trade is now live.",
      tp1:    "Take profit one hit. Eighty percent banked. 18 dollars locked in.",
      sl:     "Solana Long. Stop loss hit. Lost 12 dollars.",
      tp2:    "Take profit two hit. Trade fully closed. Won 86 dollars.",
      ready:  "Voice alerts active.",
    };
    for (const e of (d.voice_test_events || [])) {
      const evType = e.id.split("-")[1] || "signal";
      maybeSpeak(`voice:test:${e.id}`, _testPhrases[evType] || e.text || "Alert.");
    }

    // Voice: new pending signals (only fire for signals ≤30min old to avoid replaying history)
    const _sigCutoff = Date.now() - 30 * 60_000;
    for (const t of state.recentSignals) {
      const age = t.iso ? new Date(t.iso).getTime() : 0;
      if (age >= _sigCutoff) {
        maybeSpeak(`voice:signal:${t.trade_id}`,
          `New ${t.trading_system} signal. ${coinName(t)} ${t.direction}. Entry at ${_priceForTts(t.entry_price)}.`);
      }
    }
    // Voice: PENDING → OPEN activations (entry hit, confirmed by data.json)
    for (const t of recentOpens) {
      maybeSpeak(`voice:entry:${t.trade_id}`,
        `${coinName(t)} ${t.direction}. Entry hit at ${_priceForTts(t.entry_price)}. Trade is now live.`);
    }

    subscribeWs();
    render();
  } catch (e) {
    console.error("fetch failed", e);
  }
}

// === Event detection: TP1 hits + closes + manual test events → queue overlays ===
function detectEvents(newTrades, newCloses, testEvents) {
  const events = [];

  // TP1 transitions on still-open trades
  for (const t of newTrades) {
    if (t.tp1_hit) {
      const evId = `tp1:${t.trade_id}`;
      if (!seen.has(evId)) events.push({ id: evId, type: "tp1", trade: t });
      // Voice — confirmed by data.json (fires once, deduped against live detection key too)
      const banked = t.pnl_tp1_realized_usd;
      maybeSpeak(`voice:tp1live:${t.trade_id}`,
        `${coinName(t)} ${t.direction}. Take profit one hit. Eighty percent banked.${
          banked ? ` ${_amountForTts(banked)} locked in.` : ""
        }`);
    }
  }

  // Newly-closed trades
  for (const t of newCloses) {
    const evId = `close:${t.trade_id}`;
    if (!seen.has(evId)) events.push({ id: evId, type: t.won ? "win" : "loss", trade: t });
    // Voice for SL / TP2 — include the realised P&L
    const status = t.status || "";
    const amount = _amountForTts(t.pnl_usd);
    if (status === "STOPPED_AFTER_TP1") {
      // TP1 was banked, trail stopped at breakeven → net WIN
      maybeSpeak(`voice:sl:${t.trade_id}`,
        `${coinName(t)} ${t.direction}. Stopped after take profit one. Won ${amount}.`);
    } else if (status === "STOPPED") {
      // Pure stop-loss → loss
      maybeSpeak(`voice:sl:${t.trade_id}`,
        `${coinName(t)} ${t.direction}. Stop loss hit. Lost ${amount}.`);
    } else if (status === "TP2_HIT") {
      maybeSpeak(`voice:tp2:${t.trade_id}`,
        `${coinName(t)} ${t.direction}. Take profit two hit. Trade fully closed. Won ${amount}.`);
    }
  }

  // Manual test events (always fire, even on first run — pushed deliberately)
  for (const e of (testEvents || [])) {
    const evId = `test:${e.id}`;
    if (!seen.has(evId)) events.push({ id: evId, type: e.type, trade: e.trade });
  }

  if (firstRun) {
    // First time this browser opens dashboard: mark organic events as seen so we don't replay
    // history, BUT let manual test_events fire so initial tablet tests still play.
    for (const e of events) {
      if (!e.id.startsWith("test:")) seen.add(e.id);
    }
    saveSeen(seen);
    localStorage.setItem(FIRST_RUN_KEY, "1");
    firstRun = false;
    events.filter(e => e.id.startsWith("test:")).forEach((ev, i) => setTimeout(() => showOverlay(ev), i * 6500));
    return;
  }

  // Queue events with mild stagger so multiple don't collide
  events.forEach((ev, i) => setTimeout(() => showOverlay(ev), i * 6500));
}

let overlayBusy = false;
const overlayQueue = [];
const overlayQueuedIds = new Set();
let overlayHardTimer = null;
let overlayShownAt = 0;

// Watchdog: every 1s, if overlay has been visible for >10s, force-clear.
setInterval(() => {
  const el = document.getElementById("overlay");
  if (el && !el.hidden && overlayShownAt && Date.now() - overlayShownAt > 10_000) {
    console.warn("watchdog: force-clearing stuck overlay");
    el.hidden = true;
    el.classList.remove("out", "sulk");
    const cf = document.getElementById("confetti");
    if (cf) cf.innerHTML = "";
    overlayBusy = false;
    overlayShownAt = 0;
    if (overlayHardTimer) { clearTimeout(overlayHardTimer); overlayHardTimer = null; }
  }
}, 1000);

function showOverlay(ev) {
  // Win celebrations + loss "sulk" + TP1 popup overlays DISABLED per user
  // request (2026-06-17) to de-gamify the dashboard. Voice TTS is a separate
  // system and is unaffected. To re-enable, remove the early return below.
  return;
  // Dedupe: never queue or show the same event twice in one session
  if (seen.has(ev.id) || overlayQueuedIds.has(ev.id)) return;
  overlayQueuedIds.add(ev.id);
  // Mark seen IMMEDIATELY so a re-fetch can't re-queue it
  try { seen.add(ev.id); saveSeen(seen); } catch {}

  if (overlayBusy) { overlayQueue.push(ev); return; }
  overlayBusy = true;
  overlayShownAt = Date.now();

  const finish = () => {
    if (overlayHardTimer) { clearTimeout(overlayHardTimer); overlayHardTimer = null; }
    const el = $("overlay");
    el.hidden = true;
    el.classList.remove("out", "sulk");
    $("confetti").innerHTML = "";
    overlayBusy = false;
    overlayShownAt = 0;
    if (overlayQueue.length) setTimeout(() => {
      const next = overlayQueue.shift();
      overlayQueuedIds.delete(next.id);
      // un-mark so showOverlay's dedupe doesn't skip it (event is being intentionally shown)
      seen.delete(next.id);
      showOverlay(next);
    }, 800);
  };

  try {
    const t = ev.trade || {};
    const coin = (t.coin || "?").replace("USDT", "");
    const dir = t.direction || "";
    const sys = t.trading_system || "";
    const pnlNum = typeof t.pnl_usd === "number" ? t.pnl_usd : 0;
    let emoji, headline, detail, pnl, sulk = false, confetti = false;

    if (ev.type === "tp1") {
      emoji = "🎯"; headline = "TP1 HIT!";
      detail = `${coin} ${dir} · ${sys}`;
      pnl = "SL → breakeven, riding TP2";
      confetti = true;
    } else if (ev.type === "win") {
      emoji = "🚀";
      headline = t.status === "TP2_HIT" ? "TP2 SMASHED" : "WINNER CLOSED";
      detail = `${coin} ${dir} · ${sys}`;
      pnl = (pnlNum >= 0 ? "+$" : "-$") + Math.abs(pnlNum).toFixed(2);
      confetti = true;
    } else {
      emoji = "💔"; headline = "STOPPED OUT";
      detail = `${coin} ${dir} · ${sys}`;
      pnl = (pnlNum >= 0 ? "+$" : "-$") + Math.abs(pnlNum).toFixed(2);
      sulk = true;
    }

    const el = $("overlay");
    $("overlay-emoji").textContent = emoji;
    $("overlay-headline").textContent = headline;
    $("overlay-detail").textContent = detail;
    const pnlEl = $("overlay-pnl");
    pnlEl.textContent = pnl;
    pnlEl.className = "overlay-pnl " + (ev.type === "loss" ? "neg" : "pos");
    el.classList.toggle("sulk", sulk);
    el.classList.remove("out");
    el.hidden = false;
    if (confetti) launchConfetti();
    playSound(ev.type);

    // Soft clear at 5.5s, hard fail-safe at 7s (no matter what)
    setTimeout(() => $("overlay").classList.add("out"), 5500);
    setTimeout(finish, 6100);
    overlayHardTimer = setTimeout(() => { console.warn("overlay hard-clear"); finish(); }, 7000);
  } catch (err) {
    console.error("overlay error", err);
    finish();
  }
}

// Emergency: tap the overlay to dismiss
document.addEventListener("DOMContentLoaded", () => {
  const ov = document.getElementById("overlay");
  if (ov) ov.addEventListener("click", () => { ov.hidden = true; ov.classList.remove("out","sulk"); document.getElementById("confetti").innerHTML=""; overlayBusy=false; });
});

function launchConfetti() {
  const box = $("confetti");
  const colors = ["#26A69A", "#4CAF50", "#FF9800", "#FFD54F", "#80DEEA"];
  for (let i = 0; i < 80; i++) {
    const p = document.createElement("div");
    p.className = "confetti-piece";
    p.style.left = Math.random() * 100 + "vw";
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    p.style.animationDuration = (2 + Math.random() * 2.5) + "s";
    p.style.animationDelay = (Math.random() * 0.8) + "s";
    p.style.transform = `rotate(${Math.random() * 360}deg)`;
    box.appendChild(p);
  }
}

let ws = null;
let wsSymbols = "";
// PERF: coalesce 25Hz WS ticks → at most one render per requestAnimationFrame.
// Without this each ws message fired a full renderLive + renderPendingTriggers
// + animateValue rAF chain — enough to stall the Chromebook's main thread and
// jam screen-swipe transitions.
let _wsRenderScheduled = false;
let _wsLastTriggersAt = 0;
const TRIGGERS_THROTTLE_MS = 2000;
function _scheduleWsRender() {
  if (_wsRenderScheduled) return;
  _wsRenderScheduled = true;
  requestAnimationFrame(() => {
    _wsRenderScheduled = false;
    _animSkip = true;
    try {
      renderLive();
      // Triggers panel rank rarely changes between ticks — throttle to 2s.
      const now = Date.now();
      if (now - _wsLastTriggersAt > TRIGGERS_THROTTLE_MS) {
        _wsLastTriggersAt = now;
        renderPendingTriggers();
      }
      checkLiveLevels();
    } finally {
      _animSkip = false;
    }
  });
}
function subscribeWs() {
  const symbols = [...new Set(state.trades.map(t => t.coin.toLowerCase()))];
  const key = symbols.sort().join(",");
  if (key === wsSymbols && ws && ws.readyState === 1) return;
  wsSymbols = key;
  if (ws) { try { ws.close(); } catch {} }
  if (!symbols.length) return;
  const streams = symbols.map(s => s + "@miniTicker").join("/");
  ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      const c   = parseFloat(msg.data.c); // close
      const sym = msg.data.s;
      state.prices[sym] = c;
      _scheduleWsRender();
    } catch {}
  };
  ws.onclose = () => setTimeout(subscribeWs, 5000);
}

// Per-system TP split — fraction banked at TP1 and fraction still riding after.
// John/William 80/20 · Braam 50/50 · Mong 30/30/40 (after TP1 70% rides; after TP2 40%).
function splitFractions(t) {
  const sys = t.trading_system || "";
  if (sys === "Braam") return { banked: 0.5, remaining: 0.5 };
  if (sys === "Mong")  return { banked: 0.3, remaining: t.tp2_hit ? 0.4 : 0.7 };
  return { banked: 0.8, remaining: 0.2 };  // John / William default
}

function computeUnrealized(t) {
  const live = state.prices[t.coin] ?? t.price_at_run ?? t.entry_price;
  const dir = t.direction === "Long" ? 1 : -1;
  const pricePct = ((live - t.entry_price) / t.entry_price) * 100 * dir;
  const leveragedPct = pricePct * (t.leverage || 1);
  const cap = t.capital_usd || 100;

  const tp1WasHit = !!t.tp1_hit;
  const { banked: bankedFraction, remaining: remainingFractionAfterTp1 } = splitFractions(t);
  // After TP1 hit, only the riding fraction remains live (system-specific).
  const remainingFraction = tp1WasHit ? remainingFractionAfterTp1 : 1.0;
  const usd = cap * remainingFraction * (leveragedPct / 100);

  let tp1BankedUsd = 0;
  if (tp1WasHit) {
    if (t.pnl_tp1_realized_usd != null) {
      tp1BankedUsd = t.pnl_tp1_realized_usd || 0;
    } else if (t.tp1 && t.entry_price) {
      // Backend hasn't written pnl yet — estimate from TP1 price using the
      // correct per-system banked fraction (was hardcoded 0.8 = John only).
      const tp1PricePct = ((t.tp1 - t.entry_price) / t.entry_price) * 100 * dir;
      tp1BankedUsd = cap * bankedFraction * (tp1PricePct * (t.leverage || 1) / 100);
    }
  }

  return { live, pricePct, leveragedPct, usd, tp1BankedUsd };
}

function render() {
  const open = state.trades.filter(t => t.status === "OPEN");
  const pending = state.trades.filter(t => t.status === "PENDING");

  // Counts
  $("open-count").textContent = open.length;
  const oL = open.filter(t => t.direction === "Long").length;
  const oS = open.length - oL;
  $("open-split").textContent = `${oL} Long · ${oS} Short`;

  $("pending-count").textContent = pending.length;
  const pL = pending.filter(t => t.direction === "Long").length;
  const pS = pending.length - pL;
  $("pending-split").textContent = `${pL} Long · ${pS} Short`;

  // Hero portfolio P&L tile (realized + unrealized + donut + sparkline) — rendered in renderLive()

  // Last-cron meta
  if (state.lastCronIso) {
    const d = new Date(state.lastCronIso);
    const ago = Math.floor((Date.now() - d.getTime()) / 60000);
    const cetTime = d.toLocaleTimeString("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
    $("last-cron").textContent = `last run: ${cetTime} CET (${ago}m ago)`;
    $("live-dot").classList.toggle("stale", Date.now() - d.getTime() > STALE_MS);
  }

  renderLive();
  renderSystems();
  renderActivity();
  renderPendingTriggers();
  renderMexcCard();
  renderS0();
  renderRecentClosesTile();
  renderApiKeys();
}

function renderRecentClosesTile() {
  const el = document.getElementById("recent-closes-list");
  if (!el) return;
  // Use the same ascending source the equity curve uses, take the last 5,
  // then reverse for newest-first display. Guarantees Recent Closes ≡ the 5
  // rightmost points on the equity curve when many trades close at the same
  // 4H timestamp (stable-sort tie ordering would otherwise diverge).
  const closes = [...(state.recentCloses || [])]
    .sort((a, b) => new Date(a.close_iso || 0) - new Date(b.close_iso || 0))
    .slice(-5)
    .reverse();
  if (!closes.length) {
    el.innerHTML = '<div class="rc-empty">no closes yet</div>';
    return;
  }
  const newHtml = closes.map(c => {
    const coin = (c.coin || "").replace("USDT", "");
    const won = c.won != null ? c.won : (c.pnl_usd || 0) > 0;
    const pnl = c.pnl_usd || 0;
    const pnlStr = (pnl >= 0 ? "+$" : "-$") + Math.abs(pnl).toFixed(2);
    const isLong = c.direction === "Long";
    const dirCls = isLong ? "long" : "short";
    const dirLetter = isLong ? "L" : "S";
    // Close reason → short badge: "TP2 hit" → TP2, "TP1 hit" → TP1, "SL hit" → SL,
    // STOPPED_AFTER_TP1 → "TP1+SL" (closed at BE after TP1 hit), else first word uppercase.
    const reason = (c.close_reason || "").toString();
    let rCode, rCls;
    if (/^tp2/i.test(reason))         { rCode = "TP2"; rCls = "tp2"; }
    else if (/^tp1/i.test(reason))    { rCode = "TP1"; rCls = "tp1"; }
    else if (/sl|stop/i.test(reason)) {
      // "STOPPED_AFTER_TP1" means TP1 was banked then SL hit at breakeven — show TP1
      if (c.status === "STOPPED_AFTER_TP1") { rCode = "TP1+BE"; rCls = "tp1"; }
      else                                  { rCode = "SL";     rCls = "sl";  }
    }
    else if (reason)                  { rCode = reason.split(" ")[0].toUpperCase().slice(0, 6); rCls = "other"; }
    else                              { rCode = "—";    rCls = "other"; }
    // Trade-id subtitle: strip the redundant "COINUSDT_" prefix → "20260427_CWM_001"
    const tid = (c.trade_id || "").replace(/^[A-Z]+(?:USDT)?_/, "");
    return `
      <div class="rc-row ${dirCls}" data-trade-id="${c.trade_id || ""}" title="${c.trade_id || ""}">
        <div class="rc-dot ${won ? 'win' : 'loss'}"></div>
        <div class="rc-dir-pill ${dirCls}">${dirLetter}</div>
        <div class="rc-coin-block">
          <span class="rc-coin">${coin}</span>
          <span class="rc-tid">${tid || "—"}</span>
        </div>
        <div class="rc-reason ${rCls}">${rCode}</div>
        <div class="rc-pnl ${won ? 'pos' : 'neg'}">${pnlStr}</div>
        <div class="rc-ago">${fmtAgo(c.close_iso, { detectedAtIso: state.lastCronIso })}</div>
      </div>`;
  }).join("");
  flipReplace(el, newHtml);
}

function renderMexcCard() {
  const pnlEl = $("mexc-pnl");
  const eqEl  = $("mexc-equity");
  const avEl  = $("mexc-avail");
  if (!pnlEl) return;
  const m = state.mexcAccount;
  if (!m) {
    pnlEl.textContent = "—";
    pnlEl.className = "value hero-value";
    if (eqEl) eqEl.textContent = "—";
    if (avEl) avEl.textContent = "—";
    renderMexcPositions([]);
    return;
  }
  const pnl = m.unrealized_pnl;
  pnlEl.className = "value hero-value " + cls(pnl);
  animateValue(pnlEl, pnl, fmtUsd);
  if (eqEl) animateValue(eqEl, m.equity,    v => "$" + Math.round(v).toLocaleString("en-US"));
  if (avEl) animateValue(avEl, m.available, v => "$" + Math.round(v).toLocaleString("en-US"));
  renderMexcPositions(m.positions || []);
}

function renderMexcPositions(positions) {
  const host = $("mexc-positions");
  if (!host) return;
  if (!positions.length) {
    host.innerHTML = '<div class="mexc-pos-empty">No open positions</div>';
    return;
  }
  // MEXC = user's personal live trades. Independent from paper system.
  // Bar shows: SL (actual MEXC stop-loss order, or liquidation fallback) on the
  // left, entry centred, live mark dot, and TP (actual MEXC take-profit) on the
  // right when set.
  const newHtml = positions.map(p => {
    const coin = p.coin.replace("USDT", "");
    const isLong = p.direction === "Long";
    const dirCls = isLong ? "long" : "short";
    const pnlCls = cls(p.unrealized_pnl);

    // Support legacy single p.tp + new p.tp1/p.tp2; same for SL
    const tp1Price = (p.tp1 != null && p.tp1 > 0) ? p.tp1 : ((p.tp != null && p.tp > 0) ? p.tp : null);
    const tp2Price = (p.tp2 != null && p.tp2 > 0) ? p.tp2 : null;
    const sl1Price = (p.sl  != null && p.sl  > 0) ? p.sl  : null;
    const sl2Price = (p.sl2 != null && p.sl2 > 0) ? p.sl2 : null;

    // Left edge = worst SL (furthest from entry). Right edge = furthest TP.
    const slPrice = sl1Price ?? p.liq;
    const slIsLiq = !sl1Price;
    const furthestTp = tp2Price ?? tp1Price;
    const rightPrice = furthestTp != null
      ? furthestTp
      : (isLong ? p.entry + Math.abs(p.entry - slPrice)
                : p.entry - Math.abs(p.entry - slPrice));

    const posOf = price => {
      const v = (price - slPrice) / (rightPrice - slPrice);
      return Math.max(0, Math.min(1, v)) * 100;
    };

    const slPct  = posOf(slPrice);
    const sl2Pct = sl2Price != null ? posOf(sl2Price) : null;
    const ePct   = posOf(p.entry);
    const mPct   = posOf(p.mark);
    const tp1Pct = tp1Price != null ? posOf(tp1Price) : null;
    const tp2Pct = tp2Price != null ? posOf(tp2Price) : null;
    const liveColor = p.unrealized_pnl >= 0 ? cssVar("--green") : cssVar("--red");

    const titleAttr = [
      `Entry ${p.entry}`, `Mark ${p.mark}`,
      sl1Price  ? `SL  ${sl1Price}`  : `Liq ${p.liq}`,
      sl2Price  ? `SL2 ${sl2Price}`  : null,
      tp1Price  ? `TP1 ${tp1Price}`  : null,
      tp2Price  ? `TP2 ${tp2Price}`  : null,
    ].filter(Boolean).join(" · ");

    return `
      <div class="mexc-pos-row" data-pos-key="${p.coin}_${p.direction}">
        <div class="mexc-pos-head">
          <span class="mexc-pos-coin">${coin}</span>
          <span class="mexc-pos-dir ${dirCls}">${isLong ? "L" : "S"}${p.leverage ? "·" + p.leverage + "x" : ""}</span>
        </div>
        <div class="mexc-pos-bar" title="${titleAttr}">
          <div class="mexc-pos-track"></div>
          <div class="mexc-pos-marker sl${slIsLiq ? " liq-fallback" : ""}" style="left:${slPct.toFixed(1)}%"></div>
          ${sl2Pct !== null ? `<div class="mexc-pos-marker sl2" style="left:${sl2Pct.toFixed(1)}%"></div>` : ""}
          <div class="mexc-pos-marker entry" style="left:${ePct.toFixed(1)}%"></div>
          ${tp1Pct !== null ? `<div class="mexc-pos-marker tp1" style="left:${tp1Pct.toFixed(1)}%"></div>` : ""}
          ${tp2Pct !== null ? `<div class="mexc-pos-marker tp2" style="left:${tp2Pct.toFixed(1)}%"></div>` : ""}
          <div class="mexc-pos-dot" style="left:${mPct.toFixed(1)}%;background:${liveColor};box-shadow:0 0 8px ${liveColor}"></div>
        </div>
        <div class="mexc-pos-pnl ${pnlCls}">${fmtUsd(p.unrealized_pnl)}</div>
      </div>`;
  }).join("");
  flipReplace(host, newHtml, "data-pos-key");
}

// === Bloomberg news flash ===
// Per-dashboard storage keys: paper + live share localStorage (same origin)
// but track "seen" articles independently. Otherwise whichever tab polls
// first consumes the news for the other.
const BLOOMBERG_SEEN_KEY = "bloombergSeenIds_v2_paper";
const BLOOMBERG_FIRSTRUN_KEY = "bloombergFirstRun_v2_paper";
function loadBloombergSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(BLOOMBERG_SEEN_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveBloombergSeen(s) {
  localStorage.setItem(BLOOMBERG_SEEN_KEY, JSON.stringify([...s].slice(-50)));
}
let bloombergSeen = loadBloombergSeen();
let bloombergFirstRun = !localStorage.getItem(BLOOMBERG_FIRSTRUN_KEY);

function checkBloombergNews(articles) {
  // Bloomberg news-flash popups DISABLED per user request (2026-06-17).
  // To re-enable, remove this early return + re-enable fetchBloombergNews below.
  return;
  if (!articles) return;
  if (bloombergFirstRun) {
    // First load: mark existing articles as seen so we don't replay old news.
    // Always complete this block even if array is empty, so bloombergFirstRun
    // is set to false before new articles can arrive on the next fetch.
    articles.forEach(a => bloombergSeen.add(a.id));
    saveBloombergSeen(bloombergSeen);
    localStorage.setItem(BLOOMBERG_FIRSTRUN_KEY, "1");
    bloombergFirstRun = false;
    return;
  }
  if (!articles.length) return;
  const fresh = articles.filter(a => !bloombergSeen.has(a.id));
  fresh.slice(0, 3).forEach((a, i) => {
    setTimeout(() => showNewsFlash(a), i * 6500);
  });
}

let nfBusy = false;
function showNewsFlash(article) {
  if (nfBusy) return;
  nfBusy = true;
  bloombergSeen.add(article.id);
  saveBloombergSeen(bloombergSeen);
  const el = document.getElementById("news-flash");
  document.getElementById("nf-headline").textContent = article.headline || article.title || "";
  el.classList.remove("out");
  el.hidden = false;
  playSound("bloomberg");
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => { el.hidden = true; el.classList.remove("out"); nfBusy = false; }, 500);
  }, 15000);
}

// === BTC / ETH / SOL live price bar ===
const SPOTLIGHT_COINS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

async function fetchSpotlightPrices() {
  try {
    const symbols = JSON.stringify(SPOTLIGHT_COINS);
    const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbols)}`);
    const data = await r.json();
    for (const t of data) {
      const sym = t.symbol.replace("USDT", "");
      const price = parseFloat(t.lastPrice);
      const chg = parseFloat(t.priceChangePercent);
      const el = document.getElementById(`px-${sym}`);
      if (!el) continue;
      const fmt = price >= 1000 ? price.toLocaleString("en-US", {maximumFractionDigits: 0})
                : price >= 10   ? price.toFixed(2)
                : price.toFixed(3);
      el.querySelector(".px-val").textContent = "$" + fmt;
      const chgEl = el.querySelector(".px-chg");
      chgEl.textContent = (chg >= 0 ? "▲" : "▼") + Math.abs(chg).toFixed(2) + "%";
      chgEl.className = "px-chg " + (chg >= 0 ? "pos" : "neg");
    }
  } catch (e) { console.error("spotlight prices failed", e); }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
}

function renderLive() {
  const open = state.trades.filter(t => t.status === "OPEN");
  const enriched = open.map(t => ({ ...t, ...computeUnrealized(t) }));
  renderPaperBars(enriched);
  renderHero(enriched);
  // Keep Screen 4 hero P&L in sync with live prices (cheap incremental update)
  if (typeof updateEdgeLivePnL === "function") updateEdgeLivePnL();
}

function renderPaperBars(enrichedOpen) {
  const host = $("paper-bars");
  if (!host) return;
  if (!enrichedOpen.length) {
    host.innerHTML = '<div class="paper-bars-empty">No open paper trades — system is watching.</div>';
    return;
  }
  // Winners on top, losers below — sorted by total blended % P&L descending.
  function totalPct(t) {
    if (t.tp1_hit) return ((t.tp1BankedUsd || 0) + (t.usd ?? 0)) / (t.capital_usd || 100) * 100;
    return t.leveragedPct || 0;
  }
  const sorted = [...enrichedOpen].sort((a, b) => totalPct(b) - totalPct(a));
  const realTrades  = sorted.filter(t => !t.track_only);
  const trackTrades = sorted.filter(t =>  t.track_only);

  // Density tier based on per-column count (the larger column drives the tier)
  const maxCol = Math.max(realTrades.length, trackTrades.length);
  host.classList.remove("pb-compact", "pb-mini", "pb-tiny");
  if      (maxCol >= 13) host.classList.add("pb-tiny");
  else if (maxCol >= 10) host.classList.add("pb-mini");
  else if (maxCol >= 7)  host.classList.add("pb-compact");

  const barHtml = t => {
    const isLong = t.direction === "Long";
    const dirCls = isLong ? "long" : "short";
    const coin = (t.coin || "").replace("USDT", "");
    const sys  = t.trading_system || "";
    const tp1Hit = !!t.tp1_hit;
    const beActive = tp1Hit || !!t.sl_moved_to_be;
    const tp1Cls = tp1Hit ? " tp1-hit" : "";

    // Scale: SL = 0%, furthest TP = 100%. Both TP1 + TP2 always land on the bar.
    const sl = t.sl;
    const tp1 = t.tp1;
    const tp2 = t.tp2;
    const hasTP2 = !!(tp2 && tp2 !== tp1);
    const furthest = hasTP2
      ? (isLong ? Math.max(tp1, tp2) : Math.min(tp1, tp2))
      : tp1;
    const span = isLong ? (furthest - sl) : (sl - furthest);
    const posOf = price => {
      const v = isLong ? (price - sl) / span : (sl - price) / span;
      return Math.max(0, Math.min(1, v)) * 100;
    };
    const slPct  = 0;
    const ePct   = posOf(t.entry_price);
    const lPct   = posOf(t.live);
    const t1Pct  = posOf(tp1);
    const t2Pct  = hasTP2 ? posOf(tp2) : null;

    const liveColor = lPct < 33 ? cssVar("--red") : lPct > 66 ? cssVar("--green") : cssVar("--orange");

    // For tp1_hit trades: blended % = total P&L / capital (not raw price move)
    const usd = (t.tp1BankedUsd || 0) + (t.usd ?? 0);
    const pct = tp1Hit ? (usd / (t.capital_usd || 100) * 100) : (t.leveragedPct ?? 0);
    const pctCls = cls(usd);
    // Breakdown line: TP1-hit shows banked + live; non-TP1 shows live only (same format for consistency)
    const liveUsd = t.usd ?? 0;
    const bankedUsd = t.tp1BankedUsd || 0;
    const breakdownHtml = tp1Hit
      ? `<div class="pb-pnl-breakdown">
           <div class="pb-bd-row"><span class="pb-bd-k">banked</span><span class="pb-bd-v pos">${fmtUsd(bankedUsd)}</span></div>
           <div class="pb-bd-row"><span class="pb-bd-k">live</span><span class="pb-bd-v ${cls(liveUsd)}">${fmtUsd(liveUsd)}</span></div>
         </div>`
      : `<div class="pb-pnl-breakdown">
           <div class="pb-bd-row"><span class="pb-bd-k">live</span><span class="pb-bd-v ${cls(liveUsd)}">${fmtUsd(liveUsd)}</span></div>
         </div>`;

    // Filled segment showing TP1-achieved range
    const achieved = tp1Hit ? `<div class="pb-achieved" style="left:${Math.min(ePct,t1Pct).toFixed(1)}%;width:${Math.abs(t1Pct-ePct).toFixed(1)}%"></div>` : "";

    return `
      <div class="paper-bar-row ${dirCls}${tp1Cls}${t.track_only ? " pb-track-only" : ""}" data-trade-id="${t.trade_id}" title="${t.trade_id}">
        <div class="pb-head">
          <div class="pb-coin-row">
            <span class="pb-coin">${coin}</span>
            <span class="pb-live-px">${fmtPrice(t.live)}</span>
          </div>
          <div class="pb-meta">
            ${_isMexcRelevant(t) ? '<span class="pb-mexc">mexc</span>' : ""}
            <span class="pb-dir ${dirCls}" title="${isLong ? "Long" : "Short"}">${isLong ? "L" : "S"}</span>
            <span class="pb-sys">${sys}</span>
            ${beActive ? '<span class="pb-be">BE</span>' : ""}
          </div>
        </div>
        <div class="pb-bar">
          <div class="pb-track"></div>
          ${achieved}
          ${!beActive ? `<span class="pb-flag sl" style="left:${slPct}%">SL</span>` : ""}
          <span class="pb-flag entry${beActive ? " be" : ""}" style="left:${ePct.toFixed(1)}%">${beActive ? "BE" : "ENTRY"}</span>
          <span class="pb-flag tp1${tp1Hit ? " hit" : ""}" style="left:${t1Pct.toFixed(1)}%">TP1</span>
          ${t2Pct !== null ? `<span class="pb-flag tp2" style="left:${t2Pct.toFixed(1)}%">TP2</span>` : ""}
          ${!beActive ? `<div class="pb-marker sl" style="left:${slPct}%"></div>` : ""}
          <div class="pb-marker entry${beActive ? " be" : ""}" style="left:${ePct.toFixed(1)}%"></div>
          <div class="pb-marker tp1${tp1Hit ? " hit" : ""}" style="left:${t1Pct.toFixed(1)}%"></div>
          ${t2Pct !== null ? `<div class="pb-marker tp2" style="left:${t2Pct.toFixed(1)}%"></div>` : ""}
          <div class="pb-dot" style="left:${lPct.toFixed(1)}%;background:${liveColor};box-shadow:0 0 12px ${liveColor},0 0 4px ${liveColor}"></div>
          <div class="pb-prices">
            ${!beActive ? `<span class="pb-price-val sl" style="left:${slPct}%">${fmtPrice(sl)}</span>` : ""}
            <span class="pb-price-val entry" style="left:${ePct.toFixed(1)}%">${fmtPrice(t.entry_price)}</span>
            <span class="pb-price-val tp1"   style="left:${t1Pct.toFixed(1)}%">${fmtPrice(tp1)}</span>
            ${t2Pct !== null ? `<span class="pb-price-val tp2" style="left:${t2Pct.toFixed(1)}%">${fmtPrice(tp2)}</span>` : ""}
          </div>
        </div>
        <div class="pb-pnl">
          <div class="pb-pnl-pct ${pctCls}">${fmtPct(pct)}</div>
          <div class="pb-pnl-usd">${fmtUsd(usd)}</div>
          ${breakdownHtml}
        </div>
        <div class="pb-tid pb-tid-foot" title="Double-click to copy">${t.trade_id || ""}</div>
      </div>`;
  };

  const colHtml = (trades, label, count) => {
    const body = trades.length
      ? trades.map(barHtml).join("")
      : `<div class="paper-bars-empty">No ${label.toLowerCase()} open</div>`;
    return `
      <div class="pb-col">
        <div class="pb-col-head">
          <span class="pb-col-label">${label}</span>
          <span class="pb-col-count">${count}</span>
        </div>
        <div class="pb-col-body">${body}</div>
      </div>`;
  };

  flipReplace(host, `
    <div class="pb-cols">
      ${colHtml(realTrades,  "REAL TRADES", realTrades.length)}
      ${colHtml(trackTrades, "TRACK ONLY",  trackTrades.length)}
    </div>`);
}

// ── Screen 0: P&L overview (iPhone-first) ──
function renderS0() {
  // --- Paper ---
  const enriched = state.trades.filter(t => t.status === "OPEN").map(t => ({ ...t, ...computeUnrealized(t) }));
  const unrealized = enriched.reduce((s, t) => s + t.usd, 0);
  const tp1Banked  = enriched.reduce((s, t) => s + (t.tp1BankedUsd || 0), 0);
  const realized   = (state.stats.realized_pnl_usd ?? 0) + tp1Banked;
  const total      = realized + unrealized;
  const totalCap   = enriched.reduce((s, t) => s + (t.capital_usd || 100), 0);
  const closedCap  = (state.stats.closed_count ?? 0) * 100;
  const totalDeployed = closedCap + totalCap;
  const retPct = totalDeployed > 0 ? (total / totalDeployed) * 100 : 0;
  const wr  = state.stats.win_rate_pct ?? 0;
  const cl  = state.stats.closed_count ?? 0;

  const s0tot = $("s0-paper-total");
  if (s0tot) { s0tot.className = "s0-big " + cls(total); animateValue(s0tot, total, fmtUsd); }
  const s0pct = $("s0-paper-pct");
  if (s0pct) { s0pct.textContent = (retPct >= 0 ? "+" : "") + retPct.toFixed(2) + "% return on capital"; s0pct.className = "s0-return " + cls(total); }
  const s0r = $("s0-realized");   if (s0r) { s0r.textContent = fmtUsd(realized);   s0r.className = "s0-v " + cls(realized); }
  const s0u = $("s0-unrealized"); if (s0u) { s0u.textContent = enriched.length ? fmtUsd(unrealized) : "—"; s0u.className = "s0-v " + (enriched.length ? cls(unrealized) : ""); }
  const s0w = $("s0-winrate");    if (s0w) { s0w.textContent = cl ? wr.toFixed(1) + "%" : "—"; s0w.className = "s0-v " + (wr >= 50 ? "pos" : wr >= 30 ? "warn" : cl ? "neg" : ""); }
  const s0c = $("s0-capital");    if (s0c) { s0c.textContent = totalCap ? "$" + totalCap.toFixed(0) : "—"; s0c.className = "s0-v"; }

  // --- MEXC ---
  const m = state.mexcAccount;
  const s0mp = $("s0-mexc-pnl");
  if (s0mp) {
    if (!m) { s0mp.textContent = "—"; s0mp.className = "s0-big"; }
    else { s0mp.className = "s0-big " + cls(m.unrealized_pnl); animateValue(s0mp, m.unrealized_pnl, fmtUsd); }
  }
  const s0eq  = $("s0-equity"); if (s0eq) s0eq.textContent = m ? "$" + m.equity.toLocaleString("en-US", {maximumFractionDigits: 0}) : "—";
  const s0av  = $("s0-avail");  if (s0av) s0av.textContent = m ? "$" + m.available.toLocaleString("en-US", {maximumFractionDigits: 0}) : "—";
  const s0mg  = $("s0-margin"); if (s0mg) s0mg.textContent = m ? "$" + (m.position_margin || 0).toLocaleString("en-US", {maximumFractionDigits: 0}) : "—";

  const posHost = $("s0-positions");
  if (posHost) {
    const positions = m?.positions || [];
    if (!positions.length) {
      posHost.innerHTML = '<div class="s0-pos-empty">No open positions</div>';
    } else {
      posHost.innerHTML = positions.map(p => {
        const coin = (p.coin || p.symbol || "").replace("_USDT", "").replace("USDT", "");
        const isLong = p.direction === "Long";
        const dirCls = isLong ? "long" : "short";
        const pnl = p.unrealized_pnl ?? 0;
        const pnlCls = pnl >= 0 ? "pos" : "neg";
        return `<div class="s0-pos-row">
          <div class="s0-pos-left">
            <span class="s0-pos-coin">${coin}</span>
            <span class="s0-pos-dir ${dirCls}">${isLong ? "L" : "S"}${p.leverage ? " · " + p.leverage + "x" : ""}</span>
          </div>
          <div class="s0-pos-right">
            <span class="s0-pos-pnl ${pnlCls}">${fmtUsd(pnl)}</span>
            <span class="s0-pos-px">${fmtPrice(p.mark || p.entry)}</span>
          </div>
        </div>`;
      }).join("");
    }
  }
}

function renderHero(enrichedOpen) {
  const enriched = enrichedOpen || state.trades.filter(t => t.status === "OPEN").map(t => ({ ...t, ...computeUnrealized(t) }));
  const unrealized = enriched.reduce((s, t) => s + t.usd, 0);
  const totalCap   = enriched.reduce((s, t) => s + (t.capital_usd || 100), 0);
  // realized = fully-closed trades + banked TP1 portion from still-open tp1_hit trades
  const tp1Banked  = enriched.reduce((s, t) => s + (t.tp1BankedUsd || 0), 0);
  const realized   = (state.stats.realized_pnl_usd ?? 0) + tp1Banked;
  const total      = realized + unrealized;

  const pEl = $("portfolio-total");
  if (pEl) {
    pEl.className = "value hero-value " + cls(total);
    animateValue(pEl, total, fmtUsd);
    setTileGlow(pEl.closest(".tile"), total);
  }
  const rEl = $("hero-realized");
  const uEl = $("hero-unrealized");
  const cEl = $("hero-capital");
  if (rEl) {
    rEl.className = "hero-stat-val " + cls(realized);
    animateValue(rEl, realized, fmtUsd);
  }
  if (uEl) {
    uEl.className = "hero-stat-val " + (enriched.length ? cls(unrealized) : "");
    if (enriched.length) animateValue(uEl, unrealized, fmtUsd);
    else uEl.textContent = "—";
  }
  // --- Daily deltas (since 00:00 UTC today) ---
  // Both REALIZED and UNREALIZED snapshot at first render of the UTC day so
  // the deltas reconcile to actual day P&L change. Earlier version enumerated
  // closes for realizedToday — that missed TP1 banks on still-open trades
  // (e.g. THETA hits TP1 mid-day → $16.68 banked but daily realized stayed flat).
  // Snapshot approach catches: new full closes, new TP1 banks, anything that
  // moves the realized total.
  const utcDayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  function _readDaySnapshot(prefix, currentValue) {
    try {
      const KEY = prefix + utcDayKey;
      // Prune yesterday/older keys for this prefix
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix) && k !== KEY) localStorage.removeItem(k);
      }
      const existing = localStorage.getItem(KEY);
      if (existing == null) {
        localStorage.setItem(KEY, String(currentValue));
        return currentValue;
      }
      return parseFloat(existing);
    } catch (e) { return null; /* localStorage blocked */ }
  }
  const realizedBaseline = _readDaySnapshot("realSnap_",   realized);
  const unrealBaseline   = _readDaySnapshot("unrealSnap_", unrealized);
  const realizedDayDelta = realizedBaseline == null ? null : realized - realizedBaseline;
  const unrealDayDelta   = unrealBaseline   == null ? null : unrealized - unrealBaseline;

  const rDayEl = $("hero-realized-day");
  if (rDayEl) {
    if (realizedDayDelta == null) {
      rDayEl.textContent = "—";
      rDayEl.className = "hero-stat-sub";
    } else {
      rDayEl.textContent = fmtUsd(realizedDayDelta);
      rDayEl.className = "hero-stat-sub " + cls(realizedDayDelta);
    }
  }
  const uDayEl = $("hero-unrealized-day");
  if (uDayEl) {
    if (unrealDayDelta == null) {
      uDayEl.textContent = "—";
      uDayEl.className = "hero-stat-sub";
    } else {
      uDayEl.textContent = fmtUsd(unrealDayDelta);
      uDayEl.className = "hero-stat-sub " + cls(unrealDayDelta);
    }
  }
  if (cEl) {
    cEl.className = "hero-stat-val";
    if (enriched.length) animateValue(cEl, totalCap, v => "$" + v.toFixed(0));
    else cEl.textContent = "—";
  }
  const pctEl2 = $("hero-pct");
  if (pctEl2) {
    const closedCap = (state.stats.closed_count ?? 0) * 100;
    const totalDeployed = closedCap + totalCap;
    const retPct = totalDeployed > 0 ? (total / totalDeployed) * 100 : 0;
    // Bracketed % rendered inline next to the big $ value (no longer a
    // separate "on all capital deployed" sentence).
    pctEl2.textContent = "(" + (retPct >= 0 ? "+" : "") + retPct.toFixed(2) + "%)";
    pctEl2.className = "hero-pct-inline " + cls(total);
  }

  // Real-only breakdown (excludes track_only signals)
  const realStats = state.stats.real_only;
  if (realStats) {
    const realOpen   = enriched.filter(t => !t.track_only);
    const realUnreal = realOpen.reduce((s, t) => s + t.usd, 0);
    const realTp1Bk  = realOpen.reduce((s, t) => s + (t.tp1BankedUsd || 0), 0);
    const realRealiz = (realStats.realized_pnl_usd ?? 0) + realTp1Bk;
    const realTotal  = realRealiz + realUnreal;
    const rwr        = realStats.win_rate_pct ?? 0;
    const rcl        = realStats.closed_count ?? 0;
    const pnlEl   = $("hr-pnl");
    const wrEl    = $("hr-wr");
    const cntEl   = $("hr-count");
    if (pnlEl) { pnlEl.textContent = fmtUsd(realTotal); pnlEl.className = "hr-pnl " + cls(realTotal); }
    if (wrEl)  { wrEl.textContent  = rwr.toFixed(1) + "% WR"; }
    if (cntEl) { cntEl.textContent = rcl + " closed"; }
  }

  // Donut
  const wr = state.stats.win_rate_pct ?? 0;
  const closed = state.stats.closed_count ?? 0;
  const wins = Math.round((wr / 100) * closed);
  const losses = closed - wins;
  const pctEl = $("donut-pct");
  const subEl = $("donut-sub");
  const circle = $("donut-fill-circle");
  if (pctEl) pctEl.textContent = closed ? wr.toFixed(1) + "%" : "—";
  if (subEl) subEl.textContent = closed ? `${wins}W · ${losses}L · ${closed} closed` : "no closes yet";
  if (circle) {
    const C = 2 * Math.PI * 50;
    circle.style.strokeDashoffset = (C - (wr / 100) * C).toFixed(2);
    const color = wr >= 50 ? "#00c9a7" : wr >= 30 ? "#ffb74d" : "#ff4d5e";
    const glow  = wr >= 50 ? "rgba(0,201,167,0.5)" : wr >= 30 ? "rgba(255,183,77,0.45)" : "rgba(255,77,94,0.5)";
    circle.style.stroke = color;
    circle.style.filter = `drop-shadow(0 0 8px ${glow})`;
  }

  renderEquitySparkline(state.recentCloses || []);
}

// Monotone-cubic Hermite (Fritsch–Carlson) — smooth curve through points
// that NEVER overshoots in x and never overshoots in y where the source
// data is monotone. Use this instead of Catmull–Rom for time-series where
// any backward fold would be visually wrong. Input/output: [[x,y], ...].
function _monotoneCubicPath(pts) {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0][0]} ${pts[0][1]}`;
  if (n === 2) return `M${pts[0][0]} ${pts[0][1]} L${pts[1][0]} ${pts[1][1]}`;

  // Slopes of secant lines
  const dx = new Array(n - 1), dy = new Array(n - 1), d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    d[i]  = dx[i] === 0 ? 0 : dy[i] / dx[i];
  }
  // Tangents m[i]
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;                                    // local extremum → flat tangent
    } else {
      m[i] = (d[i - 1] + d[i]) / 2;
    }
  }
  // Fritsch–Carlson monotonicity adjustment
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i]     = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  // Emit cubic Bezier per segment from Hermite tangents
  let out = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    const c1x = pts[i][0]     + h / 3;
    const c1y = pts[i][1]     + h * m[i]     / 3;
    const c2x = pts[i + 1][0] - h / 3;
    const c2y = pts[i + 1][1] - h * m[i + 1] / 3;
    out += ` C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${pts[i + 1][0].toFixed(2)} ${pts[i + 1][1].toFixed(2)}`;
  }
  return out;
}

function renderEquitySparkline(recentCloses) {
  const svg = document.getElementById("equity-spark");
  const overlay = document.getElementById("equity-spark-overlay");
  if (!svg) return;

  // Source: full equity curve since inception from analytics.json.
  const curve = (_edgeAnalytics && _edgeAnalytics.equity_curve) || [];

  // BDC series: cumulative USD P&L since inception, anchored at $0.
  const closes = curve
    .filter(p => p && p.iso != null)
    .map(p => ({
      iso: p.iso,
      cum: p.cumulative || 0,
      pnl_usd: p.pnl,
      won: p.won,
    }));

  if (!closes.length) {
    svg.innerHTML = "";
    if (overlay) overlay.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.25);font-size:11px">no closed trades yet</div>';
    return;
  }

  // Prepend a $0 anchor a few hours before the first close so the curve
  // visibly starts at the $0 baseline (and avoids a duplicate-x point that
  // would break the smooth-path interpolation).
  const tFirst = new Date(closes[0].iso).getTime();
  const tLast  = new Date(closes[closes.length - 1].iso).getTime();
  const totalMs = (tLast - tFirst) || 1;
  const anchorOffset = Math.max(6 * 3600_000, totalMs * 0.01);   // 1% pre-pad
  const t0 = tFirst - anchorOffset;
  const tEnd = tLast;
  const tSpan = (tEnd - t0) || 1;
  // Resample the curve to ONE POINT PER DAY (last cumulative of that day)
  // so the smooth path has ~15-30 control points instead of ~100. With 100
  // tight vertices Catmull–Rom produces a jagged ribbon; daily resampling
  // gives the long, sweeping curve in the reference design.
  const byDay = new Map();
  closes.forEach(p => {
    const key = p.iso.slice(0, 10);          // YYYY-MM-DD
    byDay.set(key, p);                       // overwrite — last close of day wins
  });
  const daily = Array.from(byDay.values())
    .sort((a, b) => new Date(a.iso) - new Date(b.iso));

  // Anchor at $0 a few hours before the first close, then daily samples.
  const series = [{ iso: new Date(t0).toISOString(), cum: 0, anchor: true }, ...daily];

  // Use the wrap's actual pixel size as the SVG viewBox — no stretching, so
  // strokes draw at their literal pixel width.
  const wrap = svg.parentElement;
  const W = Math.max(300, wrap ? wrap.clientWidth  : 800);
  const H = Math.max(160, wrap ? wrap.clientHeight : 220);
  const PAD_L = 56, PAD_R = 22, PAD_T = 16, PAD_B = 30;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  // Y range: include 0 and all cum values. Pick a "nice" tick step.
  const vals = series.map(p => p.cum);
  let yMin = Math.min(0, ...vals);
  let yMax = Math.max(0, ...vals);
  const pad = Math.max(5, (yMax - yMin) * 0.12);
  yMin -= pad; yMax += pad;
  // Nice step: aim for ~5 ticks.
  const rough = (yMax - yMin) / 5;
  const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
  const niceMult = [1, 2, 2.5, 5, 10].find(m => m * pow10 >= rough) || 10;
  const step = niceMult * pow10;
  yMin = Math.floor(yMin / step) * step;
  yMax = Math.ceil(yMax / step) * step;
  const yRange = (yMax - yMin) || 1;

  const xFor = iso => PAD_L + ((new Date(iso).getTime() - t0) / tSpan) * innerW;
  const yFor = v   => PAD_T + (1 - (v - yMin) / yRange) * innerH;

  // Grid lines only — Y labels are rendered in the HTML overlay so they
  // don't get squashed by preserveAspectRatio="none".
  let gridHtml = "";
  const yTicks = [];
  for (let v = yMin; v <= yMax + 0.0001; v += step) {
    const y = yFor(v).toFixed(2);
    const isZero = Math.abs(v) < 0.0001;
    gridHtml += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="${isZero ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)"}" stroke-width="1"/>`;
    yTicks.push({ v, yPct: (y / H) * 100 });
  }

  // BDC path. Monotone-cubic Hermite (Fritsch–Carlson) — guarantees the
  // curve never overshoots in x (no backward folds) and never overshoots
  // in y where the data is monotone. Catmull–Rom does neither, which is
  // why it produced reversed loops between same-day-ish points.
  const bdcPts = series.map(p => [xFor(p.iso), yFor(p.cum)]);
  const bdcLine = _monotoneCubicPath(bdcPts);
  const bdcLastX = bdcPts[bdcPts.length - 1][0];
  const bdcFirstX = bdcPts[0][0];
  const baseY = yFor(Math.max(yMin, 0)).toFixed(2);
  const bdcArea = bdcLine + ` L${bdcLastX.toFixed(2)} ${baseY} L${bdcFirstX.toFixed(2)} ${baseY} Z`;

  // Color the line by Y value: green where cumulative is above $0, red where
  // it's below $0. Achieved with a vertical SVG linear gradient that flips
  // at the zero-line's pixel position. If $0 is outside the chart's y range
  // the gradient saturates to one color.
  const GREEN_RGB = "0,201,167";
  const RED_RGB   = "255,77,94";
  const zeroY = Math.max(PAD_T, Math.min(PAD_T + innerH, yFor(0)));
  const zeroOffset = Math.max(0, Math.min(1, zeroY / H));
  // Tiny epsilon so the stop is a hard line, not a band gradient.
  const EPS = 0.0005;
  const offAbove = Math.max(0, zeroOffset - EPS).toFixed(6);
  const offBelow = Math.min(1, zeroOffset + EPS).toFixed(6);

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  // Glassy line = three stacked strokes (wide halo → translucent core →
  // thin highlight), all painted with a green-above-zero / red-below-zero
  // gradient. Area fill mirrors the same color split with low alpha.
  svg.innerHTML = `
    <defs>
      <linearGradient id="bdc-line-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${H}">
        <stop offset="0"          stop-color="rgb(${GREEN_RGB})"/>
        <stop offset="${offAbove}" stop-color="rgb(${GREEN_RGB})"/>
        <stop offset="${offBelow}" stop-color="rgb(${RED_RGB})"/>
        <stop offset="1"          stop-color="rgb(${RED_RGB})"/>
      </linearGradient>
      <linearGradient id="bdc-area-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${H}">
        <stop offset="0"          stop-color="rgb(${GREEN_RGB})" stop-opacity="0.28"/>
        <stop offset="${offAbove}" stop-color="rgb(${GREEN_RGB})" stop-opacity="0.04"/>
        <stop offset="${offBelow}" stop-color="rgb(${RED_RGB})"   stop-opacity="0.04"/>
        <stop offset="1"          stop-color="rgb(${RED_RGB})"   stop-opacity="0.28"/>
      </linearGradient>
    </defs>
    ${gridHtml}
    <path d="${bdcArea}" fill="url(#bdc-area-grad)"/>
    <path d="${bdcLine}" fill="none" stroke="url(#bdc-line-grad)" stroke-width="9"
          stroke-linecap="round" stroke-linejoin="round"
          opacity="0.22" style="filter: blur(2.5px)"/>
    <path d="${bdcLine}" fill="none" stroke="url(#bdc-line-grad)" stroke-width="3.5"
          stroke-linecap="round" stroke-linejoin="round" opacity="0.65"/>
    <path d="${bdcLine}" fill="none" stroke="rgba(255,255,255,0.55)" stroke-width="0.8"
          stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
  `;

  // HTML overlay: Y-axis $ labels, X-axis dates, win/loss dots (no coin labels).
  if (!overlay) return;
  const fmtDate = iso => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const fmtDollar = v => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });

  // Y-axis $ labels (in left padding area)
  let yLabelsHtml = "";
  yTicks.forEach(t => {
    yLabelsHtml += `<div class="spark-ytick" style="top:${t.yPct.toFixed(2)}%">${fmtDollar(t.v)}</div>`;
  });

  // Dots: one per actual close. No coin name label — dots only.
  let dotsHtml = "";
  closes.forEach(p => {
    const xPct = (xFor(p.iso) / W) * 100;
    const yPct = (yFor(p.cum) / H) * 100;
    const won = p.won != null ? p.won : (p.pnl_usd || 0) > 0;
    const cls = won ? "win" : "loss";
    const pnlStr = ((p.pnl_usd || 0) >= 0 ? "+$" : "-$") + Math.abs(p.pnl_usd || 0).toFixed(2);
    dotsHtml += `<div class="spark-dot ${cls}" style="left:${xPct.toFixed(2)}%;top:${yPct.toFixed(2)}%" title="${fmtDate(p.iso)} · ${pnlStr}"></div>`;
  });

  // X-axis dates — ~6 evenly spaced ticks.
  const N_TICKS = 6;
  let datesHtml = "";
  for (let i = 0; i <= N_TICKS; i++) {
    const t = t0 + (tSpan * i) / N_TICKS;
    const xPct = ((PAD_L + (i / N_TICKS) * innerW) / W) * 100;
    const label = fmtDate(new Date(t).toISOString());
    datesHtml += `<div class="spark-date axis" style="left:${xPct.toFixed(2)}%">${label}</div>`;
  }

  overlay.innerHTML = `${yLabelsHtml}${dotsHtml}${datesHtml}`;
}

function fmtAgo(iso, opts) {
  if (!iso) return "";
  let d = new Date(iso);
  // Source-data quirk: time_closed_utc is set to the 4H bar's OPEN time
  // (e.g. "12:00") even though the actual close detection happens at the next
  // cron run, which can be up to 4 hours later. For very-recent closes, the
  // bar-open timestamp makes the display say "3h ago" when the user just saw
  // it happen. If the close falls inside the most-recent 4H bar window (i.e.
  // bar_open + 4h >= lastCronIso > bar_open), the cron run time is a much
  // better approximation of "when this was actually detected".
  if (opts && opts.detectedAtIso) {
    const detected = new Date(opts.detectedAtIso);
    const fourH = 4 * 3600 * 1000;
    if (detected.getTime() > d.getTime() && detected.getTime() - d.getTime() <= fourH) {
      d = detected;
    }
  }
  const diffMs = Date.now() - d.getTime();
  const diffM = Math.floor(diffMs / 60000);
  if (diffM < 1)  return "just now";
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffMs / 3600000);
  if (diffH < 24) return `${diffH}h ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/Paris" });
}

function fmtPrice(p) {
  return p >= 1000 ? p.toLocaleString("en-US", {maximumFractionDigits: 0})
       : p >= 1    ? p.toPrecision(5)
       : p.toPrecision(4);
}

function positionBar(t) {
  const { live, entry_price, sl, tp1, tp2, direction, tp1_hit, sl_moved_to_be } = t;
  const isLong = direction === "Long";
  // Bar scale: SL = left (0%), furthest target = right (100%).
  // Both TP1 + TP2 always land within the bar regardless of ordering.
  const hasTP2 = !!(tp2 && tp2 !== tp1);
  const furthest = hasTP2
    ? (isLong ? Math.max(tp1, tp2) : Math.min(tp1, tp2))
    : tp1;
  const span = isLong ? (furthest - sl) : (sl - furthest);
  const posOf = price => {
    const v = isLong ? (price - sl) / span : (sl - price) / span;
    return Math.max(0, Math.min(1, v)) * 100; // clamp 0–100%
  };
  const ePct  = posOf(entry_price);
  const lPct  = posOf(live);
  const t1Pct = posOf(tp1);

  const distSL  = Math.abs((live - sl)          / entry_price * 100).toFixed(1);
  const distTP1 = Math.abs((tp1  - live)         / entry_price * 100).toFixed(1);
  const distTP2 = hasTP2 ? Math.abs((tp2 - live) / entry_price * 100).toFixed(1) : null;
  const liveColor = lPct < 33 ? cssVar("--red") : lPct > 66 ? cssVar("--green") : cssVar("--orange");

  const achievedFill = tp1_hit ? `
        <div class="pos-achieved-fill" style="left:${Math.min(ePct,t1Pct).toFixed(1)}%;width:${Math.abs(t1Pct-ePct).toFixed(1)}%"></div>` : "";

  const entryLabel = (tp1_hit || sl_moved_to_be) ? "BE" : "ENTRY";
  const entryFlagExtra = (tp1_hit || sl_moved_to_be) ? " be-flag" : "";
  const entryMarkerExtra = (tp1_hit || sl_moved_to_be) ? " be-marker" : "";

  return `
    <div class="pos-bar">
      <div class="pos-track">
        <div class="pos-fill" style="width:${lPct.toFixed(1)}%;background:linear-gradient(90deg,${liveColor}22,${liveColor}55)"></div>
        ${achievedFill}
        <div class="pos-marker pos-entry-marker${entryMarkerExtra}" style="left:${ePct.toFixed(1)}%">
          <span class="marker-flag entry-flag${entryFlagExtra}">${entryLabel}</span>
        </div>
        <div class="pos-marker pos-tp1-marker${tp1_hit ? " achieved" : ""}" style="left:${t1Pct.toFixed(1)}%">
          <span class="marker-flag tp1-flag${tp1_hit ? " achieved" : ""}">${tp1_hit ? "TP1 ✓" : "TP1"}</span>
        </div>
        ${hasTP2 ? `<div class="pos-marker pos-tp2-marker" style="left:100%"><span class="marker-flag tp2-flag">TP2</span></div>` : ""}
        <div class="pos-dot" style="left:${lPct.toFixed(1)}%;background:${liveColor};box-shadow:0 0 12px ${liveColor},0 0 4px ${liveColor}"></div>
      </div>
      <div class="pos-labels">
        <span class="lbl-sl">${tp1_hit ? "BE" : "SL"} · ${distSL}%</span>
        <span class="lbl-tp1">TP1 · ${distTP1}%</span>
        ${distTP2 !== null ? `<span class="lbl-tp2">TP2 · ${distTP2}%</span>` : ""}
      </div>
    </div>`;
}

const COIN_COLORS = {
  BTC: "#F7931A", ETH: "#627EEA", SOL: "#14F195", XRP: "#0066CC",
  ADA: "#0033AD", DOGE: "#C2A633", BNB: "#F0B90B", AVAX: "#E84142",
  LINK: "#2A5ADA", SUI: "#6FBCF0", ZEC: "#ECB244", TAO: "#FF6B35",
  TRX: "#FF060A", APT: "#06CFCB", HBAR: "#5C2D91", LTC: "#345D9D",
  NEAR: "#00C08B", ONDO: "#3D63E5", RENDER: "#FF4E5E", THETA: "#2AB8E6",
  TON: "#0098EA", UNI: "#FF007A", XLM: "#08B5E5", ALGO: "#00C08B",
  CAKE: "#D1884F",
};
const SYSTEM_TAG = { John: "J", William: "W", Braam: "B", Mong: "M" };
function coinColor(coin) {
  const c = coin.replace("USDT", "");
  return COIN_COLORS[c] || "#7280B5";
}
const COIN_ICON_SLUG = {
  RENDER: "rndr",   // older ticker in icon package
};
function coinIconUrl(coin) {
  const c = coin.replace("USDT", "");
  const slug = (COIN_ICON_SLUG[c] || c).toLowerCase();
  return `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/${slug}.svg`;
}
function tradeAge(t) {
  const d = t.date_activated || t.date_opened;
  const tm = t.time_activated_utc || t.time_opened_utc || "00:00";
  if (!d) return "";
  const iso = `${d}T${tm}:00Z`;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  if (h < 1) return Math.floor(ms / 60000) + "m";
  if (h < 24) return h + "h";
  const days = Math.floor(h / 24);
  return `${days}d ${h - days * 24}h`;
}

function renderMovers(list, kind) {
  if (!list.length) return `<div class="mover empty">No open trades</div>`;
  return list.map(t => {
    const coin = t.coin.replace("USDT", "");
    const color = coinColor(t.coin);
    const isLong = t.direction === "Long";
    const sys = t.trading_system || "";
    const sysShort = SYSTEM_TAG[sys] || (sys ? sys[0] : "");
    const age = tradeAge(t);
    const cap = t.capital_usd || 100;
    const lev = t.leverage || 1;
    const posSize = cap * lev;
    // R-multiple = current move / risk
    const risk = Math.abs(t.entry_price - t.sl);
    const move = isLong ? (t.live - t.entry_price) : (t.entry_price - t.live);
    const rMult = risk > 0 ? move / risk : 0;
    const rStr = (rMult >= 0 ? "+" : "") + rMult.toFixed(2) + "R";
    return `
      <div class="mover ${isLong ? "long-card" : "short-card"}" style="--coin-color:${color}">
        <img class="mover-watermark" src="${coinIconUrl(t.coin)}" alt="" onerror="this.style.display='none'">
        <div class="mover-head">
          <div class="coin-avatar" style="--coin-color:${color}">
            <img class="coin-icon" src="${coinIconUrl(t.coin)}" alt="${coin}" onerror="this.parentElement.classList.add('icon-fail')">
            <span class="coin-fallback">${coin.slice(0,4)}</span>
          </div>
          <div class="mover-meta">
            <div class="coin-name">${coin}</div>
            <div class="mover-tags">
              <span class="dir-tag ${isLong ? "long" : "short"}">${isLong ? "▲ LONG" : "▼ SHORT"}</span>
              ${sysShort ? `<span class="sys-tag" title="${sys}">${sysShort}</span>` : ""}
              ${lev > 1 ? `<span class="lev-tag">${lev}×</span>` : ""}
              ${age ? `<span class="age-tag">${age}</span>` : ""}
              ${t.tp1_hit ? `<span class="tp1-tag" title="TP1 hit, SL at BE">TP1✓</span>` : ""}
            </div>
          </div>
        </div>
        <div class="mover-pnl-block">
          <div class="pnl-main">
            <div class="pnl-pct ${cls(t.leveragedPct)}">${fmtPct(t.leveragedPct)}</div>
            <div class="pnl-sub">
              <span class="pnl-usd ${cls(t.usd)}">${fmtUsd(t.usd)}</span>
              <span class="pnl-r ${cls(rMult)}">${rStr}</span>
            </div>
          </div>
          <div class="pnl-meta">
            <div class="meta-item">
              <div class="meta-label">Position</div>
              <div class="meta-val">$${posSize.toFixed(0)}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Entry</div>
              <div class="meta-val">${fmtPrice(t.entry_price)}</div>
            </div>
            <div class="meta-item">
              <div class="meta-label">Live</div>
              <div class="meta-val live-tick">${fmtPrice(t.live)}</div>
            </div>
          </div>
        </div>
        ${positionBar(t)}
      </div>
    `;
  }).join("");
}

// Live MEXC coin universe (commit e6775f5 — 19 coins). A paper pending
// trade is "MEXC-relevant" if (a) coin is in this set, AND (b) it's a
// real trade (not track-only). Used to label pending rows on screen 3
// so the user can see at a glance which signals route to live.
const LIVE_COINS = new Set([
  "BTC","ETH","SOL","XRP","DOGE","SUI","BNB","ADA","LINK","AVAX",
  "TAO","TRX","NEAR","UNI","XLM","LTC","ALGO","HBAR","ONDO",
]);
function _isMexcRelevant(t) {
  if (t.track_only) return false;
  const c = (t.coin || "").replace("USDT", "");
  return LIVE_COINS.has(c);
}

function renderPendingTriggers() {
  const host = $("triggers");
  const pending = state.trades.filter(t => t.status === "PENDING");
  if (!pending.length) {
    host.innerHTML = '<span class="empty">No pending trades — system is watching.</span>';
    return;
  }

  const enriched = pending.map(t => {
    const live = state.prices[t.coin] ?? t.price_at_run ?? t.entry_price;
    const isLong = t.direction === "Long";
    let distPct;
    if (isLong) {
      distPct = live > (t.entry_hi ?? t.entry_price)
        ? ((live - (t.entry_hi ?? t.entry_price)) / live * 100) : 0;
    } else {
      distPct = live < (t.entry_lo ?? t.entry_price)
        ? (((t.entry_lo ?? t.entry_price) - live) / live * 100) : 0;
    }
    return { ...t, live, distPct, inZone: distPct < 0.1 };
  }).sort((a, b) => a.distPct - b.distPct); // no cap — both columns scroll independently

  // Scale bars relative to the farthest trade + 25% headroom so the farthest
  // trade always gets ~20% bar instead of collapsing to 0
  const MAX_DIST = Math.max(8, ...enriched.map(t => t.distPct)) * 1.25;

  const rowHtml = (t) => {
    const isLong = t.direction === "Long";
    const dirCls = isLong ? "long" : "short";
    const coin = (t.coin || "").replace("USDT", "");
    const proximity = t.inZone ? 100 : Math.max(0, 100 - (t.distPct / MAX_DIST) * 100);
    const distLabel = t.inZone ? "IN ZONE" : `${t.distPct.toFixed(1)}%`;
    return `
      <div class="pt-row ${dirCls}${t.inZone ? " pt-in-zone" : ""}${t.track_only ? " pt-track-only" : ""}" data-trade-id="${t.trade_id}" title="${t.trade_id}${t.track_only ? " (track-only)" : ""}">
        <div class="pt-info">
          <div class="pt-info-top">
            <span class="pt-coin">${coin}</span>
            ${_isMexcRelevant(t) ? '<span class="pt-mexc">mexc</span>' : ''}
            <div class="pt-badges">
              <span class="pt-dir ${dirCls}">${isLong ? "L" : "S"}</span>
              <span class="pt-sys">${t.trading_system || ""}</span>
            </div>
          </div>
          <div class="pt-tid">${t.trade_id || ""}</div>
        </div>
        <div class="pt-approach">
          <div class="pt-track">
            <div class="pt-fill" style="width:${proximity.toFixed(1)}%"></div>
          </div>
          <div class="pt-axis">
            <span>FAR</span><span>ENTRY</span>
          </div>
        </div>
        <div class="pt-stat">
          <span class="pt-pct${t.inZone ? " in-zone" : ""}">${distLabel}</span>
          <span class="pt-price">${fmtPrice(t.entry_price)}</span>
        </div>
      </div>`;
  };

  const realRows  = enriched.filter(t => !t.track_only);
  const trackRows = enriched.filter(t =>  t.track_only);

  const colHtml = (rows, label, count) => {
    const body = rows.length
      ? rows.map(rowHtml).join("")
      : '<div class="pt-col-empty">no pending</div>';
    return `
      <div class="pt-col">
        <div class="pt-col-head">
          <span class="pt-col-label">${label}</span>
          <span class="pt-col-count">${count}</span>
        </div>
        <div class="pt-col-body">${body}</div>
      </div>`;
  };

  flipReplace(host, `
    <div class="pt-cols">
      ${colHtml(realRows,  "REAL TRADES", realRows.length)}
      ${colHtml(trackRows, "TRACK ONLY",  trackRows.length)}
    </div>`);
}

function renderActivity() {
  const cutoff = Date.now() - 12 * 3600_000;
  const events = [];

  // New signals (PENDING created in last 12h)
  for (const t of (state.recentSignals || [])) {
    events.push({ ts: new Date(t.iso).getTime(), type: "signal", t });
  }
  // Activations (PENDING → OPEN)
  for (const t of (state.recentOpens || [])) {
    if (t._iso_ms >= cutoff)
      events.push({ ts: t._iso_ms, type: "open", t });
  }
  // Cancels (last 12h)
  for (const t of (state.recentCancels || [])) {
    const ts = new Date(t.iso).getTime();
    if (ts >= cutoff) events.push({ ts, type: "cancel", t });
  }

  // Closes (last 12h)
  for (const t of (state.recentCloses || [])) {
    const ts = new Date(t.close_iso).getTime();
    if (ts >= cutoff) events.push({ ts, type: t.won ? "win" : "loss", t });
  }

  if (!events.length) {
    $("activity").innerHTML = '<span class="empty">Nothing new in the last 12h — system is watching.</span>';
    return;
  }

  events.sort((a, b) => b.ts - a.ts);
  const eventsHtml = events.slice(0, 8).map(ev => {
    const { t } = ev;
    const coin = (t.coin || "").replace("USDT", "");
    const dir  = t.direction || "";
    const sys  = t.trading_system || "";
    const px   = t.entry_price ? fmtPrice(t.entry_price) : "";
    const track = t.track_only ? ' <span class="ev-track">track</span>' : "";
    const ago  = `<span class="ev-time">${fmtAgo(t.iso || t.close_iso)}</span>`;
    // Stable key per event = type + trade_id (one trade can produce multiple event types)
    const k = `${ev.type}_${t.trade_id || t.iso || ev.ts}`;
    switch (ev.type) {
      case "signal": return `<div class="ev-row" data-ev-key="${k}"><span class="ev-chip signal">🔔 SIGNAL</span><span class="ev-body">${coin} ${dir} · ${sys} · $${px}${track}</span>${ago}</div>`;
      case "open":   return `<div class="ev-row" data-ev-key="${k}"><span class="ev-chip open">✅ ENTERED</span><span class="ev-body">${coin} ${dir} · ${sys} · $${px}</span>${ago}</div>`;
      case "win":    return `<div class="ev-row" data-ev-key="${k}"><span class="ev-chip win">💰 ${t.status === "TP2_HIT" ? "TP2 HIT" : "CLOSED WIN"}</span><span class="ev-body">${coin} ${dir} · ${sys} · <strong>+$${Math.abs(t.pnl_usd||0).toFixed(2)}</strong></span>${ago}</div>`;
      case "loss":   return `<div class="ev-row" data-ev-key="${k}"><span class="ev-chip loss">❌ STOPPED</span><span class="ev-body">${coin} ${dir} · ${sys} · -$${Math.abs(t.pnl_usd||0).toFixed(2)}</span>${ago}</div>`;
      case "cancel": return `<div class="ev-row" data-ev-key="${k}"><span class="ev-chip cancel">🚫 CANCELLED</span><span class="ev-body">${coin} ${dir} · ${sys}</span>${ago}</div>`;
      default: return "";
    }
  }).join("");
  // Marquee track — duplicate events for seamless infinite scroll
  const wrapped = `<div class="ab-track"><div class="ab-group">${eventsHtml}</div><div class="ab-group" aria-hidden="true">${eventsHtml}</div></div>`;
  $("activity").innerHTML = wrapped;
}

function renderApiKeys() {
  const host = $("api-keys");
  if (!host) return;
  const keys = state.apiKeys || [];
  if (!keys.length) {
    host.innerHTML = '<span class="hk-empty">No key data</span>';
    return;
  }
  host.innerHTML = keys.map(k => {
    const cls = k.status === "urgent" ? "hk-urgent"
              : k.status === "warn"   ? "hk-warn"
              : "hk-ok";
    const dot = k.status === "urgent" ? "#EF5350"
              : k.status === "warn"   ? "#FFA726"
              : "#26A69A";
    const daysText = k.days_left > 9000 ? "∞" : `${k.days_left}d`;
    return `<div class="hk-pill ${cls}">
      <span class="hk-dot" style="background:${dot}"></span>
      <span class="hk-name">${k.label}</span>
      <span class="hk-days">${daysText}</span>
    </div>`;
  }).join("");
}

// System accent colors — read from CSS vars if defined (allows theme overrides), else use defaults
const SYS_COLOR = {
  John:    cssVar("--sys-john")  || "#5B8DEF",
  Braam:   cssVar("--sys-braam") || "#ffab40",
  Mong:    cssVar("--sys-mong")  || "#a76adb",
  William: "#5a5a6e",
};
const SYS_TAG = {
  John: "Trend · Breakout", Braam: "EMA Pullback",
  Mong: "Mean Reversion",   William: "Decommissioned",
};

function renderSystems() {
  const systems = ["John", "Braam", "Mong"];
  const open = state.trades.filter(t => t.status === "OPEN");
  const r = 18, circ = 2 * Math.PI * r;
  const html = systems.map(name => {
    const sysOpen = open.filter(t => t.trading_system === name);
    const sysPending = state.trades.filter(t => t.status === "PENDING" && t.trading_system === name).length;
    const sysComputed = sysOpen.map(t => computeUnrealized(t));
    const sysUnreal = sysComputed.reduce((s, c) => s + c.usd, 0);
    const sysTp1Banked = sysComputed.reduce((s, c) => s + (c.tp1BankedUsd || 0), 0);
    const stats = state.stats.per_system?.[name] || {};
    const realized = (stats.realized_pnl_usd ?? 0) + sysTp1Banked;
    const wr = stats.win_rate_pct ?? 0;
    const closed = stats.closed_count ?? 0;
    const color = SYS_COLOR[name] || "#7280B5";
    const dash = circ * Math.min(1, wr / 100);
    const offset = circ - dash;
    const decom = name === "William";
    return `
      <div class="sys-row" data-sys="${name}" style="${decom ? 'opacity:0.45' : ''}">
        <div class="sys-name-block">
          <div class="sys-ring-wrap">
            <svg class="sys-ring-svg" viewBox="0 0 44 44">
              <circle class="sys-ring-track" cx="22" cy="22" r="${r}"/>
              <circle class="sys-ring-fill" cx="22" cy="22" r="${r}"
                stroke="${color}"
                stroke-dasharray="${circ.toFixed(1)}"
                stroke-dashoffset="${offset.toFixed(1)}"/>
            </svg>
            <div class="sys-ring-label">${wr.toFixed(0)}%</div>
          </div>
          <div>
            <div class="sys-name" style="color:${color}">${name}</div>
            <div class="sys-tag">${SYS_TAG[name]}</div>
          </div>
        </div>
        <div class="metric"><span class="k">Open</span><span class="v">${sysOpen.length}</span></div>
        <div class="metric"><span class="k">Pending</span><span class="v">${sysPending}</span></div>
        <div class="metric"><span class="k">Closed</span><span class="v">${closed}</span></div>
        <div class="metric"><span class="k">Unrealized</span><span class="v ${cls(sysUnreal)}">${fmtUsd(sysUnreal)}</span></div>
        <div class="metric"><span class="k">Realized</span><span class="v ${cls(realized)}">${fmtUsd(realized)}</span></div>
      </div>
    `;
  }).join("");
  flipReplace($("systems"), html, "data-sys");
}

// Screen navigation (swipeable — no auto-rotation)
let screenIdx = 0;
let screenTransitioning = false;
const screens = ["screen-1", "screen-2", "screen-3", "screen-4"];

function goToScreen(targetIdx, dir) {
  targetIdx = Math.max(0, Math.min(screens.length - 1, targetIdx));
  if (targetIdx === screenIdx || screenTransitioning) return;
  screenTransitioning = true;

  const prev = $(screens[screenIdx]);
  const next = $(screens[targetIdx]);
  // dir: +1 = swiping to next (current exits left, new enters from right)
  //      -1 = swiping to prev (current exits right, new enters from left)
  if (dir == null) dir = targetIdx > screenIdx ? 1 : -1;

  prev.classList.remove("active");
  prev.classList.add(dir === 1 ? "out-left" : "out-right");

  next.classList.remove("out-left", "out-right");
  next.classList.add(dir === 1 ? "from-right" : "from-left");
  // force reflow so the from-* transform applies before .active
  void next.offsetWidth;
  next.classList.remove("from-right", "from-left");
  next.classList.add("active");

  setTimeout(() => {
    prev.classList.remove("out-left", "out-right");
    screenTransitioning = false;
  }, 500);

  screenIdx = targetIdx;
  document.querySelectorAll(".dots .d").forEach(d => d.classList.remove("active"));
  document.querySelector(`.dots .d[data-i="${screenIdx}"]`).classList.add("active");
  // Activity banner visible on screen 4 only (index 3)
  const banner = document.getElementById("activity-banner");
  if (banner) banner.classList.toggle("ab-hidden", screenIdx !== 3);
}

function nextScreen() { goToScreen((screenIdx + 1) % screens.length, 1); }
function prevScreen() { goToScreen((screenIdx - 1 + screens.length) % screens.length, -1); }

// Touch swipe on the screen wrapper
(function setupSwipe() {
  const wrap = document.getElementById("screen-wrap");
  if (!wrap) return;
  let startX = 0, startY = 0, startT = 0, tracking = false;
  const THRESHOLD = 50;    // px horizontal to count as swipe
  const SLOPE = 1.2;       // horizontal must dominate vertical
  const MAX_MS = 600;      // ignore long, slow drags

  wrap.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startT = Date.now();
    tracking = true;
  }, { passive: true });

  wrap.addEventListener("touchend", e => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const dt = Date.now() - startT;
    if (dt > MAX_MS) return;
    if (Math.abs(dx) < THRESHOLD) return;
    if (Math.abs(dx) < Math.abs(dy) * SLOPE) return;
    if (dx < 0) nextScreen(); else prevScreen();
  }, { passive: true });
})();

// Clickable dots
document.querySelectorAll(".dots .d").forEach(d => {
  d.addEventListener("click", () => {
    const i = parseInt(d.dataset.i, 10);
    if (!isNaN(i)) goToScreen(i);
  });
});

// Keyboard arrows (handy for desktop testing)
document.addEventListener("keydown", e => {
  if (e.key === "ArrowRight") nextScreen();
  else if (e.key === "ArrowLeft") prevScreen();
});

// Double-click trade_id → copy to clipboard. Delegated so it survives
// flipReplace re-renders. Looks for .pb-tid (open trades), .pt-tid (pending
// triggers), or .rc-tid (recent closes); reads the full trade_id from the
// nearest [data-trade-id] ancestor (handles cases where the displayed text
// is a stripped prefix).
function _copyTidFlash(el, full) {
  const prev = el.textContent;
  const cls = "tid-copied-flash";
  el.classList.add(cls);
  el.textContent = "✓ COPIED";
  setTimeout(() => {
    el.classList.remove(cls);
    el.textContent = prev;
  }, 900);
}
document.addEventListener("dblclick", e => {
  const tidEl = e.target.closest(".pb-tid, .pt-tid, .rc-tid");
  if (!tidEl) return;
  const row = tidEl.closest("[data-trade-id]");
  const full = (row && row.getAttribute("data-trade-id")) || tidEl.textContent || "";
  if (!full) return;
  // Modern path
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(full)
      .then(() => _copyTidFlash(tidEl, full))
      .catch(() => {
        // Fallback for browsers without clipboard permission in iframe/kiosk
        _legacyCopy(full); _copyTidFlash(tidEl, full);
      });
  } else {
    _legacyCopy(full); _copyTidFlash(tidEl, full);
  }
  // Prevent accidental text selection on double-click
  window.getSelection && window.getSelection().removeAllRanges();
});
function _legacyCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  } catch {}
}

// Clock — CET/CEST (Europe/Paris, DST-aware)
function tickClock() {
  const d = new Date();
  const t = d.toLocaleTimeString("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
  $("clock").textContent = t + " CET";
}

// === Live MEXC polling (CF Worker) ===
let mexcWorkerFailing = false;

async function fetchMexcLive() {
  if (!MEXC_WORKER_URL) return;           // not configured — rely on data.json
  try {
    const r = await fetch(MEXC_WORKER_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const m = await r.json();
    if (m.error) throw new Error(m.error);
    state.mexcAccount = m;
    mexcWorkerFailing = false;
    renderMexcCard();
    renderS0();
  } catch (e) {
    if (!mexcWorkerFailing) console.warn("MEXC worker:", e.message);
    mexcWorkerFailing = true;
    // card keeps showing last known value — no blank-out
  }
}

// Init
$(screens[0]).classList.add("active");
// Banner hidden on screens 1+2 by default
const _initBanner = document.getElementById("activity-banner");
if (_initBanner) _initBanner.classList.add("ab-hidden");
fetchData();
fetchSpotlightPrices();
setInterval(fetchData, REFRESH_MS);
setInterval(fetchSpotlightPrices, 30_000);
// Auto-rotation disabled — user swipes between screens manually
setInterval(tickClock, 1000);
tickClock();

// MEXC live: poll every 15s via CF Worker
if (MEXC_WORKER_URL) {
  fetchMexcLive();
  setInterval(fetchMexcLive, 15_000);
}

// Bloomberg news: poll CF Worker every 60s
async function fetchBloombergNews() {
  if (!BLOOMBERG_WORKER_URL) return;
  try {
    const r = await fetch(BLOOMBERG_WORKER_URL + "?t=" + Date.now(), { cache: "no-store" });
    const d = await r.json();
    checkBloombergNews(d.articles || []);
  } catch (e) {
    console.warn("Bloomberg worker fetch failed:", e);
  }
}
// Bloomberg news polling DISABLED per user request (2026-06-17) — no flashes.
// fetchBloombergNews();
// setInterval(fetchBloombergNews, 60_000);

// ════════════════════════════════════════════════════════════════════════
// SCREEN 4 — EDGE INTELLIGENCE
// Fetches analytics.json (pre-computed deep stats from publish_analytics.py)
// + live Fear & Greed from alternative.me (CORS-friendly, no key).
// ════════════════════════════════════════════════════════════════════════

const ANALYTICS_URL = "analytics.json";
const FNG_URL       = "https://api.alternative.me/fng/?limit=1";
let _edgeAnalytics = null;
let _edgeFng = null;

function _fmtUsdEdge(v) {
  if (v == null || isNaN(v)) return "—";
  const sign = v > 0 ? "+" : (v < 0 ? "−" : "");
  return sign + "$" + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function _fmtPctEdge(v, d = 1) {
  if (v == null || isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return sign + Number(v).toFixed(d) + "%";
}
function _signCls(v) { return v > 0 ? "pos" : (v < 0 ? "neg" : "neu"); }

// ── FLIP animation: replace innerHTML and smoothly slide rows that changed rank ──
// Each row must have a [data-trade-id] attribute (or pass a different keyAttr).
function flipReplace(host, newHtml, keyAttr = "data-trade-id") {
  if (!host) return;
  // 1. FIRST — capture every existing row's top position
  const old = new Map();
  host.querySelectorAll(`[${keyAttr}]`).forEach(el => {
    old.set(el.getAttribute(keyAttr), el.getBoundingClientRect().top);
  });
  // 2. LAST — apply new HTML
  host.innerHTML = newHtml;
  // 3 + 4. INVERT + PLAY
  // Read all new positions in one pass first (avoids layout thrashing),
  // then write transforms in a separate pass.
  const rows = host.querySelectorAll(`[${keyAttr}]`);
  const work = [];
  rows.forEach(el => {
    const key = el.getAttribute(keyAttr);
    const newTop = el.getBoundingClientRect().top;
    const oldTop = old.get(key);
    work.push({ el, key, newTop, oldTop });
  });
  for (const w of work) {
    if (w.oldTop != null) {
      const delta = w.oldTop - w.newTop;
      if (Math.abs(delta) > 0.5) {
        // Invert: put it visually back where it was
        w.el.style.transform = `translateY(${delta.toFixed(2)}px)`;
        w.el.style.transition = "none";
        // Play: next frame, animate to natural position
        requestAnimationFrame(() => {
          w.el.style.transition = "transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)";
          w.el.style.transform = "";
        });
      }
    } else {
      // New row — gentle fade-in from below
      w.el.style.opacity = "0";
      w.el.style.transform = "translateY(6px) scale(0.985)";
      w.el.style.transition = "none";
      requestAnimationFrame(() => {
        w.el.style.transition = "opacity 0.4s ease, transform 0.4s cubic-bezier(0.22, 1, 0.36, 1)";
        w.el.style.opacity = "";
        w.el.style.transform = "";
      });
    }
  }
}

async function fetchAnalytics() {
  try {
    const r = await fetch(ANALYTICS_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    _edgeAnalytics = await r.json();
    renderEdgeScreen();
    // Hero "Performance since inception" sparkline now sources the full
    // equity curve from analytics.json — re-render once it's loaded.
    try { renderEquitySparkline((state && state.recentCloses) || []); } catch (e) {}
  } catch (e) {
    console.warn("analytics fetch failed:", e);
  }
}

async function fetchFearGreed() {
  try {
    const r = await fetch(FNG_URL + "&t=" + Date.now(), { cache: "no-store" });
    const d = await r.json();
    const item = (d.data || [])[0];
    if (item) {
      _edgeFng = {
        value: parseInt(item.value, 10),
        label: item.value_classification,
      };
      renderEdgeFng();
    }
  } catch (e) { console.warn("F&G fetch failed:", e); }
}

// ── Render: F&G gauge ──
function renderEdgeFng() {
  if (!_edgeFng) return;
  if (!$("fg-value")) return;   // Fear&Greed tile removed in Screen-4 redesign
  const v = _edgeFng.value;
  $("fg-value").textContent = v;
  $("fg-label").textContent = (_edgeFng.label || "").toUpperCase();

  // Needle: map 0..100 → angle −90° to +90° (180° arc). Updated for viewBox 220×130.
  const angleDeg = -90 + (v / 100) * 180;
  const rad = angleDeg * Math.PI / 180;
  const cx = 110, cy = 110, len = 78;
  const x2 = cx + Math.sin(rad) * len;
  const y2 = cy - Math.cos(rad) * len;
  const needle = document.getElementById("fg-needle");
  if (needle) {
    needle.setAttribute("x1", cx);
    needle.setAttribute("y1", cy);
    needle.setAttribute("x2", x2.toFixed(1));
    needle.setAttribute("y2", y2.toFixed(1));
  }

  // Colour the value based on bucket
  const fgValEl = $("fg-value");
  fgValEl.classList.remove("fg-fear", "fg-greed", "fg-neutral");
  if (v < 35) fgValEl.classList.add("fg-fear");
  else if (v > 65) fgValEl.classList.add("fg-greed");
  else fgValEl.classList.add("fg-neutral");
}

// ── Catmull-Rom → cubic Bézier smoothing ──
function _smoothPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]}`;
  const path = [`M ${points[0][0]} ${points[0][1]}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    path.push(`C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0]} ${p2[1]}`);
  }
  return path.join(" ");
}

// ── Render: smooth equity curve area chart ──
function _renderEquityCurve(curve) {
  const svg = document.getElementById("equity-curve-svg");
  if (!svg || !curve || curve.length < 2) {
    if (svg) svg.innerHTML = "";
    return;
  }
  const W = 800, H = 200;
  const padX = 8, padTop = 80, padBottom = 14;  // padTop leaves room for the overlay text
  const innerW = W - 2 * padX;
  const innerH = H - padTop - padBottom;
  const N = curve.length;
  const vals = curve.map(p => p.cumulative);
  const vMin = Math.min(0, ...vals);
  const vMax = Math.max(0, ...vals);
  const range = (vMax - vMin) || 1;
  const yFor = v => padTop + innerH - ((v - vMin) / range) * innerH;
  const xFor = i => padX + (i / (N - 1)) * innerW;
  const zeroY = yFor(0);

  const pts = curve.map((p, i) => [xFor(i), yFor(p.cumulative)]);
  const linePath = _smoothPath(pts);
  // Area: extend path to bottom corners
  const areaPath = linePath + ` L ${pts[N-1][0]} ${H} L ${pts[0][0]} ${H} Z`;

  const finalVal = vals[N - 1];
  const isPositive = finalVal >= 0;
  const stroke = isPositive ? "#00e6c0" : "#ff6b7a";
  const gradId = isPositive ? "eqAreaPos" : "eqAreaNeg";

  svg.innerHTML = `
    <defs>
      <linearGradient id="eqAreaPos" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#00e6c0" stop-opacity="0.45"/>
        <stop offset="40%" stop-color="#00c9a7" stop-opacity="0.2"/>
        <stop offset="100%" stop-color="#00c9a7" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="eqAreaNeg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ff4d5e" stop-opacity="0.4"/>
        <stop offset="40%" stop-color="#ff4d5e" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#ff4d5e" stop-opacity="0"/>
      </linearGradient>
      <filter id="eqGlow"><feGaussianBlur stdDeviation="3"/></filter>
    </defs>
    <line x1="${padX}" y1="${zeroY}" x2="${W - padX}" y2="${zeroY}"
          stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="3,4"/>
    <path d="${areaPath}" fill="url(#${gradId})"/>
    <path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#eqGlow)" opacity="0.55"/>
    <path d="${linePath}" fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${pts[N-1][0]}" cy="${pts[N-1][1]}" r="4" fill="${stroke}" filter="url(#eqGlow)"/>
    <circle cx="${pts[N-1][0]}" cy="${pts[N-1][1]}" r="2.5" fill="#fff"/>
  `;
}

// ── Render: vertical Long/Short bars with glow ──
function _renderDirectionVbars(d) {
  if (!d) return;
  const long = d.Long || { n: 0, wr: 0, pnl: 0 };
  const short = d.Short || { n: 0, wr: 0, pnl: 0 };

  // Heights scale by PnL magnitude (winner reaches 100%)
  const maxAbsPnl = Math.max(1, Math.abs(long.pnl), Math.abs(short.pnl));
  const longH = Math.max(8, Math.abs(long.pnl) / maxAbsPnl * 100);
  const shortH = Math.max(8, Math.abs(short.pnl) / maxAbsPnl * 100);

  // Apply with a small delay for animation feel
  requestAnimationFrame(() => {
    $("dir-long-fill").style.height = longH + "%";
    $("dir-short-fill").style.height = shortH + "%";
  });

  const longEl = $("dir-long-pnl");
  longEl.textContent = _fmtUsdEdge(long.pnl);
  longEl.className = "dir-vbar-pnl " + _signCls(long.pnl);
  const shortEl = $("dir-short-pnl");
  shortEl.textContent = _fmtUsdEdge(short.pnl);
  shortEl.className = "dir-vbar-pnl " + _signCls(short.pnl);

  $("dir-long-wr").textContent = (long.wr || 0).toFixed(0) + "%";
  $("dir-short-wr").textContent = (short.wr || 0).toFixed(0) + "%";
  $("dir-long-n").textContent = long.n + "t";
  $("dir-short-n").textContent = short.n + "t";
}

// ── Render: macro sparklines (smooth area for VIX & DXY 5d) ──
function _renderMacroSpark(svgId, values, isInverted) {
  const svg = document.getElementById(svgId);
  if (!svg || !values || values.length < 2) {
    if (svg) svg.innerHTML = "";
    return;
  }
  const W = 120, H = 32, padX = 2, padY = 4;
  const vMin = Math.min(...values), vMax = Math.max(...values);
  const range = (vMax - vMin) || 1;
  const pts = values.map((v, i) => [
    padX + (i / (values.length - 1)) * (W - 2 * padX),
    padY + (1 - (v - vMin) / range) * (H - 2 * padY),
  ]);
  const path = _smoothPath(pts);
  const rising = values[values.length - 1] >= values[0];
  // For VIX, rising = risk-off (red). For DXY, rising = USD strength (neutral/amber).
  // For neutral coloring on DXY, just use the rising direction.
  const color = isInverted
    ? (rising ? "#ff8a80" : "#00e6c0")  // higher VIX is bad (red)
    : (rising ? "#ffd54f" : "#9ccc65"); // higher DXY = amber, falling = green
  const areaPath = path + ` L ${pts[pts.length-1][0]} ${H} L ${pts[0][0]} ${H} Z`;
  const fillGrad = isInverted
    ? (rising ? "macroRedFill" : "macroGreenFill")
    : (rising ? "macroAmberFill" : "macroLightGreenFill");
  svg.innerHTML = `
    <defs>
      <linearGradient id="macroRedFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff4d5e" stop-opacity="0.35"/><stop offset="100%" stop-color="#ff4d5e" stop-opacity="0"/></linearGradient>
      <linearGradient id="macroGreenFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#00c9a7" stop-opacity="0.35"/><stop offset="100%" stop-color="#00c9a7" stop-opacity="0"/></linearGradient>
      <linearGradient id="macroAmberFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffd54f" stop-opacity="0.35"/><stop offset="100%" stop-color="#ffd54f" stop-opacity="0"/></linearGradient>
      <linearGradient id="macroLightGreenFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#9ccc65" stop-opacity="0.35"/><stop offset="100%" stop-color="#9ccc65" stop-opacity="0"/></linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#${fillGrad})"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  `;
}

// ── Refresh just the Edge hero P&L number — called from renderLive on every WS tick ──
function updateEdgeLivePnL() {
  // Keep the Screen-4 "vs S&P 500" headline in sync with the paper hero —
  // realized + TP1 banked + unrealized, as % of paper starting capital ($2000).
  const oursEl = document.getElementById("an-ours-pct");
  if (!oursEl) return;
  const b = _edgeAnalytics && _edgeAnalytics.benchmark;
  const openTrades = (state.trades || []).filter(t => t.status === "OPEN");
  const enriched = openTrades.map(t => ({ ...t, ...computeUnrealized(t) }));
  const tp1Banked = enriched.reduce((s, t) => s + (t.tp1BankedUsd || 0), 0);
  const unrealized = enriched.reduce((s, t) => s + (t.usd || 0), 0);
  const total = ((state.stats && state.stats.realized_pnl_usd) || 0) + tp1Banked + unrealized;
  // Denominator = Screen-1's hero %: total capital deployed.
  const totalCap = enriched.reduce((s, t) => s + (t.capital_usd || 100), 0);
  const closedCap = ((state.stats && state.stats.closed_count) || 0) * 100;
  const equity = (closedCap + totalCap) || (b && b.base_usd) || 2000;
  const oursNowPct = equity ? (total / equity) * 100 : 0;
  const setPct = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (v == null || !isFinite(v)) { el.textContent = "—"; el.className = "an-stat-v"; return; }
    el.textContent = (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
    el.className = "an-stat-v " + cls(v);
  };
  setPct("an-ours-pct", oursNowPct);
  if (b) {
    setPct("an-spx-pct", b.spx_pct);
    setPct("an-edge-pct", (b.spx_pct != null) ? oursNowPct - b.spx_pct : null);
  }
}

// ── Economic events calendar (static, hardcoded for now) ──
// TODO swap for a live feed: pre-fetch from a paid API (Finnhub /
// Trading Economics) in publish_analytics.py and expose it through
// analytics.json. Until then this list is maintained by hand.
const ECONOMIC_EVENTS = [
  { iso: "2026-05-28T12:30:00Z", name: "GDP",          country: "US", flag: "🇺🇸", importance: "high", note: "Q1 advance"            },
  { iso: "2026-05-29T12:30:00Z", name: "PCE",          country: "US", flag: "🇺🇸", importance: "high", note: "Core PCE (Fed's gauge)" },
  { iso: "2026-06-04T13:30:00Z", name: "ISM Services", country: "US", flag: "🇺🇸", importance: "med",  note: "Services PMI"          },
  { iso: "2026-06-05T12:30:00Z", name: "NFP",          country: "US", flag: "🇺🇸", importance: "high", note: "Non-Farm Payrolls"     },
  { iso: "2026-06-11T12:30:00Z", name: "CPI",          country: "US", flag: "🇺🇸", importance: "high", note: "Consumer Price Index"  },
  { iso: "2026-06-17T12:30:00Z", name: "Retail Sales", country: "US", flag: "🇺🇸", importance: "med",  note: "May retail"            },
  { iso: "2026-06-17T18:00:00Z", name: "FOMC",         country: "US", flag: "🇺🇸", importance: "high", note: "Rate decision + presser"},
  { iso: "2026-06-19T11:00:00Z", name: "BoE",          country: "UK", flag: "🇬🇧", importance: "med",  note: "BoE rate decision"     },
  { iso: "2026-06-26T12:30:00Z", name: "PCE",          country: "US", flag: "🇺🇸", importance: "high", note: "May core PCE"          },
  { iso: "2026-07-03T12:30:00Z", name: "NFP",          country: "US", flag: "🇺🇸", importance: "high", note: "Non-Farm Payrolls"     },
];

function _fmtCountdown(ms) {
  if (ms <= 0) {
    const past = -ms;
    if (past < 60 * 60 * 1000) return "live now";
    return null; // signal: drop from list
  }
  const m = Math.floor(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(ms / 3600000);
  if (h < 24) {
    const remM = Math.floor((ms - h * 3600000) / 60000);
    return remM > 0 ? `in ${h}h ${remM}m` : `in ${h}h`;
  }
  const d = Math.floor(ms / 86400000);
  const remH = Math.floor((ms - d * 86400000) / 3600000);
  return remH > 0 ? `in ${d}d ${remH}h` : `in ${d}d`;
}

function _renderEconomicEvents() {
  const host = $("edge-econ-events");
  if (!host) return;
  const now = Date.now();
  const upcoming = ECONOMIC_EVENTS
    .map(ev => ({ ...ev, _t: new Date(ev.iso).getTime() }))
    .filter(ev => ev._t > now - 60 * 60 * 1000) // keep events up to 1h after they happen
    .sort((a, b) => a._t - b._t);

  if (!upcoming.length) {
    host.innerHTML = '<div class="econ-empty">no upcoming events</div>';
    return;
  }

  const featured = upcoming[0];
  const rest     = upcoming.slice(1, 4);

  const fmtWhen = ev => {
    const d = new Date(ev._t);
    const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    const t   = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    return `${day} · ${t} UTC`;
  };

  const featuredCd = _fmtCountdown(featured._t - now) || "live now";
  const featuredHtml = `
    <div class="econ-featured" data-ev-key="${featured.iso}_${featured.name}">
      <div class="econ-featured-top">
        <span class="econ-dot ${featured.importance}"></span>
        <span class="econ-featured-name">${featured.name}</span>
        <span class="econ-flag">${featured.flag}</span>
        <span class="econ-cd-big">${featuredCd}</span>
      </div>
      <div class="econ-featured-when">${fmtWhen(featured)} · ${featured.note}</div>
    </div>`;

  const restHtml = rest.map(ev => {
    const cd = _fmtCountdown(ev._t - now) || "live now";
    return `
      <div class="econ-row" data-ev-key="${ev.iso}_${ev.name}">
        <span class="econ-dot ${ev.importance}"></span>
        <span class="econ-name">${ev.name}</span>
        <span class="econ-flag">${ev.flag}</span>
        <span class="econ-when-small">${fmtWhen(ev)}</span>
        <span class="econ-cd">${cd}</span>
      </div>`;
  }).join("");

  flipReplace(host, featuredHtml + restHtml, "data-ev-key");
}

// ── Render: streak pills (last 10 closes as W/L dots) ──
function _renderStreakPills(recentCloses) {
  const el = $("edge-streak-pills");
  if (!el) return;
  const last10 = (recentCloses || []).slice(0, 10).reverse();  // chronological L→R
  if (!last10.length) { el.innerHTML = ""; return; }
  el.innerHTML = last10.map(t => {
    return `<span class="streak-pill ${t.won ? 'win' : 'loss'}" title="${t.coin} ${t.direction} · ${_fmtUsdEdge(t.pnl_usd)}"></span>`;
  }).join("");
}

// ── Render: stacked horizontal bars (used for system/conviction/entry/etc.) ──
function _renderBars(containerId, dataObj, opts = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const entries = Object.entries(dataObj || {});
  if (!entries.length) { el.innerHTML = '<div class="bars-empty">no data</div>'; return; }

  // Sort: by pnl desc by default, or by key if numeric
  if (opts.sortByKey) {
    entries.sort((a, b) => Number(a[0]) - Number(b[0]));
  } else {
    entries.sort((a, b) => (b[1].pnl ?? 0) - (a[1].pnl ?? 0));
  }

  // For bar fill width: scale by win rate (0–100%)
  const html = entries.map(([key, v]) => {
    const wr = v.wr ?? 0;
    const pnl = v.pnl ?? 0;
    const n = v.n ?? 0;
    const cls = pnl > 0 ? "pos" : (pnl < 0 ? "neg" : "neu");
    const label = opts.labelMap ? (opts.labelMap[key] || key) : key;
    return `
      <div class="bars-row ${cls}" data-bar-key="${key}">
        <div class="bars-key">${label}</div>
        <div class="bars-track"><div class="bars-fill ${cls}" style="width:${Math.max(2, wr)}%"></div></div>
        <div class="bars-wr">${wr.toFixed(0)}%</div>
        <div class="bars-n">${n}t</div>
        <div class="bars-pnl ${cls}">${_fmtUsdEdge(pnl)}</div>
      </div>`;
  }).join("");
  flipReplace(el, html, "data-bar-key");
}

// ── Render: direction tile (Long vs Short) ──
function _renderDirection(d) {
  const el = $("edge-direction");
  if (!el || !d) return;
  const long = d.Long || { n: 0, wr: 0, pnl: 0 };
  const short = d.Short || { n: 0, wr: 0, pnl: 0 };
  el.innerHTML = `
    <div class="dir-row">
      <div class="dir-label dir-long">LONG</div>
      <div class="dir-bar"><div class="dir-fill" style="width:${Math.max(2, long.wr)}%"></div></div>
      <div class="dir-stat"><span class="dir-wr">${long.wr.toFixed(0)}%</span><span class="dir-pnl ${_signCls(long.pnl)}">${_fmtUsdEdge(long.pnl)}</span></div>
    </div>
    <div class="dir-row">
      <div class="dir-label dir-short">SHORT</div>
      <div class="dir-bar"><div class="dir-fill short" style="width:${Math.max(2, short.wr)}%"></div></div>
      <div class="dir-stat"><span class="dir-wr">${short.wr.toFixed(0)}%</span><span class="dir-pnl ${_signCls(short.pnl)}">${_fmtUsdEdge(short.pnl)}</span></div>
    </div>
    <div class="dir-meta">
      <span>${long.n} long · ${short.n} short trades</span>
    </div>
  `;
}

// ── Render: insights ticker ──
function _renderEdgeInsights(a) {
  const at = a.all_time || {};
  const macro = a.macro || {};
  const fng = _edgeFng;
  const pieces = [];

  if (at.win_rate != null) pieces.push(`<span><strong>${at.win_rate}%</strong> WR · ${at.total_trades}t</span>`);
  if (at.profit_factor != null) pieces.push(`<span>PF <strong>${at.profit_factor}</strong></span>`);
  if (at.current_streak_type && at.current_streak_count) {
    const cls = at.current_streak_type === "win" ? "pos" : "neg";
    pieces.push(`<span>Streak: <strong class="${cls}">${at.current_streak_count}${at.current_streak_type === "win" ? "W" : "L"}</strong></span>`);
  }
  if (macro.btc_7d_change_pct != null) {
    pieces.push(`<span>BTC 7d <strong class="${_signCls(macro.btc_7d_change_pct)}">${_fmtPctEdge(macro.btc_7d_change_pct)}</strong></span>`);
  }
  if (fng) {
    pieces.push(`<span>F&amp;G <strong>${fng.value}</strong> ${fng.label}</span>`);
  }
  if (macro.vix != null) pieces.push(`<span>VIX <strong>${macro.vix}</strong></span>`);
  if (a.live_positions) {
    pieces.push(`<span>${a.live_positions.open_count} open · ${a.live_positions.pending_count} pending</span>`);
  }

  const el = $("edge-insights");
  el.innerHTML = `<span class="edge-ins-label">EDGE INSIGHTS</span>` +
    pieces.map(p => `<span class="edge-ins-sep">·</span>${p}`).join("");
}

// ── Render: BY SYSTEM (rich, with inception + days active + decommissioned) ──
const SYS_COLORS = {
  John:    "#5B8DEF",
  Braam:   "#ffab40",
  Mong:    "#a76adb",
  William: "#6a7390",
};
function _renderSystemsRich(systems, decommissioned) {
  const el = $("edge-systems");
  if (!el) return;
  const active = (systems || []).map(s => {
    const color = SYS_COLORS[s.name] || "#888";
    const pnlCls = s.pnl > 0 ? "pos" : (s.pnl < 0 ? "neg" : "neu");
    const inceptShort = s.inception ? s.inception.slice(5) : "—";
    const daysTxt = s.days_active != null ? `${s.days_active}d` : "no trades";
    const liveBadges = [];
    if (s.open > 0) liveBadges.push(`<span class="sys-live-badge open">${s.open}O</span>`);
    if (s.pending > 0) liveBadges.push(`<span class="sys-live-badge pending">${s.pending}P</span>`);
    const ppd = s.pnl_per_day != null
      ? `<span class="sys-ppd ${pnlCls}">${_fmtUsdEdge(s.pnl_per_day)}/d</span>`
      : `<span class="sys-ppd muted">—</span>`;
    const noTrades = s.closed === 0;
    return `
      <div class="sys-rich-row${noTrades ? ' empty' : ''}" data-sys="${s.name}">
        <div class="sys-rich-dot" style="background:${color};box-shadow:0 0 8px ${color}90"></div>
        <span class="sys-rich-name">${s.name}</span>
        <span class="sys-rich-incept">${s.inception ? `since ${inceptShort} · ${daysTxt}` : "no trades yet"}</span>
        <div class="sys-rich-bar"><div class="sys-rich-fill ${pnlCls}" style="width:${Math.max(2, s.wr || 0)}%;${noTrades ? 'background:rgba(255,255,255,0.05)' : ''}"></div></div>
        <span class="sys-rich-wr">${noTrades ? '—' : s.wr.toFixed(0) + '%'}</span>
        <span class="sys-rich-n">${s.closed}t</span>
        ${ppd}
        <span class="sys-rich-pnl ${pnlCls}">${_fmtUsdEdge(s.pnl)}</span>
        <span class="sys-rich-badges">${liveBadges.join("")}</span>
      </div>
    `;
  }).join("");

  // Decommissioned — single dimmed row at the bottom
  let decomHtml = "";
  if (decommissioned && Object.keys(decommissioned).length) {
    const decoms = Object.entries(decommissioned).map(([name, d]) => {
      const color = SYS_COLORS[name] || "#666";
      const pnlCls = d.pnl > 0 ? "pos" : (d.pnl < 0 ? "neg" : "neu");
      return `
        <div class="sys-rich-row sys-decom" data-sys="${name}">
          <div class="sys-rich-dot" style="background:${color}"></div>
          <span class="sys-rich-name">${name}</span>
          <span class="sys-rich-incept">decommissioned · history</span>
          <div class="sys-rich-bar"><div class="sys-rich-fill ${pnlCls}" style="width:${Math.max(2, d.wr || 0)}%"></div></div>
          <span class="sys-rich-wr">${d.wr.toFixed(0)}%</span>
          <span class="sys-rich-n">${d.n}t</span>
          <span class="sys-ppd muted">—</span>
          <span class="sys-rich-pnl ${pnlCls}">${_fmtUsdEdge(d.pnl)}</span>
          <span class="sys-rich-badges"><span class="sys-decom-badge">DECOM</span></span>
        </div>`;
    }).join("");
    decomHtml = decoms;
  }

  flipReplace(el, active + decomHtml, "data-sys");
}

// Nice round y-axis ticks spanning [min,max] in ~count steps.
function _niceTicks(min, max, count) {
  const span = (max - min) || 1;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + 1e-9; v += step) ticks.push(Math.round(v));
  if (!ticks.includes(0) && min < 0 && max > 0) { ticks.push(0); ticks.sort((a,b)=>a-b); }
  return ticks;
}

// ── Render: MONTHLY P&L — glossy gradient bars + dotted cumulative trend ──
const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function _renderMonthly(monthly) {
  const host = document.getElementById("monthly-bars");
  const meta = document.getElementById("monthly-meta");
  if (!host || !monthly || !monthly.length) {
    if (host) host.innerHTML = "";
    if (meta) meta.textContent = "no closed trades yet";
    return;
  }
  const rect = host.getBoundingClientRect();
  const W = Math.max(360, Math.round(rect.width || 900));
  const H = Math.max(120, Math.round(rect.height || 190));
  const padL = 50, padR = 18, padT = 16, padB = 20;
  const iW = W - padL - padR, iH = H - padT - padB;

  const pnls = monthly.map(m => m.pnl);
  const cums = monthly.map(m => m.cumulative_pnl ?? 0);
  let vMin = Math.min(0, ...pnls, ...cums);
  let vMax = Math.max(0, ...pnls, ...cums);
  const span0 = (vMax - vMin) || 1;
  vMin -= span0 * 0.04; vMax += span0 * 0.12;
  const yOf = v => padT + (1 - (v - vMin) / (vMax - vMin)) * iH;
  const zeroY = yOf(0);
  const ticks = _niceTicks(vMin, vMax, 4);
  const fmt = v => (v >= 0 ? "+$" : "−$") + Math.abs(Math.round(v));

  const n = monthly.length;
  const slot = iW / n;
  const barW = Math.max(16, Math.min(120, slot * 0.52));

  const grid = ticks.map(t => {
    const y = yOf(t);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W-padR}" y2="${y.toFixed(1)}" class="m-grid"/>`
      + `<text x="${(padL-9).toFixed(1)}" y="${(y+3.5).toFixed(1)}" class="m-ytick" text-anchor="end">${t===0?'0':fmt(t)}</text>`;
  }).join("");

  const bars = monthly.map((m, i) => {
    const cx = padL + slot * (i + 0.5);
    const x = cx - barW / 2;
    const v = m.pnl;
    const yTop = v >= 0 ? yOf(v) : zeroY;
    const yBot = v >= 0 ? zeroY : yOf(v);
    const h = Math.max(2, yBot - yTop);
    const grad = v >= 0 ? "mPos" : "mNeg";
    const txt = (v >= 0 ? "+$" : "−$") + Math.abs(v).toFixed(0);
    const ty = v >= 0 ? yTop - 6 : yBot + 13;
    const gloss = Math.min(h, 10);
    const gy = v >= 0 ? yTop : (yBot - gloss);
    return `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="url(#${grad})"/>`
      + `<rect x="${x.toFixed(1)}" y="${gy.toFixed(1)}" width="${barW.toFixed(1)}" height="${gloss.toFixed(1)}" rx="4" fill="rgba(255,255,255,0.16)"/>`
      + `<text x="${cx.toFixed(1)}" y="${ty.toFixed(1)}" class="m-val ${v>=0?'pos':'neg'}" text-anchor="middle">${txt}</text>`;
  }).join("");

  const cumPts = monthly.map((m, i) => [padL + slot * (i + 0.5), yOf(m.cumulative_pnl ?? 0)]);
  const cumPath = cumPts.length > 1 ? _smoothPath(cumPts) : (cumPts.length ? `M ${cumPts[0][0]} ${cumPts[0][1]}` : "");
  const lc = cumPts[cumPts.length - 1];

  const xlab = monthly.map((m, i) => {
    const cx = padL + slot * (i + 0.5);
    const monIdx = parseInt(m.month.slice(5), 10) - 1;
    const mon = MONTH_NAMES[monIdx] || m.month.slice(5);
    return `<text x="${cx.toFixed(1)}" y="${H-6}" class="m-xtick" text-anchor="middle">${mon} '${m.month.slice(2,4)}</text>`;
  }).join("");

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="m-svg">
    <defs>
      <linearGradient id="mPos" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3ef0cd"/><stop offset="100%" stop-color="#009e80"/></linearGradient>
      <linearGradient id="mNeg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff7d8a"/><stop offset="100%" stop-color="#bf3242"/></linearGradient>
    </defs>
    ${grid}
    <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W-padR}" y2="${zeroY.toFixed(1)}" class="m-zero"/>
    ${bars}
    ${cumPath ? `<path d="${cumPath}" class="m-cum"/>` : ""}
    ${lc ? `<circle cx="${lc[0].toFixed(1)}" cy="${lc[1].toFixed(1)}" r="3" class="m-cum-dot"/>` : ""}
    ${lc ? `<text x="${(lc[0]-7).toFixed(1)}" y="${(lc[1]-9).toFixed(1)}" class="m-cum-lab" text-anchor="end">Cumulative</text>` : ""}
    ${xlab}
  </svg>`;

  if (meta) {
    const totalN = monthly.reduce((s, m) => s + m.n, 0);
    const cum = monthly[monthly.length - 1]?.cumulative_pnl ?? 0;
    meta.innerHTML = `<span>${monthly.length}mo · ${totalN}t</span><span class="monthly-cum ${cum>0?'pos':(cum<0?'neg':'neu')}">cumulative ${fmt(cum)}</span>`;
  }
}

// ── Render: full screen 4 ──
function renderEdgeScreen() {
  if (!_edgeAnalytics) return;
  const a = _edgeAnalytics;

  // "Ours" computed like the paper hero (Screen 1): realized (closed + TP1
  // banked) + unrealized (mark-to-market on open), as % of paper starting
  // capital ($2000). No MEXC equity — this is the paper book.
  const openTrades = (state.trades || []).filter(t => t.status === "OPEN");
  const enriched = openTrades.map(t => ({ ...t, ...computeUnrealized(t) }));
  const tp1Banked = enriched.reduce((s, t) => s + (t.tp1BankedUsd || 0), 0);
  const unrealized = enriched.reduce((s, t) => s + (t.usd || 0), 0);
  const realized = (state.stats?.realized_pnl_usd ?? 0) + tp1Banked;
  const liveTotalPnl = realized + unrealized;
  // Denominator = Screen-1's hero %: total capital deployed (closed × $100 +
  // open capital), so the Spyker number matches Screen 1 exactly.
  const totalCap = enriched.reduce((s, t) => s + (t.capital_usd || 100), 0);
  const closedCap = ((state.stats && state.stats.closed_count) || 0) * 100;
  const equity = (closedCap + totalCap) || (a.benchmark && a.benchmark.base_usd) || 2000;

  _renderBenchmark(a.benchmark, liveTotalPnl, equity);

  _renderBars("edge-by-entry", a.by_entry_type, {
    labelMap: { "at_support":"@ Support","near_support":"Near Sup","at_resistance":"@ Resist",
                "ema20_rejection":"EMA20 Rej","breakout_chase":"Brkout","structural_limit":"Struct" }
  });
  _renderBars("edge-by-confluence", a.by_confluence_score, {
    sortByKey: true, labelMap: { "4":"4/8","5":"5/8","6":"6/8","7":"7/8","8":"8/8" }
  });
  _renderBars("edge-by-conviction", a.by_conviction, {
    labelMap: { "VERY HIGH":"V.HIGH","HIGH":"HIGH","MEDIUM":"MED","LOW":"LOW" }
  });

  _renderDirectionVbars(a.by_direction);
  _renderMonthly(a.monthly);
}

// Hero: our total return (realized + open) vs S&P 500 buy-and-hold, since
// inception. Lines smoothed (_smoothPath, same as Screen 1). Spyker GREEN when
// up, RED when in loss; S&P BLUE. Index-based even spacing (no x-reversal).
function _renderBenchmark(b, liveTotalPnl, equity) {
  const svg = document.getElementById("an-bench-svg");
  if (!svg) return;
  if (!b) { svg.innerHTML = ""; return; }
  const base = equity || b.base_usd || 2000;
  const oursNowPct = base ? (liveTotalPnl / base) * 100 : 0;
  const scale = (b.base_usd && base) ? (b.base_usd / base) : 1;

  const ours = (b.ours || []).map(p => ({ pct: p.pct * scale }));
  ours.push({ pct: +oursNowPct.toFixed(3) });
  const spx = (b.spx || []).map(p => ({ pct: p.pct }));
  if (spx.length) spx.push({ pct: spx[spx.length - 1].pct });

  const allPct = ours.concat(spx).map(p => p.pct).filter(v => isFinite(v));
  let lo = Math.min(0, ...allPct), hi = Math.max(0, ...allPct);
  if (lo === hi) { lo -= 1; hi += 1; }
  const padY = (hi - lo) * 0.2; lo -= padY; hi += padY;

  const W = 1000, H = 300, padL = 6, padR = 6, padT = 14, padB = 16;
  const xAt = (i, n) => padL + (n > 1 ? i / (n - 1) : 0) * (W - padL - padR);
  const yOf = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const zeroY = yOf(0).toFixed(1);

  const oursPts = ours.map((p, i) => [xAt(i, ours.length), yOf(p.pct)]);
  const spxPts  = spx.map((p, i) => [xAt(i, spx.length), yOf(p.pct)]);
  const oursPath = _smoothPath(oursPts);
  const spxPath  = _smoothPath(spxPts);
  const area = oursPath
    ? `${oursPath} L ${oursPts[oursPts.length-1][0]} ${(H-padB).toFixed(1)} L ${oursPts[0][0]} ${(H-padB).toFixed(1)} Z`
    : "";

  const up = oursNowPct >= 0;
  const ourCol = up ? "#00e6c0" : "#ff6b7a";
  const spxCol = "#5b9dff";

  svg.innerHTML = `
    <defs>
      <linearGradient id="oursFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${ourCol}" stop-opacity="0.30"/>
        <stop offset="45%" stop-color="${ourCol}" stop-opacity="0.12"/>
        <stop offset="100%" stop-color="${ourCol}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line x1="${padL}" y1="${zeroY}" x2="${W-padR}" y2="${zeroY}" stroke="rgba(255,255,255,0.14)" stroke-width="1" stroke-dasharray="4 5" vector-effect="non-scaling-stroke"/>
    ${area ? `<path d="${area}" fill="url(#oursFill)"/>` : ""}
    ${spxPath ? `<path d="${spxPath}" fill="none" stroke="${spxCol}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` : ""}
    ${oursPath ? `<path d="${oursPath}" fill="none" stroke="${ourCol}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` : ""}
  `;

  const setPct = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (v == null || !isFinite(v)) { el.textContent = "—"; el.className = "an-stat-v"; return; }
    el.textContent = (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
    el.className = "an-stat-v " + cls(v);
  };
  setPct("an-ours-pct", oursNowPct);
  setPct("an-spx-pct", b.spx_pct);
  setPct("an-edge-pct", (b.spx_pct != null) ? oursNowPct - b.spx_pct : null);

  const sinceEl = document.getElementById("an-bench-since");
  if (sinceEl) sinceEl.textContent = b.inception_iso ? "since " + b.inception_iso.slice(0, 10) : "";
  const subEl = document.getElementById("an-bench-sub");
  if (subEl) subEl.textContent = "Total return (realized + open) vs S&P 500 buy-and-hold";
  const oi = document.querySelector(".an-leg.ours i"); if (oi) oi.style.background = ourCol;
  const ot = document.querySelector(".an-leg.ours"); if (ot) ot.style.color = ourCol;
  const si = document.querySelector(".an-leg.spx i"); if (si) si.style.background = spxCol;
}

fetchAnalytics();
fetchFearGreed();
setInterval(fetchAnalytics, 5 * 60_000);    // analytics: every 5 min
setInterval(fetchFearGreed, 30 * 60_000);   // F&G: every 30 min (updates daily anyway)
setInterval(_renderEconomicEvents, 60_000); // econ countdown: tick every 60s

// Screen-4 Housekeeping collapse toggle — only the header shows when collapsed.
(function wireHkCollapse(){
  const KEY = "hkCollapsed_paper_v1";
  function apply(){
    const tile = document.querySelector(".housekeeping-tile");
    if (!tile) return;
    tile.classList.toggle("hk-collapsed", localStorage.getItem(KEY) !== "0"); // default = collapsed
  }
  document.addEventListener("click", e => {
    const hdr = e.target.closest(".housekeeping-tile .hk-header");
    if (!hdr) return;
    const tile = hdr.closest(".housekeeping-tile");
    const collapsed = !tile.classList.contains("hk-collapsed");
    tile.classList.toggle("hk-collapsed", collapsed);
    localStorage.setItem(KEY, collapsed ? "1" : "0");
  });
  if (document.readyState !== "loading") apply();
  else document.addEventListener("DOMContentLoaded", apply);
  setTimeout(apply, 1500);
})();
