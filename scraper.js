/**
 * PSX Daily OHLC Scraper
 * Usage: node scraper.js SYMBOL [SYMBOL2 ...]
 * Example: node scraper.js MEBL HBL OGDC
 *
 * Fetches end-of-day data from the PSX DPS API and stores it in /data/SYMBOL.json.
 * Safe to run repeatedly — new records are appended, duplicates are skipped.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, 'data');
const DPS_EOD   = 'https://dps.psx.com.pk/timeseries/eod';
const TIMEOUT_MS = 10_000;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Fetch ────────────────────────────────────────────
async function fetchEod(symbol) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${DPS_EOD}/${symbol}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Parse ────────────────────────────────────────────
// DPS EOD row formats observed:
//   4 fields: [timestamp, price1, volume, price2]   ← actual format
//   3 fields: [timestamp, price, volume]
//   6 fields: [timestamp, open, high, low, close, volume]
//
// Normalises every row into { time (Unix s), open, high, low, close, volume }
function parseRecords(json) {
  const rows = Array.isArray(json?.data) ? json.data
             : Array.isArray(json)       ? json
             : null;

  if (!rows) {
    console.error('[scraper] Unexpected response shape:', JSON.stringify(json).slice(0, 400));
    return [];
  }

  console.log(`[scraper] Raw rows received: ${rows.length}`);
  // Log first 3 rows so the column layout is visible
  rows.slice(0, 3).forEach((r, i) => console.log(`[scraper] row[${i}]:`, r));

  return rows
    .map(row => {
      if (!Array.isArray(row) || row.length < 3) return null;

      // ── Parse timestamp (field 0) ────────────────
      const rawTs = row[0];
      let time;
      if (typeof rawTs === 'number') {
        time = rawTs > 1e10 ? Math.floor(rawTs / 1000) : rawTs; // ms → s
      } else if (typeof rawTs === 'string') {
        const p = Date.parse(rawTs);
        if (isNaN(p)) return null;
        time = Math.floor(p / 1000);
      } else {
        return null;
      }
      if (!Number.isFinite(time)) return null;

      // ── Map remaining fields by row length ───────
      let open, high, low, close, volume;

      if (row.length >= 6) {
        // Full OHLCV: [time, open, high, low, close, volume]
        open   = parseFloat(row[1]);
        high   = parseFloat(row[2]);
        low    = parseFloat(row[3]);
        close  = parseFloat(row[4]);
        volume = parseFloat(row[5]) || 0;
      } else if (row.length === 4) {
        // DPS actual format: [time, price1, volume, price2]
        // Treat price1 as open, price2 as close; derive high/low from both
        open   = parseFloat(row[1]);
        volume = parseFloat(row[2]) || 0;
        close  = parseFloat(row[3]);
        high   = Math.max(open, close);
        low    = Math.min(open, close);
      } else {
        // 3 fields: [time, price, volume] — single price, flatten to OHLC
        open   = parseFloat(row[1]);
        volume = parseFloat(row[2]) || 0;
        close  = open;
        high   = open;
        low    = open;
      }

      // Only require a valid timestamp and at least one finite price
      if (!Number.isFinite(close) && !Number.isFinite(open)) return null;
      // Fill any missing price from the other
      if (!Number.isFinite(open))  open  = close;
      if (!Number.isFinite(close)) close = open;
      if (!Number.isFinite(high))  high  = Math.max(open, close);
      if (!Number.isFinite(low))   low   = Math.min(open, close);

      return { time, open, high, low, close, volume };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

// ── Storage ──────────────────────────────────────────
function loadExisting(symbol) {
  const path = join(DATA_DIR, `${symbol}.json`);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    console.warn(`[scraper] Could not parse existing ${symbol}.json — starting fresh`);
    return [];
  }
}

function mergeAndSave(symbol, existing, fresh) {
  const map = new Map(existing.map(r => [r.time, r]));
  let added = 0;
  for (const r of fresh) {
    if (!map.has(r.time)) { map.set(r.time, r); added++; }
  }
  const merged = [...map.values()].sort((a, b) => a.time - b.time);
  writeFileSync(join(DATA_DIR, `${symbol}.json`), JSON.stringify(merged, null, 2));
  return { total: merged.length, added };
}

// ── Main ─────────────────────────────────────────────
async function scrape(symbol) {
  console.log(`\n── ${symbol} ──────────────────────────`);
  let json;
  try {
    json = await fetchEod(symbol);
  } catch (err) {
    console.error(`[scraper] Fetch failed: ${err.message}`);
    return;
  }

  const fresh    = parseRecords(json);
  if (fresh.length === 0) {
    console.warn('[scraper] No valid records parsed — check the sample row above');
    return;
  }

  const existing             = loadExisting(symbol);
  const { total, added }     = mergeAndSave(symbol, existing, fresh);
  const latest               = fresh.at(-1);
  const latestDate           = latest ? new Date(latest.time * 1000).toISOString().slice(0, 10) : '?';

  console.log(`[scraper] +${added} new  |  ${total} total  |  latest: ${latestDate}  →  data/${symbol}.json`);
}

const symbols = process.argv.slice(2).map(s => s.trim().toUpperCase()).filter(Boolean);

if (symbols.length === 0) {
  console.error('Usage:   node scraper.js SYMBOL [SYMBOL2 ...]');
  console.error('Example: node scraper.js MEBL HBL OGDC');
  process.exit(1);
}

for (const sym of symbols) {
  await scrape(sym);
}
