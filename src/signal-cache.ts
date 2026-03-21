export interface SignalEntry {
  price: number;
  ts: number;
  sourceSize: number;
}

export interface SignalLookupResult {
  signal: SignalEntry | null;
  expired: boolean;
}

type SignalTradeLike = {
  conditionId?: string;
  marketSlug?: string;
  market?: string;
  tokenId?: string;
  side?: string;
};

export const SIGNAL_TTL_MS = 5_000;
const MAX_SIGNAL_CACHE_SIZE = 100;
const signalCache = new Map<string, SignalEntry>();

export function getSignalKey(trade: SignalTradeLike): string {
  const marketKey =
    trade.conditionId ||
    trade.marketSlug ||
    trade.market ||
    trade.tokenId ||
    'unknown-market';
  const side = String(trade.side || 'UNKNOWN').trim().toUpperCase();
  return `${marketKey}|${side}`;
}

export function captureSignal(key: string, entry: SignalEntry, now: number): void {
  pruneExpiredSignals(now);
  signalCache.set(key, entry);

  while (signalCache.size > MAX_SIGNAL_CACHE_SIZE) {
    const oldestKey = signalCache.keys().next().value;
    if (!oldestKey) break;
    signalCache.delete(oldestKey);
  }
}

export function getSignal(key: string, now: number): SignalLookupResult {
  const signal = signalCache.get(key);
  if (!signal) return { signal: null, expired: false };
  if (now - signal.ts > SIGNAL_TTL_MS) {
    signalCache.delete(key);
    return { signal: null, expired: true };
  }
  return { signal, expired: false };
}

export function deleteSignal(key: string): void {
  signalCache.delete(key);
}

export function pruneExpiredSignals(now: number): void {
  for (const [key, signal] of signalCache.entries()) {
    if (now - signal.ts > SIGNAL_TTL_MS) {
      signalCache.delete(key);
    }
  }
}
