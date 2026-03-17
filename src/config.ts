import * as dotenv from 'dotenv';
dotenv.config();

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

function parseSigType(): 0 | 1 | 2 {
  const v = process.env.SIG_TYPE ?? '0';
  const n = parseInt(v, 10);
  if (n === 0 || n === 1 || n === 2) return n;
  return 0;
}

export const config = {
  targetWallet: process.env.TARGET_WALLET || '',
  privateKey: process.env.WALLET_PRIVATE_KEY || '',
  polymarketGeoToken: process.env.POLYMARKET_GEO_TOKEN || '',
  rpcUrl: process.env.RPC_URL || 'https://polygon-rpc.com',
  chainId: 137,

  /** Polymarket auth: sigType 0=EOA, 1=Poly Proxy, 2=Poly Polymorphic; PROXY_WALLET_ADDRESS required for 1/2. */
  auth: {
    sigType: parseSigType(),
    funderAddress: process.env.PROXY_WALLET_ADDRESS || '',
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
    minSourcePrice: parseNumber(process.env.MIN_SOURCE_PRICE, 0.97),
    maxSourcePrice: parseNumber(process.env.MAX_SOURCE_PRICE, 0.999),
    maxSourceTradeAgeMs: parseNumber(process.env.MAX_SOURCE_TRADE_AGE_MS, 30000),
    minSourceTradeUsd: parseNumber(process.env.MIN_SOURCE_TRADE_USD, 2),
    maxUsdPerOrder: parseNumber(process.env.MAX_USD_PER_ORDER, 5),
    marketScope: process.env.MARKET_SCOPE || 'crypto-only',
    oneTradePerMarket: parseBoolean(process.env.ONE_TRADE_PER_MARKET, true),
    maxPriceDeviation: parseNumber(process.env.MAX_PRICE_DEVIATION, 0.01),
    minLiquidity: parseNumber(process.env.MIN_LIQUIDITY, 5),
    maxEntryPriceGapBps: parseNumber(process.env.MAX_ENTRY_PRICE_GAP_BPS, 10),
  },

  risk: {
    maxSessionNotional: parseFloat(process.env.MAX_SESSION_NOTIONAL || '0'),
    maxPerMarketNotional: parseFloat(process.env.MAX_PER_MARKET_NOTIONAL || '0'),
  },

  monitoring: {
    pollInterval: parseInt(process.env.POLL_INTERVAL || '2000'),
    useWebSocket,
    useUserChannel: process.env.USE_USER_CHANNEL === 'true',
    wsAssetIds: parseCsv(process.env.WS_ASSET_IDS),
    wsMarketIds: parseCsv(process.env.WS_MARKET_IDS),
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

  console.log('ℹ️  API credentials will be derived/generated from WALLET_PRIVATE_KEY at startup');

  const { sigType, funderAddress } = config.auth;
  if ((sigType === 1 || sigType === 2) && !funderAddress) {
    console.warn('⚠️  SIG_TYPE 1 or 2 usually requires PROXY_WALLET_ADDRESS (proxy/safe address). Set PROXY_WALLET_ADDRESS in .env if needed.');
  }

  console.log('✅ Configuration validated');
  const authLabel = sigType === 0 ? 'EOA' : sigType === 1 ? 'Poly Proxy' : 'Poly Polymorphic';
  console.log(`   Auth: ${authLabel} (signature type ${sigType})`);
}
