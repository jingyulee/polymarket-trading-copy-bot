import { config, envPath, validateConfig } from './config.js';
import { TradeMonitor } from './monitor.js';
import { WebSocketMonitor } from './websocket-monitor.js';
import type { Trade } from './monitor.js';
import { TradeExecutor, type ExecutionValidationResult, type SignalMakerExecutionResult } from './trader.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';
import { applyFilters, applyLightweightFilters, getMarketLockKey } from './filter.js';
import { classifyCryptoMarket } from './crypto-market.js';
import { getMarketLockBehavior, isStrategyFilterSkipReason, type MarketLockType } from './market-lock.js';
import {
  getSkipStatsByWindow,
  getSessionStats,
  loadRecentMarketLocks,
  loadRecentProcessedTradeKeys,
  logTrade,
  insertLivePosition,
  insertSimPosition,
  persistMarketLock,
  persistProcessedTradeKey,
} from './db.js';
import { sendTelegram, sendTelegramDeduped } from './telegram.js';
import { startTelegramCommandWatcher } from './telegram-commands.js';
import { formatTradeMessage } from './telegram-trade-formatter.js';
import { startRedeemWatcher } from './redeem-watcher.js';
import { startSettlementUpdater } from './settlement-updater.js';
import { captureSignal, consumeSignal, getSignal, getSignalKey, type SignalEntry } from './signal-cache.js';

interface SignalConfirmationContext {
  ageMs: number;
  firstPrice: number;
  latestPrice: number;
  effectiveSignalPrice: number;
  cumulativeSourceUsd: number;
  tradeCount: number;
  windowMs: number;
}

interface SignalMakerEntryDecision {
  enabled: boolean;
  side: 'BUY' | 'SELL';
  tokenId: string;
  candidatePrice: number | null;
  candidateSizeUsd: number;
  marketLocked: boolean;
  reason: string;
}

interface MarketLockState {
  lockedUntil: number;
  lockType: MarketLockType;
  reason: string;
}

interface MarketRetryState {
  attemptCount: number;
  windowStartTs: number;
}

class PolymarketCopyBot {
  private readonly HARD_MARKET_LOCK_TTL_MS = 5 * 60 * 1000;
  private monitor: TradeMonitor;
  private wsMonitor?: WebSocketMonitor;
  private executor: TradeExecutor;
  private positions: PositionTracker;
  private risk: RiskManager;
  private isRunning = false;
  private processedTrades: Set<string> = new Set();
  private marketLocks: Set<string> = new Set();
  private marketLockStates: Map<string, MarketLockState> = new Map();
  private marketRetryStates: Map<string, MarketRetryState> = new Map();
  private botStartTime = 0;
  private readonly maxProcessedTrades = 10000;
  private stats = {
    tradesDetected: 0,
    tradesCopied: 0,
    tradesFailed: 0,
    tradesSkipped: 0,
    totalVolume: 0,
  };
  constructor() {
    this.monitor = new TradeMonitor();
    this.executor = new TradeExecutor();
    this.positions = new PositionTracker();
    this.risk = new RiskManager(this.positions);
  }

  async initialize(): Promise<void> {
    console.log('🤖 Polymarket Copy Trading Bot');
    console.log('================================');
    console.log(`ENV_PATH: ${envPath}`);
    console.log(`Target wallet: ${config.targetWallet} (from TARGET_WALLET)`);
    console.log(`Position multiplier: ${config.trading.positionSizeMultiplier * 100}%`);
    console.log(`Max trade size: ${config.trading.maxTradeSize} USDC`);
    console.log(`Max USD per order: ${config.trading.maxUsdPerOrder} USDC`);
    console.log(`Order type: ${config.trading.orderType}`);
    console.log(`Dry run: ${config.trading.dryRun ? 'Enabled' : 'Disabled'}`);
    console.log(`Market scope: ${config.trading.marketScope}`);
    console.log(`WebSocket: ${config.monitoring.useWebSocket ? 'Enabled' : 'Disabled'}`);
    console.log(`Prewarm match mode: ${config.monitoring.prewarmMatchMode}`);
    console.log(`Signal trigger: ${config.trading.enableSignalTrigger ? 'Enabled' : 'Disabled'}`);
    console.log(`signalWindowMs: ${config.trading.signalWindowMs}`);
    console.log(`signalMinTradeCount: ${config.trading.signalMinTradeCount}`);
    console.log(`signalMinCumulativeUsd: ${config.trading.signalMinCumulativeUsd}`);
    console.log(`No-asks fallback: ${config.trading.enableNoAsksFallback ? 'Enabled' : 'Disabled'} (${config.trading.noAsksFallbackOrderType})`);
    if (config.risk.maxSessionNotional > 0 || config.risk.maxPerMarketNotional > 0) {
      console.log(`Risk caps: session=${config.risk.maxSessionNotional || '∞'} USDC, per-market=${config.risk.maxPerMarketNotional || '∞'} USDC`);
    }
    const authLabel = config.auth.sigType === 0 ? 'EOA' : config.auth.sigType === 1 ? 'Poly Proxy' : 'Poly Polymorphic';
    console.log(`Auth: ${authLabel} (signature type ${config.auth.sigType})`);
    console.log('================================\n');

    validateConfig();

    this.botStartTime = Date.now();
    this.processedTrades = new Set(loadRecentProcessedTradeKeys());
    this.marketLocks = new Set(loadRecentMarketLocks());
    for (const marketLockKey of this.marketLocks) {
      this.marketLockStates.set(marketLockKey, {
        lockedUntil: Number.MAX_SAFE_INTEGER,
        lockType: 'hard',
        reason: 'persisted_hard_lock',
      });
    }
    console.log(`⏰ Bot start time: ${new Date(this.botStartTime).toISOString()}`);
    console.log('   (Only trades after this time will be copied)\n');
    console.log(`   Loaded dedupe cache: ${this.processedTrades.size} processed trade keys`);
    console.log(`   Loaded market locks: ${this.marketLocks.size}\n`);

    await this.monitor.initialize();
    await this.executor.initialize();
    await this.reconcilePositions();

    if (config.monitoring.useWebSocket) {
      this.wsMonitor = new WebSocketMonitor();
      try {
        const wsAuth = this.executor.getWsAuth();
        const channel = config.monitoring.useUserChannel ? 'user' : 'market';
        await this.wsMonitor.initialize(
          this.handleNewTrade.bind(this),
          channel,
          wsAuth,
          this.executor.getOutcomeLabel.bind(this.executor)
        );
        console.log(`✅ WebSocket monitor initialized (${channel} channel)\n`);

        if (channel === 'market' && config.monitoring.wsAssetIds.length > 0) {
          for (const assetId of config.monitoring.wsAssetIds) {
            await this.wsMonitor.subscribeToMarket(assetId);
          }
        }

        if (channel === 'user' && config.monitoring.wsMarketIds.length > 0) {
          for (const marketId of config.monitoring.wsMarketIds) {
            await this.wsMonitor.subscribeToCondition(marketId);
          }
        }

        await this.executor.prewarmOrderbooks(
          channel === 'market' ? this.wsMonitor.subscribeToMarket.bind(this.wsMonitor) : undefined
        );
      } catch (error) {
        console.error('⚠️  WebSocket initialization failed, falling back to REST API only');
        console.error('   Error:', error);
        this.wsMonitor = undefined;
      }
    } else {
      await this.executor.prewarmOrderbooks();
    }

    await sendTelegramDeduped(
      'bot:start',
      [
        'COPY BOT STARTED',
        `Source traders: ${(config.monitoring.sourceTraderWhitelist.length > 0 ? config.monitoring.sourceTraderWhitelist : [config.targetWallet]).join(', ')}`,
        `Mode: ${config.trading.dryRun ? 'DRY_RUN' : 'LIVE'}`,
        `Market scope: ${config.trading.marketScope}`,
      ].join('\n')
    );

    startRedeemWatcher(config, this.executor.getAccountAddress());
    startSettlementUpdater(config);
    startTelegramCommandWatcher();
  }

