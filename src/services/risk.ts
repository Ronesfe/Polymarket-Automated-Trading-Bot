import { BotConfig, RiskState, InventoryState, MarketMakingState, ActiveOrder } from "../types";
import { getLogger } from "../utils/logger";

/**
 * Tracks PnL, exposure, drawdown, and decides when to stop trading.
 */
export class RiskManager {
  private config: BotConfig;
  private state: RiskState;

  constructor(config: BotConfig) {
    this.config = config;
    this.state = {
      totalExposure: 0,
      totalUnrealizedPnl: 0,
      totalRealizedPnl: 0,
      drawdown: 0,
      peakEquity: 0,
      perMarketPnl: new Map(),
      breached: false,
    };
  }

  getState(): RiskState {
    return { ...this.state, perMarketPnl: new Map(this.state.perMarketPnl) };
  }

  /**
   * Update risk state from current positions and orders.
   */
  update(marketStates: MarketMakingState[]): void {
    let totalExposure = 0;
    let totalUnrealizedPnl = 0;

    for (const ms of marketStates) {
      const inv = ms.inventory;
      const exposure = Math.abs(inv.netExposure) * ms.orderBook.midpoint;
      totalExposure += exposure;

      // Rough PnL: position value vs entry (simplified - real version tracks fills)
      const yesValue = inv.yesPosition * ms.orderBook.midpoint;
      const noValue = inv.noPosition * (1 - ms.orderBook.midpoint);
      const positionValue = yesValue + noValue;

      // Also count pending order exposure
      for (const order of ms.activeOrders) {
        if (order.status === "LIVE") {
          totalExposure += (order.size - order.sizeMatched) * order.price;
        }
      }

      this.state.perMarketPnl.set(ms.market.conditionId, positionValue);
    }

    this.state.totalExposure = totalExposure;
    this.state.totalUnrealizedPnl = totalUnrealizedPnl;

    // Track equity peak and drawdown
    const currentEquity = this.state.totalRealizedPnl + this.state.totalUnrealizedPnl;
    if (currentEquity > this.state.peakEquity) {
      this.state.peakEquity = currentEquity;
    }
    this.state.drawdown = this.state.peakEquity - currentEquity;

    // Check breaches
    this.checkBreaches();
  }

  /**
   * Record a realized fill.
   */
  recordFill(marketConditionId: string, pnl: number): void {
    this.state.totalRealizedPnl += pnl;
    const current = this.state.perMarketPnl.get(marketConditionId) ?? 0;
    this.state.perMarketPnl.set(marketConditionId, current + pnl);
  }

  /**
   * Check if any risk limits are breached.
   */
  private checkBreaches(): void {
    const log = getLogger();

    // Max drawdown
    if (this.state.drawdown >= this.config.maxDrawdown) {
      this.state.breached = true;
      this.state.breachReason = `Max drawdown breached: $${this.state.drawdown.toFixed(2)} >= $${this.config.maxDrawdown}`;
      log.error(`RISK BREACH: ${this.state.breachReason}`);
      return;
    }

    // Max total exposure
    if (this.state.totalExposure >= this.config.maxTotalExposure) {
      this.state.breached = true;
      this.state.breachReason = `Max exposure breached: $${this.state.totalExposure.toFixed(2)} >= $${this.config.maxTotalExposure}`;
      log.error(`RISK BREACH: ${this.state.breachReason}`);
      return;
    }

    // Per-market loss limits
    for (const [marketId, pnl] of this.state.perMarketPnl) {
      if (pnl <= -this.config.maxLossPerMarket) {
        this.state.breached = true;
        this.state.breachReason = `Market ${marketId} loss limit: $${pnl.toFixed(2)} <= -$${this.config.maxLossPerMarket}`;
        log.error(`RISK BREACH: ${this.state.breachReason}`);
        return;
      }
    }

    this.state.breached = false;
    this.state.breachReason = undefined;
  }

  /**
   * Should we allow new orders for this market?
   */
  canTrade(marketConditionId: string): boolean {
    if (this.state.breached) return false;

    const marketPnl = this.state.perMarketPnl.get(marketConditionId) ?? 0;
    if (marketPnl <= -this.config.maxLossPerMarket) return false;

    return true;
  }

  /**
   * Compute inventory state from active orders and known fills.
   * In production, this would query on-chain positions.
   * Here we approximate from order tracking.
   */
  computeInventory(
    marketConditionId: string,
    yesTokenId: string,
    noTokenId: string,
    orders: ActiveOrder[]
  ): InventoryState {
    let yesPosition = 0;
    let noPosition = 0;

    // Count matched portions as positions
    for (const order of orders) {
      if (order.marketConditionId !== marketConditionId) continue;
      const filled = order.sizeMatched;
      if (filled <= 0) continue;

      if (order.tokenId === yesTokenId) {
        if (order.side === "BUY") yesPosition += filled;
        else yesPosition -= filled;
      } else if (order.tokenId === noTokenId) {
        if (order.side === "BUY") noPosition += filled;
        else noPosition -= filled;
      }
    }

    const netExposure = yesPosition - noPosition;
    const totalAbs = Math.abs(yesPosition) + Math.abs(noPosition);
    const skewRatio = totalAbs > 0 ? netExposure / totalAbs : 0;

    return {
      marketConditionId,
      yesTokenId,
      noTokenId,
      yesPosition: Math.max(0, yesPosition),
      noPosition: Math.max(0, noPosition),
      netExposure,
      skewRatio,
    };
  }

  /**
   * Should we skew quotes due to inventory?
   * Returns a price adjustment: positive = raise quotes, negative = lower them.
   */
  inventorySkewAdjustment(inventory: InventoryState): number {
    if (Math.abs(inventory.skewRatio) < this.config.inventorySkewThreshold) {
      return 0;
    }

    // If long YES (positive skew), lower bid / raise ask to offload YES
    // If long NO (negative skew), raise bid / lower ask to offload NO
    // Magnitude: up to half the spread
    const maxAdj = this.config.spread / 2;
    return -inventory.skewRatio * maxAdj;
  }
}
