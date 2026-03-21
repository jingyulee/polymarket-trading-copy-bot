import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { envPath } from './config.js';

export type TradeLogAction =
  | 'skip'
  | 'dry_run'
  | 'copy_success'
  | 'copy_fail'
  | 'maker_fallback_placed'
  | 'maker_fallback_filled'
  | 'maker_fallback_cancelled'
  | 'signal_maker_entry_submitted'
  | 'signal_maker_entry_filled'
  | 'signal_maker_entry_partially_filled'
  | 'signal_maker_entry_cancelled'
  | 'signal_maker_entry_failed';

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

export interface PositionEntry {
  conditionId?: string;
  market?: string;
  marketSlug?: string;
  tokenId?: string;
  outcome?: string;
  side?: string;
  entryTs?: number;
  entryPrice?: number;
  entryShares?: number;
  entryNotional?: number;
  sourcePrice?: number;
  sourceSizeUsd?: number;
  orderId?: string | null;
  status?: 'open' | 'settled_win' | 'settled_lose' | 'redeemed';
  settledTs?: number | null;
  winningOutcome?: string | null;
  redeemable?: number;
  redeemAmount?: number;
  pnl?: number;
  pnlPct?: number;
}

export interface StoredPosition extends PositionEntry {
  id: number;
}

export interface RecentTradeLogRow {
  id: number;
  ts: number | null;
  market: string | null;
  market_slug: string | null;
  action: TradeLogAction;
  reason: string | null;
  copy_notional: number | null;
}

export interface SkipReasonStat {
  reason: string;
  count: number;
}

export interface PerformanceStats {
  total_positions: number;
  open_positions: number;
  open_entry_notional: number;
  settled_positions: number;
  settled_win_count: number;
  settled_lose_count: number;
  settled_win_rate_pct: number;
  settled_entry_notional: number;
  settled_redeem_amount: number;
  settled_pnl: number;
  total_entry_notional: number;
}

