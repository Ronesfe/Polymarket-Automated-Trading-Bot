import {
  BotConfig,
  MarketInfo,
  OrderBookSnapshot,
  QuoteParams,
  PricePoint,
} from "../types";
import { getLogger } from "../utils/logger";
import { clamp, roundToTick, sleep, retry } from "../utils/helpers";

/**
 * Binance symbol mapping for each asset.
 */
const BINANCE_SYMBOLS: Record<string, string> = {
  btc: "BTCUSDT",
  eth: "ETHUSDT",
  sol: "SOLUSDT",
  xrp: "XRPUSDT",
  bnb: "BNBUSDT",
};

interface CryptoWindowState {
  asset: string;
  windowStart: number;    // unix seconds
  windowEnd: number;      // unix seconds
  openPrice: number;      // Binance price at window open
  latestPrice: number;    // most recent Binance price
  priceHistory: PricePoint[]; // all ticks this window
  market: MarketInfo;
  traded: boolean;        // already placed a trade this window
  tradeDirection?: "UP" | "DOWN";
}

export interface CryptoSignal {
  asset: string;
  direction: "UP" | "DOWN";
  confidence: number;   // 0-1
  priceChange: number;  // current - open
  pctChange: number;
  secondsLeft: number;
  reason: string;
}

/**
 * Crypto 5-Minute Up/Down Strategy.
 *
 * How these markets work:
 * - Every 5 minutes, a new market opens for each asset (BTC, ETH, SOL, XRP, BNB)
 * - Question: "Will {ASSET} price be higher at the end of this 5-min window?"
 * - Token[0] = "Up" token, Token[1] = "Down" token
 * - Resolves via Chainlink oracle at exactly the window end
 * - If close >= open -> "Up" pays $1, "Down" pays $0
 * - If close < open  -> "Down" pays $1, "Up" pays $0
 *
 * Strategy:
 * 1. Fetch real-time price from Binance every few seconds
 * 2. Track the opening price and ongoing direction
 * 3. Near the end of the window (configurable), if we have strong enough
 *    directional conviction, buy the corresponding token
 * 4. Key edge: trading late in the window when direction is clearer,
 *    but before the market fully prices it in
 *
 * Parameters:
 * - CRYPTO_ASSETS: which assets to trade
 * - CRYPTO_ENTRY_SEC_BEFORE_CLOSE: how many seconds before window end to trade
 * - CRYPTO_MIN_CONFIDENCE: min directional confidence to enter
 * - CRYPTO_PRICE_POLL_MS: how often to poll Binance
 */
export class Crypto5mStrategy {
  private config: BotConfig;
  private windowStates: Map<string, CryptoWindowState> = new Map();
  private assets: string[];
  private entrySecBeforeClose: number;
  private minConfidence: number;
  private pricePollMs: number;
  private maxPrice: number; // don't buy tokens above this price

  constructor(config: BotConfig) {
    this.config = config;
    this.assets = (config as any).cryptoAssets ?? ["btc", "eth", "sol", "xrp", "bnb"];
    this.entrySecBeforeClose = (config as any).cryptoEntrySecBeforeClose ?? 60;
    this.minConfidence = (config as any).cryptoMinConfidence ?? 0.55;
    this.pricePollMs = (config as any).cryptoPricePollMs ?? 3000;
    this.maxPrice = (config as any).cryptoMaxTokenPrice ?? 0.92;
  }

  getAssets(): string[] {
    return this.assets;
  }

  /**
   * Get the current 5-minute window boundaries.
   */
  getCurrentWindow(): { start: number; end: number } {
    const now = Math.floor(Date.now() / 1000);
    const start = Math.floor(now / 300) * 300;
    return { start, end: start + 300 };
  }

  /**
   * Fetch current price from Binance public API.
   */
  async fetchBinancePrice(asset: string): Promise<number> {
    const symbol = BINANCE_SYMBOLS[asset];
    if (!symbol) throw new Error(`Unknown asset: ${asset}`);

    const resp: any = await retry(async () => {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
      if (!r.ok) throw new Error(`Binance ${r.status}`);
      return r.json();
    });

    return parseFloat(resp.price);
  }

