import { ethers } from 'ethers';
import axios from 'axios';
import { ClobClient, Side, OrderType, AssetType } from '@polymarket/clob-client';
import { config } from './config.js';
import type { Trade } from './monitor.js';
import { findOutcomeMapCache, logTrade, upsertOutcomeMapCache } from './db.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const GAMMA_MARKETS_URL = 'https://gamma-api.polymarket.com/markets';

interface MarketMetadata {
  tickSize: number;
  tickSizeStr: string;
  negRisk: boolean;
  feeRateBps: number;
  conditionId?: string;
  outcomeLabel?: string;
  timestamp: number;
}

interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

interface OrderbookCacheEntry {
  bids: any[];
  asks: any[];
  ts: number;
}

interface PrewarmTarget {
  tokenId: string;
  market: string;
  symbol: string;
}

interface PrewarmSymbolMatch {
  symbol: string;
  matchedField: 'slug_token' | 'title_word';
}

interface PrewarmMarketEvaluation {
  symbolMatches: PrewarmSymbolMatch[];
  isUpDown: boolean;
  upDownField?: 'title_phrase' | 'slug_token' | 'slug_text';
}

interface PrewarmResolutionResult {
  targets: PrewarmTarget[];
  foundSymbols: string[];
  missingSymbols: string[];
  loadedMarketsCount: number;
  matchedMarketsCount: number;
  resolvedTokenIdsCount: number;
}

interface ActiveMarketsCacheEntry {
  markets: any[];
  timestamp: number;
}

interface NoAsksFallbackPlan {
  fallbackUsed: boolean;
  fallbackPrice: number;
  finalOrderType: 'FOK' | 'FAK';
  bestBid: number;
  bestAsk: number | null;
}

interface UnreplicableNoAskMarketResult {
  unreplicable: boolean;
  bestBid: number | null;
  asksDepth: number;
}

interface OutcomeTokenMap {
  conditionId?: string | null;
  marketSlug?: string | null;
  UP?: string;
  DOWN?: string;
  complete?: boolean;
  updatedAt?: number;
}

export interface ExecutionValidationResult {
  trade: Trade;
  orderbook: any | null;
  bestBid: number | null;
  bestAsk: number | null;
  chosenTokenId: string;
  outcomeSide: 'UP' | 'DOWN';
  slippage: number | null;
  asksDepth: number;
  rejected: boolean;
  reason?: string;
  path?: 'direct_source_token';
}

interface OrderbookLookupResult {
  tokenId: string;
  orderbook: any | null;
  status: 'ok' | 'not_found' | 'error';
  bestBid: number | null;
  bestAsk: number | null;
  bidsDepth: number;
  asksDepth: number;
}

interface SourceSideResolution {
  sourceOutcomeSide: 'UP' | 'DOWN';
  expectedTokenId: string;
  upTokenId: string;
  downTokenId: string;
}

export interface CopyExecutionResult {
  orderId: string;
  copyNotional: number;
  copyShares: number;
  price: number;
  side: 'BUY' | 'SELL';
  tokenId: string;
}

export interface SignalMakerExecutionResult extends CopyExecutionResult {
  candidatePrice: number;
  candidateNotional: number;
  finalStatus: 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED';
  filledSize: number;
  filledNotional: number;
  cancelled: boolean;
  reason: string;
}

