// Trading dashboard - reads sanitized data.json from this repo + live prices from Binance WS.
// Public-by-data, gated-by-URL-token in JS. Token check is cosmetic; real privacy comes from URL obscurity.

const URL_TOKEN = "BUKTYYvc1SELHNeI";
const DATA_URL = "data.json";
const REFRESH_MS = 60_000;
const ROTATE_MS = 15_000;
const STALE_MS = 5 * 60 * 60_000; // red dot if no cron in >5h (cron is every 4H)

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

let state = { trades: [], stats: {}, prices: {}, lastFetch: 0, lastCronIso: null, recentCloses: [] };

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

  // Realized
  const r = state.stats.realized_pnl_usd ?? 0;
  const wr = state.stats.win_rate_pct ?? 0;
  const closed = state.stats.closed_count ?? 0;
  const rEl = $("realized");
  rEl.textContent = fmtUsd(r);
  rEl.className = "value " + cls(r);
  $("realized-wr").textContent = `${wr.toFixed(1)}% WR · ${closed} closed`;

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
}

// === Bloomberg news flash ===
const BLOOMBERG_SEEN_KEY = "bloombergSeenIds_v1";
function loadBloombergSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(BLOOMBERG_SEEN_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveBloombergSeen(s) {
  localStorage.setItem(BLOOMBERG_SEEN_KEY, JSON.stringify([...s].slice(-50)));
}
let bloombergSeen = loadBloombergSeen();
let bloombergFirstRun = !localStorage.getItem("bloombergFirstRun_v1");

function checkBloombergNews(articles) {
  if (!articles || !articles.length) return;
  if (bloombergFirstRun) {
    // Mark all current as seen on first load — don't replay old news
    articles.forEach(a => bloombergSeen.add(a.id));
    saveBloombergSeen(bloombergSeen);
    localStorage.setItem("bloombergFirstRun_v1", "1");
    bloombergFirstRun = false;
    return;
  }
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
  document.getElementById("nf-headline").textContent = article.title;
  el.classList.remove("out");
  el.hidden = false;
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => { el.hidden = true; el.classList.remove("out"); nfBusy = false; }, 500);
  }, 5000);
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

  // Unrealized total
  const totalUsd = enriched.reduce((s, t) => s + t.usd, 0);
  const totalCap = enriched.reduce((s, t) => s + (t.capital_usd || 100), 0);
  const totalPct = totalCap > 0 ? (totalUsd / totalCap) * 100 : 0;
  const uEl = $("unrealized");
  uEl.textContent = fmtUsd(totalUsd);
  uEl.className = "value " + cls(totalUsd);
  const upEl = $("unrealized-pct");
  upEl.textContent = enriched.length ? fmtPct(totalPct) + " on $" + totalCap.toFixed(0) + " open" : "no open trades";
  upEl.className = "sub " + cls(totalUsd);

  // Movers
  const sorted = [...enriched].sort((a, b) => b.leveragedPct - a.leveragedPct);
  const winners = sorted.slice(0, 2);
  const losers = sorted.slice(-2).reverse();
  $("winners").innerHTML = renderMovers(winners, "winner");
  $("losers").innerHTML = renderMovers(losers, "loser");
}

function fmtPrice(p) {
  return p >= 1000 ? p.toLocaleString("en-US", {maximumFractionDigits: 0})
       : p >= 1    ? p.toPrecision(5)
       : p.toPrecision(4);
}

function positionBar(t) {
  const { live, entry_price, sl, tp1, direction } = t;
  const isLong = direction === "Long";
  const pos = isLong ? (live - sl) / (tp1 - sl) : (sl - live) / (sl - tp1);
  const pct = Math.max(0, Math.min(1, pos)) * 100;
  const distSL  = Math.abs((live - sl)  / entry_price * 100).toFixed(1);
  const distTP1 = Math.abs((tp1 - live) / entry_price * 100).toFixed(1);
  const fillColor = pos < 0.35 ? "#EF5350" : pos > 0.65 ? "#26A69A" : "#FF9800";
  return `
    <div class="pos-bar">
      <div class="pos-track">
        <div class="pos-fill" style="width:${pct.toFixed(1)}%;background:${fillColor}16;border-right:2px solid ${fillColor}"></div>
        <div class="pos-dot" style="left:${pct.toFixed(1)}%;background:${fillColor}"></div>
      </div>
      <div class="pos-labels">
        <span style="color:#EF5350">SL ${distSL}%</span>
        <span style="color:#26A69A">TP1 ${distTP1}%</span>
      </div>
    </div>`;
}

function renderMovers(list, kind) {
  if (!list.length) return `<div class="mover empty">No open trades</div>`;
  return list.map(t => `
    <div class="mover">
      <div class="row1">
        <span class="coin">${t.coin.replace("USDT", "")}</span>
        <span class="dir ${t.direction.toLowerCase()}">${t.direction.toUpperCase()}</span>
      </div>
      <div class="pnl-pct ${cls(t.leveragedPct)}">${fmtPct(t.leveragedPct)}</div>
      ${positionBar(t)}
      <div class="row3">
        <span>${fmtPrice(t.entry_price)} → ${fmtPrice(t.live)}</span>
        <span class="${cls(t.usd)}">${fmtUsd(t.usd)}</span>
      </div>
    </div>
  `).join("");
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

function renderSystems() {
  const systems = ["John", "Braam", "Mong"];
  const open = state.trades.filter(t => t.status === "OPEN");
  const html = systems.map(name => {
    const sysOpen = open.filter(t => t.trading_system === name);
    const sysUnreal = sysOpen.reduce((s, t) => s + computeUnrealized(t).usd, 0);
    const stats = state.stats.per_system?.[name] || {};
    const realized = stats.realized_pnl_usd ?? 0;
    const wr = stats.win_rate_pct ?? 0;
    const closed = stats.closed_count ?? 0;
    return `
      <div class="sys-row">
        <div class="name">${name}</div>
        <div class="metric"><span class="k">Open</span><span class="v">${sysOpen.length}</span></div>
        <div class="metric"><span class="k">Unrealized</span><span class="v ${cls(sysUnreal)}">${fmtUsd(sysUnreal)}</span></div>
        <div class="metric"><span class="k">Realized · WR</span><span class="v ${cls(realized)}">${fmtUsd(realized)} <span style="font-size:14px;color:var(--muted);font-weight:500">· ${wr.toFixed(0)}% (${closed})</span></span></div>
      </div>
    `;
  }).join("");
  $("systems").innerHTML = html;
}

// Screen rotation
let screenIdx = 0;
const screens = ["screen-1", "screen-2", "screen-3"];
function rotate() {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".dots .d").forEach(d => d.classList.remove("active"));
  screenIdx = (screenIdx + 1) % screens.length;
  $(screens[screenIdx]).classList.add("active");
  document.querySelector(`.dots .d[data-i="${screenIdx}"]`).classList.add("active");
}

// Clock — CET/CEST (Europe/Paris, DST-aware)
function tickClock() {
  const d = new Date();
  const t = d.toLocaleTimeString("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
  $("clock").textContent = t + " CET";
}

// Init
$(screens[0]).classList.add("active");
fetchData();
fetchSpotlightPrices();
setInterval(fetchData, REFRESH_MS);
setInterval(fetchSpotlightPrices, 30_000);
setInterval(rotate, ROTATE_MS);
setInterval(tickClock, 1000);
tickClock();
