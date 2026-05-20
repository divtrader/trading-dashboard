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
  if (vseen.has(key)) return false;
  vseen.add(key); saveVseen();
  speak(text);
  return true;
}

// Coin name helper: strip USDT suffix
function coinName(t) { return t.coin.replace(/USDT$/i, ""); }

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
          `${coinName(t)} ${t.direction}. Entry hit. Trade is now live.`);
      }

    } else if (t.status === "OPEN") {
      // TP1 — real-time, before data.json updates
      if (!t.tp1_hit && t.tp1) {
        const tp1Hit = isLong ? live >= t.tp1 : live <= t.tp1;
        if (tp1Hit) {
          maybeSpeak(`voice:tp1live:${t.trade_id}`,
            `${coinName(t)} ${t.direction}. Take profit one hit. Eighty percent banked.`);
        }
      }
      // SL hit
      if (t.sl) {
        const slHit = isLong ? live <= t.sl : live >= t.sl;
        if (slHit) {
          maybeSpeak(`voice:sllive:${t.trade_id}`,
            `${coinName(t)} ${t.direction}. Stop loss hit. Trade closed.`);
        }
      }
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Animated number counter — smoothly transitions displayed value over ~600ms
const _animTargets = new Map();
function animateValue(el, toVal, formatter) {
  if (!el) return;
  const prev = _animTargets.get(el) ?? toVal;
  _animTargets.set(el, toVal);
  const start = performance.now();
  const dur = 650;
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

let state = { trades: [], stats: {}, prices: {}, chg24h: {}, chg1h: {}, lastFetch: 0, lastCronIso: null, recentCloses: [], mexcAccount: null };

// Full 24-coin watchlist for the heatmap screen
const WATCHLIST = [
  "BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","SUIUSDT",
  "BNBUSDT","ADAUSDT","LINKUSDT","AVAXUSDT","TRXUSDT","TAOUSDT",
  "NEARUSDT","APTUSDT","ONDOUSDT","RENDERUSDT","THETAUSDT",
  "TONUSDT","UNIUSDT","XLMUSDT","ALGOUSDT","HBARUSDT",
  "LTCUSDT","CAKEUSDT",
];

// Fetch 1h rolling window change for all watchlist coins — called every 60s
let _heatmapTimer = null;
async function fetchHeatmap1h() {
  try {
    const syms = JSON.stringify(WATCHLIST);
    const r = await fetch(`https://api.binance.com/api/v3/ticker?symbols=${encodeURIComponent(syms)}&windowSize=1h`);
    const data = await r.json();
    for (const d of data) {
      state.chg1h[d.symbol] = parseFloat(d.priceChangePercent);
    }
    renderHeatmap();
  } catch(e) { console.warn("heatmap 1h fetch failed", e); }
}

function startHeatmapPolling() {
  if (_heatmapTimer) return;
  fetchHeatmap1h();
  _heatmapTimer = setInterval(fetchHeatmap1h, 60_000);
}

function _heatColor(pct) {
  // Uses dashboard colour DNA: teal (#00c9a7) for up, red (#ff4d5e) for down
  if (pct == null || isNaN(pct) || Math.abs(pct) < 0.1) return "#0d1120";
  const t = Math.min(1, Math.abs(pct) / 6); // full intensity at ±6%
  if (pct > 0) {
    // teal family: mid teal at small, deep teal at large
    const r = Math.round(8);
    const g = Math.round(110 + (170 - 110) * t);  // 110 → 170
    const b = Math.round(90  + (140 - 90)  * t);  // 90  → 140
    return `rgb(${r},${g},${b})`;
  } else {
    // red family: mid red at small, deep red at large
    const r = Math.round(160 + (210 - 160) * t);  // 160 → 210
    const g = Math.round(30  + (50  - 30)  * t);  // 30  → 50
    const b = Math.round(40  + (60  - 40)  * t);  // 40  → 60
    return `rgb(${r},${g},${b})`;
  }
}

function renderHeatmap() {
  const el = document.getElementById("heatmap-grid");
  if (!el) return;
  // Only render if screen 4 is active (perf optimisation)
  const s4 = document.getElementById("screen-4");
  if (!s4 || !s4.classList.contains("active")) return;

  const sorted = [...WATCHLIST].sort((a, b) => {
    const da = state.chg24h[a] ?? -Infinity;
    const db = state.chg24h[b] ?? -Infinity;
    return db - da;
  });
  el.innerHTML = sorted.map(sym => {
    const coin  = sym.replace("USDT", "");
    const price = state.prices[sym];
    const d24   = state.chg24h[sym];
    const d1h   = state.chg1h[sym];
    const bg    = d24 != null ? _heatColor(d24) : "#1a2233";
    const priceTxt = price != null
      ? (price >= 1000 ? `$${price.toLocaleString("en", {maximumFractionDigits:0})}`
       : price >= 1    ? `$${price.toFixed(2)}`
       : `$${price.toFixed(4)}`)
      : "—";
    const fmt = v => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—";
    const cls1h  = d1h  != null ? (d1h  >= 0 ? "hm-pos" : "hm-neg") : "";
    return `<div class="hm-tile" style="background:${bg}">
      <div class="hm-coin">${coin}</div>
      <div class="hm-price">${priceTxt}</div>
      <div class="hm-chg24">${fmt(d24)}</div>
      <div class="hm-1h ${cls1h}">1h ${fmt(d1h)}</div>
    </div>`;
  }).join("");
}

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
    state.lastCronIso = d.last_updated_iso || null;
    state.lastFetch = Date.now();

    // Voice test events — injected via data.json for testing, always unique IDs (timestamp-type-step)
    const _testPhrases = {
      signal: "New trade signal. Ethereum Long. John system.",
      entry:  "Entry hit. Bitcoin Short is now live.",
      tp1:    "Take profit one hit. Eighty percent banked.",
      sl:     "Stop loss hit. Solana Long closed.",
      tp2:    "Take profit two hit. Trade fully closed.",
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
          `New signal. ${coinName(t)} ${t.direction}. ${t.trading_system} system.`);
      }
    }
    // Voice: PENDING → OPEN activations (entry hit, confirmed by data.json)
    for (const t of recentOpens) {
      maybeSpeak(`voice:entry:${t.trade_id}`,
        `${coinName(t)} ${t.direction}. Entry hit. Trade is now live.`);
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
      maybeSpeak(`voice:tp1live:${t.trade_id}`,
        `${coinName(t)} ${t.direction}. Take profit one hit. Eighty percent banked.`);
    }
  }

  // Newly-closed trades
  for (const t of newCloses) {
    const evId = `close:${t.trade_id}`;
    if (!seen.has(evId)) events.push({ id: evId, type: t.won ? "win" : "loss", trade: t });
    // Voice for SL / TP2
    const status = t.status || "";
    if (status === "STOPPED" || status === "STOPPED_AFTER_TP1") {
      maybeSpeak(`voice:sl:${t.trade_id}`,
        `${coinName(t)} ${t.direction}. Stop loss hit. Trade closed.`);
    } else if (status === "TP2_HIT") {
      maybeSpeak(`voice:tp2:${t.trade_id}`,
        `${coinName(t)} ${t.direction}. Take profit two hit. Trade fully closed.`);
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
function subscribeWs() {
  // Always include all watchlist coins so heatmap has live prices + 24h data
  const tradeCoins = state.trades.map(t => t.coin.toLowerCase());
  const allCoins   = [...new Set([...tradeCoins, ...WATCHLIST.map(s => s.toLowerCase())])];
  const symbols = allCoins;
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
      const o   = parseFloat(msg.data.o); // open 24h ago
      const sym = msg.data.s;
      state.prices[sym] = c;
      // miniTicker has no P field — compute 24h% from close vs open
      if (o > 0) state.chg24h[sym] = ((c - o) / o) * 100;
      renderLive();
      renderPendingTriggers();
      checkLiveLevels();
      renderHeatmap();
    } catch {}
  };
  ws.onclose = () => setTimeout(subscribeWs, 5000);
}

