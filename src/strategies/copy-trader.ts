import {
  BotConfig,
  CopyTargetTrade,
  MarketInfo,
  QuoteParams,
} from "../types";
import { getLogger } from "../utils/logger";
import { retry, sleep, clamp, roundToTick } from "../utils/helpers";

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

/**
 * Copy trading strategy.
 *
 * Monitors one or more target wallets via Polymarket's public Data API,
 * detects new trades, and replicates them with configurable sizing.
 *
 * How it works:
 * 1. Poll /activity?user=<target>&type=TRADE for each target wallet
 * 2. Compare against last-seen trade ID to find new trades
 * 3. Apply size multiplier and caps
 * 4. Place matching orders via CLOB
 *
 * The Data API is public - no auth needed to read anyone's activity.
 * You can find wallet addresses on the Polymarket leaderboard.
 */
export class CopyTrader {
  private config: BotConfig;
  private lastSeenTrades: Map<string, string> = new Map(); // target -> last trade ID
  private processedTrades: Set<string> = new Set(); // all trade IDs we've acted on
  private marketCache: Map<string, MarketInfo> = new Map();

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Poll all target wallets for new trades.
   * Returns orders to execute.
   */
  async pollTargets(): Promise<QuoteParams[]> {
    const log = getLogger();
    const orders: QuoteParams[] = [];

    for (const target of this.config.copyTargets) {
      try {
        const newTrades = await this.fetchNewTrades(target);
        if (newTrades.length > 0) {
          log.info(`Found ${newTrades.length} new trades from ${target.substring(0, 10)}...`);
        }

        for (const trade of newTrades) {
          const order = await this.tradeToOrder(trade);
          if (order) {
            orders.push(order);
          }
        }
      } catch (err) {
        log.error(`Failed to poll target ${target.substring(0, 10)}...: ${err}`);
      }
    }

    return orders;
  }

