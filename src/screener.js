// Stock screener + portfolio backtest.
//   q:  "rsi_14 < 30 AND above_sma_200 AND return_20d > -10"
// A scan evaluates q for every stock in a universe using only data up to a given day.
// The backtest repeats that scan on each rebalance date, buys the top N picks in equal
// weights at the next day's open, holds until the next rebalance, and compounds.
import { config } from './config.js';
import * as broker from './broker.js';

// Large US companies (roughly the S&P 100). Today's list, so backtests carry
// survivorship bias: companies that collapsed or were delisted aren't in it.
export const UNIVERSES = {
  large_caps: 'AAPL MSFT NVDA AMZN GOOGL META BRK.B AVGO TSLA JPM LLY V UNH XOM MA JNJ PG HD COST ABBV MRK CVX WMT KO PEP BAC ADBE CRM NFLX AMD TMO LIN MCD CSCO ACN ABT ORCL DHR WFC INTC TXN QCOM DIS VZ PM CMCSA NEE IBM AMGN HON UNP INTU CAT GS SPGI LOW RTX BA AMAT ISRG BKNG MS T PFE NOW GE ELV BLK SBUX DE PLD MDT LMT ADI GILD SYK TJX MMC C CVS AXP MDLZ VRTX REGN SCHW CB MO ZTS BMY CI SO DUK PGR ADP BSX MU LRCX PANW KLAC SNPS CDNS CME ETN SLB EOG'.split(' '),
  sector_etfs: 'XLK XLF XLV XLE XLI XLY XLP XLU XLB XLRE XLC'.split(' '),
};

export const FIELDS = {
  close: 'Closing price',
  rsi_14: 'RSI over 14 days (0-100; under 30 = oversold, over 70 = overbought)',
  rsi_2: 'RSI over 2 days (very short-term)',
  sma_20: '20-day average price', sma_50: '50-day average price', sma_200: '200-day average price',
  above_sma_50: 'true when price is above its 50-day average',
  above_sma_200: 'true when price is above its 200-day average',
  return_5d: '% change over 5 days', return_20d: '% change over 20 days (~1 month)',
  return_60d: '% change over 60 days (~3 months)', return_252d: '% change over 252 days (~1 year)',
  from_high_252: '% below the 1-year high (0 = at the high)',
  volatility_20d: 'Annualised volatility over 20 days, %',
  avg_volume_20: 'Average daily volume over 20 days',
};

// ---------- query parsing ----------
export function parseQuery(q) {
  if (!q || !q.trim()) throw new Error('Write a condition, e.g. rsi_14 < 30 AND above_sma_200');
  return q.split(/\s+AND\s+/i).map((part) => {
    part = part.trim();
    let m = part.match(/^(NOT\s+)?([a-z_0-9]+)$/i);
    if (m) {
      const field = m[2].toLowerCase();
      if (!(field in FIELDS)) throw new Error(`Unknown field "${field}"`);
      return { field, op: m[1] ? 'false' : 'true' };
    }
    m = part.match(/^([a-z_0-9]+)\s*(<=|>=|<|>|=|==|!=)\s*(-?[\d.]+(?:e\d+)?)$/i);
    if (!m) throw new Error(`Can't read "${part}". Use things like rsi_14 < 30 or above_sma_200`);
    const field = m[1].toLowerCase();
    if (!(field in FIELDS)) throw new Error(`Unknown field "${field}"`);
    return { field, op: m[2] === '==' ? '=' : m[2], value: Number(m[3]) };
  });
}

function test(cond, v) {
  if (v == null || Number.isNaN(v)) return false;
  switch (cond.op) {
    case 'true': return v === true;
    case 'false': return v === false;
    case '<': return v < cond.value;
    case '>': return v > cond.value;
    case '<=': return v <= cond.value;
    case '>=': return v >= cond.value;
    case '=': return v === cond.value;
    case '!=': return v !== cond.value;
    default: return false;
  }
}

// ---------- indicators (computed once per symbol as full arrays) ----------
function rolling(arr, n, fn) {
  return arr.map((_, i) => (i + 1 < n ? null : fn(arr.slice(i - n + 1, i + 1))));
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function rsi(closes, n) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= n) { g += Math.max(d, 0); l += Math.max(-d, 0); if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return out;
}

