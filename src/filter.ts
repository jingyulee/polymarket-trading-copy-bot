import { config } from './config.js';

export interface FilterTrade {
  timestamp?: number;
  market?: string;
  marketSlug?: string;
  question?: string;
  title?: string;
  category?: string;
  tags?: string[] | string;
  tokenId?: string;
  conditionId?: string;
  sourceTrader?: string;
  side?: 'BUY' | 'SELL' | string;
  price?: number;
  size?: number;
  outcome?: string;
  outcomeName?: string;
}

export interface FilterResult {
  pass: boolean;
  reason: string;
  details?: {
    bestBid?: number;
    bestAsk?: number;
    spread?: number;
    bidsDepth?: number;
    asksDepth?: number;
  };
}

export interface FilterContext {
  now?: number;
  bestBid?: number | null;
  bestAsk?: number | null;
  bestAskLiquidityUsd?: number | null;
  spread?: number | null;
  bidsDepth?: number | null;
  asksDepth?: number | null;
  marketLocks?: Set<string>;
}

const HIGH_LIQUIDITY_KEYWORDS = ['btc', 'bitcoin', 'eth', 'ethereum', 'sol', 'solana'];

function textContainsCrypto(value: string): boolean {
  const normalized = value.toLowerCase();
  return config.trading.cryptoKeywords.some((keyword) => normalized.includes(keyword));
}

