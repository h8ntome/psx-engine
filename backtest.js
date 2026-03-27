/**
 * PSX Backtesting Engine
 *
 * Usage:
 *   node backtest.js SYMBOL                       — MA crossover with defaults
 *   node backtest.js SYMBOL --fast=5 --slow=20    — customise MA periods
 *   node backtest.js SYMBOL --cash=50000          — starting capital
 *   node backtest.js SYMBOL --years=5             — limit to 5-year window
 *
 * To use a custom strategy, import and call run() directly:
 *
 *   import { run } from './backtest.js';
 *   const result = run('MEBL', myStrategy, { startCash: 10000 });
 */

import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Script runner ─────────────────────────────────────
function runScript(name, args = []) {
  execFileSync(process.execPath, [join(__dirname, name), ...args], { stdio: 'inherit' });
}

// ── Data availability ─────────────────────────────────
/**
 * Ensure data for `symbol` is present and fresh (< 1 day old).
 * Runs the scraper and cleaner as child processes when needed.
 * Exported so index.js can call it from the /api/fetch-data endpoint.
 */
export function ensureData(symbol) {
  const path = join(__dirname, 'data', `${symbol.toUpperCase()}.json`);

  if (!existsSync(path)) {
    console.log(`[PSX] No data found for ${symbol}, fetching...`);
    runScript('scraper.js', [symbol]);
    runScript('clean.js',   [symbol]);
    if (!existsSync(path))
      throw new Error(`Failed to fetch data for ${symbol}. Check your network connection.`);
    return;
  }

  let lastTime = 0;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (Array.isArray(data) && data.length > 0) lastTime = data[data.length - 1].time;
  } catch { /* unreadable — let loadData surface the real error */ }

  const oneDayAgo = Math.floor(Date.now() / 1000) - 86_400;
  if (lastTime < oneDayAgo) {
    console.log(`[PSX] Data outdated for ${symbol}, updating...`);
    runScript('scraper.js', [symbol]);
    runScript('clean.js',   [symbol]);
  }
}

// ── Data loader ───────────────────────────────────────
export function loadData(symbol) {
  const path = join(__dirname, 'data', `${symbol.toUpperCase()}.json`);
  if (!existsSync(path)) throw new Error(`No data file for ${symbol} — run scraper.js first`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data) || data.length === 0) throw new Error(`${symbol}.json is empty`);
  return data;
}

// ── Engine ────────────────────────────────────────────
/**
 * Run a backtest.
 *
 * @param {string}   symbol    — ticker symbol, e.g. 'MEBL'
 * @param {Function} strategy  — (candle, history, position) => 'BUY' | 'SELL' | 'HOLD'
 * @param {object}   options   — { startCash, positionSize, feeRate }
 * @returns {object}           — result summary + tradeLog + equityCurve
 */