export function indicators(bars) {
  const c = bars.map((b) => b.c);
  const v = bars.map((b) => b.v ?? 0);
  const sma20 = rolling(c, 20, mean), sma50 = rolling(c, 50, mean), sma200 = rolling(c, 200, mean);
  const ret = (n) => c.map((x, i) => (i < n ? null : ((x - c[i - n]) / c[i - n]) * 100));
  const dailyRet = c.map((x, i) => (i ? x / c[i - 1] - 1 : 0));
  const vol = rolling(dailyRet, 20, (a) => { const m = mean(a); return Math.sqrt(mean(a.map((r) => (r - m) ** 2))) * Math.sqrt(252) * 100; });
  const hi = rolling(c, Math.min(252, c.length), (a) => Math.max(...a));
  return {
    close: c, rsi_14: rsi(c, 14), rsi_2: rsi(c, 2), sma_20: sma20, sma_50: sma50, sma_200: sma200,
    above_sma_50: c.map((x, i) => (sma50[i] == null ? null : x > sma50[i])),
    above_sma_200: c.map((x, i) => (sma200[i] == null ? null : x > sma200[i])),
    return_5d: ret(5), return_20d: ret(20), return_60d: ret(60), return_252d: ret(252),
    from_high_252: c.map((x, i) => (hi[i] == null ? null : ((hi[i] - x) / hi[i]) * 100)),
    volatility_20d: vol, avg_volume_20: rolling(v, 20, mean),
  };
}

// ---------- data ----------
function resolveUniverse(universe) {
  if (Array.isArray(universe)) return universe.map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (typeof universe === 'string' && universe.includes(',')) return universe.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (universe === 'watchlist') return config.bot.watchlist;
  return UNIVERSES[universe || 'large_caps'] ?? (() => { throw new Error(`Unknown universe "${universe}"`); })();
}

async function loadData(symbols, days) {
  // Extra 260 days so 200-day averages and 1-year returns exist from day one.
  const raw = await broker.getBarsMulti(symbols, days + 260);
  const data = {};
  for (const [sym, bars] of Object.entries(raw)) {
    if (bars.length < 30) continue;
    data[sym] = { bars, ind: indicators(bars), index: new Map(bars.map((b, i) => [b.t.slice(0, 10), i])) };
  }
  if (!Object.keys(data).length) throw new Error('No price data for that universe');
  return data;
}

function evaluate(conds, data, date, { order, dir, limit }) {
  const hits = [];
  for (const [sym, d] of Object.entries(data)) {
    const i = d.index.get(date);
    if (i == null) continue;
    if (conds.every((cond) => test(cond, d.ind[cond.field][i]))) {
      const row = { ticker: sym };
      for (const f of ['close', 'rsi_14', 'return_20d', 'from_high_252', order]) {
        const v = d.ind[f]?.[i];
        row[f] = typeof v === 'number' ? +v.toFixed(2) : v;
      }
      hits.push(row);
    }
  }
  if (order && order in FIELDS) hits.sort((a, b) => (dir === 'asc' ? 1 : -1) * ((a[order] ?? -Infinity) - (b[order] ?? -Infinity)));
  return { count: hits.length, results: hits.slice(0, limit) };
}

// Scan the universe as of the latest trading day (or a past date).
export async function scan({ q, universe, order = 'return_20d', dir = 'desc', limit = 20, asof }) {
  const conds = parseQuery(q);
  const symbols = resolveUniverse(universe);
  const since = asof ? Math.ceil(((Date.now() - new Date(asof).getTime()) / 86400000) * (252 / 365)) : 0;
  if (since > 2500) throw new Error('asof can be at most about 10 years back');
  const data = await loadData(symbols, Math.max(30, since + 30));
  const dates = [...new Set(Object.values(data).flatMap((d) => [...d.index.keys()]))].sort();
  const date = asof ? dates.filter((d) => d <= asof).at(-1) : dates.at(-1);
  if (!date) throw new Error('No trading day on or before that date');
  return { q, asOf: date, universeSize: Object.keys(data).length, ...evaluate(conds, data, date, { order, dir, limit: Math.min(100, limit) }) };
}

