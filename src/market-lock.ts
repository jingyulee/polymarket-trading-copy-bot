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
