import express from 'express';
import { existsSync, readFileSync } from 'fs';
import { execFileSync, spawnSync, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db.js';
import { run as runBacktest, ensureData, makeMAStrategy, makeCustomStrategy, validateCustomStrategy, makeJsonStrategy, validateJsonStrategy } from './backtest.js';


const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('[PSX] Starting...');

const app = express();
const PORT = process.env.PORT || 3000;
const PSX_API = 'https://psxterminal.com/api/ticks/REG';
const DPS_API = 'https://dps.psx.com.pk/timeseries/int';
const FETCH_TIMEOUT_MS = 5000;
const MAX_SYMBOLS = 10;

const INTERVAL_MS = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '1d':  86_400_000,
};

const RANGE_MS = {
  '1d':  86_400_000,
  '1w':  7   * 86_400_000,
  '1m':  30  * 86_400_000,
  '3m':  90  * 86_400_000,
  '1y':  365 * 86_400_000,
};

// ── Symbol search cache ───────────────────────────
const PSX_NAMES = {
  'ABL': 'Allied Bank Limited', 'ABOT': 'Abbott Laboratories Pakistan',
  'ACPL': 'Attock Cement Pakistan', 'AGHA': 'Agha Steel Industries',
  'AGTL': 'Al-Ghazi Tractors Limited', 'AHCL': 'Arif Habib Corporation Limited',
  'AKBL': 'Askari Bank Limited', 'ANL': 'Azgard Nine Limited',
  'APL': 'Attock Petroleum Limited', 'ASTL': 'Amreli Steels Limited',
  'ATRL': 'Attock Refinery Limited', 'AVN': 'Avanceon Limited',
  'BAFL': 'Bank Alfalah Limited', 'BAHL': 'Bank AL Habib Limited',
  'BOP': 'Bank of Punjab', 'BYCO': 'Byco Petroleum Pakistan',
  'COLG': 'Colgate-Palmolive Pakistan', 'DAWH': 'Dawood Hercules Corporation',
  'DGKC': 'D.G. Khan Cement Company', 'DSFL': 'Dewan Sugar Mills',
  'EFERT': 'Engro Fertilizers Limited', 'ENGRO': 'Engro Corporation',
  'EPCL': 'Engro Polymer & Chemicals', 'FABL': 'Faysal Bank Limited',
  'FATIMA': 'Fatima Fertilizer Company', 'FCCL': 'Fauji Cement Company',
  'FFC': 'Fauji Fertilizer Company', 'FEROZ': 'Ferozsons Laboratories',
  'FFBL': 'Fauji Fertilizer Bin Qasim', 'GATM': 'Ghandhara Automobiles',
  'GHNL': 'Ghandhara Nissan Limited', 'GLAXO': 'GlaxoSmithKline Pakistan',
  'HCAR': 'Honda Atlas Cars Pakistan', 'HBL': 'Habib Bank Limited',
  'HINOON': 'Highnoon Laboratories', 'HUBC': 'Hub Power Company',
  'ICI': 'ICI Pakistan Limited', 'INDU': 'Indus Motor Company',
  'ISL': 'International Steels Limited', 'JDWS': 'JDW Sugar Mills',
  'JSBL': 'JS Bank Limited', 'KAPCO': 'Kot Addu Power Company',
  'KEL': 'K-Electric Limited', 'KOHC': 'Kohat Cement Company',
  'KTML': 'Kohinoor Textile Mills', 'LOTCHEM': 'Lotte Chemical Pakistan',
  'LUCK': 'Lucky Cement', 'MARI': 'Mari Petroleum Company',
  'MCB': 'MCB Bank Limited', 'MEBL': 'Meezan Bank Limited',
  'MLCF': 'Maple Leaf Cement Factory', 'MTL': 'Millat Tractors Limited',
  'MUGHAL': 'Mughal Iron & Steel Industries', 'NBP': 'National Bank of Pakistan',
  'NCPL': 'Nishat Chunian Power Limited', 'NESTLE': 'Nestle Pakistan',
  'NETSOL': 'NetSol Technologies', 'NML': 'Nishat Mills Limited',
  'NRL': 'National Refinery Limited', 'OGDC': 'Oil & Gas Development Company',
  'PAEL': 'Pak Elektron Limited', 'PAKT': 'Pakistan Tobacco Company',
  'PIOC': 'Pioneer Cement', 'PMCL': 'Pakistan Mobile Communications (Jazz)',
  'PNSC': 'Pakistan National Shipping Corporation', 'POL': 'Pakistan Oilfields Limited',
  'PPL': 'Pakistan Petroleum Limited', 'PRL': 'Pakistan Refinery Limited',
  'PSO': 'Pakistan State Oil', 'PSMC': 'Pak Suzuki Motor Company',
  'PTC': 'Pakistan Telecommunication Company', 'SEARL': 'The Searle Company',
  'SHFA': 'Shifa International Hospitals', 'SIEM': 'Siemens Pakistan',
  'SILK': 'Silkbank Limited', 'SMBL': 'Summit Bank Limited',
  'SNBL': 'Soneri Bank Limited', 'SNGP': 'Sui Northern Gas Pipelines',
  'SPWL': 'Sapphire Wind Power Company', 'SRVI': 'Service Industries Limited',
  'SSGC': 'Sui Southern Gas Company', 'SYS': 'Systems Limited',
  'THALL': 'Thal Limited', 'TREET': 'Treet Corporation',
  'TRG': 'TRG Pakistan Limited', 'UBL': 'United Bank Limited',
  'UNITY': 'Unity Foods Limited', 'WAVES': 'Waves Singer Pakistan',
};