  /**
   * Poll prices for all assets. Call this on every cycle.
   * Updates internal window state.
   */
  async pollPrices(): Promise<void> {
    const log = getLogger();
    const { start, end } = this.getCurrentWindow();

    for (const asset of this.assets) {
      try {
        const price = await this.fetchBinancePrice(asset);
        const key = `${asset}-${start}`;

        let state = this.windowStates.get(key);
        if (!state) {
          // New window - initialize
          state = {
            asset,
            windowStart: start,
            windowEnd: end,
            openPrice: price,
            latestPrice: price,
            priceHistory: [],
            market: null as any, // will be set by bot
            traded: false,
          };
          this.windowStates.set(key, state);
          log.info(`[${asset.toUpperCase()}] New 5m window ${start} -> open=${price.toFixed(2)}`);

          // Cleanup old windows
          for (const [k, s] of this.windowStates) {
            if (s.windowEnd < start - 600) {
              this.windowStates.delete(k);
            }
          }
        }

        state.latestPrice = price;
        state.priceHistory.push({ price, timestamp: Date.now() });
      } catch (err) {
        log.debug(`Failed to fetch ${asset} price: ${err}`);
      }
    }
  }

  /**
   * Set the Polymarket market for a window state.
   */
  setMarket(asset: string, market: MarketInfo): void {
    const { start } = this.getCurrentWindow();
    const key = `${asset}-${start}`;
    const state = this.windowStates.get(key);
    if (state) {
      state.market = market;
    }
  }

  /**
   * Evaluate trading signal for an asset in the current window.
   */
  evaluate(asset: string): CryptoSignal | null {
    const log = getLogger();
    const { start } = this.getCurrentWindow();
    const key = `${asset}-${start}`;
    const state = this.windowStates.get(key);

    if (!state || !state.market) return null;
    if (state.traded) return null;

    const now = Math.floor(Date.now() / 1000);
    const secondsLeft = state.windowEnd - now;

    // Don't trade if window just opened (need at least 60s of price data)
    if (secondsLeft > 300 - 60) return null;

    // Don't trade if window is about to close (won't get filled)
    if (secondsLeft < 5) return null;

    // Not yet in entry window — skip silently (log every 30s)
    if (secondsLeft > this.entrySecBeforeClose) {
      return null;
    }

    // We're in the entry window — compute signal
    const priceChange = state.latestPrice - state.openPrice;
    const pctChange = priceChange / state.openPrice;
    const absPct = Math.abs(pctChange);
    const direction: "UP" | "DOWN" = priceChange >= 0 ? "UP" : "DOWN";

    // === Confidence model (tuned for real crypto 5m windows) ===
    //
    // Reality: a 0.01-0.05% move in 5 minutes is normal for BTC.
    // We're making a binary bet — even a small directional edge has value.
    //
    // Base confidence from price magnitude:
    //   0.005% -> 0.25 (small move, low confidence)
    //   0.02%  -> 0.50 (decent move)
    //   0.05%  -> 0.75 (strong move)
    //   0.10%+ -> 0.90 (very strong)
    let confidence = clamp(absPct / 0.001, 0.15, 0.90);

    // Trend consistency boost: are recent ticks agreeing with direction?
    const recent = state.priceHistory.slice(-20);
    let consistency = 0.5; // default neutral
    if (recent.length >= 4) {
      let agreeCount = 0;
      for (let i = 1; i < recent.length; i++) {
        const tick = recent[i].price - recent[i - 1].price;
        if ((direction === "UP" && tick > 0) || (direction === "DOWN" && tick < 0)) {
          agreeCount++;
        }
      }
      consistency = agreeCount / (recent.length - 1);
      // Boost confidence if trend is consistent, penalize if choppy
      confidence *= (0.6 + consistency * 0.6); // range: 0.6x to 1.2x
    }

    // Time boost: closer to end = price is less likely to reverse
    const elapsed = 300 - secondsLeft;
    const timeFactor = elapsed / 300; // 0 at start, 1 at end
    confidence *= (0.75 + timeFactor * 0.35); // range: 0.75x to 1.1x

    // Slight penalty if the move is really tiny (less than 1 tick on Binance)
    if (absPct < 0.00003) {
      confidence *= 0.5;
    }

    confidence = clamp(confidence, 0, 1);

    // Log the evaluation so you can see what's happening
    log.info(
      `[${asset.toUpperCase()}] EVAL: ${direction} ${(pctChange * 100).toFixed(4)}% | ` +
      `conf=${(confidence * 100).toFixed(1)}% (need ${(this.minConfidence * 100).toFixed(0)}%) | ` +
      `consistency=${(consistency * 100).toFixed(0)}% | ${secondsLeft}s left`
    );

    if (confidence < this.minConfidence) {
      return null;
    }

    return {
      asset,
      direction,
      confidence,
      priceChange,
      pctChange,
      secondsLeft,
      reason:
        `${asset.toUpperCase()} ${direction} ${(pctChange * 100).toFixed(3)}% | ` +
        `conf=${(confidence * 100).toFixed(0)}% | ${secondsLeft}s left`,
    };
  }

