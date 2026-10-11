import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tbot-bot-'));
process.env.ALPACA_KEY_ID = '';
process.env.ALPACA_SECRET_KEY = '';
process.env.MAX_POSITION_USD = '2000';

const broker = await import('../src/broker.js');
const { setBotStrategy, runBotCycle, botStatus } = await import('../src/strategy.js');
const { scan } = await import('../src/screener.js');

const U = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META'];

test('screen mode buys the top picks, then holds until the next rebalance', async () => {
  // A position the bot did not buy must never be sold by the screen.
  await broker.placeOrder({ symbol: 'XOM', side: 'buy', notional: 500 });

  assert.throws(() => setBotStrategy({ mode: 'screen', q: 'nonsense > 1' }, 'test'), /Unknown field/);
  const s = setBotStrategy({ mode: 'screen', q: 'return_20d > -100', universe: U, top: 3, rebalanceDays: 21, budget: 9000 }, 'test');
  assert.equal(s.mode, 'screen');
  assert.equal(s.perPickUsd, 2000); // 9000/3 capped by MAX_POSITION_USD

  const expected = (await scan({ q: 'return_20d > -100', universe: U, limit: 3 })).results.map((r) => r.ticker);
  const r1 = await runBotCycle('test');
  assert.deepEqual(r1.actions.filter((a) => a.side === 'buy').map((a) => a.symbol).sort(), [...expected].sort());
  assert.deepEqual([...botStatus().managed].sort(), [...expected].sort());
  assert.ok(botStatus().nextRebalance);

  const r2 = await runBotCycle('test');
  assert.equal(r2.actions.filter((a) => a.orderId).length, 0);
  assert.match(r2.actions[0].note, /next rebalance/);

  // Narrow the screen to one name: the others are sold, XOM stays.
  setBotStrategy({ mode: 'screen', q: 'return_20d > -100', universe: [expected[0]], top: 1 }, 'test');
  const r3 = await runBotCycle('test');
  const sold = r3.actions.filter((a) => a.side === 'sell').map((a) => a.symbol).sort();
  assert.deepEqual(sold, expected.slice(1).sort());
  const held = (await broker.getPositions()).map((p) => p.symbol).sort();
  assert.deepEqual(held, [expected[0], 'XOM'].sort());
  assert.deepEqual(botStatus().managed, [expected[0]]);

  assert.equal(setBotStrategy({ mode: 'signals' }, 'test').mode, 'signals');
});

test('stop-loss and take-profit sell only the bot\'s own losers and winners', async () => {
  const st = await import('../src/store.js');
  // Fake prices: bot owns NVDA (down 10%) and AAPL (up 25%) and MSFT (up 2%); you own XOM (down 50%).
  const positions = [
    { symbol: 'NVDA', qty: 2, unrealizedPlPct: -10 },
    { symbol: 'AAPL', qty: 3, unrealizedPlPct: 25 },
    { symbol: 'MSFT', qty: 1, unrealizedPlPct: 2 },
    { symbol: 'XOM', qty: 4, unrealizedPlPct: -50 },
  ];
  st.write('bot', { ...st.read('bot', {}), owned: ['NVDA', 'AAPL', 'MSFT'], risk: undefined });
  const { checkRisk, setBotRisk } = await import('../src/strategy.js');
  const demo = { cash: 0, orders: [], positions: {} };
  for (const p of positions) demo.positions[p.symbol] = { qty: p.qty, avgPrice: 100 };
  st.write('demo-portfolio', demo);
  const prices = Object.fromEntries((await broker.getPositions()).map((p) => [p.symbol, p.price]));
  // Set average prices so the current price gives the target gain/loss.
  for (const p of positions) demo.positions[p.symbol].avgPrice = prices[p.symbol] / (1 + p.unrealizedPlPct / 100);
  st.write('demo-portfolio', demo);

  const r = await checkRisk('test', { clock: { isOpen: true } });
  const sold = r.actions.filter((a) => a.side === 'sell').map((a) => a.symbol).sort();
  assert.deepEqual(sold, ['AAPL', 'NVDA']);
  assert.match(r.actions.find((a) => a.symbol === 'NVDA').note, /stop-loss: down 10/);
  assert.match(r.actions.find((a) => a.symbol === 'AAPL').note, /take-profit: up 25/);
  const s = st.read('bot', {});
  assert.deepEqual(s.owned, ['MSFT']);
  assert.ok(s.cooldown.NVDA > new Date().toISOString().slice(0, 10));

  // Watching every position catches XOM too.
  assert.throws(() => setBotRisk({ stopLossPct: 150 }, 'test'), /between 0/);
  setBotRisk({ scope: 'all' }, 'test');
  const r2 = await checkRisk('test', { clock: { isOpen: true } });
  assert.deepEqual(r2.actions.map((a) => a.symbol), ['XOM']);
});