  async start(): Promise<void> {
    this.isRunning = true;
    const monitoringMethods = [];
    if (this.wsMonitor) monitoringMethods.push('WebSocket');
    monitoringMethods.push('REST API');

    console.log(`🚀 Bot started! Monitoring via: ${monitoringMethods.join(' + ')}\n`);

    while (this.isRunning) {
      try {
        await this.monitor.pollForNewTrades(this.handleNewTrade.bind(this));
        this.monitor.pruneProcessedHashes();
      } catch (error) {
        console.error('Error in monitoring loop:', error);
      }

      await this.sleep(config.monitoring.pollInterval);
    }
  }

  private getLiquiditySymbolCheck(trade: Trade): { matchedSymbol: string | null; allowed: boolean } {
    const classification = classifyCryptoMarket({
      marketTitle: trade.title || trade.market || trade.question || null,
      marketSlug: trade.marketSlug || null,
      cryptoKeywords: config.trading.cryptoKeywords,
    });
    const matchedSymbol = classification.matchedSymbol;
    const allowed = classification.isCrypto;
    console.log('[Crypto Market Classification]', {
      marketTitle: trade.title || trade.market || trade.question || null,
      marketSlug: trade.marketSlug || null,
      isCrypto: classification.isCrypto,
      matchedSymbol: classification.matchedSymbol,
      matchedKeyword: classification.matchedKeyword,
      matchedField: classification.matchedField,
      reason: classification.reason,
    });
    console.log('[Liquidity Symbol Check]', {
      marketTitle: trade.title || trade.market || trade.question || null,
      marketSlug: trade.marketSlug || null,
      isCrypto: classification.isCrypto,
      matchedSymbol,
      matchedKeyword: classification.matchedKeyword,
      matchedField: classification.matchedField,
      reason: classification.reason,
      allowed,
    });
    return { matchedSymbol, allowed };
  }

  private shouldBypassNoAsksFilter(trade: Trade, marketSnapshot: {
    bestBid: number | null;
    bidsDepth: number;
    asksDepth: number;
  }): boolean {
    if (config.trading.enableSignalTrigger && trade.side === 'BUY') {
      console.log('[NoAsks Filter Bypass]', {
        tokenId: trade.tokenId,
        market: trade.market,
        bestBid: marketSnapshot.bestBid,
        bidsDepth: marketSnapshot.bidsDepth,
        asksDepth: marketSnapshot.asksDepth,
        fallbackEnabled: 'signal_trigger_execution',
      });
      return true;
    }

    const shouldBypass = Boolean(
      config.trading.enableNoAsksFallback &&
      trade.side === 'BUY' &&
      marketSnapshot.asksDepth === 0 &&
      marketSnapshot.bestBid != null &&
      marketSnapshot.bidsDepth > 0
    );

    if (shouldBypass) {
      console.log('[NoAsks Filter Bypass]', {
        tokenId: trade.tokenId,
        market: trade.market,
        bestBid: marketSnapshot.bestBid,
        bidsDepth: marketSnapshot.bidsDepth,
        asksDepth: marketSnapshot.asksDepth,
        fallbackEnabled: true,
      });
    }

    return shouldBypass;
  }