function computeUnrealized(t) {
  const live = state.prices[t.coin] ?? t.price_at_run ?? t.entry_price;
  const dir = t.direction === "Long" ? 1 : -1;
  const pricePct = ((live - t.entry_price) / t.entry_price) * 100 * dir;
  const leveragedPct = pricePct * (t.leverage || 1);
  // When TP1 is hit, 80% was already closed — only 20% of the position remains open
  const remainingFraction = (t.tp1_hit && t.pnl_tp1_realized_usd != null) ? 0.2 : 1.0;
  const usd = (t.capital_usd || 100) * remainingFraction * (leveragedPct / 100);
  const tp1BankedUsd = (t.tp1_hit && t.pnl_tp1_realized_usd != null) ? (t.pnl_tp1_realized_usd || 0) : 0;
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
  startHeatmapPolling();
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
  if (eqEl) eqEl.textContent = "$" + m.equity.toLocaleString("en-US", {maximumFractionDigits: 0});
  if (avEl) avEl.textContent = "$" + m.available.toLocaleString("en-US", {maximumFractionDigits: 0});
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
  host.innerHTML = positions.map(p => {
    const coin = p.coin.replace("USDT", "");
    const isLong = p.direction === "Long";
    const dirCls = isLong ? "long" : "short";
    const pnlCls = cls(p.unrealized_pnl);

    // Use the actual SL order if MEXC has one attached; otherwise liquidation.
    const slPrice = (p.sl != null && p.sl > 0) ? p.sl : p.liq;
    const slIsLiq = (p.sl == null || p.sl <= 0);
    // Right edge = actual TP order if set; otherwise mirror the SL distance.
    const rightPrice = (p.tp != null && p.tp > 0)
      ? p.tp
      : (isLong ? p.entry + Math.abs(p.entry - slPrice)
                : p.entry - Math.abs(p.entry - slPrice));

    // Scale: SL at 0%, TP (or symmetric fallback) at 100%, entry/mark in between.
    const posOf = price => {
      const v = (price - slPrice) / (rightPrice - slPrice);
      return Math.max(0, Math.min(1, v)) * 100;
    };

    const slPct = posOf(slPrice);            // = 0
    const ePct  = posOf(p.entry);
    const mPct  = posOf(p.mark);
    const tpPct = (p.tp != null && p.tp > 0) ? posOf(p.tp) : null;   // = 100 when set
    const liveColor = p.unrealized_pnl >= 0 ? cssVar("--green") : cssVar("--red");

    const titleAttr = `Entry ${p.entry} · Mark ${p.mark} · SL ${p.sl ?? "(liq " + p.liq + ")"}${p.tp ? " · TP " + p.tp : ""}`;

    return `
      <div class="mexc-pos-row">
        <div class="mexc-pos-head">
          <span class="mexc-pos-coin">${coin}</span>
          <span class="mexc-pos-dir ${dirCls}">${isLong ? "L" : "S"}${p.leverage ? "·" + p.leverage + "x" : ""}</span>
        </div>
        <div class="mexc-pos-bar" title="${titleAttr}">
          <div class="mexc-pos-track"></div>
          <div class="mexc-pos-marker sl${slIsLiq ? " liq-fallback" : ""}" style="left:${slPct.toFixed(1)}%"></div>
          <div class="mexc-pos-marker entry" style="left:${ePct.toFixed(1)}%"></div>
          ${tpPct !== null ? `<div class="mexc-pos-marker tp1" style="left:${tpPct.toFixed(1)}%"></div>` : ""}
          <div class="mexc-pos-dot" style="left:${mPct.toFixed(1)}%;background:${liveColor};box-shadow:0 0 8px ${liveColor}"></div>
        </div>
        <div class="mexc-pos-pnl ${pnlCls}">${fmtUsd(p.unrealized_pnl)}</div>
      </div>`;
  }).join("");
}

