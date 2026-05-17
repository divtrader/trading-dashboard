// Trading dashboard - reads sanitized data.json from this repo + live prices from Binance WS.
// Public-by-data, gated-by-URL-token in JS. Token check is cosmetic; real privacy comes from URL obscurity.

const URL_TOKEN = "BUKTYYvc1SELHNeI";
const DATA_URL = "data.json";
const REFRESH_MS = 60_000;
const ROTATE_MS = 15_000;
const STALE_MS = 30 * 60_000;

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
    $("last-cron").textContent = `last run: ${d.toUTCString().slice(17, 22)} UTC (${ago}m ago)`;
    $("live-dot").classList.toggle("stale", Date.now() - d.getTime() > STALE_MS);
  }

  renderLive();
  renderSystems();
  renderActivity();
}

// === Crypto news ticker — parse RSS via allorigins CORS proxy (free, no key) ===
const NEWS_FEEDS = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", name: "CoinDesk" },
  { url: "https://cointelegraph.com/rss", name: "CoinTelegraph" },
  { url: "https://decrypt.co/feed", name: "Decrypt" },
  { url: "https://bitcoinmagazine.com/feed", name: "BTC Magazine" },
];

async function fetchOneFeed(feed) {
  const proxied = `https://api.allorigins.win/raw?url=${encodeURIComponent(feed.url)}`;
  const r = await fetch(proxied);
  const xmlText = await r.text();
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const items = [...doc.querySelectorAll("item")].slice(0, 8);
  return items.map(it => ({
    title: (it.querySelector("title")?.textContent || "").trim(),
    source: feed.name,
    ts: new Date(it.querySelector("pubDate")?.textContent || Date.now()).getTime(),
  })).filter(x => x.title);
}

async function fetchNews() {
  try {
    const results = await Promise.allSettled(NEWS_FEEDS.map(fetchOneFeed));
    const out = [];
    for (const r of results) if (r.status === "fulfilled") out.push(...r.value);
    if (!out.length) throw new Error("no items");
    out.sort((a, b) => b.ts - a.ts);
    const top = out.slice(0, 25);
    const html = top.map(n =>
      `<span class="news-item">${escapeHtml(n.title)}<span class="news-source">${escapeHtml(n.source)}</span></span>`
    ).join("");
    $("news-ticker").innerHTML = `<span class="news-scroll">${html}${html}</span>`;
  } catch (e) {
    console.error("news failed", e);
    $("news-ticker").innerHTML = '<span class="news-item" style="color:var(--muted)">News feed unavailable</span>';
  }
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

function renderMovers(list, kind) {
  if (!list.length) return `<div class="mover empty">No open trades</div>`;
  return list.map(t => `
    <div class="mover">
      <div class="row1">
        <span class="coin">${t.coin.replace("USDT", "")}</span>
        <span class="dir ${t.direction.toLowerCase()}">${t.direction.toUpperCase()}</span>
      </div>
      <div class="pnl-pct ${cls(t.leveragedPct)}">${fmtPct(t.leveragedPct)}</div>
      <div class="row3">
        <span>${t.entry_price.toPrecision(5)} → ${t.live.toPrecision(5)}</span>
        <span class="${cls(t.usd)}">${fmtUsd(t.usd)}</span>
      </div>
    </div>
  `).join("");
}

function renderActivity() {
  const opens = state.recentOpens || [];
  const closes = state.recentCloses || [];
  // Last 8 hours window
  const cutoff = Date.now() - 8 * 3600_000;
  const recentOpens = opens.filter(o => o._iso_ms && o._iso_ms >= cutoff);
  const recentCloses = closes.filter(c => new Date(c.close_iso).getTime() >= cutoff);

  if (!recentOpens.length && !recentCloses.length) {
    $("activity").innerHTML = '<span class="empty">No new opens or closes in the last 8h.</span>';
    return;
  }
  const parts = [];
  if (recentOpens.length) {
    const names = recentOpens.slice(-4).map(o => `${o.coin.replace("USDT","")} ${o.direction}`).join(", ");
    parts.push(`<span class="chip open">${recentOpens.length} OPENED</span>${names}`);
  }
  if (recentCloses.length) {
    const wins = recentCloses.filter(c => c.won);
    const losses = recentCloses.filter(c => !c.won);
    if (wins.length) {
      const winSum = wins.reduce((s,c) => s + (c.pnl_usd || 0), 0);
      parts.push(`<span class="chip win">${wins.length} WON</span>+$${winSum.toFixed(2)}`);
    }
    if (losses.length) {
      const lossSum = losses.reduce((s,c) => s + (c.pnl_usd || 0), 0);
      parts.push(`<span class="chip loss">${losses.length} STOPPED</span>$${lossSum.toFixed(2)}`);
    }
  }
  $("activity").innerHTML = parts.join("<br>");
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

// Clock
function tickClock() {
  const d = new Date();
  $("clock").textContent = d.toTimeString().slice(0, 5);
}

// Init
$(screens[0]).classList.add("active");
fetchData();
fetchNews();
setInterval(fetchData, REFRESH_MS);
setInterval(fetchNews, 15 * 60_000); // refresh news every 15 min
setInterval(rotate, ROTATE_MS);
setInterval(tickClock, 1000);
tickClock();
