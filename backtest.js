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

// ── Strategy Expression Engine ───────────────────────
//
// Supports full expression syntax:
//   "close > sma(50) AND rsi(14) > 55"
//   "cross(sma(20), sma(50)) OR rsi(14) < 30"
//   "crossunder(sma(20), sma(50))"
//
// Safe recursive-descent parsing — no dynamic code execution of any kind.

const VALID_FIELDS = new Set(['open', 'high', 'low', 'close', 'volume', 'change', 'changepercent', 'range']);
const VALID_FUNCS  = new Set(['sma', 'ema', 'rsi', 'wsma', 'wema']);

// ── Tokenizer ──

/**
 * Break an expression string into typed tokens.
 * Legacy compact forms like "sma20" are transparently expanded to "sma(20)".
 */
function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const s = (expr ?? '').trim();

  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }

    // Comparison operators (check two-char forms first)
    if (s[i] === '>' && s[i + 1] === '=') { tokens.push({ type: 'op', value: '>=' }); i += 2; continue; }
    if (s[i] === '<' && s[i + 1] === '=') { tokens.push({ type: 'op', value: '<=' }); i += 2; continue; }
    if (s[i] === '>')                      { tokens.push({ type: 'op', value: '>' });  i++;     continue; }
    if (s[i] === '<')                      { tokens.push({ type: 'op', value: '<' });  i++;     continue; }

    if (s[i] === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
    if (s[i] === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }
    if (s[i] === ',') { tokens.push({ type: 'COMMA'  }); i++; continue; }

    // Numeric literals
    const numM = s.slice(i).match(/^\d+(\.\d+)?/);
    if (numM) {
      tokens.push({ type: 'num', value: parseFloat(numM[0]) });
      i += numM[0].length;
      continue;
    }

    // Identifiers: AND, OR, function names, field names
    const idM = s.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    if (idM) {
      const id    = idM[0];
      const upper = id.toUpperCase();

      if (upper === 'AND') { tokens.push({ type: 'AND' }); i += id.length; continue; }
      if (upper === 'OR')  { tokens.push({ type: 'OR'  }); i += id.length; continue; }

      // Backward compat: "sma20" → sma(20), "rsi14" → rsi(14), etc.
      const legacyM = id.match(/^(sma|ema|rsi|wsma|wema)(\d+)$/i);
      if (legacyM) {
        tokens.push({ type: 'ident', value: legacyM[1].toLowerCase() });
        tokens.push({ type: 'LPAREN' });
        tokens.push({ type: 'num', value: parseInt(legacyM[2], 10) });
        tokens.push({ type: 'RPAREN' });
        i += id.length;
        continue;
      }

      tokens.push({ type: 'ident', value: id.toLowerCase() });
      i += id.length;
      continue;
    }

    throw new Error(`Unexpected character "${s[i]}" at position ${i} in: "${expr}"`);
  }

  return tokens;
}

// ── Recursive-descent parser ──

class ExprParser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }

  peek()    { return this.tokens[this.pos]; }
  consume() { return this.tokens[this.pos++]; }

  expect(type) {
    const t = this.consume();
    if (!t || t.type !== type)
      throw new Error(`Expected ${type} but got "${t?.type ?? 'EOF'}"`);
    return t;
  }

  // expression = condition (('AND' | 'OR') condition)*
  parseExpression() {
    let left = this.parseCondition();
    while (this.peek()?.type === 'AND' || this.peek()?.type === 'OR') {
      const logOp = this.consume().type.toLowerCase(); // 'and' | 'or'
      const right = this.parseCondition();
      left = { type: logOp, left, right };
    }
    return left;
  }

  // condition = cross(v, v) | crossunder(v, v) | value op value
  parseCondition() {
    const t = this.peek();

    if (t?.type === 'ident' && (t.value === 'cross' || t.value === 'crossunder')) {
      const name = this.consume().value;
      this.expect('LPAREN');
      const a = this.parseValue();
      this.expect('COMMA');
      const b = this.parseValue();
      this.expect('RPAREN');
      return { type: name, a, b };
    }

    const left  = this.parseValue();
    const opTok = this.peek();
    if (!opTok || opTok.type !== 'op')
      throw new Error(`Expected comparison operator (> < >= <=) after value, got "${opTok?.type ?? 'EOF'}"`);
    this.consume();
    const right = this.parseValue();
    return { type: 'cmp', left, op: opTok.value, right };
  }

  // value = number | ident ['(' args ')']
  parseValue() {
    const t = this.peek();
    if (!t) throw new Error('Unexpected end of expression');

    if (t.type === 'num') {
      this.consume();
      return { type: 'num', value: t.value };
    }

    if (t.type === 'LPAREN') {
      this.consume();
      const v = this.parseValue();
      this.expect('RPAREN');
      return v;
    }

    if (t.type === 'ident') {
      this.consume();
      if (this.peek()?.type === 'LPAREN') {
        this.consume(); // consume '('
        const args = [];
        if (this.peek()?.type !== 'RPAREN') {
          args.push(this.parseValue());
          while (this.peek()?.type === 'COMMA') { this.consume(); args.push(this.parseValue()); }
        }
        this.expect('RPAREN');
        return { type: 'func', name: t.value, args };
      }
      return { type: 'field', name: t.value };
    }

    throw new Error(`Unexpected token "${t.type}" while parsing value`);
  }
}

