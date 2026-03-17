import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export type TradeLogAction = 'skip' | 'dry_run' | 'copy_success' | 'copy_fail';

export interface TradeLogEntry {
  ts?: number;
  market?: string;
  marketSlug?: string;
  tokenId?: string;
  side?: string;
  sourcePrice?: number;
  sourceSizeUsd?: number;
  sourceAgeMs?: number;
  action: TradeLogAction;
  reason?: string;
  orderId?: string;
  fillPrice?: number;
  fillSize?: number;
  copyNotional?: number;
}

const dbDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sessionStartedAt = Date.now();
const db = new Database(path.join(dbDir, 'trade-log.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS trade_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER,
    market TEXT,
    market_slug TEXT,
    token_id TEXT,
    side TEXT,
    source_price REAL,
    source_size_usd REAL,
    source_age_ms INTEGER,
    action TEXT NOT NULL,
    reason TEXT,
    order_id TEXT,
    fill_price REAL,
    fill_size REAL,
    copy_notional REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertTradeLog = db.prepare(`
  INSERT INTO trade_log (
    ts, market, market_slug, token_id, side,
    source_price, source_size_usd, source_age_ms,
    action, reason, order_id, fill_price, fill_size, copy_notional
  ) VALUES (
    @ts, @market, @marketSlug, @tokenId, @side,
    @sourcePrice, @sourceSizeUsd, @sourceAgeMs,
    @action, @reason, @orderId, @fillPrice, @fillSize, @copyNotional
  )
`);

export function logTrade(entry: TradeLogEntry): void {
  insertTradeLog.run({
    ts: entry.ts ?? Date.now(),
    market: entry.market ?? null,
    marketSlug: entry.marketSlug ?? null,
    tokenId: entry.tokenId ?? null,
    side: entry.side ?? null,
    sourcePrice: entry.sourcePrice ?? null,
    sourceSizeUsd: entry.sourceSizeUsd ?? null,
    sourceAgeMs: entry.sourceAgeMs ?? null,
    action: entry.action,
    reason: entry.reason ?? null,
    orderId: entry.orderId ?? null,
    fillPrice: entry.fillPrice ?? null,
    fillSize: entry.fillSize ?? null,
    copyNotional: entry.copyNotional ?? null,
  });
}

export function getRecentSkipStats(windowMs: number = 60 * 60 * 1000): Array<{ reason: string; count: number }> {
  const since = Date.now() - windowMs;
  const stmt = db.prepare(`
    SELECT COALESCE(reason, 'unknown') AS reason, COUNT(*) AS count
    FROM trade_log
    WHERE action = 'skip' AND ts >= ?
    GROUP BY COALESCE(reason, 'unknown')
    ORDER BY count DESC, reason ASC
  `);
  return stmt.all(since) as Array<{ reason: string; count: number }>;
}

export function getSessionStats(): {
  detected: number;
  skipped: number;
  dryRun: number;
  success: number;
  fail: number;
  copyNotional: number;
} {
  const stmt = db.prepare(`
    SELECT
      SUM(CASE WHEN action = 'skip' THEN 1 ELSE 0 END) AS skipped,
      SUM(CASE WHEN action = 'dry_run' THEN 1 ELSE 0 END) AS dry_run,
      SUM(CASE WHEN action = 'copy_success' THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN action = 'copy_fail' THEN 1 ELSE 0 END) AS fail,
      COALESCE(SUM(CASE WHEN action IN ('dry_run', 'copy_success') THEN copy_notional ELSE 0 END), 0) AS copy_notional
    FROM trade_log
    WHERE ts >= ?
  `);
  const row = stmt.get(sessionStartedAt) as any;
  const skipped = Number(row?.skipped || 0);
  const dryRun = Number(row?.dry_run || 0);
  const success = Number(row?.success || 0);
  const fail = Number(row?.fail || 0);
  return {
    detected: skipped + dryRun + success + fail,
    skipped,
    dryRun,
    success,
    fail,
    copyNotional: Number(row?.copy_notional || 0),
  };
}
