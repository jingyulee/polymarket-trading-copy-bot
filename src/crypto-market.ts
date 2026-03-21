export interface CryptoMarketClassification {
  isCrypto: boolean;
  matchedSymbol: string | null;
  matchedKeyword: string | null;
  matchedField: 'title' | 'slug' | null;
  reason: string | null;
}

const SYMBOL_ALIASES: Array<{ symbol: string; aliases: string[] }> = [
  { symbol: 'bitcoin', aliases: ['btc', 'bitcoin'] },
  { symbol: 'ethereum', aliases: ['eth', 'ethereum'] },
  { symbol: 'solana', aliases: ['sol', 'solana'] },
  { symbol: 'xrp', aliases: ['xrp'] },
  { symbol: 'bnb', aliases: ['bnb'] },
  { symbol: 'hyperliquid', aliases: ['hype', 'hyperliquid'] },
  { symbol: 'dogecoin', aliases: ['doge', 'dogecoin'] },
];

function findMatch(value: string, aliases: string[]): string | null {
  const normalized = value.toLowerCase();
  for (const alias of aliases) {
    if (normalized.includes(alias)) {
      return alias;
    }
  }
  return null;
}

export function classifyCryptoMarket(params: {
  marketTitle?: string | null;
  marketSlug?: string | null;
  cryptoKeywords: string[];
}): CryptoMarketClassification {
  const marketTitle = String(params.marketTitle || '').toLowerCase();
  const marketSlug = String(params.marketSlug || '').toLowerCase();
  const keywordSet = new Set(
    params.cryptoKeywords
      .map((keyword) => String(keyword || '').trim().toLowerCase())
      .filter(Boolean)
  );

  if (!marketTitle && !marketSlug) {
    return {
      isCrypto: false,
      matchedSymbol: null,
      matchedKeyword: null,
      matchedField: null,
      reason: 'market_metadata_missing',
    };
  }

  for (const entry of SYMBOL_ALIASES) {
    const activeAliases = entry.aliases.filter((alias) => keywordSet.has(alias));
    if (activeAliases.length === 0) continue;

    const slugMatch = marketSlug ? findMatch(marketSlug, activeAliases) : null;
    if (slugMatch) {
      return {
        isCrypto: true,
        matchedSymbol: entry.symbol,
        matchedKeyword: slugMatch,
        matchedField: 'slug',
        reason: 'matched_symbol_alias',
      };
    }

    const titleMatch = marketTitle ? findMatch(marketTitle, activeAliases) : null;
    if (titleMatch) {
      return {
        isCrypto: true,
        matchedSymbol: entry.symbol,
        matchedKeyword: titleMatch,
        matchedField: 'title',
        reason: 'matched_symbol_alias',
      };
    }
  }

  const freeformKeywords = Array.from(keywordSet);
  const slugKeywordMatch = marketSlug ? findMatch(marketSlug, freeformKeywords) : null;
  if (slugKeywordMatch) {
    return {
      isCrypto: true,
      matchedSymbol: null,
      matchedKeyword: slugKeywordMatch,
      matchedField: 'slug',
      reason: 'matched_keyword',
    };
  }

  const titleKeywordMatch = marketTitle ? findMatch(marketTitle, freeformKeywords) : null;
  if (titleKeywordMatch) {
    return {
      isCrypto: true,
      matchedSymbol: null,
      matchedKeyword: titleKeywordMatch,
      matchedField: 'title',
      reason: 'matched_keyword',
    };
  }

  return {
    isCrypto: false,
    matchedSymbol: null,
    matchedKeyword: null,
    matchedField: null,
    reason: 'no_keyword_match',
  };
}