export function run(symbol, strategy, options = {}) {
  const {
    startCash    = 10_000,
    positionSize = 0.5,    // fraction of cash deployed per BUY (0–1)
    feeRate      = 0.003,  // 0.3% per trade (applied on both buy and sell)
    years        = 10,     // default lookback window in years
  } = options;

  const allCandles  = loadData(symbol);
  const cutoff      = Math.floor(Date.now() / 1000) - years * 365 * 24 * 60 * 60;
  const candles     = allCandles.filter(c => c.time >= cutoff);

  if (candles.length > 0) {
    const actualYears = (Math.floor(Date.now() / 1000) - candles[0].time) / (365 * 24 * 60 * 60);
    if (actualYears < years - 0.25) {
      console.warn(`[PSX] Warning: Only ${actualYears.toFixed(1)} years of data available (requested ${years} years)`);
    }
  }

  console.log(`[PSX] Backtesting ${symbol.toUpperCase()} — ${years}-year window  (${candles.length} candles)`);

  // Pre-compute indicators once for the full filtered dataset
  if (strategy.requiredIndicators?.length) {
    computeIndicators(candles, strategy.requiredIndicators);
  }

  let cash          = startCash;
  let shares        = 0;
  let entryCost     = 0;   // total cash spent opening position, fees included
  const tradeLog    = [];
  const equityCurve = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (candle.isSynthetic) continue;

    const history  = candles.slice(0, i + 1);
    const avgEntry = shares > 0 ? round2(entryCost / shares) : 0;
    const signal   = strategy(candle, history, { shares, entryPrice: avgEntry });

    if (signal === 'BUY' && shares === 0 && cash > 0) {
      // Allocate positionSize fraction; back out fee so total spend = allocate
      const allocate = cash * positionSize;
      const qty      = Math.floor(allocate / (candle.close * (1 + feeRate)));
      if (qty === 0) continue;

      const cost  = qty * candle.close;
      const fee   = round2(cost * feeRate);
      cash       -= cost + fee;
      shares      = qty;
      entryCost   = cost + fee;

      tradeLog.push({
        time:   candle.time,
        date:   isoDate(candle.time),
        action: 'BUY',
        price:  candle.close,
        shares: qty,
        fee,
        profit: null,
      });

    } else if (signal === 'SELL' && shares > 0) {
      const proceeds = shares * candle.close;
      const fee      = round2(proceeds * feeRate);
      const net      = proceeds - fee;
      const profit   = round2(net - entryCost);
      const profitPct = round4((candle.close - avgEntry) / avgEntry);
      cash   += net;

      tradeLog.push({
        time:      candle.time,
        date:      isoDate(candle.time),
        action:    'SELL',
        price:     candle.close,
        shares,
        fee,
        profit,
        profitPct,
      });
      shares    = 0;
      entryCost = 0;
    }

    // Snapshot equity at close of each real candle (after any trade)
    equityCurve.push({ time: candle.time, equity: round2(cash + shares * candle.close) });
  }

  const lastReal     = [...candles].reverse().find(c => !c.isSynthetic);
  const currentPrice = lastReal?.close ?? 0;
  const finalBalance = round2(cash + shares * currentPrice);
  const totalReturn  = round4((finalBalance - startCash) / startCash);

  const sells       = tradeLog.filter(t => t.action === 'SELL');
  const wins        = sells.filter(t => t.profit > 0);
  const totalProfit = round2(sells.reduce((s, t) => s + t.profit, 0));

  return {
    symbol,
    startCash,
    finalBalance,
    totalReturn,
    totalReturnPct: `${(totalReturn * 100).toFixed(2)}%`,
    totalTrades:    sells.length,
    winningTrades:  wins.length,
    losingTrades:   sells.length - wins.length,
    winRate:        sells.length > 0 ? round4(wins.length / sells.length) : 0,
    totalProfit,
    openShares:     shares,
    openValue:      round2(shares * currentPrice),
    trades:         tradeLog,
    tradeLog,
    equityCurve,
  };
}

// ── Built-in strategies ───────────────────────────────

/**
 * Moving-average crossover.
 * BUY  when the fast MA crosses above the slow MA.
 * SELL when the fast MA crosses below the slow MA.
 *
 * Only uses real (non-synthetic) candles for MA calculation.
 */
export function makeMAStrategy(fastPeriod = 5, slowPeriod = 20) {
  if (fastPeriod >= slowPeriod)
    throw new Error('fastPeriod must be less than slowPeriod');

  return function maStrategy(candle, history, position) {
    // Extract close prices from real candles only (no synthetic noise)
    const closes = history
      .filter(c => !c.isSynthetic)
      .map(c => c.close);

    if (closes.length < slowPeriod) return 'HOLD'; // not enough data yet

    const fastMA = avg(closes.slice(-fastPeriod));
    const slowMA = avg(closes.slice(-slowPeriod));

    // Also compute previous bar MAs to detect the crossover moment
    const prevCloses = closes.slice(0, -1);
    if (prevCloses.length < slowPeriod) return 'HOLD';

    const prevFastMA = avg(prevCloses.slice(-fastPeriod));
    const prevSlowMA = avg(prevCloses.slice(-slowPeriod));

    const crossedAbove = prevFastMA <= prevSlowMA && fastMA > slowMA;
    const crossedBelow = prevFastMA >= prevSlowMA && fastMA < slowMA;

    if (crossedAbove && position.shares === 0) return 'BUY';
    if (crossedBelow && position.shares  >  0) return 'SELL';
    return 'HOLD';
  };
}

// ── Custom expression strategy ────────────────────────

// Supported variables (both sides of a comparison)
const CANDLE_FIELDS = new Set(['close', 'open', 'high', 'low']);
const TOKEN_RE      = /^(close|open|high|low|sma\d+|rsi\d+|\d+(\.\d+)?)$/;
const EXPR_RE       = /^(\S+)\s*(>=|<=|>|<)\s*(\S+)$/;
const IND_RE        = /\b(sma\d+|rsi\d+)\b/g;

/**
 * Parse "close > sma20" → { left:'close', op:'>', right:'sma20' }
 * Throws a descriptive Error on any problem so callers can surface it.
 */
function parseExpression(raw) {
  const expr = (raw ?? '').trim();
  if (!expr) throw new Error('Expression is empty');

  const m = expr.match(EXPR_RE);
  if (!m) throw new Error(`Cannot parse "${expr}" — expected: <value> <op> <value>  (ops: > < >= <=)`);

  const [, left, op, right] = m;

  for (const token of [left, right]) {
    if (!TOKEN_RE.test(token))
      throw new Error(`Unknown variable or value: "${token}" — allowed: close, open, high, low, smaX, rsiX, numbers`);
  }

  return { left, op, right };
}

