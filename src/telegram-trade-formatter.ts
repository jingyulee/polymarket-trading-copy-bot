import type { Trade } from './monitor.js';

export type TelegramTradeMode = 'DRY' | 'LIVE';
export type TelegramTradeDecision = 'WOULD_COPY' | 'ORDER_PLACED' | 'SKIP' | 'FAILED';

function formatHeader(mode: TelegramTradeMode, decision: TelegramTradeDecision): string {
  if (mode === 'DRY' && decision === 'WOULD_COPY') {
    return '🟡 DRY RUN — WOULD COPY';
  }

  if (mode === 'DRY' && decision === 'SKIP') {
    return '🔴 DRY RUN — SKIP';
  }

  if (mode === 'DRY' && decision === 'FAILED') {
    return '❌ DRY RUN — FAILED';
  }

  if (mode === 'LIVE' && decision === 'ORDER_PLACED') {
    return '🟢 LIVE — ORDER PLACED';
  }

  if (mode === 'LIVE' && decision === 'SKIP') {
    return '🔴 LIVE — SKIP';
  }

  return '❌ LIVE — FAILED';
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
    decision: TelegramTradeDecision;
    copyNotional: number;
    sourceAgeMs: number;
    reason?: string;
  }
): string {
  const sourceAgeSec = Math.max(0, options.sourceAgeMs) / 1000;

  const lines = [
    formatHeader(options.mode, options.decision),
    '',
    `📌 ${trade.market}`,
  ];

  if (options.reason) {
    lines.push('', `原因: ${options.reason}`);
  }

  lines.push(
    '',
    formatSideLine(trade),
    formatRiskLine(Number(trade.price || 0)),
    '',
    `💰 Copy: ${options.copyNotional.toFixed(2)} USDC`,
    `📊 Source: ${Number(trade.size || 0).toFixed(2)} USDC`,
    '',
    `⏱ 延遲: ${sourceAgeSec.toFixed(1)}s`,
  );

  return lines.join('\n');
}
