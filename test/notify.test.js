import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tbot-notify-'));
delete process.env.NTFY_TOPIC;
const { notifySettings, setNotifyEnabled, formatActivity, notifyActivity } = await import('../src/notify.js');

test('makes a private random topic and stays off until switched on', () => {
  const a = notifySettings();
  assert.equal(a.enabled, false);
  assert.match(a.topic, /^tradingbot-[\w-]{12}$/);
  assert.equal(notifySettings().topic, a.topic); // stable
  assert.equal(setNotifyEnabled(true).enabled, true);
});

test('formats trades and errors, ignores routine noise', () => {
  const buy = formatActivity({ source: 'bot', action: 'order', side: 'buy', symbol: 'NVDA', notional: 1000, reason: 'screen: rsi_14 < 30' });
  assert.equal(buy.title, 'Bot bought NVDA');
  assert.match(buy.body, /\$1,000 of NVDA \(paper\)\nscreen/);
  assert.equal(formatActivity({ source: 'claude-mcp', action: 'order', side: 'sell', symbol: 'AAPL', qty: 3 }).title, 'Claude sold AAPL');
  assert.equal(formatActivity({ source: 'bot', action: 'bot-cycle', errors: [] }), null);
  assert.equal(formatActivity({ source: 'bot', action: 'bot-cycle', errors: ['MSFT: insufficient buying power'] }).priority, 4);
  assert.equal(formatActivity({ source: 'website', action: 'cancel' }), null);
});

test('posts to ntfy when on', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, text: async () => '' }; };
  try {
    notifyActivity({ source: 'bot', action: 'order', side: 'buy', symbol: 'MSFT', notional: 500 });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://ntfy.sh/${notifySettings().topic}`);
    assert.equal(calls[0].opts.headers.Title, 'Bot bought MSFT');
    setNotifyEnabled(false);
    notifyActivity({ source: 'bot', action: 'order', side: 'buy', symbol: 'MSFT', notional: 500 });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = orig; }
});