let symbolCache = [];
let symbolCacheTime = 0;
const SYMBOL_CACHE_TTL_MS = 60 * 60 * 1000; // refresh hourly

async function refreshSymbolCache() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://psxterminal.com/api/symbols', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (Array.isArray(json.data) && json.data.length > 0) {
      symbolCache = json.data;
      symbolCacheTime = Date.now();
      console.log(`[PSX] Symbol cache loaded: ${symbolCache.length} symbols`);
    }
  } catch (err) {
    clearTimeout(timer);
    console.warn('[PSX] Could not load symbol list:', err.message);
    // Fall back to names we already know
    if (symbolCache.length === 0) symbolCache = Object.keys(PSX_NAMES);
  }
}

console.log('[PSX] Loading data...');
console.log('[PSX] Calling refreshSymbolCache...');
refreshSymbolCache().then(() => {
  console.log('[PSX] Symbol cache ready');
}).catch(err => {
  console.error('[PSX] Symbol cache init failed:', err.message);
});
setInterval(refreshSymbolCache, SYMBOL_CACHE_TTL_MS);

async function fetchTimeseries(symbol) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${DPS_API}/${symbol}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
  } catch (err) {
    clearTimeout(timer);
    console.error(`[PSX] fetchTimeseries ${symbol}: ${err.message}`);
    return [];
  }
}

function buildCandles(ticks, intervalMs, sinceMs) {
  // 1. Validate, filter to range, then sort ascending by timestamp.
  //    Sorting BEFORE bucketing is critical: open = first-by-time price,
  //    close = last-by-time price. Without this they are arbitrary.
  const sorted = ticks
    .filter(t =>
      Array.isArray(t) && t.length >= 3 &&
      Number.isFinite(t[0]) && Number.isFinite(t[1]) && Number.isFinite(t[2]) &&
      t[0] * 1000 >= sinceMs
    )
    .sort((a, b) => a[0] - b[0]);

  console.log(`[PSX] buildCandles: ${ticks.length} raw ticks → ${sorted.length} valid in range`);

  const candles = new Map();

  for (const [ts, price, volume] of sorted) {
    const bucketTs = Math.floor((ts * 1000) / intervalMs) * intervalMs;

    if (!candles.has(bucketTs)) {
      candles.set(bucketTs, { time: bucketTs / 1000, open: price, high: price, low: price, close: price, volume });
    } else {
      const c = candles.get(bucketTs);
      if (price > c.high) c.high = price;
      if (price < c.low)  c.low  = price;
      c.close   = price;       // last tick in sorted order = correct close
      c.volume += volume;
    }
  }

  const result = [...candles.values()].sort((a, b) => a.time - b.time);

  if (result.length > 0) {
    console.log(`[PSX] buildCandles: ${result.length} candles generated`);
    console.log(`[PSX] buildCandles sample[0]:`, JSON.stringify(result[0]));
  } else {
    console.warn('[PSX] buildCandles: no candles produced');
  }

  return result;
}

