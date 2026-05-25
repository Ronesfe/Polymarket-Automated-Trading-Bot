import { MarketInfo, OrderBookSnapshot } from "../types";
import { PolymarketService } from "../services/polymarket";
import { getLogger } from "../utils/logger";
import { isNearExpiry } from "../utils/helpers";

export interface ScoredMarket {
  market: MarketInfo;
  orderBook: OrderBookSnapshot;
  score: number;
  reasons: string[];
}

/**
 * Scans available markets and ranks them by attractiveness for market making.
 *
 * Good MM markets have:
 * - High volume (fills happen)
 * - Wide spreads (room for profit)
 * - Decent book depth (less adverse selection)
 * - Not too close to resolution (binary outcome risk)
 * - Price near 0.5 (more two-sided flow)
 */
export class MarketScanner {
  private polymarket: PolymarketService;

  constructor(polymarket: PolymarketService) {
    this.polymarket = polymarket;
  }

  async scanAndRank(): Promise<ScoredMarket[]> {
    const log = getLogger();
    const markets = await this.polymarket.getActiveMarkets();

    if (markets.length === 0) {
      log.warn("No eligible markets found");
      return [];
    }

    const scored: ScoredMarket[] = [];

    for (const market of markets) {
      try {
        const orderBook = await this.polymarket.getOrderBook(market.tokenIds[0]);
        const result = this.scoreMarket(market, orderBook);
        if (result.score > 0) {
          scored.push(result);
        }
      } catch (err) {
        log.debug(`Failed to score market ${market.conditionId}: ${err}`);
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    log.info(`Scored ${scored.length} markets:`);
    for (const s of scored.slice(0, 10)) {
      log.info(`  [${s.score.toFixed(1)}] ${s.market.question.substring(0, 60)} | ${s.reasons.join(", ")}`);
    }

    return scored;
  }

  private scoreMarket(market: MarketInfo, orderBook: OrderBookSnapshot): ScoredMarket {
    let score = 0;
    const reasons: string[] = [];

    // 1. Volume score (log scale, max 30 pts)
    const volScore = Math.min(30, Math.log10(market.volume24h + 1) * 8);
    score += volScore;
    if (volScore > 15) reasons.push(`vol:$${(market.volume24h / 1000).toFixed(0)}k`);

    // 2. Spread score: wider = more opportunity (max 25 pts)
    // Sweet spot: 2-8 cents. Too tight = no edge, too wide = no fills
    const spread = orderBook.spread;
    if (spread >= 0.02 && spread <= 0.10) {
      const spreadScore = 25 * (1 - Math.abs(spread - 0.05) / 0.05);
      score += Math.max(0, spreadScore);
      reasons.push(`spread:${(spread * 100).toFixed(1)}¢`);
    } else if (spread > 0.10) {
      score += 5; // too wide, might not fill but still some opportunity
      reasons.push(`wide:${(spread * 100).toFixed(1)}¢`);
    }

    // 3. Depth score: thicker book = safer MM (max 20 pts)
    const bidDepth = orderBook.bids.reduce((sum, l) => sum + l.size * l.price, 0);
    const askDepth = orderBook.asks.reduce((sum, l) => sum + l.size * l.price, 0);
    const totalDepth = bidDepth + askDepth;
    const depthScore = Math.min(20, totalDepth / 50);
    score += depthScore;

    // 4. Price balance: near 0.5 = more two-sided flow (max 15 pts)
    const mid = orderBook.midpoint;
    const balanceScore = 15 * (1 - Math.abs(mid - 0.5) * 2);
    score += Math.max(0, balanceScore);

    // 5. Penalty: near expiry (markets about to resolve are dangerous)
    if (isNearExpiry(market.endDate, 24)) {
      score *= 0.3;
      reasons.push("near-expiry");
    } else if (isNearExpiry(market.endDate, 72)) {
      score *= 0.7;
    }

    // 6. Penalty: extreme prices (>0.9 or <0.1 = one-sided, adverse selection risk)
    if (mid > 0.9 || mid < 0.1) {
      score *= 0.4;
      reasons.push("extreme-price");
    }

    return { market, orderBook, score, reasons };
  }
}
