import type { Trade } from './monitor.js';

export type TelegramTradeMode = 'DRY' | 'LIVE';

function formatHeader(mode: TelegramTradeMode): string {
  return mode === 'DRY' ? '🟡 DRY RUN' : '🟢 LIVE';
}

function formatSideLine(trade: Trade): string {
  const side = String(trade.side || '').trim().toUpperCase() || 'UNKNOWN';
  const outcome = String(trade.outcome || trade.outcomeName || '').trim().toUpperCase();
  const price = Number(trade.price || 0).toFixed(4);

  if (side === 'BUY' && outcome === 'UP') {
    return `🟢 BUY UP @ ${price}`;
  }

  if (side === 'BUY' && outcome === 'DOWN') {
    return `🔴 BUY DOWN @ ${price}`;
  }

  return `${side} ${outcome || 'UNKNOWN'} @ ${price}`;
}

function formatRiskLine(price: number): string {
  if (price >= 0.99) {
    return '⚠️ 高價區（風險高）';
  }

  if (price >= 0.97) {
    return '⚡ 中價區（可觀察）';
  }

  return '🟢 低價區（較佳）';
}

export function formatTradeMessage(
  trade: Trade,
  options: {
    mode: TelegramTradeMode;
    copyNotional: number;
    sourceAgeMs: number;
  }
): string {
  const sourceAgeSec = Math.max(0, options.sourceAgeMs) / 1000;

  return [
    formatHeader(options.mode),
    '',
    `📌 ${trade.market}`,
    '',
    formatSideLine(trade),
    formatRiskLine(Number(trade.price || 0)),
    '',
    `💰 Copy: ${options.copyNotional.toFixed(2)} USDC`,
    `📊 Source: ${Number(trade.size || 0).toFixed(2)} USDC`,
    '',
    `⏱ 延遲: ${sourceAgeSec.toFixed(1)}s`,
  ].join('\n');
}