// === Bloomberg news flash ===
const BLOOMBERG_SEEN_KEY = "bloombergSeenIds_v2";
function loadBloombergSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(BLOOMBERG_SEEN_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveBloombergSeen(s) {
  localStorage.setItem(BLOOMBERG_SEEN_KEY, JSON.stringify([...s].slice(-50)));
}
let bloombergSeen = loadBloombergSeen();
let bloombergFirstRun = !localStorage.getItem("bloombergFirstRun_v2");

function checkBloombergNews(articles) {
  if (!articles) return;
  if (bloombergFirstRun) {
    // First load: mark existing articles as seen so we don't replay old news.
    // Always complete this block even if array is empty, so bloombergFirstRun
    // is set to false before new articles can arrive on the next fetch.
    articles.forEach(a => bloombergSeen.add(a.id));
    saveBloombergSeen(bloombergSeen);
    localStorage.setItem("bloombergFirstRun_v2", "1");
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
}

function renderPaperBars(enrichedOpen) {
  const host = $("paper-bars");
  if (!host) return;
  if (!enrichedOpen.length) {
    host.innerHTML = '<div class="paper-bars-empty">No open paper trades</div>';
    return;
  }
  // Winners on top, losers below — sorted by leveraged % P&L descending.
  const sorted = [...enrichedOpen].sort((a, b) => (b.leveragedPct || 0) - (a.leveragedPct || 0));

  host.innerHTML = sorted.map(t => {
    const isLong = t.direction === "Long";
    const dirCls = isLong ? "long" : "short";
    const coin = (t.coin || "").replace("USDT", "");
    const sys  = t.trading_system || "";
    const tp1Hit = !!t.tp1_hit;
    const beActive = tp1Hit || !!t.sl_moved_to_be;

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

    const pct = t.leveragedPct ?? 0;
    // For tp1_hit trades: show total blended P&L (banked TP1 portion + remaining 20% live)
    const usd = (t.tp1BankedUsd || 0) + (t.usd ?? 0);
    const pctCls = cls(usd);

    // Filled segment showing TP1-achieved range
    const achieved = tp1Hit ? `<div class="pb-achieved" style="left:${Math.min(ePct,t1Pct).toFixed(1)}%;width:${Math.abs(t1Pct-ePct).toFixed(1)}%"></div>` : "";

    return `
      <div class="paper-bar-row ${dirCls}" title="${t.trade_id}">
        <div class="pb-head">
          <div class="pb-coin">${coin}</div>
          <div class="pb-meta">
            <span class="pb-dir ${dirCls}">${isLong ? "▲ LONG" : "▼ SHORT"}</span>
            <span class="pb-sys">${sys}</span>
            ${beActive ? '<span class="pb-be">BE</span>' : ""}
          </div>
          <div class="pb-tid">${t.trade_id || ""}</div>
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
        </div>
      </div>`;
  }).join("");
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
    rEl.textContent = fmtUsd(realized);
    rEl.className = "hero-stat-val " + cls(realized);
  }
  if (uEl) {
    uEl.textContent = enriched.length ? fmtUsd(unrealized) : "—";
    uEl.className = "hero-stat-val " + (enriched.length ? cls(unrealized) : "");
  }
  if (cEl) {
    cEl.textContent = enriched.length ? "$" + totalCap.toFixed(0) : "—";
    cEl.className = "hero-stat-val";
  }
  const pctEl2 = $("hero-pct");
  if (pctEl2) {
    const closedCap = (state.stats.closed_count ?? 0) * 100;
    const totalDeployed = closedCap + totalCap;
    const retPct = totalDeployed > 0 ? (total / totalDeployed) * 100 : 0;
    pctEl2.textContent = (retPct >= 0 ? "+" : "") + retPct.toFixed(2) + "% on all capital deployed";
    pctEl2.className = "hero-return " + cls(total);
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

function renderEquitySparkline(recentCloses) {
  const svg = document.getElementById("equity-spark");
  const overlay = document.getElementById("equity-spark-overlay");
  if (!svg) return;
  const closes = [...recentCloses]
    .sort((a, b) => new Date(a.close_iso) - new Date(b.close_iso))
    .slice(-20);
  if (!closes.length) {
    svg.setAttribute("viewBox", "0 0 400 80");
    svg.innerHTML = "";
    if (overlay) overlay.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.25);font-size:11px">no closed trades yet</div>';
    return;
  }

  // First "anchor" point at $0 baseline before any closes.
  let cum = 0;
  const points = [0, ...closes.map(t => { cum += (t.pnl_usd || 0); return cum; })];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = (max - min) || 1;
  const W = 400, H = 80;
  const TOP = 8, BOT = 56;          // chart area; below BOT = label band
  const stepX = W / (points.length - 1);
  const yFor = v => BOT - ((v - min) / range) * (BOT - TOP);
  const d = points.map((v, i) => `${i ? "L" : "M"}${(i * stepX).toFixed(2)} ${yFor(v).toFixed(2)}`).join(" ");
  const lastIdx = points.length - 1;
  const lastX = lastIdx * stepX;
  const lastY = yFor(points[lastIdx]);
  const final = points[lastIdx];
  const color = final >= 0 ? "#00c9a7" : "#ff4d5e";
  const glow  = final >= 0 ? "rgba(0,201,167,0.5)" : "rgba(255,77,94,0.5)";
  const gid = "spark-grad-" + (final >= 0 ? "g" : "r");
  const area = d + ` L${lastX.toFixed(2)} ${BOT} L0 ${BOT} Z`;

  let zeroLine = "";
  if (min < 0 && max > 0) {
    const z = yFor(0).toFixed(2);
    zeroLine = `<line x1="0" y1="${z}" x2="${W}" y2="${z}" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="3 3"/>`;
  }

  // SVG: chart only (line stretches with the container — no text inside).
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${zeroLine}
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 0 4px ${glow})"/>
  `;

  // HTML overlay: everything that should NOT stretch — dates, end P&L, per-close dots.
  if (!overlay) return;
  const fmtDate = iso => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const firstDate = fmtDate(closes[0].close_iso).toUpperCase();
  const lastDate  = fmtDate(closes[closes.length - 1].close_iso).toUpperCase();
  const finalLabel = (final >= 0 ? "+$" : "-$") + Math.abs(final).toFixed(2);
  const finalCls   = final >= 0 ? "pos" : "neg";

  // Trade ID short label — pull the coin abbreviation from "BTCUSDT_..." style.
  const shortId = c => {
    const tid = c.trade_id || "";
    const coin = (c.coin || tid.split("_")[0] || "").replace("USDT", "");
    return coin || "?";
  };

  // Per-close dots: alternate label position above/below dots to reduce overlap.
  let dotsHtml = "";
  closes.forEach((c, i) => {
    const idx = i + 1;                  // points[0] is the $0 anchor
    const xPct = (idx * stepX / W) * 100;
    const yPct = (yFor(points[idx]) / H) * 100;
    const won = c.won != null ? c.won : (c.pnl_usd || 0) > 0;
    const cls = won ? "win" : "loss";
    const above = (i % 2 === 0);
    const pnlStr = ((c.pnl_usd || 0) >= 0 ? "+$" : "-$") + Math.abs(c.pnl_usd || 0).toFixed(2);
    dotsHtml += `
      <div class="spark-dot ${cls}" style="left:${xPct.toFixed(2)}%;top:${yPct.toFixed(2)}%"
           title="${c.trade_id || ""} · ${pnlStr}">
        <span class="spark-tid ${above ? "above" : "below"}">${shortId(c)}</span>
      </div>`;
  });

  // Date labels — one per unique day across the chart, anchored at each day's
  // first close. First/last dates always shown at the edges so the chart
  // reads naturally regardless of which days fall in the middle.
  const dayKey = iso => iso.slice(0, 10);                    // YYYY-MM-DD
  const dayShort = iso => fmtDate(iso).toUpperCase();
  const seenDays = new Set();
  let datesHtml = "";
  closes.forEach((c, i) => {
    const k = dayKey(c.close_iso);
    if (seenDays.has(k)) return;
    seenDays.add(k);
    const idx = i + 1;
    const xPct = (idx * stepX / W) * 100;
    // Skip if it would collide with the right-pinned final date or left edge.
    if (xPct < 6) return;
    if (xPct > 94) return;
    datesHtml += `<div class="spark-date mid" style="left:${xPct.toFixed(2)}%">${dayShort(c.close_iso)}</div>`;
  });

  overlay.innerHTML = `
    ${dotsHtml}
    <div class="spark-final ${finalCls}">${finalLabel}</div>
    <div class="spark-date left">${firstDate}</div>
    ${datesHtml}
    <div class="spark-date right">${lastDate}</div>
  `;
}

function fmtAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffM = Math.floor(diffMs / 60000);
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

function renderPendingTriggers() {
  const host = $("triggers");
  const pending = state.trades.filter(t => t.status === "PENDING" && !t.track_only);
  if (!pending.length) {
    host.innerHTML = '<span class="empty">No pending triggers</span>';
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
  }).sort((a, b) => a.distPct - b.distPct).slice(0, 5);

  host.innerHTML = enriched.map(t => {
    const isLong = t.direction === "Long";
    const dirCls = isLong ? "long" : "short";
    const coin = (t.coin || "").replace("USDT", "");
    const sl = t.sl, tp1 = t.tp1, tp2 = t.tp2;
    const hasTP2 = !!(tp2 && tp2 !== tp1);
    const furthest = hasTP2 ? (isLong ? Math.max(tp1, tp2) : Math.min(tp1, tp2)) : tp1;
    const span = isLong ? (furthest - sl) : (sl - furthest);
    const posOf = p => Math.max(0, Math.min(1, isLong ? (p - sl) / span : (sl - p) / span)) * 100;

    const slPct = 0;
    const ePct  = posOf(t.entry_price);
    const lPct  = posOf(t.live);
    const t1Pct = posOf(tp1);
    const t2Pct = hasTP2 ? posOf(tp2) : null;

    const liveColor = t.inZone ? cssVar("--orange") : cssVar("--muted");
    const distLabel = t.inZone ? "IN ZONE" : `${t.distPct.toFixed(1)}% away`;
    const distCls   = t.inZone ? "pos" : "muted-val";

    return `
      <div class="paper-bar-row ${dirCls}${t.inZone ? " trig-in-zone" : ""}" title="${t.trade_id}">
        <div class="pb-head">
          <div class="pb-coin-row">
            <span class="pb-coin">${coin}</span>
            <span class="pb-tid-inline">${t.trade_id || ""}</span>
          </div>
          <div class="pb-meta">
            <span class="pb-dir ${dirCls}">${isLong ? "▲ LONG" : "▼ SHORT"}</span>
            <span class="pb-sys">${t.trading_system || ""}</span>
          </div>
        </div>
        <div class="pb-bar">
          <div class="pb-track"></div>
          <span class="pb-flag sl"    style="left:${slPct}%">SL</span>
          <span class="pb-flag entry" style="left:${ePct.toFixed(1)}%">ENTRY</span>
          <span class="pb-flag tp1"   style="left:${t1Pct.toFixed(1)}%">TP1</span>
          ${t2Pct !== null ? `<span class="pb-flag tp2" style="left:${t2Pct.toFixed(1)}%">TP2</span>` : ""}
          <div class="pb-marker sl"    style="left:${slPct}%"></div>
          <div class="pb-marker entry" style="left:${ePct.toFixed(1)}%"></div>
          <div class="pb-marker tp1"   style="left:${t1Pct.toFixed(1)}%"></div>
          ${t2Pct !== null ? `<div class="pb-marker tp2" style="left:${t2Pct.toFixed(1)}%"></div>` : ""}
          <div class="pb-dot" style="left:${lPct.toFixed(1)}%;background:${liveColor};box-shadow:0 0 12px ${liveColor},0 0 4px ${liveColor}"></div>
          <div class="pb-prices">
            <span class="pb-price-val sl"    style="left:${slPct}%">${fmtPrice(sl)}</span>
            <span class="pb-price-val entry" style="left:${ePct.toFixed(1)}%">${fmtPrice(t.entry_price)}</span>
            <span class="pb-price-val tp1"   style="left:${t1Pct.toFixed(1)}%">${fmtPrice(tp1)}</span>
            ${t2Pct !== null ? `<span class="pb-price-val tp2" style="left:${t2Pct.toFixed(1)}%">${fmtPrice(tp2)}</span>` : ""}
          </div>
        </div>
        <div class="pb-pnl">
          <div class="pb-pnl-pct ${distCls}">${distLabel}</div>
          <div class="pb-pnl-usd">${fmtPrice(t.live)}</div>
        </div>
      </div>`;
  }).join("");
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
  $("activity").innerHTML = events.slice(0, 8).map(ev => {
    const { t } = ev;
    const coin = (t.coin || "").replace("USDT", "");
    const dir  = t.direction || "";
    const sys  = t.trading_system || "";
    const px   = t.entry_price ? fmtPrice(t.entry_price) : "";
    const track = t.track_only ? ' <span class="ev-track">track</span>' : "";
    const ago  = `<span class="ev-time">${fmtAgo(t.iso || t.close_iso)}</span>`;
    switch (ev.type) {
      case "signal": return `<div class="ev-row"><span class="ev-chip signal">🔔 SIGNAL</span><span class="ev-body">${coin} ${dir} · ${sys} · $${px}${track}</span>${ago}</div>`;
      case "open":   return `<div class="ev-row"><span class="ev-chip open">✅ ENTERED</span><span class="ev-body">${coin} ${dir} · ${sys} · $${px}</span>${ago}</div>`;
      case "win":    return `<div class="ev-row"><span class="ev-chip win">💰 ${t.status === "TP2_HIT" ? "TP2 HIT" : "CLOSED WIN"}</span><span class="ev-body">${coin} ${dir} · ${sys} · <strong>+$${Math.abs(t.pnl_usd||0).toFixed(2)}</strong></span>${ago}</div>`;
      case "loss":   return `<div class="ev-row"><span class="ev-chip loss">❌ STOPPED</span><span class="ev-body">${coin} ${dir} · ${sys} · -$${Math.abs(t.pnl_usd||0).toFixed(2)}</span>${ago}</div>`;
      case "cancel": return `<div class="ev-row"><span class="ev-chip cancel">🚫 CANCELLED</span><span class="ev-body">${coin} ${dir} · ${sys}</span>${ago}</div>`;
      default: return "";
    }
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
  const systems = ["John", "Braam", "Mong", "William"];
  const open = state.trades.filter(t => t.status === "OPEN");
  const r = 18, circ = 2 * Math.PI * r;
  const html = systems.map(name => {
    const sysOpen = open.filter(t => t.trading_system === name);
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
        <div class="metric"><span class="k">Closed</span><span class="v">${closed}</span></div>
        <div class="metric"><span class="k">Unrealized</span><span class="v ${cls(sysUnreal)}">${fmtUsd(sysUnreal)}</span></div>
        <div class="metric"><span class="k">Realized</span><span class="v ${cls(realized)}">${fmtUsd(realized)}</span></div>
      </div>
    `;
  }).join("");
  $("systems").innerHTML = html;
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
  // Render heatmap when navigating to screen 4
  if (screenIdx === 3) renderHeatmap();
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
  } catch (e) {
    if (!mexcWorkerFailing) console.warn("MEXC worker:", e.message);
    mexcWorkerFailing = true;
    // card keeps showing last known value — no blank-out
  }
}

// Init
$(screens[0]).classList.add("active");
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
fetchBloombergNews();
setInterval(fetchBloombergNews, 60_000);
