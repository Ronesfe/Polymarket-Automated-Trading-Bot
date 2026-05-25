import { BotConfig, MarketMakingState, ActiveOrder, AISentiment, QuoteParams } from "../types";
import { PolymarketService } from "../services/polymarket";
import { RiskManager } from "../services/risk";
import { AIRouter } from "../ai/router";
import { MarketMaker } from "../strategies/market-maker";
import { MomentumStrategy } from "../strategies/momentum";
import { MeanReversionStrategy } from "../strategies/mean-reversion";
import { CopyTrader } from "../strategies/copy-trader";
import { Crypto5mStrategy } from "../strategies/crypto-5m";
import { MarketScanner, ScoredMarket } from "../strategies/scanner";
import { getLogger } from "../utils/logger";
import { sleep, formatUSDC } from "../utils/helpers";
import "emojifancy-print";

export class Bot {
  private config: BotConfig;
  private polymarket: PolymarketService;
  private risk: RiskManager;
  private ai: AIRouter;
  private scanner: MarketScanner;

  // Strategies (initialized based on config)
  private mmStrategy?: MarketMaker;
  private momentumStrategy?: MomentumStrategy;
  private meanRevStrategy?: MeanReversionStrategy;
  private copyTrader?: CopyTrader;
  private crypto5m?: Crypto5mStrategy;