/**
 * Parse a full strategy expression string into an AST.
 * Throws a descriptive Error on any syntax problem.
 */
function parseStrategy(expr) {
  const tokens = tokenize(expr);
  if (tokens.length === 0) throw new Error('Expression is empty');
  const parser = new ExprParser(tokens);
  const ast    = parser.parseExpression();
  if (parser.pos < tokens.length) {
    const extra = tokens[parser.pos];
    throw new Error(`Unexpected token "${extra.value ?? extra.type}" after expression`);
  }
  return ast;
}

// ── AST validation ──

/** Walk an AST and return an array of semantic error strings. */
function validateAst(ast) {
  const errors = [];

  function walkCond(node) {
    if (!node) { errors.push('Null condition node'); return; }
    switch (node.type) {
      case 'and':
      case 'or':
        walkCond(node.left);
        walkCond(node.right);
        break;
      case 'cmp':
        walkVal(node.left);
        walkVal(node.right);
        break;
      case 'cross':
      case 'crossunder':
        walkVal(node.a);
        walkVal(node.b);
        break;
      default:
        errors.push(`Unknown condition node type: "${node.type}"`);
    }
  }

  function walkVal(node) {
    if (!node) { errors.push('Null value node'); return; }
    switch (node.type) {
      case 'num': break;
      case 'field':
        if (!VALID_FIELDS.has(node.name))
          errors.push(`Unknown field "${node.name}" — allowed: ${[...VALID_FIELDS].join(', ')}`);
        break;
      case 'func': {
        if (!VALID_FUNCS.has(node.name))
          errors.push(`Unknown function "${node.name}()" — allowed: ${[...VALID_FUNCS].join(', ')}`);
        if (node.args.length !== 1)
          errors.push(`${node.name}() requires exactly 1 argument (period), got ${node.args.length}`);
        else if (node.args[0].type !== 'num' || !Number.isInteger(node.args[0].value) || node.args[0].value <= 0)
          errors.push(`${node.name}() argument must be a positive integer`);
        break;
      }
      default:
        errors.push(`Unknown value node type: "${node.type}"`);
    }
  }

  walkCond(ast);
  return errors;
}

// ── Indicator key extraction ──

/** Return an array of indicator cache keys (e.g. ["sma_50","rsi_14"]) required by an AST. */
function extractIndicators(ast) {
  const keys = new Set();

  function walkCond(node) {
    if (!node) return;
    switch (node.type) {
      case 'and': case 'or': walkCond(node.left); walkCond(node.right); break;
      case 'cmp': walkVal(node.left); walkVal(node.right); break;
      case 'cross': case 'crossunder': walkVal(node.a); walkVal(node.b); break;
    }
  }

  function walkVal(node) {
    if (node?.type === 'func') {
      const period = node.args[0]?.value;
      if (period > 0) keys.add(`${node.name}_${period}`);
    }
  }

  walkCond(ast);
  return [...keys];
}

// ── Value resolver ──

/** Resolve a value AST node to a number using the candle's pre-computed _ind cache. */
function resolveValue(node, candle) {
  switch (node.type) {
    case 'num': return node.value;
    case 'field':
      switch (node.name) {
        case 'open':          return candle.open;
        case 'high':          return candle.high;
        case 'low':           return candle.low;
        case 'close':         return candle.close;
        case 'volume':        return candle.volume;
        case 'change':        return candle.return ?? NaN;
        case 'changepercent': return candle.return != null ? candle.return * 100 : NaN;
        case 'range':         return candle.high - candle.low;
        default:              return NaN;
      }
    case 'func': {
      const key = `${node.name}_${node.args[0]?.value}`;
      return (candle._ind && key in candle._ind) ? candle._ind[key] : NaN;
    }
    default: return NaN;
  }
}

// ── Condition tester ──

