# AI Trading Bot

A website + MCP server that connects your brokerage to Claude. The bot scans the latest
stock market and world news, scores it for sentiment, finds trending topics and tickers,
combines that with price momentum to make buy / sell / hold signals, and can trade on its own.
Claude gets the same tools through MCP, and everything Claude, the bot and you do shows up
in one activity feed on the site.

**Paper trading only.** It talks to Alpaca's paper (fake money) API. The live trading
endpoint is not wired in at all. Without keys it runs a simulated $100k demo portfolio.

## Quick start

```bash
npm install
cp .env.example .env        # optional: add Alpaca paper keys
npm start                   # http://localhost:3000
npm test                    # runs the test suite offline
```

## Connect your Alpaca paper account

1. Create a free account at https://alpaca.markets and switch to **Paper Trading**.
2. Generate API keys on the paper dashboard.
3. Put them in `.env` (never in chat, never in git):
   ```
   ALPACA_KEY_ID=...
   ALPACA_SECRET_KEY=...
   ```
4. Restart. The header badge changes from **DEMO** to **PAPER**. You also get Alpaca's
   free news feed (Benzinga headlines) on top of the RSS sources.

## Connect Claude

The MCP server exposes these tools: `get_account`, `get_positions`, `get_orders`,
`get_quote`, `get_price_history`, `get_news`, `get_market_trends`, `analyze_stock`,
`get_trade_signals`, `place_order`, `cancel_order`, `get_bot_status`, `set_bot_enabled`,
`run_bot_cycle`, `set_bot_strategy`, `get_activity`, `list_backtest_strategies`, `run_backtest`, `compare_strategies`, `list_screener_fields`, `scan_stocks`, `backtest_scan`.

**Claude Code / Claude Desktop on your computer (stdio):**

```bash
claude mcp add trading-bot -- node /full/path/to/trading-bot/src/mcp-stdio.js
```

For Claude Desktop, add to `claude_desktop_config.json`:

```json
{ "mcpServers": { "trading-bot": { "command": "node", "args": ["/full/path/to/trading-bot/src/mcp-stdio.js"] } } }
```

Run `npm start` too, so the website and the bot scheduler are up. Both processes share
state through the `data/` folder.

**Claude.ai / phone (remote):** host the bot online (next section), then add
`https://your-site/mcp/<MCP_SECRET>` under claude.ai › Settings › Connectors › Add custom
connector. Treat that link like a password.

Example prompts: "What are today's market trends?", "Analyze NVDA against the latest
news", "Buy $500 of MSFT in paper and note why".

## Run it in the cloud (works when your PC is off)

The repo includes a `Dockerfile` and `railway.json`, so it deploys to Railway as-is
(any Docker host works too: Render paid plans, Fly.io, a DigitalOcean droplet).

1. Put the code in a private GitHub repo.
2. On railway.com: **New Project › Deploy from GitHub repo** and pick it.
3. In the service, **Variables**: add `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`,
   `DASHBOARD_PASSWORD`, `MCP_SECRET`, `SESSION_SECRET` (and any bot settings).
4. **Right-click the service › Attach volume**, mount path `/data`, so activity and bot
   on/off state survive restarts.
5. **Settings › Networking › Generate Domain** to get your `https://...up.railway.app` link.
6. Open it, log in, and copy the Claude link from the "Connect Claude" box.

Without `DASHBOARD_PASSWORD` set, anyone with the link could see the account and trade,
so never deploy without it.

## News sources

Free RSS: Yahoo Finance, CNBC (top, finance, world), MarketWatch, NYT (business, world),
BBC (business, world), plus Alpaca news when keys are set. Add more with `EXTRA_RSS_FEEDS`.
Headlines are cached for 5 minutes.

## How the signals work

- **News sentiment:** finance word list (beat, surge, downgrade, lawsuit...), titles count
  double, weighted by how many headlines mention the ticker.
- **Momentum:** 5-day vs 20-day average price.
- **Score** = 0.6 × news + 0.4 × momentum. Above 0.30 is buy, below −0.30 is sell.

This is a transparent heuristic, not a prediction model. Claude can do deeper reasoning on
top of it through the tools.

## Backtesting

The **Backtest a strategy** panel (and Claude's `run_backtest` / `compare_strategies` tools)
replay a strategy over up to ~10 years of daily prices and compare it with buy-and-hold:

| Strategy | Rule |
| --- | --- |
| Moving-average crossover | Hold while the fast average is above the slow one |
| RSI mean reversion | Buy below the oversold level, sell above the overbought level |
| Momentum | Hold while the price is up more than X% over the lookback |
| Breakout | Buy on a new N-day high, sell on a new M-day low |

Trades happen at the next day's open (no peeking ahead), long only, with a 0.05% cost per
trade. Results show return, worst drop, Sharpe, win rate and every trade. News sentiment
isn't included because historical sentiment data isn't available. Past results don't
predict future returns.

## Stock screener and portfolio backtest

Write a screen like `rsi_14 < 30 AND above_sma_200` and the bot:

1. On each rebalance date (weekly, monthly or quarterly), evaluates it for every stock in
   the universe using only data known that day.
2. Buys the top N matches (ranked by a field you choose) in equal weights at the next open.
3. Holds until the next rebalance, then repeats, compounding into an equity curve vs SPY.

**Scan today** runs the same screen on the latest data. Fields: `close`, `rsi_14`, `rsi_2`,
`sma_20/50/200`, `above_sma_50`, `above_sma_200`, `return_5d/20d/60d/252d`,
`from_high_252`, `volatility_20d`, `avg_volume_20`. Universes: ~100 large US companies,
sector ETFs, your watchlist, or a custom list (via Claude).

Limitation: the universe is today's list of companies, so it misses stocks that
collapsed or were delisted (survivorship bias), and there's no market-cap data. A paid
point-in-time data source (e.g. Tickerbot) would remove that bias.

## Autonomous bot and safety limits

Toggle the bot on the site, via Claude (`set_bot_enabled`), or with `AUTO_TRADE=true`.
Every `BOT_INTERVAL_MINUTES` while the market is open it buys watchlist names with a buy
signal it doesn't hold and sells holdings with a sell signal.

**Trading a screen instead of news signals.** In the screener panel, build a screen,
backtest it, then press **Let the bot trade this screen**. The bot then holds the top N
matches in equal dollar amounts (your budget ÷ N, each capped by `MAX_POSITION_USD`),
sells picks that drop out, and rebalances on the schedule you chose. It only ever sells
stocks it bought itself, so anything else in the account is left alone. Claude can do the
same with `set_bot_strategy`, and "Switch back to news signals" on the site undoes it.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MAX_POSITION_USD` | 2000 | Max dollars per buy order (applies to you and Claude too) |
| `MAX_ORDERS_PER_DAY` | 10 | Bot order cap per day |
| `WATCHLIST` | AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,SPY,QQQ | Symbols the bot trades |

## Project layout

```
src/server.js     website, JSON API, remote /mcp endpoint, bot scheduler
src/mcp-stdio.js  local MCP server for Claude Desktop / Code
src/tools.js      MCP tool definitions (shared by both)
src/broker.js     Alpaca paper API + demo simulator
src/news.js       RSS / Alpaca news fetcher
src/trends.js     sentiment, tickers, topics
src/strategy.js   signals + autonomous bot
public/           dashboard (plain HTML/CSS/JS)
test/             offline tests
```

Not financial advice.