  private canCaptureSignalTrade(trade: Trade, sourceAgeMs: number): boolean {
    if ((config.trading.copyOnlyBuy || config.trading.signalRequireBuyOnly) && trade.side !== 'BUY') {
      return false;
    }
    if (!Number.isFinite(Number(trade.price))) {
      return false;
    }
    if (sourceAgeMs > config.trading.maxSourceTradeAgeMs) {
      return false;
    }

    if (config.trading.marketScope === 'crypto-only') {
      const marketTitle = trade.title || trade.market || trade.question || null;
      const marketClassification = classifyCryptoMarket({
        marketTitle,
        marketSlug: trade.marketSlug,
        cryptoKeywords: config.trading.cryptoKeywords,
      });
      console.log('[Crypto Market Classification]', {
        marketTitle: trade.title || trade.market || trade.question || null,
        marketSlug: trade.marketSlug || null,
        isCrypto: marketClassification.isCrypto,
        matchedSymbol: marketClassification.matchedSymbol,
        matchedKeyword: marketClassification.matchedKeyword,
        matchedField: marketClassification.matchedField,
        reason: marketClassification.reason,
      });
      console.log('[Market Scope]', {
        marketTitle,
        marketSlug: trade.marketSlug || null,
        matchedSymbol: marketClassification.matchedSymbol,
        matchedKeyword: marketClassification.matchedKeyword,
        matchedField: marketClassification.matchedField,
        result: marketClassification.isCrypto ? 'crypto' : 'non_crypto',
        reason: marketClassification.reason,
      });
      if (!marketClassification.isCrypto) {
        return false;
      }
    }

    return true;
  }

  private getEffectiveSignalPrice(signal: SignalEntry): number | null {
    const effectiveSignalPrice = Number(signal.maxSourcePrice);
    if (!Number.isFinite(effectiveSignalPrice)) {
      return null;
    }

    const boundedSignalPrice = Math.min(effectiveSignalPrice, config.trading.maxSourcePrice);
    if (!Number.isFinite(boundedSignalPrice)) {
      return null;
    }

    return Math.round(boundedSignalPrice * 10000) / 10000;
  }

  private getSignalConfirmation(signal: SignalEntry, now: number): SignalConfirmationContext | null {
    const windowMs = Math.max(0, now - signal.firstTs);
    if (windowMs > config.trading.signalWindowMs) {
      return null;
    }
    const shouldTrigger = (
      signal.tradeCount >= config.trading.signalMinTradeCount ||
      signal.cumulativeSourceUsd >= 50 ||
      signal.maxSingleTradeUsd >= 50
    );
    if (!shouldTrigger) {
      return null;
    }

    const effectiveSignalPrice = this.getEffectiveSignalPrice(signal);
    if (effectiveSignalPrice == null) {
      return null;
    }

    return {
      ageMs: Math.max(0, now - signal.lastTs),
      firstPrice: signal.firstSourcePrice,
      latestPrice: signal.latestSourcePrice,
      effectiveSignalPrice,
      cumulativeSourceUsd: signal.cumulativeSourceUsd,
      tradeCount: signal.tradeCount,
      windowMs,
    };
  }

  private async shouldPlaceSignalMakerEntry(params: {
    trade: Trade;
    signalConfirmation: SignalConfirmationContext | null;
    bestBid: number | null;
    asksDepth: number;
    copyNotional: number;
    marketLocked: boolean;
  }): Promise<SignalMakerEntryDecision> {
    const { trade, signalConfirmation, bestBid, asksDepth, copyNotional, marketLocked } = params;
    const baseDecision: SignalMakerEntryDecision = {
      enabled: false,
      side: trade.side === 'SELL' ? 'SELL' : 'BUY',
      tokenId: trade.tokenId,
      candidatePrice: null,
      candidateSizeUsd: Math.min(copyNotional, config.trading.maxSignalMakerUsd),
      marketLocked,
      reason: 'signal_not_confirmed',
    };

    if (!signalConfirmation) {
      return baseDecision;
    }
    if (config.trading.enableSignalTrigger) {
      return { ...baseDecision, reason: 'signal_trigger_prefers_taker_execution' };
    }
    if (!config.trading.enableSignalMakerEntry) {
      return { ...baseDecision, reason: 'signal_maker_entry_disabled' };
    }

    if (trade.side !== 'BUY') {
      return { ...baseDecision, reason: 'side_not_supported' };
    }
    if (trade.price < 0.95) {
      return { ...baseDecision, reason: 'source_price_below_0_95' };
    }
    if (signalConfirmation.windowMs > config.trading.signalWindowMs) {
      return { ...baseDecision, reason: 'signal_expired' };
    }
    if (asksDepth !== 0) {
      return { ...baseDecision, reason: 'asks_present' };
    }
    if (bestBid == null) {
      return { ...baseDecision, reason: 'best_bid_missing' };
    }
    if (marketLocked) {
      return { ...baseDecision, reason: 'market_already_executed' };
    }
    if (bestBid < config.trading.minReplicableBestBid) {
      return { ...baseDecision, reason: 'best_bid_too_low' };
    }
    if ((trade.price - bestBid) > config.trading.maxSignalEntryBidGap) {
      return { ...baseDecision, reason: 'bid_gap_too_wide' };
    }

    const candidatePrice = await this.executor.getValidatedPriceForDecision(
      Math.min(
        signalConfirmation.effectiveSignalPrice,
        bestBid + config.trading.signalMakerPriceOffset,
        config.trading.maxSourcePrice,
        0.99
      ),
      trade.tokenId
    );

    return {
      enabled: true,
      side: 'BUY',
      tokenId: trade.tokenId,
      candidatePrice,
      candidateSizeUsd: baseDecision.candidateSizeUsd,
      marketLocked,
      reason: 'signal_confirmed_no_asks_maker_candidate',
    };
  }

