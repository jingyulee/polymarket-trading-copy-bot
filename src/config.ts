import * as dotenv from 'dotenv';

export const envPath = process.env.ENV_PATH || '.env';
dotenv.config({ path: envPath });
console.log(`ENV_PATH: ${envPath}`);

function parseCsv(value?: string): string[] {
  if (!value) return [];
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

const useWebSocket = process.env.USE_WEBSOCKET !== 'false';

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseImmediateOrderType(value: string | undefined, fallback: 'FOK' | 'FAK'): 'FOK' | 'FAK' {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === 'FOK' || normalized === 'FAK' ? normalized : fallback;
}

function parseSigType(): 0 | 1 | 2 {
  const v = process.env.SIG_TYPE ?? '0';
  const n = parseInt(v, 10);
  if (n === 0 || n === 1 || n === 2) return n;
  return 0;
}

export const config = {
  targetWallet: process.env.TARGET_WALLET || '',
  privateKey: process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || '',
  polymarketGeoToken: process.env.POLYMARKET_GEO_TOKEN || '',
  clobApiKey: process.env.CLOB_API_KEY || '',
  clobApiSecret: process.env.CLOB_API_SECRET || process.env.CLOB_SECRET || '',
  clobApiPassphrase: process.env.CLOB_API_PASSPHRASE || '',
  rpcUrl: process.env.RPC_URL || 'https://polygon-rpc.com',
  chainId: parseNumber(process.env.CHAIN_ID, 137),

  /** Polymarket auth: sigType 0=EOA, 1=Poly Proxy, 2=Poly Polymorphic; PROXY_WALLET_ADDRESS required for 1/2. */
  auth: {
    sigType: parseSigType(),
    funderAddress: process.env.PROXY_WALLET_ADDRESS || process.env.POLYMARKET_PROXY_ADDRESS || '',
  },

  // Polygon mainnet contracts used for approvals and balance checks.
  contracts: {
    exchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    ctf: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
    negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  },

  trading: {
    positionSizeMultiplier: parseFloat(process.env.POSITION_MULTIPLIER || '0.1'),
    maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE || '100'),
    minTradeSize: parseFloat(process.env.MIN_TRADE_SIZE || '1'),
    slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE || '0.02'),
    // LIMIT=GTC, FOK=fill-or-kill, FAK=fill-and-kill
    orderType: (process.env.ORDER_TYPE || 'FOK') as 'LIMIT' | 'FOK' | 'FAK',
    dryRun: parseBoolean(process.env.DRY_RUN, true),
    copyOnlyBuy: parseBoolean(process.env.COPY_ONLY_BUY, true),
    enableSignalTrigger: parseBoolean(process.env.ENABLE_SIGNAL_TRIGGER, true),
    signalWindowMs: parseNumber(process.env.SIGNAL_WINDOW_MS, 8000),
    signalMinTradeCount: parseNumber(process.env.SIGNAL_MIN_TRADE_COUNT, 2),
    signalMinCumulativeUsd: parseNumber(process.env.SIGNAL_MIN_CUMULATIVE_USD, 20),
    singleSignalTriggerUsd: parseNumber(process.env.SINGLE_SIGNAL_TRIGGER_USD, 20),
    signalRequireBuyOnly: parseBoolean(process.env.SIGNAL_REQUIRE_BUY_ONLY, true),
    mvpMaxPriceDriftBps: parseNumber(process.env.MVP_MAX_PRICE_DRIFT_BPS, 20),
    minSourcePrice: parseNumber(process.env.MIN_SOURCE_PRICE, 0.97),
    maxSourcePrice: parseNumber(process.env.MAX_SOURCE_PRICE, 0.999),
    maxSourceTradeAgeMs: parseNumber(process.env.MAX_SOURCE_TRADE_AGE_MS, 12000),
    minSourceTradeUsd: parseNumber(process.env.MIN_SOURCE_TRADE_USD, 2),
    maxUsdPerOrder: parseNumber(process.env.MAX_USD_PER_ORDER, 3),
    marketScope: process.env.MARKET_SCOPE || 'crypto-only',
    cryptoKeywords: parseCsv(process.env.CRYPTO_KEYWORDS || 'btc,bitcoin,eth,ethereum,sol,solana,xrp,doge,dogecoin,bnb,hyperliquid,hype,avax,pepe,sui,arb'),
    oneTradePerMarket: parseBoolean(process.env.ONE_TRADE_PER_MARKET, true),
    maxPriceDeviation: parseNumber(process.env.MAX_PRICE_DEVIATION, 0.01),
    minLiquidity: parseNumber(process.env.MIN_LIQUIDITY, 5),
    maxEntryPriceGapBps: parseNumber(process.env.MAX_ENTRY_PRICE_GAP_BPS, 10),
    enableMakerFallback: parseBoolean(process.env.ENABLE_MAKER_FALLBACK, false),
    makerFallbackPriceOffsetBps: parseNumber(process.env.MAKER_FALLBACK_PRICE_OFFSET_BPS, 10),
    makerFallbackTtlMs: parseNumber(process.env.MAKER_FALLBACK_TTL_MS, 15000),
    minBestBidForMakerFallback: parseNumber(process.env.MIN_BEST_BID_FOR_MAKER_FALLBACK, 0.10),
    maxSpreadForEntry: parseNumber(process.env.MAX_SPREAD_FOR_ENTRY, 0.05),
    minAsksDepth: parseNumber(process.env.MIN_ASKS_DEPTH, 1),
    onlyHighLiquiditySymbols: parseBoolean(process.env.ONLY_HIGH_LIQUIDITY_SYMBOLS, true),
    enableNoAsksFallback: parseBoolean(process.env.ENABLE_NO_ASKS_FALLBACK, true),
    noAsksFallbackOrderType: parseImmediateOrderType(process.env.NO_ASKS_FALLBACK_ORDER_TYPE, 'FAK'),
    maxFallbackPriceGapBps: parseNumber(process.env.MAX_FALLBACK_PRICE_GAP_BPS, 300),
    minReplicableBestBid: parseNumber(process.env.MIN_REPLICABLE_BEST_BID, 0.80),
    maxSignalEntryBidGap: parseNumber(process.env.MAX_SIGNAL_ENTRY_BID_GAP, 0.05),
    maxSignalMakerUsd: parseNumber(process.env.MAX_SIGNAL_MAKER_USD, 1),
    signalMakerTtlMs: parseNumber(process.env.SIGNAL_MAKER_TTL_MS, 5000),
    signalMakerPriceOffset: parseNumber(process.env.SIGNAL_MAKER_PRICE_OFFSET, 0.01),
    enableSignalMakerEntry: parseBoolean(process.env.ENABLE_SIGNAL_MAKER_ENTRY, true),
    marketShortLockMs: parseNumber(process.env.MARKET_SHORT_LOCK_MS, 5000),
    marketMaxRetryPerWindow: parseNumber(process.env.MARKET_MAX_RETRY_PER_WINDOW, 2),
    marketRetryWindowMs: parseNumber(process.env.MARKET_RETRY_WINDOW_MS, 15000),
  },

  risk: {
    maxSessionNotional: parseFloat(process.env.MAX_SESSION_NOTIONAL || '0'),
    maxPerMarketNotional: parseFloat(process.env.MAX_PER_MARKET_NOTIONAL || '0'),
  },

  monitoring: {
    pollInterval: parseInt(process.env.POLL_INTERVAL || '2000'),
    useWebSocket,
    useUserChannel: process.env.USE_USER_CHANNEL === 'true',
    sourceTraderWhitelist: parseCsv(process.env.SOURCE_TRADER_WHITELIST).map((v) => v.toLowerCase()),
    wsAssetIds: parseCsv(process.env.WS_ASSET_IDS),
    wsMarketIds: parseCsv(process.env.WS_MARKET_IDS),
    enableOrderbookPrewarm: parseBoolean(process.env.ENABLE_ORDERBOOK_PREWARM, true),
    prewarmSymbols: (process.env.PREWARM_SYMBOLS || 'btc,bitcoin,eth,ethereum,sol,solana')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    prewarmMatchMode: (process.env.PREWARM_MATCH_MODE || 'strict').trim().toLowerCase(),
    orderbookCacheTtlMs: parseNumber(process.env.ORDERBOOK_CACHE_TTL_MS, 5000),
    redeemCheckIntervalMs: Number(process.env.REDEEM_CHECK_INTERVAL_MS || 60000),
    settlementCheckIntervalMs: Number(process.env.SETTLEMENT_CHECK_INTERVAL_MS || 60000),
  },

  notifications: {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    telegramRedeemChatId: process.env.TELEGRAM_REDEEM_CHAT_ID || '',
  }
};

