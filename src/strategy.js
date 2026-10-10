// Turns news sentiment + price momentum into buy/sell/hold signals, and runs the
// optional autonomous bot loop. Everything here only ever trades the paper account.
import { config } from './config.js';
import * as broker from './broker.js';
import { fetchAllNews } from './news.js';
import { summarizeTrends } from './trends.js';
import { read, write, logActivity } from './store.js';

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const sma = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;

export async function getTrends() {
  const { articles, at, errors } = await fetchAllNews();
  return { fetchedAt: new Date(at).toISOString(), ...summarizeTrends(articles), sourceErrors: errors };
}

export async function analyzeSymbol(symbol, articles) {
  symbol = symbol.toUpperCase();
  articles ??= (await fetchAllNews()).articles;
  const related = articles.filter((a) => a.tickers.includes(symbol));
  const newsSentiment = related.length ? related.reduce((s, a) => s + a.sentiment, 0) / related.length : 0;
  const newsScore = newsSentiment * Math.min(1, related.length / 3); // more coverage = more confidence

  let momentumPct = 0;
  try {
    const closes = (await broker.getBars(symbol, 25)).map((b) => b.c);
    if (closes.length >= 20) momentumPct = ((sma(closes.slice(-5)) - sma(closes.slice(-20))) / sma(closes.slice(-20))) * 100;
  } catch { /* no price data: rely on news only */ }
  const momentumScore = clamp(momentumPct / 5);

  const score = +(0.6 * newsScore + 0.4 * momentumScore).toFixed(2);
  const action = score > 0.3 ? 'buy' : score < -0.3 ? 'sell' : 'hold';
  const reasons = [
    `${related.length} recent headline(s), average sentiment ${newsSentiment.toFixed(2)}`,
    `5-day vs 20-day price trend ${momentumPct >= 0 ? '+' : ''}${momentumPct.toFixed(2)}%`,
  ];
  return { symbol, action, score, newsSentiment: +newsSentiment.toFixed(2), mentions: related.length, momentumPct: +momentumPct.toFixed(2), reasons, headlines: related.slice(0, 3).map((a) => a.title) };
}

export async function getSignals(symbols = config.bot.watchlist) {
  const { articles } = await fetchAllNews();
  const signals = await Promise.all(symbols.map((s) => analyzeSymbol(s, articles)));
  return signals.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

// ---------- Autonomous bot ----------
// The on/off switch lives in the shared store, so the website, Claude (via MCP)
// and the AUTO_TRADE env var all control the same bot. The website process runs
// the scheduler that actually executes cycles.
const today = () => new Date().toISOString().slice(0, 10);

export function botStatus() {
  const s = read('bot', {});
  return {
    enabled: s.enabled ?? config.bot.autoTrade,
    intervalMinutes: config.bot.intervalMinutes,
    maxPositionUsd: config.bot.maxPositionUsd,
    maxOrdersPerDay: config.bot.maxOrdersPerDay,
    watchlist: config.bot.watchlist,
    lastRun: s.lastRun || null,
    ordersToday: s.day === today() ? s.ordersToday : 0,
    paperOnly: true,
  };
}

export async function runBotCycle(source = 'bot') {
  const clock = await broker.getMarketClock().catch(() => ({ isOpen: false }));
  const signals = await getSignals();
  const positions = await broker.getPositions();
  const held = new Map(positions.map((p) => [p.symbol, p]));
  const actions = [];

  const state = read('bot', {});
  if (state.day !== today()) Object.assign(state, { day: today(), ordersToday: 0 });

  if (!clock.isOpen) {
    actions.push({ note: 'Market is closed; signals computed but no orders placed.' });
  } else {
    for (const sig of signals) {
      if (state.ordersToday >= config.bot.maxOrdersPerDay) { actions.push({ note: 'Daily order limit reached.' }); break; }
      try {
        if (sig.action === 'buy' && !held.has(sig.symbol)) {
          const notional = Math.floor(config.bot.maxPositionUsd * Math.min(1, sig.score));
          const order = await broker.placeOrder({ symbol: sig.symbol, side: 'buy', notional });
          state.ordersToday++;
          actions.push({ symbol: sig.symbol, side: 'buy', score: sig.score, orderId: order.id });
          logActivity(source, 'order', { symbol: sig.symbol, side: 'buy', notional, reason: sig.reasons.join('; ') });
        } else if (sig.action === 'sell' && held.has(sig.symbol)) {
          const qty = held.get(sig.symbol).qty;
          const order = await broker.placeOrder({ symbol: sig.symbol, side: 'sell', qty });
          state.ordersToday++;
          actions.push({ symbol: sig.symbol, side: 'sell', score: sig.score, orderId: order.id });
          logActivity(source, 'order', { symbol: sig.symbol, side: 'sell', qty, reason: sig.reasons.join('; ') });
        }
      } catch (e) {
        actions.push({ symbol: sig.symbol, error: e.message });
      }
    }
  }
  // Re-read so a concurrent on/off toggle is not overwritten.
  const latest = read('bot', {});
  write('bot', { ...latest, day: state.day, ordersToday: state.ordersToday, lastRun: new Date().toISOString() });
  logActivity(source, 'bot-cycle', { ordersPlaced: actions.filter((a) => a.orderId).length, marketOpen: clock.isOpen });
  return { ranAt: new Date().toISOString(), marketOpen: clock.isOpen, actions, signals };
}

export function setBotEnabled(enabled, source) {
  write('bot', { ...read('bot', {}), enabled });
  logActivity(source, enabled ? 'bot-enabled' : 'bot-disabled');
  return botStatus();
}

// Called once by the website server: checks every minute whether a cycle is due.
export function startScheduler() {
  let running = false;
  const tick = async () => {
    const s = botStatus();
    const due = !s.lastRun || Date.now() - new Date(s.lastRun).getTime() >= s.intervalMinutes * 60000;
    if (!s.enabled || !due || running) return;
    running = true;
    try { await runBotCycle('bot'); } catch (e) { logActivity('bot', 'error', { error: e.message }); } finally { running = false; }
  };
  setInterval(tick, 60000).unref();
  setTimeout(tick, 5000).unref();
}
