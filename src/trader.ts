import { ethers } from 'ethers';
import axios from 'axios';
import { ClobClient, Side, OrderType, AssetType } from '@polymarket/clob-client';
import { config } from './config.js';
import type { Trade } from './monitor.js';
import { logTrade } from './db.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';

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

export interface CopyExecutionResult {
  orderId: string;
  copyNotional: number;
  copyShares: number;
  price: number;
  side: 'BUY' | 'SELL';
  tokenId: string;
}

export class TradeExecutor {
  private wallet: ethers.Wallet;
  private provider: ethers.providers.JsonRpcProvider;
  private clobClient: ClobClient;
  private apiCreds?: { apiKey: string; secret: string; passphrase: string };
  private marketCache: Map<string, MarketMetadata> = new Map();
  private warnedMissingOutcomeMappings = new Set<string>();
  private readonly CACHE_TTL = 3600000;
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
      return value.map((item) => this.normalizeOutcomeLabel(item)).filter(Boolean) as string[];
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

  private normalizeOutcomeLabel(value: any): string | undefined {
    const normalized = String(value ?? '').trim();
    if (!normalized) return undefined;
    return normalized.toUpperCase();
  }

  async getTickSize(tokenId: string): Promise<number> {
    const metadata = await this.getMarketMetadata(tokenId);
    return metadata.tickSize;
  }

  async getOrderbook(tokenId: string): Promise<any | null> {
    try {
      return await this.clobClient.getOrderBook(tokenId);
    } catch (error: any) {
      console.log(`⚠️  Could not fetch orderbook for ${tokenId}: ${error?.message || 'Unknown error'}`);
      return null;
    }
  }

  async getBestAsk(tokenId: string): Promise<number | null> {
    const orderbook = await this.getOrderbook(tokenId);
    const ask = Number(orderbook?.asks?.[0]?.price);
    return Number.isFinite(ask) ? ask : null;
  }

  roundToTickSize(price: number, tickSize: number): number {
    return Math.round(price / tickSize) * tickSize;
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

  async executeCopyTrade(
    originalTrade: Trade,
    copyNotionalOverride?: number
  ): Promise<CopyExecutionResult> {
    const orderType = config.trading.orderType;
    const copyNotional = copyNotionalOverride ?? this.calculateCopySize(originalTrade.size);

    console.log(`📈 Executing copy trade (${orderType}):`);
    console.log(`   Market: ${originalTrade.market}`);
    console.log(`   Side: ${originalTrade.side}`);
    console.log(`   Original size: ${originalTrade.size} USDC`);
    console.log(`   Token ID: ${originalTrade.tokenId}`);
    console.log(`   Copy notional: ${copyNotional} USDC`);

    return this.executeWithRetry(async () => {
      if (orderType === 'FOK' || orderType === 'FAK') {
        return this.executeMarketOrder(originalTrade, orderType, copyNotional);
      } else {
        return this.executeLimitOrder(originalTrade, copyNotional);
      }
    });
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

  private async tryMakerFallback(
    originalTrade: Trade,
    copyNotional: number,
    orderbook: any
  ): Promise<CopyExecutionResult | null> {
    if (!config.trading.enableMakerFallback || originalTrade.side !== 'BUY' || (orderbook?.asks?.length || 0) > 0) {
      return null;
    }

    const bestBid = Number(orderbook?.bids?.[0]?.price || 0);
    const bestAsk = Number(orderbook?.asks?.[0]?.price || 0);

    console.log('[MakerFallback Market Snapshot]', {
      bestBid,
      bestAsk,
      spread: bestAsk - bestBid,
      bidsDepth: orderbook?.bids?.length || 0,
      asksDepth: orderbook?.asks?.length || 0
    });

    console.log('⚠️  No asks available, trying maker fallback');

    if (!Number.isFinite(bestBid) || bestBid <= 0) {
      console.log('   No best bid available; skipping maker fallback');
      throw new Error('SKIP:no_bids_no_asks_orderbook');
    }

    console.log(`   Best bid: ${bestBid.toFixed(4)}`);

    const rawPrice = bestBid * (1 + config.trading.makerFallbackPriceOffsetBps / 10000);
    const cappedPrice = Math.min(rawPrice, config.trading.maxSourcePrice, 0.99);
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
      reason: 'asks_empty_fallback',
      orderId,
      fillPrice: validatedPrice,
      fillSize: copyShares,
      copyNotional,
    });

    const deadline = Date.now() + Math.max(1000, config.trading.makerFallbackTtlMs);
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

    throw new Error('SKIP:maker_fallback_timeout_cancelled');
  }

  private async executeLimitOrder(originalTrade: Trade, copyNotional: number): Promise<CopyExecutionResult> {
    await this.validateBalance(copyNotional, originalTrade.tokenId);

    let orderbook;
    try {
      orderbook = await this.clobClient.getOrderBook(originalTrade.tokenId);
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
      const makerFallbackResult = await this.tryMakerFallback(originalTrade, copyNotional, orderbook);
      if (makerFallbackResult) {
        return makerFallbackResult;
      }
      const reason = originalTrade.side === 'BUY' ? 'no_asks_in_orderbook' : 'no_bids_in_orderbook';
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
      orderbook = await this.clobClient.getOrderBook(originalTrade.tokenId);
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
      const makerFallbackResult = await this.tryMakerFallback(originalTrade, copyNotional, orderbook);
      if (makerFallbackResult) {
        return makerFallbackResult;
      }
      const reason = originalTrade.side === 'BUY' ? 'no_asks_in_orderbook' : 'no_bids_in_orderbook';
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
