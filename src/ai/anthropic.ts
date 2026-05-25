import Anthropic from "@anthropic-ai/sdk";
import { AISentiment, MarketInfo, OrderBookSnapshot } from "../types";
import { getLogger } from "../utils/logger";

const SYSTEM_PROMPT = `You are a prediction market analyst. You evaluate the probability of real-world events.

Given a prediction market question and current market data, provide:
1. Your estimated fair probability (0-1) for the YES outcome
2. Your confidence in that estimate (0-1)
3. Brief reasoning (2-3 sentences max)
4. Whether the market is overpricing YES, overpricing NO, or fairly priced

Respond ONLY in this exact JSON format, no other text:
{
  "fairValue": 0.XX,
  "confidence": 0.XX,
  "reasoning": "...",
  "skewDirection": "YES" | "NO" | "NEUTRAL",
  "skewMagnitude": 0.XX
}

skewDirection: "YES" means you think YES is underpriced, "NO" means NO is underpriced.
skewMagnitude: how far off the market is (0 = fair, 1 = wildly mispriced).

Be calibrated. Most markets are roughly efficient. Only signal strong skew if you have genuine reason.`;

export class AnthropicProvider {
  private client: Anthropic;
  private model = "claude-sonnet-4-20250514";

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async analyzeSentiment(
    market: MarketInfo,
    orderBook: OrderBookSnapshot
  ): Promise<AISentiment> {
    const log = getLogger();

    const userPrompt = `Market Question: "${market.question}"

Current market data:
- YES price: ${market.outcomePrices[0].toFixed(3)}
- NO price: ${market.outcomePrices[1].toFixed(3)}
- Best bid: ${orderBook.bids[0]?.price?.toFixed(3) ?? "N/A"}
- Best ask: ${orderBook.asks[0]?.price?.toFixed(3) ?? "N/A"}
- Midpoint: ${orderBook.midpoint.toFixed(3)}
- Spread: ${orderBook.spread.toFixed(3)}
- 24h Volume: $${market.volume24h.toLocaleString()}
- End date: ${market.endDate}

What is the fair probability for YES?`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const parsed = JSON.parse(text);

      return {
        marketConditionId: market.conditionId,
        question: market.question,
        fairValue: Math.max(0, Math.min(1, parsed.fairValue)),
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        reasoning: parsed.reasoning,
        skewDirection: parsed.skewDirection,
        skewMagnitude: Math.max(0, Math.min(1, parsed.skewMagnitude)),
        timestamp: Date.now(),
        provider: "anthropic",
      };
    } catch (err) {
      log.error(`Anthropic analysis failed for "${market.question}": ${err}`);
      throw err;
    }
  }
}