  private handleSuccessfulExecution(
    trade: Trade,
    result: { orderId: string; copyNotional: number; copyShares: number; price: number; side: 'BUY' | 'SELL'; tokenId: string },
    sourceAgeMs: number,
    marketLockKey: string,
    reason: string,
    persistMarketLockOnSuccess: boolean
  ): void {
    this.risk.recordFill({
      trade,
      notional: result.copyNotional,
      shares: result.copyShares,
      price: result.price,
      side: result.side,
    });
    this.stats.tradesCopied++;
    this.stats.totalVolume += result.copyNotional;
    if (persistMarketLockOnSuccess && config.trading.oneTradePerMarket) {
      this.applyMarketLock(trade, marketLockKey, {
        lockType: 'hard',
        reason,
      });
    }
    this.marketRetryStates.delete(marketLockKey);
    this.recordTradeLog(trade, {
      action: 'copy_success',
      reason,
      orderId: result.orderId,
      fillPrice: result.price,
      fillSize: result.copyShares,
      copyNotional: result.copyNotional,
      sourceAgeMs,
    });
    insertLivePosition({
      conditionId: trade.conditionId,
      market: trade.market,
      marketSlug: trade.marketSlug,
      tokenId: trade.tokenId,
      outcome: trade.outcome,
      side: trade.side,
      entryTs: trade.timestamp || Date.now(),
      entryPrice: result.price,
      entryShares: result.copyShares,
      entryNotional: result.copyNotional,
      sourcePrice: trade.price,
      sourceSizeUsd: trade.size,
      orderId: result.orderId,
      status: 'open',
    });
  }

  private getMarketRetryState(marketLockKey: string, now: number): MarketRetryState | null {
    const retryState = this.marketRetryStates.get(marketLockKey);
    if (!retryState) return null;
    if (now - retryState.windowStartTs >= config.trading.marketRetryWindowMs) {
      this.marketRetryStates.delete(marketLockKey);
      return null;
    }
    return retryState;
  }

  private pruneMarketLockState(now: number): void {
    for (const [marketLockKey, lockState] of this.marketLockStates.entries()) {
      if (lockState.lockType === 'hard') {
        if (!this.marketLocks.has(marketLockKey)) {
          this.marketLockStates.delete(marketLockKey);
          console.log('[Market Lock Released]', {
            market: marketLockKey,
            tokenId: marketLockKey,
            lockType: 'hard',
          });
        }
        continue;
      }

      if (now >= lockState.lockedUntil) {
        this.marketLockStates.delete(marketLockKey);
        console.log('[Market Lock Released]', {
          market: marketLockKey,
          tokenId: marketLockKey,
          lockType: lockState.lockType,
        });
      }
    }

    for (const [marketLockKey, retryState] of this.marketRetryStates.entries()) {
      if (now - retryState.windowStartTs >= config.trading.marketRetryWindowMs) {
        this.marketRetryStates.delete(marketLockKey);
      }
    }
  }

  private applyMarketLock(
    trade: Trade,
    marketLockKey: string,
    params: {
      lockType: MarketLockType;
      reason: string;
      lockMs?: number | null;
    }
  ): void {
    if (!marketLockKey) {
      return;
    }

    const lockedUntil = params.lockType === 'hard'
      ? Number.MAX_SAFE_INTEGER
      : Date.now() + Math.max(0, params.lockMs ?? config.trading.marketShortLockMs);
    const lockTs = params.lockType === 'hard'
      ? Date.now() + this.HARD_MARKET_LOCK_TTL_MS
      : trade.timestamp || Date.now();

    if (params.lockType === 'hard') {
      this.marketLocks.add(marketLockKey);
      persistMarketLock(marketLockKey, lockTs);
    }

    this.marketLockStates.set(marketLockKey, {
      lockedUntil,
      lockType: params.lockType,
      reason: params.reason,
    });

    if (params.lockType === 'hard') {
      console.log('[Market Hard Lock Applied]', {
        market: trade.market || marketLockKey,
        tokenId: trade.tokenId || marketLockKey,
        lockKey: marketLockKey,
        ts: lockTs,
      });
      return;
    }

    console.log('[Market Lock Applied]', {
      market: trade.market || marketLockKey,
      tokenId: trade.tokenId || marketLockKey,
      lockType: params.lockType,
      reason: params.reason,
      lockedUntil,
    });
  }

  private incrementMarketRetryState(trade: Trade, marketLockKey: string, now: number): void {
    const existingState = this.getMarketRetryState(marketLockKey, now);
    const nextState = existingState
      ? {
        attemptCount: existingState.attemptCount + 1,
        windowStartTs: existingState.windowStartTs,
      }
      : {
        attemptCount: 1,
        windowStartTs: now,
      };

    this.marketRetryStates.set(marketLockKey, nextState);
    console.log('[Market Retry State]', {
      market: trade.market || marketLockKey,
      tokenId: trade.tokenId || marketLockKey,
      attemptCount: nextState.attemptCount,
      maxRetry: config.trading.marketMaxRetryPerWindow,
      windowMs: config.trading.marketRetryWindowMs,
    });
  }

