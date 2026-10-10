import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tbot-'));
process.env.ALPACA_KEY_ID = '';
process.env.ALPACA_SECRET_KEY = '';

const { parseFeed, _setCache } = await import('../src/news.js');
const { scoreArticle, summarizeTrends } = await import('../src/trends.js');
const broker = await import('../src/broker.js');
const { app } = await import('../src/server.js');
const { SAMPLE_RSS, SAMPLE_ATOM, SAMPLE_ARTICLES } = await import('./fixtures.js');

test('parses RSS and Atom feeds', () => {
  const rss = parseFeed(SAMPLE_RSS, { name: 'T', category: 'markets' });
  assert.equal(rss.length, 2);
  assert.equal(rss[0].url, 'https://example.com/a');
  assert.equal(rss[0].summary, 'Chip demand from AI keeps growing.');
  const atom = parseFeed(SAMPLE_ATOM, { name: 'T', category: 'markets' });
  assert.equal(atom[0].url, 'https://example.com/c');
  assert.equal(atom[0].published, '2026-10-08T12:00:00.000Z');
});

test('scores sentiment, tickers and topics', () => {
  const up = scoreArticle({ title: 'Nvidia shares surge after earnings beat' });
  assert.equal(up.sentimentLabel, 'positive');
  assert.ok(up.tickers.includes('NVDA'));
  assert.ok(up.topics.includes('Earnings'));
  const down = scoreArticle({ title: 'Tesla stock plunges on delivery miss' });
  assert.equal(down.sentimentLabel, 'negative');
  assert.ok(down.tickers.includes('TSLA'));
  assert.ok(scoreArticle({ title: 'Fed signals rate cut' }).sentiment > 0);
  assert.ok(scoreArticle({ title: 'Shares of $PLTR rise' }).tickers.includes('PLTR'));
});

test('summarizes trends', () => {
  const t = summarizeTrends(SAMPLE_ARTICLES.map((a) => ({ ...a, ...scoreArticle(a) })));
  assert.equal(t.articleCount, SAMPLE_ARTICLES.length);
  assert.ok(t.topics.find((x) => x.name === 'AI & chips'));
  assert.ok(t.tickers.length > 3);
});

test('demo broker buys and sells with safety limit', async () => {
  const buy = await broker.placeOrder({ symbol: 'AAPL', side: 'buy', notional: 1000 });
  assert.equal(buy.status, 'filled');
  const [pos] = await broker.getPositions();
  assert.equal(pos.symbol, 'AAPL');
  await assert.rejects(broker.placeOrder({ symbol: 'AAPL', side: 'buy', notional: 999999 }), /MAX_POSITION_USD/);
  await broker.placeOrder({ symbol: 'AAPL', side: 'sell', qty: pos.qty });
  assert.equal((await broker.getPositions()).length, 0);
});

test('website API and MCP endpoint share state', async () => {
  _setCache(SAMPLE_ARTICLES);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const trends = await (await fetch(`${base}/api/trends`)).json();
    assert.ok(trends.topics.length);

    const mcp = async (method, params, id = 1) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      const body = await res.text();
      const line = body.split('\n').find((l) => l.startsWith('data:'));
      return JSON.parse(line ? line.slice(5) : body);
    };
    const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'ai-trading-bot');
    const tools = await mcp('tools/list', {});
    const names = tools.result.tools.map((t) => t.name);
    for (const n of ['get_news', 'get_market_trends', 'place_order', 'get_trade_signals']) assert.ok(names.includes(n), n);

    const order = await mcp('tools/call', { name: 'place_order', arguments: { symbol: 'MSFT', side: 'buy', notional: 500, reason: 'test from Claude' } });
    assert.ok(!order.result.isError, order.result.content[0].text);
    const activity = await (await fetch(`${base}/api/activity`)).json();
    assert.equal(activity[0].source, 'claude-mcp');
    assert.equal(activity[0].symbol, 'MSFT');
    const positions = await (await fetch(`${base}/api/positions`)).json();
    assert.ok(positions.find((p) => p.symbol === 'MSFT'));

    const signals = await mcp('tools/call', { name: 'get_trade_signals', arguments: {} });
    assert.ok(JSON.parse(signals.result.content[0].text).length > 0);
  } finally {
    server.close();
  }
});
