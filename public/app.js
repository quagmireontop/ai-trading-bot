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
  $('#localMcp').hidden = !!s.mcpUrl;
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
setInterval(refreshPortfolio, 30000);
setInterval(refreshNews, 5 * 60000);
