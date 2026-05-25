import {
  BotConfig,
  MarketInfo,
  OrderBookSnapshot,
  AISentiment,
  InventoryState,
  QuoteParams,
} from "../types";
import { getLogger } from "../utils/logger";
import { clamp, roundToTick, weightedMidpoint } from "../utils/helpers";

export interface QuotePair {
  bid: QuoteParams;
  ask: QuoteParams;
}

/**
 * Market making strategy.
 *
 * Core logic:
 * 1. Compute a "fair" midpoint from the order book
 * 2. Adjust midpoint based on AI sentiment (if available)
 * 3. Adjust for inventory skew (offload heavy positions)
 * 4. Place symmetric bid/ask quotes around adjusted mid
 * 5. Layer multiple orders at different price levels
 */
export class MarketMaker {
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Generate bid and ask quotes for a market's YES token.
   */
  generateQuotes(
    market: MarketInfo,
    orderBook: OrderBookSnapshot,
    sentiment: AISentiment | undefined,
    inventory: InventoryState,
    inventorySkew: number
  ): QuotePair[] {
    const log = getLogger();
    const quotes: QuotePair[] = [];

    // Step 1: Determine fair midpoint from order book
    let fairMid = orderBook.midpoint;

    // Use size-weighted mid if we have book depth
    if (orderBook.bids.length > 0 && orderBook.asks.length > 0) {
      fairMid = weightedMidpoint(
        orderBook.bids[0].price,
        orderBook.asks[0].price,
        orderBook.bids[0].size,
        orderBook.asks[0].size
      );
    }

    // Step 2: Blend in AI sentiment
    if (sentiment && sentiment.confidence > 0.2) {
      const weight = this.config.aiSkewWeight * sentiment.confidence;
      fairMid = fairMid * (1 - weight) + sentiment.fairValue * weight;

      log.debug(
        `AI adjustment: fairValue=${sentiment.fairValue.toFixed(3)}, ` +
        `confidence=${sentiment.confidence.toFixed(2)}, ` +
        `adjusted mid=${fairMid.toFixed(3)}`
      );
    }

    // Step 3: Apply inventory skew
    fairMid += inventorySkew;

    // Clamp mid to valid range
    fairMid = clamp(fairMid, 0.01, 0.99);

    // Step 4: Calculate spread
    // Widen spread if:
    //  - market book spread is wide (follow the market)
    //  - AI confidence is low
    //  - inventory is skewed
    let halfSpread = this.config.spread / 2;

    // Widen if market is already wide (don't tighten beyond market)
    if (orderBook.spread > this.config.spread) {
      halfSpread = Math.max(halfSpread, orderBook.spread * 0.4);
    }

    // Widen if AI is uncertain
    if (sentiment && sentiment.confidence < 0.3) {
      halfSpread *= 1.5;
    }

    // Widen if inventory is skewed
    if (Math.abs(inventory.skewRatio) > this.config.inventorySkewThreshold) {
      halfSpread *= 1.3;
    }

    // Step 5: Generate layered quotes
    const tickSize = 0.01;
    for (let i = 0; i < this.config.maxOrdersPerSide; i++) {
      const layerOffset = i * tickSize; // each layer 1 tick deeper

      let bidPrice = roundToTick(fairMid - halfSpread - layerOffset, tickSize);
      let askPrice = roundToTick(fairMid + halfSpread + layerOffset, tickSize);

      // Clamp to valid Polymarket price range
      bidPrice = clamp(bidPrice, 0.01, 0.99);
      askPrice = clamp(askPrice, 0.01, 0.99);

      // Don't cross: bid must be below ask
      if (bidPrice >= askPrice) continue;

      // Size: reduce for deeper layers
      const layerSizeFactor = 1 / (1 + i * 0.5);
      const size = Math.max(1, Math.round(this.config.orderSize * layerSizeFactor));

      quotes.push({
        bid: {
          tokenId: market.tokenIds[0], // YES token
          side: "BUY",
          price: bidPrice,
          size,
          orderType: "GTC",
        },
        ask: {
          tokenId: market.tokenIds[0], // YES token
          side: "SELL",
          price: askPrice,
          size,
          orderType: "GTC",
        },
      });
    }

    log.info(
      `Quotes for "${market.question.substring(0, 50)}...": ` +
      `mid=${fairMid.toFixed(3)}, spread=${(halfSpread * 2).toFixed(3)}, ` +
      `${quotes.length} layers`
    );

    return quotes;
  }

  /**
   * Decide if we should refresh quotes based on market movement.
   * Returns true if the midpoint has moved more than a threshold since last quote.
   */
  shouldRefresh(
    currentBook: OrderBookSnapshot,
    lastMid: number,
    thresholdPct: number = 0.005
  ): boolean {
    const drift = Math.abs(currentBook.midpoint - lastMid) / lastMid;
    return drift > thresholdPct;
  }
}
