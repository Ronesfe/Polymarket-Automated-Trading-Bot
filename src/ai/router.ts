import { BotConfig, AISentiment, MarketInfo, OrderBookSnapshot } from "../types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import { getLogger } from "../utils/logger";

/**
 * Routes AI requests to the configured provider(s).
 * In "none" mode: returns neutral sentiment (no API calls).
 * In "fallback" mode: tries Anthropic first, falls back to OpenAI.
 */
export class AIRouter {
  private anthropic?: AnthropicProvider;
  private openai?: OpenAIProvider;
  private mode: BotConfig["aiProvider"];
  private enabled: boolean;

  constructor(config: BotConfig) {
    this.mode = config.aiProvider;
    this.enabled = config.aiProvider !== "none";

    if (config.anthropicApiKey) {
      this.anthropic = new AnthropicProvider(config.anthropicApiKey);
    }
    if (config.openaiApiKey) {
      this.openai = new OpenAIProvider(config.openaiApiKey);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async analyze(
    market: MarketInfo,
    orderBook: OrderBookSnapshot
  ): Promise<AISentiment> {
    const log = getLogger();

    // No AI mode - return neutral
    if (!this.enabled) {
      return this.neutralSentiment(market, orderBook);
    }

    if (this.mode === "anthropic") {
      if (!this.anthropic) throw new Error("Anthropic provider not configured");
      return this.anthropic.analyzeSentiment(market, orderBook);
    }

    if (this.mode === "openai") {
      if (!this.openai) throw new Error("OpenAI provider not configured");
      return this.openai.analyzeSentiment(market, orderBook);
    }

    // Fallback mode: try Anthropic, then OpenAI
    if (this.anthropic) {
      try {
        return await this.anthropic.analyzeSentiment(market, orderBook);
      } catch (err) {
        log.warn(`Anthropic failed, falling back to OpenAI: ${err}`);
      }
    }

    if (this.openai) {
      try {
        return await this.openai.analyzeSentiment(market, orderBook);
      } catch (err) {
        log.warn(`OpenAI also failed: ${err}`);
      }
    }

    log.error("All AI providers failed, using neutral sentiment");
    return this.neutralSentiment(market, orderBook);
  }

  private neutralSentiment(market: MarketInfo, orderBook: OrderBookSnapshot): AISentiment {
    return {
      marketConditionId: market.conditionId,
      question: market.question,
      fairValue: orderBook.midpoint,
      confidence: 0,
      reasoning: "No AI analysis - using market midpoint as fair value",
      skewDirection: "NEUTRAL",
      skewMagnitude: 0,
      timestamp: Date.now(),
      provider: "anthropic",
    };
  }
}