async function fetchSymbol(symbol) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${PSX_API}/${symbol}`, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();

    const tick = json?.data;

    if (!tick) throw new Error('empty response');

    const price = parseFloat(tick.price);
    const change = parseFloat(tick.change);
    const timestamp = tick.timestamp;

    if (isNaN(price)) throw new Error('missing price field');

    return { symbol, price, change: isNaN(change) ? null : change, timestamp };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    console.error(`[PSX] Failed to fetch ${symbol}: ${reason}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

app.use(express.json());

const round2 = n => Math.round(n * 100) / 100;

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/prices', async (req, res) => {
  const raw = req.query.symbols ?? '';

  const validSymbols = raw
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length > 0 && /^[A-Z0-9]+$/.test(s))
    .slice(0, MAX_SYMBOLS);

  if (validSymbols.length === 0) {
    return res.status(400).json({ error: 'No valid symbols provided' });
  }

  const results = await Promise.all(validSymbols.map(fetchSymbol));
  const data = results.filter(Boolean);

  res.json({
    data,
    count: data.length,
    requested: validSymbols.length,
    serverTime: Math.floor(Date.now() / 1000),
  });
});

app.get('/search', (req, res) => {
  const q = (req.query.query ?? '').trim().toUpperCase();
  if (!q) return res.json([]);

  const results = symbolCache
    .filter(s => s.includes(q))
    .sort((a, b) => {
      // Prefix matches rank first
      const aP = a.startsWith(q), bP = b.startsWith(q);
      if (aP !== bP) return aP ? -1 : 1;
      return a.localeCompare(b);
    })
    .slice(0, 10)
    .map(symbol => ({ symbol, name: PSX_NAMES[symbol] ?? symbol }));

  res.json(results);
});

// GET /portfolio/:type — load saved positions
app.get('/portfolio/:type', (req, res) => {
  const { type } = req.params;
  if (type !== 'paper' && type !== 'real')
    return res.status(400).json({ error: 'portfolioType must be "paper" or "real"' });

  const rows = db
    .prepare('SELECT id, symbol, quantity, buyPrice FROM positions WHERE portfolioType = ? ORDER BY id ASC')
    .all(type);

  res.json(rows);
});

