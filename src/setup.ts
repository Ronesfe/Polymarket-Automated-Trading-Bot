/**
 * Setup script: derives CLOB API credentials and verifies connectivity.
 * Run this once before starting the bot.
 *
 * Usage: npm run setup
 */
import { loadConfig, validateConfig } from "./config";
import { initLogger, getLogger } from "./utils/logger";
import { PolymarketService } from "./services/polymarket";

async function main() {
  const config = loadConfig();
  initLogger("info", "setup.log");
  const log = getLogger();

  log.info("=== Polymarket Bot Setup ===");

  // Validate config
  try {
    validateConfig(config);
    log.info("Config validation passed");
  } catch (err) {
    log.error(`Config validation failed: ${err}`);
    process.exit(1);
  }

  // Test CLOB connection
  log.info("Testing CLOB connection...");
  const polymarket = new PolymarketService(config);
  try {
    await polymarket.init();
    log.info("CLOB connection successful");
  } catch (err) {
    log.error(`CLOB connection failed: ${err}`);
    log.error("Check your PRIVATE_KEY and network connection");
    process.exit(1);
  }

  // Test market data
  log.info("Fetching market data...");
  try {
    const markets = await polymarket.getActiveMarkets();
    log.info(`Found ${markets.length} eligible markets`);
    if (markets.length > 0) {
      const sample = markets[0];
      log.info(`Sample market: "${sample.question}"`);
      log.info(`  YES: ${sample.outcomePrices[0].toFixed(3)}, NO: ${sample.outcomePrices[1].toFixed(3)}`);
      log.info(`  Volume: $${sample.volume24h.toLocaleString()}`);

      // Test order book
      const book = await polymarket.getOrderBook(sample.tokenIds[0]);
      log.info(`  Book: ${book.bids.length} bids, ${book.asks.length} asks, spread=${(book.spread * 100).toFixed(1)}¢`);
    }
  } catch (err) {
    log.error(`Market data test failed: ${err}`);
  }

  // Test AI (optional)
  if (config.anthropicApiKey || config.openaiApiKey) {
    log.info("Testing AI provider...");
    const { AIRouter } = await import("./ai/router");
    const ai = new AIRouter(config);
    try {
      const markets = await polymarket.getActiveMarkets();
      if (markets.length > 0) {
        const book = await polymarket.getOrderBook(markets[0].tokenIds[0]);
        const sentiment = await ai.analyze(markets[0], book);
        log.info(`AI test result: fair=${sentiment.fairValue.toFixed(3)}, provider=${sentiment.provider}`);
        log.info(`  Reasoning: ${sentiment.reasoning}`);
      }
    } catch (err) {
      log.error(`AI test failed: ${err}`);
      log.error("Bot will still work, but without AI-driven skew");
    }
  }

  log.info("=== Setup Complete ===");
  log.info("You can now run the bot with: npm run dev");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
