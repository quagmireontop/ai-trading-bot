// MCP tools shared by the stdio server (Claude Desktop / Claude Code on your
// computer) and the HTTP /mcp endpoint on the website (Claude custom connector).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { demoMode } from './config.js';
import * as broker from './broker.js';
import { getNews } from './news.js';
import { getTrends, analyzeSymbol, getSignals, botStatus, setBotEnabled, runBotCycle } from './strategy.js';
import { logActivity, getActivity } from './store.js';

const SOURCE = 'claude-mcp';
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args ?? {}));
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
};
const readOnly = { readOnlyHint: true, openWorldHint: true };

export function createMcpServer() {
  const server = new McpServer(
    { name: 'ai-trading-bot', version: '0.1.0' },
    {
      instructions: `Tools for an AI trading bot connected to an Alpaca ${demoMode ? 'DEMO (simulated)' : 'PAPER'} account. `
        + 'All trading is paper/simulated money only. Use get_market_trends and get_news to understand what is moving markets, '
        + 'analyze_stock / get_trade_signals for per-ticker views, and confirm with the user before calling place_order. '
        + 'Everything you do is logged to the website activity feed.',
    },
  );

  server.registerTool('get_account', {
    title: 'Account summary', description: 'Cash, equity, buying power and mode (paper or demo) of the trading account.', inputSchema: {}, annotations: readOnly,
  }, wrap(() => broker.getAccount()));

  server.registerTool('get_positions', {
    title: 'Open positions', description: 'All open positions with quantity, average price, current price and unrealized P/L.', inputSchema: {}, annotations: readOnly,
  }, wrap(() => broker.getPositions()));

  server.registerTool('get_orders', {
    title: 'Recent orders', description: 'Recent orders, newest first.',
    inputSchema: { limit: z.number().int().min(1).max(200).default(25) }, annotations: readOnly,
  }, wrap(({ limit }) => broker.getOrders(limit)));

  server.registerTool('get_quote', {
    title: 'Stock quote', description: 'Latest price and daily change for a stock or ETF symbol.',
    inputSchema: { symbol: z.string().describe('Ticker, e.g. AAPL') }, annotations: readOnly,
  }, wrap(({ symbol }) => broker.getQuote(symbol)));

  server.registerTool('get_price_history', {
    title: 'Price history', description: 'Daily OHLC bars for a symbol (t=time, o/h/l/c=prices, v=volume).',
    inputSchema: { symbol: z.string(), days: z.number().int().min(5).max(365).default(30) }, annotations: readOnly,
  }, wrap(({ symbol, days }) => broker.getBars(symbol, days)));

  server.registerTool('get_news', {
    title: 'Latest news', description: 'Latest stock market and world headlines from RSS feeds (and Alpaca news), each scored for sentiment, tickers and topics. Filter by keyword, category (markets|world) or ticker.',
    inputSchema: {
      query: z.string().optional().describe('Keyword to search in headlines'),
      category: z.enum(['markets', 'world', 'custom']).optional(),
      symbol: z.string().optional().describe('Only news that mentions this ticker'),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: readOnly,
  }, wrap((args) => getNews(args)));

  server.registerTool('get_market_trends', {
    title: 'Market trends', description: 'Summarizes the latest news into overall market mood, trending topics (Fed, AI, oil, geopolitics...) and most-mentioned tickers with sentiment.',
    inputSchema: {}, annotations: readOnly,
  }, wrap(() => getTrends()));

  server.registerTool('analyze_stock', {
    title: 'Analyze a stock', description: 'Combines news sentiment and 5/20-day price momentum into a buy/sell/hold signal with reasons.',
    inputSchema: { symbol: z.string() }, annotations: readOnly,
  }, wrap(({ symbol }) => analyzeSymbol(symbol)));

  server.registerTool('get_trade_signals', {
    title: 'Trade signals', description: 'Buy/sell/hold signals for the watchlist (or the given symbols), strongest first.',
    inputSchema: { symbols: z.array(z.string()).optional() }, annotations: readOnly,
  }, wrap(({ symbols }) => getSignals(symbols?.map((s) => s.toUpperCase()))));

  server.registerTool('place_order', {
    title: 'Place paper order',
    description: 'Places a PAPER-trading order (no real money). Give qty (shares) or notional (dollars). Buys are capped by MAX_POSITION_USD. Confirm with the user first.',
    inputSchema: {
      symbol: z.string(),
      side: z.enum(['buy', 'sell']),
      qty: z.number().positive().optional(),
      notional: z.number().positive().optional().describe('Dollar amount instead of qty (market orders only)'),
      type: z.enum(['market', 'limit']).default('market'),
      limit_price: z.number().positive().optional(),
      reason: z.string().optional().describe('Why this trade; shown on the website activity feed'),
    },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, wrap(async ({ symbol, side, qty, notional, type, limit_price, reason }) => {
    const order = await broker.placeOrder({ symbol, side, qty, notional, type, limitPrice: limit_price });
    logActivity(SOURCE, 'order', { symbol: order.symbol, side, qty: order.qty, notional: order.notional, reason });
    return order;
  }));

  server.registerTool('cancel_order', {
    title: 'Cancel order', description: 'Cancels an open paper order by id.', inputSchema: { order_id: z.string() },
  }, wrap(async ({ order_id }) => {
    const r = await broker.cancelOrder(order_id);
    logActivity(SOURCE, 'cancel', { orderId: order_id });
    return r;
  }));

  server.registerTool('get_bot_status', {
    title: 'Bot status', description: 'Whether the autonomous bot is enabled, its limits, watchlist and last run.', inputSchema: {}, annotations: readOnly,
  }, wrap(() => botStatus()));

  server.registerTool('set_bot_enabled', {
    title: 'Turn bot on/off', description: 'Turns the autonomous paper-trading bot on or off (runs inside the website process).',
    inputSchema: { enabled: z.boolean() },
  }, wrap(({ enabled }) => setBotEnabled(enabled, SOURCE)));

  server.registerTool('run_bot_cycle', {
    title: 'Run bot once', description: 'Runs one bot cycle now: computes signals and, if the market is open, places paper orders within the safety limits.',
    inputSchema: {},
  }, wrap(() => runBotCycle(SOURCE)));

  server.registerTool('get_activity', {
    title: 'Activity log', description: 'Recent activity from the website, the bot and Claude (orders, bot runs, toggles).',
    inputSchema: { limit: z.number().int().min(1).max(200).default(30) }, annotations: readOnly,
  }, wrap(({ limit }) => getActivity(limit)));

  return server;
}
