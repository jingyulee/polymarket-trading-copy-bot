import { config, validateConfig } from './config.js';
import { TradeMonitor } from './monitor.js';
import { WebSocketMonitor } from './websocket-monitor.js';
import type { Trade } from './monitor.js';
import { TradeExecutor } from './trader.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';
import { applyFilters, getMarketLockKey } from './filter.js';
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

  constructor() {
    this.monitor = new TradeMonitor();
    this.executor = new TradeExecutor();
    this.positions = new PositionTracker();
    this.risk = new RiskManager(this.positions);
  }

  async initialize(): Promise<void> {
    console.log('🤖 Polymarket Copy Trading Bot');
    console.log('================================');
    console.log(`Target wallet: ${config.targetWallet} (from TARGET_WALLET)`);
    console.log(`Position multiplier: ${config.trading.positionSizeMultiplier * 100}%`);
    console.log(`Max trade size: ${config.trading.maxTradeSize} USDC`);
    console.log(`Max USD per order: ${config.trading.maxUsdPerOrder} USDC`);
    console.log(`Order type: ${config.trading.orderType}`);
    console.log(`Dry run: ${config.trading.dryRun ? 'Enabled' : 'Disabled'}`);
    console.log(`Market scope: ${config.trading.marketScope}`);
    console.log(`WebSocket: ${config.monitoring.useWebSocket ? 'Enabled' : 'Disabled'}`);
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
      } catch (error) {
        console.error('⚠️  WebSocket initialization failed, falling back to REST API only');
        console.error('   Error:', error);
        this.wsMonitor = undefined;
      }
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

    const sourceAgeMs = Math.max(0, Date.now() - (trade.timestamp || Date.now()));
    const marketLockKey = getMarketLockKey(trade);

    console.log('\n' + '='.repeat(50));
    console.log('🎯 NEW TRADE DETECTED');
    console.log(`   Time: ${new Date(trade.timestamp).toISOString()}`);
    console.log(`   Market: ${trade.market}`);
    console.log(`   Side: ${trade.side} ${trade.outcome}`);
    console.log(`   Size: ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
    console.log(`   Token ID: ${trade.tokenId}`);
    console.log(`   Age: ${sourceAgeMs}ms`);
    console.log('='.repeat(50));

    if (this.wsMonitor) {
      await this.wsMonitor.subscribeToMarket(trade.tokenId);
    }

    const orderbook = await this.executor.getOrderbook(trade.tokenId);
    const bestAsk = Number(orderbook?.asks?.[0]?.price);
    const bestAskSize = Number(orderbook?.asks?.[0]?.size);
    const bestAskLiquidityUsd = Number.isFinite(bestAsk) && Number.isFinite(bestAskSize)
      ? bestAsk * bestAskSize
      : undefined;

    const filterResult = applyFilters(trade, {
      now: Date.now(),
      bestAsk: Number.isFinite(bestAsk) ? bestAsk : undefined,
      bestAskLiquidityUsd,
      marketLocks: this.marketLocks,
    });

    if (!filterResult.pass) {
      this.recordTradeLog(trade, {
        action: 'skip',
        reason: filterResult.reason,
        sourceAgeMs,
      });
      console.log(`⚠️  Filter skipped trade: ${filterResult.reason}`);
      this.printStats();
      return;
    }

    const copyNotional = this.executor.calculateCopySize(trade.size);
    const riskCheck = this.risk.checkTrade(trade, copyNotional);
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
      const entryPrice = Number.isFinite(bestAsk) ? bestAsk : trade.price;
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
      const result = await this.executor.executeCopyTrade(trade, copyNotional);
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
      action: 'skip' | 'dry_run' | 'copy_success' | 'copy_fail';
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
