# Polymarket Trading Bot

Automated trading bot for Polymarket prediction markets. Supports 4 strategies, optional AI integration, and full risk management.

## Strategies

### 1. Market Making (`STRATEGY=market-maker`)
Places two-sided bid/ask quotes around a computed fair value. Profits from the spread when both sides fill. Optionally uses AI (Claude/GPT) to tilt the midpoint based on event analysis.

### 2. Momentum (`STRATEGY=momentum`)
Tracks price over a rolling window. When price moves sharply in one direction (news, event catalyst), enters in the same direction and rides the trend. Exits on take-profit or stop-loss. Works best on markets with breaking news flow.

### 3. Mean Reversion (`STRATEGY=mean-reversion`)
Maintains an EMA of price and a rolling standard deviation. When price deviates beyond N standard deviations from the EMA, bets on reversion back to the mean. Exits when price returns within a tighter band. Works best on stable-consensus markets with no new information.

### 4. Copy Trading (`STRATEGY=copy-trade`)
Monitors one or more target wallets (from the Polymarket leaderboard or anywhere) via the public Data API. When a target makes a trade, replicates it with configurable sizing and delay. No market scanning needed — just follows the targets.



![img](https://i.imgur.com/ns2FIS6.png)



## Architecture

```
src/
├── index.ts                    # Entry point
├── setup.ts                    # Credential derivation & connectivity test
├── config/index.ts             # Config loader (all strategies)
├── types/index.ts              # Full type definitions
├── ai/
│   ├── anthropic.ts            # Claude API
│   ├── openai.ts               # GPT API
│   └── router.ts               # Provider selection (supports "none" mode)
├── strategies/
│   ├── market-maker.ts         # Spread quoting with layered orders
│   ├── momentum.ts             # Trend-following with entry/exit signals
│   ├── mean-reversion.ts       # EMA + z-score based fade strategy
│   ├── copy-trader.ts          # Wallet monitoring + trade replication
│   └── scanner.ts              # Market discovery & ranking
├── services/
│   ├── polymarket.ts           # CLOB client wrapper
│   ├── risk.ts                 # Exposure, PnL, drawdown tracking
│   └── bot.ts                  # Orchestrator (routes to active strategy)
└── utils/
    ├── logger.ts
    └── helpers.ts
```

## Setup

```bash
npm install
cp .env.example .env
# Edit .env: set PRIVATE_KEY, FUNDER_ADDRESS, STRATEGY, and strategy-specific params

# Test connectivity (derives CLOB API creds)
npm run setup

# Run
npm run dev
```

### AI is optional
Set `AI_PROVIDER=none` (the default) to run any strategy without AI. The market maker will use pure order-book-derived midpoints. Momentum and mean reversion don't use AI at all. Copy trading doesn't use AI at all.

If you want AI-assisted market making, set `AI_PROVIDER=anthropic` or `openai` or `fallback` and provide the corresponding API key.

## Copy Trading Setup

1. Find wallet addresses on the [Polymarket leaderboard](https://polymarket.com/leaderboard)
2. Set them in `.env`:
   ```
   STRATEGY=copy-trade
   COPY_TARGETS=0xabc123...,0xdef456...
   COPY_SIZE_MULTIPLIER=0.5
   COPY_MAX_SIZE_USD=25
   ```
3. The bot polls the Data API every `COPY_POLL_INTERVAL_SEC` seconds for new trades from those wallets
4. First poll marks existing trades — it won't retroactively copy the target's history

## Key Config

| Parameter | Default | Strategies | Description |
|-----------|---------|-----------|-------------|
| `STRATEGY` | market-maker | all | Which strategy to run |
| `AI_PROVIDER` | none | market-maker | `none`, `anthropic`, `openai`, `fallback` |
| `SPREAD` | 0.02 | market-maker | Bid-ask spread width |
| `ORDER_SIZE` | 10 | all | USDC per order |
| `MOMENTUM_THRESHOLD` | 0.03 | momentum | Min price move to trigger |
| `MEAN_REVERSION_BAND` | 1.5 | mean-reversion | Z-score entry threshold |
| `COPY_TARGETS` | (empty) | copy-trade | Comma-separated wallet addresses |
| `COPY_SIZE_MULTIPLIER` | 0.5 | copy-trade | Your size relative to target |
| `MAX_DRAWDOWN` | 200 | all | USDC loss before full shutdown |

## Risk Management

Applies to all strategies:
- Per-market loss cap → stops quoting that market
- Total drawdown cap → cancels everything, pauses
- Exposure cap → no new orders
- Inventory skew → tilts quotes to offload (market-maker only)

## Warnings

- **Real money.** Start with tiny sizes ($1-2) and low exposure caps.
- Market making in prediction markets is risky — markets can resolve 0 or 1 and wipe your inventory.
- Copy trading adds latency — the target gets better prices than you.
- The bot requires token allowances set on Polygon for the CTF Exchange before placing orders.
- Polymarket cancels all open orders when your session goes inactive — the bot must run continuously.
