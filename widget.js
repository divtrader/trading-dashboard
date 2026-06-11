// ======================================
//  Spyker Trading - iPhone Widget
//  App: Scriptable (free on App Store)
//  Supports: small, medium, large
// ======================================

const DATA_URL = "https://divtrader.github.io/trading-dashboard/data.json";
const MEXC_URL = "https://mexc-proxy.braamdeclerk.workers.dev";

// -- Colours --
const C = {
  bg:      new Color("#0d1117"),
  panel:   new Color("#161b22"),
  panel2:  new Color("#1c2128"),
  green:   new Color("#00c9a7"),
  red:     new Color("#ff4d5e"),
  orange:  new Color("#ff9800"),
  muted:   new Color("#8892a4"),
  fg:      new Color("#e8eaf0"),
  border:  new Color("#ffffff", 0.07),
  dimFg:   new Color("#c8cdd8"),
};

// -- Helpers
function fmtUsd(v) {
  if (v == null || isNaN(v)) return "--";
  const abs = Math.abs(v);
  const sign = v >= 0 ? "+" : "-";
  if (abs >= 1000) return sign + "$" + (abs / 1000).toFixed(1) + "k";
  return sign + "$" + abs.toFixed(0);
}
function fmtUsdFull(v) {
  if (v == null || isNaN(v)) return "--";
  const abs = Math.abs(v);
  const sign = v >= 0 ? "+" : "-";
  if (abs >= 1000) return sign + "$" + (abs / 1000).toFixed(2) + "k";
  return sign + "$" + abs.toFixed(2);
}
function colorFor(v) { return v > 0 ? C.green : v < 0 ? C.red : C.muted; }
function fmtTime(d) {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return h + ":" + m;
}

