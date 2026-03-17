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

async function fetchResolvedOutcome(position: StoredPosition): Promise<string | null> {
  try {
    const { data } = await axios.get<any[]>('https://data-api.polymarket.com/markets', {
      params: {
        clob_token_ids: position.tokenId,
        limit: 1,
      },
      timeout: 15_000,
    });

    const market = Array.isArray(data) ? data[0] : undefined;
    if (!market) {
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
      return directWinner;
    }

    const tokens = Array.isArray(market.tokens) ? market.tokens : [];
    for (const token of tokens) {
      const candidateId = String(token?.token_id || token?.tokenId || token?.asset_id || token?.id || '');
      const isWinner = token?.winner === true || token?.winning === true || token?.isWinner === true;
      if (candidateId === position.tokenId && isWinner) {
        return normalizeOutcome(token?.outcome || token?.label || token?.name);
      }
    }

    const outcomes = parseOutcomes(market.outcomes);
    if (outcomes.length === tokens.length) {
      for (let i = 0; i < tokens.length; i++) {
        const candidateId = String(tokens[i]?.token_id || tokens[i]?.tokenId || tokens[i]?.asset_id || tokens[i]?.id || '');
        const isWinner = tokens[i]?.winner === true || tokens[i]?.winning === true || tokens[i]?.isWinner === true;
        if (candidateId === position.tokenId && isWinner) {
          return outcomes[i] || null;
        }
      }
    }
  } catch (error: any) {
    console.warn(`[SETTLEMENT] failed to fetch market resolution for tokenId=${position.tokenId}: ${error?.message || error}`);
  }

  return null;
}

function buildSettlementUpdate(position: StoredPosition, winningOutcome: string): Required<Pick<PositionEntry, 'status' | 'settledTs' | 'winningOutcome' | 'redeemable' | 'redeemAmount' | 'pnl' | 'pnlPct'>> {
  const isWin = normalizeOutcome(position.outcome) === normalizeOutcome(winningOutcome);
  const redeemAmount = isWin ? Number(position.entryShares || 0) : 0;
  const pnl = isWin ? redeemAmount - Number(position.entryNotional || 0) : -Number(position.entryNotional || 0);
  const pnlPct = Number(position.entryNotional || 0) > 0 ? (pnl / Number(position.entryNotional || 0)) * 100 : 0;

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
