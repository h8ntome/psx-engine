# PSX Terminal — Frontend Functionality Fixes
**Date:** 2026-03-28
**Scope:** Bug fixes and correctness only — no UI redesign, no new features
**Approach:** Approach 2 — targeted refactor of chart pipeline to fix bugs as a side effect of clean separation

---

## Problem Summary

Five categories of broken behavior in `index.html` client-side JavaScript:

1. Chart timestamps are inconsistent across tooltip, axis labels, and header
2. Timeframe buttons (1D/1W/1M) reuse the same cached dataset — no fresh fetch
3. Auto chart load on Enter is unreliable; no loading state; no empty-data state
4. Ticker bar refreshes too slowly (15s); click interaction exists but needs validation
5. Stale chart data shown when switching symbols; no clearing between renders

Root cause: `loadChart()` fetches, filters, sorts, stores, and renders in one function. `setTimeframe()` only calls `renderChart()` on cached data. No shared loading state management.

---

## Architecture — Chart Pipeline

Replace the monolithic `loadChart + renderChart` pair with a clean pipeline:

```
loadChart(symbol, timeframe)
  1. showChartLoading(symbol)       — destroy old chart, show spinner, disable tf buttons
  2. fetchDailyCandles(symbol)      — GET /history-daily/:symbol, returns raw array
  3. filterAndAggregate(raw, tf)    — filter by date range, then aggregate candles
  4. validateCandles(candles)       — dedupe by time, sort ascending, drop invalid
  5. if empty → showChartEmpty(symbol)
  6. else     → renderChart(candles, tf) — create new Chart.js instance
  7. hideChartLoading()             — re-enable tf buttons
```

`loadChart(symbol, timeframe)` is the **single entry point** for all chart operations:
- Symbol search pick → `loadChart(symbol, chartTimeframe)`
- Enter key → `loadChart(symbol, chartTimeframe)`
- Timeframe button → `loadChart(chartSymbol, newTF)`  ← always fresh fetch
- Ticker click → `loadChart(symbol, chartTimeframe)`

No other code path calls `renderChart` directly.

---

## Fix 1 — Chart Timestamp Consistency

**Rule:** All candle timestamps are UNIX seconds (integers) throughout the pipeline. No conversion, no mixed formats.

- `fetchDailyCandles` returns raw objects with `c.time` in UNIX seconds as stored in the JSON files
- `filterAndAggregate` compares `c.time` against `Date.now() / 1000 - rangeSeconds` — no unit conversion
- `validateCandles` deduplicates on `c.time` (exact integer match), sorts `(a, b) => a.time - b.time`
- `fmtLabel(time, tf)` — receives raw `c.time`, formats for axis ticks
- `fmtDayFull(time)` — receives raw `c.time`, formats for tooltip
- Both functions use `new Date(time * 1000)` — identical conversion, same source

