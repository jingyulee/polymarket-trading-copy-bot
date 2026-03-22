export interface SignalTradeLike {
  conditionId?: string;
  marketSlug?: string;
  market?: string;
  tokenId?: string;
  side?: string;
  price?: number;
  size?: number;
  timestamp?: number;
  title?: string;
  outcome?: string;
}

export interface SignalEntry {
  key: string;
  firstTs: number;
  lastTs: number;
  tradeCount: number;
  cumulativeSourceUsd: number;
  maxSingleTradeUsd: number;
  firstSourcePrice: number;
  latestSourcePrice: number;
  minSourcePrice: number;
  maxSourcePrice: number;
  latestMarketTitle: string;
  latestMarketSlug: string;
  latestTokenId: string;
  latestOutcome: string;
  side: string;
  consumedAt?: number;
}

const MAX_SIGNAL_CACHE_SIZE = 200;
const signalCache = new Map<string, SignalEntry>();

function normalizeNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getSignalKey(trade: SignalTradeLike): string {
  const marketKey =
    trade.conditionId ||
    trade.marketSlug ||
    trade.market ||
    trade.tokenId ||
    'unknown-market';
  const outcome = String(trade.outcome || 'UNKNOWN').trim().toUpperCase();
  const side = String(trade.side || 'UNKNOWN').trim().toUpperCase();
  return `${marketKey}|${outcome}|${side}`;
}

export function captureSignal(trade: SignalTradeLike, now: number, windowMs: number): SignalEntry {
  pruneExpiredSignals(now, windowMs);

  const key = getSignalKey(trade);
  const price = normalizeNumber(trade.price) ?? 0;
  const size = Math.max(0, normalizeNumber(trade.size) ?? 0);
  const tradeTs = normalizeNumber(trade.timestamp) ?? now;
  const side = String(trade.side || 'UNKNOWN').trim().toUpperCase();
  const marketTitle = String(trade.title || trade.market || '').trim();
  const marketSlug = String(trade.marketSlug || '').trim();
  const tokenId = String(trade.tokenId || '').trim();
  const outcome = String(trade.outcome || '').trim();
  const existing = signalCache.get(key);

  const shouldReset = !existing ||
    existing.consumedAt != null ||
    (now - existing.firstTs) > windowMs ||
    tradeTs < existing.firstTs;

  const nextEntry: SignalEntry = shouldReset
    ? {
      key,
      firstTs: now,
      lastTs: now,
      tradeCount: 1,
      cumulativeSourceUsd: size,
      maxSingleTradeUsd: size,
      firstSourcePrice: price,
      latestSourcePrice: price,
      minSourcePrice: price,
      maxSourcePrice: price,
      latestMarketTitle: marketTitle,
      latestMarketSlug: marketSlug,
      latestTokenId: tokenId,
      latestOutcome: outcome,
      side,
    }
    : {
      ...existing,
      lastTs: now,
      tradeCount: existing.tradeCount + 1,
      cumulativeSourceUsd: existing.cumulativeSourceUsd + size,
      maxSingleTradeUsd: Math.max(existing.maxSingleTradeUsd, size),
      latestSourcePrice: price,
      minSourcePrice: Math.min(existing.minSourcePrice, price),
      maxSourcePrice: Math.max(existing.maxSourcePrice, price),
      latestMarketTitle: marketTitle || existing.latestMarketTitle,
      latestMarketSlug: marketSlug || existing.latestMarketSlug,
      latestTokenId: tokenId || existing.latestTokenId,
      latestOutcome: outcome || existing.latestOutcome,
      side,
      consumedAt: undefined,
    };

  signalCache.set(key, nextEntry);

  while (signalCache.size > MAX_SIGNAL_CACHE_SIZE) {
    const oldestKey = signalCache.keys().next().value;
    if (!oldestKey) break;
    signalCache.delete(oldestKey);
  }

  return nextEntry;
}

export function getSignal(key: string, now: number, windowMs: number): SignalEntry | null {
  const signal = signalCache.get(key);
  if (!signal) return null;
  if (signal.consumedAt != null || (now - signal.firstTs) > windowMs) {
    signalCache.delete(key);
    return null;
  }
  return signal;
}

export function consumeSignal(key: string, now: number): void {
  const signal = signalCache.get(key);
  if (!signal) return;
  signalCache.set(key, {
    ...signal,
    consumedAt: now,
  });
}

export function deleteSignal(key: string): void {
  signalCache.delete(key);
}

export function pruneExpiredSignals(now: number, windowMs: number): void {
  for (const [key, signal] of signalCache.entries()) {
    if (signal.consumedAt != null || (now - signal.firstTs) > windowMs) {
      signalCache.delete(key);
    }
  }
}