/**
 * Test a strategy AST node against a candle.
 * Returns true/false. Returns false when any required indicator is unavailable (NaN).
 */
function testCondition(ast, candle, history) {
  switch (ast.type) {
    case 'and': return testCondition(ast.left, candle, history) && testCondition(ast.right, candle, history);
    case 'or':  return testCondition(ast.left, candle, history) || testCondition(ast.right, candle, history);

    case 'cmp': {
      const lv = resolveValue(ast.left,  candle);
      const rv = resolveValue(ast.right, candle);
      if (!Number.isFinite(lv) || !Number.isFinite(rv)) return false;
      switch (ast.op) {
        case '>':  return lv >  rv;
        case '<':  return lv <  rv;
        case '>=': return lv >= rv;
        case '<=': return lv <= rv;
      }
      return false;
    }

    case 'cross':
    case 'crossunder': {
      // Find the most recent real (non-synthetic) candle before the current one
      let prevCandle = null;
      for (let j = history.length - 2; j >= 0; j--) {
        if (!history[j].isSynthetic) { prevCandle = history[j]; break; }
      }
      if (!prevCandle) return false;

      const a  = resolveValue(ast.a, candle);
      const b  = resolveValue(ast.b, candle);
      const pa = resolveValue(ast.a, prevCandle);
      const pb = resolveValue(ast.b, prevCandle);
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(pa) || !Number.isFinite(pb)) return false;

      return ast.type === 'cross'
        ? (pa <= pb && a > b)   // crossed above
        : (pa >= pb && a < b);  // crossed below
    }

    default: return false;
  }
}

// ── Validate / make helpers ──

/**
 * Validate buy/sell expression strings.
 * Returns an array of error strings (empty = valid).
 */
export function validateCustomStrategy({ buy, sell }) {
  const errors = [];
  for (const [label, expr] of [['Buy', buy], ['Sell', sell]]) {
    try {
      const ast  = parseStrategy(expr);
      const errs = validateAst(ast);
      for (const e of errs) errors.push(`${label}: ${e}`);
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
    }
  }
  return errors;
}

/**
 * Build a strategy function from { buy, sell } expression strings.
 * Supports full AND/OR logic, indicator functions, and cross/crossunder.
 */
export function makeCustomStrategy({ buy, sell }) {
  const buyAst  = parseStrategy(buy);
  const sellAst = parseStrategy(sell);
  const indicators = [...new Set([...extractIndicators(buyAst), ...extractIndicators(sellAst)])];

  function customStrategy(candle, history, position) {
    if (position.shares === 0 && testCondition(buyAst,  candle, history)) return 'BUY';
    if (position.shares >  0  && testCondition(sellAst, candle, history)) return 'SELL';
    return 'HOLD';
  }

  customStrategy.requiredIndicators = indicators;
  return customStrategy;
}

// ── JSON strategy ─────────────────────────────────────

/**
 * Validate a JSON strategy object (or JSON string).
 *
 * Format:
 *   { "buy": "close > sma(50) AND rsi(14) > 55", "sell": "crossunder(sma(20), sma(50))" }
 *   { "buy": ["cond1", "cond2"], "sell": ["cond1"] }   ← array: conditions AND-ed
 *
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

  if (!buyArr  || buyArr.length  === 0) errors.push('buy must be a non-empty string or array');
  if (!sellArr || sellArr.length === 0) errors.push('sell must be a non-empty string or array');

  for (const cond of [...(buyArr ?? []), ...(sellArr ?? [])]) {
    try {
      const errs = validateAst(parseStrategy(cond));
      for (const e of errs) errors.push(e);
    } catch (e) {
      errors.push(e.message);
    }
  }

  return errors;
}

/**
 * Build a strategy function from a JSON strategy object (or JSON string).
 * Array conditions are AND-ed; each string may itself contain AND/OR logic.
 * The returned function has a `.requiredIndicators` property so run() can
 * pre-compute them once for the full dataset before the main loop.
 */
