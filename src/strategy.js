// Turns news sentiment + price momentum into buy/sell/hold signals, and runs the
// optional autonomous bot loop. Everything here only ever trades the paper account.
import { config } from './config.js';
import * as broker from './broker.js';
import { fetchAllNews } from './news.js';
import { summarizeTrends } from './trends.js';
import { read, write, logActivity } from './store.js';
import { scan, parseQuery } from './screener.js';

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

const DEFAULT_SCREEN = { universe: 'large_caps', order: 'return_20d', dir: 'desc', top: 5, rebalanceDays: 21 };
const DEFAULT_BUDGET = 10000;
// Trading days -> calendar days, roughly (5 trading days per week).
const nextRebalance = (s) => {
  if (!s.lastRebalance) return null;
  const days = Math.ceil((s.screen?.rebalanceDays ?? 21) * 7 / 5);
  return new Date(new Date(s.lastRebalance).getTime() + days * 86400000).toISOString();
};

export function botStatus() {
  const s = read('bot', {});
  const mode = s.mode === 'screen' && s.screen?.q ? 'screen' : 'signals';
  return {
    enabled: s.enabled ?? config.bot.autoTrade,
    mode,
    intervalMinutes: config.bot.intervalMinutes,
    maxPositionUsd: config.bot.maxPositionUsd,
    maxOrdersPerDay: config.bot.maxOrdersPerDay,
    watchlist: config.bot.watchlist,
    lastRun: s.lastRun || null,
    ordersToday: s.day === today() ? s.ordersToday : 0,
    ...(mode === 'screen' && {
      screen: s.screen,
      budget: s.budget ?? DEFAULT_BUDGET,
      perPickUsd: Math.min((s.budget ?? DEFAULT_BUDGET) / s.screen.top, config.bot.maxPositionUsd),
      managed: s.managed || [],
      lastRebalance: s.lastRebalance || null,
      nextRebalance: nextRebalance(s),
    }),
    paperOnly: true,
  };
}

// Switch what the bot trades: 'signals' (news + momentum on the watchlist) or
// 'screen' (hold the top N results of a screener query, rebalanced on a schedule).
export function setBotStrategy({ mode, q, universe, order, dir, top, rebalanceDays, budget }, source) {
  const s = read('bot', {});
  if (mode === 'screen') {
    if (!q || !String(q).trim()) throw new Error('A screen query is required, e.g. "rsi_14 < 30 and close > sma_200"');
    parseQuery(q); // throws on a bad query before we save it
    const screen = {
      ...DEFAULT_SCREEN, ...(s.screen || {}),
      q: String(q).trim(),
      ...(universe && { universe }), ...(order && { order }), ...(dir && { dir }),
      ...(top && { top: Math.max(1, Math.min(20, Math.floor(top))) }),
      ...(rebalanceDays && { rebalanceDays: Math.max(1, Math.min(126, Math.floor(rebalanceDays))) }),
    };
    const changed = JSON.stringify(screen) !== JSON.stringify(s.screen);
    write('bot', { ...s, mode: 'screen', screen, budget: budget ? Math.max(100, +budget) : (s.budget ?? DEFAULT_BUDGET), ...(changed && { lastRebalance: null }) });
    logActivity(source, 'bot-strategy', { mode: 'screen', q: screen.q, top: screen.top, rebalanceDays: screen.rebalanceDays });
  } else {
    write('bot', { ...s, mode: 'signals' });
    logActivity(source, 'bot-strategy', { mode: 'signals' });
  }
  return botStatus();
}

async function runScreenCycle(source, state, held, actions, { force = false } = {}) {
  const s = botStatus();
  const due = force || !s.lastRebalance || Date.now() >= new Date(s.nextRebalance).getTime();
  if (!due) {
    actions.push({ note: `Holding screen picks until the next rebalance on ${s.nextRebalance.slice(0, 10)}.` });
    return { rebalanced: false };
  }
  const { q, universe, order, dir, top } = s.screen;
  const res = await scan({ q, universe, order, dir, limit: top });
  const picks = res.results.map((r) => r.ticker);
  const managed = new Set(s.managed);
  const reason = `screen: ${q} (top ${top} by ${order})`;

  // Only ever sell what the bot itself bought, never your other holdings.
  for (const sym of [...managed]) {
    if (picks.includes(sym)) continue;
    if (!held.has(sym)) { managed.delete(sym); continue; }
    if (state.ordersToday >= config.bot.maxOrdersPerDay) { actions.push({ note: 'Daily order limit reached.' }); break; }
    try {
      const qty = held.get(sym).qty;
      const o = await broker.placeOrder({ symbol: sym, side: 'sell', qty });
      state.ordersToday++;
      managed.delete(sym);
      actions.push({ symbol: sym, side: 'sell', orderId: o.id, note: 'dropped out of the screen' });
      logActivity(source, 'order', { symbol: sym, side: 'sell', qty, reason: `${reason}; no longer a pick` });
    } catch (e) { actions.push({ symbol: sym, error: e.message }); }
  }
  for (const sym of picks) {
    if (held.has(sym)) { if (!managed.has(sym)) actions.push({ symbol: sym, note: 'already held outside the bot; skipped' }); continue; }
    if (state.ordersToday >= config.bot.maxOrdersPerDay) { actions.push({ note: 'Daily order limit reached.' }); break; }
    try {
      const notional = Math.floor(s.perPickUsd);
      const o = await broker.placeOrder({ symbol: sym, side: 'buy', notional });
      state.ordersToday++;
      managed.add(sym);
      actions.push({ symbol: sym, side: 'buy', orderId: o.id, notional });
      logActivity(source, 'order', { symbol: sym, side: 'buy', notional, reason });
    } catch (e) { actions.push({ symbol: sym, error: e.message }); }
  }
  // Only count it as rebalanced if every pick got handled (limit hits retry next cycle).
  const complete = !actions.some((a) => a.note === 'Daily order limit reached.');
  return { rebalanced: complete, picks, managed: [...managed], asOf: res.asOf };
}

export async function runBotCycle(source = 'bot', { force = false } = {}) {
  const clock = await broker.getMarketClock().catch(() => ({ isOpen: false }));
  const mode = botStatus().mode;
  const signals = mode === 'signals' ? await getSignals() : [];
  const positions = await broker.getPositions();
  const held = new Map(positions.map((p) => [p.symbol, p]));
  const actions = [];
  let screenResult = null;

  const state = read('bot', {});
  if (state.day !== today()) Object.assign(state, { day: today(), ordersToday: 0 });

  if (!clock.isOpen) {
    actions.push({ note: 'Market is closed; no orders placed.' });
  } else if (mode === 'screen') {
    screenResult = await runScreenCycle(source, state, held, actions, { force });
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
  // Re-read so a concurrent on/off toggle or strategy change is not overwritten.
  const latest = read('bot', {});
  const update = { day: state.day, ordersToday: state.ordersToday, lastRun: new Date().toISOString() };
  if (screenResult?.managed && latest.mode === 'screen') {
    update.managed = screenResult.managed;
    if (screenResult.rebalanced) update.lastRebalance = new Date().toISOString();
  }
  write('bot', { ...latest, ...update });
  logActivity(source, 'bot-cycle', { mode, ordersPlaced: actions.filter((a) => a.orderId).length, marketOpen: clock.isOpen });
  return { ranAt: new Date().toISOString(), mode, marketOpen: clock.isOpen, actions, ...(mode === 'signals' ? { signals } : { screen: screenResult }) };
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