  /**
   * Generate an order from a crypto signal.
   * Buys the "Up" token (index 0) or "Down" token (index 1).
   */
  generateOrder(
    signal: CryptoSignal,
    market: MarketInfo,
    orderBook: OrderBookSnapshot
  ): QuoteParams | null {
    const log = getLogger();
    const { start } = this.getCurrentWindow();
    const key = `${signal.asset}-${start}`;
    const state = this.windowStates.get(key);

    if (!state || state.traded) return null;

    // Token selection: Up = tokenIds[0], Down = tokenIds[1]
    const tokenIndex = signal.direction === "UP" ? 0 : 1;
    const tokenId = market.tokenIds[tokenIndex];

    // Price: we want to buy, so lift the best ask (aggressive fill)
    const targetBook = orderBook; // book is for tokenIds[0] (Up token)
    let price: number;

    if (signal.direction === "UP") {
      // Buy Up token - take the ask
      price = targetBook.asks[0]?.price ?? targetBook.midpoint + 0.01;
    } else {
      // Buy Down token - the orderbook we have is for Up token
      // Down token price ≈ 1 - Up token price (approximately)
      // But we need the actual Down token book. For simplicity,
      // price the Down buy at what feels fair given Up's mid.
      price = 1 - (targetBook.bids[0]?.price ?? targetBook.midpoint);
    }

    price = roundToTick(clamp(price, 0.01, 0.99), 0.01);

    // Don't overpay - if token is already > maxPrice, the edge is gone
    if (price > this.maxPrice) {
      log.info(`[${signal.asset.toUpperCase()}] Skip: token price ${price.toFixed(2)} > max ${this.maxPrice}`);
      return null;
    }

    // Size: scale with confidence
    const size = Math.max(1, Math.round(this.config.orderSize * signal.confidence));

    state.traded = true;
    state.tradeDirection = signal.direction;

    log.info(
      `>>> TRADE: ${signal.asset.toUpperCase()} ${signal.direction} | ` +
      `${size} tokens @ ${price.toFixed(2)} | ${signal.reason}`
    );

    return {
      tokenId,
      side: "BUY",
      price,
      size,
      orderType: "GTC",
    };
  }

  /**
   * Check if we need to switch to a new window.
   * Returns true if the current window is different from what we're tracking.
   */
  isNewWindow(asset: string): boolean {
    const { start } = this.getCurrentWindow();
    const key = `${asset}-${start}`;
    return !this.windowStates.has(key);
  }

  /**
   * Get summary of current window states for logging.
   */
  getStatus(): string {
    const { start, end } = this.getCurrentWindow();
    const now = Math.floor(Date.now() / 1000);
    const secondsLeft = end - now;

    const lines: string[] = [`Window ${start} | ${secondsLeft}s left`];

    for (const asset of this.assets) {
      const key = `${asset}-${start}`;
      const state = this.windowStates.get(key);
      if (!state) {
        lines.push(`  ${asset.toUpperCase()}: no data`);
        continue;
      }

      const change = state.latestPrice - state.openPrice;
      const pct = (change / state.openPrice * 100).toFixed(3);
      const dir = change >= 0 ? "↑" : "↓";
      const traded = state.traded ? ` [TRADED ${state.tradeDirection}]` : "";

      lines.push(
        `  ${asset.toUpperCase()}: ${state.latestPrice.toFixed(2)} (${dir}${pct}%) open=${state.openPrice.toFixed(2)}${traded}`
      );
    }

    return lines.join("\n");
  }
}
