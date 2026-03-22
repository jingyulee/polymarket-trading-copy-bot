export type MarketLockType = 'short' | 'hard';

export interface MarketLockBehavior {
  applyLock: boolean;
  lockType: MarketLockType | null;
  lockMs: number | null;
}

const NO_LOCK_REASONS = new Set([
  'market_locked',
  'market_short_locked',
  'market_retry_exhausted',
  'source_price_out_of_range',
  'source_trade_usd_too_small',
  'non_crypto_market',
  'stale_trade',
]);

const STRATEGY_FILTER_SKIP_REASONS = new Set([
  'source_price_out_of_range',
  'source_trade_usd_too_small',
  'non_crypto_market',
  'stale_trade',
]);

export function getMarketLockBehavior(
  skipReason: string,
  marketShortLockMs: number
): MarketLockBehavior {
  if (!skipReason || NO_LOCK_REASONS.has(skipReason)) {
    return {
      applyLock: false,
      lockType: null,
      lockMs: null,
    };
  }

  return {
    applyLock: true,
    lockType: 'short',
    lockMs: marketShortLockMs,
  };
}

export function isStrategyFilterSkipReason(skipReason: string): boolean {
  return STRATEGY_FILTER_SKIP_REASONS.has(skipReason);
}