  /**
   * Fetch new trades for a target wallet since our last check.
   */
  private async fetchNewTrades(target: string): Promise<CopyTargetTrade[]> {
    const log = getLogger();

    const url = `${DATA_API}/activity?user=${target}&type=TRADE&limit=20&sortBy=TIMESTAMP`;

    const resp: any = await retry(async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Data API ${r.status}: ${r.statusText}`);
      return r.json();
    });

    const activities: any[] = Array.isArray(resp) ? resp : resp.history ?? resp.data ?? [];

    const trades: CopyTargetTrade[] = [];
    const lastSeen = this.lastSeenTrades.get(target);
    let foundLastSeen = false;

    for (const a of activities) {
      const tradeId = a.id ?? a.transaction_hash ?? `${a.timestamp}-${a.conditionId}`;

      // Stop when we hit the last trade we already saw
      if (tradeId === lastSeen) {
        foundLastSeen = true;
        break;
      }

      // Skip if we already processed this one (dedup across polls)
      if (this.processedTrades.has(tradeId)) continue;

      // Parse the trade
      const conditionId = a.conditionId ?? a.condition_id ?? a.market ?? "";
      const tokenId = a.assetId ?? a.asset_id ?? a.tokenId ?? "";
      const side = (a.side ?? "").toUpperCase();
      const price = parseFloat(a.price ?? a.outcomePrice ?? "0");
      const size = parseFloat(a.size ?? a.tokenAmount ?? a.tokens ?? "0");
      const cashSize = parseFloat(a.cashAmount ?? a.cash ?? String(price * size));
      const timestamp = a.timestamp
        ? new Date(a.timestamp).getTime()
        : Date.now();

      if (!conditionId || !tokenId || !side || size <= 0) continue;

      trades.push({
        id: tradeId,
        user: target,
        conditionId,
        tokenId,
        side: side as "BUY" | "SELL",
        price,
        size,
        cashSize,
        timestamp,
        type: "TRADE",
      });
    }

    // Update last seen marker
    if (activities.length > 0) {
      const firstId = activities[0]?.id ?? activities[0]?.transaction_hash ?? "";
      if (firstId) {
        this.lastSeenTrades.set(target, firstId);
      }
    }

    // On first poll, don't copy historical trades - just set the marker
    if (!lastSeen && !foundLastSeen) {
      log.info(`First poll for ${target.substring(0, 10)}... - marking ${activities.length} existing trades, will copy new ones`);
      for (const t of trades) {
        this.processedTrades.add(t.id);
      }
      return [];
    }

    return trades;
  }

  /**
   * Convert a target's trade into an order we should place.
   */
  private async tradeToOrder(trade: CopyTargetTrade): Promise<QuoteParams | null> {
    const log = getLogger();

    // Mark as processed
    this.processedTrades.add(trade.id);

    // Apply delay (helps with slippage - don't front-run, follow)
    if (this.config.copyDelayMs > 0) {
      await sleep(this.config.copyDelayMs);
    }

    // Size calculation
    let size = trade.size * this.config.copySizeMultiplier;
    const cashEquivalent = size * trade.price;

    // Cap by max USD
    if (cashEquivalent > this.config.copyMaxSizeUsd) {
      size = this.config.copyMaxSizeUsd / trade.price;
    }

    size = Math.max(1, Math.round(size));

    // Price: use the same price as the target (limit order)
    // In practice, the price may have moved. We could cross the spread
    // for faster fill, but that's riskier. Start with same price.
    const price = roundToTick(clamp(trade.price, 0.01, 0.99), 0.01);

    log.info(
      `COPY ${trade.side} ${size} @ ${price.toFixed(2)} ` +
      `(target: ${trade.user.substring(0, 10)}... did ${trade.side} ${trade.size} @ ${trade.price.toFixed(2)}, ` +
      `market: ${trade.conditionId.substring(0, 16)}...)`
    );

    return {
      tokenId: trade.tokenId,
      side: trade.side,
      price,
      size,
      orderType: "GTC",
    };
  }

  /**
   * Fetch the leaderboard to find good wallets to copy.
   * Returns top traders by profit.
   */
  async fetchLeaderboard(window: "1d" | "7d" | "30d" | "all" = "30d", limit: number = 20): Promise<Array<{
    address: string;
    profit: number;
    volume: number;
    rank: number;
  }>> {
    const log = getLogger();

    try {
      const url = `${DATA_API}/leaderboard?window=${window}&limit=${limit}`;
      const resp: any = await retry(async () => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Leaderboard API ${r.status}`);
        return r.json();
      });

      const entries = Array.isArray(resp) ? resp : resp.data ?? resp.leaderboard ?? [];
      return entries.map((e: any, i: number) => ({
        address: e.user ?? e.address ?? e.wallet ?? "",
        profit: parseFloat(e.profit ?? e.pnl ?? "0"),
        volume: parseFloat(e.volume ?? "0"),
        rank: e.rank ?? i + 1,
      }));
    } catch (err) {
      log.error(`Failed to fetch leaderboard: ${err}`);
      return [];
    }
  }

  /**
   * Fetch a target's current positions.
   * Useful for initial sync or checking what they're holding.
   */
  async fetchPositions(target: string): Promise<Array<{
    conditionId: string;
    tokenId: string;
    size: number;
    avgPrice: number;
  }>> {
    const log = getLogger();

    try {
      const url = `${DATA_API}/positions?user=${target}`;
      const resp: any = await retry(async () => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Positions API ${r.status}`);
        return r.json();
      });

      const positions = Array.isArray(resp) ? resp : resp.data ?? resp.positions ?? [];
      return positions.map((p: any) => ({
        conditionId: p.conditionId ?? p.condition_id ?? p.market ?? "",
        tokenId: p.assetId ?? p.asset_id ?? p.tokenId ?? "",
        size: parseFloat(p.size ?? p.amount ?? "0"),
        avgPrice: parseFloat(p.avgPrice ?? p.averagePrice ?? "0"),
      })).filter((p: any) => p.size > 0);
    } catch (err) {
      log.error(`Failed to fetch positions for ${target.substring(0, 10)}...: ${err}`);
      return [];
    }
  }

  /**
   * Get a market's neg_risk flag.
   * Caches results.
   */
  async isNegRisk(conditionId: string): Promise<boolean> {
    const cached = this.marketCache.get(conditionId);
    if (cached) return cached.negRisk;

    try {
      const url = `${GAMMA_API}/markets?condition_id=${conditionId}`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        const markets = Array.isArray(data) ? data : [data];
        if (markets[0]) {
          return markets[0].neg_risk ?? markets[0].negRisk ?? false;
        }
      }
    } catch {
      // default to false
    }
    return false;
  }
}
