import { config, envPath, validateConfig } from './config.js';
import { TradeMonitor } from './monitor.js';
import { WebSocketMonitor } from './websocket-monitor.js';
import type { Trade } from './monitor.js';
import { TradeExecutor } from './trader.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';
import { applyFilters, applyLightweightFilters, getMarketLockKey } from './filter.js';
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
  removeMarketLock,
} from './db.js';
import { sendTelegram, sendTelegramDeduped } from './telegram.js';
import { startTelegramCommandWatcher } from './telegram-commands.js';
import { formatTradeMessage } from './telegram-trade-formatter.js';
import { startRedeemWatcher } from './redeem-watcher.js';
import { startSettlementUpdater } from './settlement-updater.js';
import { captureSignal, deleteSignal, getSignal, getSignalKey, SIGNAL_TTL_MS } from './signal-cache.js';

interface SignalConfirmationContext {
  ageMs: number;
  signalPrice: number;
  confirmationPrice: number;
  entryPrice: number;
  signalSourceSize: number;
}

interface SignalMakerEntryDecision {
  enabled: boolean;
  side: 'BUY' | 'SELL';
  tokenId: string;
  candidatePrice: number | null;
  candidateSizeUsd: number;
  reason: string;
}

class PolymarketCopyBot {
  private monitor: TradeMonitor;
  private wsMonitor?: WebSocketMonitor;
  private executor: TradeExecutor;
  private positions: PositionTracker;
  private risk: RiskManager;
  private isRunning = false;
  private processedTrades: Set<string> = new Set();
  private marketLocks: Set<string> = new Set();
  private botStartTime = 0;
  private readonly maxProcessedTrades = 10000;
  private stats = {
    tradesDetected: 0,
    tradesCopied: 0,
    tradesFailed: 0,
    tradesSkipped: 0,
    totalVolume: 0,
  };
  private readonly fallbackLiquiditySymbols: Array<{ symbol: string; aliases: string[] }> = [
    { symbol: 'bitcoin', aliases: ['bitcoin', 'btc'] },
    { symbol: 'ethereum', aliases: ['ethereum', 'eth'] },
    { symbol: 'solana', aliases: ['solana', 'sol'] },
    { symbol: 'xrp', aliases: ['xrp'] },
    { symbol: 'dogecoin', aliases: ['dogecoin', 'doge'] },
    { symbol: 'bnb', aliases: ['bnb'] },
    { symbol: 'hyperliquid', aliases: ['hyperliquid', 'hype'] },
  ];

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

  private matchLiquiditySymbol(trade: Trade): string | null {
    const texts = [
      trade.title,
      trade.market,
      trade.question,
      trade.marketSlug,
      trade.outcome,
      trade.outcomeName,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());

    for (const entry of this.fallbackLiquiditySymbols) {
      if (entry.aliases.some((alias) => texts.some((text) => text.includes(alias)))) {
        return entry.symbol;
      }
    }
    return null;
  }

  private getLiquiditySymbolCheck(trade: Trade): { matchedSymbol: string | null; allowed: boolean } {
    const matchedSymbol = this.matchLiquiditySymbol(trade);
    const allowed = Boolean(matchedSymbol);
    console.log('[Liquidity Symbol Check]', {
      marketTitle: trade.title || trade.market || trade.question || null,
      marketSlug: trade.marketSlug || null,
      matchedSymbol,
      allowed,
    });
    return { matchedSymbol, allowed };
  }