// POST /portfolio/:type — atomically replace all positions for type
app.post('/portfolio/:type', (req, res) => {
  const { type } = req.params;
  if (type !== 'paper' && type !== 'real')
    return res.status(400).json({ error: 'portfolioType must be "paper" or "real"' });

  const body = req.body;
  if (!Array.isArray(body))
    return res.status(400).json({ error: 'Request body must be a JSON array' });

  const validated = body
    .filter(p =>
      typeof p.symbol === 'string' && /^[A-Z0-9]+$/i.test(p.symbol.trim()) &&
      typeof p.quantity === 'number' && p.quantity > 0 &&
      typeof p.buyPrice === 'number' && p.buyPrice > 0
    )
    .map(p => ({ symbol: p.symbol.trim().toUpperCase(), quantity: p.quantity, buyPrice: p.buyPrice }));

  const replace = db.transaction((positions, portfolioType) => {
    db.prepare('DELETE FROM positions WHERE portfolioType = ?').run(portfolioType);
    const insert = db.prepare(
      'INSERT INTO positions (symbol, quantity, buyPrice, portfolioType) VALUES (?, ?, ?, ?)'
    );
    for (const p of positions) insert.run(p.symbol, p.quantity, p.buyPrice, portfolioType);
    return db
      .prepare('SELECT id, symbol, quantity, buyPrice FROM positions WHERE portfolioType = ? ORDER BY id ASC')
      .all(portfolioType);
  });

  try {
    res.json(replace(validated, type));
  } catch (err) {
    console.error('[PSX] DB error:', err.message);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// POST /portfolio — calculate P&L (stateless, no persistence)
app.post('/portfolio', async (req, res) => {
  const body = req.body;

  if (!Array.isArray(body) || body.length === 0) {
    return res.status(400).json({ error: 'No valid positions provided. The request body was empty or contained no valid entries.' });
  }

  const validPositions = body.filter(p =>
    typeof p.symbol === 'string' &&
    /^[A-Z0-9]+$/i.test(p.symbol.trim()) &&
    typeof p.quantity === 'number' && p.quantity > 0 &&
    typeof p.buyPrice === 'number' && p.buyPrice > 0
  ).map(p => ({ ...p, symbol: p.symbol.trim().toUpperCase() }));

  if (validPositions.length === 0) {
    return res.status(400).json({ error: 'No valid positions provided. The request body was empty or contained no valid entries.' });
  }

  const results = await Promise.all(validPositions.map(p => fetchSymbol(p.symbol)));

  const positions = validPositions
    .map((p, i) => {
      const tick = results[i];
      if (!tick) return null;
      const currentPrice = tick.price;
      return {
        symbol: p.symbol,
        quantity: p.quantity,
        buyPrice: p.buyPrice,
        currentPrice,
        value: round2(currentPrice * p.quantity),
        profit: round2((currentPrice - p.buyPrice) * p.quantity),
      };
    })
    .filter(Boolean);

  const totalValue = round2(positions.reduce((sum, p) => sum + p.value, 0));
  const totalProfit = round2(positions.reduce((sum, p) => sum + p.profit, 0));

  res.json({ positions, totalValue, totalProfit });
});

app.get('/history/:symbol', async (req, res) => {
  const symbol = req.params.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol))
    return res.status(400).json({ error: 'Invalid symbol' });

  const intervalKey = req.query.interval ?? '1m';
  const rangeKey    = req.query.range    ?? '1d';

  const intervalMs = INTERVAL_MS[intervalKey];
  const rangeMs    = RANGE_MS[rangeKey];

  if (!intervalMs)
    return res.status(400).json({ error: `Invalid interval. Use: ${Object.keys(INTERVAL_MS).join(', ')}` });
  if (!rangeMs)
    return res.status(400).json({ error: `Invalid range. Use: ${Object.keys(RANGE_MS).join(', ')}` });

  const ticks = await fetchTimeseries(symbol);
  if (ticks.length === 0) return res.json([]);

  const sinceMs = Date.now() - rangeMs;
  const candles = buildCandles(ticks, intervalMs, sinceMs);
  res.json(candles);
});

// GET /history-daily/:symbol — serve locally stored daily OHLC data
app.get('/history-daily/:symbol', (req, res) => {
  const symbol = req.params.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol))
    return res.status(400).json({ error: 'Invalid symbol' });

  const filePath = join(__dirname, 'data', `${symbol}.json`);

  if (!existsSync(filePath))
    return res.json([]);

  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error(`[PSX] /history-daily/${symbol}:`, err.message);
    res.status(500).json({ error: 'Failed to read data file' });
  }
});