const sessionStartedAt = Date.now();
const configuredDbPath = (process.env.DB_PATH || './data/trade-log.sqlite').trim();
const resolvedDbPath = path.resolve(process.cwd(), configuredDbPath);
const dbDir = path.dirname(resolvedDbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
console.log(`DB_PATH: ${configuredDbPath} (${resolvedDbPath})`);
console.log(`Config source: ${envPath}`);
const db = new Database(resolvedDbPath);

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

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_trade (
    trade_key TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS market_lock (
    lock_key TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS positions_sim (
    -- 主鍵
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 市場唯一識別，每一局盤口
    condition_id TEXT,
    -- 市場名稱，例如 Bitcoin Up or Down
    market TEXT,
    -- 盤口 slug，例如 btc-updown-15m-xxxx
    market_slug TEXT,
    -- 對應 outcome 的 token
    token_id TEXT,
    -- 方向，例如 UP / DOWN
    outcome TEXT,
    -- BUY / SELL
    side TEXT,
    -- 進場時間 timestamp
    entry_ts INTEGER,
    -- 進場價格
    entry_price REAL,
    -- 購買的 shares 數量
    entry_shares REAL,
    -- 投入金額 USDC
    entry_notional REAL,
    -- 來源 trader 的價格
    source_price REAL,
    -- 來源 trader 的交易金額
    source_size_usd REAL,
    -- 真實下單的 order id，模擬可為 NULL
    order_id TEXT,
    -- 狀態：open / settled_win / settled_lose / redeemed
    status TEXT,
    -- 結算時間
    settled_ts INTEGER,
    -- 市場最終結果，例如 UP / DOWN
    winning_outcome TEXT,
    -- 是否可領回，1=可 redeem
    redeemable INTEGER DEFAULT 0,
    -- 實際可領回金額
    redeem_amount REAL DEFAULT 0,
    -- 損益
    pnl REAL DEFAULT 0,
    -- 報酬率 %
    pnl_pct REAL DEFAULT 0,
    -- 建立時間
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- 更新時間
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS positions_live (
    -- 主鍵
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- 市場唯一識別，每一局盤口
    condition_id TEXT,
    -- 市場名稱，例如 Bitcoin Up or Down
    market TEXT,
    -- 盤口 slug，例如 btc-updown-15m-xxxx
    market_slug TEXT,
    -- 對應 outcome 的 token
    token_id TEXT,
    -- 方向，例如 UP / DOWN
    outcome TEXT,
    -- BUY / SELL
    side TEXT,
    -- 進場時間 timestamp
    entry_ts INTEGER,
    -- 進場價格
    entry_price REAL,
    -- 購買的 shares 數量
    entry_shares REAL,
    -- 投入金額 USDC
    entry_notional REAL,
    -- 來源 trader 的價格
    source_price REAL,
    -- 來源 trader 的交易金額
    source_size_usd REAL,
    -- 真實下單的 order id，模擬可為 NULL
    order_id TEXT,
    -- 狀態：open / settled_win / settled_lose / redeemed
    status TEXT,
    -- 結算時間
    settled_ts INTEGER,
    -- 市場最終結果，例如 UP / DOWN
    winning_outcome TEXT,
    -- 是否可領回，1=可 redeem
    redeemable INTEGER DEFAULT 0,
    -- 實際可領回金額
    redeem_amount REAL DEFAULT 0,
    -- 損益
    pnl REAL DEFAULT 0,
    -- 報酬率 %
    pnl_pct REAL DEFAULT 0,
    -- 建立時間
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- 更新時間
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

const insertProcessedTrade = db.prepare(`
  INSERT OR IGNORE INTO processed_trade (trade_key, ts)
  VALUES (?, ?)
`);

const insertMarketLock = db.prepare(`
  INSERT OR IGNORE INTO market_lock (lock_key, ts)
  VALUES (?, ?)
`);

const deleteMarketLockStmt = db.prepare(`
  DELETE FROM market_lock WHERE lock_key = ?
`);

function createInsertPositionStatement(tableName: 'positions_sim' | 'positions_live') {
  return db.prepare(`
    INSERT INTO ${tableName} (
      condition_id, market, market_slug, token_id, outcome, side,
      entry_ts, entry_price, entry_shares, entry_notional,
      source_price, source_size_usd, order_id, status,
      settled_ts, winning_outcome, redeemable, redeem_amount, pnl, pnl_pct
    ) VALUES (
      @conditionId, @market, @marketSlug, @tokenId, @outcome, @side,
      @entryTs, @entryPrice, @entryShares, @entryNotional,
      @sourcePrice, @sourceSizeUsd, @orderId, @status,
      @settledTs, @winningOutcome, @redeemable, @redeemAmount, @pnl, @pnlPct
    )
  `);
}

function createLoadOpenPositionsStatement(tableName: 'positions_sim' | 'positions_live') {
  return db.prepare(`
    SELECT *
    FROM ${tableName}
    WHERE status = 'open'
    ORDER BY entry_ts ASC, id ASC
  `);
}

function createGetOpenPositionsStatement(tableName: 'positions_sim' | 'positions_live') {
  return db.prepare(`
    SELECT *
    FROM ${tableName}
    WHERE status = 'open'
    ORDER BY entry_ts DESC, id DESC
    LIMIT ?
  `);
}

function createResolvePositionStatement(tableName: 'positions_sim' | 'positions_live') {
  return db.prepare(`
    UPDATE ${tableName}
    SET
      status = @status,
      settled_ts = @settledTs,
      winning_outcome = @winningOutcome,
      redeemable = @redeemable,
      redeem_amount = @redeemAmount,
      pnl = @pnl,
      pnl_pct = @pnlPct,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);
}

function createPerformanceStatsStatement(tableName: 'positions_sim' | 'positions_live') {
  return db.prepare(`
    SELECT
      COUNT(*) AS total_positions,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_positions,
      COALESCE(SUM(CASE WHEN status = 'open' THEN entry_notional ELSE 0 END), 0) AS open_entry_notional,
      SUM(CASE WHEN status IN ('settled_win', 'settled_lose', 'redeemed') THEN 1 ELSE 0 END) AS settled_positions,
      SUM(CASE WHEN status = 'settled_win' OR status = 'redeemed' THEN 1 ELSE 0 END) AS settled_win_count,
      SUM(CASE WHEN status = 'settled_lose' THEN 1 ELSE 0 END) AS settled_lose_count,
      COALESCE(SUM(CASE WHEN status IN ('settled_win', 'settled_lose', 'redeemed') THEN entry_notional ELSE 0 END), 0) AS settled_entry_notional,
      COALESCE(SUM(CASE WHEN status IN ('settled_win', 'settled_lose', 'redeemed') THEN redeem_amount ELSE 0 END), 0) AS settled_redeem_amount,
      COALESCE(SUM(CASE WHEN status IN ('settled_win', 'settled_lose', 'redeemed') THEN pnl ELSE 0 END), 0) AS settled_pnl,
      COALESCE(SUM(entry_notional), 0) AS total_entry_notional
    FROM ${tableName}
  `);
}

const insertSimPositionStmt = createInsertPositionStatement('positions_sim');
const insertLivePositionStmt = createInsertPositionStatement('positions_live');
const loadOpenSimPositionsStmt = createLoadOpenPositionsStatement('positions_sim');
const loadOpenLivePositionsStmt = createLoadOpenPositionsStatement('positions_live');
const getOpenSimPositionsStmt = createGetOpenPositionsStatement('positions_sim');
const getOpenLivePositionsStmt = createGetOpenPositionsStatement('positions_live');
const resolveSimPositionStmt = createResolvePositionStatement('positions_sim');
const resolveLivePositionStmt = createResolvePositionStatement('positions_live');
const simPerformanceStatsStmt = createPerformanceStatsStatement('positions_sim');
const livePerformanceStatsStmt = createPerformanceStatsStatement('positions_live');
const recentTradeLogsStmt = db.prepare(`
  SELECT id, ts, market, market_slug, action, reason, copy_notional
  FROM trade_log
  ORDER BY ts DESC, id DESC
  LIMIT ?
`);
const recentSkipStatsStmt = db.prepare(`
  SELECT COALESCE(reason, 'unknown') AS reason, COUNT(*) AS count
  FROM (
    SELECT reason
    FROM trade_log
    WHERE action = 'skip'
    ORDER BY ts DESC, id DESC
    LIMIT ?
  )
  GROUP BY COALESCE(reason, 'unknown')
  ORDER BY count DESC, reason ASC
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

export function persistProcessedTradeKey(tradeKey: string, ts: number = Date.now()): void {
  insertProcessedTrade.run(tradeKey, ts);
}

export function persistMarketLock(lockKey: string, ts: number = Date.now()): void {
  insertMarketLock.run(lockKey, ts);
}

export function removeMarketLock(lockKey: string): void {
  deleteMarketLockStmt.run(lockKey);
}

export function loadRecentProcessedTradeKeys(windowMs: number = 7 * 24 * 60 * 60 * 1000): string[] {
  const since = Date.now() - windowMs;
  const stmt = db.prepare(`
    SELECT trade_key
    FROM processed_trade
    WHERE ts >= ?
    ORDER BY ts ASC
  `);
  const rows = stmt.all(since) as Array<{ trade_key: string }>;
  return rows.map((row) => row.trade_key);
}

export function loadRecentMarketLocks(windowMs: number = 7 * 24 * 60 * 60 * 1000): string[] {
  const since = Date.now() - windowMs;
  const stmt = db.prepare(`
    SELECT lock_key
    FROM market_lock
    WHERE ts >= ?
    ORDER BY ts ASC
  `);
  const rows = stmt.all(since) as Array<{ lock_key: string }>;
  return rows.map((row) => row.lock_key);
}

export function getSkipStatsByWindow(windowMs: number = 60 * 60 * 1000): SkipReasonStat[] {
  const since = Date.now() - windowMs;
  const stmt = db.prepare(`
    SELECT COALESCE(reason, 'unknown') AS reason, COUNT(*) AS count
    FROM trade_log
    WHERE action = 'skip' AND ts >= ?
    GROUP BY COALESCE(reason, 'unknown')
    ORDER BY count DESC, reason ASC
  `);
  return stmt.all(since) as SkipReasonStat[];
}

export function getRecentSkipStats(limit: number = 200): SkipReasonStat[] {
  return recentSkipStatsStmt.all(Math.max(1, Math.floor(limit))) as SkipReasonStat[];
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

function insertPosition(stmt: Database.Statement, entry: PositionEntry): void {
  stmt.run({
    conditionId: entry.conditionId ?? null,
    market: entry.market ?? null,
    marketSlug: entry.marketSlug ?? null,
    tokenId: entry.tokenId ?? null,
    outcome: entry.outcome ?? null,
    side: entry.side ?? null,
    entryTs: entry.entryTs ?? Date.now(),
    entryPrice: entry.entryPrice ?? 0,
    entryShares: entry.entryShares ?? 0,
    entryNotional: entry.entryNotional ?? 0,
    sourcePrice: entry.sourcePrice ?? null,
    sourceSizeUsd: entry.sourceSizeUsd ?? null,
    orderId: entry.orderId ?? null,
    status: entry.status ?? 'open',
    settledTs: entry.settledTs ?? null,
    winningOutcome: entry.winningOutcome ?? null,
    redeemable: entry.redeemable ?? 0,
    redeemAmount: entry.redeemAmount ?? 0,
    pnl: entry.pnl ?? 0,
    pnlPct: entry.pnlPct ?? 0,
  });
}

export function insertSimPosition(entry: PositionEntry): void {
  insertPosition(insertSimPositionStmt, entry);
}

export function insertLivePosition(entry: PositionEntry): void {
  insertPosition(insertLivePositionStmt, entry);
}

export function loadOpenSimPositions(): StoredPosition[] {
  return loadOpenSimPositionsStmt.all() as StoredPosition[];
}

export function loadOpenLivePositions(): StoredPosition[] {
  return loadOpenLivePositionsStmt.all() as StoredPosition[];
}

export function getOpenSimPositions(limit: number = 10): StoredPosition[] {
  return getOpenSimPositionsStmt.all(Math.max(1, Math.floor(limit))) as StoredPosition[];
}

export function getOpenLivePositions(limit: number = 10): StoredPosition[] {
  return getOpenLivePositionsStmt.all(Math.max(1, Math.floor(limit))) as StoredPosition[];
}

export function getRecentTradeLogs(limit: number = 10): RecentTradeLogRow[] {
  return recentTradeLogsStmt.all(Math.max(1, Math.floor(limit))) as RecentTradeLogRow[];
}

function resolvePosition(stmt: Database.Statement, positionId: number, entry: Required<Pick<PositionEntry, 'status' | 'settledTs' | 'winningOutcome' | 'redeemable' | 'redeemAmount' | 'pnl' | 'pnlPct'>>): void {
  stmt.run({
    id: positionId,
    status: entry.status,
    settledTs: entry.settledTs,
    winningOutcome: entry.winningOutcome,
    redeemable: entry.redeemable,
    redeemAmount: entry.redeemAmount,
    pnl: entry.pnl,
    pnlPct: entry.pnlPct,
  });
}

export function resolveSimPosition(positionId: number, entry: Required<Pick<PositionEntry, 'status' | 'settledTs' | 'winningOutcome' | 'redeemable' | 'redeemAmount' | 'pnl' | 'pnlPct'>>): void {
  resolvePosition(resolveSimPositionStmt, positionId, entry);
}

export function resolveLivePosition(positionId: number, entry: Required<Pick<PositionEntry, 'status' | 'settledTs' | 'winningOutcome' | 'redeemable' | 'redeemAmount' | 'pnl' | 'pnlPct'>>): void {
  resolvePosition(resolveLivePositionStmt, positionId, entry);
}

function normalizePerformanceStats(row: any): PerformanceStats {
  const total_positions = Number(row?.total_positions || 0);
  const open_positions = Number(row?.open_positions || 0);
  const open_entry_notional = Number(row?.open_entry_notional || 0);
  const settled_positions = Number(row?.settled_positions || 0);
  const settled_win_count = Number(row?.settled_win_count || 0);
  const settled_lose_count = Number(row?.settled_lose_count || 0);
  return {
    total_positions,
    open_positions,
    open_entry_notional,
    settled_positions,
    settled_win_count,
    settled_lose_count,
    settled_win_rate_pct: settled_positions > 0 ? (settled_win_count / settled_positions) * 100 : 0,
    settled_entry_notional: Number(row?.settled_entry_notional || 0),
    settled_redeem_amount: Number(row?.settled_redeem_amount || 0),
    settled_pnl: Number(row?.settled_pnl || 0),
    total_entry_notional: Number(row?.total_entry_notional || 0),
  };
}

export function getSimPerformanceStats(): PerformanceStats {
  return normalizePerformanceStats(simPerformanceStatsStmt.get());
}

export function getLivePerformanceStats(): PerformanceStats {
  return normalizePerformanceStats(livePerformanceStatsStmt.get());
}
