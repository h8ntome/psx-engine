# psx-engine

Open-source PSX trading engine with live market data, portfolio tracking, and backtesting.

---

## Features

- Live PSX stock data (via API)
- Portfolio tracking (paper + real)
- Backtesting engine (multi-year historical data)
- Strategy system (MA crossover + custom rules)
- Web-based UI

---

## Installation

Install globally:

npm install -g psx-engine

---

## Usage

Run the app:

psx-engine

This will:
- start the backend server
- open the web interface automatically

---

## Development

Clone the repository:

git clone https://github.com/h8ntome/psx-engine.git
cd psx-engine

Install dependencies:

npm install

Run locally:

npm run dev

---

## Project Structure

- index.js → backend server
- backtest.js → backtesting engine
- clean.js → data cleaning
- scraper.js → data fetching
- index.html → frontend UI

---

## Disclaimer

This project is for educational purposes only and is not financial advice.