/** Resolve a token to a number given the current candle + history. */
function resolveToken(token, candle, history) {
  if (CANDLE_FIELDS.has(token)) return candle[token];

  // Fast path: pre-computed indicator attached to candle by computeIndicators()
  if (candle._ind && token in candle._ind) return candle._ind[token];

  // Fallback: compute SMA on-the-fly from history (used by legacy makeCustomStrategy)
  const smaMatch = token.match(/^sma(\d+)$/);
  if (smaMatch) {
    const period = parseInt(smaMatch[1], 10);
    const closes = history.filter(c => !c.isSynthetic).map(c => c.close);
    if (closes.length < period) return NaN;
    return closes.slice(-period).reduce((s, v) => s + v, 0) / period;
  }

  return parseFloat(token); // numeric literal
}

/** Evaluate a parsed expression against the current bar. Returns boolean. */
function evalExpr(parsed, candle, history) {
  const lv = resolveToken(parsed.left,  candle, history);
  const rv = resolveToken(parsed.right, candle, history);
  if (!Number.isFinite(lv) || !Number.isFinite(rv)) return false;
  switch (parsed.op) {
    case '>':  return lv >  rv;
    case '<':  return lv <  rv;
    case '>=': return lv >= rv;
    case '<=': return lv <= rv;
  }
  return false;
}

/**
 * Validate buy/sell expression strings.
 * Returns an array of error strings (empty = valid).
 */
export function validateCustomStrategy({ buy, sell }) {
  const errors = [];
  try { parseExpression(buy);  } catch (e) { errors.push(`Buy: ${e.message}`);  }
  try { parseExpression(sell); } catch (e) { errors.push(`Sell: ${e.message}`); }
  return errors;
}

/**
 * Build a strategy function from { buy, sell } expression strings.
 * Parses once at creation time; evaluation is pure comparison — no eval().
 */
export function makeCustomStrategy({ buy, sell }) {
  const buyParsed  = parseExpression(buy);
  const sellParsed = parseExpression(sell);

  return function customStrategy(candle, history, position) {
    if (position.shares === 0 && evalExpr(buyParsed,  candle, history)) return 'BUY';
    if (position.shares >  0  && evalExpr(sellParsed, candle, history)) return 'SELL';
    return 'HOLD';
  };
}

// ── JSON strategy ─────────────────────────────────────

/**
 * Validate a JSON strategy object (or JSON string).
 *
 * Format:
 *   { "name": "My Strategy", "buy": ["cond1", "cond2"], "sell": ["cond1"] }
 *
 * buy/sell can also be a single string — it will be treated as a 1-element array.
 * Returns an array of error strings (empty = valid).
 */
export function validateJsonStrategy(input) {
  const errors = [];

  let obj;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); }
    catch { errors.push('Invalid JSON'); return errors; }
  } else if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    obj = input;
  } else {
    errors.push('Strategy must be a JSON object or JSON string');
    return errors;
  }

  const toArray = v => Array.isArray(v) ? v : (typeof v === 'string' ? [v] : null);
  const buyArr  = toArray(obj.buy);
  const sellArr = toArray(obj.sell);

  if (!buyArr  || buyArr.length  === 0) errors.push('buy must be a non-empty array or string');
  if (!sellArr || sellArr.length === 0) errors.push('sell must be a non-empty array or string');

  for (const cond of [...(buyArr ?? []), ...(sellArr ?? [])]) {
    try { parseExpression(cond); }
    catch (e) { errors.push(e.message); }
  }

  return errors;
}

/**
 * Build a strategy function from a JSON strategy object (or JSON string).
 * All buy conditions are AND-ed; all sell conditions are AND-ed.
 * The returned function has a `.requiredIndicators` property so run() can
 * pre-compute them once for the full dataset before the main loop.
 */
export function makeJsonStrategy(input) {
  const obj     = typeof input === 'string' ? JSON.parse(input) : input;
  const toArray = v => Array.isArray(v) ? v : [v];
  const buyArr  = toArray(obj.buy);
  const sellArr = toArray(obj.sell);

  const buyParsed  = buyArr.map(parseExpression);
  const sellParsed = sellArr.map(parseExpression);

  // Collect all indicator names used across all conditions
  const allConds = [...buyArr, ...sellArr].join(' ');
  const indicators = [...new Set([...allConds.matchAll(IND_RE)].map(m => m[1]))];

  function jsonStrategy(candle, history, position) {
    if (position.shares === 0) {
      if (buyParsed.every(p => evalExpr(p, candle, history))) return 'BUY';
    } else {
      if (sellParsed.every(p => evalExpr(p, candle, history))) return 'SELL';
    }
    return 'HOLD';
  }

  jsonStrategy.requiredIndicators = indicators;
  return jsonStrategy;
}

