import axios from 'axios';
import {
  loadOpenLivePositions,
  loadOpenSimPositions,
  resolveLivePosition,
  resolveSimPosition,
  type PositionEntry,
  type StoredPosition,
} from './db.js';

interface SettlementUpdaterConfig {
  monitoring: {
    settlementCheckIntervalMs: number;
  };
}

const GAMMA_MARKETS_URL = 'https://gamma-api.polymarket.com/markets';

function getPositionFields(position: StoredPosition): {
  tokenId: string;
  conditionId: string;
  marketSlug: string;
  outcome: string;
  lookupKey: string;
} {
  const tokenId = String((position as any).tokenId || (position as any).token_id || '').trim();
  const conditionId = String((position as any).conditionId || (position as any).condition_id || '').trim();
  const marketSlug = String((position as any).marketSlug || (position as any).market_slug || '').trim();
  const outcome = String((position as any).outcome || (position as any).outcome_name || '').trim().toUpperCase();
  const lookupKey = tokenId || conditionId || marketSlug || `position:${position.id}`;

  return { tokenId, conditionId, marketSlug, outcome, lookupKey };
}

function normalizeOutcome(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

function parseOutcomes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOutcome(item)).filter(Boolean);
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => normalizeOutcome(item)).filter(Boolean);
      }
    } catch {
      return value.split(',').map((item) => normalizeOutcome(item)).filter(Boolean);
    }
  }

  return [];
}

function parseOutcomePrices(value: unknown): number[] {
  const normalizePrices = (items: unknown[]): number[] => items
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));

  if (Array.isArray(value)) {
    return normalizePrices(value);
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return normalizePrices(parsed);
      }
    } catch {
      return normalizePrices(value.split(',').map((item) => item.trim()));
    }
  }

  return [];
}

async function fetchResolvedOutcome(position: StoredPosition): Promise<string | null> {
  const { tokenId, conditionId, marketSlug, lookupKey } = getPositionFields(position);

  if (!tokenId && !conditionId && !marketSlug) {
    console.warn(`[SETTLEMENT] skip position id=${position.id}: missing token_id / condition_id / market_slug`);
    return null;
  }

  try {
    let market: any | undefined;
    let resolutionSource = '';

    if (conditionId) {
      console.log(`[SETTLEMENT] lookup by condition_id=${conditionId}`);
      const { data } = await axios.get<any[]>(GAMMA_MARKETS_URL, {
        params: {
          condition_ids: conditionId,
          limit: 1,
        },
        timeout: 15_000,
      });
      market = Array.isArray(data) ? data[0] : undefined;
      resolutionSource = `condition_id=${conditionId}`;
    }

    if (!market && marketSlug) {
      console.log(`[SETTLEMENT] lookup by market_slug=${marketSlug}`);
      const { data } = await axios.get<any[]>(GAMMA_MARKETS_URL, {
        params: {
          slug: marketSlug,
          limit: 1,
        },
        timeout: 15_000,
      });
      market = Array.isArray(data) ? data[0] : undefined;
      resolutionSource = `market_slug=${marketSlug}`;
    }

    if (!market) {
      console.warn(`[SETTLEMENT] could not resolve market metadata for ${lookupKey} via condition_id / market_slug`);
      return null;
    }

    const directWinner = normalizeOutcome(
      market.winning_outcome ||
      market.winningOutcome ||
      market.resolved_outcome ||
      market.resolvedOutcome ||
      market.result ||
      market.winner
    );
    if (directWinner) {
      console.log(`[SETTLEMENT] market resolved via ${resolutionSource}`);
      return directWinner;
    }

    const tokens = Array.isArray(market.tokens) ? market.tokens : [];
    for (const token of tokens) {
      const candidateId = String(token?.token_id || token?.tokenId || token?.asset_id || token?.id || '');
      const isWinner = token?.winner === true || token?.winning === true || token?.isWinner === true;
      if (candidateId === tokenId && isWinner) {
        console.log(`[SETTLEMENT] token winner matched via ${resolutionSource}`);
        return normalizeOutcome(token?.outcome || token?.label || token?.name);
      }
    }

    const outcomes = parseOutcomes(market.outcomes);
    if (outcomes.length === tokens.length) {
      for (let i = 0; i < tokens.length; i++) {
        const candidateId = String(tokens[i]?.token_id || tokens[i]?.tokenId || tokens[i]?.asset_id || tokens[i]?.id || '');
        const isWinner = tokens[i]?.winner === true || tokens[i]?.winning === true || tokens[i]?.isWinner === true;
        if (candidateId === tokenId && isWinner) {
          console.log(`[SETTLEMENT] token winner matched via ${resolutionSource}`);
          return outcomes[i] || null;
        }
      }
    }

    const isResolved = normalizeOutcome(market.umaResolutionStatus) === 'RESOLVED' || market.closed === true;
    const outcomePrices = parseOutcomePrices(market.outcomePrices);
    if (isResolved && outcomes.length > 0 && outcomePrices.length === outcomes.length) {
      const winningIndex = outcomePrices.findIndex((price) => price >= 0.999);
      if (winningIndex >= 0) {
        const inferredWinner = outcomes[winningIndex] || null;
        if (inferredWinner) {
          console.log(`[SETTLEMENT] inferred winner from outcomePrices via ${resolutionSource}`);
          return inferredWinner;
        }
      }
    }
  } catch (error: any) {
    console.warn(`[SETTLEMENT] failed to fetch market resolution for ${lookupKey} via condition_id / market_slug: ${error?.message || error}`);
  }

  return null;
}

