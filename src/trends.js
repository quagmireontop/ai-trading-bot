// Lightweight, explainable news analysis: sentiment from a finance word list,
// ticker detection, and topic tagging. No paid AI API needed; Claude does the
// deeper reasoning over these results through the MCP tools.

const POSITIVE = ['beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'jump', 'jumps', 'gain', 'gains', 'record high', 'upgrade', 'upgraded', 'outperform', 'bullish', 'growth', 'strong', 'profit', 'boost', 'rebound', 'rise', 'rises', 'climb', 'climbs', 'optimism', 'breakthrough', 'approval', 'approved', 'raises guidance', 'buyback', 'tops', 'expands', 'deal', 'cools', 'eases', 'rate cut', 'cuts rates', 'recovery'];
const NEGATIVE = ['miss', 'misses', 'plunge', 'plunges', 'tumble', 'tumbles', 'slump', 'sink', 'sinks', 'fall', 'falls', 'drop', 'drops', 'downgrade', 'downgraded', 'underperform', 'bearish', 'loss', 'losses', 'weak', 'cuts guidance', 'layoff', 'layoffs', 'lawsuit', 'probe', 'investigation', 'recall', 'fraud', 'bankruptcy', 'default', 'recession', 'crash', 'selloff', 'sell-off', 'fears', 'warning', 'warns', 'slowdown', 'tariff', 'tariffs', 'sanctions', 'war', 'attack', 'strike', 'shutdown', 'inflation rises', 'hot inflation', 'rate hike', 'hikes rates', 'volatility', 'uncertainty'];

export const TOPICS = {
  'Fed & interest rates': ['federal reserve', 'the fed', 'fed ', 'powell', 'interest rate', 'rate cut', 'rate hike', 'fomc', 'treasury yield', 'bond yield'],
  'Inflation & economy': ['inflation', 'cpi', 'ppi', 'jobs report', 'payroll', 'unemployment', 'gdp', 'recession', 'consumer spending', 'retail sales'],
  'AI & chips': ['artificial intelligence', ' ai ', 'ai-', 'chip', 'semiconductor', 'nvidia', 'gpu', 'data center', 'openai', 'anthropic'],
  'Earnings': ['earnings', 'quarterly results', 'revenue', 'guidance', 'eps', 'profit forecast'],
  'Energy & oil': ['oil', 'opec', 'crude', 'natural gas', 'energy prices', 'brent'],
  'Trade & tariffs': ['tariff', 'trade war', 'export controls', 'trade deal', 'customs'],
  'Geopolitics': ['war', 'ukraine', 'russia', 'china', 'taiwan', 'israel', 'iran', 'middle east', 'sanctions', 'nato', 'election'],
  'Crypto': ['bitcoin', 'crypto', 'ethereum', 'stablecoin', 'coinbase'],
  'Mergers & deals': ['merger', 'acquisition', 'acquire', 'buyout', 'takeover', 'ipo'],
  'Regulation & legal': ['antitrust', 'sec ', 'regulator', 'lawsuit', 'ftc', 'doj', 'fine'],
};

export const COMPANIES = {
  AAPL: ['apple', 'iphone'], MSFT: ['microsoft'], NVDA: ['nvidia'], AMZN: ['amazon'], GOOGL: ['alphabet', 'google'],
  META: ['meta platforms', 'facebook', 'instagram'], TSLA: ['tesla'], AMD: ['amd', 'advanced micro'], NFLX: ['netflix'],
  JPM: ['jpmorgan'], BAC: ['bank of america'], XOM: ['exxon'], INTC: ['intel'], AVGO: ['broadcom'], ORCL: ['oracle'],
  CRM: ['salesforce'], DIS: ['disney'], BA: ['boeing'], WMT: ['walmart'], COIN: ['coinbase'], PLTR: ['palantir'],
  SPY: ['s&p 500', 's&p500', 'wall street', 'stocks'], QQQ: ['nasdaq'],
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countHits = (text, words) => words.reduce((n, w) => n + (new RegExp(`\\b${escape(w)}\\b`, 'i').test(text) ? 1 : 0), 0);

export function scoreArticle(article) {
  const raw = `${article.title} ${article.title} ${article.summary || ''}`; // title counts double
  const text = ` ${raw.toLowerCase()} `;
  const pos = countHits(text, POSITIVE);
  const neg = countHits(text, NEGATIVE);
  const sentiment = pos + neg === 0 ? 0 : +((pos - neg) / (pos + neg)).toFixed(2);

  const tickers = new Set(article.symbols || []);
  for (const m of raw.matchAll(/\$([A-Z]{1,5})\b|\((?:NASDAQ|NYSE|AMEX)?:?\s?([A-Z]{1,5})\)/g)) tickers.add(m[1] || m[2]);
  for (const [sym, names] of Object.entries(COMPANIES)) if (names.some((n) => text.includes(n))) tickers.add(sym);

  const topics = Object.entries(TOPICS).filter(([, words]) => words.some((w) => text.includes(w))).map(([t]) => t);
  return { sentiment, sentimentLabel: sentiment > 0.2 ? 'positive' : sentiment < -0.2 ? 'negative' : 'neutral', tickers: [...tickers], topics };
}

// Aggregate a list of scored articles into trend summaries.
export function summarizeTrends(articles) {
  const topicMap = {};
  const tickerMap = {};
  for (const a of articles) {
    for (const t of a.topics) (topicMap[t] ??= []).push(a);
    for (const s of a.tickers) (tickerMap[s] ??= []).push(a);
  }
  const agg = (map) => Object.entries(map)
    .map(([name, list]) => ({
      name,
      mentions: list.length,
      sentiment: +(list.reduce((s, a) => s + a.sentiment, 0) / list.length).toFixed(2),
      headlines: list.slice(0, 3).map((a) => ({ title: a.title, url: a.url, source: a.source })),
    }))
    .sort((a, b) => b.mentions - a.mentions);

  const overall = articles.length ? +(articles.reduce((s, a) => s + a.sentiment, 0) / articles.length).toFixed(2) : 0;
  const mood = overall > 0.1 ? 'risk-on (mostly positive news)' : overall < -0.1 ? 'risk-off (mostly negative news)' : 'mixed / neutral';
  return {
    articleCount: articles.length,
    overallSentiment: overall,
    marketMood: mood,
    topics: agg(topicMap),
    tickers: agg(tickerMap).slice(0, 20),
  };
}
