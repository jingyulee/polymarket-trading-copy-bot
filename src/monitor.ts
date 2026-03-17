import axios from 'axios';
import { config } from './config.js';

export type TradeOutcome = string;

export interface Trade {
  txHash: string;
  timestamp: number;
  market: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  outcome: TradeOutcome;
  conditionId?: string;
  marketSlug?: string;
  question?: string;
  title?: string;
  outcomeName?: string;
}

function formatOutcomeLabel(value: any): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) return 'UNKNOWN';

  const upper = normalized.toUpperCase();
  if (upper === 'YES') return 'YES';
  if (upper === 'NO') return 'NO';
  if (upper === 'UP') return 'UP';
  if (upper === 'DOWN') return 'DOWN';
  return normalized;
}

export class TradeMonitor {
  private lastProcessedTimestamp: number = 0;
  private processedTradeIds: Set<string> = new Set();

  async initialize(): Promise<void> {
    this.lastProcessedTimestamp = Date.now();
    console.log(`📊 Monitor initialized at ${new Date(this.lastProcessedTimestamp).toISOString()}`);
    console.log(`   Will copy trades that occur AFTER this time`);
  }
  
  private async fetchTradesFromDataApi(): Promise<Trade[]> {
    try {
      const startSeconds = Math.floor(this.lastProcessedTimestamp / 1000) + 1;
      const response = await axios.get(
        'https://data-api.polymarket.com/activity',
        {
          params: {
            user: config.targetWallet.toLowerCase(),
            type: 'TRADE',
            limit: 100,
            sortBy: 'TIMESTAMP',
            sortDirection: 'DESC',
            start: startSeconds,
          },
          headers: {
            'Accept': 'application/json',
          },
        }
      );

      if (Array.isArray(response.data)) {
        return response.data.map(this.parseDataApiTrade.bind(this));
      }

      return [];
    } catch (error: any) {
      console.log(`⚠️  Could not fetch trades: ${error.message || 'Unknown error'}`);
      return [];
    }
  }

  private parseDataApiTrade(apiTrade: any): Trade {
    const outcomeName = formatOutcomeLabel(apiTrade.outcome || apiTrade.outcomeName);
    return {
      txHash: apiTrade.transactionHash || apiTrade.id || `trade-${apiTrade.timestamp}`,
      timestamp: apiTrade.timestamp * 1000,
      market: apiTrade.title || apiTrade.market || apiTrade.question || apiTrade.slug || apiTrade.conditionId,
      tokenId: apiTrade.asset || apiTrade.tokenId || apiTrade.token_id,
      side: apiTrade.side.toUpperCase() as 'BUY' | 'SELL',
      price: parseFloat(apiTrade.price),
      size: parseFloat(apiTrade.usdcSize || apiTrade.size),
      outcome: outcomeName,
      conditionId: apiTrade.conditionId || apiTrade.condition_id,
      marketSlug: apiTrade.slug || apiTrade.marketSlug || apiTrade.market_slug,
      question: apiTrade.question,
      title: apiTrade.title,
      outcomeName,
    };
  }
  
  async pollForNewTrades(callback: (trade: Trade) => Promise<void>): Promise<void> {
    try {
      const trades = await this.fetchTradesFromDataApi();

      if (trades.length === 0) {
        return;
      }

      const sortedTrades = trades.sort((a, b) => a.timestamp - b.timestamp);

      let newTradesCount = 0;

      for (const trade of sortedTrades) {
        const tradeId = trade.txHash;

        if (this.processedTradeIds.has(tradeId)) {
          continue;
        }

        if (trade.timestamp <= this.lastProcessedTimestamp) {
          continue;
        }

        this.processedTradeIds.add(tradeId);
        this.lastProcessedTimestamp = Math.max(this.lastProcessedTimestamp, trade.timestamp);
        newTradesCount++;

        console.log(`🎯 New trade detected: ${trade.side} ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
        console.log(`   Time: ${new Date(trade.timestamp).toISOString()}`);
        await callback(trade);
      }

      if (newTradesCount > 0) {
        console.log(`🔍 Processed ${newTradesCount} new trade(s)`);
      }
    } catch (error: any) {
      console.error(`❌ Error polling for trades:`, error.message);
    }
  }

  pruneProcessedHashes(): void {
    if (this.processedTradeIds.size > 10000) {
      const entries = Array.from(this.processedTradeIds);
      this.processedTradeIds = new Set(entries.slice(-5000));
    }
  }
}
