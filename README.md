# Trading Dashboard

Public static dashboard for the private trading watchlist system. Data is sanitized and pushed here from the private repo on every cron run.

Live dashboard: `https://divtrader.github.io/trading-dashboard/?k=YOUR_TOKEN`

Files:
- `index.html` — single-page dashboard, rotates 3 screens (overview, movers, per-system)
- `dashboard.js` — fetches `data.json`, opens Binance WebSocket for live prices, computes unrealized P&L in-browser
- `style.css` — dark theme, tablet-readable type
- `data.json` — sanitized snapshot, auto-updated by GitHub Action in private repo
