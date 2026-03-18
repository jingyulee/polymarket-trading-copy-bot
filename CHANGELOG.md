# 2026-03-16 安全重建紀錄

- 發現 `big-nunber` 與 `ts-bign` 兩個已知可疑 typo-squatting 套件，同時存在於 `package.json` 與實際 import 路徑。
- 由於污染依賴已進入執行路徑，原 repo 不應再被視為可直接信任的執行基線。
- 已移除可疑依賴與對應 import，改用原生數值運算取代部位僅限持倉平均價與總額計算。
- 已刪除 `generate-api-creds` 與 `test-api-creds` 兩個非核心腳本，避免額外的私密資料落地與不必要攻擊面。
- 已重建最小化 `package.json`，只保留核心監控與交易流程需要的主流依賴。
- 已移除啟動時自動送出 `approve` / `setApprovalForAll` 的行為，改成只讀檢查錢包 readiness，降低誤授權與無上限授權風險。
- 審查期間未在 repo 原始碼中發現明確的 `.ssh` 竊取、`.env` 外傳、任意 shell 執行、惡意 webhook、或將資金轉往不明地址的硬編碼邏輯。
- 建議淘汰原 repo 的信任鏈，僅保留已人工審閱且可驗證的業務邏輯，作為後續二次開發基線。

# 2026-03-19 Orderbook Handling Fixes

- fix: treat missing orderbook (404 "No orderbook exists") as skip with reason `no_orderbook_exists`
- fix: normalize null/undefined orderbook to { bids: [], asks: [] } to prevent undefined.length errors
- add canonical outcome to execution debug logs
- ensure all orderbook access is safe with optional chaining

# 2026-03-19 Execution Debug and Skip Logic

- fix: treat empty ask/bid orderbook as skip instead of fail, with reasons `no_asks_in_orderbook` or `no_bids_in_orderbook`
- add debug logs in executeLimitOrder and executeMarketOrder for execution details: tokenId, market, source side/outcome, orderbook stats, best prices, top 3 bids/asks
- update error handling to count skips in stats and trade_log instead of fails
- prevent retries for skip conditions

# 2026-03-19 CLOB Allowance Parsing Fix

- fix: parse clob allowances map by exchange address in validateBalance()
- add debug logs for current exchangeAddress and resolved clob allowance
- update error message to include exchangeAddress for better debugging

# 2026-03-17 v32 Sharky 策略整合

- 整合 v32 strategy filters，加入 BUY only、來源價格區間、30 秒 stale trade guard、crypto-only market filter、10 bps slippage guard、價格偏離保護與單市場單次交易鎖。
- 新增 `DRY_RUN` 模式與最小侵入式主流程調整，保留既有 execution engine，讓偵測、過濾、dry-run、實單、成功與失敗都走同一條事件管線。
- 新增 SQLite `trade_log`，將 `skip`、`dry_run`、`copy_success`、`copy_fail` 全部持久化，並提供近期 skip 與 session stats 查詢。
- 新增 Telegram 通知與 5 秒 dedupe 視窗，避免重複訊號轟炸且不阻斷主流程。
- 補齊 `.env.example` 的所有實際 env keys，加入 Telegram 相關欄位，避免因範例檔漏設造成通知未啟用。
- feat: add redeem watcher (auto notify redeemable positions)
- add `REDEEM_CHECK_INTERVAL_MS` env
- add `TELEGRAM_REDEEM_CHAT_ID` support
- fix: resolve UNKNOWN outcome by mapping tokenId to outcome label
- feat: make crypto filter configurable via env
- feat: persist market lock and processed trade dedupe
- feat: add source trader whitelist support
- chore: improve telegram notification clarity
- feat: add positions_sim and positions_live
- feat: add settlement updater
- feat: add pnl and win rate stats
- fix: support snake_case position fields in settlement updater
- fix: use condition_id / market_slug for settlement resolution lookup instead of token_id
- fix: use gamma-api markets endpoint in settlement updater
- fix: infer winning outcome from outcomePrices in settlement updater
- feat: add telegram monitoring commands
- feat: add telegram_commands.md documentation
- improve: restructure telegram stats output into settled/open/overall sections
- improve: unify telegram trade notification format for dry run and live
- feat: add price risk indicator in telegram trade notification
- improve: unify telegram trade notification layout for dry run and live
- feat: add unified decision header for trade notifications
- fix: restore fill price and fill size in live trade notification
- feat: merge performance tracking system (trade_log, positions, market_lock, telegram stats)
- note: live fill display will be completed in next iteration
- fix: use funder address for balance and allowance checks in proxy mode
- improve: clarify signer and funder initialization logs
- experiment: add maker fallback limit buy when asks are empty
- fix: use market fee rate for maker fallback orders
