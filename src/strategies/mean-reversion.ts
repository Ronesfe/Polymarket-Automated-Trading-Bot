import {
  BotConfig,
  MarketInfo,
  OrderBookSnapshot,
  PriceHistory,
  QuoteParams,
} from "../types";
import { getLogger } from "../utils/logger";
import { clamp, roundToTick } from "../utils/helpers";

export interface MeanRevSignal {
  tokenId: string;
  direction: "BUY" | "SELL" | "HOLD";
  strength: number;
  zScore: number;
  ema: number;
  reason: string;
}

/**
 * Mean reversion strategy for prediction markets.
 *
 * Logic:
 * - Maintain an EMA (exponential moving average) of the price
 * - Compute a rolling standard deviation
 * - When price deviates > N standard deviations from the EMA, bet on reversion
 * - Exit when price returns within the exit band
 *
 * Works well on established markets with a stable consensus (e.g. election
 * with no new news, a market that's been at 60¢ for a week). Terrible on
 * markets with genuine information shocks — that's where momentum shines.
 *
 * The two strategies are natural complements.
 */
export class MeanReversionStrategy {
  private config: BotConfig;
  private histories: Map<string, PriceHistory> = new Map();
  private emas: Map<string, number> = new Map();
  private variances: Map<string, number> = new Map();
  private entryZScores: Map<string, number> = new Map(); // tracks open positions

  // EMA smoothing factor (derived from window)
  private alpha: number;

  constructor(config: BotConfig) {
    this.config = config;
    // alpha = 2 / (N + 1)
    this.alpha = 2 / (config.meanReversionWindow + 1);
  }

  /**
   * Feed a new price and update EMA + variance.
   */
  recordPrice(tokenId: string, price: number): void {
    let history = this.histories.get(tokenId);
    if (!history) {
      history = { tokenId, points: [] };
      this.histories.set(tokenId, history);
    }
    history.points.push({ price, timestamp: Date.now() });

    // Keep a reasonable buffer
    const maxPoints = this.config.meanReversionWindow * 10;
    if (history.points.length > maxPoints) {
      history.points = history.points.slice(-maxPoints);
    }

    // Update EMA
    const prevEma = this.emas.get(tokenId);
    if (prevEma === undefined) {
      this.emas.set(tokenId, price);
      this.variances.set(tokenId, 0);
    } else {
      const newEma = this.alpha * price + (1 - this.alpha) * prevEma;
      this.emas.set(tokenId, newEma);

      // Update variance (EMA of squared deviation)
      const deviation = price - newEma;
      const prevVar = this.variances.get(tokenId) ?? 0;
      const newVar = this.alpha * (deviation * deviation) + (1 - this.alpha) * prevVar;
      this.variances.set(tokenId, newVar);
    }
  }

  /**
   * Evaluate mean reversion signal.
   */
  evaluate(tokenId: string, currentBook: OrderBookSnapshot): MeanRevSignal {
    const ema = this.emas.get(tokenId);
    const variance = this.variances.get(tokenId);
    const history = this.histories.get(tokenId);

    if (ema === undefined || variance === undefined || !history) {
      return { tokenId, direction: "HOLD", strength: 0, zScore: 0, ema: 0, reason: "no data yet" };
    }

    // Need enough data points for the EMA to stabilize
    if (history.points.length < this.config.meanReversionWindow) {
      return {
        tokenId, direction: "HOLD", strength: 0, zScore: 0, ema,
        reason: `warming up: ${history.points.length}/${this.config.meanReversionWindow} points`,
      };
    }

    const stddev = Math.sqrt(variance);

    // Avoid division by zero / very low vol markets
    if (stddev < 0.003) {
      return { tokenId, direction: "HOLD", strength: 0, zScore: 0, ema, reason: "vol too low" };
    }

    const currentPrice = currentBook.midpoint;
    const zScore = (currentPrice - ema) / stddev;

    // Check if we have an open position
    const entryZ = this.entryZScores.get(tokenId);
    if (entryZ !== undefined) {
      // Exit condition: z-score has returned within exit band
      if (Math.abs(zScore) <= this.config.meanReversionExitBand) {
        const direction = entryZ > 0 ? "SELL" : "BUY"; // close the position
        this.entryZScores.delete(tokenId);
        return {
          tokenId, direction, strength: 0.8, zScore, ema,
          reason: `exit: z=${zScore.toFixed(2)} within band (entered at z=${entryZ.toFixed(2)})`,
        };
      }

      // Still holding
      return { tokenId, direction: "HOLD", strength: 0, zScore, ema, reason: `holding (z=${zScore.toFixed(2)})` };
    }

    // Entry condition: z-score beyond the entry band
    if (zScore > this.config.meanReversionBand) {
      // Price is high relative to EMA -> sell (expect reversion down)
      const strength = clamp((Math.abs(zScore) - this.config.meanReversionBand) / 2, 0.3, 1);
      return {
        tokenId, direction: "SELL", strength, zScore, ema,
        reason: `sell signal: z=${zScore.toFixed(2)} > ${this.config.meanReversionBand} (EMA=${ema.toFixed(3)}, σ=${stddev.toFixed(4)})`,
      };
    }

    if (zScore < -this.config.meanReversionBand) {
      // Price is low relative to EMA -> buy (expect reversion up)
      const strength = clamp((Math.abs(zScore) - this.config.meanReversionBand) / 2, 0.3, 1);
      return {
        tokenId, direction: "BUY", strength, zScore, ema,
        reason: `buy signal: z=${zScore.toFixed(2)} < -${this.config.meanReversionBand} (EMA=${ema.toFixed(3)}, σ=${stddev.toFixed(4)})`,
      };
    }

    return { tokenId, direction: "HOLD", strength: 0, zScore, ema, reason: `neutral (z=${zScore.toFixed(2)})` };
  }

  /**
   * Generate order from a mean reversion signal.
   */
  generateOrder(
    signal: MeanRevSignal,
    market: MarketInfo,
    orderBook: OrderBookSnapshot
  ): QuoteParams | null {
    if (signal.direction === "HOLD") return null;

    const log = getLogger();
    const tickSize = 0.01;

    // Use limit prices slightly inside the spread for better fills
    let price: number;
    if (signal.direction === "BUY") {
      // Bid slightly above best bid
      const bestBid = orderBook.bids[0]?.price ?? (orderBook.midpoint - tickSize);
      price = bestBid + tickSize;
    } else {
      // Ask slightly below best ask
      const bestAsk = orderBook.asks[0]?.price ?? (orderBook.midpoint + tickSize);
      price = bestAsk - tickSize;
    }

    price = roundToTick(clamp(price, 0.01, 0.99), tickSize);
    const size = Math.max(1, Math.round(this.config.orderSize * signal.strength));

    // Track entry for exit
    if (!this.entryZScores.has(signal.tokenId)) {
      this.entryZScores.set(signal.tokenId, signal.zScore);
    } else {
      this.entryZScores.delete(signal.tokenId);
    }

    log.info(`MeanRev ${signal.direction} ${size} @ ${price.toFixed(2)} | ${signal.reason}`);

    return {
      tokenId: signal.tokenId,
      side: signal.direction,
      price,
      size,
      orderType: "GTC",
    };
  }
}