  private shouldBypassNoAsksFilter(trade: Trade, marketSnapshot: {
    bestBid: number | null;
    bidsDepth: number;
    asksDepth: number;
  }): boolean {
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

  private shouldCaptureSmallTradeSignal(trade: Trade, sourcePrice: number, sourceAgeMs: number): boolean {
    if (config.trading.copyOnlyBuy && trade.side !== 'BUY') {
      return false;
    }
    if (!Number.isFinite(sourcePrice)) {
      return false;
    }
    if (sourcePrice < config.trading.minSourcePrice || sourcePrice > config.trading.maxSourcePrice) {
      return false;
    }
    if (sourceAgeMs > config.trading.maxSourceTradeAgeMs) {
      return false;
    }
    return true;
  }

  private getSignalBoostPrice(trade: Trade, signalPrice: number): number | null {
    const sourcePrice = Number(trade.price);
    if (!Number.isFinite(sourcePrice) || !Number.isFinite(signalPrice)) {
      return null;
    }

    const slippageCap = signalPrice * (1 + config.trading.slippageTolerance);
    const boostedPrice = Math.min(
      sourcePrice,
      signalPrice + 0.01,
      slippageCap,
      config.trading.maxSourcePrice
    );

    if (!Number.isFinite(boostedPrice)) {
      return null;
    }

    return Math.round(boostedPrice * 10000) / 10000;
  }

  private async shouldPlaceSignalMakerEntry(params: {
    trade: Trade;
    signalConfirmation: SignalConfirmationContext | null;
    bestBid: number | null;
    asksDepth: number;
    copyNotional: number;
  }): Promise<SignalMakerEntryDecision> {
    const { trade, signalConfirmation, bestBid, asksDepth, copyNotional } = params;
    const baseDecision: SignalMakerEntryDecision = {
      enabled: false,
      side: trade.side === 'SELL' ? 'SELL' : 'BUY',
      tokenId: trade.tokenId,
      candidatePrice: null,
      candidateSizeUsd: copyNotional,
      reason: 'signal_not_confirmed',
    };

    if (!signalConfirmation) {
      return baseDecision;
    }

    if (trade.side !== 'BUY') {
      return { ...baseDecision, reason: 'side_not_supported' };
    }
    if (trade.price < 0.95) {
      return { ...baseDecision, reason: 'source_price_below_0_95' };
    }
    if (signalConfirmation.ageMs > SIGNAL_TTL_MS) {
      return { ...baseDecision, reason: 'signal_expired' };
    }
    if (asksDepth !== 0) {
      return { ...baseDecision, reason: 'asks_present' };
    }
    if (bestBid == null) {
      return { ...baseDecision, reason: 'best_bid_missing' };
    }
    if (bestBid < config.trading.minReplicableBestBid) {
      return { ...baseDecision, reason: 'best_bid_too_low' };
    }
    if ((trade.price - bestBid) > config.trading.maxSignalEntryBidGap) {
      return { ...baseDecision, reason: 'bid_gap_too_wide' };
    }

    const candidatePrice = await this.executor.getValidatedPriceForDecision(
      Math.min(trade.price, 0.99),
      trade.tokenId
    );

    return {
      enabled: true,
      side: 'BUY',
      tokenId: trade.tokenId,
      candidatePrice,
      candidateSizeUsd: copyNotional,
      reason: 'signal_confirmed_no_asks_maker_candidate',
    };
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
    const marketLockKey = getMarketLockKey(trade);
    const signalKey = getSignalKey(trade);

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
      if (this.shouldCaptureSmallTradeSignal(trade, sourcePrice, sourceAgeMs)) {
        captureSignal(signalKey, {
          price: sourcePrice,
          ts: now,
          sourceSize: sourceSizeUsd,
        }, now);
        console.log('[Signal Captured]', {
          key: signalKey,
          market: trade.market,
          side: trade.side,
          sourcePrice,
          sourceSizeUsd,
          ttlMs: SIGNAL_TTL_MS,
        });
        return;
      }
    }

    let effectiveTrade = trade;
    let signalConfirmation: SignalConfirmationContext | null = null;
    const signalLookup = getSignal(signalKey, now);
    if (signalLookup.expired) {
      console.log('[Signal Expired]', {
        key: signalKey,
        market: trade.market,
        side: trade.side,
        ttlMs: SIGNAL_TTL_MS,
      });
    }
    const signal = signalLookup.signal;
    if (signal) {
      const signalAgeMs = now - signal.ts;
      if (sourcePrice < 0.95) {
        console.log('[Signal Ignored]', {
          key: signalKey,
          market: trade.market,
          side: trade.side,
          reason: 'source_price_below_0_95',
          sourcePrice,
          signalPrice: signal.price,
          ageMs: signalAgeMs,
        });
      } else {
        const boostedPrice = this.getSignalBoostPrice(trade, signal.price);
        if (boostedPrice == null || boostedPrice < config.trading.minSourcePrice) {
          console.log('[Signal Ignored]', {
            key: signalKey,
            market: trade.market,
            side: trade.side,
            reason: 'boosted_price_out_of_range',
            sourcePrice,
            signalPrice: signal.price,
            boostedPrice,
            ageMs: signalAgeMs,
          });
        } else {
          effectiveTrade = {
            ...trade,
            price: boostedPrice,
          };
          signalConfirmation = {
            ageMs: signalAgeMs,
            signalPrice: signal.price,
            confirmationPrice: sourcePrice,
            entryPrice: boostedPrice,
            signalSourceSize: signal.sourceSize,
          };
          deleteSignal(signalKey);
          console.log('[Signal Confirmed]', {
            key: signalKey,
            market: trade.market,
            side: trade.side,
            ageMs: signalAgeMs,
            signalPrice: signal.price,
            confirmationPrice: sourcePrice,
            entryPrice: boostedPrice,
            signalSourceSize: signal.sourceSize,
          });
        }
      }
    }

    const liquiditySymbolCheck = this.getLiquiditySymbolCheck(trade);
    const lightweightFilterResult = applyLightweightFilters(effectiveTrade, {
      now,
    });

    const bypassLiquidityGate = lightweightFilterResult.reason === 'not_high_liquidity_symbol' && liquiditySymbolCheck.allowed;
    if (!lightweightFilterResult.pass && !bypassLiquidityGate) {
      this.recordTradeLog(trade, {
        action: 'skip',
        reason: lightweightFilterResult.reason,
        sourceAgeMs,
      });
      console.log(`⚠️  Lightweight filter skipped trade: ${lightweightFilterResult.reason}`);
      this.printStats();
      return;
    }
    if (bypassLiquidityGate) {
      console.log('ℹ️  Bypassing lightweight liquidity gate for configured crypto symbol');
    }

    if (this.wsMonitor) {
      await this.wsMonitor.subscribeToMarket(trade.tokenId);
    }

    const orderbook = await this.executor.getOrderbook(trade.tokenId);
    const bestBidValue = Number(orderbook?.bids?.[0]?.price);
    const bestAskValue = Number(orderbook?.asks?.[0]?.price);
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
      this.recordTradeLog(trade, {
        action: 'skip',
        reason: resolvedReason,
        sourceAgeMs,
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
    const signalMakerDecision = await this.shouldPlaceSignalMakerEntry({
      trade: effectiveTrade,
      signalConfirmation,
      bestBid,
      asksDepth,
      copyNotional,
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
    const riskCheck = this.risk.checkTrade(effectiveTrade, copyNotional);
    if (!riskCheck.allowed) {
      this.recordTradeLog(trade, {
        action: 'skip',
        reason: riskCheck.reason || 'risk_check_blocked',
        sourceAgeMs,
        copyNotional,
      });
      console.log(`⚠️  Risk check blocked trade: ${riskCheck.reason}`);
      this.printStats();
      return;
    }

    if (config.trading.oneTradePerMarket) {
      this.marketLocks.add(marketLockKey);
      persistMarketLock(marketLockKey, trade.timestamp || Date.now());
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
      this.risk.recordFill({
        trade,
        notional: result.copyNotional,
        shares: result.copyShares,
        price: result.price,
        side: result.side,
      });
      this.stats.tradesCopied++;
      this.stats.totalVolume += result.copyNotional;
      this.recordTradeLog(trade, {
        action: 'copy_success',
        reason: 'executed',
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
        this.stats.tradesSkipped++;
        this.recordTradeLog(trade, {
          action: 'skip',
          reason,
          copyNotional,
          sourceAgeMs,
        });
        console.log(`⏭️  Skipped trade: ${reason}`);
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
      if (config.trading.oneTradePerMarket) {
        this.marketLocks.delete(marketLockKey);
        removeMarketLock(marketLockKey);
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
