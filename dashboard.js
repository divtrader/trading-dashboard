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
const cls = (n) => (n >= 0 ? "pos" : "neg");

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
    }
  }

  // Newly-closed trades
  for (const t of newCloses) {
    const evId = `close:${t.trade_id}`;
    if (!seen.has(evId)) events.push({ id: evId, type: t.won ? "win" : "loss", trade: t });
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
      const p = parseFloat(msg.data.c);
      const sym = msg.data.s;
      state.prices[sym] = p;
      renderLive();
    } catch {}
  };
  ws.onclose = () => setTimeout(subscribeWs, 5000);
}

function computeUnrealized(t) {
  const live = state.prices[t.coin] ?? t.price_at_run ?? t.entry_price;
  const dir = t.direction === "Long" ? 1 : -1;
  const pricePct = ((live - t.entry_price) / t.entry_price) * 100 * dir;
  const leveragedPct = pricePct * (t.leverage || 1);
  const usd = (t.capital_usd || 100) * (leveragedPct / 100);
  return { live, pricePct, leveragedPct, usd };
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
    const liveColor = p.unrealized_pnl >= 0 ? "#00c9a7" : "#ff4d5e";

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

  // Movers
  const sorted = [...enriched].sort((a, b) => b.leveragedPct - a.leveragedPct);
  const winners = sorted.slice(0, 2);
  const winnerIds = new Set(winners.map(w => w.trade_id));
  const losers = sorted.slice().reverse().filter(t => !winnerIds.has(t.trade_id)).slice(0, 2);
  $("winners").innerHTML = renderMovers(winners, "winner");
  $("losers").innerHTML = renderMovers(losers, "loser");

  renderHero(enriched);
}

