// MCP tools shared by the stdio server (Claude Desktop / Claude Code on your
// computer) and the HTTP /mcp endpoint on the website (Claude custom connector).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { demoMode } from './config.js';
import * as broker from './broker.js';
import { getNews } from './news.js';
import { getTrends, analyzeSymbol, getSignals, botStatus, setBotEnabled, setBotStrategy, runBotCycle } from './strategy.js';
import { logActivity, getActivity } from './store.js';
import { runBacktest, compareStrategies, listStrategies } from './backtest.js';
import { scan, backtestScan, listFields } from './screener.js';

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

  const universe = z.union([z.enum(['large_caps', 'sector_etfs', 'watchlist']), z.array(z.string())]).default('large_caps')
    .describe('large_caps (~100 big US stocks), sector_etfs, watchlist, or a list of symbols');
  const query = z.string().describe('Conditions joined by AND, e.g. "rsi_14 < 30 AND above_sma_200 AND return_20d > -15". Call list_screener_fields for fields.');

  server.registerTool('get_bot_status', {
    title: 'Bot status', description: 'Whether the autonomous bot is enabled, what it trades (news signals or a screen), its limits, holdings it manages and last run.', inputSchema: {}, annotations: readOnly,
  }, wrap(() => botStatus()));

  server.registerTool('set_bot_enabled', {
    title: 'Turn bot on/off', description: 'Turns the autonomous paper-trading bot on or off (runs inside the website process).',
    inputSchema: { enabled: z.boolean() },
  }, wrap(({ enabled }) => setBotEnabled(enabled, SOURCE)));

  server.registerTool('run_bot_cycle', {
    title: 'Run bot once', description: 'Runs one bot cycle now. In signals mode it trades the watchlist on news + momentum; in screen mode it rebalances into the screen\'s top picks when a rebalance is due. Paper orders only, within the safety limits, and only while the market is open.',
    inputSchema: { rebalance_now: z.boolean().default(false).describe('Screen mode only: rebalance now even if the next scheduled rebalance is later') },
  }, wrap(({ rebalance_now }) => runBotCycle(SOURCE, { force: rebalance_now })));

  server.registerTool('set_bot_strategy', {
    title: 'Set what the bot trades',
    description: 'Switches the autonomous paper bot between "signals" (news + momentum on the watchlist) and "screen" (hold the top N matches of a screener query in equal dollar amounts, rebalanced every rebalance_days trading days). In screen mode the bot only sells positions it bought itself. Confirm with the user before switching.',
    inputSchema: {
      mode: z.enum(['signals', 'screen']),
      q: query.optional().describe('Screen mode: screener query, same syntax as scan_stocks'),
      universe: z.union([z.enum(['large_caps', 'sector_etfs', 'watchlist']), z.array(z.string())]).optional(),
      order: z.string().optional().describe('Field to rank matches by (default return_20d)'),
      dir: z.enum(['asc', 'desc']).optional(),
      top: z.number().int().min(1).max(20).optional().describe('How many picks to hold (default 5)'),
      rebalance_days: z.number().int().min(1).max(126).optional().describe('Trading days between rebalances (default 21, monthly)'),
      budget: z.number().positive().optional().describe('Total paper dollars for the screen (default 10000). Each pick also stays under MAX_POSITION_USD.'),
    },
  }, wrap(({ rebalance_days, ...args }) => setBotStrategy({ ...args, rebalanceDays: rebalance_days }, SOURCE)));

  server.registerTool('list_backtest_strategies', {
    title: 'Backtest strategies', description: 'Lists the strategies that can be backtested, with their parameters, defaults and allowed ranges.', inputSchema: {}, annotations: readOnly,
  }, wrap(() => listStrategies()));

  server.registerTool('run_backtest', {
    title: 'Backtest a strategy',
    description: 'Backtests one strategy on one symbol over daily price history (long-only, trades at next day\'s open, fees included) and compares it with buy-and-hold. Returns total/annual return, max drawdown, Sharpe, win rate and trades. Past results do not predict future returns; news sentiment is not part of backtests.',
    inputSchema: {
      symbol: z.string(),
      strategy: z.enum(['sma_crossover', 'rsi', 'momentum', 'breakout']).default('sma_crossover'),
      params: z.record(z.string(), z.number()).optional().describe('Strategy parameters, e.g. {"fast": 10, "slow": 30}. Omit for defaults.'),
      days: z.number().int().min(60).max(2500).default(500).describe('Trading days of history (252 ≈ 1 year)'),
      capital: z.number().positive().default(10000),
      fee_bps: z.number().min(0).max(100).default(5).describe('Cost per trade in basis points'),
    },
    annotations: readOnly,
  }, wrap(async ({ symbol, strategy, params, days, capital, fee_bps }) => {
    const r = await runBacktest({ symbol, strategy, params, days, capital, feeBps: fee_bps });
    const { curve, ...rest } = r; // keep the response compact for Claude
    return { ...rest, trades: rest.trades.slice(-10) };
  }));

  server.registerTool('compare_strategies', {
    title: 'Compare strategies', description: 'Backtests every strategy with default settings on one symbol and ranks them against buy-and-hold.',
    inputSchema: { symbol: z.string(), days: z.number().int().min(60).max(2500).default(500) }, annotations: readOnly,
  }, wrap(({ symbol, days }) => compareStrategies({ symbol, days })));


  server.registerTool('list_screener_fields', {
    title: 'Screener fields', description: 'Fields and universes available to scan_stocks and backtest_scan.', inputSchema: {}, annotations: readOnly,
  }, wrap(() => listFields()));

  server.registerTool('scan_stocks', {
    title: 'Scan stocks', description: 'Finds stocks in a universe that match the conditions today, or as of a past date (asof, YYYY-MM-DD) using only data known then.',
    inputSchema: {
      q: query, universe,
      order: z.string().default('return_20d').describe('Field to rank matches by'),
      dir: z.enum(['asc', 'desc']).default('desc'),
      limit: z.number().int().min(1).max(100).default(20),
      asof: z.string().optional(),
    },
    annotations: readOnly,
  }, wrap((args) => scan(args)));

  server.registerTool('backtest_scan', {
    title: 'Backtest a screen',
    description: 'Portfolio backtest: on each rebalance date, scan the universe with only data known that day, buy the top N matches in equal weights at the next open, hold until the next rebalance, compound. Compares with SPY. Universe is today\'s companies, so results carry survivorship bias.',
    inputSchema: {
      q: query, universe,
      order: z.string().default('return_20d'), dir: z.enum(['asc', 'desc']).default('desc'),
      top: z.number().int().min(1).max(50).default(10),
      rebalance_days: z.number().int().min(1).max(252).default(21).describe('Trading days between rebalances (5 weekly, 21 monthly, 63 quarterly)'),
      days: z.number().int().min(60).max(2500).default(504),
      capital: z.number().positive().default(10000),
    },
    annotations: readOnly,
  }, wrap(async ({ rebalance_days, ...args }) => {
    const { curve, ...r } = await backtestScan({ ...args, rebalanceDays: rebalance_days });
    return { ...r, periods: r.periods.slice(-12) };
  }));

  server.registerTool('get_activity', {
    title: 'Activity log', description: 'Recent activity from the website, the bot and Claude (orders, bot runs, toggles).',
    inputSchema: { limit: z.number().int().min(1).max(200).default(30) }, annotations: readOnly,
  }, wrap(({ limit }) => getActivity(limit)));

  return server;
}
