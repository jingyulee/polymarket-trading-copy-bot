import { config } from './config.js';

export interface FilterTrade {
  timestamp?: number;
  market?: string;
  marketSlug?: string;
  question?: string;
  title?: string;
  tokenId?: string;
  conditionId?: string;
  side?: 'BUY' | 'SELL' | string;
  price?: number;
  size?: number;
  outcome?: string;
  outcomeName?: string;
}

export interface FilterResult {
  pass: boolean;
  reason: string;
}

export interface FilterContext {
  now?: number;
  bestAsk?: number | null;
  bestAskLiquidityUsd?: number | null;
  marketLocks?: Set<string>;
}

const CRYPTO_KEYWORDS = [
  'btc',
  'bitcoin',
  'eth',
  'ethereum',
  'sol',
  'solana',
  'xrp',
  'doge',
  'crypto',
];

function textContainsCrypto(value: string): boolean {
  const normalized = value.toLowerCase();
  return CRYPTO_KEYWORDS.some((keyword) => normalized.includes(keyword));
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
      trade.question,
      trade.title,
      trade.outcome,
      trade.outcomeName,
    ].filter(Boolean) as string[];

    if (marketTexts.length === 0) {
      return { pass: false, reason: 'market_metadata_missing' };
    }

    const isCryptoMarket = marketTexts.some(textContainsCrypto);
    if (!isCryptoMarket) {
      return { pass: false, reason: 'non_crypto_market' };
    }
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

  return { pass: true, reason: 'pass' };
}
