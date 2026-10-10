import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ALPACA_KEY_ID = '';
process.env.ALPACA_SECRET_KEY = '';
const { simulate, listStrategies } = await import('../src/backtest.js');

const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString();
const series = (prices) => prices.map((c, i) => ({ t: day(i), o: c, c }));

test('buy and hold math and no-lookahead entries', () => {
  // Steady uptrend: momentum should be invested most of the time and make money.
  const up = series(Array.from({ length: 120 }, (_, i) => 100 + i));
  const r = simulate(up, 'momentum', { lookback: 5, threshold: 0 }, { capital: 1000, feeBps: 0 });
  assert.ok(Math.abs(r.buyAndHold.totalReturnPct - 119) < 0.01);
  assert.ok(r.result.totalReturnPct > 90);
  assert.equal(r.result.maxDrawdownPct, 0);
  assert.ok(r.openTrade, 'still holding at the end');
  // Signal appears on day 5, so the first buy is at day 6's open (106), not earlier.
  assert.equal(r.openTrade.entryPrice, 106);
});

test('strategies sell on reversal and record trades', () => {
  const prices = [...Array.from({ length: 60 }, (_, i) => 100 + i), ...Array.from({ length: 60 }, (_, i) => 160 - i * 1.5)];
  const r = simulate(series(prices), 'sma_crossover', { fast: 5, slow: 20 }, { capital: 1000, feeBps: 0 });
  assert.equal(r.result.trades, 1);
  assert.ok(r.result.maxDrawdownPct < r.buyAndHold.maxDrawdownPct, 'exiting limits the drop');
});

test('validates parameters and strategy names', () => {
  const s = series(Array.from({ length: 60 }, (_, i) => 100 + i));
  assert.throws(() => simulate(s, 'nope'), /Unknown strategy/);
  assert.throws(() => simulate(s, 'sma_crossover', { fast: 1 }), /fast must be between/);
  assert.equal(listStrategies().length, 4);
});