  private getMarketLockSkipReason(
    trade: Trade,
    marketLockKey: string,
    now: number
  ): 'market_already_executed' | 'market_short_locked' | 'market_retry_exhausted' | null {
    this.pruneMarketLockState(now);

    const activeLockState = this.marketLockStates.get(marketLockKey);
    if (activeLockState) {
      if (activeLockState.lockType === 'hard') {
        console.log('[Market Hard Lock Skip]', {
          market: trade.market || marketLockKey,
          tokenId: trade.tokenId || marketLockKey,
          lockKey: marketLockKey,
        });
        return 'market_already_executed';
      }

      const remainingMs = Math.max(0, activeLockState.lockedUntil - now);
      console.log('[Market Lock Skip]', {
        market: trade.market || marketLockKey,
        tokenId: trade.tokenId || marketLockKey,
        lockType: activeLockState.lockType,
        reason: activeLockState.reason,
        remainingMs,
      });
      return 'market_short_locked';
    }

    const retryState = this.getMarketRetryState(marketLockKey, now);
    if (retryState && retryState.attemptCount >= config.trading.marketMaxRetryPerWindow) {
      const remainingMs = Math.max(0, (retryState.windowStartTs + config.trading.marketRetryWindowMs) - now);
      console.log('[Market Lock Skip]', {
        market: trade.market || marketLockKey,
        tokenId: trade.tokenId || marketLockKey,
        lockType: 'short',
        reason: 'market_retry_exhausted',
        remainingMs,
      });
      return 'market_retry_exhausted';
    }

    return null;
  }

  private handleTradeSkip(
    trade: Trade,
    params: {
      reason: string;
      sourceAgeMs: number;
      marketLockKey: string;
      copyNotional?: number;
      incrementRetry?: boolean;
    }
  ): void {
    this.stats.tradesSkipped++;
    this.recordTradeLog(trade, {
      action: 'skip',
      reason: params.reason,
      sourceAgeMs: params.sourceAgeMs,
      copyNotional: params.copyNotional,
    });

    const behavior = getMarketLockBehavior(params.reason, config.trading.marketShortLockMs);
    if (behavior.applyLock && behavior.lockType === 'short') {
      if (params.incrementRetry !== false) {
        this.incrementMarketRetryState(trade, params.marketLockKey, Date.now());
      }
      this.applyMarketLock(trade, params.marketLockKey, {
        lockType: 'short',
        reason: params.reason,
        lockMs: behavior.lockMs,
      });
    }

    if (isStrategyFilterSkipReason(params.reason)) {
      console.log('[Strategy Filter Skip]', {
        reason: params.reason,
        market: trade.market || params.marketLockKey,
        tokenId: trade.tokenId || params.marketLockKey,
      });
    }

    console.log(`⏭️  Skipped trade: ${params.reason}`);
  }

