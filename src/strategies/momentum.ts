import {
  BotConfig,
  MarketInfo,
  OrderBookSnapshot,
  PriceHistory,
  PricePoint,
  QuoteParams,
} from "../types";
import { getLogger } from "../utils/logger";
import { clamp, roundToTick } from "../utils/helpers";

export interface MomentumSignal {
  tokenId: string;
  direction: "BUY" | "SELL" | "HOLD";
  strength: number; // 0-1
  priceChange: number;
  reason: string;
}

/**
 * Momentum strategy for prediction markets.
 *
 * Logic:
 * - Track price over a rolling window
 * - When price moves > threshold in one direction, enter in that direction
 *   (the idea: sharp moves often continue briefly as information gets priced in)
 * - Exit when price reverses by exitTicks or after a timeout
 *
 * Works well on markets with breaking news / event-driven moves.
 * Does NOT work well on sideways / low-volume markets.
 */
export class MomentumStrategy {
  private config: BotConfig;
  private histories: Map<string, PriceHistory> = new Map();
  private openPositionMids: Map<string, number> = new Map(); // tokenId -> entry mid

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Record a new price observation.
   */
  recordPrice(tokenId: string, price: number): void {
    let history = this.histories.get(tokenId);
    if (!history) {
      history = { tokenId, points: [] };
      this.histories.set(tokenId, history);
    }

    history.points.push({ price, timestamp: Date.now() });

    // Trim to window
    const cutoff = Date.now() - this.config.momentumWindowMin * 60 * 1000;
    history.points = history.points.filter((p) => p.timestamp >= cutoff);
  }

  /**
   * Evaluate whether there's a momentum signal for this token.
   */
  evaluate(tokenId: string, currentBook: OrderBookSnapshot): MomentumSignal {
    const history = this.histories.get(tokenId);

    if (!history || history.points.length < 3) {
      return { tokenId, direction: "HOLD", strength: 0, priceChange: 0, reason: "insufficient data" };
    }

    const oldest = history.points[0];
    const newest = history.points[history.points.length - 1];
    const priceChange = newest.price - oldest.price;
    const absChange = Math.abs(priceChange);
    const windowSeconds = (newest.timestamp - oldest.timestamp) / 1000;

    // Need at least 60 seconds of data
    if (windowSeconds < 60) {
      return { tokenId, direction: "HOLD", strength: 0, priceChange, reason: "window too short" };
    }

    // Check if we have an open position to manage
    const entryMid = this.openPositionMids.get(tokenId);
    if (entryMid !== undefined) {
      return this.evaluateExit(tokenId, currentBook, entryMid, priceChange);
    }

    // Check for entry signal
    if (absChange < this.config.momentumThreshold) {
      return { tokenId, direction: "HOLD", strength: 0, priceChange, reason: "below threshold" };
    }

    // Confirm trend consistency: at least 60% of recent moves should agree with direction
    const recentPoints = history.points.slice(-10);
    if (recentPoints.length < 3) {
      return { tokenId, direction: "HOLD", strength: 0, priceChange, reason: "not enough recent points" };
    }

    let agreeCount = 0;
    for (let i = 1; i < recentPoints.length; i++) {
      const move = recentPoints[i].price - recentPoints[i - 1].price;
      if ((priceChange > 0 && move > 0) || (priceChange < 0 && move < 0)) {
        agreeCount++;
      }
    }
    const consistency = agreeCount / (recentPoints.length - 1);

    if (consistency < 0.6) {
      return { tokenId, direction: "HOLD", strength: 0, priceChange, reason: "inconsistent trend" };
    }

    // Velocity: faster moves = stronger signal
    const velocity = absChange / (windowSeconds / 60); // change per minute
    const strength = clamp(velocity / (this.config.momentumThreshold * 2), 0.3, 1);

    const direction = priceChange > 0 ? "BUY" : "SELL";
    return {
      tokenId,
      direction,
      strength,
      priceChange,
      reason: `${direction} momentum: ${(priceChange * 100).toFixed(1)}¢ over ${(windowSeconds / 60).toFixed(1)}min (${(consistency * 100).toFixed(0)}% consistent)`,
    };
  }

  /**
   * Check if an open position should be exited.
   */
  private evaluateExit(
    tokenId: string,
    currentBook: OrderBookSnapshot,
    entryMid: number,
    overallChange: number
  ): MomentumSignal {
    const tickSize = 0.01;
    const exitDistance = this.config.momentumExitTicks * tickSize;
    const currentMid = currentBook.midpoint;
    const pnlFromEntry = currentMid - entryMid;

    // Take profit: price moved in our favor by exitTicks
    if (overallChange > 0 && pnlFromEntry >= exitDistance) {
      return {
        tokenId,
        direction: "SELL", // close long
        strength: 1,
        priceChange: pnlFromEntry,
        reason: `take profit: +${(pnlFromEntry * 100).toFixed(1)}¢`,
      };
    }
    if (overallChange < 0 && pnlFromEntry <= -exitDistance) {
      return {
        tokenId,
        direction: "BUY", // close short
        strength: 1,
        priceChange: pnlFromEntry,
        reason: `take profit: +${(Math.abs(pnlFromEntry) * 100).toFixed(1)}¢`,
      };
    }

    // Stop loss: price reversed by more than exitTicks against us
    if (overallChange > 0 && pnlFromEntry <= -exitDistance) {
      return {
        tokenId,
        direction: "SELL",
        strength: 1,
        priceChange: pnlFromEntry,
        reason: `stop loss: ${(pnlFromEntry * 100).toFixed(1)}¢`,
      };
    }
    if (overallChange < 0 && pnlFromEntry >= exitDistance) {
      return {
        tokenId,
        direction: "BUY",
        strength: 1,
        priceChange: pnlFromEntry,
        reason: `stop loss: ${(pnlFromEntry * 100).toFixed(1)}¢`,
      };
    }

    return { tokenId, direction: "HOLD", strength: 0, priceChange: pnlFromEntry, reason: "holding position" };
  }

  /**
   * Generate order for a momentum signal.
   */
  generateOrder(
    signal: MomentumSignal,
    market: MarketInfo,
    orderBook: OrderBookSnapshot
  ): QuoteParams | null {
    if (signal.direction === "HOLD") return null;

    const log = getLogger();
    const tickSize = 0.01;

    // Use aggressive pricing: cross the spread to get filled quickly
    let price: number;
    if (signal.direction === "BUY") {
      // Lift the ask
      price = orderBook.asks[0]?.price ?? orderBook.midpoint + tickSize;
    } else {
      // Hit the bid
      price = orderBook.bids[0]?.price ?? orderBook.midpoint - tickSize;
    }

    price = roundToTick(clamp(price, 0.01, 0.99), tickSize);
    const size = Math.max(1, Math.round(this.config.orderSize * signal.strength));

    log.info(`Momentum ${signal.direction} ${size} @ ${price.toFixed(2)} | ${signal.reason}`);

    // Track entry for exit management
    if (!this.openPositionMids.has(signal.tokenId)) {
      this.openPositionMids.set(signal.tokenId, orderBook.midpoint);
    } else {
      // Exiting - clear the position tracker
      this.openPositionMids.delete(signal.tokenId);
    }

    return {
      tokenId: signal.tokenId,
      side: signal.direction,
      price,
      size,
      orderType: "GTC",
    };
  }
}