// -- Fetch live Binance prices for a list of symbols
async function fetchLivePrices(symbols) {
  if (!symbols.length) return {};
  try {
    const encoded = encodeURIComponent(JSON.stringify(symbols));
    const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encoded}`;
    const data = await new Request(url).loadJSON();
    const map = {};
    for (const item of data) map[item.symbol] = parseFloat(item.price);
    return map;
  } catch (e) {
    return {};
  }
}

// -- Fetch
async function loadData() {
  try {
    const [dash, mexc] = await Promise.all([
      new Request(DATA_URL).loadJSON(),
      new Request(MEXC_URL).loadJSON(),
    ]);

    // Fetch live prices for all open paper trades
    const openTrades = (dash.active_trades || []).filter(t => t.status === "OPEN");
    const symbols = [...new Set(openTrades.map(t => t.coin).filter(Boolean))];
    const livePx = await fetchLivePrices(symbols);

    return { dash, mexc, livePx };
  } catch (e) {
    return null;
  }
}

// Compute paper P&L from data.json active_trades using live Binance prices
// Mirrors dashboard.js computeUnrealized + tp1Banked logic exactly
function computePaper(dash, livePx) {
  const stats  = dash.stats         || {};
  const trades = dash.active_trades || [];

  let unrealized = 0;
  let tp1Banked  = 0;

  for (const t of trades) {
    if (t.status !== "OPEN") continue;
    const live = (livePx && livePx[t.coin]) ?? t.price_at_run ?? t.entry_price;
    const isLong = t.direction === "Long";
    const dir    = isLong ? 1 : -1;
    const ep     = t.entry_price || 0;
    const cap    = t.capital_usd || 100;
    const lev    = t.leverage    || 1;

    if (t.tp1_hit) {
      // 80% banked at TP1 — use recorded value if available, else calculate
      if (t.pnl_tp1_realized_usd != null) {
        tp1Banked += t.pnl_tp1_realized_usd;
      } else if (t.tp1 && ep) {
        const tp1Pct = ((t.tp1 - ep) / ep) * dir;
        tp1Banked += cap * 0.8 * tp1Pct * lev;
      }
      // Remaining 20% still live
      const pct20 = ep ? ((live - ep) / ep) * dir : 0;
      unrealized += cap * 0.2 * pct20 * lev;
    } else {
      const pct = ep ? ((live - ep) / ep) * dir : 0;
      unrealized += cap * pct * lev;
    }
  }

  const realized  = (stats.realized_pnl_usd ?? 0) + tp1Banked;
  const total     = realized + unrealized;
  const wr        = stats.win_rate_pct  ?? 0;
  const closed    = stats.closed_count  ?? 0;
  // Canonical realized-P&L % — emitted by publish_dashboard.py /
  // publish_live_dashboard.py. Widget never computes its own %; reads
  // this so widget + dashboard never drift.
  const pct       = stats.realized_pnl_pct ?? 0;
  const openCnt   = trades.filter(t => t.status === "OPEN").length;
  const pendCnt   = trades.filter(t => t.status === "PENDING").length;

  return { total, realized, unrealized, pct, wr, closed, openCnt, pendCnt };
}

// "+$X.XX (+P.PP%)" — matches dashboard's hero format. Drops to just
// the $ figure if pct is null/undefined (legacy data).
// Uses a non-breaking space ( ) between $ and (%) so iOS
// Scriptable can't word-wrap the bracketed % onto a second line
// on Medium-width cards.
function fmtUsdPct(v, pct) {
  if (v == null || isNaN(v)) return "--";
  const $ = fmtUsdFull(v);
  if (pct == null || isNaN(pct)) return $;
  const sign = pct >= 0 ? "+" : "";
  return `${$} (${sign}${pct.toFixed(2)}%)`;
}

// -- Widget builders
// oneLine=true forces lineLimit=1 + a more aggressive scale floor so
// long strings (like "+$X.XX (+P.PP%)") shrink to fit rather than
// wrapping onto a 2nd line. Used for headline figures on Medium-card
// widths where the bracketed % otherwise pushes to a second row.
function txt(stack, text, size, color, bold, oneLine) {
  const el = stack.addText(text);
  el.textColor = color ?? C.fg;
  el.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  el.minimumScaleFactor = oneLine ? 0.45 : 0.6;
  if (oneLine) el.lineLimit = 1;
  return el;
}

function statBlock(col, label, value, valColor) {
  const b = col.addStack();
  b.layoutVertically();
  const lbl = b.addText(label);
  lbl.textColor = C.muted;
  lbl.font = Font.boldSystemFont(7);
  const val = b.addText(value);
  val.textColor = valColor ?? C.fg;
  val.font = Font.boldSystemFont(13);
  val.minimumScaleFactor = 0.5;
  return b;
}

function makeCard(parent, width) {
  const card = parent.addStack();
  card.layoutVertically();
  card.backgroundColor = C.panel;
  card.cornerRadius = 14;
  card.setPadding(12, 13, 12, 13);
  if (width) card.size = new Size(width, -1);
  return card;
}

// -- SMALL
function buildSmall(w, paper, mexc) {
  w.setPadding(16, 16, 16, 16);

  txt(w, "PAPER", 8, C.muted, true);
  w.addSpacer(3);
  txt(w, fmtUsdPct(paper.total, paper.pct), 20, colorFor(paper.total), true, true);

  w.addSpacer(12);

  txt(w, "MEXC LIVE", 8, C.muted, true);
  w.addSpacer(3);
  // Worker emits unrealized_pct as percentage points already
  // (e.g. -3.5 = -3.5%). Don't multiply by 100.
  const mexcPnl = mexc?.unrealized_pnl ?? null;
  const mexcPct = mexc?.unrealized_pct ?? null;
  txt(w, fmtUsdPct(mexcPnl, mexcPct), 20, colorFor(mexcPnl), true, true);

  w.addSpacer();
  const now = new Date();
  txt(w, fmtTime(now), 9, C.muted, false);
}

// -- MEDIUM
function buildMedium(w, paper, mexc, now) {
  w.setPadding(13, 13, 13, 13);

  const row = w.addStack();
  row.layoutHorizontally();
  row.spacing = 9;

  // ---- Paper card ----
  const left = makeCard(row);

  // Header row
  const lh = left.addStack();
  lh.layoutHorizontally();
  txt(lh, "PAPER", 8, C.muted, true);
  lh.addSpacer();
  txt(lh, "LIVE", 7, C.green, false);
  left.addSpacer(5);

  // Big number + canonical realized % (publisher-emitted)
  txt(left, fmtUsdPct(paper.total, paper.pct), 20, colorFor(paper.total), true, true);
  left.addSpacer(7);

  // Stats row 1: realized / unrealized
  const sr1 = left.addStack();
  sr1.layoutHorizontally();
  sr1.spacing = 12;
  statBlock(sr1, "REALIZED",   fmtUsd(paper.realized),   colorFor(paper.realized));
  statBlock(sr1, "UNREALIZED", fmtUsd(paper.unrealized), colorFor(paper.unrealized));
  left.addSpacer(5);

  // Stats row 2: WR / open / pending
  const sr2 = left.addStack();
  sr2.layoutHorizontally();
  sr2.spacing = 12;
  statBlock(sr2, "WIN RATE", paper.wr.toFixed(1) + "%",
    paper.wr >= 50 ? C.green : paper.wr >= 30 ? C.orange : C.red);
  statBlock(sr2, "OPEN",    String(paper.openCnt),  C.fg);
  statBlock(sr2, "PENDING", String(paper.pendCnt),  C.muted);

  // ---- MEXC card ----
  const right = makeCard(row);

  // Header
  txt(right, "MEXC LIVE", 8, C.muted, true);
  right.addSpacer(5);

  const mp = mexc?.unrealized_pnl ?? null;
  const eq = mexc?.equity         ?? 0;
  const av = mexc?.available      ?? 0;
  // Return-on-equity: unrealized / equity (fixes ~100× inflation from margin denominator)
  const mpPct = eq > 0 && mp != null ? (mp / eq) * 100 : null;
  txt(right, fmtUsdPct(mp, mpPct), 20, colorFor(mp), true, true);
  right.addSpacer(7);

  // Equity / available
  const mr1 = right.addStack();
  mr1.layoutHorizontally();
  mr1.spacing = 12;
  statBlock(mr1, "EQUITY",    "$" + Math.round(eq), C.fg);
  statBlock(mr1, "AVAILABLE", "$" + Math.round(av), C.fg);
  right.addSpacer(5);

  // Win rate / open / pending — mirrors paper side
  const mr2 = right.addStack();
  mr2.layoutHorizontally();
  mr2.spacing = 12;
  statBlock(mr2, "WIN RATE", paper.wr.toFixed(1) + "%", paper.wr >= 50 ? C.green : paper.wr >= 30 ? C.orange : C.red);
  statBlock(mr2, "OPEN",    String(paper.openCnt),  C.fg);
  statBlock(mr2, "PENDING", String(paper.pendCnt),  C.muted);
  mr2.addSpacer();

  // Updated timestamp
  right.addSpacer(5);
  const ts2 = right.addStack();
  ts2.layoutHorizontally();
  ts2.addSpacer();
  const tsLbl = ts2.addText("updated " + fmtTime(now));
  tsLbl.textColor = C.muted;
  tsLbl.font = Font.systemFont(8);
}

// -- LARGE
function buildLarge(w, paper, mexc, now) {
  buildMedium(w, paper, mexc, now);

  w.addSpacer(10);
  txt(w, "RECENT CLOSES", 8, C.muted, true);
  w.addSpacer(6);

  const closes = (w._dash?.recent_closes || []).slice(0, 5);
  if (!closes.length) {
    txt(w, "No recent closes", 11, C.muted, false);
  }
  for (const c of closes) {
    const row = w.addStack();
    row.layoutHorizontally();
    row.backgroundColor = C.panel2;
    row.cornerRadius = 8;
    row.setPadding(6, 10, 6, 10);
    const coin = (c.coin || "").replace("USDT", "");
    txt(row, coin, 12, C.fg, true);
    row.addSpacer(4);
    txt(row, c.direction === "Long" ? "L" : "S", 10,
        c.direction === "Long" ? C.green : C.red, true);
    row.addSpacer();
    txt(row, fmtUsdFull(c.pnl_usd), 12, colorFor(c.pnl_usd ?? 0), true);
    w.addSpacer(4);
  }
}

// -- MAIN
const now    = new Date();
const data   = await loadData();
const widget = new ListWidget();
widget.backgroundColor = C.bg;
widget.refreshAfterDate = new Date(now.getTime() + 2 * 60 * 1000);

if (!data) {
  widget.setPadding(14, 14, 14, 14);
  const t = widget.addText("Could not load data");
  t.textColor = C.muted;
  t.font = Font.systemFont(13);
} else {
  const paper = computePaper(data.dash, data.livePx);
  const mexc  = data.mexc?.error ? null : data.mexc;
  const size  = config.widgetFamily ?? "medium";

  if      (size === "small") buildSmall (widget, paper, mexc);
  else if (size === "large") { widget._dash = data.dash; buildLarge(widget, paper, mexc, now); }
  else                       buildMedium(widget, paper, mexc, now);
}

Script.setWidget(widget);
if (!config.runsInWidget) await widget.presentMedium();
Script.complete();