export class TradeExecutor {
  private wallet: ethers.Wallet;
  private provider: ethers.providers.JsonRpcProvider;
  private clobClient: ClobClient;
  private apiCreds?: { apiKey: string; secret: string; passphrase: string };
  private marketCache: Map<string, MarketMetadata> = new Map();
  private orderbookCache = new Map<string, OrderbookCacheEntry>();
  private outcomeMapByConditionId = new Map<string, OutcomeTokenMap>();
  private outcomeMapByMarketSlug = new Map<string, OutcomeTokenMap>();
  private activeMarketsCache?: ActiveMarketsCacheEntry;
  private warnedMissingOutcomeMappings = new Set<string>();
  private readonly CACHE_TTL = 3600000;
  private readonly ACTIVE_MARKETS_CACHE_TTL = 60_000;
  private readonly RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
  };
  private readonly ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
  ];
  private readonly CTF_ABI = [
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
  ];

  constructor() {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);

    const { sigType, funderAddress } = config.auth;
    const funder = funderAddress || this.wallet.address;
    const apiCreds = config.clobApiKey
      ? {
        key: config.clobApiKey,
        secret: config.clobApiSecret,
        passphrase: config.clobApiPassphrase,
      }
      : undefined;

    if (apiCreds) {
      this.apiCreds = {
        apiKey: config.clobApiKey,
        secret: config.clobApiSecret,
        passphrase: config.clobApiPassphrase,
      };
    }

    this.clobClient = new ClobClient(
      'https://clob.polymarket.com',
      137,
      this.wallet,
      apiCreds,
      sigType,
      funder,
      config.polymarketGeoToken || undefined
    );
  }

  private getSignerAddress(): string {
    return this.wallet.address;
  }

  private getFunderAddress(): string {
    return config.auth.funderAddress || this.wallet.address;
  }

  private getFundsCheckAddress(): string {
    return config.auth.sigType !== 0 && config.auth.funderAddress
      ? config.auth.funderAddress
      : this.wallet.address;
  }

  async initialize(): Promise<void> {
    console.log(`🔧 Initializing trader...`);
    const { sigType, funderAddress } = config.auth;
    const signer = this.getSignerAddress();
    const funder = funderAddress || signer;
    const fundsCheckWallet = this.getFundsCheckAddress();
    console.log(`   Signing wallet: ${signer} (from WALLET_PRIVATE_KEY)`);
    console.log(`   Funder: ${funder} (${funderAddress ? 'from PROXY_WALLET_ADDRESS' : 'fallback to signer'})`);
    console.log(`   Funds/allowance check wallet: ${fundsCheckWallet}`);
    console.log(`   Execution signer: ${signer}`);
    if (signer.toLowerCase() !== funder.toLowerCase()) {
      console.log(`   ⚠️  signer/funder mismatch (proxy mode)`);
    }
    console.log(`   Signature type: ${sigType}`);
    console.log(`   CLOB API key (first 6): ${config.clobApiKey?.slice(0, 6) || 'dynamic'}`);

    try {
      if (!config.clobApiKey) {
        await this.deriveAndReinitApiKeys(funder);
      } else {
        console.log('🔑 Using static CLOB API credentials from env');
      }
      await this.validateApiCredentials();
    } catch (error: any) {
      console.error(`❌ Failed to initialize API credentials:`, error.message);
      throw error;
    }

    await this.validateWalletReadiness();

    console.log(`✅ Trader initialized`);
    console.log(`   Market cache: Enabled (TTL: ${this.CACHE_TTL / 1000}s)`);
  }

  private isApiError(resp: any): boolean {
    return resp && typeof resp === 'object' && 'error' in resp;
  }

  private getApiErrorMessage(resp: any): string {
    if (!resp) return 'Unknown error';
    if (typeof resp === 'string') return resp;
    if (resp.error) return resp.error;
    return JSON.stringify(resp);
  }

  private async validateApiCredentials(): Promise<void> {
    const result: any = await this.clobClient.getApiKeys();
    if (result?.error || result?.status >= 400) {
      throw new Error(`Invalid CLOB API credentials: ${result?.error || `status ${result?.status}`}`);
    }
    console.log(`✅ CLOB API credentials validated`);
  }

  private async deriveAndReinitApiKeys(funderAddress: string): Promise<void> {
    console.log(`   Generating API credentials programmatically...`);
    let creds = await this.clobClient.deriveApiKey().catch(() => null);
    if (!creds || this.isApiError(creds)) {
      creds = await this.clobClient.createApiKey();
    }

    const apiKey = (creds as any)?.apiKey || (creds as any)?.key;
    if (this.isApiError(creds) || !apiKey || !creds?.secret || !creds?.passphrase) {
      const errMsg = this.getApiErrorMessage(creds);
      throw new Error(`Could not create/derive API key: ${errMsg}`);
    }

    console.log(`✅ API credentials generated!`);
    console.log(`   Credentials loaded in memory for this session`);
    console.log(`   API credentials remain in memory only; no credential export script is shipped in this baseline`);

    this.apiCreds = {
      apiKey,
      secret: creds.secret,
      passphrase: creds.passphrase,
    };

    this.clobClient = new ClobClient(
      'https://clob.polymarket.com',
      137,
      this.wallet,
      {
        key: apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
      config.auth.sigType,
      funderAddress,
      config.polymarketGeoToken || undefined
    );
  }

  getWsAuth(): { apiKey: string; secret: string; passphrase: string } | undefined {
    return this.apiCreds;
  }

  getAccountAddress(): string {
    return this.getFundsCheckAddress();
  }

  getCacheStats(): { size: number; items: string[] } {
    return {
      size: this.marketCache.size,
      items: Array.from(this.marketCache.keys()),
    };
  }

  clearCache(): void {
    this.marketCache.clear();
    console.log('🗑️  Market cache cleared');
  }

  calculateCopySize(originalSize: number): number {
    const { positionSizeMultiplier, maxTradeSize, minTradeSize, orderType, maxUsdPerOrder } = config.trading;
    let size = originalSize * positionSizeMultiplier;
    size = Math.min(size, maxTradeSize, maxUsdPerOrder);
    const marketMin = orderType === 'FOK' || orderType === 'FAK' ? 1 : minTradeSize;
    size = Math.max(size, marketMin);
    return Math.round(size * 100) / 100;
  }

  calculateCopyShares(originalSizeUsdc: number, price: number): number {
    const notional = this.calculateCopySize(originalSizeUsdc);
    return this.calculateSharesFromNotional(notional, price);
  }

  calculateSharesFromNotional(notional: number, price: number): number {
    const shares = notional / price;
    return Math.round(shares * 10000) / 10000;
  }

  async getMarketMetadata(tokenId: string): Promise<MarketMetadata> {
    const cached = this.marketCache.get(tokenId);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      return cached;
    }

    try {
      const [tickSizeData, negRisk, feeRateBps, outcomeLabel] = await Promise.all([
        this.clobClient.getTickSize(tokenId).catch(() => ({ minimum_tick_size: '0.01' })),
        this.clobClient.getNegRisk(tokenId).catch(() => false),
        this.clobClient.getFeeRateBps(tokenId).catch(() => 0),
        this.resolveOutcomeLabel(tokenId),
      ]);

      const tickSizeStr = (tickSizeData as any)?.minimum_tick_size || tickSizeData || '0.01';
      const tickSize = parseFloat(tickSizeStr);

      const metadata: MarketMetadata = {
        tickSize,
        tickSizeStr,
        negRisk,
        feeRateBps,
        outcomeLabel,
        timestamp: now,
      };

      this.marketCache.set(tokenId, metadata);

      return metadata;
    } catch (error) {
      console.log(`⚠️  Could not fetch market metadata for ${tokenId}, using defaults`);
      const defaultMetadata: MarketMetadata = {
        tickSize: 0.01,
        tickSizeStr: '0.01',
        negRisk: false,
        feeRateBps: 0,
        outcomeLabel: undefined,
        timestamp: now,
      };
      this.marketCache.set(tokenId, defaultMetadata);
      return defaultMetadata;
    }
  }

  async getOutcomeLabel(tokenId: string): Promise<string> {
    const metadata = await this.getMarketMetadata(tokenId);
    if (metadata.outcomeLabel) {
      return metadata.outcomeLabel;
    }
    if (!this.warnedMissingOutcomeMappings.has(tokenId)) {
      this.warnedMissingOutcomeMappings.add(tokenId);
      console.warn(`[WARN] outcome mapping not found for tokenId=${tokenId}`);
    }
    return 'UNKNOWN';
  }

  async validateExecutionTarget(originalTrade: Trade): Promise<ExecutionValidationResult> {
    const PRICE_MATCH_EPSILON = 0.02;
    const sourcePrice = Number(originalTrade.price);
    const sourceResolution = await this.resolveSourceSideExecutionTarget(originalTrade);
    const fallbackResult = {
      trade: originalTrade,
      orderbook: null,
      bestBid: null,
      bestAsk: null,
      chosenTokenId: originalTrade.tokenId,
      outcomeSide: sourceResolution?.sourceOutcomeSide || (sourcePrice >= 0.5 ? 'UP' : 'DOWN'),
      slippage: null,
      asksDepth: 0,
      rejected: true,
      reason: 'market_outcome_map_missing',
    } satisfies ExecutionValidationResult;

    if (!sourceResolution) {
      return fallbackResult;
    }

    const { sourceOutcomeSide, expectedTokenId, upTokenId, downTokenId } = sourceResolution;
    const normalizedOriginalTokenId = String(originalTrade.tokenId || '').trim();
    console.log('[Execution Side Locked]', {
      market: originalTrade.market,
      sourceSide: sourceOutcomeSide,
      executionSide: sourceOutcomeSide,
      sourceTokenId: normalizedOriginalTokenId || null,
      executionTokenId: expectedTokenId,
      outcomeMapUpTokenId: upTokenId,
      outcomeMapDownTokenId: downTokenId,
      mustMatch: true,
    });

    const expectedLookup = await this.getOrderbookLookup(expectedTokenId, originalTrade.market);
    const validationChosenTokenId = expectedTokenId;
    const validationBestBid = expectedLookup.bestBid;
    const validationBestAsk = expectedLookup.bestAsk;
    const validationAsksDepth = expectedLookup.asksDepth;
    const validationPassed = expectedLookup.bestAsk != null && Math.abs(expectedLookup.bestAsk - sourcePrice) <= PRICE_MATCH_EPSILON;
    const slippage = validationBestAsk != null && sourcePrice > 0
      ? (validationBestAsk - sourcePrice) / sourcePrice
      : null;

    const validatedTrade: Trade = {
      ...originalTrade,
      tokenId: validationChosenTokenId,
      outcome: sourceOutcomeSide,
      outcomeName: sourceOutcomeSide,
    };

    console.log('[Execution Validation]', {
      sourcePrice,
      chosenSide: sourceOutcomeSide,
      chosenTokenId: validationChosenTokenId,
      chosenBestBid: validationBestBid,
      chosenBestAsk: validationBestAsk,
      directAskMatches: validationPassed,
      validationPassed,
      validationReason: validationPassed ? 'source_side_ask_match' : 'source_side_locked',
    });

    console.log('[Execution Decision]', {
      sourcePrice,
      chosenSide: sourceOutcomeSide,
      tokenId: validationChosenTokenId,
      bestBid: validationBestBid,
      bestAsk: validationBestAsk,
      slippage,
    });

    if (expectedLookup.status === 'not_found') {
      console.log('[Execution Validation]', {
        market: originalTrade.market,
        sourceSide: sourceOutcomeSide,
        expectedTokenId,
        bestAsk: validationBestAsk,
        bestBid: validationBestBid,
        skipReason: 'no_orderbook_on_source_side',
      });
      return {
        ...fallbackResult,
        trade: validatedTrade,
        orderbook: null,
        bestBid: validationBestBid,
        bestAsk: validationBestAsk,
        chosenTokenId: validationChosenTokenId,
        slippage,
        asksDepth: validationAsksDepth,
        reason: 'no_orderbook_on_source_side',
      };
    }

    if (validationAsksDepth === 0 || validationBestAsk == null || validationBestAsk <= 0) {
      console.log('[Execution Validation]', {
        market: originalTrade.market,
        sourceSide: sourceOutcomeSide,
        expectedTokenId,
        bestAsk: validationBestAsk,
        bestBid: validationBestBid,
        skipReason: 'no_ask_on_source_side',
      });
      return {
        ...fallbackResult,
        trade: validatedTrade,
        orderbook: expectedLookup.orderbook || null,
        bestBid: validationBestBid,
        bestAsk: validationBestAsk,
        chosenTokenId: validationChosenTokenId,
        slippage,
        asksDepth: validationAsksDepth,
        reason: 'no_ask_on_source_side',
      };
    }

    if (!validationPassed) {
      console.log('[Execution Validation]', {
        market: originalTrade.market,
        sourceSide: sourceOutcomeSide,
        expectedTokenId,
        bestAsk: validationBestAsk,
        bestBid: validationBestBid,
        skipReason: 'source_side_price_mismatch',
      });
      return {
        ...fallbackResult,
        trade: validatedTrade,
        orderbook: expectedLookup.orderbook || null,
        bestBid: validationBestBid,
        bestAsk: validationBestAsk,
        chosenTokenId: validationChosenTokenId,
        slippage,
        asksDepth: validationAsksDepth,
        reason: 'source_side_price_mismatch',
      };
    }

    return {
      trade: validatedTrade,
      orderbook: expectedLookup.orderbook,
      bestBid: validationBestBid,
      bestAsk: validationBestAsk,
      chosenTokenId: validationChosenTokenId,
      outcomeSide: sourceOutcomeSide,
      slippage,
      asksDepth: validationAsksDepth,
      rejected: false,
      path: 'direct_source_token',
    };
  }

  async precheckSignalSourceSide(trade: Trade): Promise<{
    ok: boolean;
    trade: Trade;
    reason?: string;
    tokenId?: string;
    bestAsk: number | null;
    bestBid: number | null;
  }> {
    const sourceResolution = await this.resolveSourceSideExecutionTarget(trade);
    if (!sourceResolution) {
      return {
        ok: false,
        trade,
        reason: 'market_outcome_map_missing',
        tokenId: trade.tokenId,
        bestAsk: null,
        bestBid: null,
      };
    }

    const { sourceOutcomeSide, expectedTokenId } = sourceResolution;
    const lookup = await this.getOrderbookLookup(expectedTokenId, trade.market);
    console.log('[Signal Precheck]', {
      sourceSide: sourceOutcomeSide,
      executionSide: sourceOutcomeSide,
      tokenId: expectedTokenId,
      bestAsk: lookup.bestAsk,
      bestBid: lookup.bestBid,
      asksDepth: lookup.asksDepth,
      bidsDepth: lookup.bidsDepth,
      action: lookup.status === 'not_found' || lookup.bestAsk == null || lookup.bestAsk <= 0 ? 'skip' : 'continue',
    });

    const resolvedTrade: Trade = {
      ...trade,
      tokenId: expectedTokenId,
      outcome: sourceOutcomeSide,
      outcomeName: sourceOutcomeSide,
    };

    if (lookup.status === 'not_found' || lookup.bestAsk == null || lookup.bestAsk <= 0) {
      console.log('[Signal Precheck Skip]', {
        reason: 'no_ask_on_source_side',
        sourceSide: sourceOutcomeSide,
        executionSide: sourceOutcomeSide,
        tokenId: expectedTokenId,
        bestAsk: lookup.bestAsk,
        asksDepth: lookup.asksDepth,
      });
      return {
        ok: false,
        trade: resolvedTrade,
        reason: 'no_ask_on_source_side',
        tokenId: expectedTokenId,
        bestAsk: lookup.bestAsk,
        bestBid: lookup.bestBid,
      };
    }

    return {
      ok: true,
      trade: resolvedTrade,
      tokenId: expectedTokenId,
      bestAsk: lookup.bestAsk,
      bestBid: lookup.bestBid,
    };
  }

  private async resolveSourceSideExecutionTarget(originalTrade: Trade): Promise<SourceSideResolution | null> {
    const sourcePrice = Number(originalTrade.price);
    const defaultOutcomeSide: 'UP' | 'DOWN' = sourcePrice >= 0.5 ? 'UP' : 'DOWN';
    const sourceOutcomeSide = this.normalizeOutcomeSide(originalTrade.outcomeName || originalTrade.outcome) || defaultOutcomeSide;
    const outcomeMap = await this.getOutcomeMapForTrade(originalTrade);
    const upTokenId = outcomeMap?.UP;
    const downTokenId = outcomeMap?.DOWN;
    if (!upTokenId || !downTokenId) {
      return null;
    }

    return {
      sourceOutcomeSide,
      expectedTokenId: sourceOutcomeSide === 'UP' ? upTokenId : downTokenId,
      upTokenId,
      downTokenId,
    };
  }

  private async resolveOutcomeLabel(tokenId: string): Promise<string | undefined> {
    try {
      const { data } = await axios.get<any[]>(`${DATA_API_BASE}/markets`, {
        params: {
          clob_token_ids: tokenId,
          limit: 1,
        },
        timeout: 15_000,
      });

      const market = Array.isArray(data) ? data[0] : undefined;
      if (!market) {
        return undefined;
      }

      const tokenLabel = this.findOutcomeLabelInMarket(market, tokenId);
      return tokenLabel || undefined;
    } catch {
      return undefined;
    }
  }

  seedOutcomeMapFromTrade(trade: Pick<Trade, 'conditionId' | 'marketSlug' | 'outcome' | 'outcomeName' | 'tokenId'>): void {
    const normalizedOutcome = this.normalizeOutcomeSide(trade.outcomeName || trade.outcome);
    const tokenId = String(trade.tokenId || '').trim();
    const conditionId = String(trade.conditionId || '').trim();
    const marketSlug = String(trade.marketSlug || '').trim().toLowerCase();

    if (!normalizedOutcome || !tokenId || (!conditionId && !marketSlug)) {
      return;
    }

    const existing = this.getCachedOutcomeMap(conditionId, marketSlug) || {};
    const nextMap: OutcomeTokenMap = {
      ...existing,
      conditionId: conditionId || existing.conditionId || null,
      marketSlug: marketSlug || existing.marketSlug || null,
      [normalizedOutcome]: tokenId,
      updatedAt: Date.now(),
    };
    nextMap.complete = Boolean(nextMap.UP && nextMap.DOWN);

    this.storeOutcomeMap(nextMap, conditionId || null, marketSlug || null);
    console.log('[Outcome Map Partial Seeded]', {
      conditionId: conditionId || null,
      marketSlug: marketSlug || null,
      seededSide: normalizedOutcome,
      tokenId,
      complete: Boolean(nextMap.UP && nextMap.DOWN),
    });
  }

  private getCachedOutcomeMap(conditionId?: string | null, marketSlug?: string | null): OutcomeTokenMap | null {
    const normalizedConditionId = String(conditionId || '').trim();
    const normalizedMarketSlug = String(marketSlug || '').trim().toLowerCase();

    if (normalizedConditionId) {
      const byCondition = this.outcomeMapByConditionId.get(normalizedConditionId);
      if (byCondition) {
        console.log('[Outcome Map Cache Hit]', {
          keyType: 'condition_id',
          key: normalizedConditionId,
          complete: Boolean(byCondition.UP && byCondition.DOWN),
        });
        return byCondition;
      }
    }

    if (normalizedMarketSlug) {
      const bySlug = this.outcomeMapByMarketSlug.get(normalizedMarketSlug);
      if (bySlug) {
        console.log('[Outcome Map Cache Hit]', {
          keyType: 'market_slug',
          key: normalizedMarketSlug,
          complete: Boolean(bySlug.UP && bySlug.DOWN),
        });
        return bySlug;
      }
    }

    const persisted = findOutcomeMapCache(normalizedConditionId || null, normalizedMarketSlug || null);
    if (!persisted) {
      return null;
    }

    const outcomeMap: OutcomeTokenMap = {
      conditionId: persisted.conditionId || null,
      marketSlug: persisted.marketSlug || null,
      UP: persisted.upTokenId || undefined,
      DOWN: persisted.downTokenId || undefined,
      complete: Boolean(persisted.upTokenId && persisted.downTokenId),
      updatedAt: persisted.updatedTs,
    };
    this.storeOutcomeMap(outcomeMap, persisted.conditionId || null, persisted.marketSlug || null, false);
    console.log('[Outcome Map Cache Hit]', {
      keyType: persisted.conditionId ? 'condition_id' : 'market_slug',
      key: persisted.conditionId || persisted.marketSlug,
      complete: Boolean(outcomeMap.UP && outcomeMap.DOWN),
      source: 'persistent',
    });
    return outcomeMap;
  }

  private storeOutcomeMap(
    outcomeMap: OutcomeTokenMap,
    conditionId?: string | null,
    marketSlug?: string | null,
    persist: boolean = true
  ): void {
    const normalizedConditionId = String(conditionId || '').trim();
    const normalizedMarketSlug = String(marketSlug || '').trim().toLowerCase();
    const normalizedOutcomeMap: OutcomeTokenMap = {
      ...outcomeMap,
      conditionId: normalizedConditionId || outcomeMap.conditionId || null,
      marketSlug: normalizedMarketSlug || outcomeMap.marketSlug || null,
      updatedAt: outcomeMap.updatedAt || Date.now(),
    };
    normalizedOutcomeMap.complete = Boolean(normalizedOutcomeMap.UP && normalizedOutcomeMap.DOWN);

    if (normalizedConditionId) {
      this.outcomeMapByConditionId.set(normalizedConditionId, normalizedOutcomeMap);
    }
    if (normalizedMarketSlug) {
      this.outcomeMapByMarketSlug.set(normalizedMarketSlug, normalizedOutcomeMap);
    }

    if (persist) {
      upsertOutcomeMapCache({
        conditionId: normalizedOutcomeMap.conditionId || null,
        marketSlug: normalizedOutcomeMap.marketSlug || null,
        upTokenId: normalizedOutcomeMap.UP || null,
        downTokenId: normalizedOutcomeMap.DOWN || null,
        updatedTs: normalizedOutcomeMap.updatedAt || Date.now(),
      });
    }
  }

  private async getOutcomeMapForTrade(trade: Pick<Trade, 'conditionId' | 'marketSlug'>): Promise<OutcomeTokenMap | null> {
    const conditionId = String(trade.conditionId || '').trim();
    const marketSlug = String(trade.marketSlug || '').trim().toLowerCase();

    const cached = this.getCachedOutcomeMap(conditionId || null, marketSlug || null);
    if (cached?.UP && cached?.DOWN) {
      return cached;
    }

    const resolved = await this.resolveOutcomeMapForTrade(trade, cached || {});
    if (!resolved?.UP || !resolved?.DOWN) {
      console.log('[Outcome Map Missing]', {
        conditionId: conditionId || null,
        marketSlug: marketSlug || null,
      });
      return resolved && (resolved.UP || resolved.DOWN) ? resolved : null;
    }

    console.log('[Outcome Map Resolved]', {
      conditionId: conditionId || null,
      marketSlug: marketSlug || null,
      upTokenId: resolved.UP,
      downTokenId: resolved.DOWN,
    });
    return resolved;
  }

  private async resolveOutcomeMapForTrade(
    trade: Pick<Trade, 'conditionId' | 'marketSlug'>,
    baseMap: OutcomeTokenMap
  ): Promise<OutcomeTokenMap | null> {
    const conditionId = String(trade.conditionId || '').trim();
    const marketSlug = String(trade.marketSlug || '').trim().toLowerCase();
    if (!conditionId && !marketSlug) {
      return null;
    }

    const queryVariants = [
      conditionId ? { condition_id: conditionId, limit: 5 } : null,
      conditionId ? { conditionId, limit: 5 } : null,
      marketSlug ? { slug: marketSlug, limit: 5 } : null,
      marketSlug ? { market_slug: marketSlug, limit: 5 } : null,
    ].filter(Boolean) as Array<Record<string, string | number>>;

    for (const params of queryVariants) {
      try {
        console.log('[Outcome Map Lookup Start]', {
          conditionId: conditionId || null,
          marketSlug: marketSlug || null,
          params,
        });
        const { data } = await axios.get<any[]>(GAMMA_MARKETS_URL, {
          params,
          timeout: 15_000,
        });
        const markets = Array.isArray(data) ? data : [];
        const matched = markets.find((market) => {
          const candidateConditionId = String(market?.conditionId || market?.condition_id || '').trim();
          const candidateSlug = String(market?.slug || market?.marketSlug || market?.market_slug || '').trim().toLowerCase();
          return (
            (conditionId && candidateConditionId === conditionId) ||
            (marketSlug && candidateSlug === marketSlug)
          );
        });
        if (!matched) {
          continue;
        }

        const matchedConditionId = String(matched?.conditionId || matched?.condition_id || '').trim();
        const matchedMarketSlug = String(matched?.slug || matched?.marketSlug || matched?.market_slug || '').trim().toLowerCase();
        const resolvedMap = this.buildOutcomeMapFromMarket(matched, {
          ...baseMap,
          conditionId: conditionId || matchedConditionId || baseMap.conditionId || null,
          marketSlug: marketSlug || matchedMarketSlug || baseMap.marketSlug || null,
        });
        this.storeOutcomeMap(
          resolvedMap,
          conditionId || matchedConditionId || null,
          marketSlug || matchedMarketSlug || null
        );
        return resolvedMap;
      } catch (error: any) {
        console.log(`⚠️  Outcome map resolve failed: ${error?.message || 'Unknown error'}`);
      }
    }

    return Object.keys(baseMap).length > 0 ? baseMap : null;
  }

  private buildOutcomeMapFromMarket(market: any, seedMap: OutcomeTokenMap = {}): OutcomeTokenMap {
    const outcomeMap: OutcomeTokenMap = {
      ...seedMap,
      conditionId: String(market?.conditionId || market?.condition_id || seedMap.conditionId || '').trim() || null,
      marketSlug: String(market?.slug || market?.marketSlug || market?.market_slug || seedMap.marketSlug || '').trim().toLowerCase() || null,
      updatedAt: Date.now(),
    };
    const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
    for (const token of tokens) {
      const tokenId = String(token?.token_id || token?.tokenId || token?.asset_id || token?.id || '').trim();
      const normalizedOutcome = this.normalizeOutcomeSide(
        token?.outcome ||
        token?.label ||
        token?.name ||
        token?.shortName ||
        token?.short_name
      );
      if (tokenId && normalizedOutcome) {
        outcomeMap[normalizedOutcome] = tokenId;
      }
    }

    const outcomes = this.parseOutcomeArray(market?.outcomes);
    if (outcomes.length === tokens.length && outcomes.length > 0) {
      for (let i = 0; i < tokens.length; i++) {
        const tokenId = String(tokens[i]?.token_id || tokens[i]?.tokenId || tokens[i]?.asset_id || tokens[i]?.id || '').trim();
        const normalizedOutcome = this.normalizeOutcomeSide(outcomes[i]);
        if (tokenId && normalizedOutcome && !outcomeMap[normalizedOutcome]) {
          outcomeMap[normalizedOutcome] = tokenId;
        }
      }
    }

    const clobTokenIds = this.parseTokenIdArray(market?.clobTokenIds ?? market?.clob_token_ids);
    if (outcomes.length === clobTokenIds.length && outcomes.length > 0) {
      for (let i = 0; i < clobTokenIds.length; i++) {
        const normalizedOutcome = this.normalizeOutcomeSide(outcomes[i]);
        const tokenId = clobTokenIds[i];
        if (tokenId && normalizedOutcome && !outcomeMap[normalizedOutcome]) {
          outcomeMap[normalizedOutcome] = tokenId;
        }
      }
    }

    outcomeMap.complete = Boolean(outcomeMap.UP && outcomeMap.DOWN);

    return outcomeMap;
  }

  private findOutcomeLabelInMarket(market: any, tokenId: string): string | undefined {
    const tokens = Array.isArray(market?.tokens) ? market.tokens : [];
    for (const token of tokens) {
      const candidateId = String(token?.token_id || token?.tokenId || token?.asset_id || token?.id || '');
      if (candidateId !== tokenId) {
        continue;
      }

      const directLabel = this.normalizeOutcomeLabel(
        token?.outcome ||
        token?.label ||
        token?.name ||
        token?.shortName ||
        token?.short_name
      );
      if (directLabel) {
        return directLabel;
      }
    }

    const outcomes = this.parseOutcomeArray(market?.outcomes);
    if (outcomes.length === tokens.length && outcomes.length > 0) {
      for (let i = 0; i < tokens.length; i++) {
        const candidateId = String(tokens[i]?.token_id || tokens[i]?.tokenId || tokens[i]?.asset_id || tokens[i]?.id || '');
        if (candidateId === tokenId) {
          return outcomes[i];
        }
      }
    }

    return undefined;
  }

  private parseOutcomeArray(value: any): string[] {
    if (Array.isArray(value)) {
      return value
        .map((item) => this.normalizeOutcomeLabel(item?.outcome ?? item?.label ?? item?.name ?? item))
        .filter(Boolean) as string[];
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => this.normalizeOutcomeLabel(item)).filter(Boolean) as string[];
        }
      } catch {
        return value
          .split(',')
          .map((item) => this.normalizeOutcomeLabel(item))
          .filter(Boolean) as string[];
      }
    }

    return [];
  }

  private parseTokenIdArray(value: any): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item ?? '').trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item ?? '').trim()).filter(Boolean);
        }
      } catch {
        return value
          .split(',')
          .map((item) => String(item ?? '').trim())
          .filter(Boolean);
      }
    }

    return [];
  }

  private normalizeOutcomeLabel(value: any): string | undefined {
    const normalized = String(value ?? '').trim();
    if (!normalized) return undefined;
    return normalized.toUpperCase();
  }

  private normalizeOutcomeSide(value: any): 'UP' | 'DOWN' | undefined {
    const normalized = this.normalizeOutcomeLabel(value);
    if (!normalized) return undefined;
    if (normalized === 'YES' || normalized === 'UP') return 'UP';
    if (normalized === 'NO' || normalized === 'DOWN') return 'DOWN';
    return undefined;
  }

  async getTickSize(tokenId: string): Promise<number> {
    const metadata = await this.getMarketMetadata(tokenId);
    return metadata.tickSize;
  }

  private normalizeOrderbook(orderbook: any): OrderbookCacheEntry {
    return {
      bids: Array.isArray(orderbook?.bids) ? orderbook.bids : [],
      asks: Array.isArray(orderbook?.asks) ? orderbook.asks : [],
      ts: Date.now(),
    };
  }

  private setOrderbookCache(tokenId: string, orderbook: any, source: 'prewarm' | 'fetch' | 'execution_fetch'): OrderbookCacheEntry {
    const normalized = this.normalizeOrderbook(orderbook);
    this.orderbookCache.set(tokenId, normalized);
    console.log('[Orderbook Cache Update]', {
      tokenId,
      source,
      bidsDepth: normalized.bids.length,
      asksDepth: normalized.asks.length,
      ts: normalized.ts,
    });
    return normalized;
  }

  private getFreshOrderbookCache(tokenId: string): OrderbookCacheEntry | undefined {
    const cached = this.orderbookCache.get(tokenId);
    if (!cached) return undefined;
    if (Date.now() - cached.ts >= config.monitoring.orderbookCacheTtlMs) {
      return undefined;
    }
    return cached;
  }

  private async fetchOrderbookFromApi(tokenId: string): Promise<OrderbookCacheEntry | null> {
    try {
      const orderbook = await this.clobClient.getOrderBook(tokenId);
      return this.setOrderbookCache(tokenId, orderbook, 'fetch');
    } catch (error: any) {
      if (this.isOrderbookNotFoundError(error)) {
        console.log('[Orderbook Not Found]', {
          tokenId,
          source: 'clob_book',
          reason: 'token_not_tradeable_on_current_clob',
        });
        return null;
      }
      console.log(`⚠️  Could not fetch orderbook for ${tokenId}: ${error?.message || 'Unknown error'}`);
      return null;
    }
  }

  private isOrderbookNotFoundError(error: any): boolean {
    const status = Number(error?.response?.status);
    const message = String(error?.response?.data?.error || error?.response?.data?.message || error?.message || '');
    return status === 404 || message.includes('No orderbook exists for the requested token id');
  }

  private async getOrderbookLookup(tokenId: string, market?: string): Promise<OrderbookLookupResult> {
    const cached = this.getFreshOrderbookCache(tokenId);
    if (cached) {
      const top = this.getTopOfBook({ bids: cached.bids, asks: cached.asks });
      return {
        tokenId,
        orderbook: { bids: cached.bids, asks: cached.asks },
        status: 'ok',
        ...top,
      };
    }

    try {
      const orderbook = await this.clobClient.getOrderBook(tokenId);
      const normalized = this.setOrderbookCache(tokenId, orderbook, 'execution_fetch');
      const payload = { bids: normalized.bids, asks: normalized.asks };
      return {
        tokenId,
        orderbook: payload,
        status: 'ok',
        ...this.getTopOfBook(payload),
      };
    } catch (error: any) {
      if (this.isOrderbookNotFoundError(error)) {
        console.log('[Orderbook Not Found]', {
          market: market || null,
          tokenId,
          source: 'clob_book',
          reason: 'token_not_tradeable_on_current_clob',
        });
        return {
          tokenId,
          orderbook: null,
          status: 'not_found',
          bestBid: null,
          bestAsk: null,
          bidsDepth: 0,
          asksDepth: 0,
        };
      }
      console.log(`⚠️  Could not fetch orderbook for ${tokenId}: ${error?.message || 'Unknown error'}`);
      return {
        tokenId,
        orderbook: null,
        status: 'error',
        bestBid: null,
        bestAsk: null,
        bidsDepth: 0,
        asksDepth: 0,
      };
    }
  }

  async getOrderbook(tokenId: string): Promise<any | null> {
    const cached = this.getFreshOrderbookCache(tokenId);
    const staleCached = this.orderbookCache.get(tokenId);
    const ageMs = staleCached ? Date.now() - staleCached.ts : null;
    const cacheHit = Boolean(cached);
    const cacheExpired = Boolean(staleCached && !cached);
    if (cached) {
      console.log('[Orderbook Cache]', {
        tokenId,
        source: 'cache',
        ageMs,
        cacheHit,
        cacheExpired,
      });
      return { bids: cached.bids, asks: cached.asks };
    }

    console.log('[Orderbook Cache]', {
      tokenId,
      source: 'fetch',
      ageMs,
      cacheHit,
      cacheExpired,
    });

    const fetched = await this.fetchOrderbookFromApi(tokenId);
    if (fetched) {
      return { bids: fetched.bids, asks: fetched.asks };
    }

    if (staleCached) {
      return { bids: staleCached.bids, asks: staleCached.asks };
    }

    return null;
  }

  private async getOrderbookForExecution(tokenId: string): Promise<any> {
    const cached = this.getFreshOrderbookCache(tokenId);
    const staleCached = this.orderbookCache.get(tokenId);
    const ageMs = staleCached ? Date.now() - staleCached.ts : null;
    const cacheHit = Boolean(cached);
    const cacheExpired = Boolean(staleCached && !cached);
    if (cached) {
      console.log('[Orderbook Cache]', {
        tokenId,
        source: 'cache',
        ageMs,
        cacheHit,
        cacheExpired,
      });
      return { bids: cached.bids, asks: cached.asks };
    }

    console.log('[Orderbook Cache]', {
      tokenId,
      source: 'fetch',
      ageMs,
      cacheHit,
      cacheExpired,
    });

    try {
      const orderbook = await this.clobClient.getOrderBook(tokenId);
      const normalized = this.setOrderbookCache(tokenId, orderbook, 'execution_fetch');
      return { bids: normalized.bids, asks: normalized.asks };
    } catch (error: any) {
      if (this.isOrderbookNotFoundError(error)) {
        console.log('[Orderbook Not Found]', {
          tokenId,
          source: 'clob_book',
          reason: 'token_not_tradeable_on_current_clob',
        });
        throw new Error('orderbook_not_found');
      }
      throw error;
    }
  }

  async prewarmOrderbooks(
    subscribeToMarket?: (tokenId: string) => Promise<void>
  ): Promise<void> {
    if (!config.monitoring.enableOrderbookPrewarm || config.monitoring.prewarmSymbols.length === 0) {
      return;
    }

    console.log('[Orderbook Prewarm Rule Summary]', {
      symbolRule: 'strict crypto token/word match',
      marketTypeRule: 'crypto market must also be up/down',
      upDownSignals: [
        'title contains "up or down"',
        'slug contains "updown"',
        'slug contains "up-or-down"',
      ],
    });
    const resolution = await this.resolvePrewarmTokenIds();
    console.log('[Orderbook Prewarm Markets]', {
      loadedMarketsCount: resolution.loadedMarketsCount,
      matchedMarketsCount: resolution.matchedMarketsCount,
      resolvedTokenIdsCount: resolution.resolvedTokenIdsCount,
    });
    if (resolution.targets.length === 0) {
      console.log('ℹ️  Orderbook prewarm found no matching tokenIds');
      if (resolution.missingSymbols.length > 0) {
        console.log('[Orderbook Prewarm Missing Symbols]', resolution.missingSymbols);
      }
      return;
    }

    console.log(`🔥 Prewarming orderbooks for ${resolution.targets.length} token(s)`);
    console.log('[Orderbook Prewarm Found Symbols]', resolution.foundSymbols);
    if (resolution.missingSymbols.length > 0) {
      console.log('[Orderbook Prewarm Missing Symbols]', resolution.missingSymbols);
    }
    console.log('[Orderbook Prewarm Targets]', resolution.targets);
    const subscribedTokenIds: string[] = [];
    for (const target of resolution.targets) {
      try {
        if (subscribeToMarket) {
          await subscribeToMarket(target.tokenId);
          subscribedTokenIds.push(target.tokenId);
        }
        const orderbook = await this.clobClient.getOrderBook(target.tokenId);
        this.setOrderbookCache(target.tokenId, orderbook, 'prewarm');
      } catch (error: any) {
        console.log(`⚠️  Orderbook prewarm failed for ${target.tokenId}: ${error?.message || 'Unknown error'}`);
      }
    }
    console.log('[Orderbook Prewarm Subscribed TokenIds]', subscribedTokenIds);
  }

  private async resolvePrewarmTokenIds(): Promise<PrewarmResolutionResult> {
    try {
      const targets = new Map<string, PrewarmTarget>();
      const foundSymbols = new Set<string>();
      const strictSymbols = this.getStrictPrewarmSymbols();
      const missingSymbols = new Set<string>(strictSymbols);
      const matchedMarkets = new Set<string>();
      const markets = await this.loadActiveOpenMarkets();

      for (const market of markets) {
        const evaluation = this.evaluatePrewarmMarket(market);
        if (evaluation.symbolMatches.length === 0) {
          continue;
        }

        const marketTitle = String(
          market?.question ||
          market?.title ||
          market?.market ||
          'unknown-market'
        );
        const marketSlug = String(
          market?.slug ||
          market?.marketSlug ||
          market?.market_slug ||
          ''
        );

        if (!evaluation.isUpDown) {
          console.log('[Prewarm Skipped Crypto Market]', {
            reason: 'not_updown',
            marketTitle,
            marketSlug,
          });
          continue;
        }

        const tokenIds = this.extractTokenIdsFromMarket(market);
        if (tokenIds.length === 0) {
          continue;
        }

        for (const match of evaluation.symbolMatches) {
          console.log('[Prewarm Match]', {
            marketTitle,
            marketSlug,
            matchedSymbols: evaluation.symbolMatches.map((item) => item.symbol),
            updownMatched: true,
            matchedSymbol: match.symbol,
            matchedField: match.matchedField,
            upDownField: evaluation.upDownField,
          });
          foundSymbols.add(match.symbol);
          missingSymbols.delete(match.symbol);
        }

        for (const tokenId of tokenIds) {
          const primaryMatch = evaluation.symbolMatches[0];
          targets.set(tokenId, {
            tokenId,
            symbol: primaryMatch.symbol,
            market: marketTitle,
          });
        }

        matchedMarkets.add(this.getMarketCacheKey(market));
      }

      return {
        targets: Array.from(targets.values()),
        foundSymbols: Array.from(foundSymbols),
        missingSymbols: Array.from(missingSymbols),
        loadedMarketsCount: markets.length,
        matchedMarketsCount: matchedMarkets.size,
        resolvedTokenIdsCount: targets.size,
      };
    } catch (error: any) {
      console.log(`⚠️  Could not resolve prewarm tokenIds: ${error?.message || 'Unknown error'}`);
      return {
        targets: [],
        foundSymbols: [],
        missingSymbols: [...config.monitoring.prewarmSymbols],
        loadedMarketsCount: 0,
        matchedMarketsCount: 0,
        resolvedTokenIdsCount: 0,
      };
    }
  }

  private async loadActiveOpenMarkets(): Promise<any[]> {
    const now = Date.now();
    if (this.activeMarketsCache && (now - this.activeMarketsCache.timestamp) < this.ACTIVE_MARKETS_CACHE_TTL) {
      return this.activeMarketsCache.markets;
    }

    const markets: any[] = [];
    const pageSize = 200;
    console.log('[Orderbook Prewarm Markets Endpoint]', GAMMA_MARKETS_URL);

    for (let offset = 0; offset < 2000; offset += pageSize) {
      try {
        console.log('[Orderbook Prewarm Markets Fetch]', {
          endpoint: GAMMA_MARKETS_URL,
          pageSize,
          offset,
        });
        const { data } = await axios.get<any[]>(GAMMA_MARKETS_URL, {
          params: {
            active: true,
            closed: false,
            archived: false,
            limit: pageSize,
            offset,
          },
          timeout: 15_000,
        });

        const batch = Array.isArray(data) ? data : [];
        console.log('[Orderbook Prewarm Markets Fetch Result]', {
          endpoint: GAMMA_MARKETS_URL,
          pageSize,
          offset,
          fetchedMarketsCount: batch.length,
        });
        if (batch.length === 0) {
          break;
        }

        markets.push(...batch);
        if (batch.length < pageSize) {
          break;
        }
      } catch (error: any) {
        console.log(`⚠️  Active/open market fetch failed at offset=${offset}: ${error?.message || 'Unknown error'}`);
        console.log('[Orderbook Prewarm Markets Fetch Error]', {
          endpoint: GAMMA_MARKETS_URL,
          pageSize,
          offset,
        });
        break;
      }
    }

    console.log('[Orderbook Prewarm Markets Loaded]', {
      endpoint: GAMMA_MARKETS_URL,
      pageSize,
      totalMarketsCount: markets.length,
    });

    this.activeMarketsCache = {
      markets,
      timestamp: now,
    };

    return markets;
  }

  private getStrictPrewarmSymbols(): string[] {
    const strictSymbols = new Set<string>();
    for (const symbol of config.monitoring.prewarmSymbols) {
      const normalized = this.normalizePrewarmAlias(symbol);
      if (normalized) {
        strictSymbols.add(normalized);
      }
    }
    return Array.from(strictSymbols);
  }

  private normalizePrewarmAlias(symbol: string): string | undefined {
    const normalized = String(symbol || '').trim().toLowerCase();
    if (!normalized) return undefined;

    if (normalized === 'btc' || normalized === 'bitcoin') return 'bitcoin';
    if (normalized === 'eth' || normalized === 'ethereum') return 'ethereum';
    if (normalized === 'sol' || normalized === 'solana') return 'solana';
    if (normalized === 'bnb') return 'bnb';
    if (normalized === 'xrp') return 'xrp';
    if (normalized === 'hyperliquid' || normalized === 'hype') return 'hyperliquid';
    return undefined;
  }

  private getPrewarmSymbolTokens(symbol: string): string[] {
    switch (symbol) {
      case 'bitcoin':
        return ['bitcoin', 'btc'];
      case 'ethereum':
        return ['ethereum', 'eth'];
      case 'solana':
        return ['solana', 'sol'];
      case 'bnb':
        return ['bnb'];
      case 'xrp':
        return ['xrp'];
      case 'hyperliquid':
        return ['hyperliquid', 'hype'];
      default:
        return [symbol];
    }
  }

  private tokenizePrewarmText(value: any): string[] {
    return String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  private matchPrewarmSymbolsForMarket(market: any): PrewarmSymbolMatch[] {
    const matches: PrewarmSymbolMatch[] = [];
    if (config.monitoring.prewarmMatchMode !== 'strict') {
      const haystacks = [
        market?.question,
        market?.title,
        market?.market,
        market?.slug,
        market?.marketSlug,
        market?.market_slug,
        market?.ticker,
      ]
        .filter(Boolean)
        .map((value: any) => String(value).toLowerCase());
      for (const symbol of this.getStrictPrewarmSymbols()) {
        const candidateTokens = this.getPrewarmSymbolTokens(symbol);
        if (candidateTokens.some((token) => haystacks.some((text) => text.includes(token)))) {
          matches.push({ symbol, matchedField: 'title_word' });
        }
      }
      return matches;
    }

    const slugTokens = new Set(this.tokenizePrewarmText(
      market?.slug ||
      market?.marketSlug ||
      market?.market_slug ||
      market?.ticker
    ));
    const titleTokens = new Set(this.tokenizePrewarmText(
      market?.question ||
      market?.title ||
      market?.market
    ));

    for (const symbol of this.getStrictPrewarmSymbols()) {
      const candidateTokens = this.getPrewarmSymbolTokens(symbol);
      if (candidateTokens.some((token) => slugTokens.has(token))) {
        matches.push({ symbol, matchedField: 'slug_token' });
        continue;
      }
      if (candidateTokens.some((token) => titleTokens.has(token))) {
        matches.push({ symbol, matchedField: 'title_word' });
      }
    }

    return matches;
  }

  private isUpDownMarket(title: string, slug: string): boolean {
    const t = String(title || '').toLowerCase();
    const s = String(slug || '').toLowerCase();

    return (
      t.includes('up or down') ||
      s.includes('updown') ||
      s.includes('up-or-down')
    );
  }

  private detectPrewarmUpDownMarket(market: any): {
    isUpDown: boolean;
    field?: 'title_phrase' | 'slug_token' | 'slug_text';
  } {
    const titleText = String(
      market?.question ||
      market?.title ||
      market?.market ||
      ''
    );
    const slugText = String(
      market?.slug ||
      market?.marketSlug ||
      market?.market_slug ||
      market?.ticker ||
      ''
    );

    if (!this.isUpDownMarket(titleText, slugText)) {
      return { isUpDown: false };
    }

    if (titleText.toLowerCase().includes('up or down')) {
      return { isUpDown: true, field: 'title_phrase' };
    }

    const normalizedSlug = slugText.toLowerCase();
    if (normalizedSlug.includes('up-or-down')) {
      return { isUpDown: true, field: 'slug_text' };
    }
    if (normalizedSlug.includes('updown')) {
      return { isUpDown: true, field: 'slug_text' };
    }

    const slugTokens = this.tokenizePrewarmText(slugText);
    if (slugTokens.includes('updown')) {
      return { isUpDown: true, field: 'slug_token' };
    }

    return { isUpDown: false };
  }

  private evaluatePrewarmMarket(market: any): PrewarmMarketEvaluation {
    const symbolMatches = this.matchPrewarmSymbolsForMarket(market);
    const upDown = this.detectPrewarmUpDownMarket(market);
    return {
      symbolMatches,
      isUpDown: upDown.isUpDown,
      upDownField: upDown.field,
    };
  }

  private getMarketCacheKey(market: any): string {
    return String(
      market?.conditionId ||
      market?.condition_id ||
      market?.slug ||
      market?.marketSlug ||
      market?.market_slug ||
      market?.question ||
      market?.title ||
      market?.market ||
      JSON.stringify(market)
    );
  }

  private extractTokenIdsFromMarket(market: any): string[] {
    const tokenIds = new Set<string>();
    const tokens = Array.isArray(market?.tokens) ? market.tokens : [];

    for (const token of tokens) {
      const tokenId = String(token?.token_id || token?.tokenId || token?.asset_id || token?.id || '').trim();
      if (tokenId) {
        tokenIds.add(tokenId);
      }
    }

    for (const fallbackField of [
      market?.clobTokenIds,
      market?.clob_token_ids,
      market?.tokenIds,
      market?.token_ids,
    ]) {
      for (const tokenId of this.parseTokenIdList(fallbackField)) {
        tokenIds.add(tokenId);
      }
    }

    return Array.from(tokenIds);
  }

  private async resolveExecutionCandidateTokenIds(trade: Trade): Promise<string[]> {
    const tokenIds = new Set<string>();
    if (trade.tokenId) {
      tokenIds.add(String(trade.tokenId));
    }

    try {
      const markets = await this.loadActiveOpenMarkets();
      for (const market of markets) {
        const conditionId = String(market?.conditionId || market?.condition_id || '').trim();
        const marketSlug = String(market?.slug || market?.marketSlug || market?.market_slug || '').trim();
        if (
          (trade.conditionId && conditionId === trade.conditionId) ||
          (trade.marketSlug && marketSlug && marketSlug === trade.marketSlug)
        ) {
          for (const tokenId of this.extractTokenIdsFromMarket(market)) {
            tokenIds.add(tokenId);
          }
        }
      }
    } catch (error: any) {
      console.log(`⚠️  Execution candidate token resolution failed: ${error?.message || 'Unknown error'}`);
    }

    return Array.from(tokenIds);
  }

  private parseTokenIdList(value: any): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item).trim()).filter(Boolean);
        }
      } catch {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
      }
    }

    return [];
  }

  async getBestAsk(tokenId: string): Promise<number | null> {
    const orderbook = await this.getOrderbook(tokenId);
    const ask = Number(orderbook?.asks?.[0]?.price);
    return Number.isFinite(ask) ? ask : null;
  }

  roundToTickSize(price: number, tickSize: number): number {
    return Math.round(price / tickSize) * tickSize;
  }

  async getValidatedPriceForDecision(price: number, tokenId: string): Promise<number> {
    return this.validatePrice(price, tokenId);
  }

  async validatePrice(price: number, tokenId: string): Promise<number> {
    const tickSize = await this.getTickSize(tokenId);
    const roundedPrice = this.roundToTickSize(price, tickSize);

    const validPrice = Math.max(0.01, Math.min(0.99, roundedPrice));

    if (Math.abs(validPrice - price) > 0.001) {
      console.log(`   Price adjusted: ${price.toFixed(4)} → ${validPrice.toFixed(4)} (tick size: ${tickSize})`);
    }

    return validPrice;
  }

  private getBestPrice(orderbook: any, side: 'BUY' | 'SELL', fallback: number): number {
    if (side === 'BUY') {
      return Number(orderbook.asks[0]?.price || fallback);
    }
    return Number(orderbook.bids[0]?.price || fallback);
  }

  private applySlippage(price: number, side: 'BUY' | 'SELL', slippage: number): number {
    if (side === 'BUY') {
      return Math.min(price * (1 + slippage), 0.99);
    }
    return Math.max(price * (1 - slippage), 0.01);
  }

  private ensureLiquidity(orderbook: any, side: 'BUY' | 'SELL'): boolean {
    if (side === 'BUY' && orderbook.asks.length === 0) {
      return false;
    }
    if (side === 'SELL' && orderbook.bids.length === 0) {
      return false;
    }
    return true;
  }

  private getTopOfBook(orderbook: any): {
    bestBid: number | null;
    bestAsk: number | null;
    bidsDepth: number;
    asksDepth: number;
  } {
    const bestBidValue = Number(orderbook?.bids?.[0]?.price);
    const bestAskValue = Number(orderbook?.asks?.[0]?.price);
    return {
      bestBid: Number.isFinite(bestBidValue) ? bestBidValue : null,
      bestAsk: Number.isFinite(bestAskValue) ? bestAskValue : null,
      bidsDepth: Array.isArray(orderbook?.bids) ? orderbook.bids.length : 0,
      asksDepth: Array.isArray(orderbook?.asks) ? orderbook.asks.length : 0,
    };
  }

  private getPriceGapBps(referencePrice: number, candidatePrice: number): number {
    if (!Number.isFinite(referencePrice) || referencePrice <= 0 || !Number.isFinite(candidatePrice) || candidatePrice <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.abs(candidatePrice - referencePrice) / referencePrice * 10000;
  }

  private getAvailableAskNotional(orderbook: any, targetNotional: number): number {
    const asks = Array.isArray(orderbook?.asks) ? orderbook.asks : [];
    let availableNotional = 0;
    for (const ask of asks) {
      const price = Number(ask?.price);
      const size = Number(ask?.size);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size <= 0) {
        continue;
      }
      availableNotional += price * size;
      if (availableNotional >= targetNotional) {
        return availableNotional;
      }
    }
    return availableNotional;
  }

  private async buildNoAsksFallbackPlan(
    originalTrade: Trade,
    orderbook: any
  ): Promise<NoAsksFallbackPlan | null> {
    const { bestBid, bestAsk, bidsDepth, asksDepth } = this.getTopOfBook(orderbook);
    const fallbackOrderType = config.trading.noAsksFallbackOrderType === 'FOK' ? 'FOK' : 'FAK';

    const baseLog = {
      fallbackUsed: false,
      bestBid,
      bestAsk,
      fallbackPrice: null as number | null,
      finalOrderType: fallbackOrderType,
    };

    if (!config.trading.enableNoAsksFallback || originalTrade.side !== 'BUY') {
      console.log('[NoAsks Fallback]', baseLog);
      return null;
    }

    if (asksDepth > 0 && bestAsk != null) {
      console.log('[NoAsks Fallback]', baseLog);
      return null;
    }

    if (bidsDepth <= 0 || bestBid == null) {
      console.log('[Fallback Execution]', {
        tokenId: originalTrade.tokenId,
        market: originalTrade.market,
        bestBid,
        bestAsk,
        fallbackPrice: null,
        orderType: fallbackOrderType,
        sourcePrice: originalTrade.price,
        maxGapBps: config.trading.maxFallbackPriceGapBps,
        gapBps: null,
        skipReason: 'no_liquidity_both_sides',
      });
      console.log('[NoAsks Fallback]', {
        ...baseLog,
        skipReason: 'no_liquidity_both_sides',
      });
      throw new Error('SKIP:no_liquidity_both_sides');
    }

    const rawFallbackPrice = 1 - bestBid;
    if (!Number.isFinite(rawFallbackPrice) || rawFallbackPrice <= 0) {
      console.log('[Fallback Execution]', {
        tokenId: originalTrade.tokenId,
        market: originalTrade.market,
        bestBid,
        bestAsk,
        fallbackPrice: rawFallbackPrice,
        orderType: fallbackOrderType,
        sourcePrice: originalTrade.price,
        maxGapBps: config.trading.maxFallbackPriceGapBps,
        gapBps: null,
        skipReason: 'invalid_fallback_price',
      });
      console.log('[NoAsks Fallback]', {
        ...baseLog,
        fallbackPrice: rawFallbackPrice,
        skipReason: 'invalid_fallback_price',
      });
      throw new Error('SKIP:invalid_fallback_price');
    }

    if (bestBid <= 0.001) {
      console.log('[NoAsks Fallback Extreme Bid]', {
        bestBid,
        rawFallbackPrice,
        market: originalTrade.market,
        tokenId: originalTrade.tokenId,
      });
    }

    const slippageAdjusted = this.applySlippage(rawFallbackPrice, 'BUY', config.trading.slippageTolerance);
    const fallbackPrice = await this.validatePrice(slippageAdjusted, originalTrade.tokenId);

    if (!Number.isFinite(fallbackPrice) || fallbackPrice <= 0.01 || fallbackPrice >= 0.99) {
      console.log('[Fallback Execution]', {
        tokenId: originalTrade.tokenId,
        market: originalTrade.market,
        bestBid,
        bestAsk,
        fallbackPrice,
        orderType: fallbackOrderType,
        sourcePrice: originalTrade.price,
        maxGapBps: config.trading.maxFallbackPriceGapBps,
        gapBps: null,
        skipReason: 'fallback_price_out_of_range',
      });
      console.log('[NoAsks Fallback]', {
        ...baseLog,
        fallbackPrice,
        skipReason: 'fallback_price_out_of_range',
      });
      throw new Error('SKIP:fallback_price_out_of_range');
    }

    const fallbackGapBps = this.getPriceGapBps(originalTrade.price, fallbackPrice);
    if (fallbackGapBps > config.trading.maxFallbackPriceGapBps) {
      console.log('[Fallback Execution]', {
        tokenId: originalTrade.tokenId,
        market: originalTrade.market,
        bestBid,
        bestAsk,
        fallbackPrice,
        orderType: fallbackOrderType,
        sourcePrice: originalTrade.price,
        maxGapBps: config.trading.maxFallbackPriceGapBps,
        gapBps: fallbackGapBps,
        skipReason: 'fallback_price_gap_too_wide',
      });
      console.log('[NoAsks Fallback]', {
        ...baseLog,
        fallbackPrice,
        fallbackGapBps,
        skipReason: 'fallback_price_gap_too_wide',
      });
      throw new Error('SKIP:fallback_price_gap_too_wide');
    }

    const entryGapBps = this.getPriceGapBps(originalTrade.price, fallbackPrice);
    if (entryGapBps > config.trading.maxEntryPriceGapBps) {
      console.log('[Fallback Execution]', {
        tokenId: originalTrade.tokenId,
        market: originalTrade.market,
        bestBid,
        bestAsk,
        fallbackPrice,
        orderType: fallbackOrderType,
        sourcePrice: originalTrade.price,
        maxGapBps: config.trading.maxFallbackPriceGapBps,
        gapBps: entryGapBps,
        skipReason: 'fallback_price_gap_too_wide',
      });
      console.log('[NoAsks Fallback]', {
        ...baseLog,
        fallbackPrice,
        entryGapBps,
        skipReason: 'fallback_price_gap_too_wide',
      });
      throw new Error('SKIP:fallback_price_gap_too_wide');
    }

    const plan: NoAsksFallbackPlan = {
      fallbackUsed: true,
      fallbackPrice,
      finalOrderType: fallbackOrderType,
      bestBid,
      bestAsk,
    };

    console.log('[NoAsks Fallback]', plan);
    return plan;
  }

  private isUnreplicableNoAskMarket(orderbook: any, sourcePrice: number): UnreplicableNoAskMarketResult {
    const asksDepth = Array.isArray(orderbook?.asks) ? orderbook.asks.length : 0;
    const bestBidValue = Number(orderbook?.bids?.[0]?.price);
    const bestBid = Number.isFinite(bestBidValue) ? bestBidValue : null;

    return {
      unreplicable: asksDepth === 0 && bestBid != null && bestBid <= 0.05 && sourcePrice >= 0.95,
      bestBid,
      asksDepth,
    };
  }

  private async tryNoAsksBuyFallback(
    originalTrade: Trade,
    copyNotional: number,
    orderbook: any,
    orderOpts: any,
    feeRateBps: number
  ): Promise<CopyExecutionResult | null> {
    const plan = await this.buildNoAsksFallbackPlan(originalTrade, orderbook);
    if (!plan?.fallbackUsed) {
      return null;
    }

    const copyShares = this.calculateSharesFromNotional(copyNotional, plan.fallbackPrice);
    const gapBps = this.getPriceGapBps(originalTrade.price, plan.fallbackPrice);
    console.log('[Fallback Execution]', {
      tokenId: originalTrade.tokenId,
      market: originalTrade.market,
      bestBid: plan.bestBid,
      bestAsk: plan.bestAsk,
      fallbackPrice: plan.fallbackPrice,
      orderType: plan.finalOrderType,
      sourcePrice: originalTrade.price,
      maxGapBps: config.trading.maxFallbackPriceGapBps,
      gapBps,
    });
    console.log(`   fallbackUsed: ${plan.fallbackUsed}`);
    console.log(`   bestBid: ${plan.bestBid}`);
    console.log(`   bestAsk: ${plan.bestAsk ?? 'N/A'}`);
    console.log(`   fallbackPrice: ${plan.fallbackPrice.toFixed(4)}`);
    console.log(`   finalOrderType: ${plan.finalOrderType}`);
    console.log(`   Copy shares: ${copyShares}`);
    console.log(`   feeRateBps: ${feeRateBps}`);

    const orderTypeEnum = plan.finalOrderType === 'FOK' ? OrderType.FOK : OrderType.FAK;
    const response = await this.clobClient.createAndPostMarketOrder(
      {
        tokenID: originalTrade.tokenId,
        amount: copyNotional,
        price: plan.fallbackPrice,
        side: originalTrade.side as Side,
        feeRateBps,
        orderType: orderTypeEnum,
      },
      orderOpts,
      orderTypeEnum
    );

    if (!response.success) {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      console.log(`❌ No-asks fallback order failed: ${errorMsg}`);
      throw new Error(`Order placement failed: ${errorMsg}`);
    }

    console.log(`✅ ${plan.finalOrderType} fallback order executed: ${response.orderID}`);
    if (response.status === 'LIVE') {
      console.log('   ⚠️  Fallback order posted to book (no immediate match)');
    }

    return {
      orderId: response.orderID,
      copyNotional,
      copyShares,
      price: plan.fallbackPrice,
      side: originalTrade.side,
      tokenId: originalTrade.tokenId,
    };
  }

  async executeCopyTrade(
    originalTrade: Trade,
    copyNotionalOverride?: number
  ): Promise<CopyExecutionResult> {
    const copyNotional = copyNotionalOverride ?? this.calculateCopySize(originalTrade.size);

    console.log(`📈 Executing signal-triggered trade:`);
    console.log(`   Market: ${originalTrade.market}`);
    console.log(`   Side: ${originalTrade.side}`);
    console.log(`   Original size: ${originalTrade.size} USDC`);
    console.log(`   Token ID: ${originalTrade.tokenId}`);
    console.log(`   Copy notional: ${copyNotional} USDC`);

    let lastFailureReason = 'execution_failed';
    for (const attempt of [
      { attempt: 1, orderType: 'FOK' as const },
      { attempt: 2, orderType: 'FAK' as const },
    ]) {
      const refreshedBook = await this.refreshExecutionBook(originalTrade);
      if (refreshedBook.bestAsk == null || refreshedBook.asksDepth === 0) {
        console.log('[Execution Skip]', {
          market: originalTrade.market,
          tokenId: originalTrade.tokenId,
          reason: 'no_ask_on_source_side',
        });
        throw new Error('no_ask_on_source_side');
      }

      const availableAskNotional = this.getAvailableAskNotional(refreshedBook.orderbook, copyNotional);
      console.log('[Execution Depth Check]', {
        copyNotional,
        availableAskNotional,
      });
      if (availableAskNotional < copyNotional) {
        console.log('[Execution Depth Check Skip]', {
          reason: 'insufficient_source_ask_depth',
          copyNotional,
          availableAskNotional,
        });
        throw new Error('insufficient_source_ask_depth');
      }

      const priceDriftBps = this.getPriceGapBps(Number(originalTrade.price), refreshedBook.bestAsk);
      if (priceDriftBps > config.trading.mvpMaxPriceDriftBps) {
        console.log('[Execution Skip]', {
          market: originalTrade.market,
          tokenId: originalTrade.tokenId,
          reason: 'execution_price_moved_too_far',
          sourcePrice: originalTrade.price,
          latestBestAsk: refreshedBook.bestAsk,
          priceDriftBps,
        });
        throw new Error('execution_price_moved_too_far');
      }

      const validatedPrice = await this.validatePrice(refreshedBook.bestAsk, originalTrade.tokenId);
      const derivedShares = this.calculateSharesFromNotional(copyNotional, validatedPrice);
      console.log('[Execution Path]', {
        mode: 'TAKER',
        sourceSide: originalTrade.outcome,
        executionSide: originalTrade.outcome,
        tokenId: originalTrade.tokenId,
        bestAsk: refreshedBook.bestAsk,
        sourcePrice: originalTrade.price,
        mustMatchSourceSide: true,
      });
      console.log('[Execution Plan]', {
        sourceSide: originalTrade.outcome,
        sourceTokenId: originalTrade.tokenId,
        executionTokenId: originalTrade.tokenId,
        sourcePrice: originalTrade.price,
        latestBestAsk: refreshedBook.bestAsk,
        chosenPrice: validatedPrice,
        priceDriftBps,
        copyNotional,
        derivedShares,
        orderType: attempt.orderType,
      });

      try {
        return await this.executeMvpTakerAttempt(
          originalTrade,
          copyNotional,
          validatedPrice,
          derivedShares,
          refreshedBook.bestBid,
          refreshedBook.bestAsk,
          attempt.orderType,
          attempt.attempt
        );
      } catch (error: any) {
        lastFailureReason = error?.message || lastFailureReason;
        console.log('[Execution Failure]', {
          attempt: attempt.attempt,
          orderType: attempt.orderType,
          reason: lastFailureReason,
        });
      }
    }

    throw new Error(lastFailureReason);
  }

  private async refreshExecutionBook(originalTrade: Trade): Promise<{
    orderbook: any;
    bestBid: number | null;
    bestAsk: number | null;
    bidsDepth: number;
    asksDepth: number;
  }> {
    let orderbook: any;
    try {
      const fetched = await this.clobClient.getOrderBook(originalTrade.tokenId);
      const normalized = this.setOrderbookCache(originalTrade.tokenId, fetched, 'execution_fetch');
      orderbook = { bids: normalized.bids, asks: normalized.asks };
    } catch (error: any) {
      if (this.isOrderbookNotFoundError(error)) {
        console.log('[Execution Skip]', {
          market: originalTrade.market,
          tokenId: originalTrade.tokenId,
          reason: 'no_orderbook_on_source_side',
        });
        throw new Error('no_orderbook_on_source_side');
      }
      throw error;
    }
    const { bestBid, bestAsk, bidsDepth, asksDepth } = this.getTopOfBook(orderbook);
    console.log('[Execution Book Refresh]', {
      tokenId: originalTrade.tokenId,
      sourceSide: originalTrade.outcome,
      sourcePrice: originalTrade.price,
      bestBid,
      bestAsk,
      bidsDepth,
      asksDepth,
    });
    return {
      orderbook,
      bestBid,
      bestAsk,
      bidsDepth,
      asksDepth,
    };
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    attempt: number = 1
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: any) {
      const isRetryable = this.isRetryableError(error);

      if (!isRetryable || attempt >= this.RETRY_CONFIG.maxAttempts) {
        console.error(`❌ Failed after ${attempt} attempt(s): ${error.message}`);
        if (error?.response?.data) {
          console.error('   Response data:', error.response.data);
        }
        throw error;
      }

      const delay = Math.min(
        this.RETRY_CONFIG.initialDelay * Math.pow(this.RETRY_CONFIG.backoffMultiplier, attempt - 1),
        this.RETRY_CONFIG.maxDelay
      );

      console.log(`⚠️  Attempt ${attempt} failed: ${error.message}`);
      if (error?.response?.data) {
        console.log('   Response data:', error.response.data);
      }
      console.log(`   Retrying in ${delay}ms... (${attempt + 1}/${this.RETRY_CONFIG.maxAttempts})`);

      await this.sleep(delay);
      return this.executeWithRetry(fn, attempt + 1);
    }
  }

  private isRetryableError(error: any): boolean {
    const errorMsg = error?.message || '';

    if (errorMsg.startsWith('SKIP:')) {
      return false;
    }

    const lowerMsg = errorMsg.toLowerCase();
    const responseData = error?.response?.data?.error?.toLowerCase() || '';
    const responseStatus = error?.response?.status;

    if (responseStatus === 401 || errorMsg.includes('unauthorized') || responseData.includes('unauthorized')) {
      console.log('   ⚠️  Unauthorized/Invalid API key - skipping trade');
      return false;
    }
    if (responseStatus === 403 || errorMsg.includes('cloudflare') || responseData.includes('cloudflare') || responseData.includes('blocked')) {
      console.log('   ⚠️  Access blocked (Cloudflare/geo restriction) - skipping trade');
      return false;
    }

    if (errorMsg.includes('network') || errorMsg.includes('timeout') || errorMsg.includes('econnreset')) {
      return true;
    }

    if (errorMsg.includes('rate limit') || responseData.includes('rate limit')) {
      return true;
    }

    if (errorMsg.includes('502') || errorMsg.includes('503') || errorMsg.includes('504')) {
      return true;
    }

    if (
      errorMsg.includes('insufficient') ||
      responseData.includes('insufficient') ||
      errorMsg.includes('not enough balance') ||
      responseData.includes('not enough balance') ||
      errorMsg.includes('allowance') ||
      responseData.includes('allowance')
    ) {
      console.log('   ⚠️  Not enough balance/allowance - skipping trade');
      return false;
    }

    if (
      errorMsg.includes('invalid') ||
      responseData.includes('invalid') ||
      responseData.includes('bad request')
    ) {
      console.log('   ⚠️  Invalid order parameters - skipping trade');
      return false;
    }

    if (errorMsg.includes('duplicate') || responseData.includes('duplicate')) {
      console.log('   ⚠️  Duplicate order - skipping');
      return false;
    }

    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private logMakerFallbackEvent(
    trade: Trade,
    params: {
      action: 'maker_fallback_placed' | 'maker_fallback_filled' | 'maker_fallback_cancelled';
      reason: string;
      orderId?: string;
      fillPrice?: number;
      fillSize?: number;
      copyNotional?: number;
    }
  ): void {
    logTrade({
      ts: Date.now(),
      market: trade.market,
      marketSlug: trade.marketSlug,
      tokenId: trade.tokenId,
      side: trade.side,
      sourcePrice: trade.price,
      sourceSizeUsd: trade.size,
      sourceAgeMs: trade.timestamp ? Math.max(0, Date.now() - trade.timestamp) : undefined,
      action: params.action,
      reason: params.reason,
      orderId: params.orderId,
      fillPrice: params.fillPrice,
      fillSize: params.fillSize,
      copyNotional: params.copyNotional,
    });
  }

  private logSignalMakerEntryEvent(
    trade: Trade,
    params: {
      action:
        | 'signal_maker_entry_submitted'
        | 'signal_maker_entry_filled'
        | 'signal_maker_entry_partially_filled'
        | 'signal_maker_entry_cancelled'
        | 'signal_maker_entry_failed';
      reason: string;
      orderId?: string;
      fillPrice?: number;
      fillSize?: number;
      copyNotional?: number;
    }
  ): void {
    logTrade({
      ts: Date.now(),
      market: trade.market,
      marketSlug: trade.marketSlug,
      tokenId: trade.tokenId,
      side: trade.side,
      sourcePrice: trade.price,
      sourceSizeUsd: trade.size,
      sourceAgeMs: trade.timestamp ? Math.max(0, Date.now() - trade.timestamp) : undefined,
      action: params.action,
      reason: params.reason,
      orderId: params.orderId,
      fillPrice: params.fillPrice,
      fillSize: params.fillSize,
      copyNotional: params.copyNotional,
    });
  }

  private async executeMvpTakerAttempt(
    originalTrade: Trade,
    copyNotional: number,
    executionPrice: number,
    copyShares: number,
    bestBid: number | null,
    bestAsk: number | null,
    orderType: 'FOK' | 'FAK',
    attempt: number
  ): Promise<CopyExecutionResult> {
    await this.validateBalance(copyNotional, originalTrade.tokenId);

    const orderOpts = await this.getOrderOptions(originalTrade.tokenId);
    const feeRateBps = await this.getFeeRateBps(originalTrade.tokenId);
    console.log('[Order Params Build]', {
      market: originalTrade.market,
      executionSide: originalTrade.outcome,
      executionTokenId: originalTrade.tokenId,
      sourcePrice: originalTrade.price,
      chosenBestAsk: bestAsk,
      copyNotional,
      derivedPrice: executionPrice,
      derivedShares: copyShares,
      orderType,
    });

    console.log('[Execution Attempt]', {
      attempt,
      orderType,
      tokenId: originalTrade.tokenId,
      market: originalTrade.market,
      sourcePrice: originalTrade.price,
      executionPrice: executionPrice,
      copyNotional,
    });

    const orderTypeEnum = orderType === 'FOK' ? OrderType.FOK : OrderType.FAK;
    const response = await this.clobClient.createAndPostMarketOrder(
      {
        tokenID: originalTrade.tokenId,
        amount: originalTrade.side === 'BUY' ? copyNotional : copyShares,
        price: executionPrice,
        side: originalTrade.side as Side,
        feeRateBps,
        orderType: orderTypeEnum,
      },
      orderOpts,
      orderTypeEnum
    );

    if (!response.success) {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      throw new Error(`${orderType}_failed:${errorMsg}`);
    }

    console.log('[Execution Success]', {
      tokenId: originalTrade.tokenId,
      side: originalTrade.outcome,
      price: executionPrice,
      shares: copyShares,
      notional: copyNotional,
    });
    return {
      orderId: response.orderID,
      copyNotional,
      copyShares,
      price: executionPrice,
      side: originalTrade.side,
      tokenId: originalTrade.tokenId,
    };
  }

  private async executeSignalMakerOrder(
    originalTrade: Trade,
    copyNotional: number,
    bestBid: number,
    bestAsk: number,
    slippage: number | null
  ): Promise<CopyExecutionResult> {
    await this.validateBalance(copyNotional, originalTrade.tokenId);

    const rawMakerPrice = Math.min(
      Number(originalTrade.price) - 0.001,
      bestBid + 0.001
    );
    const validatedPrice = await this.validatePrice(rawMakerPrice, originalTrade.tokenId);
    if (validatedPrice <= bestBid) {
      throw new Error('maker_price_not_improving');
    }

    const copyShares = this.calculateSharesFromNotional(copyNotional, validatedPrice);
    const orderOpts = await this.getOrderOptions(originalTrade.tokenId);
    const feeRateBps = await this.getFeeRateBps(originalTrade.tokenId);

    console.log('[Execution Plan]', {
      mode: 'MAKER',
      sourcePrice: originalTrade.price,
      bestBid,
      bestAsk,
      chosenPrice: validatedPrice,
      slippage,
      tokenId: originalTrade.tokenId,
      side: 'BUY',
    });

    console.log('[Order Params Build]', {
      market: originalTrade.market,
      executionSide: originalTrade.outcome,
      executionTokenId: originalTrade.tokenId,
      sourcePrice: originalTrade.price,
      chosenBestAsk: bestAsk,
      copyNotional,
      derivedPrice: validatedPrice,
      derivedShares: copyShares,
      orderType: 'GTC',
    });

    const response = await this.clobClient.createAndPostOrder(
      {
        tokenID: originalTrade.tokenId,
        price: validatedPrice,
        size: copyShares,
        side: originalTrade.side as Side,
        feeRateBps,
      },
      orderOpts,
      OrderType.GTC,
      false,
      true
    );

    if (!response.success) {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      throw new Error(`maker_submit_failed:${errorMsg}`);
    }

    const orderId = response.orderID;
    const deadline = Date.now() + 3000;
    let lastMatched = 0;
    let resolvedPrice = validatedPrice;

    while (Date.now() < deadline) {
      await this.sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
      try {
        const order = await this.clobClient.getOrder(orderId);
        const matched = parseFloat(order?.size_matched || '0');
        const price = parseFloat(order?.price || validatedPrice.toString());
        lastMatched = Number.isFinite(matched) ? matched : lastMatched;
        resolvedPrice = Number.isFinite(price) ? price : resolvedPrice;
        if (lastMatched > 0) {
          return {
            orderId,
            copyNotional: lastMatched * resolvedPrice,
            copyShares: lastMatched,
            price: resolvedPrice,
            side: originalTrade.side,
            tokenId: originalTrade.tokenId,
          };
        }
      } catch (error: any) {
        console.log(`   Maker execution poll failed: ${error?.message || 'Unknown error'}`);
      }
    }

    try {
      await this.clobClient.cancelOrder({ orderID: orderId });
    } catch (error: any) {
      console.log(`   Maker execution cancel failed: ${error?.message || 'Unknown error'}`);
    }

    throw new Error('maker_timeout_cancelled');
  }

  async executeSignalMakerEntry(
    originalTrade: Trade,
    params: {
      candidatePrice: number;
      candidateNotional: number;
      reason: string;
    }
  ): Promise<SignalMakerExecutionResult> {
    const validatedPrice = await this.validatePrice(params.candidatePrice, originalTrade.tokenId);
    const copyShares = this.calculateSharesFromNotional(params.candidateNotional, validatedPrice);
    const orderOpts = await this.getOrderOptions(originalTrade.tokenId);
    const feeRateBps = await this.getFeeRateBps(originalTrade.tokenId);

    console.log('[Signal Maker Entry Submitted]', {
      tokenId: originalTrade.tokenId,
      market: originalTrade.market,
      side: originalTrade.side,
      candidatePrice: validatedPrice,
      candidateNotional: params.candidateNotional,
      candidateSizeUsd: params.candidateNotional,
      reason: params.reason,
    });

    let response: any;
    try {
      response = await this.clobClient.createAndPostOrder(
        {
          tokenID: originalTrade.tokenId,
          price: validatedPrice,
          size: copyShares,
          side: originalTrade.side as Side,
          feeRateBps,
        },
        orderOpts,
        OrderType.GTC,
        false,
        true
      );
    } catch (error: any) {
      console.log('[Signal Maker Entry Failed]', {
        tokenId: originalTrade.tokenId,
        market: originalTrade.market,
        side: originalTrade.side,
        candidatePrice: validatedPrice,
        candidateNotional: params.candidateNotional,
        reason: error?.message || 'Unknown error',
      });
      this.logSignalMakerEntryEvent(originalTrade, {
        action: 'signal_maker_entry_failed',
        reason: error?.message || 'signal_maker_submit_failed',
        fillPrice: validatedPrice,
        fillSize: copyShares,
        copyNotional: params.candidateNotional,
      });
      throw error;
    }

    if (!response.success) {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      console.log('[Signal Maker Entry Failed]', {
        tokenId: originalTrade.tokenId,
        market: originalTrade.market,
        side: originalTrade.side,
        candidatePrice: validatedPrice,
        candidateNotional: params.candidateNotional,
        reason: errorMsg,
      });
      this.logSignalMakerEntryEvent(originalTrade, {
        action: 'signal_maker_entry_failed',
        reason: errorMsg,
        fillPrice: validatedPrice,
        fillSize: copyShares,
        copyNotional: params.candidateNotional,
      });
      throw new Error(`Order placement failed: ${errorMsg}`);
    }

    const orderId = response.orderID;
    this.logSignalMakerEntryEvent(originalTrade, {
      action: 'signal_maker_entry_submitted',
      reason: params.reason,
      orderId,
      fillPrice: validatedPrice,
      fillSize: copyShares,
      copyNotional: params.candidateNotional,
    });

    const deadline = Date.now() + Math.max(1000, config.trading.signalMakerTtlMs);
    let lastMatched = 0;
    let lastOrderStatus = '';
    let resolvedPrice = validatedPrice;

    while (Date.now() < deadline) {
      await this.sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
      try {
        const order = await this.clobClient.getOrder(orderId);
        const matched = parseFloat(order?.size_matched || '0');
        const originalSize = parseFloat(order?.original_size || copyShares.toString());
        const status = String(order?.status || '').toUpperCase();
        const price = parseFloat(order?.price || validatedPrice.toString());

        lastMatched = Number.isFinite(matched) ? matched : lastMatched;
        lastOrderStatus = status;
        resolvedPrice = Number.isFinite(price) ? price : resolvedPrice;

        if (lastMatched > 0 && (lastMatched >= originalSize - 0.0001 || ['FILLED', 'MATCHED', 'COMPLETED'].includes(status))) {
          const filledNotional = lastMatched * resolvedPrice;
          console.log('[Signal Maker Entry Filled]', {
            tokenId: originalTrade.tokenId,
            market: originalTrade.market,
            side: originalTrade.side,
            candidatePrice: validatedPrice,
            candidateNotional: params.candidateNotional,
            orderId,
            finalStatus: status || 'FILLED',
            filledSize: lastMatched,
            filledNotional,
            cancelled: false,
            reason: 'signal_maker_filled',
          });
          this.logSignalMakerEntryEvent(originalTrade, {
            action: 'signal_maker_entry_filled',
            reason: 'signal_maker_filled',
            orderId,
            fillPrice: resolvedPrice,
            fillSize: lastMatched,
            copyNotional: filledNotional,
          });
          return {
            orderId,
            copyNotional: filledNotional,
            copyShares: lastMatched,
            price: resolvedPrice,
            side: originalTrade.side,
            tokenId: originalTrade.tokenId,
            candidatePrice: validatedPrice,
            candidateNotional: params.candidateNotional,
            finalStatus: 'FILLED',
            filledSize: lastMatched,
            filledNotional,
            cancelled: false,
            reason: 'signal_maker_filled',
          };
        }
      } catch (error: any) {
        console.log(`   Signal maker entry poll failed: ${error?.message || 'Unknown error'}`);
      }
    }

    try {
      await this.clobClient.cancelOrder({ orderID: orderId });
    } catch (error: any) {
      console.log(`   Signal maker entry cancel failed: ${error?.message || 'Unknown error'}`);
    }

    if (lastMatched > 0) {
      const filledNotional = lastMatched * resolvedPrice;
      console.log('[Signal Maker Entry Partially Filled]', {
        tokenId: originalTrade.tokenId,
        market: originalTrade.market,
        side: originalTrade.side,
        candidatePrice: validatedPrice,
        candidateNotional: params.candidateNotional,
        orderId,
        finalStatus: lastOrderStatus || 'PARTIALLY_FILLED',
        filledSize: lastMatched,
        filledNotional,
        cancelled: true,
        reason: 'signal_maker_partial_fill_cancelled',
      });
      this.logSignalMakerEntryEvent(originalTrade, {
        action: 'signal_maker_entry_partially_filled',
        reason: 'signal_maker_partial_fill_cancelled',
        orderId,
        fillPrice: resolvedPrice,
        fillSize: lastMatched,
        copyNotional: filledNotional,
      });
      return {
        orderId,
        copyNotional: filledNotional,
        copyShares: lastMatched,
        price: resolvedPrice,
        side: originalTrade.side,
        tokenId: originalTrade.tokenId,
        candidatePrice: validatedPrice,
        candidateNotional: params.candidateNotional,
        finalStatus: 'PARTIALLY_FILLED',
        filledSize: lastMatched,
        filledNotional,
        cancelled: true,
        reason: 'signal_maker_partial_fill_cancelled',
      };
    }

    console.log('[Signal Maker Entry Cancelled]', {
      tokenId: originalTrade.tokenId,
      market: originalTrade.market,
      side: originalTrade.side,
      candidatePrice: validatedPrice,
      candidateNotional: params.candidateNotional,
      orderId,
      finalStatus: lastOrderStatus || 'CANCELLED',
      filledSize: 0,
      filledNotional: 0,
      cancelled: true,
      reason: 'signal_maker_timeout_cancelled',
    });
    this.logSignalMakerEntryEvent(originalTrade, {
      action: 'signal_maker_entry_cancelled',
      reason: 'signal_maker_timeout_cancelled',
      orderId,
      fillPrice: resolvedPrice,
      copyNotional: params.candidateNotional,
    });
    return {
      orderId,
      copyNotional: 0,
      copyShares: 0,
      price: resolvedPrice,
      side: originalTrade.side,
      tokenId: originalTrade.tokenId,
      candidatePrice: validatedPrice,
      candidateNotional: params.candidateNotional,
      finalStatus: 'CANCELLED',
      filledSize: 0,
      filledNotional: 0,
      cancelled: true,
      reason: 'signal_maker_timeout_cancelled',
    };
  }

  private async tryMakerFallback(
    originalTrade: Trade,
    copyNotional: number,
    orderbook: any
  ): Promise<CopyExecutionResult | null> {
    if (originalTrade.side !== 'BUY') {
      return null;
    }

    const bestBid = Number(orderbook?.bids?.[0]?.price || 0);
    const bestAsk = Number(orderbook?.asks?.[0]?.price || 0);
    const spread = bestAsk > 0 ? bestAsk - bestBid : 0;
    const bidsDepth = orderbook?.bids?.length || 0;
    const asksDepth = orderbook?.asks?.length || 0;

    console.log('[MakerFallback Market Snapshot]', {
      bestBid,
      bestAsk,
      spread,
      bidsDepth,
      asksDepth
    });

    console.log('⚠️  Trying maker fallback');

    if (!Number.isFinite(bestBid) || bestBid <= 0) {
      console.log('   No best bid available; skipping maker fallback');
      return null;
    }

    console.log(`   Best bid: ${bestBid.toFixed(4)}`);

    const rawPrice = bestBid + 0.01;
    const cappedPrice = Math.min(rawPrice, 0.995);
    const validatedPrice = await this.validatePrice(cappedPrice, originalTrade.tokenId);
    const copyShares = this.calculateSharesFromNotional(copyNotional, validatedPrice);
    const orderOpts = await this.getOrderOptions(originalTrade.tokenId);
    const feeRateBps = await this.getFeeRateBps(originalTrade.tokenId);

    console.log(`   Maker fallback price: ${validatedPrice.toFixed(4)}`);
    console.log(`   Maker fallback shares: ${copyShares.toFixed(4)}`);
    console.log(`   feeRateBps: ${feeRateBps}`);

    const response = await this.clobClient.createAndPostOrder(
      {
        tokenID: originalTrade.tokenId,
        price: validatedPrice,
        size: copyShares,
        side: originalTrade.side as Side,
        feeRateBps,
      },
      orderOpts,
      OrderType.GTC,
      false,
      true
    );

    if (!response.success) {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      console.log(`❌ Maker fallback order failed: ${errorMsg}`);
      throw new Error(`Order placement failed: ${errorMsg}`);
    }

    const orderId = response.orderID;
    console.log(`   Maker fallback order placed: ${orderId}`);
    this.logMakerFallbackEvent(originalTrade, {
      action: 'maker_fallback_placed',
      reason: 'signal_trigger_maker_fallback',
      orderId,
      fillPrice: validatedPrice,
      fillSize: copyShares,
      copyNotional,
    });

    const deadline = Date.now() + 3000;
    let lastMatched = 0;
    let lastOrderStatus = '';
    let resolvedPrice = validatedPrice;

    while (Date.now() < deadline) {
      await this.sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
      try {
        const order = await this.clobClient.getOrder(orderId);
        const matched = parseFloat(order?.size_matched || '0');
        const originalSize = parseFloat(order?.original_size || copyShares.toString());
        const status = String(order?.status || '').toUpperCase();
        const price = parseFloat(order?.price || validatedPrice.toString());

        lastMatched = Number.isFinite(matched) ? matched : lastMatched;
        lastOrderStatus = status;
        resolvedPrice = Number.isFinite(price) ? price : resolvedPrice;

        if (lastMatched > 0 && (lastMatched >= originalSize - 0.0001 || ['FILLED', 'MATCHED', 'COMPLETED'].includes(status))) {
          const filledNotional = lastMatched * resolvedPrice;
          console.log('   Maker fallback filled');
          this.logMakerFallbackEvent(originalTrade, {
            action: 'maker_fallback_filled',
            reason: 'maker_fallback_filled',
            orderId,
            fillPrice: resolvedPrice,
            fillSize: lastMatched,
            copyNotional: filledNotional,
          });
          return {
            orderId,
            copyNotional: filledNotional,
            copyShares: lastMatched,
            price: resolvedPrice,
            side: originalTrade.side,
            tokenId: originalTrade.tokenId,
          };
        }
      } catch (error: any) {
        console.log(`   Maker fallback poll failed: ${error?.message || 'Unknown error'}`);
      }
    }

    console.log('   Maker fallback timeout, cancelling order');
    try {
      await this.clobClient.cancelOrder({ orderID: orderId });
      console.log('   Maker fallback cancelled');
    } catch (error: any) {
      console.log(`   Maker fallback cancel failed: ${error?.message || 'Unknown error'}`);
    }

    this.logMakerFallbackEvent(originalTrade, {
      action: 'maker_fallback_cancelled',
      reason: lastMatched > 0 ? 'maker_fallback_timeout_partial_cancelled' : 'maker_fallback_timeout_cancelled',
      orderId,
      fillPrice: resolvedPrice,
      fillSize: lastMatched > 0 ? lastMatched : undefined,
      copyNotional: lastMatched > 0 ? lastMatched * resolvedPrice : undefined,
    });

    if (lastMatched > 0) {
      const filledNotional = lastMatched * resolvedPrice;
      console.log(`   Maker fallback partial fill retained: ${lastMatched.toFixed(4)} @ ${resolvedPrice.toFixed(4)}`);
      this.logMakerFallbackEvent(originalTrade, {
        action: 'maker_fallback_filled',
        reason: 'maker_fallback_partial_fill',
        orderId,
        fillPrice: resolvedPrice,
        fillSize: lastMatched,
        copyNotional: filledNotional,
      });
      return {
        orderId,
        copyNotional: filledNotional,
        copyShares: lastMatched,
        price: resolvedPrice,
        side: originalTrade.side,
        tokenId: originalTrade.tokenId,
      };
    }

    throw new Error('maker_fallback_timeout_cancelled');
  }

  private async executeLimitOrder(originalTrade: Trade, copyNotional: number): Promise<CopyExecutionResult> {
    await this.validateBalance(copyNotional, originalTrade.tokenId);

    let orderbook;
    try {
      orderbook = await this.getOrderbookForExecution(originalTrade.tokenId);
    } catch (error: any) {
      if (error?.response?.status === 404 && error?.response?.data?.error?.includes('No orderbook exists for the requested token id')) {
        throw new Error(`SKIP:no_orderbook_exists`);
      }
      throw error;
    }
    orderbook = orderbook || { bids: [], asks: [] };

    const orderOpts = await this.getOrderOptions(originalTrade.tokenId);
    const feeRateBps = await this.getFeeRateBps(originalTrade.tokenId);

    console.log(`[DEBUG] Execution details:`);
    console.log(`   tokenId: ${originalTrade.tokenId}`);
    console.log(`   market: ${originalTrade.market}`);
    console.log(`   source side: ${originalTrade.side}`);
    console.log(`   source outcome: ${originalTrade.outcome} (${originalTrade.outcomeName || 'no name'})`);
    const canonicalOutcome = await this.getOutcomeLabel(originalTrade.tokenId);
    console.log(`   canonical outcome: ${canonicalOutcome}`);
    console.log(`   orderbook bids.length: ${orderbook.bids?.length || 0}`);
    console.log(`   orderbook asks.length: ${orderbook.asks?.length || 0}`);
    console.log(`   best bid: ${orderbook.bids?.[0]?.price || 'N/A'}`);
    console.log(`   best ask: ${orderbook.asks?.[0]?.price || 'N/A'}`);
    console.log(`   top 3 bids: ${JSON.stringify(orderbook.bids?.slice(0, 3) || [])}`);
    console.log(`   top 3 asks: ${JSON.stringify(orderbook.asks?.slice(0, 3) || [])}`);

    if (!this.ensureLiquidity(orderbook, originalTrade.side)) {
      const marketStructure = this.isUnreplicableNoAskMarket(orderbook, originalTrade.price);
      if (marketStructure.unreplicable) {
        console.log('[Unreplicable Market Structure]', {
          tokenId: originalTrade.tokenId,
          market: originalTrade.market,
          bestBid: marketStructure.bestBid,
          asksDepth: marketStructure.asksDepth,
          sourcePrice: originalTrade.price,
          reason: 'no_asks_and_extreme_bid_gap',
        });
        throw new Error('SKIP:unreplicable_market_structure');
      }
      const noAsksFallbackResult = await this.tryNoAsksBuyFallback(
        originalTrade,
        copyNotional,
        orderbook,
        orderOpts,
        feeRateBps
      );
      if (noAsksFallbackResult) {
        return noAsksFallbackResult;
      }
      const makerFallbackResult = await this.tryMakerFallback(originalTrade, copyNotional, orderbook);
      if (makerFallbackResult) {
        return makerFallbackResult;
      }
      const reason = originalTrade.side === 'BUY' ? 'no_asks_in_orderbook' : 'no_bids_in_orderbook';
      console.log('[NoAsks Fallback]', {
        fallbackUsed: false,
        bestBid: Number(orderbook?.bids?.[0]?.price || 0) || null,
        bestAsk: Number(orderbook?.asks?.[0]?.price || 0) || null,
        fallbackPrice: null,
        finalOrderType: config.trading.noAsksFallbackOrderType,
        skipReason: reason,
      });
      throw new Error(`SKIP:${reason}`);
    }

    const { slippageTolerance } = config.trading;
    const bestPrice = this.getBestPrice(orderbook, originalTrade.side, originalTrade.price);
    const limitPrice = this.applySlippage(bestPrice, originalTrade.side, slippageTolerance);
    const validatedPrice = await this.validatePrice(limitPrice, originalTrade.tokenId);
    const copyShares = this.calculateSharesFromNotional(copyNotional, validatedPrice);

    console.log(`   Limit price: ${validatedPrice.toFixed(4)}`);
    console.log(`   Copy shares: ${copyShares}`);
    console.log(`   feeRateBps: ${feeRateBps}`);

    const response = await this.clobClient.createAndPostOrder(
      {
        tokenID: originalTrade.tokenId,
        price: validatedPrice,
        size: copyShares,
        side: originalTrade.side as Side,
        feeRateBps,
      },
      orderOpts,
      OrderType.GTC
    );

    if (response.success) {
      console.log(`✅ Limit order placed: ${response.orderID}`);
      return {
        orderId: response.orderID,
        copyNotional,
        copyShares,
        price: validatedPrice,
        side: originalTrade.side,
        tokenId: originalTrade.tokenId,
      };
    } else {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      console.log(`❌ Order failed: ${errorMsg}`);
      throw new Error(`Order placement failed: ${errorMsg}`);
    }
  }

  private async executeMarketOrder(
    originalTrade: Trade,
    orderType: 'FOK' | 'FAK',
    copyNotional: number
  ): Promise<CopyExecutionResult> {
    await this.validateBalance(copyNotional, originalTrade.tokenId);

    let orderbook;
    try {
      orderbook = await this.getOrderbookForExecution(originalTrade.tokenId);
    } catch (error: any) {
      if (error?.response?.status === 404 && error?.response?.data?.error?.includes('No orderbook exists for the requested token id')) {
        throw new Error(`SKIP:no_orderbook_exists`);
      }
      throw error;
    }
    orderbook = orderbook || { bids: [], asks: [] };

    const orderOpts = await this.getOrderOptions(originalTrade.tokenId);
    const feeRateBps = await this.getFeeRateBps(originalTrade.tokenId);

    console.log(`[DEBUG] Execution details:`);
    console.log(`   tokenId: ${originalTrade.tokenId}`);
    console.log(`   market: ${originalTrade.market}`);
    console.log(`   source side: ${originalTrade.side}`);
    console.log(`   source outcome: ${originalTrade.outcome} (${originalTrade.outcomeName || 'no name'})`);
    const canonicalOutcome = await this.getOutcomeLabel(originalTrade.tokenId);
    console.log(`   canonical outcome: ${canonicalOutcome}`);
    console.log(`   orderbook bids.length: ${orderbook.bids?.length || 0}`);
    console.log(`   orderbook asks.length: ${orderbook.asks?.length || 0}`);
    console.log(`   best bid: ${orderbook.bids?.[0]?.price || 'N/A'}`);
    console.log(`   best ask: ${orderbook.asks?.[0]?.price || 'N/A'}`);
    console.log(`   top 3 bids: ${JSON.stringify(orderbook.bids?.slice(0, 3) || [])}`);
    console.log(`   top 3 asks: ${JSON.stringify(orderbook.asks?.slice(0, 3) || [])}`);

    if (!this.ensureLiquidity(orderbook, originalTrade.side)) {
      const marketStructure = this.isUnreplicableNoAskMarket(orderbook, originalTrade.price);
      if (marketStructure.unreplicable) {
        console.log('[Unreplicable Market Structure]', {
          tokenId: originalTrade.tokenId,
          market: originalTrade.market,
          bestBid: marketStructure.bestBid,
          asksDepth: marketStructure.asksDepth,
          sourcePrice: originalTrade.price,
          reason: 'no_asks_and_extreme_bid_gap',
        });
        throw new Error('SKIP:unreplicable_market_structure');
      }
      const noAsksFallbackResult = await this.tryNoAsksBuyFallback(
        originalTrade,
        copyNotional,
        orderbook,
        orderOpts,
        feeRateBps
      );
      if (noAsksFallbackResult) {
        return noAsksFallbackResult;
      }
      const makerFallbackResult = await this.tryMakerFallback(originalTrade, copyNotional, orderbook);
      if (makerFallbackResult) {
        return makerFallbackResult;
      }
      const reason = originalTrade.side === 'BUY' ? 'no_asks_in_orderbook' : 'no_bids_in_orderbook';
      console.log('[NoAsks Fallback]', {
        fallbackUsed: false,
        bestBid: Number(orderbook?.bids?.[0]?.price || 0) || null,
        bestAsk: Number(orderbook?.asks?.[0]?.price || 0) || null,
        fallbackPrice: null,
        finalOrderType: config.trading.noAsksFallbackOrderType,
        skipReason: reason,
      });
      throw new Error(`SKIP:${reason}`);
    }

    const { slippageTolerance } = config.trading;
    const bestPrice = this.getBestPrice(orderbook, originalTrade.side, originalTrade.price);
    const marketPrice = this.applySlippage(bestPrice, originalTrade.side, slippageTolerance);
    const validatedPrice = await this.validatePrice(marketPrice, originalTrade.tokenId);
    const copyShares = this.calculateSharesFromNotional(copyNotional, validatedPrice);
    console.log(`   Market price: ${validatedPrice.toFixed(4)}`);
    console.log(`   Copy shares: ${copyShares}`);
    console.log(`   feeRateBps: ${feeRateBps}`);

    const orderTypeEnum = orderType === 'FOK' ? OrderType.FOK : OrderType.FAK;
    const response = await this.clobClient.createAndPostMarketOrder(
      {
        tokenID: originalTrade.tokenId,
        amount: originalTrade.side === 'BUY' ? copyNotional : copyShares,
        price: validatedPrice,
        side: originalTrade.side as Side,
        feeRateBps,
        orderType: orderTypeEnum,
      },
      orderOpts,
      orderTypeEnum
    );

    if (response.success) {
      console.log(`✅ ${orderType} order executed: ${response.orderID}`);
      if (response.status === 'LIVE') {
        console.log(`   ⚠️  Order posted to book (no immediate match)`);
      }
      return {
        orderId: response.orderID,
        copyNotional,
        copyShares,
        price: validatedPrice,
        side: originalTrade.side,
        tokenId: originalTrade.tokenId,
      };
    } else {
      const errorMsg = response.errorMsg || response.error || 'Unknown error';
      console.log(`❌ Order failed: ${errorMsg}`);
      throw new Error(`Order placement failed: ${errorMsg}`);
    }
  }

  private async validateBalance(requiredAmount: number, tokenId: string): Promise<void> {
    try {
      const metadata = await this.getMarketMetadata(tokenId);
      const exchangeAddress = metadata.negRisk ? config.contracts.negRiskExchange : config.contracts.exchange;
      const ownerAddress = this.getFundsCheckAddress();

      const usdc = new ethers.Contract(config.contracts.usdc, this.ERC20_ABI, this.wallet);
      const ctf = new ethers.Contract(config.contracts.ctf, this.CTF_ABI, this.wallet);
      const decimals = await usdc.decimals();
      const required = ethers.utils.parseUnits(requiredAmount.toString(), decimals);

      const balance = await usdc.balanceOf(ownerAddress);
      if (balance.lt(required)) {
        const bal = ethers.utils.formatUnits(balance, decimals);
        throw new Error(`not enough balance / allowance (USDC.e balance ${bal} < required ${requiredAmount})`);
      }

      const allowanceCtf = await usdc.allowance(ownerAddress, config.contracts.ctf);
      if (allowanceCtf.lt(required)) {
        const allow = ethers.utils.formatUnits(allowanceCtf, decimals);
        throw new Error(`not enough balance / allowance (USDC.e allowance to CTF ${allow} < required ${requiredAmount})`);
      }

      const allowanceEx = await usdc.allowance(ownerAddress, exchangeAddress);
      if (allowanceEx.lt(required)) {
        const allow = ethers.utils.formatUnits(allowanceEx, decimals);
        throw new Error(`not enough balance / allowance (USDC.e allowance to Exchange ${allow} < required ${requiredAmount})`);
      }

      const clobBal = await this.clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      console.log('[DEBUG] getBalanceAllowance raw =', JSON.stringify(clobBal, null, 2));
      console.log('[DEBUG] signer =', this.getSignerAddress());
      console.log('[DEBUG] funder =', this.getFunderAddress());
      console.log('[DEBUG] fundsCheck =', this.getFundsCheckAddress());

      const clobBalance = parseFloat(clobBal?.balance || '0') / 1_000_000;
      if (clobBalance < requiredAmount) {
        throw new Error(`not enough balance / allowance (CLOB balance ${clobBalance} < required ${requiredAmount})`);
      }
      console.log('[DEBUG] current exchangeAddress =', exchangeAddress);
      const allowancesMap = (clobBal as any)?.allowances ?? {};
      const exchangeKey = Object.keys(allowancesMap).find(
        (key) => key.toLowerCase() === exchangeAddress.toLowerCase()
      );
      const resolvedClobAllowance =
        (exchangeKey ? allowancesMap[exchangeKey] : undefined) ??
        clobBal?.allowance ??
        '0';
      console.log('[DEBUG] resolved clob allowance =', resolvedClobAllowance);
      if (resolvedClobAllowance === '0') {
        throw new Error(`not enough balance / allowance (CLOB allowance to Exchange is 0 for ${exchangeAddress})`);
      }

      const approved = await ctf.isApprovedForAll(ownerAddress, exchangeAddress);
      if (!approved) {
        console.log('   ⚠️  CTF approval missing for exchange (required for SELLs)');
      }

      console.log(`   Balance/allowance check passed`);
    } catch (error) {
      throw error;
    }
  }


  async getPositions(): Promise<any[]> {
    try {
      const user = config.auth.sigType !== 0 && config.auth.funderAddress
        ? config.auth.funderAddress
        : this.wallet.address;
      const { data } = await axios.get<unknown[]>(`${DATA_API_BASE}/positions`, {
        params: { user },
        timeout: 15_000,
      });
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async cancelAllOrders(): Promise<void> {
    try {
      await this.clobClient.cancelAll();
      console.log('✅ All orders cancelled');
    } catch (error) {
      console.error('Error cancelling orders:', error);
    }
  }

  private async getFeeRateBps(tokenId: string): Promise<number> {
    const metadata = await this.getMarketMetadata(tokenId);
    return metadata.feeRateBps;
  }

  private async getOrderOptions(tokenId: string): Promise<{ tickSize: any; negRisk: boolean }> {
    const metadata = await this.getMarketMetadata(tokenId);
    return {
      tickSize: metadata.tickSizeStr as any,
      negRisk: metadata.negRisk,
    };
  }
  private async validateWalletReadiness(): Promise<void> {
    console.log('🔐 Checking wallet readiness without sending approval transactions...');
    const ownerAddress = this.getFundsCheckAddress();

    const usdc = new ethers.Contract(config.contracts.usdc, this.ERC20_ABI, this.wallet);
    const ctf = new ethers.Contract(config.contracts.ctf, this.CTF_ABI, this.wallet);

    const maticBal = await this.provider.getBalance(this.wallet.address);
    const maticAmount = parseFloat(ethers.utils.formatEther(maticBal));
    if (maticAmount < 0.05) {
      console.log(`   ⚠️  Low POL/MATIC for signer gas wallet ${this.wallet.address}: ${maticAmount.toFixed(4)}`);
    }

    const decimals = await usdc.decimals();
    const minAllowance = ethers.utils.parseUnits(config.trading.maxTradeSize.toString(), decimals);

    const usdcSpenders = [
      { name: 'CTF', address: config.contracts.ctf },
      { name: 'CTF Exchange', address: config.contracts.exchange },
      { name: 'Neg Risk CTF Exchange', address: config.contracts.negRiskExchange },
    ];

    for (const spender of usdcSpenders) {
      const allowance = await usdc.allowance(ownerAddress, spender.address);
      if (allowance.lt(minAllowance)) {
        const formatted = ethers.utils.formatUnits(allowance, decimals);
        console.log(`   ⚠️  Missing manual USDC.e approval for ${spender.name} (${spender.address}), current allowance=${formatted}`);
      } else {
        console.log(`   ✅ USDC.e allowance looks sufficient for ${spender.name}`);
      }
    }

    const operators = [
      { name: 'CTF Exchange', address: config.contracts.exchange },
      { name: 'Neg Risk CTF Exchange', address: config.contracts.negRiskExchange },
    ];

    for (const operator of operators) {
      const approved = await ctf.isApprovedForAll(ownerAddress, operator.address);
      if (!approved) {
        console.log(`   ⚠️  Missing manual CTF operator approval for ${operator.name} (${operator.address})`);
      } else {
        console.log(`   ✅ CTF operator approval present for ${operator.name}`);
      }
    }
  }
}
