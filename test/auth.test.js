import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tbot-auth-'));
process.env.ALPACA_KEY_ID = '';
process.env.ALPACA_SECRET_KEY = '';
process.env.DASHBOARD_PASSWORD = 'correct horse';
process.env.MCP_SECRET = 's3cret-path-value';

const { app } = await import('../src/server.js');

test('login protects the dashboard, API and MCP', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });
  try {
    assert.equal((await get('/healthz')).status, 200);
    const home = await get('/');
    assert.equal(home.status, 302);
    assert.equal(home.headers.get('location'), '/login');
    assert.equal((await get('/api/account')).status, 401);

    const bad = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=nope' });
    assert.equal(bad.headers.get('location'), '/login?error=wrong');

    const good = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=correct+horse' });
    const cookie = good.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^tb_session=/);
    assert.equal((await get('/', { cookie })).status, 200);
    const status = await (await get('/api/status', { cookie })).json();
    assert.ok(status.mcpUrl.endsWith('/mcp/s3cret-path-value'));

    const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    assert.equal((await get('/api/account', { cookie: tampered })).status, 401);

    const mcp = (p) => fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    assert.equal((await mcp('/mcp')).status, 401);
    assert.equal((await mcp('/mcp/wrong')).status, 401);
    assert.equal((await mcp('/mcp/s3cret-path-value')).status, 200);
  } finally {
    server.close();
  }
});