// POST /api/fetch-data — scrape + clean data for a symbol
app.post('/api/fetch-data', (req, res) => {
  const { symbol } = req.body ?? {};
  if (!symbol || !/^[A-Z0-9]+$/i.test(symbol))
    return res.status(400).json({ error: 'Invalid or missing symbol' });

  const sym = symbol.toUpperCase();
  try {
    ensureData(sym);
    // Return the last candle date so the UI can confirm freshness
    const dataPath = join(__dirname, 'data', `${sym}.json`);
    const candles  = JSON.parse(readFileSync(dataPath, 'utf8'));
    const last     = candles.at(-1);
    const lastDate = last ? new Date(last.time * 1000).toISOString().slice(0, 10) : null;
    res.json({ ok: true, symbol: sym, candles: candles.length, lastDate });
  } catch (err) {
    console.error(`[PSX] /api/fetch-data error for ${sym}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /backtest — run a backtest and return results
app.post('/backtest', (req, res) => {
  const {
    symbol,
    strategy     = 'ma',
    fast         = 5,
    slow         = 20,
    cash         = 10_000,
    positionSize = 0.5,
    years        = 10,
  } = req.body ?? {};

  if (!symbol || !/^[A-Z0-9]+$/i.test(symbol))
    return res.status(400).json({ error: 'Invalid or missing symbol' });

  const {
    buyExpr,
    sellExpr,
    jsonStrategy,
  } = req.body ?? {};

  let strategyFn;

  if (strategy === 'ma') {
    const fastN = Number(fast);
    const slowN = Number(slow);
    if (!Number.isFinite(fastN) || !Number.isFinite(slowN) || fastN >= slowN || fastN < 1)
      return res.status(400).json({ error: 'fast must be a positive integer less than slow' });
    strategyFn = makeMAStrategy(fastN, slowN);

  } else if (strategy === 'custom') {
    if (!buyExpr || !sellExpr)
      return res.status(400).json({ error: 'Custom strategy requires buyExpr and sellExpr' });
    const errs = validateCustomStrategy({ buy: buyExpr, sell: sellExpr });
    if (errs.length) return res.status(400).json({ error: errs.join(' | ') });
    strategyFn = makeCustomStrategy({ buy: buyExpr, sell: sellExpr });

  } else if (strategy === 'json') {
    if (!jsonStrategy)
      return res.status(400).json({ error: 'JSON strategy requires a jsonStrategy field' });
    const errs = validateJsonStrategy(jsonStrategy);
    if (errs.length) return res.status(400).json({ error: errs.join(' | ') });
    strategyFn = makeJsonStrategy(jsonStrategy);

  } else {
    return res.status(400).json({ error: `Unknown strategy "${strategy}". Supported: ma, custom, json` });
  }

  try {
    const result = runBacktest(
      symbol.toUpperCase(),
      strategyFn,
      { startCash: Number(cash) || 10_000, positionSize: Number(positionSize) || 0.5, years: Number(years) || 10 }
    );
    res.json(result);
  } catch (err) {
    const status = err.message.includes('No data file') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/analyze/:symbol — Python-powered analysis engine
app.get('/api/analyze/:symbol', (req, res) => {
  const symbol = req.params.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol))
    return res.status(400).json({ error: 'Invalid symbol' });

  const scriptPath = join(__dirname, 'analyze.py');
  if (!existsSync(scriptPath))
    return res.status(500).json({ error: 'analyze.py not found' });

  const result = spawnSync('python3', [scriptPath, symbol], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  if (result.error) {
    console.error('[PSX] analyze.py spawn error:', result.error.message);
    return res.status(500).json({ error: 'Analysis engine unavailable. Is Python 3 installed?' });
  }

  if (result.status !== 0) {
    console.error('[PSX] analyze.py stderr:', result.stderr);
    return res.status(500).json({ error: 'Analysis engine crashed' });
  }

  try {
    const data = JSON.parse(result.stdout);
    if (data.error) return res.status(400).json(data);
    res.json(data);
  } catch {
    res.status(500).json({ error: 'Invalid response from analysis engine' });
  }
});

// Return JSON for any unhandled errors (e.g. body-parser SyntaxError)
app.use((err, req, res, _next) => {
  console.error('[PSX] Error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

console.log('[PSX] Initializing server...');
console.log('[PSX] About to start server...');

function openBrowser(url) {
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', url]);
  } else if (process.platform === 'darwin') {
    execFile('open', [url]);
  } else {
    execFile('xdg-open', [url]);
  }
}

const server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`[PSX] Server running at ${url}`);
  openBrowser(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[PSX] Error: Port ${PORT} is already in use. Stop the existing process or set PORT=<other> and retry.`);
  } else {
    console.error('[PSX] Server failed to start:', err.message);
  }
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('[PSX] Unhandled Rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[PSX] Uncaught Exception:', err);
});