export function makeJsonStrategy(input) {
  const obj      = typeof input === 'string' ? JSON.parse(input) : input;
  const toArray  = v => Array.isArray(v) ? v : [v];
  const buyAsts  = toArray(obj.buy).map(parseStrategy);
  const sellAsts = toArray(obj.sell).map(parseStrategy);
  const indicators = [...new Set([
    ...buyAsts.flatMap(extractIndicators),
    ...sellAsts.flatMap(extractIndicators),
  ])];

  function jsonStrategy(candle, history, position) {
    if (position.shares === 0) {
      if (buyAsts.every(ast => testCondition(ast, candle, history))) return 'BUY';
    } else {
      if (sellAsts.every(ast => testCondition(ast, candle, history))) return 'SELL';
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
 * Compute EMA from a closes array.
 * Seeded by SMA of the first `period` values, then Wilder-style smoothing.
 */
function calcEma(closes, period) {
  if (closes.length < period) return NaN;
  const alpha = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * alpha + ema * (1 - alpha);
  }
  return ema;
}

/** Return a year-week string key for weekly grouping, e.g. "2024-W03". */
function isoWeekKey(unixTimestamp) {
  const d  = new Date(unixTimestamp * 1000);
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const startW1 = new Date(jan4);
  startW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const week = Math.floor((d - startW1) / (7 * 86_400_000)) + 1;
  return `${d.getFullYear()}-W${week}`;
}

/**
 * Pre-compute a set of indicators for every candle in the array.
 * Results are attached as `candle._ind = { sma_50: …, ema_20: …, rsi_14: … }`.
 *
 * Supported key formats:
 *   sma_N   — simple moving average (daily)
 *   ema_N   — exponential moving average (daily, incremental)
 *   rsi_N   — RSI via Wilder's smoothing (daily)
 *   wsma_N  — simple moving average (weekly)
 *   wema_N  — exponential moving average (weekly)
 *
 * Legacy key formats (sma20, rsi14) are also handled for backward compatibility.
 * Only real (non-synthetic) candles contribute to rolling calculations.
 */
function computeIndicators(candles, indicators) {
  if (!indicators.length) return;

  const realCloses  = [];
  const emaStates   = {};  // key → { sum, count, ema, seeded }
  const weekCloses  = [];  // running weekly closes (last close of each week so far)
  let   weekKey     = null;

  for (const c of candles) {
    if (!c.isSynthetic) {
      realCloses.push(c.close);

      // Maintain rolling weekly closes: one entry per calendar week, updated each day
      const wk = isoWeekKey(c.time);
      if (wk !== weekKey) {
        weekCloses.push(c.close);
        weekKey = wk;
      } else {
        weekCloses[weekCloses.length - 1] = c.close;
      }
    }

    const ind = c._ind ?? {};

    for (const key of indicators) {
      // ── sma_N  (new format) ──
      const smaM = key.match(/^sma_(\d+)$/);
      if (smaM) {
        const p = parseInt(smaM[1], 10);
        ind[key] = realCloses.length >= p
          ? realCloses.slice(-p).reduce((s, v) => s + v, 0) / p
          : NaN;
        continue;
      }

      // ── ema_N  (new format) ──
      const emaM = key.match(/^ema_(\d+)$/);
      if (emaM) {
        const p = parseInt(emaM[1], 10);
        if (!c.isSynthetic) {
          let st = emaStates[key] ?? (emaStates[key] = { sum: 0, count: 0, ema: NaN, seeded: false });
          st.count++;
          if (!st.seeded) {
            st.sum += c.close;
            if (st.count >= p) { st.ema = st.sum / p; st.seeded = true; }
          } else {
            const alpha = 2 / (p + 1);
            st.ema = c.close * alpha + st.ema * (1 - alpha);
          }
          ind[key] = st.seeded ? st.ema : NaN;
        } else {
          ind[key] = emaStates[key]?.seeded ? emaStates[key].ema : NaN;
        }
        continue;
      }

      // ── rsi_N  (new format) ──
      const rsiM = key.match(/^rsi_(\d+)$/);
      if (rsiM) {
        ind[key] = calcRsi(realCloses, parseInt(rsiM[1], 10));
        continue;
      }

      // ── wsma_N ──
      const wsmaM = key.match(/^wsma_(\d+)$/);
      if (wsmaM) {
        const p = parseInt(wsmaM[1], 10);
        ind[key] = weekCloses.length >= p
          ? weekCloses.slice(-p).reduce((s, v) => s + v, 0) / p
          : NaN;
        continue;
      }

      // ── wema_N ──
      const wemaM = key.match(/^wema_(\d+)$/);
      if (wemaM) {
        ind[key] = calcEma(weekCloses, parseInt(wemaM[1], 10));
        continue;
      }

      // ── Legacy formats: sma20, rsi14 (backward compat) ──
      const legSmaM = key.match(/^sma(\d+)$/);
      if (legSmaM) {
        const p = parseInt(legSmaM[1], 10);
        ind[key] = realCloses.length >= p
          ? realCloses.slice(-p).reduce((s, v) => s + v, 0) / p
          : NaN;
        continue;
      }
      const legRsiM = key.match(/^rsi(\d+)$/);
      if (legRsiM) {
        ind[key] = calcRsi(realCloses, parseInt(legRsiM[1], 10));
        continue;
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