Candle field correctness (for aggregated candles):
- `open` = `candles[0].open` of first candle in group (the group's opening price)
- `close` = last candle's `close` in group (sorted ascending, so `candles[n-1].close`)
- `high` = `Math.max(...candles.map(c => c.high ?? c.close))`
- `low` = `Math.min(...candles.map(c => c.low ?? c.close))`
- `time` = first candle's `time` in group (group start timestamp)

---

## Fix 2 — Timeframe Buttons (Option A — Lookback Window)

Each timeframe defines a **date filter** applied to the full `/history-daily` dataset:

| Button | Range filter | Aggregation | Displayed bars |
|--------|-------------|-------------|----------------|
| 1D     | Last 60 days | None (daily bars) | ~60 candles |
| 1W     | Last 2 years | Weekly (7-day buckets) | ~104 candles |
| 1M     | All data     | Monthly (calendar month) | All months available |

`filterAndAggregate(raw, tf)`:
- Computes `cutoff = Date.now()/1000 - rangeSeconds` per timeframe
- Filters: `raw.filter(c => c.time >= cutoff)` (for 1D and 1W) or no filter (1M)
- For 1D: returns filtered daily candles as-is
- For 1W/1M: runs existing `aggregateWeekly` / `aggregateMonthly` on filtered set

Timeframe button handler:
```javascript
function setTimeframe(tf) {
  if (tf === '1m') return;           // disabled — no intraday source
  if (!chartSymbol) return;          // no symbol loaded yet
  chartTimeframe = tf;
  updateTFButtons(tf);
  loadChart(chartSymbol, tf);        // fresh fetch + render
}
```

---

## Fix 3 — Auto Chart Load on Enter

Current code calls `loadChart` only if value passes regex and is not comma-separated. No loading state shown.

Fix:
```javascript
symbolsInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  fetchPrices();
  const val = symbolsInput.value.trim().toUpperCase();
  const single = val && !val.includes(',') && /^[A-Z0-9]+$/.test(val);
  if (single) loadChart(val, chartTimeframe);
});
```

`loadChart` itself handles loading state and empty data — no additional logic needed in the event handler.

Empty data state: if `validateCandles` returns 0 candles, call `showChartEmpty(symbol)` which renders a centered message "No chart data available for [SYMBOL]" in the chart area and does not create a Chart.js instance.

---

## Fix 4 — Ticker Bar

**Refresh rate:** Change interval from 15 000ms → 8 000ms.

**Ticker click:** `tickerClick(symbol)` already exists. Ensure it:
1. Switches to market section: `showSection('market')`
2. Sets input value: `symbolsInput.value = symbol`
3. Calls `loadChart(symbol, chartTimeframe)` (not a separate path — uses the main pipeline)

**Scroll continuity:** Do not touch the CSS animation. The existing scroll does not reset because `updateTickerData` updates DOM text in-place without rebuilding the container.

---

## Fix 5 — Stale Data / Loading States

**`showChartLoading(symbol)`:**
- If `chartInstance` exists: `chartInstance.destroy(); chartInstance = null`
- Set `chartDailyCandles = []`
- Inject a `<div class="chart-overlay">Loading…</div>` dynamically inside the chart wrapper (removed in `hideChartLoading`/`showChartEmpty`) — no static HTML changes required
- Disable all timeframe buttons (`disabled` attribute)
- Update any existing chart title/symbol label elements to show "[SYMBOL]"

**`hideChartLoading()`:**
- Hide spinner/overlay
- Re-enable timeframe buttons

**`showChartEmpty(symbol)`:**
- Hide spinner
- Re-enable timeframe buttons
- Render centered text in canvas area: "No chart data available for [SYMBOL]"
- Do NOT create Chart.js instance

**Guard in `renderChart`:**
```javascript
function renderChart(candles, tf) {
  if (!candles.length) return;   // safety guard — should not reach here
  // ... Chart.js setup
}
```

---

## Implementation Scope

All changes are confined to the JavaScript block inside `index.html` (lines ~1627–1846 for chart code, plus ticker initialization around line 1220).

**Functions to modify:**
- `loadChart` — refactor into pipeline, add loading/empty states
- `setTimeframe` — call `loadChart` instead of `renderChart`
- `renderChart` — pure render only, no fetching or state management
- `updateTickerData` / `initTicker` — change interval 15s → 8s
- `tickerClick` — ensure uses `loadChart`
- Enter key handler — simplify condition

**New helper functions:**
- `fetchDailyCandles(symbol)` — extracted fetch logic
- `filterAndAggregate(raw, tf)` — extracted filter + aggregate
- `validateCandles(candles)` — extracted dedupe + sort
- `showChartLoading(symbol)` — loading state UI
- `hideChartLoading()` — clear loading state
- `showChartEmpty(symbol)` — empty state UI
- `updateTFButtons(tf)` — update active class on timeframe buttons

**No changes to:**
- HTML structure / CSS classes / layout
- Backend (index.js) — no new endpoints needed
- Portfolio, backtest, analysis sections
- Symbol search autocomplete logic
