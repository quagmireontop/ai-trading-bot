import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

// Minimal .env loader so there is no extra dependency. Real env vars win over .env.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

export const config = {
  port: num(env.PORT, 3000),
  dashboardToken: env.DASHBOARD_TOKEN || '',
  // Website login. When set, the dashboard asks for this password.
  dashboardPassword: env.DASHBOARD_PASSWORD || '',
  // Lets claude.ai connect at /mcp/<MCP_SECRET> (connectors there can't send a token).
  mcpSecret: env.MCP_SECRET || '',
  sessionSecret: env.SESSION_SECRET || '',
  alpaca: {
    keyId: env.ALPACA_KEY_ID || env.ALPACA_API_KEY || env.APCA_API_KEY_ID || '',
    secretKey: env.ALPACA_SECRET_KEY || env.ALPACA_API_SECRET || env.ALPACA_SECRET || env.APCA_API_SECRET_KEY || '',
    // Paper trading only. The live endpoint is deliberately not configurable.
    tradingUrl: 'https://paper-api.alpaca.markets',
    dataUrl: 'https://data.alpaca.markets',
  },
  bot: {
    autoTrade: env.AUTO_TRADE === 'true',
    intervalMinutes: num(env.BOT_INTERVAL_MINUTES, 15),
    maxPositionUsd: num(env.MAX_POSITION_USD, 2000),
    maxOrdersPerDay: num(env.MAX_ORDERS_PER_DAY, 10),
    watchlist: list(env.WATCHLIST, ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'SPY', 'QQQ']).map((s) => s.toUpperCase()),
  },
  extraFeeds: list(env.EXTRA_RSS_FEEDS, []),
};

export const demoMode = !(config.alpaca.keyId && config.alpaca.secretKey);
