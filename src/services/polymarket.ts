import { ClobClient, ApiKeyCreds, Side, OrderType } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  BotConfig,
  MarketInfo,
  OrderBookSnapshot,
  OrderBookLevel,
  ActiveOrder,
  QuoteParams,
} from "../types";
import { getLogger } from "../utils/logger";
import { retry } from "../utils/helpers";

export class PolymarketService {
  private client!: ClobClient;
  private config: BotConfig;
  private authenticated = false;

  constructor(config: BotConfig) {
    this.config = config;
  }

  /**
   * Initialize the CLOB client with authentication.
   * Derives API creds from private key if not provided.
   */
  async init(): Promise<void> {
    const log = getLogger();
    const account = privateKeyToAccount(this.config.privateKey as `0x${string}`);

    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    // If we already have API creds, use them
    if (this.config.clobApiKey && this.config.clobApiSecret && this.config.clobApiPassphrase) {
      const creds: ApiKeyCreds = {
        key: this.config.clobApiKey,
        secret: this.config.clobApiSecret,
        passphrase: this.config.clobApiPassphrase,
      };

      this.client = new ClobClient(
        this.config.clobHost,
        this.config.chainId,
        signer,
        creds,
        this.config.signatureType,
        this.config.funderAddress || undefined
      );
      this.authenticated = true;
      log.info("CLOB client initialized with existing API creds");
      return;
    }

    // Derive API creds from private key
    log.info("Deriving CLOB API credentials from private key...");
    const tempClient = new ClobClient(
      this.config.clobHost,
      this.config.chainId,
      signer
    );

    const creds = await tempClient.createOrDeriveApiKey();
    log.info("API credentials derived successfully");
    log.info(`Save these in your .env to skip derivation next time:`);
    log.info(`  CLOB_API_KEY=${creds.key}`);
    log.info(`  CLOB_API_SECRET=${creds.secret}`);
    log.info(`  CLOB_API_PASSPHRASE=${creds.passphrase}`);

    this.client = new ClobClient(
      this.config.clobHost,
      this.config.chainId,
      signer,
      creds,
      this.config.signatureType,
      this.config.funderAddress || undefined
    );
    this.authenticated = true;
  }

