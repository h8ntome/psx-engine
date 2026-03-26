/**
 * PSX Backtesting Engine
 *
 * Usage:
 *   node backtest.js SYMBOL                       — MA crossover with defaults
 *   node backtest.js SYMBOL --fast=5 --slow=20    — customise MA periods
 *   node backtest.js SYMBOL --cash=50000          — starting capital
 *
 * To use a custom strategy, import and call run() directly:
 *
 *   import { run } from './backtest.js';
 *   const result = run('MEBL', myStrategy, { startCash: 10000 });
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  } = options;

  const candles     = loadData(symbol);
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
const TOKEN_RE      = /^(close|open|high|low|sma\d+|\d+(\.\d+)?)$/;
const EXPR_RE       = /^(\S+)\s*(>=|<=|>|<)\s*(\S+)$/;

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
      throw new Error(`Unknown variable or value: "${token}" — allowed: close, open, high, low, smaX, numbers`);
  }

  return { left, op, right };
}

/** Resolve a token to a number given the current candle + history. */
function resolveToken(token, candle, history) {
  if (CANDLE_FIELDS.has(token)) return candle[token];

  const smaMatch = token.match(/^sma(\d+)$/);
  if (smaMatch) {
    const period = parseInt(smaMatch[1], 10);
    const closes = history.filter(c => !c.isSynthetic).map(c => c.close);
    if (closes.length < period) return NaN; // not enough history yet
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
    console.error('Usage: node backtest.js SYMBOL [--fast=5] [--slow=20] [--cash=10000]');
    process.exit(1);
  }

  const get = (flag, def) => {
    const match = args.find(a => a.startsWith(`--${flag}=`));
    return match ? Number(match.split('=')[1]) : def;
  };

  const fast  = get('fast',  5);
  const slow  = get('slow',  20);
  const cash  = get('cash',  10_000);

  console.log(`Strategy: MA crossover (fast=${fast}, slow=${slow})  |  capital: Rs ${cash}`);

  try {
    const result = run(symbol, makeMAStrategy(fast, slow), { startCash: cash });
    printResult(result);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