function textContainsHighLiquiditySymbol(value: string): boolean {
  const normalized = value.toLowerCase();
  return HIGH_LIQUIDITY_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function findMatchingKeyword(value: string | undefined, keywords: string[]): string | null {
  const normalized = String(value || '').toLowerCase();
  if (!normalized) return null;
  return keywords.find((keyword) => normalized.includes(keyword.toLowerCase())) || null;
}

function getCryptoMarketMatch(trade: FilterTrade): {
  matchedKeyword: string | null;
  matchedField: 'slug' | 'title' | 'category' | 'tags' | null;
} {
  const keywords = config.trading.cryptoKeywords.map((keyword) => keyword.toLowerCase());

  const slugMatch = findMatchingKeyword(trade.marketSlug, keywords);
  if (slugMatch) {
    return { matchedKeyword: slugMatch, matchedField: 'slug' };
  }

  const titleCandidates = [trade.title, trade.market, trade.question];
  for (const candidate of titleCandidates) {
    const titleMatch = findMatchingKeyword(candidate, keywords);
    if (titleMatch) {
      return { matchedKeyword: titleMatch, matchedField: 'title' };
    }
  }

  const categoryMatch = findMatchingKeyword(trade.category, keywords);
  if (categoryMatch) {
    return { matchedKeyword: categoryMatch, matchedField: 'category' };
  }

  const tags = Array.isArray(trade.tags) ? trade.tags : typeof trade.tags === 'string' ? trade.tags.split(',') : [];
  for (const tag of tags) {
    const tagMatch = findMatchingKeyword(tag, keywords);
    if (tagMatch) {
      return { matchedKeyword: tagMatch, matchedField: 'tags' };
    }
  }

  return { matchedKeyword: null, matchedField: null };
}

export function getMarketLockKey(trade: FilterTrade): string {
  const outcome = String(trade.outcomeName || trade.outcome || '').trim().toUpperCase();
  return (
    [trade.conditionId, outcome].filter(Boolean).join('|') ||
    trade.marketSlug ||
    trade.market ||
    trade.tokenId ||
    'unknown-market'
  );
}

export function applyFilters(trade: FilterTrade, context: FilterContext = {}): FilterResult {
  const now = context.now ?? Date.now();
  const sourcePrice = Number(trade.price);
  const sourceSizeUsd = Number(trade.size);
  const sourceAgeMs = Math.max(0, now - Number(trade.timestamp || now));
  const bestBid = Number(context.bestBid);
  const bestAsk = Number(context.bestAsk);
  const spread = Number(context.spread);
  const bidsDepth = Number(context.bidsDepth);
  const asksDepth = Number(context.asksDepth);
  const details = {
    bestBid: Number.isFinite(bestBid) ? bestBid : undefined,
    bestAsk: Number.isFinite(bestAsk) ? bestAsk : undefined,
    spread: Number.isFinite(spread) ? spread : undefined,
    bidsDepth: Number.isFinite(bidsDepth) ? bidsDepth : undefined,
    asksDepth: Number.isFinite(asksDepth) ? asksDepth : undefined,
  };

  const lightweightResult = applyLightweightFilters(trade, context);
  if (!lightweightResult.pass) {
    return lightweightResult;
  }

  const marketLockKey = getMarketLockKey(trade);
  if (config.trading.oneTradePerMarket && context.marketLocks?.has(marketLockKey)) {
    return { pass: false, reason: 'market_locked' };
  }

  if (Number.isFinite(context.bestAsk)) {
    const bestAsk = Number(context.bestAsk);
    const bestAskLiquidityUsd = Number(context.bestAskLiquidityUsd);
    if (Number.isFinite(bestAskLiquidityUsd) && bestAskLiquidityUsd < config.trading.minLiquidity) {
      return { pass: false, reason: 'orderbook_liquidity_too_low' };
    }

    const deviation = bestAsk - sourcePrice;
    if (deviation > config.trading.maxPriceDeviation) {
      return { pass: false, reason: 'price_deviation_too_high' };
    }

    if (bestAsk > sourcePrice) {
      const gapBps = ((bestAsk - sourcePrice) / sourcePrice) * 10000;
      if (gapBps > config.trading.maxEntryPriceGapBps) {
        return { pass: false, reason: 'slippage_gap_too_high' };
      }
    }
  }

  if (trade.side === 'BUY') {
    if (Number.isFinite(asksDepth) && asksDepth === 0 && !config.trading.enableMakerFallback) {
      return { pass: false, reason: 'no_asks_in_orderbook', details };
    }

    if (Number.isFinite(asksDepth) && asksDepth > 0 && asksDepth < config.trading.minAsksDepth) {
      return { pass: false, reason: 'asks_depth_too_low', details };
    }

    if (Number.isFinite(spread) && Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0 && bestAsk > 0) {
      if (spread > config.trading.maxSpreadForEntry) {
        return { pass: false, reason: 'spread_too_wide', details };
      }
    }
  }

  return { pass: true, reason: 'pass' };
}

export function applyLightweightFilters(trade: FilterTrade, context: FilterContext = {}): FilterResult {
  const now = context.now ?? Date.now();
  const sourcePrice = Number(trade.price);
  const sourceSizeUsd = Number(trade.size);
  const sourceAgeMs = Math.max(0, now - Number(trade.timestamp || now));
  const bestBid = Number(context.bestBid);
  const bestAsk = Number(context.bestAsk);
  const spread = Number(context.spread);
  const bidsDepth = Number(context.bidsDepth);
  const asksDepth = Number(context.asksDepth);
  const details = {
    bestBid: Number.isFinite(bestBid) ? bestBid : undefined,
    bestAsk: Number.isFinite(bestAsk) ? bestAsk : undefined,
    spread: Number.isFinite(spread) ? spread : undefined,
    bidsDepth: Number.isFinite(bidsDepth) ? bidsDepth : undefined,
    asksDepth: Number.isFinite(asksDepth) ? asksDepth : undefined,
  };

  if (config.trading.copyOnlyBuy && trade.side !== 'BUY') {
    return { pass: false, reason: 'skip_sell_trade' };
  }

  if (!Number.isFinite(sourcePrice) || sourcePrice < config.trading.minSourcePrice || sourcePrice > config.trading.maxSourcePrice) {
    return { pass: false, reason: 'source_price_out_of_range' };
  }

  if (!Number.isFinite(sourceSizeUsd) || sourceSizeUsd < config.trading.minSourceTradeUsd) {
    return { pass: false, reason: 'source_trade_usd_too_small' };
  }

  if (sourceAgeMs > config.trading.maxSourceTradeAgeMs) {
    return { pass: false, reason: 'stale_trade' };
  }

  if (config.trading.marketScope === 'crypto-only') {
    const marketTexts = [
      trade.market,
      trade.marketSlug,
      trade.title,
      trade.question,
      trade.outcome,
      trade.outcomeName,
    ].filter(Boolean) as string[];

    if (marketTexts.length === 0) {
      return { pass: false, reason: 'market_metadata_missing' };
    }

    const cryptoMatch = getCryptoMarketMatch(trade);
    const isCryptoMarket = Boolean(cryptoMatch.matchedKeyword) || marketTexts.some(textContainsCrypto);
    console.log('[Market Scope]', {
      marketTitle: trade.title || trade.market || trade.question || null,
      marketSlug: trade.marketSlug || null,
      matchedKeyword: cryptoMatch.matchedKeyword,
      matchedField: cryptoMatch.matchedField,
      result: isCryptoMarket ? 'crypto' : 'non_crypto',
    });
    if (!isCryptoMarket) {
      return { pass: false, reason: 'non_crypto_market' };
    }

    if (config.trading.onlyHighLiquiditySymbols) {
      const isHighLiquiditySymbol = marketTexts.some(textContainsHighLiquiditySymbol);
      if (!isHighLiquiditySymbol) {
        return { pass: false, reason: 'not_high_liquidity_symbol', details };
      }
    }
  }

  return { pass: true, reason: 'pass' };
}
