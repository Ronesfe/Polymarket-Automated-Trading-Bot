// ============================================
// Type definitions for the entire bot
// ============================================

export type StrategyType = "market-maker" | "momentum" | "mean-reversion" | "copy-trade" | "crypto-5m";
export type AIProviderType = "anthropic" | "openai" | "fallback" | "none";

export interface BotConfig {
  // Wallet
  privateKey: string;
  funderAddress: string;
  signatureType: number;

  // CLOB
  clobHost: string;
  chainId: number;
  clobApiKey?: string;
  clobApiSecret?: string;
  clobApiPassphrase?: string;

  // AI (optional now)
  anthropicApiKey?: string;
  openaiApiKey?: string;
  aiProvider: AIProviderType;

  // Strategy selection
  strategy: StrategyType;

  // Market Making
  spread: number;
  orderSize: number;
  maxOrdersPerSide: number;
  maxTotalExposure: number;
  refreshIntervalSec: number;
  aiSkewWeight: number;

  // Market Selection
  minVolume: number;
  minLiquidity: number;
  maxActiveMarkets: number;

  // Risk
  maxLossPerMarket: number;
  maxDrawdown: number;
  inventorySkewThreshold: number;

  // Momentum strategy
  momentumWindowMin: number;   // lookback window in minutes
  momentumThreshold: number;   // min price move to trigger (e.g. 0.03 = 3 cents)
  momentumExitTicks: number;   // take profit distance in ticks

  // Mean reversion strategy
  meanReversionWindow: number;  // EMA lookback periods
  meanReversionBand: number;    // z-score threshold to enter (e.g. 1.5)
  meanReversionExitBand: number; // z-score to exit (e.g. 0.3)

  // Copy trading
  copyTargets: string[];
  copyPollIntervalSec: number;
  copySizeMultiplier: number;
  copyMaxSizeUsd: number;
  copyDelayMs: number;
  copyIgnoreMarketsBelow: number;

  // Crypto 5-minute up/down
  cryptoAssets: string[];            // e.g. ["btc","eth","sol","xrp","bnb"]
  cryptoEntrySecBeforeClose: number; // seconds before window end to place trade
  cryptoMinConfidence: number;       // min confidence to trade (0-1)
  cryptoPricePollMs: number;         // binance price poll interval
  cryptoMaxTokenPrice: number;       // don't buy tokens above this price

  // Logging
  logLevel: string;
  logFile: string;
}

export interface MarketInfo {
  conditionId: string;
  questionId: string;
  question: string;
  slug: string;
  tokenIds: [string, string]; // [YES token, NO token]
  outcomePrices: [number, number];
  volume24h: number;
  liquidity: number;
  endDate: string;
  active: boolean;
  negRisk: boolean;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  tokenId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midpoint: number;
  spread: number;
  timestamp: number;
}

export interface QuoteParams {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  orderType: "GTC" | "GTD" | "FOK";
  expiration?: number;
}

export interface ActiveOrder {
  orderId: string;
  tokenId: string;
  marketConditionId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  sizeMatched: number;
  status: "LIVE" | "MATCHED" | "CANCELLED";
  createdAt: number;
}

export interface Position {
  tokenId: string;
  marketConditionId: string;
  side: "YES" | "NO";
  size: number;
  avgEntry: number;
  currentPrice: number;
  unrealizedPnl: number;
}

export interface InventoryState {
  marketConditionId: string;
  yesTokenId: string;
  noTokenId: string;
  yesPosition: number;
  noPosition: number;
  netExposure: number;
  skewRatio: number;
}

export interface AISentiment {
  marketConditionId: string;
  question: string;
  fairValue: number;
  confidence: number;
  reasoning: string;
  skewDirection: "YES" | "NO" | "NEUTRAL";
  skewMagnitude: number;
  timestamp: number;
  provider: "anthropic" | "openai";
}

export interface RiskState {
  totalExposure: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  drawdown: number;
  peakEquity: number;
  perMarketPnl: Map<string, number>;
  breached: boolean;
  breachReason?: string;
}

export interface MarketMakingState {
  market: MarketInfo;
  orderBook: OrderBookSnapshot;
  inventory: InventoryState;
  sentiment?: AISentiment;
  activeOrders: ActiveOrder[];
  lastRefresh: number;
}

export interface TradeLog {
  timestamp: number;
  marketConditionId: string;
  question: string;
  side: "BUY" | "SELL";
  token: "YES" | "NO";
  price: number;
  size: number;
  orderId: string;
  type: "FILL" | "PLACE" | "CANCEL";
}

// --- Price history for technical strategies ---

export interface PricePoint {
  price: number;
  timestamp: number;
}

export interface PriceHistory {
  tokenId: string;
  points: PricePoint[];
}

// --- Copy trading types ---

export interface CopyTargetTrade {
  id: string;
  user: string;
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;      // token amount
  cashSize: number;   // USDC amount
  timestamp: number;
  type: string;       // "TRADE"
}

export interface CopyTargetPosition {
  user: string;
  conditionId: string;
  tokenId: string;
  size: number;
  avgPrice: number;
  currentValue: number;
}
