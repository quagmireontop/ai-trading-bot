import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ALPACA_KEY_ID = '';
process.env.ALPACA_SECRET_KEY = '';
const { parseQuery, indicators, scan, backtestScan } = await import('../src/screener.js');

test('parses conditions', () => {
  assert.deepEqual(parseQuery('rsi_14 < 30 AND above_sma_200'), [{ field: 'rsi_14', op: '<', value: 30 }, { field: 'above_sma_200', op: 'true' }]);
  assert.deepEqual(parseQuery('NOT above_sma_50 and return_20d >= -5'), [{ field: 'above_sma_50', op: 'false' }, { field: 'return_20d', op: '>=', value: -5 }]);
  assert.throws(() => parseQuery('market_cap > 1e9'), /Unknown field/);
  assert.throws(() => parseQuery('rsi_14 <'), /Can't read/);
});

test('indicators only use past data', () => {
  const bars = Array.from({ length: 260 }, (_, i) => ({ t: `d${i}`, c: 100 + i, v: 1 }));
  const a = indicators(bars);
  const b = indicators(bars.slice(0, 210)); // same history up to day 209
  assert.equal(a.sma_200[209], b.sma_200[209]);
  assert.equal(a.rsi_14[209], b.rsi_14[209]);
  assert.equal(a.sma_200[198], null);
  assert.equal(a.above_sma_200[259], true);
  assert.equal(Math.round(a.return_20d[259] * 100) / 100, +((359 / 339 - 1) * 100).toFixed(2));
});

test('scan and portfolio backtest run end to end (demo data)', async () => {
  const s = await scan({ q: 'return_20d > -100', universe: ['AAPL', 'MSFT', 'NVDA'], limit: 2 });
  assert.equal(s.count, 3);
  assert.equal(s.results.length, 2);
  const r = await backtestScan({ q: 'return_20d > -100', universe: ['AAPL', 'MSFT', 'NVDA'], top: 3, rebalanceDays: 21, days: 252, feeBps: 0 });
  assert.ok(r.result.periods >= 11);
  assert.equal(r.result.avgPicks, 3);
  assert.ok(r.benchmarkReturnPct != null);
  assert.equal(r.curve.at(-1).strategy, r.result.endingValue);
});