  /**
   * Fetch active markets from the Gamma API (the right source for discovery).
   * The CLOB SDK's getMarkets() returns a different structure - Gamma is what
   * gives us the full market catalog with volume, liquidity, tokens, etc.
   */
  async getActiveMarkets(): Promise<MarketInfo[]> {
    const log = getLogger();
    const GAMMA_API = "https://gamma-api.polymarket.com";

    try {
      const markets: MarketInfo[] = [];
      let offset = 0;
      const pageSize = 100;

      // Paginate through active events sorted by volume
      while (markets.length < this.config.maxActiveMarkets * 3) {
        const url =
          `${GAMMA_API}/events?active=true&closed=false&limit=${pageSize}&offset=${offset}` +
          `&order=volume_24hr&ascending=false`;

        const resp = await retry(async () => {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`Gamma API ${r.status}: ${r.statusText}`);
          return r.json() as Promise<any[]>;
        });

        if (!Array.isArray(resp) || resp.length === 0) break;

        for (const event of resp) {
          const eventMarkets = event.markets ?? [];
          for (const m of eventMarkets) {
            if (!m.active || m.closed) continue;

            // Extract tokens - markets have clobTokenIds (JSON string)
            // and outcomePrices (JSON string)
            let tokenIds: string[] = [];
            try {
              tokenIds = typeof m.clobTokenIds === "string"
                ? JSON.parse(m.clobTokenIds)
                : m.clobTokenIds ?? [];
            } catch {
              continue;
            }
            if (tokenIds.length < 2) continue;

            let outcomePrices: number[] = [];
            try {
              const raw = typeof m.outcomePrices === "string"
                ? JSON.parse(m.outcomePrices)
                : m.outcomePrices ?? [];
              outcomePrices = raw.map((p: any) => parseFloat(p));
            } catch {
              outcomePrices = [0.5, 0.5];
            }

            const volume = parseFloat(m.volume_num_24hr ?? m.volume24hr ?? m.volume ?? "0");
            const liquidity = parseFloat(m.liquidity_num ?? m.liquidityNum ?? m.liquidity ?? "0");

            if (volume < this.config.minVolume) continue;
            if (liquidity < this.config.minLiquidity) continue;

            markets.push({
              conditionId: m.conditionId ?? m.condition_id ?? "",
              questionId: m.questionId ?? m.question_id ?? "",
              question: m.question ?? m.groupItemTitle ?? event.title ?? "Unknown",
              slug: m.slug ?? event.slug ?? "",
              tokenIds: [tokenIds[0], tokenIds[1]] as [string, string],
              outcomePrices: [outcomePrices[0] ?? 0.5, outcomePrices[1] ?? 0.5] as [number, number],
              volume24h: volume,
              liquidity,
              endDate: m.endDate ?? m.end_date_iso ?? event.endDate ?? "",
              active: true,
              negRisk: m.negRisk ?? m.neg_risk ?? event.negRisk ?? false,
            });
          }
        }

        // If we got fewer than pageSize, there are no more pages
        if (resp.length < pageSize) break;
        offset += pageSize;
      }

      // Sort by volume descending
      markets.sort((a, b) => b.volume24h - a.volume24h);
      const selected = markets.slice(0, this.config.maxActiveMarkets);

      log.info(`Found ${markets.length} eligible markets, selected top ${selected.length}`);
      for (const m of selected) {
        log.info(`  -> "${m.question.substring(0, 55)}" vol=$${(m.volume24h / 1000).toFixed(1)}k liq=$${(m.liquidity / 1000).toFixed(1)}k`);
      }
      return selected;
    } catch (err) {
      log.error(`Failed to fetch markets: ${err}`);
      return [];
    }
  }

  /**
   * Get order book snapshot for a token.
   */
  async getOrderBook(tokenId: string): Promise<OrderBookSnapshot> {
    const raw = await retry(() => this.client.getOrderBook(tokenId));

    const parseLevels = (levels: any[]): OrderBookLevel[] =>
      (levels ?? []).map((l: any) => ({
        price: parseFloat(l.price),
        size: parseFloat(l.size),
      }));

    const bids = parseLevels(raw.bids);
    const asks = parseLevels(raw.asks);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;
    const midpoint = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    return {
      tokenId,
      bids,
      asks,
      midpoint,
      spread,
      timestamp: Date.now(),
    };
  }

  /**
   * Place a limit order.
   */
  async placeOrder(params: QuoteParams, negRisk: boolean): Promise<string | null> {
    const log = getLogger();

    if (!this.authenticated) {
      log.error("Cannot place order: not authenticated");
      return null;
    }

    try {
      const orderArgs = {
        tokenID: params.tokenId,
        price: params.price,
        size: params.size,
        side: params.side === "BUY" ? Side.BUY : Side.SELL,
      };

      let orderType: any;
      switch (params.orderType) {
        case "GTC": orderType = OrderType.GTC; break;
        case "GTD": orderType = OrderType.GTD; break;
        case "FOK": orderType = OrderType.FOK; break;
        default: orderType = OrderType.GTC;
      }

      const resp = await this.client.createAndPostOrder(orderArgs, orderType as any, negRisk as any);

      const orderId = (resp as any)?.orderID ?? (resp as any)?.id ?? null;
      if (orderId) {
        log.info(`Order placed: ${params.side} ${params.size} @ ${params.price} -> ${orderId}`);
      }
      return orderId;
    } catch (err) {
      log.error(`Failed to place order: ${err}`);
      return null;
    }
  }

  /**
   * Cancel a specific order.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    const log = getLogger();
    try {
      await this.client.cancelOrder(orderId as any);
      log.debug(`Cancelled order ${orderId}`);
      return true;
    } catch (err) {
      log.error(`Failed to cancel order ${orderId}: ${err}`);
      return false;
    }
  }

  /**
   * Cancel all open orders.
   */
  async cancelAll(): Promise<void> {
    const log = getLogger();
    try {
      await this.client.cancelAll();
      log.info("All open orders cancelled");
    } catch (err) {
      log.error(`Failed to cancel all orders: ${err}`);
    }
  }

  /**
   * Get current open orders.
   */
  async getOpenOrders(): Promise<ActiveOrder[]> {
    try {
      const raw = await this.client.getOpenOrders();
      const orders = Array.isArray(raw) ? raw : (raw as any).data ?? [];

      return orders.map((o: any) => ({
        orderId: o.id ?? o.order_id,
        tokenId: o.asset_id ?? o.tokenID,
        marketConditionId: o.market ?? o.condition_id ?? "",
        side: o.side === "BUY" ? "BUY" : "SELL",
        price: parseFloat(o.price),
        size: parseFloat(o.original_size ?? o.size),
        sizeMatched: parseFloat(o.size_matched ?? "0"),
        status: o.status ?? "LIVE",
        createdAt: new Date(o.created_at ?? o.timestamp ?? Date.now()).getTime(),
      })) as ActiveOrder[];
    } catch (err) {
      getLogger().error(`Failed to fetch open orders: ${err}`);
      return [];
    }
  }

  /**
   * Get midpoint price for a token.
   */
  async getMidpoint(tokenId: string): Promise<number> {
    try {
      const mid = await this.client.getMidpoint(tokenId);
      return parseFloat(mid as any) || 0.5;
    } catch {
      return 0.5;
    }
  }

  /**
   * Fetch a single market by its Gamma slug.
   * Returns null if not found or not active.
   */
  async fetchMarketBySlug(slug: string): Promise<MarketInfo | null> {
    const GAMMA_API = "https://gamma-api.polymarket.com";
    try {
      const url = `${GAMMA_API}/markets?slug=${slug}`;
      const r = await fetch(url);
      if (!r.ok) return null;

      const data: any = await r.json();
      // Gamma returns an array or single object
      const items = Array.isArray(data) ? data : [data];
      const m = items[0];
      if (!m || !m.conditionId) return null;

      let tokenIds: string[] = [];
      try {
        tokenIds = typeof m.clobTokenIds === "string"
          ? JSON.parse(m.clobTokenIds)
          : m.clobTokenIds ?? [];
      } catch {
        return null;
      }
      if (tokenIds.length < 2) return null;

      let outcomePrices: number[] = [];
      try {
        const raw = typeof m.outcomePrices === "string"
          ? JSON.parse(m.outcomePrices)
          : m.outcomePrices ?? [];
        outcomePrices = raw.map((p: any) => parseFloat(p));
      } catch {
        outcomePrices = [0.5, 0.5];
      }

      return {
        conditionId: m.conditionId ?? "",
        questionId: m.questionId ?? "",
        question: m.question ?? m.groupItemTitle ?? slug,
        slug: m.slug ?? slug,
        tokenIds: [tokenIds[0], tokenIds[1]] as [string, string],
        outcomePrices: [outcomePrices[0] ?? 0.5, outcomePrices[1] ?? 0.5] as [number, number],
        volume24h: parseFloat(m.volume_num_24hr ?? m.volume ?? "0"),
        liquidity: parseFloat(m.liquidity_num ?? m.liquidity ?? "0"),
        endDate: m.endDate ?? m.end_date_iso ?? "",
        active: m.active ?? true,
        negRisk: m.negRisk ?? m.neg_risk ?? false,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch the current and next 5-minute crypto up/down markets for given assets.
   * Slug pattern: {asset}-updown-5m-{unix_timestamp}
   * Timestamp = floor(now / 300) * 300
   */
  async getCryptoUpDownMarkets(assets: string[]): Promise<MarketInfo[]> {
    const log = getLogger();
    const now = Math.floor(Date.now() / 1000);
    const currentWindow = Math.floor(now / 300) * 300;
    const nextWindow = currentWindow + 300;

    const markets: MarketInfo[] = [];

    for (const asset of assets) {
      // Try current window first, then next
      for (const ts of [currentWindow, nextWindow]) {
        const slug = `${asset}-updown-5m-${ts}`;
        const market = await this.fetchMarketBySlug(slug);
        if (market && market.active) {
          markets.push(market);
          log.info(`  [${asset.toUpperCase()}] ${slug} -> YES=${market.outcomePrices[0].toFixed(2)} NO=${market.outcomePrices[1].toFixed(2)}`);
          break; // found one for this asset, move to next
        }
      }
    }

    log.info(`Found ${markets.length}/${assets.length} crypto 5m markets`);
    return markets;
  }
}
