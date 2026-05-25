/**
 * Sleep for ms milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clamp a number between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Round to a specific number of decimal places.
 */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Round price to valid Polymarket tick size.
 * Polymarket uses 0.01 (1 cent) or 0.001 ticks depending on market.
 */
export function roundToTick(price: number, tickSize: number = 0.01): number {
  return Math.round(price / tickSize) * tickSize;
}

/**
 * Retry an async function with exponential backoff.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxRetries) {
        const delay = baseDelay * 2 ** attempt + Math.random() * 500;
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Format USDC amount for display.
 */
export function formatUSDC(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Check if a market is near expiration (within hours).
 */
export function isNearExpiry(endDate: string, hoursThreshold: number = 2): boolean {
  const end = new Date(endDate).getTime();
  const now = Date.now();
  const hoursRemaining = (end - now) / (1000 * 60 * 60);
  return hoursRemaining <= hoursThreshold;
}

/**
 * Calculate weighted midpoint from an order book.
 */
export function weightedMidpoint(
  bestBid: number,
  bestAsk: number,
  bidSize: number,
  askSize: number
): number {
  const totalSize = bidSize + askSize;
  if (totalSize === 0) return (bestBid + bestAsk) / 2;
  // Weight toward the side with more size (thicker side pulls mid toward it)
  return (bestBid * askSize + bestAsk * bidSize) / totalSize;
}
