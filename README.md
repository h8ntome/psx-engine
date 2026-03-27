# PSX Engine

> An open-source trading engine for the Pakistan Stock Exchange — live market data, portfolio tracking, and backtesting in one local web app.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/psx-engine)](https://www.npmjs.com/package/psx-engine)

---

## Features

- **Live Market Data** — Real-time PSX tick data with candlestick charts across multiple timeframes (1D, 1W, 1M)
- **Auto Analysis** — When you select a symbol, technical indicators load automatically below the chart: performance metrics, moving averages, RSI gauge, volume analysis, and support/resistance levels
- **Portfolio Tracker** — Track paper and real portfolios with live P&L calculations
- **Backtesting Engine** — Test strategies against multi-year historical OHLC data
- **Strategy System** — Built-in MA crossover strategy plus support for custom expression-based and JSON-defined strategies
- **Symbol Search** — Full PSX symbol search with company name resolution
- **Reliable CLI** — `psx-engine` starts with clear progress logs, auto-opens the browser, and handles errors (port conflicts, database lock) gracefully

---

## Quick Start

Install globally via npm:

```bash
npm install -g psx-engine
```

Then run:

```bash
psx-engine
```

This starts the backend server and automatically opens the web interface in your browser at `http://localhost:3000`.

---

## Development Setup

```bash
git clone https://github.com/h8ntome/psx-engine.git
cd psx-engine
npm install
npm run dev
```

---

## Backtesting

Strategies can be run directly from the command line:

```bash
# MA crossover with defaults (fast=5, slow=20)
node backtest.js MEBL

# Custom MA periods
node backtest.js LUCK --fast=10 --slow=50

# Set starting capital and time window
node backtest.js OGDC --cash=50000 --years=5
```

Three strategy types are supported via the web UI and API:

| Strategy | Description |
|----------|-------------|
| `ma` | Moving average crossover (configurable fast/slow periods) |
| `custom` | Expression-based buy/sell rules |
| `json` | JSON-defined strategy object |

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/prices?symbols=MEBL,LUCK` | Fetch live prices for up to 10 symbols |
| `GET` | `/search?query=HBL` | Search symbols with company name |
| `GET` | `/history/:symbol?interval=1m&range=1d` | OHLC candlestick data |
| `GET` | `/history-daily/:symbol` | Locally stored daily OHLC data |
| `GET` | `/portfolio/:type` | Load saved positions (`paper` or `real`) |
| `POST` | `/portfolio/:type` | Save positions for a portfolio type |
| `POST` | `/portfolio` | Calculate live P&L (stateless) |
| `POST` | `/api/fetch-data` | Fetch and store historical data for a symbol |
| `POST` | `/backtest` | Run a backtest and return results |
| `GET` | `/api/analyze/:symbol` | Run Python technical analysis (performance, SMAs, RSI, S/R) |

**Supported intervals:** `1m`, `5m`, `15m`, `1h`, `1d`
**Supported ranges:** `1d`, `1w`, `1m`, `3m`, `1y`

---

## Project Structure

```
psx-engine/
├── cli.js          # CLI entry point — detects running server, opens browser
├── index.js        # Express backend server & API routes
├── analyze.py      # Python technical analysis engine (SMAs, RSI, S/R)
├── backtest.js     # Backtesting engine & strategy system
├── scraper.js      # Historical data fetcher
├── clean.js        # Data cleaning & normalization
├── db.js           # SQLite portfolio persistence
├── index.html      # Frontend web UI
└── data/           # Locally cached OHLC data (per symbol)
```

---

## Requirements

- Node.js 18 or higher
- Python 3 with `pandas` and `numpy` (for technical analysis)
- Internet connection for live data (PSX Terminal API)

---

## Disclaimer

This project is for **educational purposes only** and does not constitute financial advice. Past backtest performance does not guarantee future results. Use at your own risk.

---

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License

[MIT](LICENSE)
