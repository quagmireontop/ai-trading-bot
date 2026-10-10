// Pulls the latest market + world headlines from free RSS feeds (and Alpaca's
// news API when keys are set), de-duplicates them and caches for a few minutes.
import { XMLParser } from 'fast-xml-parser';
import { config } from './config.js';
import { getBrokerNews } from './broker.js';
import { scoreArticle } from './trends.js';

export const FEEDS = [
  { name: 'Yahoo Finance', category: 'markets', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'CNBC Top News', category: 'markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { name: 'CNBC Finance', category: 'markets', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664' },
  { name: 'MarketWatch', category: 'markets', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'NYT Business', category: 'markets', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml' },
  { name: 'BBC Business', category: 'markets', url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'CNBC World', category: 'world', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362' },
  { name: 'BBC World', category: 'world', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'NYT World', category: 'world', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
  ...config.extraFeeds.map((url) => ({ name: new URL(url).hostname, category: 'custom', url })),
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
const CACHE_MS = 5 * 60 * 1000;
let cache = { at: 0, articles: [], errors: [] };

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return text(v['#text'] ?? v['@href'] ?? '');
  return String(v).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
};

export function parseFeed(xml, feed) {
  const doc = parser.parse(xml);
  const items = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.['rdf:RDF']?.item ?? [];
  return (Array.isArray(items) ? items : [items]).map((it) => {
    const link = Array.isArray(it.link) ? it.link.find((l) => l['@rel'] !== 'self') ?? it.link[0] : it.link;
    const published = it.pubDate || it.published || it.updated || it['dc:date'];
    const date = published ? new Date(text(published)) : null;
    return {
      title: text(it.title),
      summary: text(it.description || it.summary || it.content).slice(0, 400),
      url: text(link),
      source: feed.name,
      category: feed.category,
      published: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    };
  }).filter((a) => a.title);
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (ai-trading-bot news scanner)' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text(), feed);
}

export async function fetchAllNews({ force = false } = {}) {
  if (!force && Date.now() - cache.at < CACHE_MS && cache.articles.length) return cache;
  const errors = [];
  const results = await Promise.all(FEEDS.map((f) => fetchFeed(f).catch((e) => { errors.push({ source: f.name, error: e.message }); return []; })));
  const broker = await getBrokerNews(config.bot.watchlist, 50).catch((e) => { errors.push({ source: 'Alpaca News', error: e.message }); return []; });
  const all = [...results.flat(), ...broker.map((b) => ({ ...b, category: 'markets' }))];

  const seen = new Set();
  const articles = all
    .filter((a) => {
      const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((a) => ({ ...a, ...scoreArticle(a) }))
    .sort((a, b) => (b.published || '').localeCompare(a.published || ''));

  cache = { at: Date.now(), articles, errors };
  return cache;
}

export async function getNews({ query, category, symbol, limit = 30 } = {}) {
  const { articles, errors, at } = await fetchAllNews();
  let list = articles;
  if (category) list = list.filter((a) => a.category === category);
  if (symbol) list = list.filter((a) => a.tickers.includes(symbol.toUpperCase()));
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((a) => `${a.title} ${a.summary}`.toLowerCase().includes(q));
  }
  return { fetchedAt: new Date(at).toISOString(), count: list.length, articles: list.slice(0, limit), sourceErrors: errors };
}

// Test hook: lets tests inject articles without network access.
export function _setCache(articles) {
  cache = { at: Date.now(), articles: articles.map((a) => ({ ...a, ...scoreArticle(a) })), errors: [] };
}
