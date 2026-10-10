export const SAMPLE_RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>
<item><title>Nvidia shares surge after record data center revenue beats estimates</title><link>https://example.com/a</link><description>&lt;p&gt;Chip demand from AI keeps growing.&lt;/p&gt;</description><pubDate>Thu, 08 Oct 2026 14:00:00 GMT</pubDate></item>
<item><title>Oil prices tumble as OPEC signals output increase</title><link>https://example.com/b</link><description>Crude falls 4%.</description><pubDate>Thu, 08 Oct 2026 13:00:00 GMT</pubDate></item>
</channel></rss>`;

export const SAMPLE_ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Fed's Powell hints at rate cut as inflation cools</title><link rel="alternate" href="https://example.com/c"/><updated>2026-10-08T12:00:00Z</updated><summary>Treasury yields drop.</summary></entry></feed>`;

const now = Date.now();
const iso = (mins) => new Date(now - mins * 60000).toISOString();
export const SAMPLE_ARTICLES = [
  { title: 'Nvidia shares surge after record data center revenue beats estimates', summary: 'AI chip demand keeps growing as cloud giants expand spending.', url: 'https://example.com/1', source: 'CNBC Top News', category: 'markets', published: iso(12) },
  { title: "Fed's Powell signals rate cut as inflation cools", summary: 'Treasury yields fall; stocks rally on the news.', url: 'https://example.com/2', source: 'MarketWatch', category: 'markets', published: iso(25) },
  { title: 'Tesla stock tumbles after delivery miss and price cuts warning', summary: 'Shares drop 6% in premarket trading.', url: 'https://example.com/3', source: 'Yahoo Finance', category: 'markets', published: iso(40) },
  { title: 'Oil prices jump as Middle East tensions escalate', summary: 'Brent crude climbs above $90 amid fears of supply disruption.', url: 'https://example.com/4', source: 'BBC Business', category: 'world', published: iso(55) },
  { title: 'Apple unveils new AI features, analysts upgrade stock to outperform', summary: 'iPhone upgrade cycle seen boosting growth.', url: 'https://example.com/5', source: 'NYT Business', category: 'markets', published: iso(70) },
  { title: 'China announces new tariffs on US goods, trade war fears return', summary: 'Wall Street futures slip on the news.', url: 'https://example.com/6', source: 'CNBC World', category: 'world', published: iso(90) },
  { title: 'Microsoft and OpenAI expand data center deal', summary: 'The partnership boosts Azure growth outlook.', url: 'https://example.com/7', source: 'CNBC Finance', category: 'markets', published: iso(110) },
  { title: 'Amazon faces FTC antitrust lawsuit over marketplace fees', summary: 'Regulators say the company harmed sellers.', url: 'https://example.com/8', source: 'NYT Business', category: 'markets', published: iso(130) },
  { title: 'Jobs report shows strong payroll gains, unemployment steady', summary: 'Economy adds 250,000 jobs.', url: 'https://example.com/9', source: 'MarketWatch', category: 'markets', published: iso(150) },
  { title: 'Ukraine and Russia hold new round of talks as sanctions bite', summary: 'European markets watch closely.', url: 'https://example.com/10', source: 'BBC World', category: 'world', published: iso(170) },
  { title: 'Bitcoin climbs to record high as crypto ETFs see inflows', summary: 'Coinbase shares jump.', url: 'https://example.com/11', source: 'Yahoo Finance', category: 'markets', published: iso(200) },
  { title: 'Meta Platforms shares slump on higher AI spending forecast', summary: 'Investors worry about margins.', url: 'https://example.com/12', source: 'CNBC Top News', category: 'markets', published: iso(230) },
];
