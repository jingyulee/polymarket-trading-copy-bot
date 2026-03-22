export type MarketLockType = 'short' | 'hard';

export interface MarketLockBehavior {
  applyLock: boolean;
  lockType: MarketLockType | null;
  lockMs: number | null;
  incrementRetry: boolean;
  softened?: boolean;
}

const NO_LOCK_REASONS = new Set([
  'market_already_executed',
  'market_locked',
  'market_short_locked',
  'market_retry_exhausted',
  'source_price_out_of_range',
  'source_trade_usd_too_small',
  'non_crypto_market',
  'stale_trade',
  'stale',
  'too_small',
  'market_outcome_map_missing',
  'signal_pending',
  'market_order_already_open',
]);

const STRATEGY_FILTER_SKIP_REASONS = new Set([
  'source_price_out_of_range',
  'source_trade_usd_too_small',
  'non_crypto_market',
  'stale_trade',
  'stale',
  'too_small',
  'market_outcome_map_missing',
  'signal_pending',
  'market_order_already_open',
]);

const SOFT_LOCK_REASONS = new Set([
  'no_liquidity',
  'no_liquidity_both_sides',
  'orderbook_not_found',
  'execution_side_switch',
  'order_param_build_failed',
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
      incrementRetry: false,
    };
  }

  if (SOFT_LOCK_REASONS.has(skipReason)) {
    return {
      applyLock: true,
      lockType: 'short',
      lockMs: Math.min(Math.max(0, marketShortLockMs), 500),
      incrementRetry: false,
      softened: true,
    };
  }

  return {
    applyLock: true,
    lockType: 'short',
    lockMs: marketShortLockMs,
    incrementRetry: true,
  };
}

export function isStrategyFilterSkipReason(skipReason: string): boolean {
  return STRATEGY_FILTER_SKIP_REASONS.has(skipReason);
}
