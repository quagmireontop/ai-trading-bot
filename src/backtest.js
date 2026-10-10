// Backtests simple, rule-based strategies on daily price history.
// Long-only, one position per symbol, signals act at the NEXT day's open so the
// test never uses information it wouldn't have had at the time.
import * as broker from './broker.js';

const sma = (arr, i, n) => {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += arr[k];
  return s / n;
};

function rsiSeries(closes, n) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= n) {
      gain += g; loss += l;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

// Each strategy returns, for every day, true (want to hold), false (want to be out) or null (no opinion yet).
export const STRATEGIES = {
  sma_crossover: {
    name: 'Moving-average crossover',
    description: 'Hold while the fast moving average is above the slow one.',
    params: { fast: { default: 20, min: 2, max: 200 }, slow: { default: 50, min: 5, max: 400 } },
    signals(closes, { fast, slow }) {
      return closes.map((_, i) => {
        const f = sma(closes, i, fast), s = sma(closes, i, slow);
        return f == null || s == null ? null : f > s;
      });
    },
  },
  rsi: {
    name: 'RSI mean reversion',
    description: 'Buy when RSI drops below the oversold level, sell when it rises above the overbought level.',
    params: { period: { default: 14, min: 2, max: 50 }, oversold: { default: 30, min: 5, max: 50 }, overbought: { default: 70, min: 50, max: 95 } },
    signals(closes, { period, oversold, overbought }) {
      const r = rsiSeries(closes, period);
      let holding = false;
      return r.map((v) => {
        if (v == null) return null;
        if (!holding && v < oversold) holding = true;
        else if (holding && v > overbought) holding = false;
        return holding;
      });
    },
  },
  momentum: {
    name: 'Momentum',
    description: 'Hold while the price is up more than the threshold over the lookback period (like the live bot\'s price signal).',
    params: { lookback: { default: 20, min: 2, max: 250 }, threshold: { default: 0, min: -20, max: 50 } },
    signals(closes, { lookback, threshold }) {
      return closes.map((c, i) => (i < lookback ? null : ((c - closes[i - lookback]) / closes[i - lookback]) * 100 > threshold));
    },
  },
  breakout: {
    name: 'Breakout',
    description: 'Buy when price closes at a new N-day high, sell when it closes at a new M-day low.',
    params: { entry: { default: 20, min: 5, max: 250 }, exit: { default: 10, min: 2, max: 250 } },
    signals(closes, { entry, exit }) {
      let holding = false;
      return closes.map((c, i) => {
        if (i < Math.max(entry, exit)) return null;
        const prevHigh = Math.max(...closes.slice(i - entry, i));
        const prevLow = Math.min(...closes.slice(i - exit, i));
        if (!holding && c > prevHigh) holding = true;
        else if (holding && c < prevLow) holding = false;
        return holding;
      });
    },
  },
};

function resolveParams(strategy, given = {}) {
  const out = {};
  for (const [k, spec] of Object.entries(strategy.params)) {
    const v = given[k] === undefined || given[k] === '' ? spec.default : Number(given[k]);
    if (!Number.isFinite(v) || v < spec.min || v > spec.max) throw new Error(`${k} must be between ${spec.min} and ${spec.max}`);
    out[k] = v;
  }
  return out;
}

function metrics(equity, startCapital, days) {
  const end = equity.at(-1);
  const years = days / 252;
  let peak = equity[0], maxDd = 0;
  const rets = [];
  for (let i = 1; i < equity.length; i++) {
    peak = Math.max(peak, equity[i]);
    maxDd = Math.max(maxDd, (peak - equity[i]) / peak);
    rets.push(equity[i] / equity[i - 1] - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1));
  return {
    endingValue: +end.toFixed(2),
    totalReturnPct: +(((end - startCapital) / startCapital) * 100).toFixed(2),
    annualReturnPct: years > 0 ? +((Math.pow(end / startCapital, 1 / years) - 1) * 100).toFixed(2) : null,
    maxDrawdownPct: +(maxDd * 100).toFixed(2),
    sharpe: sd > 0 ? +((mean / sd) * Math.sqrt(252)).toFixed(2) : null,
  };
}

export function simulate(bars, strategyKey, params = {}, { capital = 10000, feeBps = 5 } = {}) {
  const strategy = STRATEGIES[strategyKey];
  if (!strategy) throw new Error(`Unknown strategy "${strategyKey}". Options: ${Object.keys(STRATEGIES).join(', ')}`);
  const p = resolveParams(strategy, params);
  if (bars.length < 30) throw new Error('Not enough price history to backtest (need at least 30 days)');
  const closes = bars.map((b) => b.c);
  const want = strategy.signals(closes, p);
  const fee = feeBps / 10000;

  let cash = capital, shares = 0, entry = null;
  const trades = [];
  const equity = [];
  for (let i = 0; i < bars.length; i++) {
    // Act at today's open on yesterday's signal.
    if (i > 0) {
      const open = bars[i].o ?? bars[i - 1].c;
      if (want[i - 1] === true && shares === 0) {
        shares = (cash * (1 - fee)) / open;
        cash = 0;
        entry = { date: bars[i].t, price: open };
      } else if (want[i - 1] === false && shares > 0) {
        cash = shares * open * (1 - fee);
        trades.push({ entryDate: entry.date.slice(0, 10), exitDate: bars[i].t.slice(0, 10), entryPrice: +entry.price.toFixed(2), exitPrice: +open.toFixed(2), returnPct: +(((open * (1 - fee) ** 2) / entry.price - 1) * 100).toFixed(2) });
        shares = 0;
      }
    }
    equity.push(cash + shares * bars[i].c);
  }
  const openTrade = shares > 0 ? { entryDate: entry.date.slice(0, 10), entryPrice: +entry.price.toFixed(2), returnPct: +((closes.at(-1) / entry.price - 1) * 100).toFixed(2) } : null;

  const bh = bars.map((b) => (capital * (1 - fee) * b.c) / bars[0].c);
  const wins = trades.filter((t) => t.returnPct > 0).length;
  const daysInMarket = want.filter(Boolean).length;
  return {
    strategy: strategyKey,
    strategyName: strategy.name,
    params: p,
    from: bars[0].t.slice(0, 10),
    to: bars.at(-1).t.slice(0, 10),
    tradingDays: bars.length,
    capital,
    result: { ...metrics(equity, capital, bars.length), trades: trades.length, winRatePct: trades.length ? +((wins / trades.length) * 100).toFixed(1) : null, timeInMarketPct: +((daysInMarket / bars.length) * 100).toFixed(1) },
    buyAndHold: metrics(bh, capital, bars.length),
    trades: trades.slice(-50),
    openTrade,
    // Downsampled curves for charting (max ~250 points).
    curve: bars
      .map((b, i) => ({ t: b.t.slice(0, 10), strategy: +equity[i].toFixed(2), buyAndHold: +bh[i].toFixed(2) }))
      .filter((_, i) => i % Math.ceil(bars.length / 250) === 0 || i === bars.length - 1),
  };
}

export async function runBacktest({ symbol, strategy = 'sma_crossover', params = {}, days = 500, capital = 10000, feeBps = 5 }) {
  if (!symbol) throw new Error('symbol is required');
  days = Math.max(60, Math.min(2500, Math.round(Number(days) || 500)));
  const bars = await broker.getBars(symbol, days);
  return { symbol: symbol.toUpperCase(), ...simulate(bars, strategy, params, { capital: Number(capital) || 10000, feeBps: Number(feeBps) || 0 }) };
}

// Runs every strategy with default settings on one symbol, best first.
export async function compareStrategies({ symbol, days = 500, capital = 10000 }) {
  const bars = await broker.getBars(symbol, Math.max(60, Math.min(2500, Number(days) || 500)));
  const rows = Object.keys(STRATEGIES).map((key) => {
    const r = simulate(bars, key, {}, { capital });
    return { strategy: key, name: r.strategyName, params: r.params, ...r.result };
  });
  const bh = simulate(bars, 'momentum', {}, { capital }).buyAndHold;
  return { symbol: symbol.toUpperCase(), from: bars[0].t.slice(0, 10), to: bars.at(-1).t.slice(0, 10), buyAndHold: bh, strategies: rows.sort((a, b) => b.totalReturnPct - a.totalReturnPct) };
}

export function listStrategies() {
  return Object.entries(STRATEGIES).map(([key, s]) => ({ key, name: s.name, description: s.description, params: s.params }));
}
