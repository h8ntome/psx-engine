#!/usr/bin/env python3
"""
PSX Analysis Engine
Reads data/SYMBOL.json and returns structured JSON with:
  - Performance metrics
  - Moving averages & trend
  - RSI
  - Support / resistance
  - Volume analysis
  - Signal generation
"""

import json
import sys
import math
from pathlib import Path


# ── Indicator helpers ─────────────────────────────────────────────────────────

def compute_sma(prices, period):
    """Simple moving average — returns list aligned to prices (leading Nones)."""
    n = len(prices)
    if n < period:
        return [None] * n
    result = [None] * (period - 1)
    window_sum = sum(prices[:period])
    result.append(window_sum / period)
    for i in range(period, n):
        window_sum += prices[i] - prices[i - period]
        result.append(window_sum / period)
    return result


def compute_rsi(prices, period=14):
    """Wilder-smoothed RSI — returns list aligned to prices (leading Nones)."""
    n = len(prices)
    if n < period + 1:
        return [None] * n

    changes = [prices[i] - prices[i - 1] for i in range(1, n)]
    gains   = [max(0.0, c) for c in changes]
    losses  = [max(0.0, -c) for c in changes]

    result = [None] * period  # first `period` candles have no RSI

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    def to_rsi(ag, al):
        if al == 0:
            return 100.0
        return 100.0 - 100.0 / (1.0 + ag / al)

    result.append(to_rsi(avg_gain, avg_loss))

    for i in range(period, len(changes)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        result.append(to_rsi(avg_gain, avg_loss))

    return result


def last_valid(lst):
    """Return the last non-None value in a list, or None."""
    for v in reversed(lst):
        if v is not None:
            return v
    return None


def find_support_resistance(candles, window=5, tolerance=0.018, max_levels=8):
    """
    Detect local pivot highs and lows, then cluster nearby ones.
    Returns up to max_levels price levels sorted ascending.
    """
    highs  = [c['high']  for c in candles]
    lows   = [c['low']   for c in candles]
    n      = len(highs)
    raw    = []

    for i in range(window, n - window):
        # local high
        if all(highs[i] >= highs[i - j] and highs[i] >= highs[i + j] for j in range(1, window + 1)):
            raw.append(highs[i])
        # local low
        if all(lows[i] <= lows[i - j] and lows[i] <= lows[i + j] for j in range(1, window + 1)):
            raw.append(lows[i])

    if not raw:
        return []

    raw.sort()
    clusters = []

    for level in raw:
        merged = False
        for cl in clusters:
            if abs(level - cl['center']) / cl['center'] < tolerance:
                cl['values'].append(level)
                cl['center'] = sum(cl['values']) / len(cl['values'])
                cl['strength'] += 1
                merged = True
                break
        if not merged:
            clusters.append({'center': level, 'values': [level], 'strength': 1})

    clusters.sort(key=lambda x: -x['strength'])
    top = clusters[:max_levels]
    return sorted(round(c['center'], 2) for c in top)


# ── Main analysis ─────────────────────────────────────────────────────────────

def analyze(symbol):
    data_path = Path(__file__).parent / 'data' / f'{symbol}.json'
    if not data_path.exists():
        return {'error': f'No data file for {symbol}. Use "Fetch Data" in Backtest first.'}

    with open(data_path, 'r', encoding='utf-8') as f:
        candles = json.load(f)

    if not isinstance(candles, list) or len(candles) < 21:
        return {'error': 'Insufficient data — need at least 21 daily candles.'}

    prices  = [c['close']  for c in candles]
    highs   = [c['high']   for c in candles]
    lows    = [c['low']    for c in candles]
    volumes = [c['volume'] for c in candles]

    # ── Performance metrics ───────────────────────────────────────────────────
    first_price = prices[0]
    last_price  = prices[-1]
    total_return = (last_price - first_price) / first_price

    first_ts = candles[0]['time']
    last_ts  = candles[-1]['time']
    years    = (last_ts - first_ts) / (365.25 * 86400)

    cagr = None
    if years >= 0.5 and first_price > 0:
        cagr = (last_price / first_price) ** (1.0 / years) - 1.0

    # Max drawdown (peak-to-trough on close prices)
    peak   = prices[0]
    max_dd = 0.0
    for p in prices:
        if p > peak:
            peak = p
        dd = (peak - p) / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd

    # Annualised volatility (252 trading days)
    daily_rets = [(prices[i] - prices[i - 1]) / prices[i - 1]
                  for i in range(1, len(prices)) if prices[i - 1] != 0]
    volatility = None
    if len(daily_rets) >= 5:
        mu  = sum(daily_rets) / len(daily_rets)
        var = sum((r - mu) ** 2 for r in daily_rets) / len(daily_rets)
        volatility = math.sqrt(var * 252)

    performance = {
        'totalReturn':  round(total_return, 4),
        'cagr':         round(cagr, 4)       if cagr       is not None else None,
        'maxDrawdown':  round(max_dd, 4),
        'volatility':   round(volatility, 4) if volatility is not None else None,
        'firstPrice':   round(first_price, 2),
        'lastPrice':    round(last_price, 2),
        'dataPoints':   len(candles),
        'years':        round(years, 2),
    }

    # ── Moving averages ───────────────────────────────────────────────────────
    sma20_list  = compute_sma(prices, 20)
    sma50_list  = compute_sma(prices, 50)
    sma200_list = compute_sma(prices, 200)

    sma20  = last_valid(sma20_list)
    sma50  = last_valid(sma50_list)
    sma200 = last_valid(sma200_list)

    # Trend classification (200 MA primary, fall back to 50 MA)
    if sma200 is not None:
        trend = 'bullish' if last_price > sma200 else 'bearish'
    elif sma50 is not None:
        trend = 'bullish' if last_price > sma50 else 'bearish'
    else:
        trend = 'neutral'

    indicators = {
        'sma20':  round(sma20,  2) if sma20  is not None else None,
        'sma50':  round(sma50,  2) if sma50  is not None else None,
        'sma200': round(sma200, 2) if sma200 is not None else None,
        'trend':  trend,
    }

    # ── RSI ───────────────────────────────────────────────────────────────────
    rsi_list = compute_rsi(prices, 14)
    rsi_val  = last_valid(rsi_list)

    if rsi_val is not None:
        if rsi_val > 70:
            rsi_state = 'overbought'
        elif rsi_val < 30:
            rsi_state = 'oversold'
        else:
            rsi_state = 'neutral'
    else:
        rsi_state = None

    indicators['rsi']      = round(rsi_val, 1) if rsi_val is not None else None
    indicators['rsiState'] = rsi_state

    # ── Support / Resistance ──────────────────────────────────────────────────
    all_levels       = find_support_resistance(candles)
    support_levels   = sorted([l for l in all_levels if l < last_price], reverse=True)[:4]
    resistance_levels = sorted([l for l in all_levels if l > last_price])[:4]

    indicators['supportLevels']    = support_levels
    indicators['resistanceLevels'] = resistance_levels

    # ── Volume analysis ───────────────────────────────────────────────────────
    avg_vol     = sum(volumes) / len(volumes)
    recent_vol  = volumes[-1]
    spike       = recent_vol > avg_vol * 2.0

    recent_20   = volumes[-20:]
    recent_avg  = sum(recent_20) / len(recent_20)
    if recent_avg > avg_vol * 1.1:
        vol_trend = 'rising'
    elif recent_avg < avg_vol * 0.9:
        vol_trend = 'falling'
    else:
        vol_trend = 'normal'

    # Count spikes in last 60 candles
    last_60     = volumes[-60:]
    spike_count = sum(1 for v in last_60 if v > avg_vol * 2.0)

    volume = {
        'current':    int(recent_vol),
        'average':    int(avg_vol),
        'spike':      spike,
        'trend':      vol_trend,
        'spikesLast60': spike_count,
    }

    # ── Signal generation ─────────────────────────────────────────────────────
    score   = 0
    reasons = []

    if sma50 is not None:
        if last_price > sma50:
            score += 1
            reasons.append('price above SMA50')
        else:
            score -= 1
            reasons.append('price below SMA50')

    if sma200 is not None:
        if last_price > sma200:
            score += 1
            reasons.append('price above SMA200')
        else:
            score -= 1
            reasons.append('price below SMA200')

    if sma20 is not None and sma50 is not None:
        if sma20 > sma50:
            score += 1
            reasons.append('SMA20 > SMA50 (golden zone)')
        else:
            score -= 1
            reasons.append('SMA20 < SMA50 (death zone)')

    if rsi_val is not None:
        if rsi_val < 35:
            score += 1
            reasons.append(f'RSI oversold ({rsi_val:.1f})')
        elif rsi_val > 65:
            score -= 1
            reasons.append(f'RSI overbought ({rsi_val:.1f})')
        # neutral RSI contributes nothing

    if score >= 2:
        signal = 'BUY'
    elif score <= -2:
        signal = 'SELL'
    else:
        signal = 'HOLD'

    signals = {
        'signal':  signal,
        'score':   score,
        'reasons': reasons,
    }

    return {
        'symbol':      symbol,
        'performance': performance,
        'indicators':  indicators,
        'volume':      volume,
        'signals':     signals,
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: analyze.py <SYMBOL>'}))
        sys.exit(1)

    raw_symbol = sys.argv[1].strip().upper()
    if not raw_symbol or not raw_symbol.replace('-', '').isalnum():
        print(json.dumps({'error': 'Invalid symbol'}))
        sys.exit(1)

    result = analyze(raw_symbol)
    print(json.dumps(result))