function renderHero(enrichedOpen) {
  const enriched = enrichedOpen || state.trades.filter(t => t.status === "OPEN").map(t => ({ ...t, ...computeUnrealized(t) }));
  const unrealized = enriched.reduce((s, t) => s + t.usd, 0);
  const totalCap   = enriched.reduce((s, t) => s + (t.capital_usd || 100), 0);
  const realized   = state.stats.realized_pnl_usd ?? 0;
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
  if (!svg) return;
  const closes = [...recentCloses].sort((a, b) => new Date(a.close_iso) - new Date(b.close_iso));
  if (!closes.length) {
    svg.setAttribute("viewBox", "0 0 400 80");
    svg.innerHTML = '<text x="200" y="40" text-anchor="middle" fill="rgba(255,255,255,0.25)" font-size="11" font-family="-apple-system,sans-serif">no closed trades yet</text>';
    return;
  }
  let cum = 0;
  // First "anchor" point at $0 baseline before any closes
  const points = [0, ...closes.map(t => { cum += (t.pnl_usd || 0); return cum; })];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = (max - min) || 1;
  const W = 400, H = 80;
  const TOP = 8, BOT = 56; // chart area; below = labels
  const stepX = W / (points.length - 1);
  const yFor = v => BOT - ((v - min) / range) * (BOT - TOP);
  const d = points.map((v, i) => `${i ? "L" : "M"}${(i * stepX).toFixed(2)} ${yFor(v).toFixed(2)}`).join(" ");
  const lastX = ((points.length - 1) * stepX).toFixed(2);
  const lastY = yFor(points[points.length - 1]).toFixed(2);
  const final = points[points.length - 1];
  const color = final >= 0 ? "#00c9a7" : "#ff4d5e";
  const glow  = final >= 0 ? "rgba(0,201,167,0.5)" : "rgba(255,77,94,0.5)";
  const gid = "spark-grad-" + (final >= 0 ? "g" : "r");
  const area = d + ` L${lastX} ${BOT} L0 ${BOT} Z`;

  // Date labels — first close on the left, last on the right
  const fmtDate = iso => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  const firstDate = fmtDate(closes[0].close_iso);
  const lastDate  = fmtDate(closes[closes.length - 1].close_iso);

  // Cumulative P&L label near the end dot
  const finalLabel = (final >= 0 ? "+$" : "-$") + Math.abs(final).toFixed(2);
  // Position the label above or below the dot depending on space
  const labelY = Number(lastY) > 24 ? Number(lastY) - 8 : Number(lastY) + 16;
  const labelX = Math.min(Number(lastX) - 2, W - 4);

  // Optional zero line if the chart crosses zero
  let zeroLine = "";
  if (min < 0 && max > 0) {
    const z = yFor(0).toFixed(2);
    zeroLine = `<line x1="0" y1="${z}" x2="${W}" y2="${z}" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="3 3"/>`;
  }

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
    <circle cx="${lastX}" cy="${lastY}" r="3.5" fill="${color}" style="filter: drop-shadow(0 0 6px ${glow})"/>
    <text x="${labelX}" y="${labelY}" text-anchor="end" fill="${color}" font-size="11" font-weight="800" font-family="-apple-system,sans-serif" style="filter: drop-shadow(0 0 4px ${glow})">${finalLabel}</text>
    <text x="0"   y="74" text-anchor="start" fill="rgba(255,255,255,0.45)" font-size="10" font-weight="700" letter-spacing="0.8" font-family="-apple-system,sans-serif">${firstDate.toUpperCase()}</text>
    <text x="${W}" y="74" text-anchor="end"   fill="rgba(255,255,255,0.45)" font-size="10" font-weight="700" letter-spacing="0.8" font-family="-apple-system,sans-serif">${lastDate.toUpperCase()}</text>
  `;
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
  const liveColor = lPct < 33 ? "#ff4d5e" : lPct > 66 ? "#00c9a7" : "#ffb74d";

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
  const pending = state.trades.filter(t => t.status === "PENDING" && !t.track_only);
  if (!pending.length) {
    $("triggers").innerHTML = '<span class="empty">No active pending trades</span>';
    return;
  }
  const enriched = pending.map(t => {
    const live = state.prices[t.coin] ?? t.price_at_run ?? t.entry_price;
    const isLong = t.direction === "Long";
    // Distance: how far price is from entry zone (entry_lo / entry_hi)
    // 0% = in zone (trigger imminent), positive = still approaching
    let distPct, proximity;
    if (isLong) {
      // Long: waiting for price to drop into zone (entry_lo..entry_hi)
      distPct = live > (t.entry_hi ?? t.entry_price)
        ? ((live - (t.entry_hi ?? t.entry_price)) / live * 100)
        : 0;
    } else {
      // Short: waiting for price to rise into zone
      distPct = live < (t.entry_lo ?? t.entry_price)
        ? (((t.entry_lo ?? t.entry_price) - live) / live * 100)
        : 0;
    }
    // proximity bar: 100% = in zone, 0% = far away (cap at 20% distance = 0% fill)
    proximity = Math.max(0, Math.min(100, (1 - distPct / 20) * 100));
    return { ...t, live, distPct, proximity };
  }).sort((a, b) => b.proximity - a.proximity).slice(0, 4);

  $("triggers").innerHTML = enriched.map(t => {
    const inZone = t.distPct < 0.1;
    const barColor = inZone ? "#FF9800" : t.proximity > 60 ? "#26A69A" : "#4a5568";
    const label = inZone ? "IN ZONE" : `${t.distPct.toFixed(1)}% away`;
    return `
      <div class="trigger-row">
        <div class="tr-left">
          <span class="tr-coin">${t.coin.replace("USDT","")}</span>
          <span class="dir ${t.direction.toLowerCase()}" style="font-size:11px;padding:2px 6px">${t.direction.toUpperCase()}</span>
          <span class="tr-sys">${t.trading_system}</span>
        </div>
        <div class="tr-bar-wrap">
          <div class="tr-bar-track">
            <div class="tr-bar-fill" style="width:${t.proximity.toFixed(0)}%;background:${barColor}"></div>
          </div>
        </div>
        <div class="tr-dist ${inZone ? "in-zone" : ""}">${label}</div>
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
  // TP1 still open
  for (const t of (state.tp1HitsOpen || [])) {
    events.push({ ts: Date.now(), type: "tp1", t });
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
    switch (ev.type) {
      case "signal": return `<div class="ev-row"><span class="ev-chip signal">🔔 SIGNAL</span><span class="ev-body">${coin} ${dir} · ${sys} · $${px}${track}</span></div>`;
      case "open":   return `<div class="ev-row"><span class="ev-chip open">✅ ENTERED</span><span class="ev-body">${coin} ${dir} · ${sys} · $${px}</span></div>`;
      case "tp1":    return `<div class="ev-row"><span class="ev-chip tp1">🎯 TP1 HIT</span><span class="ev-body">${coin} ${dir} · ${sys} · SL at breakeven</span></div>`;
      case "win":    return `<div class="ev-row"><span class="ev-chip win">💰 ${t.status === "TP2_HIT" ? "TP2 HIT" : "CLOSED WIN"}</span><span class="ev-body">${coin} ${dir} · ${sys} · <strong>+$${Math.abs(t.pnl_usd||0).toFixed(2)}</strong></span></div>`;
      case "loss":   return `<div class="ev-row"><span class="ev-chip loss">❌ STOPPED</span><span class="ev-body">${coin} ${dir} · ${sys} · -$${Math.abs(t.pnl_usd||0).toFixed(2)}</span></div>`;
      case "cancel": return `<div class="ev-row"><span class="ev-chip cancel">🚫 CANCELLED</span><span class="ev-body">${coin} ${dir} · ${sys}</span></div>`;
      default: return "";
    }
  }).join("");
}

const SYS_COLOR = { John: "#5B8DEF", Braam: "#ffab40", Mong: "#a76adb" };
const SYS_TAG   = { John: "Trend · Breakout", Braam: "EMA Pullback", Mong: "Mean Reversion" };

function renderSystems() {
  const systems = ["John", "Braam", "Mong"];
  const open = state.trades.filter(t => t.status === "OPEN");
  const r = 18, circ = 2 * Math.PI * r;
  const html = systems.map(name => {
    const sysOpen = open.filter(t => t.trading_system === name);
    const sysUnreal = sysOpen.reduce((s, t) => s + computeUnrealized(t).usd, 0);
    const stats = state.stats.per_system?.[name] || {};
    const realized = stats.realized_pnl_usd ?? 0;
    const wr = stats.win_rate_pct ?? 0;
    const closed = stats.closed_count ?? 0;
    const color = SYS_COLOR[name] || "#7280B5";
    const dash = circ * Math.min(1, wr / 100);
    const offset = circ - dash;
    return `
      <div class="sys-row" data-sys="${name}">
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
        <div class="metric"><span class="k">Unrealized</span><span class="v ${cls(sysUnreal)}">${fmtUsd(sysUnreal)}</span></div>
        <div class="metric"><span class="k">Realized · ${closed}t</span><span class="v ${cls(realized)}">${fmtUsd(realized)}</span></div>
      </div>
    `;
  }).join("");
  $("systems").innerHTML = html;
}

// Screen navigation (swipeable — no auto-rotation)
let screenIdx = 0;
let screenTransitioning = false;
const screens = ["screen-1", "screen-2", "screen-3"];

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