  private activeMarkets: Map<string, MarketMakingState> = new Map();
  private sentimentCache: Map<string, AISentiment> = new Map();
  private running = false;
  private cycleCount = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.polymarket = new PolymarketService(config);
    this.risk = new RiskManager(config);
    this.ai = new AIRouter(config);
    this.scanner = new MarketScanner(this.polymarket);
  }

  async start(): Promise<void> {
    const log = getLogger();
    log.info("=== Polymarket Trading Bot ===");
    log.info(`Strategy: ${this.config.strategy}`);
    log.info(`Order size: ${formatUSDC(this.config.orderSize)}`);
    log.info(`Max exposure: ${formatUSDC(this.config.maxTotalExposure)}, Max drawdown: ${formatUSDC(this.config.maxDrawdown)}`);
    log.info(`AI: ${this.config.aiProvider === "none" ? "disabled" : this.config.aiProvider}`);

    // Init strategy
    switch (this.config.strategy) {
      case "market-maker":
        this.mmStrategy = new MarketMaker(this.config);
        log.info(`Spread: ${this.config.spread}, Layers: ${this.config.maxOrdersPerSide}`);
        break;
      case "momentum":
        this.momentumStrategy = new MomentumStrategy(this.config);
        log.info(`Window: ${this.config.momentumWindowMin}min, Threshold: ${(this.config.momentumThreshold * 100).toFixed(1)}¢`);
        break;
      case "mean-reversion":
        this.meanRevStrategy = new MeanReversionStrategy(this.config);
        log.info(`EMA window: ${this.config.meanReversionWindow}, Entry z: ${this.config.meanReversionBand}, Exit z: ${this.config.meanReversionExitBand}`);
        break;
      case "copy-trade":
        this.copyTrader = new CopyTrader(this.config);
        log.info(`Targets: ${this.config.copyTargets.length} wallets`);
        log.info(`Size multiplier: ${this.config.copySizeMultiplier}x, Max per trade: ${formatUSDC(this.config.copyMaxSizeUsd)}`);
        for (const t of this.config.copyTargets) {
          log.info(`  -> ${t}`);
        }
        break;
      case "crypto-5m":
        this.crypto5m = new Crypto5mStrategy(this.config);
        log.info(`Assets: ${this.config.cryptoAssets.map(a => a.toUpperCase()).join(", ")}`);
        log.info(`Entry: ${this.config.cryptoEntrySecBeforeClose}s before close, Min confidence: ${(this.config.cryptoMinConfidence * 100).toFixed(0)}%`);
        log.info(`Max token price: ${this.config.cryptoMaxTokenPrice}, Price poll: ${this.config.cryptoPricePollMs}ms`);
        break;
    }

    // Connect to Polymarket
    log.info("Connecting to Polymarket CLOB...");
    await this.polymarket.init();
    log.info("Connected.");

    // Cancel stale orders
    log.info("Cancelling stale orders...");
    await this.polymarket.cancelAll();

    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));

    this.running = true;
    log.info("Bot started. Entering main loop.\n");

    if (this.config.strategy === "copy-trade") {
      await this.copyTradeLoop();
    } else if (this.config.strategy === "crypto-5m") {
      await this.crypto5mLoop();
    } else {
      await this.tradingLoop();
    }
  }

  // ====================================================
  // Copy trading loop (separate flow - poll based)
  // ====================================================
  private async copyTradeLoop(): Promise<void> {
    const log = getLogger();

    while (this.running) {
      try {
        this.cycleCount++;

        // Check risk
        const riskState = this.risk.getState();
        if (riskState.breached) {
          log.error(`Risk breach: ${riskState.breachReason} - pausing 60s`);
          await this.polymarket.cancelAll();
          await sleep(60_000);
          continue;
        }

        // Poll targets for new trades
        const orders = await this.copyTrader!.pollTargets();

        // Execute copy orders
        for (const order of orders) {
          if (!this.risk.canTrade(order.tokenId)) {
            log.warn(`Risk blocking copy trade for ${order.tokenId}`);
            continue;
          }

          const negRisk = await this.copyTrader!.isNegRisk(order.tokenId);
          await this.polymarket.placeOrder(order, negRisk);
        }

        if (orders.length > 0) {
          log.info(`Cycle #${this.cycleCount}: copied ${orders.length} trades`);
        } else if (this.cycleCount % 20 === 0) {
          log.debug(`Cycle #${this.cycleCount}: no new trades from targets`);
        }

        await sleep(this.config.copyPollIntervalSec * 1000);
      } catch (err) {
        log.error(`Copy trade loop error: ${err}`);
        await sleep(5000);
      }
    }
  }

  // ====================================================
  // Crypto 5-minute up/down loop
  // ====================================================
  private async crypto5mLoop(): Promise<void> {
    const log = getLogger();
    const strategy = this.crypto5m!;
    let lastMarketFetch = 0;
    let currentMarkets: Map<string, any> = new Map(); // asset -> MarketInfo

    while (this.running) {
      try {
        this.cycleCount++;

        // Check risk
        const riskState = this.risk.getState();
        if (riskState.breached) {
          log.error(`Risk breach: ${riskState.breachReason} - pausing 60s`);
          await sleep(60_000);
          continue;
        }

        // Poll Binance prices for all assets
        await strategy.pollPrices();

        // Fetch Polymarket markets when entering a new window or periodically
        const needNewMarkets = strategy.getAssets().some(a => strategy.isNewWindow(a));
        const marketFetchAge = Date.now() - lastMarketFetch;
        if (needNewMarkets || marketFetchAge > 60_000) {
          log.info("Fetching crypto 5m markets from Polymarket...");
          const markets = await this.polymarket.getCryptoUpDownMarkets(strategy.getAssets());

          currentMarkets.clear();
          for (const m of markets) {
            // Match market to asset by slug prefix
            for (const asset of strategy.getAssets()) {
              if (m.slug.startsWith(`${asset}-updown-5m`)) {
                currentMarkets.set(asset, m);
                strategy.setMarket(asset, m);
                break;
              }
            }
          }
          lastMarketFetch = Date.now();
        }

        // Evaluate signals for each asset
        for (const asset of strategy.getAssets()) {
          const market = currentMarkets.get(asset);
          if (!market) continue;

          const signal = strategy.evaluate(asset);
          if (!signal) continue;

          // Get the orderbook for the Up token
          try {
            const orderBook = await this.polymarket.getOrderBook(market.tokenIds[0]);
            const order = strategy.generateOrder(signal, market, orderBook);

            if (order) {
              await this.polymarket.placeOrder(order, market.negRisk);
            }
          } catch (err) {
            log.error(`Failed to trade ${asset}: ${err}`);
          }
        }

        // Log status periodically
        if (this.cycleCount % 10 === 0) {
          log.info(`\n${strategy.getStatus()}`);
        }

        await sleep(this.config.cryptoPricePollMs);
      } catch (err) {
        log.error(`Crypto 5m loop error: ${err}`);
        await sleep(3000);
      }
    }
  }

  // ====================================================
  // Standard trading loop (MM, momentum, mean-reversion)
  // ====================================================
  private async tradingLoop(): Promise<void> {
    const log = getLogger();

    while (this.running) {
      try {
        this.cycleCount++;
        const cycleStart = Date.now();

        // Rescan markets periodically
        if (this.cycleCount % 10 === 1 || this.activeMarkets.size === 0) {
          await this.selectMarkets();
        }

        // Check risk
        const riskState = this.risk.getState();
        if (riskState.breached) {
          log.error(`Risk breach: ${riskState.breachReason} - pausing 60s`);
          await this.polymarket.cancelAll();
          this.activeMarkets.clear();
          await sleep(60_000);
          continue;
        }

        // Process each active market
        for (const [conditionId, state] of this.activeMarkets) {
          try {
            await this.processMarket(conditionId, state);
          } catch (err) {
            log.error(`Error processing ${conditionId}: ${err}`);
          }
        }

        // Update risk
        this.risk.update(Array.from(this.activeMarkets.values()));

        const elapsed = Date.now() - cycleStart;
        log.info(
          `Cycle #${this.cycleCount} (${elapsed}ms) | ` +
          `Markets: ${this.activeMarkets.size} | ` +
          `Exposure: ${formatUSDC(riskState.totalExposure)} | ` +
          `PnL: ${formatUSDC(riskState.totalRealizedPnl + riskState.totalUnrealizedPnl)}`
        );

        await sleep(this.config.refreshIntervalSec * 1000);
      } catch (err) {
        log.error(`Main loop error: ${err}`);
        await sleep(5000);
      }
    }
  }

  /**
   * Process a single market based on the active strategy.
   */
  private async processMarket(conditionId: string, state: MarketMakingState): Promise<void> {
    if (!this.risk.canTrade(conditionId)) return;

    // Get fresh order book
    const orderBook = await this.polymarket.getOrderBook(state.market.tokenIds[0]);
    state.orderBook = orderBook;

    // Route to the right strategy
    switch (this.config.strategy) {
      case "market-maker":
        await this.processMarketMaking(conditionId, state);
        break;
      case "momentum":
        await this.processMomentum(conditionId, state);
        break;
      case "mean-reversion":
        await this.processMeanReversion(conditionId, state);
        break;
    }
  }

  // --- Market Making ---
  private async processMarketMaking(conditionId: string, state: MarketMakingState): Promise<void> {
    const log = getLogger();

    // AI sentiment (optional)
    let sentiment = this.sentimentCache.get(conditionId);
    if (this.ai.isEnabled()) {
      const sentimentAge = sentiment ? Date.now() - sentiment.timestamp : Infinity;
      if (sentimentAge > 5 * 60 * 1000) {
        try {
          sentiment = await this.ai.analyze(state.market, state.orderBook);
          this.sentimentCache.set(conditionId, sentiment);
          log.info(
            `AI: "${state.market.question.substring(0, 40)}..." -> ` +
            `fair=${sentiment.fairValue.toFixed(3)}, conf=${sentiment.confidence.toFixed(2)}`
          );
        } catch (err) {
          log.warn(`AI failed: ${err}`);
        }
      }
    }
    state.sentiment = sentiment;

    // Get open orders
    const allOrders = await this.polymarket.getOpenOrders();
    state.activeOrders = allOrders.filter(
      (o) => o.tokenId === state.market.tokenIds[0] || o.tokenId === state.market.tokenIds[1]
    );

    // Inventory
    state.inventory = this.risk.computeInventory(
      conditionId, state.market.tokenIds[0], state.market.tokenIds[1], allOrders
    );

    // Refresh check
    const lastMid = state.lastRefresh > 0 ? state.orderBook.midpoint : 0;
    const needsRefresh =
      state.lastRefresh === 0 ||
      state.activeOrders.length === 0 ||
      this.mmStrategy!.shouldRefresh(state.orderBook, lastMid);

    if (!needsRefresh) return;

    // Cancel old, place new
    for (const order of state.activeOrders) {
      await this.polymarket.cancelOrder(order.orderId);
    }

    const inventoryAdj = this.risk.inventorySkewAdjustment(state.inventory);
    const quotePairs = this.mmStrategy!.generateQuotes(
      state.market, state.orderBook, sentiment, state.inventory, inventoryAdj
    );

    const newOrders: ActiveOrder[] = [];
    for (const pair of quotePairs) {
      const bidId = await this.polymarket.placeOrder(pair.bid, state.market.negRisk);
      const askId = await this.polymarket.placeOrder(pair.ask, state.market.negRisk);
      if (bidId) {
        newOrders.push({
          orderId: bidId, tokenId: pair.bid.tokenId, marketConditionId: conditionId,
          side: "BUY", price: pair.bid.price, size: pair.bid.size, sizeMatched: 0,
          status: "LIVE", createdAt: Date.now(),
        });
      }
      if (askId) {
        newOrders.push({
          orderId: askId, tokenId: pair.ask.tokenId, marketConditionId: conditionId,
          side: "SELL", price: pair.ask.price, size: pair.ask.size, sizeMatched: 0,
          status: "LIVE", createdAt: Date.now(),
        });
      }
    }

    state.activeOrders = newOrders;
    state.lastRefresh = Date.now();
  }

  // --- Momentum ---
  private async processMomentum(conditionId: string, state: MarketMakingState): Promise<void> {
    const tokenId = state.market.tokenIds[0];

    // Record price
    this.momentumStrategy!.recordPrice(tokenId, state.orderBook.midpoint);

    // Evaluate
    const signal = this.momentumStrategy!.evaluate(tokenId, state.orderBook);
    const order = this.momentumStrategy!.generateOrder(signal, state.market, state.orderBook);

    if (order) {
      await this.polymarket.placeOrder(order, state.market.negRisk);
    }
  }

  // --- Mean Reversion ---
  private async processMeanReversion(conditionId: string, state: MarketMakingState): Promise<void> {
    const tokenId = state.market.tokenIds[0];

    // Record price
    this.meanRevStrategy!.recordPrice(tokenId, state.orderBook.midpoint);

    // Evaluate
    const signal = this.meanRevStrategy!.evaluate(tokenId, state.orderBook);
    const order = this.meanRevStrategy!.generateOrder(signal, state.market, state.orderBook);

    if (order) {
      await this.polymarket.placeOrder(order, state.market.negRisk);
    }
  }

  // --- Market Selection ---
  private async selectMarkets(): Promise<void> {
    const log = getLogger();
    log.info("Scanning markets...");

    const scored = await this.scanner.scanAndRank();
    const selected = scored.slice(0, this.config.maxActiveMarkets);

    // Remove dropped markets
    const selectedIds = new Set(selected.map((s) => s.market.conditionId));
    for (const [conditionId] of this.activeMarkets) {
      if (!selectedIds.has(conditionId)) {
        const state = this.activeMarkets.get(conditionId);
        if (state) {
          for (const order of state.activeOrders) {
            await this.polymarket.cancelOrder(order.orderId);
          }
        }
        this.activeMarkets.delete(conditionId);
      }
    }

    // Add new markets
    for (const scored of selected) {
      if (!this.activeMarkets.has(scored.market.conditionId)) {
        this.initMarketState(scored);
      }
    }
  }

  private initMarketState(scored: ScoredMarket): void {
    const log = getLogger();
    const market = scored.market;
    log.info(`+ "${market.question.substring(0, 60)}" (score: ${scored.score.toFixed(1)})`);

    const inventory = this.risk.computeInventory(
      market.conditionId, market.tokenIds[0], market.tokenIds[1], []
    );

    this.activeMarkets.set(market.conditionId, {
      market, orderBook: scored.orderBook, inventory, activeOrders: [], lastRefresh: 0,
    });
  }

  // --- Shutdown ---
  async shutdown(signal: string): Promise<void> {
    const log = getLogger();
    log.info(`\n${signal} received, shutting down...`);
    this.running = false;

    log.info("Cancelling all open orders...");
    await this.polymarket.cancelAll();

    const rs = this.risk.getState();
    log.info("=== Final State ===");
    log.info(`Realized PnL: ${formatUSDC(rs.totalRealizedPnl)}`);
    log.info(`Unrealized PnL: ${formatUSDC(rs.totalUnrealizedPnl)}`);
    log.info(`Drawdown: ${formatUSDC(rs.drawdown)}`);
    log.info(`Cycles: ${this.cycleCount}`);
    log.info("Stopped.");

    process.exit(0);
  }
}