// ── Indicator engine ──────────────────────────────────

/**
 * RSI via Wilder's smoothing.
 * `closes` is the running array of real (non-synthetic) close prices up to
 * the current candle.  Returns NaN until enough history is available.
 */
function calcRsi(closes, period) {
  if (closes.length < period + 1) return NaN;

  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);

  // Seed: simple average of first `period` changes
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss -= changes[i];
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smooth remaining changes
  for (let i = period; i < changes.length; i++) {
    const g = changes[i] > 0 ?  changes[i] : 0;
    const l = changes[i] < 0 ? -changes[i] : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }

  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Pre-compute a set of indicators for every candle in the array.
 * Results are attached as `candle._ind = { sma20: …, rsi14: … }`.
 * Only real (non-synthetic) candles contribute to rolling calculations.
 */
function computeIndicators(candles, indicators) {
  if (!indicators.length) return;

  const realCloses = []; // grows as we iterate forward

  for (const c of candles) {
    if (!c.isSynthetic) realCloses.push(c.close);

    const ind = {};
    for (const name of indicators) {
      const smaM = name.match(/^sma(\d+)$/);
      if (smaM) {
        const p = parseInt(smaM[1], 10);
        ind[name] = realCloses.length >= p
          ? realCloses.slice(-p).reduce((s, v) => s + v, 0) / p
          : NaN;
        continue;
      }
      const rsiM = name.match(/^rsi(\d+)$/);
      if (rsiM) {
        ind[name] = calcRsi(realCloses, parseInt(rsiM[1], 10));
      }
    }
    c._ind = ind;
  }
}

// ── Utilities ─────────────────────────────────────────
function avg(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function round2(n) { return Math.round(n * 100)   / 100;   }
function round4(n) { return Math.round(n * 10_000) / 10_000; }
function isoDate(unix) { return new Date(unix * 1000).toISOString().slice(0, 10); }

function printResult(result) {
  const { symbol, startCash, finalBalance, totalReturnPct,
          totalTrades, winningTrades, losingTrades, winRate,
          totalProfit, openShares, openValue } = result;

  const divider = '─'.repeat(44);
  console.log(`\n${divider}`);
  console.log(` Backtest — ${symbol}`);
  console.log(divider);
  console.log(` Start capital   Rs ${startCash.toLocaleString()}`);
  console.log(` Final balance   Rs ${finalBalance.toLocaleString()}`);
  console.log(` Total return    ${totalReturnPct}`);
  console.log(` Realised P/L    Rs ${totalProfit.toLocaleString()}`);
  console.log(divider);
  console.log(` Total trades    ${totalTrades}`);
  console.log(` Wins / Losses   ${winningTrades} / ${losingTrades}`);
  console.log(` Win rate        ${(winRate * 100).toFixed(1)}%`);
  if (openShares > 0)
    console.log(` Open position   ${openShares} shares @ Rs ${openValue.toLocaleString()}`);
  console.log(divider);

  if (result.trades.length > 0) {
    console.log('\n Trade log:');
    for (const t of result.trades) {
      const tag = t.action === 'BUY'
        ? `  BUY  ${t.date}  ${t.shares} × Rs ${t.price}`
        : `  SELL ${t.date}  ${t.shares} × Rs ${t.price}  →  ${t.profit >= 0 ? '+' : ''}Rs ${t.profit} (${(t.profitPct * 100).toFixed(2)}%)`;
      console.log(tag);
    }
    console.log('');
  }
}

// ── CLI entry point ───────────────────────────────────
// Only runs when executed directly (not when imported as a module)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args    = process.argv.slice(2);
  const symbol  = args.find(a => !a.startsWith('--'))?.toUpperCase();

  if (!symbol) {
    console.error('Usage: node backtest.js SYMBOL [--fast=5] [--slow=20] [--cash=10000] [--years=10]');
    process.exit(1);
  }

  const get = (flag, def) => {
    const match = args.find(a => a.startsWith(`--${flag}=`));
    return match ? Number(match.split('=')[1]) : def;
  };

  const fast  = get('fast',  5);
  const slow  = get('slow',  20);
  const cash  = get('cash',  10_000);
  const years = get('years', 10);

  console.log(`Strategy: MA crossover (fast=${fast}, slow=${slow})  |  capital: Rs ${cash}  |  years: ${years}`);

  try {
    ensureData(symbol);
    const result = run(symbol, makeMAStrategy(fast, slow), { startCash: cash, years });
    printResult(result);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
