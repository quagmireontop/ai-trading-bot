// Website + JSON API + remote MCP endpoint, all in one process.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config, demoMode, ROOT } from './config.js';
import * as broker from './broker.js';
import { getNews } from './news.js';
import { getTrends, analyzeSymbol, getSignals, botStatus, setBotEnabled, setBotStrategy, runBotCycle, startScheduler } from './strategy.js';
import { logActivity, getActivity } from './store.js';
import { createMcpServer } from './tools.js';
import { notifySettings, setNotifyEnabled, sendPush, formatActivity } from './notify.js';
import { runBacktest, compareStrategies, listStrategies } from './backtest.js';
import { scan, backtestScan, listFields } from './screener.js';
import { loginEnabled, requireAuth, requirePageAuth, handleLogin, handleLogout, mcpAllowed } from './auth.js';

export const app = express();
app.set('trust proxy', 1); // cloud hosts put a proxy in front; needed for secure cookies
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const page = (name) => (req, res) => res.sendFile(path.join(ROOT, 'public', name));
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/login', (req, res, next) => (loginEnabled() ? page('login.html')(req, res, next) : res.redirect('/')));
app.post('/login', handleLogin);
app.get('/logout', handleLogout);
app.get(['/', '/index.html'], requirePageAuth, page('index.html'));
app.use(express.static(path.join(ROOT, 'public'), { index: false }));

const route = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

const api = express.Router();
api.use(requireAuth);
api.get('/status', route(async (r) => ({ mcpUrl: config.mcpSecret ? `${r.protocol}://${r.get('host')}/mcp/${config.mcpSecret}` : null, mcpScript: path.join(ROOT, 'src', 'mcp-stdio.js'), demoMode, paperOnly: true, loginEnabled: loginEnabled(), remoteMcp: !!config.mcpSecret, clock: await broker.getMarketClock().catch(() => null), bot: botStatus() })));
api.get('/account', route(() => broker.getAccount()));
api.get('/positions', route(() => broker.getPositions()));
api.get('/orders', route(() => broker.getOrders(50)));
api.get('/quote/:symbol', route((r) => broker.getQuote(r.params.symbol)));
api.get('/bars/:symbol', route((r) => broker.getBars(r.params.symbol, Number(r.query.days) || 30)));
api.get('/news', route((r) => getNews({ query: r.query.q, category: r.query.category, symbol: r.query.symbol, limit: Number(r.query.limit) || 40 })));
api.get('/trends', route(() => getTrends()));
api.get('/signals', route(() => getSignals()));
api.get('/analyze/:symbol', route((r) => analyzeSymbol(r.params.symbol)));
api.get('/activity', route(() => getActivity(50)));
api.get('/backtest/strategies', route(() => listStrategies()));
api.post('/backtest', route((r) => runBacktest(r.body)));
api.post('/backtest/compare', route((r) => compareStrategies(r.body)));
api.get('/screener/fields', route(() => listFields()));
api.post('/screener/scan', route((r) => scan(r.body)));
api.post('/screener/backtest', route((r) => backtestScan(r.body)));
api.post('/orders', route(async (r) => {
  const { symbol, side, qty, notional, type, limitPrice } = r.body;
  const order = await broker.placeOrder({ symbol, side, qty: qty && Number(qty), notional: notional && Number(notional), type, limitPrice: limitPrice && Number(limitPrice) });
  logActivity('website', 'order', { symbol: order.symbol, side, qty: order.qty, notional: order.notional });
  return order;
}));
api.delete('/orders/:id', route(async (r) => {
  const result = await broker.cancelOrder(r.params.id);
  logActivity('website', 'cancel', { orderId: r.params.id });
  return result;
}));
api.post('/bot', route((r) => setBotEnabled(!!r.body.enabled, 'website')));
api.post('/bot/run', route(() => runBotCycle('website')));
api.post('/bot/strategy', route((r) => setBotStrategy(r.body, 'website')));
api.get('/notify', route(() => notifySettings()));
api.post('/notify', route((r) => setNotifyEnabled(!!r.body.enabled)));
api.post('/notify/test', route(async () => {
  if (!notifySettings().enabled) throw new Error('Turn phone alerts on first');
  await sendPush(formatActivity({ action: 'test' }));
  return { sent: true };
}));
app.use('/api', api);

// Remote MCP endpoint (stateless Streamable HTTP). Add https://<your-site>/mcp as a
// custom connector in Claude to give Claude the same tools the website uses.
app.post(['/mcp', '/mcp/:secret'], async (req, res) => {
  if (!mcpAllowed(req)) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
  }
});
app.all(['/mcp', '/mcp/:secret'], (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  app.listen(config.port, (err) => {
    if (err) {
      console.error(err.code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use. Close the other window running the bot, or set PORT=3001 in .env.`
        : `Could not start the website: ${err.message}`);
      process.exit(1);
    }
    console.log(`AI trading bot running at http://localhost:${config.port}`);
    console.log(demoMode ? 'Mode: DEMO (no Alpaca keys found, simulated portfolio)' : 'Mode: Alpaca PAPER trading');
    if (!loginEnabled()) console.log('Tip: set DASHBOARD_PASSWORD before putting this on the internet.');
    startScheduler();
  });
}