function buildSettlementUpdate(position: StoredPosition, winningOutcome: string): Required<Pick<PositionEntry, 'status' | 'settledTs' | 'winningOutcome' | 'redeemable' | 'redeemAmount' | 'pnl' | 'pnlPct'>> {
  const { outcome } = getPositionFields(position);
  const entryShares = Number((position as any).entryShares || (position as any).entry_shares || 0);
  const entryNotional = Number((position as any).entryNotional || (position as any).entry_notional || 0);
  const isWin = outcome === normalizeOutcome(winningOutcome);
  const redeemAmount = isWin ? entryShares : 0;
  const pnl = isWin ? redeemAmount - entryNotional : -entryNotional;
  const pnlPct = entryNotional > 0 ? (pnl / entryNotional) * 100 : 0;

  return {
    status: isWin ? 'settled_win' : 'settled_lose',
    settledTs: Date.now(),
    winningOutcome,
    redeemable: isWin ? 1 : 0,
    redeemAmount,
    pnl,
    pnlPct,
  };
}

async function resolvePositions(
  tableLabel: 'sim' | 'live',
  positions: StoredPosition[],
  resolver: (positionId: number, entry: Required<Pick<PositionEntry, 'status' | 'settledTs' | 'winningOutcome' | 'redeemable' | 'redeemAmount' | 'pnl' | 'pnlPct'>>) => void
): Promise<number> {
  let resolvedCount = 0;

  for (const position of positions) {
    try {
      const winningOutcome = await fetchResolvedOutcome(position);
      if (!winningOutcome) {
        continue;
      }

      resolver(position.id, buildSettlementUpdate(position, winningOutcome));
      resolvedCount++;
      console.log(`[SETTLEMENT] resolved position (${tableLabel}) id=${position.id} winner=${winningOutcome}`);
    } catch (error: any) {
      console.warn(`[SETTLEMENT] failed to resolve position (${tableLabel}) id=${position.id}: ${error?.message || error}`);
    }
  }

  return resolvedCount;
}

async function checkOpenPositions(): Promise<void> {
  console.log('[SETTLEMENT] checking open positions');

  try {
    const [simOpenPositions, liveOpenPositions] = [loadOpenSimPositions(), loadOpenLivePositions()];
    const [resolvedSim, resolvedLive] = await Promise.all([
      resolvePositions('sim', simOpenPositions, resolveSimPosition),
      resolvePositions('live', liveOpenPositions, resolveLivePosition),
    ]);

    if (resolvedSim + resolvedLive === 0) {
      console.log('[SETTLEMENT] no resolved positions');
    }
  } catch (error: any) {
    console.warn(`[SETTLEMENT] check failed: ${error?.message || error}`);
  }
}

export function startSettlementUpdater(config: SettlementUpdaterConfig): void {
  const run = () => {
    void checkOpenPositions();
  };

  setTimeout(run, 5000);
  setInterval(run, Math.max(1000, config.monitoring.settlementCheckIntervalMs || 60000));
}
