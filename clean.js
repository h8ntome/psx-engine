/**
 * PSX Data Cleaner
 * Usage: node clean.js [SYMBOL ...]   — specify symbols, or omit for all /data/*.json
 *
 * For each file:
 *   1. Remove invalid / duplicate candles
 *   2. Normalise high/low if out of range
 *   3. Remove flat candles (no price movement)
 *   4. Fill missing calendar days with synthetic carry-forward candles
 *   5. Add derived metrics: return, rangePercent, bodyPercent
 *   6. Overwrite the file with the cleaned result
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, 'data');
const ONE_DAY   = 86_400; // seconds

// ── Helpers ──────────────────────────────────────────
const fin  = v  => typeof v === 'number' && Number.isFinite(v);
const r4   = n  => Math.round(n * 10_000) / 10_000;

function normalise(raw) {
  // Accept any object that has at least a finite time and one finite price.
  // Returns a well-formed candle or null.
  if (!raw || !fin(raw.time) || raw.time <= 0) return null;

  const close  = fin(raw.close)  ? raw.close  : (fin(raw.open) ? raw.open : null);
  if (close === null) return null;

  const open   = fin(raw.open)   ? raw.open   : close;
  const vol    = fin(raw.volume) ? raw.volume : 0;

  // Widen high/low so they always contain the body
  const high   = fin(raw.high)   ? Math.max(raw.high, open, close) : Math.max(open, close);
  const low    = fin(raw.low)    ? Math.min(raw.low,  open, close) : Math.min(open, close);

  // Final structural check
  if (high < Math.max(open, close)) return null;
  if (low  > Math.min(open, close)) return null;

  return { time: raw.time, open, high, low, close, volume: vol };
}

function isFlat(c) {
  return c.open === c.close && c.high === c.close && c.low === c.close;
}

// ── Gap filling ───────────────────────────────────────
// Counts whole calendar days between two timestamps (rounded, handles DST drift)
function daysBetween(t1, t2) {
  return Math.round((t2 - t1) / ONE_DAY);
}

function makeSynthetic(prevCandle, offsetDays) {
  const p = prevCandle.close;
  return {
    time:        prevCandle.time + offsetDays * ONE_DAY,
    open:        p,
    high:        p,
    low:         p,
    close:       p,
    volume:      0,
    isSynthetic: true,
  };
}

// ── Main processing ───────────────────────────────────
function cleanAndEnrich(raw) {
  // Step 1: normalise + validate + dedupe + sort
  const seen  = new Set();
  const valid = raw
    .map(normalise)
    .filter(c => {
      if (!c) return false;
      if (seen.has(c.time)) return false;
      seen.add(c.time);
      return true;
    })
    .sort((a, b) => a.time - b.time)
    .filter(c => !isFlat(c));

  // Step 2: fill gaps
  const filled = [];
  for (const curr of valid) {
    const prev = filled.at(-1);
    if (prev) {
      const gap = daysBetween(prev.time, curr.time);
      // gap === 1 is normal (next trading day)
      // gap > 1 means missing days (weekends, holidays, data holes)
      for (let d = 1; d < gap; d++) {
        filled.push(makeSynthetic(prev, d));
      }
    }
    filled.push(curr);
  }

  // Step 3: derive metrics
  return filled.map((c, i) => {
    const prev = i > 0 ? filled[i - 1] : null;

    const ret          = (prev && prev.close !== 0)
                         ? r4((c.close - prev.close) / prev.close)
                         : 0;
    const rangePercent = (c.close !== 0) ? r4((c.high - c.low) / c.close) : 0;
    const bodyPercent  = (c.close !== 0) ? r4(Math.abs(c.close - c.open) / c.close) : 0;

    return {
      time:         c.time,
      open:         c.open,
      high:         c.high,
      low:          c.low,
      close:        c.close,
      volume:       c.volume,
      return:       ret,
      rangePercent,
      bodyPercent,
      isSynthetic:  c.isSynthetic === true,
    };
  });
}

// ── File handler ──────────────────────────────────────
function processFile(filePath) {
  const symbol = basename(filePath, '.json');

  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[clean] ${symbol}: read error — ${err.message}`);
    return;
  }

  if (!Array.isArray(raw)) {
    console.error(`[clean] ${symbol}: not an array, skipping`);
    return;
  }

  const before    = raw.length;
  const result    = cleanAndEnrich(raw);
  const synthetic = result.filter(c => c.isSynthetic).length;
  const real      = result.length - synthetic;
  const removed   = before - real;

  writeFileSync(filePath, JSON.stringify(result, null, 2));

  const parts = [
    `${symbol}:`,
    `${before} raw`,
    `→ ${real} clean`,
    removed   ? `(removed ${removed})` : '',
    synthetic ? `+ ${synthetic} synthetic` : '',
  ].filter(Boolean);

  console.log('[clean]', parts.join('  '));
}

// ── Entry point ───────────────────────────────────────
const args  = process.argv.slice(2).map(s => s.trim().toUpperCase()).filter(Boolean);

let files;
if (args.length > 0) {
  files = args.map(s => join(DATA_DIR, `${s}.json`));
} else {
  if (!existsSync(DATA_DIR)) {
    console.error('[clean] /data directory not found — run scraper.js first');
    process.exit(1);
  }
  files = readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => join(DATA_DIR, f));
}

if (files.length === 0) {
  console.log('[clean] No files to process');
  process.exit(0);
}

for (const f of files) {
  processFile(f);
}