  private async handleNewTrade(trade: Trade): Promise<void> {
    if (trade.outcome === 'UNKNOWN') {
      const mappedOutcome = await this.executor.getOutcomeLabel(trade.tokenId);
      trade.outcome = mappedOutcome;
      trade.outcomeName = mappedOutcome;
    }

    if (trade.timestamp && trade.timestamp < this.botStartTime) {
      return;
    }

    const tradeKeys = this.getTradeKeys(trade);
    if (tradeKeys.some((key) => this.processedTrades.has(key))) {
      return;
    }

    for (const key of tradeKeys) {
      this.processedTrades.add(key);
      persistProcessedTradeKey(key, trade.timestamp || Date.now());
    }
    this.pruneProcessedTrades();
    this.stats.tradesDetected++;

    const now = Date.now();
    const sourceAgeMs = Math.max(0, now - (trade.timestamp || now));
    const sourcePrice = Number(trade.price);
    const sourceSizeUsd = Number(trade.size);
    const signalKey = getSignalKey(trade);
    const signalCaptureEligible = config.trading.enableSignalTrigger && this.canCaptureSignalTrade(trade, sourceAgeMs);

    console.log('\n' + '='.repeat(50));
    console.log('🎯 NEW TRADE DETECTED');
    console.log(`   Time: ${new Date(trade.timestamp).toISOString()}`);
    console.log(`   Market: ${trade.market}`);
    console.log(`   Side: ${trade.side} ${trade.outcome}`);
    console.log(`   Size: ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
    console.log(`   Token ID: ${trade.tokenId}`);
    console.log(`   Age: ${sourceAgeMs}ms`);
    console.log('='.repeat(50));

    if (Number.isFinite(sourceSizeUsd) && sourceSizeUsd < config.trading.minSourceTradeUsd) {
      console.log('[Source Trade Size]', {
        key: signalKey,
        market: trade.market,
        side: trade.side,
        sourcePrice,
        sourceSizeUsd,
        belowExecutionThreshold: true,
      });
    }

    let effectiveTrade = trade;
    let signalConfirmation: SignalConfirmationContext | null = null;
    let activeSignal = getSignal(signalKey, now, config.trading.signalWindowMs);
    let executionValidation: ExecutionValidationResult | null = null;

    if (signalCaptureEligible) {
      activeSignal = captureSignal(trade, now, config.trading.signalWindowMs);
      console.log('[Signal Captured]', {
        key: signalKey,
        market: trade.market,
        side: trade.side,
        sourcePrice,
        sourceSizeUsd,
        tradeCount: activeSignal.tradeCount,
        cumulativeSourceUsd: activeSignal.cumulativeSourceUsd,
        ageMs: Math.max(0, now - activeSignal.firstTs),
      });

      signalConfirmation = this.getSignalConfirmation(activeSignal, now);
      if (signalConfirmation) {
        effectiveTrade = {
          ...trade,
          market: activeSignal.latestMarketTitle || trade.market,
          marketSlug: activeSignal.latestMarketSlug || trade.marketSlug,
          tokenId: activeSignal.latestTokenId || trade.tokenId,
          outcome: activeSignal.latestOutcome || trade.outcome,
          outcomeName: activeSignal.latestOutcome || trade.outcomeName,
          price: signalConfirmation.effectiveSignalPrice,
          size: Math.max(trade.size, signalConfirmation.cumulativeSourceUsd),
        };
        console.log('[Signal Confirmed]', {
          key: signalKey,
          market: effectiveTrade.market,
          side: effectiveTrade.side,
          tradeCount: signalConfirmation.tradeCount,
          cumulativeSourceUsd: signalConfirmation.cumulativeSourceUsd,
          firstPrice: signalConfirmation.firstPrice,
          latestPrice: signalConfirmation.latestPrice,
          effectiveSignalPrice: signalConfirmation.effectiveSignalPrice,
          windowMs: signalConfirmation.windowMs,
        });
      }
    }

    if (config.trading.enableSignalTrigger && !signalConfirmation && (signalCaptureEligible || activeSignal != null)) {
      console.log('[Signal Pending]', {
        key: signalKey,
        market: trade.market,
        side: trade.side,
        tradeCount: activeSignal?.tradeCount ?? 0,
        cumulativeSourceUsd: activeSignal?.cumulativeSourceUsd ?? 0,
      });
      this.printStats();
      return;
    }

    executionValidation = await this.executor.validateExecutionTarget(effectiveTrade);
    effectiveTrade = executionValidation.trade;
    const marketLockKey = getMarketLockKey(effectiveTrade);
    if (executionValidation.rejected) {
      this.handleTradeSkip(trade, {
        reason: executionValidation.reason || 'wrong_token_side_validation_failed',
        sourceAgeMs,
        marketLockKey,
      });
      this.printStats();
      return;
    }

    const marketLockSkipReason = marketLockKey
      ? this.getMarketLockSkipReason(effectiveTrade, marketLockKey, now)
      : null;
    if (marketLockSkipReason) {
      this.handleTradeSkip(trade, {
        reason: marketLockSkipReason,
        sourceAgeMs,
        marketLockKey,
        incrementRetry: false,
      });
      this.printStats();
      return;
    }

    const liquiditySymbolCheck = this.getLiquiditySymbolCheck(effectiveTrade);
    const lightweightFilterResult = applyLightweightFilters(effectiveTrade, {
      now,
    });

    const bypassLiquidityGate = lightweightFilterResult.reason === 'not_high_liquidity_symbol' && liquiditySymbolCheck.allowed;
    if (!lightweightFilterResult.pass && !bypassLiquidityGate) {
      this.handleTradeSkip(trade, {
        reason: lightweightFilterResult.reason,
        sourceAgeMs,
        marketLockKey,
      });
      console.log(`⚠️  Lightweight filter skipped trade: ${lightweightFilterResult.reason}`);
      this.printStats();
      return;
    }
    if (bypassLiquidityGate) {
      console.log('ℹ️  Bypassing lightweight liquidity gate for configured crypto symbol');
    }

    if (this.wsMonitor) {
      await this.wsMonitor.subscribeToMarket(effectiveTrade.tokenId);
    }

    const orderbook = executionValidation?.orderbook ?? await this.executor.getOrderbook(effectiveTrade.tokenId);
    const bestBidValue = executionValidation?.bestBid ?? Number(orderbook?.bids?.[0]?.price);
    const bestAskValue = executionValidation?.bestAsk ?? Number(orderbook?.asks?.[0]?.price);
    const bestAskSize = Number(orderbook?.asks?.[0]?.size);
    const bidsDepth = orderbook?.bids?.length || 0;
    const asksDepth = orderbook?.asks?.length || 0;
    const bestBid = Number.isFinite(bestBidValue) ? bestBidValue : null;
    const bestAsk = Number.isFinite(bestAskValue) ? bestAskValue : null;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    const bestAskLiquidityUsd = bestAsk != null && Number.isFinite(bestAskSize)
      ? bestAsk * bestAskSize
      : undefined;

    const filterResult = applyFilters(trade, {
      now,
      bestBid: bestBid ?? undefined,
      bestAsk: bestAsk ?? undefined,
      bestAskLiquidityUsd,
      spread: spread ?? undefined,
      bidsDepth,
      asksDepth,
      marketLocks: this.marketLocks,
    });
    const effectiveFilterResult = effectiveTrade === trade
      ? filterResult
      : applyFilters(effectiveTrade, {
        now,
        bestBid: bestBid ?? undefined,
        bestAsk: bestAsk ?? undefined,
        bestAskLiquidityUsd,
        spread: spread ?? undefined,
        bidsDepth,
        asksDepth,
        marketLocks: this.marketLocks,
      });

    const bypassNoAsksFilter = effectiveFilterResult.reason === 'no_asks_in_orderbook' && this.shouldBypassNoAsksFilter(effectiveTrade, {
      bestBid,
      bidsDepth,
      asksDepth,
    });
    const noLiquidityBothSides = effectiveFilterResult.reason === 'no_asks_in_orderbook' && asksDepth === 0 && (bestBid == null || bidsDepth === 0);

    if (!effectiveFilterResult.pass && !bypassNoAsksFilter) {
      const resolvedReason = noLiquidityBothSides ? 'no_liquidity_both_sides' : effectiveFilterResult.reason;
      this.handleTradeSkip(trade, {
        reason: resolvedReason,
        sourceAgeMs,
        marketLockKey,
      });
      console.log(`⚠️  Filter skipped trade: ${resolvedReason}`);
      console.log('   Filter market snapshot:', {
        bestBid,
        bestAsk,
        spread,
        bidsDepth,
        asksDepth,
      });
      this.printStats();
      return;
    }
    if (bypassNoAsksFilter) {
      console.log('ℹ️  Bypassing no_asks_in_orderbook filter so fallback execution can handle the trade');
    }

    const copyNotional = this.executor.calculateCopySize(effectiveTrade.size);
    const marketLocked = config.trading.oneTradePerMarket && this.marketLocks.has(marketLockKey);
    const signalMakerDecision = await this.shouldPlaceSignalMakerEntry({
      trade: effectiveTrade,
      signalConfirmation,
      bestBid,
      asksDepth,
      copyNotional,
      marketLocked,
    });
    if (signalMakerDecision.enabled) {
      console.log('[Signal Maker Entry Candidate]', {
        tokenId: effectiveTrade.tokenId,
        market: effectiveTrade.market,
        sourcePrice: effectiveTrade.price,
        bestBid,
        asksDepth,
        candidatePrice: signalMakerDecision.candidatePrice,
        candidateSizeUsd: signalMakerDecision.candidateSizeUsd,
        enabled: signalMakerDecision.enabled,
        reason: signalMakerDecision.reason,
      });
    } else if (signalConfirmation) {
      console.log('[Signal Maker Entry Rejected]', {
        tokenId: effectiveTrade.tokenId,
        market: effectiveTrade.market,
        sourcePrice: effectiveTrade.price,
        bestBid,
        asksDepth,
        reason: signalMakerDecision.reason,
      });
    }
    const riskTargetNotional = signalMakerDecision.enabled ? signalMakerDecision.candidateSizeUsd : copyNotional;
    const riskCheck = this.risk.checkTrade(effectiveTrade, riskTargetNotional);
    if (!riskCheck.allowed) {
      this.handleTradeSkip(trade, {
        reason: riskCheck.reason || 'risk_check_blocked',
        sourceAgeMs,
        marketLockKey,
        copyNotional: riskTargetNotional,
      });
      console.log(`⚠️  Risk check blocked trade: ${riskCheck.reason}`);
      this.printStats();
      return;
    }

    if (config.trading.enableSignalTrigger && signalConfirmation) {
      consumeSignal(signalKey, now);
      console.log('[Execution Trigger]', {
        key: signalKey,
        market: effectiveTrade.market,
        side: effectiveTrade.side,
        effectiveSignalPrice: signalConfirmation.effectiveSignalPrice,
        cumulativeSourceUsd: signalConfirmation.cumulativeSourceUsd,
        tradeCount: signalConfirmation.tradeCount,
        copyNotional: riskTargetNotional,
      });
    }

    if (signalMakerDecision.enabled && !config.trading.dryRun && signalMakerDecision.candidatePrice != null) {
      try {
        const makerResult: SignalMakerExecutionResult = await this.executor.executeSignalMakerEntry(effectiveTrade, {
          candidatePrice: signalMakerDecision.candidatePrice,
          candidateNotional: signalMakerDecision.candidateSizeUsd,
          reason: signalMakerDecision.reason,
        });

        if (makerResult.filledNotional > 0) {
          this.handleSuccessfulExecution(trade, {
            orderId: makerResult.orderId,
            copyNotional: makerResult.filledNotional,
            copyShares: makerResult.filledSize,
            price: makerResult.price,
            side: makerResult.side,
            tokenId: makerResult.tokenId,
          }, sourceAgeMs, marketLockKey, makerResult.reason, true);
          console.log('✅ Signal maker entry executed');
          await sendTelegram(formatTradeMessage(trade, {
            mode: 'LIVE',
            decision: 'ORDER_PLACED',
            copyNotional: makerResult.filledNotional,
            fillPrice: makerResult.price,
            fillSize: makerResult.filledSize,
            sourceAgeMs,
          }));
        } else {
          this.handleTradeSkip(trade, {
            reason: makerResult.reason,
            sourceAgeMs,
            marketLockKey,
            copyNotional: signalMakerDecision.candidateSizeUsd,
          });
          console.log(`⏭️  Signal maker entry ended without fill: ${makerResult.reason}`);
        }
        this.printStats();
        return;
      } catch (error: any) {
        const reason = error?.message || 'signal_maker_entry_failed';
        this.stats.tradesFailed++;
        const behavior = getMarketLockBehavior(reason, config.trading.marketShortLockMs);
        if (behavior.applyLock && behavior.lockType === 'short') {
          this.incrementMarketRetryState(trade, marketLockKey, Date.now());
          this.applyMarketLock(trade, marketLockKey, {
            lockType: 'short',
            reason,
            lockMs: behavior.lockMs,
          });
        }
        this.recordTradeLog(trade, {
          action: 'copy_fail',
          reason,
          sourceAgeMs,
          copyNotional: signalMakerDecision.candidateSizeUsd,
        });
        console.log(`❌ Signal maker entry failed: ${reason}`);
        this.printStats();
        return;
      }
    }

    if (config.trading.dryRun) {
      const entryPrice = Number.isFinite(bestAsk) ? bestAsk : effectiveTrade.price;
      const entryShares = this.executor.calculateSharesFromNotional(copyNotional, entryPrice);
      this.recordTradeLog(trade, {
        action: 'dry_run',
        reason: 'dry_run_enabled',
        sourceAgeMs,
        copyNotional,
        fillPrice: Number.isFinite(bestAsk) ? bestAsk : undefined,
      });
      insertSimPosition({
        conditionId: trade.conditionId,
        market: trade.market,
        marketSlug: trade.marketSlug,
        tokenId: trade.tokenId,
        outcome: trade.outcome,
        side: trade.side,
        entryTs: trade.timestamp || Date.now(),
        entryPrice,
        entryShares,
        entryNotional: copyNotional,
        sourcePrice: trade.price,
        sourceSizeUsd: trade.size,
        orderId: null,
        status: 'open',
      });
      console.log(`🧪 DRY_RUN enabled, skipped live order for ${trade.market}`);
      await sendTelegramDeduped(
        `dry-run:${trade.txHash || marketLockKey}`,
        formatTradeMessage(trade, {
          mode: 'DRY',
          decision: 'WOULD_COPY',
          copyNotional,
          sourceAgeMs,
        })
      );
      this.printStats();
      return;
    }

    try {
      const result = await this.executor.executeCopyTrade(effectiveTrade, copyNotional);
      this.handleSuccessfulExecution(trade, result, sourceAgeMs, marketLockKey, 'executed', true);
      console.log('✅ Successfully copied trade');
      await sendTelegram(formatTradeMessage(trade, {
        mode: 'LIVE',
        decision: 'ORDER_PLACED',
        copyNotional: result.copyNotional,
        fillPrice: result.price,
        fillSize: result.copyShares,
        sourceAgeMs,
      }));
      this.printStats();
    } catch (error: any) {
      const errorMsg = error?.message || '';
      if (errorMsg.startsWith('SKIP:')) {
        const reason = errorMsg.substring(5); // remove 'SKIP:'
        this.handleTradeSkip(trade, {
          reason,
          sourceAgeMs,
          marketLockKey,
          copyNotional,
        });
        await sendTelegram(formatTradeMessage(trade, {
          mode: 'LIVE',
          decision: 'SKIP',
          copyNotional,
          reason,
          sourceAgeMs,
        }));
        this.printStats();
        return;
      }

      this.stats.tradesFailed++;
      const behavior = getMarketLockBehavior(error?.message || 'copy_failed', config.trading.marketShortLockMs);
      if (behavior.applyLock && behavior.lockType === 'short') {
        this.incrementMarketRetryState(trade, marketLockKey, Date.now());
        this.applyMarketLock(trade, marketLockKey, {
          lockType: 'short',
          reason: error?.message || 'copy_failed',
          lockMs: behavior.lockMs,
        });
      }
      this.recordTradeLog(trade, {
        action: 'copy_fail',
        reason: error?.message || 'copy_failed',
        copyNotional,
        sourceAgeMs,
      });
      console.log('❌ Failed to copy trade');
      if (error?.message) {
        console.log(`   Reason: ${error.message}`);
      }
      await sendTelegram(formatTradeMessage(trade, {
        mode: 'LIVE',
        decision: 'FAILED',
        copyNotional,
        reason: error?.message || 'Unknown error',
        sourceAgeMs,
      }));
      this.printStats();
    }
  }

  private recordTradeLog(
    trade: Trade,
    params: {
      action:
        | 'skip'
        | 'dry_run'
        | 'copy_success'
        | 'copy_fail'
        | 'maker_fallback_placed'
        | 'maker_fallback_filled'
        | 'maker_fallback_cancelled';
      reason: string;
      sourceAgeMs: number;
      orderId?: string;
      fillPrice?: number;
      fillSize?: number;
      copyNotional?: number;
    }
  ): void {
    logTrade({
      ts: trade.timestamp || Date.now(),
      market: trade.market,
      marketSlug: trade.marketSlug,
      tokenId: trade.tokenId,
      side: trade.side,
      sourcePrice: trade.price,
      sourceSizeUsd: trade.size,
      sourceAgeMs: params.sourceAgeMs,
      action: params.action,
      reason: params.reason,
      orderId: params.orderId,
      fillPrice: params.fillPrice,
      fillSize: params.fillSize,
      copyNotional: params.copyNotional,
    });
  }

  private async reconcilePositions(): Promise<void> {
    try {
      const positions = await this.executor.getPositions();
      if (!positions || positions.length === 0) {
        console.log('🧾 Positions: none found (fresh session)');
        return;
      }

      const { loaded, skipped } = this.positions.loadFromClobPositions(positions);
      const totalNotional = this.positions.getTotalNotional();
      console.log(`🧾 Positions loaded: ${loaded} (skipped ${skipped}), total notional ≈ ${totalNotional.toFixed(2)} USDC`);
    } catch (error: any) {
      console.log(`🧾 Positions reconciliation failed: ${error.message || 'Unknown error'}`);
    }
  }

  stop(): void {
    this.isRunning = false;

    if (this.wsMonitor) {
      this.wsMonitor.close();
    }

    console.log('\n🛑 Bot stopped');
    this.printStats();
  }

  printStats(): void {
    const sessionStats = getSessionStats();
    const topSkip = getSkipStatsByWindow(60 * 60 * 1000)[0];
    console.log('\n📊 Session Statistics:');
    console.log(`   Trades detected: ${this.stats.tradesDetected}`);
    console.log(`   Trades copied: ${this.stats.tradesCopied}`);
    console.log(`   Trades failed: ${this.stats.tradesFailed}`);
    console.log(`   Total volume: ${this.stats.totalVolume.toFixed(2)} USDC`);
    console.log(`   DB session: skip=${sessionStats.skipped}, dry_run=${sessionStats.dryRun}, success=${sessionStats.success}, fail=${sessionStats.fail}, notional=${sessionStats.copyNotional.toFixed(2)} USDC`);
    if (topSkip) {
      console.log(`   Top skip(1h): ${topSkip.reason} (${topSkip.count})`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getTradeKeys(trade: Trade): string[] {
    const keys: string[] = [];

    if (trade.txHash) {
      keys.push(trade.txHash);
    }

    const fallbackKey = `${trade.tokenId}|${trade.side}|${trade.size}|${trade.price}|${trade.timestamp}`;
    keys.push(fallbackKey);

    return keys;
  }

  private pruneProcessedTrades(): void {
    if (this.processedTrades.size <= this.maxProcessedTrades) {
      return;
    }

    const entries = Array.from(this.processedTrades);
    this.processedTrades = new Set(entries.slice(-Math.floor(this.maxProcessedTrades / 2)));
  }
}

async function main() {
  const bot = new PolymarketCopyBot();

  process.on('SIGINT', () => {
    console.log('\n\nReceived SIGINT, shutting down...');
    bot.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
  });

  try {
    await bot.initialize();
    await bot.start();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
