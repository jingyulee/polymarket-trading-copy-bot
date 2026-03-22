import fetch from 'node-fetch';
import { config } from './config.js';
import {
  getLivePerformanceStats,
  getOpenLivePositions,
  getOpenSimPositions,
  getRecentSkipStats,
  getRecentTradeLogs,
  getSimPerformanceStats,
  type PerformanceStats,
  type RecentTradeLogRow,
  type SkipReasonStat,
  type StoredPosition,
} from './db.js';
import { sendTelegram } from './telegram.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const COMMAND_POLL_INTERVAL_MS = 5000;
const DEFAULT_OPEN_LIMIT = 10;
const DEFAULT_RECENT_LIMIT = 10;
const DEFAULT_SKIP_LIMIT = 200;
const SUPPORTED_COMMANDS = new Set(['/stats', '/simstats', '/livestats', '/open', '/recent', '/skips']);
const SKIP_REASONS = [
  'stale_trade',
  'market_already_executed',
  'source_trade_usd_too_small',
  'non_crypto_market',
  'slippage_gap_too_high',
];

let telegramUpdateOffset = 0;
let pollingStarted = false;

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id?: number | string;
    };
  };
}

function formatUsd(value: number): string {
  return `${value.toFixed(2)} USDC`;
}

function formatSignedUsd(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)} USDC`;
}

function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatTimestamp(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) {
    return '-';
  }

  const date = new Date(value);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function combinePerformanceStats(sim: PerformanceStats, live: PerformanceStats): PerformanceStats {
  const total_positions = sim.total_positions + live.total_positions;
  const open_positions = sim.open_positions + live.open_positions;
  const open_entry_notional = sim.open_entry_notional + live.open_entry_notional;
  const settled_positions = sim.settled_positions + live.settled_positions;
  const settled_win_count = sim.settled_win_count + live.settled_win_count;
  const settled_lose_count = sim.settled_lose_count + live.settled_lose_count;
  const settled_entry_notional = sim.settled_entry_notional + live.settled_entry_notional;
  const settled_redeem_amount = sim.settled_redeem_amount + live.settled_redeem_amount;
  const settled_pnl = sim.settled_pnl + live.settled_pnl;
  return {
    total_positions,
    open_positions,
    open_entry_notional,
    settled_positions,
    settled_win_count,
    settled_lose_count,
    settled_win_rate_pct: settled_positions > 0 ? (settled_win_count / settled_positions) * 100 : 0,
    settled_entry_notional,
    settled_redeem_amount,
    settled_pnl,
    total_entry_notional: sim.total_entry_notional + live.total_entry_notional,
  };
}

function formatPerformanceMessage(title: string, stats: PerformanceStats): string {
  if (stats.total_positions === 0) {
    return `${title}\n目前無資料`;
  }

  return [
    title,
    '',
    '已結算',
    `筆數: ${stats.settled_positions}`,
    `🎯 勝率: ${formatPct(stats.settled_win_rate_pct)}`,
    `💵 投入: ${formatUsd(stats.settled_entry_notional)}`,
    `🏦 redeem: ${formatUsd(stats.settled_redeem_amount)}`,
    `📈 pnl: ${formatSignedUsd(stats.settled_pnl)}`,
    '',
    '未結算',
    `筆數: ${stats.open_positions}`,
    `💵 佔用資金: ${formatUsd(stats.open_entry_notional)}`,
    '',
    '整體',
    `💵 總投入: ${formatUsd(stats.total_entry_notional)}`,
    `📊 當前 pnl（已結算）: ${formatSignedUsd(stats.settled_pnl)}`,
  ].join('\n');
}

function formatOpenPositionLine(typeLabel: 'SIM' | 'LIVE', position: StoredPosition): string {
  const marketSlug = String((position as any).marketSlug || (position as any).market_slug || '-');
  const outcome = String((position as any).outcome || '-').toUpperCase();
  const entryPrice = Number((position as any).entryPrice || (position as any).entry_price || 0);
  const entryNotional = Number((position as any).entryNotional || (position as any).entry_notional || 0);
  const entryTs = Number((position as any).entryTs || (position as any).entry_ts || 0);

  return [
    `${typeLabel} ${marketSlug}`,
    `${outcome} @ ${entryPrice.toFixed(4)}`,
    `${formatUsd(entryNotional)}`,
    formatTimestamp(entryTs),
  ].join(' | ');
}

function formatOpenPositionsMessage(): string {
  const rows = [
    ...getOpenSimPositions(DEFAULT_OPEN_LIMIT).map((position) => ({ type: 'SIM' as const, position })),
    ...getOpenLivePositions(DEFAULT_OPEN_LIMIT).map((position) => ({ type: 'LIVE' as const, position })),
  ]
    .sort((a, b) => {
      const aTs = Number((a.position as any).entryTs || (a.position as any).entry_ts || 0);
      const bTs = Number((b.position as any).entryTs || (b.position as any).entry_ts || 0);
      return bTs - aTs;
    })
    .slice(0, DEFAULT_OPEN_LIMIT);

  if (rows.length === 0) {
    return '📌 未結算\n目前無資料';
  }

  return [
    `📌 未結算 (前 ${rows.length} 筆)`,
    ...rows.map(({ type, position }) => formatOpenPositionLine(type, position)),
  ].join('\n');
}

function formatRecentTradeLogLine(row: RecentTradeLogRow): string {
  const marketSlug = row.market_slug || row.market || '-';
  const reason = row.reason || '-';
  const copyNotional = row.copy_notional != null ? formatUsd(Number(row.copy_notional || 0)) : '-';
  return [
    formatTimestamp(row.ts ?? undefined),
    marketSlug,
    row.action,
    reason,
    copyNotional,
  ].join(' | ');
}

function formatRecentTradeLogsMessage(): string {
  const rows = getRecentTradeLogs(DEFAULT_RECENT_LIMIT);
  if (rows.length === 0) {
    return '🕘 recent\n目前無資料';
  }

  return [
    `🕘 recent (最近 ${rows.length} 筆)`,
    ...rows.map((row) => formatRecentTradeLogLine(row)),
  ].join('\n');
}

function formatSkipStatsMessage(stats: SkipReasonStat[]): string {
  if (stats.length === 0) {
    return '🚫 skips\n目前無資料';
  }

  const counts = new Map(stats.map((item) => [item.reason, item.count]));
  return [
    `🚫 skips (最近 ${DEFAULT_SKIP_LIMIT} 筆 skip)`,
    ...SKIP_REASONS.map((reason) => `${reason}: ${counts.get(reason) || 0}`),
  ].join('\n');
}

export function buildTelegramCommandResponse(command: string): string | null {
  switch (command) {
    case '/stats': {
      return formatPerformanceMessage('📊 總覽', combinePerformanceStats(getSimPerformanceStats(), getLivePerformanceStats()));
    }
    case '/simstats': {
      return formatPerformanceMessage('🧪 SIM', getSimPerformanceStats());
    }
    case '/livestats': {
      return formatPerformanceMessage('📊 LIVE', getLivePerformanceStats());
    }
    case '/open': {
      return formatOpenPositionsMessage();
    }
    case '/recent': {
      return formatRecentTradeLogsMessage();
    }
    case '/skips': {
      return formatSkipStatsMessage(getRecentSkipStats(DEFAULT_SKIP_LIMIT));
    }
    default:
      return null;
  }
}

function normalizeCommand(text: string): string {
  return text.trim().split(/\s+/)[0]?.split('@')[0]?.toLowerCase() || '';
}

function isAuthorizedChat(chatId: string): boolean {
  const configuredChatId = String(config.notifications.telegramChatId || '').trim();
  if (!configuredChatId) {
    return true;
  }

  return configuredChatId === chatId;
}

async function fetchTelegramUpdates(): Promise<TelegramUpdate[]> {
  const token = config.notifications.telegramBotToken;
  if (!token) {
    return [];
  }

  const query = new URLSearchParams();
  if (telegramUpdateOffset > 0) {
    query.set('offset', String(telegramUpdateOffset));
  }
  query.set('timeout', '0');

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getUpdates?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`getUpdates HTTP ${response.status}`);
  }

  const data = await response.json() as { ok?: boolean; result?: TelegramUpdate[]; description?: string };
  if (!data.ok) {
    throw new Error(data.description || 'getUpdates failed');
  }

  return Array.isArray(data.result) ? data.result : [];
}

async function pollTelegramCommands(): Promise<void> {
  try {
    const updates = await fetchTelegramUpdates();
    for (const update of updates) {
      telegramUpdateOffset = Math.max(telegramUpdateOffset, update.update_id + 1);

      const text = String(update.message?.text || '').trim();
      const chatId = String(update.message?.chat?.id || '').trim();
      if (!text || !chatId || !isAuthorizedChat(chatId)) {
        continue;
      }

      const command = normalizeCommand(text);
      if (!SUPPORTED_COMMANDS.has(command)) {
        continue;
      }

      const response = buildTelegramCommandResponse(command);
      if (!response) {
        continue;
      }

      await sendTelegram(response, chatId);
      console.log(`[TELEGRAM] replied to ${command} for chat ${chatId}`);
    }
  } catch (error: any) {
    console.warn(`[TELEGRAM] command polling failed: ${error?.message || error}`);
  } finally {
    setTimeout(() => {
      void pollTelegramCommands();
    }, COMMAND_POLL_INTERVAL_MS);
  }
}

export function startTelegramCommandWatcher(): void {
  if (pollingStarted || !config.notifications.telegramBotToken) {
    return;
  }

  pollingStarted = true;
  void pollTelegramCommands();
}
