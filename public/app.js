const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (n == null || Number.isNaN(n) ? '–' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const pct = (n) => (n == null ? '–' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const sentClass = (s) => (s > 0.2 ? 'pos' : s < -0.2 ? 'neg' : '');
const sentWord = (s) => (s > 0.2 ? 'positive' : s < -0.2 ? 'negative' : 'neutral');

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Not logged in');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const emptyRow = (cols, text) => `<tr><td colspan="${cols}" class="empty">${text}</td></tr>`;

async function loadStatus() {
  const s = await api('/status');
  $('#logout').hidden = !s.loginEnabled;
  if (s.mcpUrl) { $('#remoteMcp').hidden = false; $('#mcpUrl').textContent = s.mcpUrl; }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  $('#localMcp').hidden = !!s.mcpUrl || !isLocal;
  $('#mcpMissing').hidden = !!s.mcpUrl || isLocal;
  if (s.mcpScript) $('#mcpConfig').textContent = `"trading-bot": { "command": "node", "args": [${JSON.stringify(s.mcpScript)}] }`;
  $('#mode').textContent = s.demoMode ? 'DEMO' : 'PAPER';
  $('#mode').className = `badge ${s.demoMode ? 'warn' : ''}`;
  $('#mode').title = s.demoMode ? 'No Alpaca keys found: simulated portfolio and prices' : 'Connected to Alpaca paper trading';
  $('#market').textContent = s.clock?.demo ? 'Simulated market' : s.clock?.isOpen ? 'Market open' : 'Market closed';
  $('#botToggle').checked = s.bot.enabled;
  $('#botToggle').title = `Every ${s.bot.intervalMinutes} min · max $${s.bot.maxPositionUsd}/position · ${s.bot.ordersToday}/${s.bot.maxOrdersPerDay} orders today`;
}

async function loadAccount() {
  const [a, positions, orders] = await Promise.all([api('/account'), api('/positions'), api('/orders')]);
  $('#kEquity').textContent = usd(a.equity);
  const day = a.equity - a.lastEquity;
  $('#kDay').innerHTML = `<span class="${cls(day)}">${usd(day)} <small>${pct((day / a.lastEquity) * 100)}</small></span>`;
  $('#kCash').textContent = usd(a.cash);
  $('#kBp').textContent = usd(a.buyingPower);

  $('#positions tbody').innerHTML = positions.length ? positions.map((p) => `
    <tr class="click" data-sym="${esc(p.symbol)}"><td><strong>${esc(p.symbol)}</strong></td><td class="num">${+p.qty.toFixed(4)}</td>
    <td class="num">${usd(p.avgPrice)}</td><td class="num">${usd(p.price)}</td><td class="num">${usd(p.marketValue)}</td>
    <td class="num ${cls(p.unrealizedPl)}">${usd(p.unrealizedPl)}<br><small>${pct(p.unrealizedPlPct)}</small></td></tr>`).join('')
    : emptyRow(6, 'No open positions yet');

  $('#orders tbody').innerHTML = orders.length ? orders.slice(0, 10).map((o) => `
    <tr><td class="muted">${ago(o.submittedAt)}</td><td><strong>${esc(o.symbol)}</strong></td>
    <td><span class="chip ${o.side}">${o.side}</span></td>
    <td class="num">${o.qty != null ? +(+o.qty).toFixed(4) : usd(o.notional)}</td><td>${esc(o.status)}</td></tr>`).join('')
    : emptyRow(5, 'No orders yet');
}

function barList(el, items, label) {
  const max = Math.max(1, ...items.map((i) => i.mentions));
  el.innerHTML = items.length ? items.slice(0, 8).map((i) => `
    <li data-${label}="${esc(i.name)}" title="${esc(i.headlines.map((h) => h.title).join('\n'))}">
      <span>${esc(i.name)}</span><span class="muted small">${i.mentions} · <span class="${sentClass(i.sentiment)}">${sentWord(i.sentiment)}</span></span>
      <span class="bar"><i class="${sentClass(i.sentiment)}" style="width:${(i.mentions / max) * 100}%"></i></span>
    </li>`).join('') : '<li class="muted">No data yet</li>';
}

async function loadTrends() {
  const t = await api('/trends');
  $('#mood').textContent = t.marketMood;
  $('#gaugeDot').style.left = `${50 + Math.max(-1, Math.min(1, t.overallSentiment * 2)) * 50}%`;
  $('#trendsTime').textContent = `${t.articleCount} headlines · updated ${ago(t.fetchedAt)}`;
  barList($('#topics'), t.topics, 'topic');
  barList($('#tickers'), t.tickers, 'sym');
}

async function loadSignals() {
  const s = await api('/signals');
  $('#signals tbody').innerHTML = s.map((x) => `
    <tr class="click" data-sym="${esc(x.symbol)}"><td><strong>${esc(x.symbol)}</strong></td><td><span class="chip ${x.action}">${x.action}</span></td>
    <td class="num ${cls(x.score)}">${x.score.toFixed(2)}</td><td class="num">${x.mentions}</td>
    <td class="num ${sentClass(x.newsSentiment)}">${x.newsSentiment.toFixed(2)}</td><td class="num ${cls(x.momentumPct)}">${pct(x.momentumPct)}</td>
    <td class="wrap">${esc(x.headlines[0] || '—')}</td></tr>`).join('');
}

let newsTimer;
async function loadNews() {
  const cat = document.querySelector('input[name=cat]:checked').value;
  const q = $('#newsSearch').value.trim();
  const params = new URLSearchParams({ limit: 60, ...(cat && { category: cat }), ...(q && { q }) });
  const n = await api(`/news?${params}`);
  $('#news').innerHTML = n.articles.length ? n.articles.map((a) => `
    <li><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>
      ${a.summary ? `<p>${esc(a.summary.slice(0, 200))}${a.summary.length > 200 ? '…' : ''}</p>` : ''}
      <div class="meta"><span>${esc(a.source)}</span><span>${ago(a.published)}</span>
        <span class="chip ${sentClass(a.sentiment)}">${a.sentimentLabel}</span>
        ${a.tickers.map((t) => `<span class="chip tkr" data-sym="${esc(t)}">${esc(t)}</span>`).join('')}
        ${a.topics.slice(0, 2).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
      </div></li>`).join('') : '<li class="muted">No headlines match. News feeds may be unreachable from this server.</li>';
  $('#newsErrors').textContent = n.sourceErrors.length ? `Unreachable sources: ${n.sourceErrors.map((e) => e.source).join(', ')}` : '';
}

async function loadActivity() {
  const items = await api('/activity');
  const label = { 'claude-mcp': 'Claude', website: 'Website', bot: 'Bot' };
  $('#activity').innerHTML = items.length ? items.map((a) => {
    let what = a.action;
    if (a.action === 'order') what = `${a.side} ${a.symbol} ${a.qty ? `${+(+a.qty).toFixed(4)} sh` : usd(a.notional)}`;
    if (a.action === 'bot-cycle') what = `bot run · ${a.ordersPlaced} order(s)${a.marketOpen === false ? ' · market closed' : ''}`;
    return `<li><span><span class="src ${esc(a.source)}">${esc(label[a.source] || a.source)}</span> <span class="muted">${ago(a.time)}</span></span>
      <span>${esc(what)}</span>${a.reason ? `<span class="muted">${esc(a.reason)}</span>` : ''}${a.error ? `<span class="neg">${esc(a.error)}</span>` : ''}</li>`;
  }).join('') : '<li class="muted">Nothing yet. Trades from this page, the bot and Claude will appear here.</li>';
}

function sparkline(bars) {
  if (!bars.length) return '';
  const c = bars.map((b) => b.c);
  const min = Math.min(...c); const max = Math.max(...c);
  const pts = c.map((v, i) => `${(i / (c.length - 1)) * 100},${38 - ((v - min) / (max - min || 1)) * 36}`).join(' ');
  const color = c.at(-1) >= c[0] ? 'var(--pos)' : 'var(--neg)';
  return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

async function showDetail(sym) {
  const dlg = $('#detail');
  $('#detailBody').innerHTML = `<h2>${esc(sym)}</h2><p class="muted">Loading…</p>`;
  dlg.showModal();
  try {
    const [q, a, bars] = await Promise.all([api(`/quote/${sym}`), api(`/analyze/${sym}`), api(`/bars/${sym}?days=30`)]);
    $('#detailBody').innerHTML = `
      <h2>${esc(sym)} <span class="chip ${a.action}">${a.action}</span></h2>
      <p><strong style="font-size:22px">${usd(q.price)}</strong> <span class="${cls(q.changePct)}">${pct(q.changePct)}</span> <span class="muted small">today</span></p>
      ${sparkline(bars)}<p class="muted small">Last 30 trading days</p>
      <h3>Why</h3><ul class="small">${a.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}<li>Combined score ${a.score.toFixed(2)} (buy above 0.30, sell below −0.30)</li></ul>
      ${a.headlines.length ? `<h3>Headlines</h3><ul class="small">${a.headlines.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
      <button id="tradeThis">Trade ${esc(sym)}</button>`;
    $('#tradeThis').onclick = () => { $('#tradeForm').symbol.value = sym; dlg.close(); $('#tradeForm').amount.focus(); updateQuote(); };
  } catch (e) {
    $('#detailBody').innerHTML = `<h2>${esc(sym)}</h2><p class="neg">${esc(e.message)}</p>`;
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-sym]');
  if (el) showDetail(el.dataset.sym);
  const topic = e.target.closest('[data-topic]');
  if (topic) { $('#newsSearch').value = ''; $('#cAll').checked = true; filterByTopic(topic.dataset.topic); }
});

async function filterByTopic(topic) {
  const n = await api('/news?limit=100');
  const list = n.articles.filter((a) => a.topics.includes(topic));
  $('#news').innerHTML = `<li class="muted small">Showing “${esc(topic)}” · <a href="#" id="clearTopic">show all</a></li>` + list.map((a) => `
    <li><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>
    <div class="meta"><span>${esc(a.source)}</span><span>${ago(a.published)}</span><span class="chip ${sentClass(a.sentiment)}">${a.sentimentLabel}</span></div></li>`).join('');
  $('#clearTopic').onclick = (ev) => { ev.preventDefault(); loadNews(); };
  $('#news').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let quoteTimer;
async function updateQuote() {
  const sym = $('#tradeForm').symbol.value.trim().toUpperCase();
  if (!sym) { $('#quoteLine').textContent = ''; return; }
  try {
    const q = await api(`/quote/${sym}`);
    $('#quoteLine').innerHTML = `${esc(sym)} ${usd(q.price)} <span class="${cls(q.changePct)}">${pct(q.changePct)}</span>`;
  } catch { $('#quoteLine').textContent = 'No quote for that symbol'; }
}
$('#tradeForm').symbol.addEventListener('input', () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(updateQuote, 400); });

$('#tradeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { symbol: f.symbol.value.trim().toUpperCase(), side: f.side.value, [f.unit.value]: Number(f.amount.value) };
  const btn = f.querySelector('button');
  btn.disabled = true;
  $('#tradeMsg').textContent = '';
  try {
    const o = await api('/orders', { method: 'POST', body });
    $('#tradeMsg').innerHTML = `<span class="pos">Order ${esc(o.status)}: ${esc(o.side)} ${esc(o.symbol)}</span>`;
    f.amount.value = '';
    refreshPortfolio();
  } catch (err) {
    $('#tradeMsg').innerHTML = `<span class="neg">${esc(err.message)}</span>`;
  } finally { btn.disabled = false; }
});

$('#botToggle').addEventListener('change', async (e) => {
  try { await api('/bot', { method: 'POST', body: { enabled: e.target.checked } }); loadActivity(); }
  catch (err) { e.target.checked = !e.target.checked; alert(err.message); }
});
$('#runBot').addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = 'Running…';
  try { const r = await api('/bot/run', { method: 'POST' }); if (!r.marketOpen) alert('Market is closed: signals refreshed, no orders placed.'); refreshPortfolio(); loadSignals(); }
  catch (err) { alert(err.message); }
  finally { e.target.disabled = false; e.target.textContent = 'Run once'; }
});
document.querySelectorAll('input[name=cat]').forEach((r) => r.addEventListener('change', loadNews));
$('#newsSearch').addEventListener('input', () => { clearTimeout(newsTimer); newsTimer = setTimeout(loadNews, 300); });



// ---------- Backtesting ----------
let strategies = [];
async function loadStrategies() {
  strategies = await api('/backtest/strategies');
  $('#btStrategy').innerHTML = strategies.map((st) => `<option value="${esc(st.key)}">${esc(st.name)}</option>`).join('');
  renderParams();
}
function renderParams() {
  const st = strategies.find((x) => x.key === $('#btStrategy').value);
  if (!st) return;
  $('#btDesc').textContent = st.description;
  $('#btParams').innerHTML = Object.entries(st.params).map(([k, p]) => `
    <label>${esc(k[0].toUpperCase() + k.slice(1))}<input name="p_${esc(k)}" type="number" value="${p.default}" min="${p.min}" max="${p.max}" step="any"></label>`).join('');
}
$('#btStrategy').addEventListener('change', renderParams);

function btChart(curve, capital, el = $('#btChart')) {
  const W = Math.max(300, el.clientWidth || 800), H = 240, L = 56, R = 8, T = 10, B = 24;
  const vals = curve.flatMap((p) => [p.strategy, p.buyAndHold]).filter((v) => v != null);
  let min = Math.min(...vals, capital), max = Math.max(...vals, capital);
  const pad = (max - min) * 0.05 || 1; min -= pad; max += pad;
  const x = (i) => L + (i / (curve.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const line = (key) => { let pen = 'M'; return curve.map((p, i) => { if (p[key] == null) { pen = 'M'; return ''; } const seg = `${pen}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`; pen = 'L'; return seg; }).join(''); };
  const ticks = [min + pad, capital, max - pad].filter((v, i, a) => a.findIndex((w) => Math.abs(w - v) < (max - min) * 0.08) === i);
  const fmt = (v) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Equity curve: strategy versus buy and hold">
    ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('')}
    <text x="${L}" y="${H - 6}">${esc(curve[0].t)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(curve.at(-1).t)}</text>
    <path class="bh" d="${line('buyAndHold')}" fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <path class="strat" d="${line('strategy')}" fill="none" stroke-width="2" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function btForm() {
  const f = $('#btForm');
  const params = {};
  f.querySelectorAll('[name^=p_]').forEach((el) => { params[el.name.slice(2)] = Number(el.value); });
  return { symbol: f.symbol.value.trim().toUpperCase(), strategy: f.strategy.value, params, days: Number(f.days.value), capital: Number(f.capital.value) };
}

$('#btForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; $('#btMsg').textContent = 'Running…'; $('#btCompareResult').hidden = true;
  try {
    const r = await api('/backtest', { method: 'POST', body: btForm() });
    const res = r.result, bh = r.buyAndHold;
    const beat = res.totalReturnPct - bh.totalReturnPct;
    $('#btMsg').innerHTML = `<strong>${esc(r.symbol)}</strong> · ${esc(r.strategyName)} · ${esc(r.from)} to ${esc(r.to)}: <span class="${cls(beat)}">${beat >= 0 ? 'beat' : 'trailed'} buy and hold by ${Math.abs(beat).toFixed(1)} points</span>`;
    const kpi = (label, v, sub) => `<div><span>${label}</span><strong>${v}</strong>${sub ? ` <small>${sub}</small>` : ''}</div>`;
    $('#btKpis').innerHTML = [
      kpi('Strategy return', `<span class="${cls(res.totalReturnPct)}">${pct(res.totalReturnPct)}</span>`, `ends ${usd(res.endingValue)}`),
      kpi('Buy and hold', `<span class="${cls(bh.totalReturnPct)}">${pct(bh.totalReturnPct)}</span>`, `ends ${usd(bh.endingValue)}`),
      kpi('Worst drop', `<span class="neg">-${res.maxDrawdownPct.toFixed(1)}%</span>`, `vs -${bh.maxDrawdownPct.toFixed(1)}%`),
      kpi('Trades', res.trades, res.winRatePct != null ? `${res.winRatePct}% winners` : ''),
      kpi('Sharpe', res.sharpe ?? '–', `vs ${bh.sharpe ?? '–'}`),
      kpi('Time invested', `${res.timeInMarketPct}%`),
    ].join('');
    $('#btResult').hidden = false;
    $('#btChart').innerHTML = btChart(r.curve, r.capital);
    const rows = [...r.trades].reverse().slice(0, 10);
    if (r.openTrade) rows.unshift({ entryDate: r.openTrade.entryDate, exitDate: 'still open', entryPrice: r.openTrade.entryPrice, exitPrice: null, returnPct: r.openTrade.returnPct });
    $('#btTrades tbody').innerHTML = rows.length ? rows.map((t) => `<tr><td>${esc(t.entryDate)}</td><td>${esc(t.exitDate)}</td><td class="num">${usd(t.entryPrice)}</td><td class="num">${t.exitPrice != null ? usd(t.exitPrice) : '–'}</td><td class="num ${cls(t.returnPct)}">${pct(t.returnPct)}</td></tr>`).join('') : emptyRow(5, 'No trades in this period');
    $('#btResult').hidden = false;
  } catch (err) {
    $('#btMsg').innerHTML = `<span class="neg">${esc(err.message)}</span>`;
  } finally { btn.disabled = false; }
});

$('#btCompare').addEventListener('click', async (e) => {
  e.target.disabled = true; $('#btMsg').textContent = 'Comparing…'; $('#btResult').hidden = true;
  try {
    const { symbol, days, capital } = btForm();
    const c = await api('/backtest/compare', { method: 'POST', body: { symbol, days, capital } });
    $('#btMsg').innerHTML = `<strong>${esc(c.symbol)}</strong> · default settings · ${esc(c.from)} to ${esc(c.to)}`;
    $('#btCompareResult').innerHTML = `<table><thead><tr><th>Strategy</th><th class="num">Return</th><th class="num">vs buy and hold</th><th class="num">Worst drop</th><th class="num">Trades</th><th class="num">Sharpe</th></tr></thead><tbody>
      ${c.strategies.map((s) => `<tr><td>${esc(s.name)}</td><td class="num ${cls(s.totalReturnPct)}">${pct(s.totalReturnPct)}</td><td class="num ${cls(s.totalReturnPct - c.buyAndHold.totalReturnPct)}">${pct(s.totalReturnPct - c.buyAndHold.totalReturnPct).replace('%', ' pts')}</td><td class="num">-${s.maxDrawdownPct.toFixed(1)}%</td><td class="num">${s.trades}</td><td class="num">${s.sharpe ?? '–'}</td></tr>`).join('')}
      <tr><td class="muted">Buy and hold</td><td class="num ${cls(c.buyAndHold.totalReturnPct)}">${pct(c.buyAndHold.totalReturnPct)}</td><td class="num">–</td><td class="num">-${c.buyAndHold.maxDrawdownPct.toFixed(1)}%</td><td class="num">1</td><td class="num">${c.buyAndHold.sharpe ?? '–'}</td></tr>
    </tbody></table>`;
    $('#btCompareResult').hidden = false;
  } catch (err) {
    $('#btMsg').innerHTML = `<span class="neg">${esc(err.message)}</span>`;
  } finally { e.target.disabled = false; }
});

// ---------- Screener ----------
async function loadScreenerFields() {
  const f = await api('/screener/fields');
  $('#scFields').innerHTML = Object.entries(f.fields).map(([k, d]) => `<li><code>${esc(k)}</code> ${esc(d)}</li>`).join('');
  $('#scOrder').innerHTML = Object.keys(f.fields).filter((k) => !k.startsWith('above_')).map((k) => `<option value="${esc(k)}"${k === 'return_20d' ? ' selected' : ''}>${esc(k)}</option>`).join('');
}
const scBody = () => Object.fromEntries(new FormData($('#scForm')).entries());

$('#scForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true; $('#scMsg').textContent = 'Running… the first run loads price history for every stock and can take a little while.'; $('#scNowResult').hidden = true;
  try {
    const r = await api('/screener/backtest', { method: 'POST', body: scBody() });
    const res = r.result;
    const beat = r.benchmarkReturnPct == null ? null : res.totalReturnPct - r.benchmarkReturnPct;
    $('#scMsg').innerHTML = `<code>${esc(r.q)}</code> · ${r.universeSize} stocks · ${esc(r.from)} to ${esc(r.to)}${beat == null ? '' : `: <span class="${cls(beat)}">${beat >= 0 ? 'beat' : 'trailed'} ${esc(r.benchmark)} by ${Math.abs(beat).toFixed(1)} points</span>`}`;
    const kpi = (label, v, sub) => `<div><span>${label}</span><strong>${v}</strong>${sub ? ` <small>${sub}</small>` : ''}</div>`;
    $('#scKpis').innerHTML = [
      kpi('Screen return', `<span class="${cls(res.totalReturnPct)}">${pct(res.totalReturnPct)}</span>`, `ends ${usd(res.endingValue)}`),
      kpi(esc(r.benchmark), r.benchmarkReturnPct == null ? '–' : `<span class="${cls(r.benchmarkReturnPct)}">${pct(r.benchmarkReturnPct)}</span>`),
      kpi('Per year', pct(res.annualReturnPct)),
      kpi('Worst drop', `<span class="neg">-${res.maxDrawdownPct.toFixed(1)}%</span>`),
      kpi('Winning periods', res.winningPeriodsPct == null ? '–' : `${res.winningPeriodsPct}%`, `${res.periodsInvested}/${res.periods} invested`),
      kpi('Avg picks', res.avgPicks),
    ].join('');
    $('#scResult').hidden = false;
    $('#scChart').innerHTML = btChart(r.curve, r.capital, $('#scChart'));
    $('#scPeriods tbody').innerHTML = [...r.periods].reverse().map((p) => `<tr><td>${esc(p.date)}</td><td class="picks">${p.picks.length ? esc(p.picks.join(', ')) : 'no matches, stayed in cash'}</td><td class="num ${cls(p.returnPct)}">${pct(p.returnPct)}</td><td class="num">${usd(p.equity)}</td></tr>`).join('');
  } catch (err) {
    $('#scMsg').innerHTML = `<span class="neg">${esc(err.message)}</span>`;
  } finally { btn.disabled = false; }
});

$('#scNow').addEventListener('click', async (e) => {
  e.target.disabled = true; $('#scMsg').textContent = 'Scanning…'; $('#scResult').hidden = true;
  try {
    const b = scBody();
    const r = await api('/screener/scan', { method: 'POST', body: { q: b.q, universe: b.universe, order: b.order, dir: b.dir, limit: 50 } });
    $('#scMsg').innerHTML = `<strong>${r.count}</strong> of ${r.universeSize} stocks match as of ${esc(r.asOf)}`;
    $('#scNowResult').innerHTML = r.results.length ? `<table><thead><tr><th>Symbol</th><th class="num">Price</th><th class="num">RSI 14</th><th class="num">20-day</th><th class="num">Below 1-yr high</th></tr></thead><tbody>
      ${r.results.map((x) => `<tr class="click" data-sym="${esc(x.ticker)}"><td><strong>${esc(x.ticker)}</strong></td><td class="num">${usd(x.close)}</td><td class="num">${x.rsi_14 ?? '–'}</td><td class="num ${cls(x.return_20d)}">${pct(x.return_20d)}</td><td class="num">${x.from_high_252 == null ? '–' : `${x.from_high_252}%`}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Nothing matches today.</p>';
    $('#scNowResult').hidden = false;
  } catch (err) {
    $('#scMsg').innerHTML = `<span class="neg">${esc(err.message)}</span>`;
  } finally { e.target.disabled = false; }
});

$('#mcpUrl').onclick = () => navigator.clipboard?.writeText($('#mcpUrl').textContent);
const safe = (fn) => fn().catch((e) => console.error(e));
function refreshPortfolio() {
  loadAccount().then(() => { $('#accountError').hidden = true; }).catch((e) => {
    $('#accountError').hidden = false;
    $('#accountError').textContent = /401|unauthorized/i.test(e.message)
      ? 'Alpaca rejected your API keys. Put your PAPER keys in .env, then close the bot window and start it again.'
      : `Could not load your account: ${e.message}`;
  });
  safe(loadActivity); safe(loadStatus);
}
function refreshNews() { safe(loadTrends); safe(loadNews); safe(loadSignals); }

refreshPortfolio();
refreshNews();
safe(loadStrategies);
safe(loadScreenerFields);
setInterval(refreshPortfolio, 30000);
setInterval(refreshNews, 5 * 60000);
