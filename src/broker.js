// Brokerage layer. Talks to Alpaca's PAPER trading API when keys are set,
// otherwise runs a simulated $100k demo portfolio so everything still works.
import { config, demoMode } from './config.js';
import { read, write } from './store.js';

const headers = () => ({
  'APCA-API-KEY-ID': config.alpaca.keyId,
  'APCA-API-SECRET-KEY': config.alpaca.secretKey,
  'Content-Type': 'application/json',
});

async function alpaca(base, path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${data?.message || text}`);
  return data;
}
const trading = (path, opts) => alpaca(config.alpaca.tradingUrl, path, opts);
const market = (path, opts) => alpaca(config.alpaca.dataUrl, path, opts);

// ---------- Demo simulator ----------
const BASE_PRICES = { AAPL: 230, MSFT: 430, NVDA: 125, AMZN: 190, GOOGL: 165, META: 560, TSLA: 240, SPY: 570, QQQ: 490, AMD: 155, NFLX: 700, JPM: 210, XOM: 115, BAC: 40 };

function seeded(symbol, n) {
  let h = 2166136261;
  for (const c of `${symbol}:${n}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}
// Deterministic random walk per symbol per day, plus a little intraday drift.
function demoBars(symbol, days = 60) {
  let price = BASE_PRICES[symbol] ?? 20 + seeded(symbol, 0) * 200;
  const today = Math.floor(Date.now() / 86400000);
  const bars = [];
  for (let d = today - days; d <= today; d++) {
    const open = price;
    price = Math.max(1, price * (1 + (seeded(symbol, d) - 0.48) * 0.04));
    bars.push({ t: new Date(d * 86400000).toISOString(), o: open, c: price, h: Math.max(open, price) * 1.005, l: Math.min(open, price) * 0.995, v: 1e6 });
  }
  return bars;
}
function demoPrice(symbol) {
  const bars = demoBars(symbol, 1);
  const minute = Math.floor(Date.now() / 60000);
  return +(bars.at(-1).c * (1 + (seeded(symbol, minute) - 0.5) * 0.004)).toFixed(2);
}
function demoState() {
  return read('demo-portfolio', { cash: 100000, positions: {}, orders: [] });
}

// ---------- Public API ----------
export async function getAccount() {
  if (!demoMode) {
    const a = await trading('/v2/account');
    return { mode: 'paper', cash: +a.cash, equity: +a.equity, buyingPower: +a.buying_power, lastEquity: +a.last_equity, status: a.status };
  }
  const s = demoState();
  const positions = await getPositions();
  const value = positions.reduce((sum, p) => sum + p.marketValue, 0);
  return { mode: 'demo', cash: s.cash, equity: s.cash + value, buyingPower: s.cash, lastEquity: 100000, status: 'ACTIVE' };
}

export async function getPositions() {
  if (!demoMode) {
    const list = await trading('/v2/positions');
    return list.map((p) => ({
      symbol: p.symbol, qty: +p.qty, avgPrice: +p.avg_entry_price, price: +p.current_price,
      marketValue: +p.market_value, unrealizedPl: +p.unrealized_pl, unrealizedPlPct: +p.unrealized_plpc * 100,
    }));
  }
  const s = demoState();
  return Object.entries(s.positions).map(([symbol, p]) => {
    const price = demoPrice(symbol);
    return {
      symbol, qty: p.qty, avgPrice: p.avgPrice, price, marketValue: p.qty * price,
      unrealizedPl: (price - p.avgPrice) * p.qty, unrealizedPlPct: ((price - p.avgPrice) / p.avgPrice) * 100,
    };
  });
}

export async function getOrders(limit = 50) {
  if (!demoMode) {
    const list = await trading(`/v2/orders?status=all&limit=${limit}&direction=desc`);
    return list.map((o) => ({
      id: o.id, symbol: o.symbol, side: o.side, type: o.type, qty: o.qty ? +o.qty : null, notional: o.notional ? +o.notional : null,
      limitPrice: o.limit_price ? +o.limit_price : null, status: o.status, filledPrice: o.filled_avg_price ? +o.filled_avg_price : null,
      submittedAt: o.submitted_at,
    }));
  }
  return demoState().orders.slice(0, limit);
}

