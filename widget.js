// ======================================
//  Spyker Trading - iPhone Widget
//  App: Scriptable (free on App Store)
//  Supports: small, medium, large
// ======================================

const DATA_URL = "https://divtrader.github.io/trading-dashboard/data.json";
const MEXC_URL = "https://mexc-proxy.braamdeclerk.workers.dev";

// -- Colours --
const C = {
  bg:     new Color("#0d1117"),
  panel:  new Color("#161b22"),
  panel2: new Color("#1c2128"),
  green:  new Color("#00c9a7"),
  red:    new Color("#ff4d5e"),
  orange: new Color("#ff9800"),
  muted:  new Color("#8892a4"),
  fg:     new Color("#e8eaf0"),
  border: new Color("#ffffff", 0.07),
};

// -- Helpers
function fmtUsd(v) {
  if (v == null || isNaN(v)) return "--";
  const abs = Math.abs(v);
  const sign = v >= 0 ? "+" : "-";
  if (abs >= 1000) return sign + "$" + (abs / 1000).toFixed(2) + "k";
  return sign + "$" + abs.toFixed(2);
}
function colorFor(v) { return v > 0 ? C.green : v < 0 ? C.red : C.muted; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// -- Fetch
async function loadData() {
  try {
    const [dash, mexc] = await Promise.all([
      new Request(DATA_URL).loadJSON(),
      new Request(MEXC_URL).loadJSON(),
    ]);
    return { dash, mexc };
  } catch (e) {
    return null;
  }
}

// Compute paper P&L from data.json active_trades
function computePaper(dash) {
  const stats  = dash.stats         || {};
  const trades = dash.active_trades || [];

  let unrealized = 0;
  for (const t of trades) {
    if (t.status !== "OPEN") continue;
    const live = t.price_at_run ?? t.entry_price;
    const dir  = t.direction === "Long" ? 1 : -1;
    const pct  = ((live - t.entry_price) / t.entry_price) * dir;
    const cap  = t.capital_usd || 100;
    const lev  = t.leverage    || 1;
    const remaining = t.tp1_hit ? 0.2 : 1.0;
    unrealized += cap * remaining * pct * lev;
    if (t.tp1_hit && t.pnl_tp1_realized_usd != null) unrealized += t.pnl_tp1_realized_usd;
  }

  const realized  = stats.realized_pnl_usd ?? 0;
  const total     = realized + unrealized;
  const wr        = stats.win_rate_pct  ?? 0;
  const closed    = stats.closed_count  ?? 0;
  const openCnt   = trades.filter(t => t.status === "OPEN").length;
  const pendCnt   = trades.filter(t => t.status === "PENDING").length;

  return { total, realized, unrealized, wr, closed, openCnt, pendCnt };
}

// -- Widget builders
function addLabel(stack, text, size, color, bold) {
  const el = stack.addText(text);
  el.textColor = color ?? C.fg;
  el.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  el.minimumScaleFactor = 0.6;
  return el;
}

function addStat(col, label, value, valColor) {
  const row = col.addStack();
  row.layoutVertically();
  const k = row.addText(label);
  k.textColor = C.muted;
  k.font = Font.boldSystemFont(7);
  const v = row.addText(value);
  v.textColor = valColor ?? C.fg;
  v.font = Font.boldSystemFont(12);
  v.minimumScaleFactor = 0.5;
  return row;
}

function makeCard(parent, flex) {
  const card = parent.addStack();
  card.layoutVertically();
  card.backgroundColor = C.panel;
  card.cornerRadius = 12;
  card.setPadding(11, 11, 11, 11);
  if (flex) card.size = new Size(flex, -1);
  return card;
}

// -- SMALL
function buildSmall(w, paper, mexc) {
  w.setPadding(14, 14, 14, 14);

  addLabel(w, "PAPER", 8, C.muted, true);
  w.addSpacer(2);
  addLabel(w, fmtUsd(paper.total), 26, colorFor(paper.total), true);

  w.addSpacer(10);

  addLabel(w, "MEXC LIVE", 8, C.muted, true);
  w.addSpacer(2);
  const mexcPnl = mexc?.unrealized_pnl ?? null;
  addLabel(w, fmtUsd(mexcPnl), 26, colorFor(mexcPnl), true);

  w.addSpacer();
  addLabel(w, "WR " + paper.wr.toFixed(0) + "%  " + paper.openCnt + " open  " + paper.pendCnt + " pending", 9, C.muted, false);
}

// -- MEDIUM
function buildMedium(w, paper, mexc) {
  w.setPadding(12, 12, 12, 12);

  const row = w.addStack();
  row.layoutHorizontally();
  row.spacing = 8;

  // Paper card
  const left = makeCard(row);
  addLabel(left, "📄 PAPER", 8, C.muted, true);
  left.addSpacer(5);
  addLabel(left, fmtUsd(paper.total), 22, colorFor(paper.total), true);
  left.addSpacer(6);

  const s1 = left.addStack();
  s1.layoutHorizontally();
  s1.spacing = 10;
  addStat(s1, "REALIZED",   fmtUsd(paper.realized),   colorFor(paper.realized));
  addStat(s1, "UNREALIZED", fmtUsd(paper.unrealized), colorFor(paper.unrealized));
  left.addSpacer(4);

  const s2 = left.addStack();
  s2.layoutHorizontally();
  s2.spacing = 10;
  addStat(s2, "WIN RATE", paper.wr.toFixed(1) + "%", paper.wr >= 50 ? C.green : paper.wr >= 30 ? C.orange : C.red);
  addStat(s2, "OPEN",     String(paper.openCnt),     C.fg);
  addStat(s2, "PENDING",  String(paper.pendCnt),     C.muted);

  // MEXC card
  const right = makeCard(row);
  addLabel(right, "⚡ MEXC LIVE", 8, C.muted, true);
  right.addSpacer(5);
  const mp = mexc?.unrealized_pnl ?? null;
  addLabel(right, fmtUsd(mp), 22, colorFor(mp), true);
  right.addSpacer(6);

  const eq  = mexc?.equity          ?? 0;
  const av  = mexc?.available        ?? 0;
  const mg  = mexc?.position_margin  ?? 0;
  addStat(right, "EQUITY",    "$" + eq.toFixed(0), C.fg);
  right.addSpacer(4);
  addStat(right, "AVAILABLE", "$" + av.toFixed(0), C.fg);
  right.addSpacer(4);
  addStat(right, "MARGIN",    "$" + mg.toFixed(0), C.muted);
}

// -- LARGE
function buildLarge(w, paper, mexc) {
  buildMedium(w, paper, mexc);

  // Show recent closes
  w.addSpacer(10);
  addLabel(w, "PAPER - RECENT CLOSES", 8, C.muted, true);
  w.addSpacer(6);

  const closes = (w._dash?.recent_closes || []).slice(0, 5);
  if (!closes.length) {
    addLabel(w, "No recent closes", 11, C.muted, false);
  }
  for (const c of closes) {
    const row = w.addStack();
    row.layoutHorizontally();
    row.backgroundColor = C.panel2;
    row.cornerRadius = 8;
    row.setPadding(6, 10, 6, 10);
    const coin = (c.coin || "").replace("USDT", "");
    addLabel(row, coin, 12, C.fg, true);
    row.addSpacer(4);
    addLabel(row, c.direction === "Long" ? "L" : "S", 10, c.direction === "Long" ? C.green : C.red, true);
    row.addSpacer();
    addLabel(row, fmtUsd(c.pnl_usd), 12, colorFor(c.pnl_usd ?? 0), true);
    w.addSpacer(4);
  }
}

// -- MAIN
const data   = await loadData();
const widget = new ListWidget();
widget.backgroundColor = C.bg;
widget.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000); // refresh every 5 min

if (!data) {
  widget.setPadding(14, 14, 14, 14);
  const t = widget.addText("⚠️ Could not load data");
  t.textColor = C.muted;
  t.font = Font.systemFont(13);
} else {
  const paper = computePaper(data.dash);
  const mexc  = data.mexc?.error ? null : data.mexc;
  const size  = config.widgetFamily ?? "medium";

  if      (size === "small") buildSmall (widget, paper, mexc);
  else if (size === "large") { widget._dash = data.dash; buildLarge(widget, paper, mexc); }
  else                       buildMedium(widget, paper, mexc);
}

Script.setWidget(widget);
if (!config.runsInWidget) await widget.presentMedium();
Script.complete();