// Walk rebalance dates: scan as of each, hold top N equal-weight until the next.
export async function backtestScan({ q, universe, order = 'return_20d', dir = 'desc', top = 10, rebalanceDays = 21, days = 504, capital = 10000, feeBps = 5, benchmark = 'SPY' }) {
  const conds = parseQuery(q);
  days = Math.max(60, Math.min(2500, Number(days) || 504));
  rebalanceDays = Math.max(1, Math.min(252, Number(rebalanceDays) || 21));
  top = Math.max(1, Math.min(50, Number(top) || 10));
  const symbols = resolveUniverse(universe);
  const data = await loadData([...symbols, benchmark], days);
  const benchSym = benchmark.toUpperCase();
  const bench = data[benchSym];
  if (!symbols.includes(benchSym)) delete data[benchSym]; // benchmark is for comparison, not a pick

  const allDates = [...new Set(Object.values(data).flatMap((d) => [...d.index.keys()]))].sort();
  const dates = allDates.slice(-days);
  const fee = (Number(feeBps) || 0) / 10000;
  const priceAt = (sym, date, field) => {
    const d = sym === benchSym ? bench : data[sym]; const i = d?.index.get(date);
    return i == null ? null : (field === 'o' ? d.bars[i].o ?? d.bars[i].c : d.bars[i].c);
  };

  let equity = capital;
  const curve = [{ t: dates[0], strategy: capital }];
  const periods = [];
  for (let r = 0; r + 1 < dates.length; r += rebalanceDays) {
    const signalDate = dates[r];
    const entryDate = dates[r + 1];
    const exitIdx = Math.min(r + 1 + rebalanceDays, dates.length - 1);
    const exitDate = dates[exitIdx];
    const picks = evaluate(conds, data, signalDate, { order, dir, limit: top }).results.map((x) => x.ticker);
    const legs = picks.map((sym) => {
      const entry = priceAt(sym, entryDate, 'o');
      if (entry == null) return null;
      // If a stock stops trading mid-period, exit at its last available close.
      let exit = null;
      for (let k = exitIdx; k > r && exit == null; k--) exit = priceAt(sym, dates[k], exitIdx === dates.length - 1 && k === exitIdx ? 'c' : 'o');
      return exit == null ? null : { sym, ret: (exit * (1 - fee)) / (entry * (1 + fee)) - 1 };
    }).filter(Boolean);
    const periodRet = legs.length ? legs.reduce((a, l) => a + l.ret, 0) / legs.length : 0;
    // Daily marks for the chart (equal weight, buy-and-hold within the period).
    for (let k = r + 1; k <= exitIdx; k++) {
      const marks = legs.map((l) => { const e = priceAt(l.sym, entryDate, 'o'); const p = priceAt(l.sym, dates[k], 'c'); return p == null ? 1 + l.ret : p / e; });
      curve.push({ t: dates[k], strategy: +(legs.length ? equity * (marks.reduce((a, b) => a + b, 0) / marks.length) : equity).toFixed(2) });
    }
    equity *= 1 + periodRet;
    curve[curve.length - 1].strategy = +equity.toFixed(2);
    periods.push({ date: signalDate, picks: legs.map((l) => l.sym), returnPct: +(periodRet * 100).toFixed(2), equity: +equity.toFixed(2), best: legs.length ? legs.reduce((a, b) => (b.ret > a.ret ? b : a)).sym : null });
  }

  // Benchmark buy-and-hold over the same dates.
  let benchCurve = null, benchReturn = null;
  if (bench) {
    const b0 = priceAt(benchSym, dates[1], 'o') ?? priceAt(benchSym, dates[0], 'c');
    benchCurve = new Map(dates.map((t) => [t, priceAt(benchSym, t, 'c')]).filter(([, p]) => p != null).map(([t, p]) => [t, +(capital * p / b0).toFixed(2)]));
    benchReturn = +((benchCurve.get(dates.at(-1)) / capital - 1) * 100).toFixed(2);
  }
  const step = Math.ceil(curve.length / 250);
  const chart = curve.filter((_, i) => i % step === 0 || i === curve.length - 1).map((p) => ({ t: p.t, strategy: p.strategy, buyAndHold: benchCurve?.get(p.t) ?? null }));

  const eq = curve.map((p) => p.strategy);
  let peak = eq[0], maxDd = 0;
  for (const v of eq) { peak = Math.max(peak, v); maxDd = Math.max(maxDd, (peak - v) / peak); }
  const years = dates.length / 252;
  const invested = periods.filter((p) => p.picks.length).length;
  return {
    q, universe: Array.isArray(universe) ? 'custom' : universe || 'large_caps', universeSize: Object.keys(data).length,
    from: dates[0], to: dates.at(-1), rebalanceDays, top, order, dir, capital, benchmark: benchSym,
    result: {
      endingValue: +equity.toFixed(2),
      totalReturnPct: +((equity / capital - 1) * 100).toFixed(2),
      annualReturnPct: +((Math.pow(equity / capital, 1 / years) - 1) * 100).toFixed(2),
      maxDrawdownPct: +(maxDd * 100).toFixed(2),
      periods: periods.length,
      periodsInvested: invested,
      winningPeriodsPct: invested ? +((periods.filter((p) => p.picks.length && p.returnPct > 0).length / invested) * 100).toFixed(1) : null,
      avgPicks: invested ? +(periods.reduce((a, p) => a + p.picks.length, 0) / invested).toFixed(1) : 0,
    },
    benchmarkReturnPct: benchReturn,
    periods: periods.slice(-60),
    curve: chart,
    caveat: 'Universe is today\'s list of companies, so stocks that collapsed or were delisted are missing (survivorship bias). Results may look better than reality.',
  };
}

export function listFields() {
  return { fields: FIELDS, universes: { ...Object.fromEntries(Object.entries(UNIVERSES).map(([k, v]) => [k, `${v.length} symbols`])), watchlist: 'your WATCHLIST setting', custom: 'comma-separated symbols' } };
}
