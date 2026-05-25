import dotenv from "dotenv";
import { BotConfig, AIProviderType, StrategyType } from "../types";

dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function parseList(val: string): string[] {
  if (!val.trim()) return [];
  return val.split(",").map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): BotConfig {
  const aiProvider = optionalEnv("AI_PROVIDER", "none") as AIProviderType;
  const strategy = optionalEnv("STRATEGY", "market-maker") as StrategyType;

  return {
    privateKey: requireEnv("PRIVATE_KEY"),
    funderAddress: optionalEnv("FUNDER_ADDRESS", ""),
    signatureType: parseInt(optionalEnv("SIGNATURE_TYPE", "0")),

    clobHost: optionalEnv("CLOB_HOST", "https://clob.polymarket.com"),
    chainId: parseInt(optionalEnv("CHAIN_ID", "137")),
    clobApiKey: process.env.CLOB_API_KEY || undefined,
    clobApiSecret: process.env.CLOB_API_SECRET || undefined,
    clobApiPassphrase: process.env.CLOB_API_PASSPHRASE || undefined,

    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: process.env.OPENAI_API_KEY || undefined,
    aiProvider,

    strategy,

    spread: parseFloat(optionalEnv("SPREAD", "0.02")),
    orderSize: parseFloat(optionalEnv("ORDER_SIZE", "10")),
    maxOrdersPerSide: parseInt(optionalEnv("MAX_ORDERS_PER_SIDE", "3")),
    maxTotalExposure: parseFloat(optionalEnv("MAX_TOTAL_EXPOSURE", "500")),
    refreshIntervalSec: parseInt(optionalEnv("REFRESH_INTERVAL_SEC", "30")),
    aiSkewWeight: parseFloat(optionalEnv("AI_SKEW_WEIGHT", "0.2")),

    minVolume: parseFloat(optionalEnv("MIN_VOLUME", "5000")),
    minLiquidity: parseFloat(optionalEnv("MIN_LIQUIDITY", "1000")),
    maxActiveMarkets: parseInt(optionalEnv("MAX_ACTIVE_MARKETS", "5")),

    maxLossPerMarket: parseFloat(optionalEnv("MAX_LOSS_PER_MARKET", "50")),
    maxDrawdown: parseFloat(optionalEnv("MAX_DRAWDOWN", "200")),
    inventorySkewThreshold: parseFloat(optionalEnv("INVENTORY_SKEW_THRESHOLD", "0.6")),

    // Momentum
    momentumWindowMin: parseInt(optionalEnv("MOMENTUM_WINDOW_MIN", "15")),
    momentumThreshold: parseFloat(optionalEnv("MOMENTUM_THRESHOLD", "0.03")),
    momentumExitTicks: parseInt(optionalEnv("MOMENTUM_EXIT_TICKS", "3")),

    // Mean reversion
    meanReversionWindow: parseInt(optionalEnv("MEAN_REVERSION_WINDOW", "30")),
    meanReversionBand: parseFloat(optionalEnv("MEAN_REVERSION_BAND", "1.5")),
    meanReversionExitBand: parseFloat(optionalEnv("MEAN_REVERSION_EXIT_BAND", "0.3")),

    // Copy trading
    copyTargets: parseList(optionalEnv("COPY_TARGETS", "")),
    copyPollIntervalSec: parseInt(optionalEnv("COPY_POLL_INTERVAL_SEC", "15")),
    copySizeMultiplier: parseFloat(optionalEnv("COPY_SIZE_MULTIPLIER", "0.5")),
    copyMaxSizeUsd: parseFloat(optionalEnv("COPY_MAX_SIZE_USD", "25")),
    copyDelayMs: parseInt(optionalEnv("COPY_DELAY_MS", "2000")),
    copyIgnoreMarketsBelow: parseFloat(optionalEnv("COPY_IGNORE_MARKETS_BELOW", "1000")),

    // Crypto 5m
    cryptoAssets: parseList(optionalEnv("CRYPTO_ASSETS", "btc,eth,sol,xrp,bnb")),
    cryptoEntrySecBeforeClose: parseInt(optionalEnv("CRYPTO_ENTRY_SEC_BEFORE_CLOSE", "120")),
    cryptoMinConfidence: parseFloat(optionalEnv("CRYPTO_MIN_CONFIDENCE", "0.45")),
    cryptoPricePollMs: parseInt(optionalEnv("CRYPTO_PRICE_POLL_MS", "3000")),
    cryptoMaxTokenPrice: parseFloat(optionalEnv("CRYPTO_MAX_TOKEN_PRICE", "0.92")),

    logLevel: optionalEnv("LOG_LEVEL", "info"),
    logFile: optionalEnv("LOG_FILE", "bot.log"),
  };
}

export function validateConfig(config: BotConfig): void {
  if (!config.privateKey.startsWith("0x")) {
    throw new Error("PRIVATE_KEY must start with 0x");
  }

  // AI validation: only enforce if provider is not "none"
  if (config.aiProvider === "anthropic" && !config.anthropicApiKey) {
    throw new Error("AI_PROVIDER is anthropic but ANTHROPIC_API_KEY is missing");
  }
  if (config.aiProvider === "openai" && !config.openaiApiKey) {
    throw new Error("AI_PROVIDER is openai but OPENAI_API_KEY is missing");
  }
  if (config.aiProvider === "fallback" && !config.anthropicApiKey && !config.openaiApiKey) {
    throw new Error("AI_PROVIDER is fallback but no AI API keys are set");
  }
  // "none" is always valid - no AI needed

  if (config.spread <= 0 || config.spread >= 0.5) {
    throw new Error("SPREAD must be between 0 and 0.5");
  }
  if (config.orderSize <= 0) {
    throw new Error("ORDER_SIZE must be positive");
  }

  // Strategy-specific validation
  const validStrategies: StrategyType[] = ["market-maker", "momentum", "mean-reversion", "copy-trade", "crypto-5m"];
  if (!validStrategies.includes(config.strategy)) {
    throw new Error(`STRATEGY must be one of: ${validStrategies.join(", ")}`);
  }

  if (config.strategy === "copy-trade" && config.copyTargets.length === 0) {
    throw new Error("COPY_TARGETS is required when STRATEGY=copy-trade. Provide comma-separated wallet addresses.");
  }
}