export async function getQuote(symbol) {
  symbol = symbol.toUpperCase();
  if (!demoMode) {
    const s = await market(`/v2/stocks/${encodeURIComponent(symbol)}/snapshot?feed=iex`);
    const price = s.latestTrade?.p ?? s.dailyBar?.c;
    const prev = s.prevDailyBar?.c;
    return { symbol, price, prevClose: prev, changePct: prev ? ((price - prev) / prev) * 100 : null, time: s.latestTrade?.t };
  }
  const bars = demoBars(symbol, 2);
  const price = demoPrice(symbol);
  const prev = bars.at(-2).c;
  return { symbol, price, prevClose: +prev.toFixed(2), changePct: ((price - prev) / prev) * 100, time: new Date().toISOString(), demo: true };
}

export async function getBars(symbol, days = 30) {
  symbol = symbol.toUpperCase();
  if (!demoMode) {
    const start = new Date(Date.now() - (days * 1.6 + 5) * 86400000).toISOString().slice(0, 10);
    const r = await market(`/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Day&start=${start}&limit=1000&feed=iex&adjustment=split`);
    return (r.bars || []).slice(-days);
  }
  return demoBars(symbol, days);
}

export async function placeOrder({ symbol, side, qty, notional, type = 'market', limitPrice }) {
  symbol = symbol.toUpperCase();
  if (!['buy', 'sell'].includes(side)) throw new Error('side must be buy or sell');
  if (!qty && !notional) throw new Error('Provide qty (shares) or notional (dollars)');
  if (type === 'limit' && !limitPrice) throw new Error('limitPrice is required for limit orders');
  const orderValue = notional ?? qty * (limitPrice ?? (await getQuote(symbol)).price);
  if (side === 'buy' && orderValue > config.bot.maxPositionUsd) {
    throw new Error(`Order value $${orderValue.toFixed(2)} is over the MAX_POSITION_USD safety limit of $${config.bot.maxPositionUsd}`);
  }

  if (!demoMode) {
    const body = { symbol, side, type, time_in_force: 'day' };
    if (notional) body.notional = String(notional); else body.qty = String(qty);
    if (type === 'limit') body.limit_price = String(limitPrice);
    const o = await trading('/v2/orders', { method: 'POST', body });
    return { id: o.id, symbol, side, type, qty: o.qty ? +o.qty : null, notional: o.notional ? +o.notional : null, status: o.status, submittedAt: o.submitted_at };
  }

  // Demo: fill market orders instantly at the simulated price.
  const s = demoState();
  const price = type === 'limit' ? limitPrice : demoPrice(symbol);
  const shares = qty ?? +(notional / price).toFixed(4);
  const cost = shares * price;
  const pos = s.positions[symbol] ?? { qty: 0, avgPrice: 0 };
  if (side === 'buy') {
    if (cost > s.cash) throw new Error('Not enough demo cash');
    pos.avgPrice = (pos.avgPrice * pos.qty + cost) / (pos.qty + shares);
    pos.qty += shares;
    s.cash -= cost;
  } else {
    if (shares > pos.qty + 1e-9) throw new Error(`You only hold ${pos.qty} ${symbol}; short selling is disabled in demo mode`);
    pos.qty -= shares;
    s.cash += cost;
  }
  if (pos.qty > 1e-9) s.positions[symbol] = pos; else delete s.positions[symbol];
  const order = { id: `demo-${Date.now()}`, symbol, side, type, qty: shares, notional: notional ?? null, status: 'filled', filledPrice: price, submittedAt: new Date().toISOString() };
  s.orders.unshift(order);
  s.orders = s.orders.slice(0, 200);
  write('demo-portfolio', s);
  return order;
}

export async function cancelOrder(id) {
  if (!demoMode) {
    await trading(`/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { id, status: 'cancel_requested' };
  }
  return { id, status: 'already_filled', note: 'Demo orders fill instantly' };
}

export async function getMarketClock() {
  if (!demoMode) {
    const c = await trading('/v2/clock');
    return { isOpen: c.is_open, nextOpen: c.next_open, nextClose: c.next_close };
  }
  return { isOpen: true, demo: true };
}

// Alpaca's free news API (Benzinga headlines). Only available with keys.
export async function getBrokerNews(symbols = [], limit = 30) {
  if (demoMode) return [];
  const q = symbols.length ? `&symbols=${symbols.join(',')}` : '';
  const r = await market(`/v1beta1/news?limit=${limit}${q}`);
  return (r.news || []).map((n) => ({
    title: n.headline, summary: n.summary, url: n.url, source: n.source || 'Benzinga', published: n.created_at, symbols: n.symbols || [],
  }));
}