export function validateConfig(): void {
  const required = ['targetWallet', 'privateKey'];
  for (const key of required) {
    if (!config[key as keyof typeof config]) {
      throw new Error(`Missing required config: ${key}`);
    }
  }

  const hasAnyClobCredential = Boolean(config.clobApiKey || config.clobApiSecret || config.clobApiPassphrase);
  const hasAllClobCredentials = Boolean(config.clobApiKey && config.clobApiSecret && config.clobApiPassphrase);
  if (hasAnyClobCredential && !hasAllClobCredentials) {
    throw new Error('CLOB_API_KEY, CLOB_API_SECRET, and CLOB_API_PASSPHRASE must all be set together');
  }

  console.log(
    hasAllClobCredentials
      ? 'ℹ️  Using static CLOB API credentials from env'
      : 'ℹ️  CLOB API credentials not provided; will derive/create from WALLET_PRIVATE_KEY at startup'
  );

  const { sigType, funderAddress } = config.auth;
  if ((sigType === 1 || sigType === 2) && !funderAddress) {
    console.warn('⚠️  SIG_TYPE 1 or 2 usually requires PROXY_WALLET_ADDRESS (proxy/safe address). Set PROXY_WALLET_ADDRESS in .env if needed.');
  }

  console.log('✅ Configuration validated');
  const authLabel = sigType === 0 ? 'EOA' : sigType === 1 ? 'Poly Proxy' : 'Poly Polymorphic';
  console.log(`   Auth: ${authLabel} (signature type ${sigType})`);
  console.log(
    `   Orderbook prewarm: ${config.monitoring.enableOrderbookPrewarm ? 'enabled' : 'disabled'} ` +
    `(ttl=${config.monitoring.orderbookCacheTtlMs}ms, symbols=${config.monitoring.prewarmSymbols.join(',') || 'none'}, matchMode=${config.monitoring.prewarmMatchMode})`
  );
  console.log(
    `   Signal trigger: ${config.trading.enableSignalTrigger ? 'enabled' : 'disabled'} ` +
    `(signalWindowMs=${config.trading.signalWindowMs}, signalMinTradeCount=${config.trading.signalMinTradeCount}, ` +
    `signalMinCumulativeUsd=${config.trading.signalMinCumulativeUsd}, singleSignalTriggerUsd=${config.trading.singleSignalTriggerUsd}, ` +
    `requireBuyOnly=${config.trading.signalRequireBuyOnly})`
  );
  console.log(`   MVP max price drift: ${config.trading.mvpMaxPriceDriftBps}bps`);
  console.log(
    `   No-asks fallback: ${config.trading.enableNoAsksFallback ? 'enabled' : 'disabled'} ` +
    `(orderType=${config.trading.noAsksFallbackOrderType}, maxGap=${config.trading.maxFallbackPriceGapBps}bps)`
  );
  console.log(
    `   Signal maker entry: ${config.trading.enableSignalMakerEntry ? 'enabled' : 'disabled'} ` +
    `(minReplicableBestBid=${config.trading.minReplicableBestBid}, maxSignalEntryBidGap=${config.trading.maxSignalEntryBidGap}, ` +
    `maxSignalMakerUsd=${config.trading.maxSignalMakerUsd}, signalMakerTtlMs=${config.trading.signalMakerTtlMs}, ` +
    `signalMakerPriceOffset=${config.trading.signalMakerPriceOffset})`
  );
  console.log(
    `   Market lock: shortLockMs=${config.trading.marketShortLockMs}, maxRetryPerWindow=${config.trading.marketMaxRetryPerWindow}, ` +
    `retryWindowMs=${config.trading.marketRetryWindowMs}`
  );
  console.log(`   Max source trade age: ${config.trading.maxSourceTradeAgeMs}ms`);
}
