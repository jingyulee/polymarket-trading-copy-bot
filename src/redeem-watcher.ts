import fetch from 'node-fetch';
import { sendTelegram } from './telegram.js';

interface RedeemWatcherConfig {
  monitoring: {
    redeemCheckIntervalMs: number;
  };
  notifications: {
    telegramChatId: string;
    telegramRedeemChatId: string;
  };
}

interface RedeemablePosition {
  conditionId?: string;
  condition_id?: string;
  title?: string;
  market?: string;
  question?: string;
  outcome?: string;
  size?: number | string;
  redeemable?: number | string;
  redeemableAmount?: number | string;
  claimable?: number | string;
}

const notifiedRedeems = new Set<string>();

function normalizeNumber(value: unknown): number {
  const num = typeof value === 'string' ? Number(value) : Number(value);
  return Number.isFinite(num) ? num : 0;
}

function getRedeemKey(position: RedeemablePosition): string {
  const conditionId = position.conditionId || position.condition_id || position.title || position.market || 'unknown-condition';
  const outcome = String(position.outcome || 'UNKNOWN').trim().toUpperCase();
  return `${conditionId}|${outcome}`;
}

function buildRedeemMessage(position: RedeemablePosition): string {
  const title = position.title || position.market || position.question || 'Unknown market';
  const outcome = position.outcome || 'UNKNOWN';
  const size = normalizeNumber(position.size);
  const redeemableUsdc = normalizeNumber(position.redeemableAmount ?? position.redeemable ?? position.claimable ?? position.size);
  return [
    '[REDEEMABLE POSITION]',
    `Market: ${title}`,
    `Outcome: ${outcome}`,
    `Size: ${size.toFixed(4)}`,
    `Redeemable USDC: ${redeemableUsdc.toFixed(4)}`,
  ].join('\n');
}

async function checkRedeemablePositions(config: RedeemWatcherConfig, userAddress: string): Promise<void> {
  if (!userAddress) {
    return;
  }

  console.log('[REDEEM] checking positions...');

  try {
    const url = new URL('https://data-api.polymarket.com/positions');
    url.searchParams.set('user', userAddress);
    url.searchParams.set('redeemable', 'true');
    url.searchParams.set('sizeThreshold', '0.01');

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`[REDEEM] request failed (${response.status})`);
      return;
    }

    const data = await response.json();
    const positions = Array.isArray(data) ? data as RedeemablePosition[] : [];

    if (positions.length === 0) {
      console.log('[REDEEM] none');
      return;
    }

    console.log(`[REDEEM] found ${positions.length} redeemable positions`);

    for (const position of positions) {
      const key = getRedeemKey(position);
      if (notifiedRedeems.has(key)) {
        continue;
      }

      const chatId = config.notifications.telegramRedeemChatId || config.notifications.telegramChatId || undefined;
      await sendTelegram(buildRedeemMessage(position), chatId);
      notifiedRedeems.add(key);
      console.log('[REDEEM] notify sent');
    }
  } catch (error: any) {
    console.error('[REDEEM] check failed:', error?.message || error);
  }
}

export function startRedeemWatcher(config: RedeemWatcherConfig, userAddress: string): void {
  const run = () => {
    void checkRedeemablePositions(config, userAddress);
  };

  setTimeout(run, 5000);
  setInterval(run, Math.max(1000, config.monitoring.redeemCheckIntervalMs || 60000));
}
