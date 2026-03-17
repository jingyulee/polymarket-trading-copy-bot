# BOT 規則盤點

最後更新：依目前 `main` 工作樹實際程式碼盤點，不新增推測規則。

## 1. Source 規則（來源）

- `TARGET_WALLET` 是預設來源 trader。
  來源檔案：`src/config.ts`、`src/monitor.ts`、`src/websocket-monitor.ts`
- 若 `SOURCE_TRADER_WHITELIST` 有設定值，REST 與 WebSocket 都會改成只追白名單內地址，不再只用 `TARGET_WALLET`。
  來源檔案：`src/config.ts`、`src/monitor.ts`、`src/websocket-monitor.ts`
- REST 監控不會抓全市場。
  實作方式：`src/monitor.ts` 會對每個允許的 source trader 呼叫 Data API `activity?user=<address>&type=TRADE`。
- WebSocket 監控也不會無條件抓全市場成交。
  實作方式：`src/websocket-monitor.ts` 在收到 `last_trade_price` 後，還會檢查 `maker` 或 `taker` 是否在允許名單內，不在名單就直接丟棄。
- 若 `SOURCE_TRADER_WHITELIST` 為空，行為是「只跟 `TARGET_WALLET`」，不是全市場亂抓。
  來源檔案：`src/monitor.ts`、`src/websocket-monitor.ts`
- 例外注意：
  若 WebSocket 使用 `market` channel 且訂閱了很多 market，訊息來源本身可能很多，但最終仍會被 `maker/taker` 白名單再次過濾。
  來源檔案：`src/websocket-monitor.ts`

## 2. Market filter

- 有 `MARKET_SCOPE`。
  來源檔案：`src/config.ts`
- 目前支援：
  - `MARKET_SCOPE=all`：直接放行，不做 crypto keyword 過濾。
  - `MARKET_SCOPE=crypto-only`：啟用 crypto market filter。
  來源檔案：`src/filter.ts`
- crypto 判斷不是 hardcode 在 `filter.ts`，而是讀 `CRYPTO_KEYWORDS` env 後放在 `config.trading.cryptoKeywords`。
  來源檔案：`src/config.ts`、`src/filter.ts`
- crypto 判斷欄位目前使用：
  - `market`
  - `marketSlug`
  - `title`
  - `outcome`
  - `outcomeName`
  來源檔案：`src/filter.ts`
- crypto 判斷邏輯是單純字串 `includes()`。
  來源檔案：`src/filter.ts`
- 是否可能誤判：會。
  - 若市場文字沒有帶到關鍵字，即使實際是 crypto 市場，也可能被判成 `non_crypto_market`。
  - 若文字剛好包含關鍵字，也可能被誤放行。
  - `BNB`、`Hyperliquid` 目前已在預設 `CRYPTO_KEYWORDS` 內，不再像舊版那樣因 hardcode 遺漏。
  來源檔案：`src/config.ts`、`src/filter.ts`

## 3. Trade 過濾條件（會 skip 的）

以下是目前實際會阻止下單或阻止進一步執行的條件。

- 舊訊號不處理。
  - 判斷條件：`trade.timestamp < botStartTime`
  - 結果：直接 return，不記為 `skip`
  - 來源檔案：`src/index.ts`
  - 是否一定會 skip：是

- 重複 trade 不處理。
  - 判斷條件：`processedTrades` 已存在任一 trade key
  - trade key 來源：`txHash`，以及 fallback `tokenId|side|size|price|timestamp`
  - 結果：直接 return，不記為 `skip`
  - 來源檔案：`src/index.ts`
  - 是否一定會 skip：是

- `copyOnlyBuy` 啟用且來源單為 `SELL`。
  - 判斷條件：`config.trading.copyOnlyBuy && trade.side !== 'BUY'`
  - skip reason：`skip_sell_trade`
  - 來源檔案：`src/filter.ts`
  - 是否一定會 skip：是

- 來源價格不在允許範圍。
  - 判斷條件：`price < MIN_SOURCE_PRICE` 或 `price > MAX_SOURCE_PRICE`，或 price 非數字
  - skip reason：`source_price_out_of_range`
  - 來源檔案：`src/filter.ts`
  - 是否一定會 skip：是

- 來源單金額太小。
  - 判斷條件：`size < MIN_SOURCE_TRADE_USD`，或 size 非數字
  - skip reason：`source_trade_usd_too_small`
  - 來源檔案：`src/filter.ts`
  - 是否一定會 skip：是

- 來源單太舊。
  - 判斷條件：`now - trade.timestamp > MAX_SOURCE_TRADE_AGE_MS`
  - skip reason：`stale_trade`
  - 來源檔案：`src/filter.ts`
  - 是否一定會 skip：是

- `MARKET_SCOPE=crypto-only` 且 market metadata 不足。
  - 判斷條件：`market / slug / title / outcome / outcomeName` 全空
  - skip reason：`market_metadata_missing`
  - 來源檔案：`src/filter.ts`
  - 是否一定會 skip：是，在 `crypto-only` 模式下才成立

- `MARKET_SCOPE=crypto-only` 且未命中任何 crypto keyword。
  - 判斷條件：上述文字欄位沒有任何一個包含 `config.trading.cryptoKeywords`
  - skip reason：`non_crypto_market`
  - 來源檔案：`src/filter.ts`
  - 是否一定會 skip：是，在 `crypto-only` 模式下才成立

- 同一 market 已上鎖。
  - 判斷條件：`ONE_TRADE_PER_MARKET=true` 且 `marketLocks` 已含 `getMarketLockKey(trade)`
  - skip reason：`market_locked`
  - 來源檔案：`src/filter.ts`、`src/index.ts`
  - 是否一定會 skip：是

- orderbook 第一檔流動性不足。
  - 判斷條件：`bestAskLiquidityUsd < MIN_LIQUIDITY`
  - skip reason：`orderbook_liquidity_too_low`
  - 來源檔案：`src/filter.ts`
  - 是否一定會 skip：是，但前提是有成功抓到 best ask 與 size

- orderbook 與 source 價差過大。
  - 判斷條件：`bestAsk - sourcePrice > MAX_PRICE_DEVIATION`
  - skip reason：`price_deviation_too_high`
  - 來源檔案：`src/filter.ts`
  - 是否一定會 skip：是，但前提是有 best ask

- orderbook 與 source 價格 gap 超過 bps 限制。
  - 判斷條件：`((bestAsk - sourcePrice) / sourcePrice) * 10000 > MAX_ENTRY_PRICE_GAP_BPS`
  - skip reason：`slippage_gap_too_high`
  - 來源檔案：`src/filter.ts`
  - 是否一定會 skip：是，但前提是 `bestAsk > sourcePrice`

- 風險檢查不通過：copyNotional 小於等於 0。
  - 判斷條件：`copyNotional <= 0`
  - skip reason：`Copy notional is <= 0`
  - 來源檔案：`src/risk-manager.ts`，由 `src/index.ts` 呼叫
  - 是否一定會 skip：是

- 風險檢查不通過：超過 session notional cap。
  - 判斷條件：`MAX_SESSION_NOTIONAL > 0` 且 `sessionNotional + copyNotional > MAX_SESSION_NOTIONAL`
  - 來源檔案：`src/risk-manager.ts`，由 `src/index.ts` 呼叫
  - 是否一定會 skip：是

- 風險檢查不通過：超過 per-market notional cap。
  - 判斷條件：`MAX_PER_MARKET_NOTIONAL > 0` 且 `currentMarketNotional + copyNotional > MAX_PER_MARKET_NOTIONAL`
  - 來源檔案：`src/risk-manager.ts`，由 `src/index.ts` 呼叫
  - 是否一定會 skip：是

- `DRY_RUN=true` 時不送實單。
  - 判斷條件：filter 與 risk 都通過後，若 `config.trading.dryRun`
  - 結果：記錄 `dry_run`，不執行 `executeCopyTrade`
  - 來源檔案：`src/index.ts`
  - 是否一定會 skip live order：是

- orderbook 不存在時，前置 filter 不一定 skip。
  - 判斷條件：`getOrderbook()` 失敗回傳 `null`
  - 結果：slippage / liquidity / price deviation guard 會被略過，因為 `bestAsk` 不存在
  - 來源檔案：`src/trader.ts`、`src/index.ts`、`src/filter.ts`
  - 是否一定會 skip：否

- 進入 execution 後若 orderbook 無 asks / bids，執行階段會失敗。
  - 判斷條件：`ensureLiquidity()` 看到對應 side 的 orderbook 空陣列
  - 結果：throw error，最後記為 `copy_fail`
  - 來源檔案：`src/trader.ts`
  - 是否一定會 skip：不是前置 skip，而是執行失敗

- 餘額 / allowance 不足。
  - 判斷條件：`validateBalance()` 任一檢查失敗
  - 結果：執行失敗，最後記為 `copy_fail`
  - 來源檔案：`src/trader.ts`
  - 是否一定會 skip：不是前置 skip，而是執行失敗

- API key / geo / invalid params / duplicate order。
  - 判斷條件：`executeWithRetry()` 中 `isRetryableError()` 判斷為不可重試
  - 結果：執行失敗，最後記為 `copy_fail`
  - 來源檔案：`src/trader.ts`
  - 是否一定會 skip：不是前置 skip，而是執行失敗

## 4. Sizing 邏輯

- copyNotional 計算公式：
  - `originalSize * POSITION_MULTIPLIER`
  - 再取最小值：`MAX_TRADE_SIZE`、`MAX_USD_PER_ORDER`
  - 再套最小值下限：若 `ORDER_TYPE` 是 `FOK` / `FAK`，最低為 `1`；否則最低為 `MIN_TRADE_SIZE`
  - 最後四捨五入到小數點後兩位
  來源檔案：`src/trader.ts`
- 有 multiplier。
  - `POSITION_MULTIPLIER`
  - 來源檔案：`src/config.ts`、`src/trader.ts`
- 有 `MAX_USD_PER_ORDER`。
  - 來源檔案：`src/config.ts`、`src/trader.ts`
- 有 min size。
  - `MIN_TRADE_SIZE`，但在 `FOK/FAK` 下會被固定最小值 `1` 覆蓋
  - 來源檔案：`src/config.ts`、`src/trader.ts`
- 有 cap。
  - `MAX_TRADE_SIZE`
  - `MAX_USD_PER_ORDER`
  - 來源檔案：`src/config.ts`、`src/trader.ts`
- copy shares 計算方式：
  - `copyShares = copyNotional / validatedPrice`
  - 四捨五入到小數點後四位
  - 來源檔案：`src/trader.ts`

## 5. Dedupe / Market lock

- 有 `processedTrades`。
  - 形式：`Set<string>`
  - 來源檔案：`src/index.ts`
- 有 `marketLocks`。
  - 形式：`Set<string>`
  - 來源檔案：`src/index.ts`
- 不只在 memory。
  - `processed_trade` 與 `market_lock` 都會寫入 SQLite
  - 啟動時會從最近 7 天資料載入回記憶體
  - 來源檔案：`src/db.ts`、`src/index.ts`
- processed trade key 寫入時機：
  - `handleNewTrade()` 一通過「不是舊訊號 / 不是已處理」後就立即寫入 DB 與記憶體
  - 來源檔案：`src/index.ts`
- market lock 寫入時機：
  - filter 與 risk 通過後，在 `DRY_RUN` / 真實執行之前就寫入
  - 來源檔案：`src/index.ts`
- market lock 移除時機：
  - 只有 live execution 失敗時才會刪除 lock
  - `DRY_RUN` 不會刪除
  - success 也不會刪除
  - 來源檔案：`src/index.ts`
- 實際效果：
  - 同一 source trade 不應重複處理
  - 同一 market 只允許一次後續進場
  - 重啟後仍會保留最近 7 天 dedupe / lock 狀態

## 6. Execution 條件

- `ORDER_TYPE` 會影響下單方式。
  - `FOK` / `FAK`：走 `createAndPostMarketOrder`
  - `LIMIT`：走 `createAndPostOrder(..., OrderType.GTC)`
  - 來源檔案：`src/config.ts`、`src/trader.ts`
- 有 execution 階段 slippage 處理。
  - 不是 filter 的前置 guard，而是實際下單價格計算：
  - BUY：`bestPrice * (1 + SLIPPAGE_TOLERANCE)`，最高不超過 `0.99`
  - SELL：`bestPrice * (1 - SLIPPAGE_TOLERANCE)`，最低不低於 `0.01`
  - 來源檔案：`src/trader.ts`
- 有 orderbook depth / liquidity 判斷，但只看第一檔是否存在，不看多層深度。
  - 前置 filter：`MIN_LIQUIDITY` 看 best ask 第一檔的名目金額
  - execution：`ensureLiquidity()` 只檢查 asks / bids 陣列是否為空
  - 來源檔案：`src/filter.ts`、`src/trader.ts`
- 有 fallback。
  - 前置抓 orderbook：`getOrderbook()` 失敗回傳 `null`，bot 不會 crash，前置 slippage guard 會被略過
  - execution 時仍會直接重新抓 orderbook，因此真正下單前還是依賴 CLOB orderbook 可用
  - 來源檔案：`src/trader.ts`、`src/index.ts`
- 有價格合法化。
  - `validatePrice()` 會依 tick size round，並限制在 `0.01 ~ 0.99`
  - 來源檔案：`src/trader.ts`
- 有 retry，但不是所有錯都 retry。
  - network / timeout / rate limit / 502/503/504 會 retry
  - unauthorized / blocked / insufficient / invalid / duplicate 不 retry
  - 來源檔案：`src/trader.ts`

## 7. Telegram 通知

- 啟動時會發送一次 bot started 通知。
  - 使用 `sendTelegramDeduped('bot:start', ...)`
  - 來源檔案：`src/index.ts`
- `DRY_RUN` 通過時會發。
  - 類型：`DRY RUN WOULD COPY`
  - 使用 dedupe
  - 來源檔案：`src/index.ts`
- live order success 會發。
  - 類型：`ORDER SUCCESS`
  - 不使用 dedupe
  - 來源檔案：`src/index.ts`
- live order fail 會發。
  - 類型：`ORDER FAIL`
  - 不使用 dedupe
  - 來源檔案：`src/index.ts`
- redeem reminder 會發。
  - 由 `src/redeem-watcher.ts` 定時檢查並發送
  - 優先送到 `TELEGRAM_REDEEM_CHAT_ID`，否則 fallback 到 `TELEGRAM_CHAT_ID`
  - 來源檔案：`src/redeem-watcher.ts`、`src/telegram.ts`
- 目前不是每筆 raw signal 都發 Telegram。
  - 原始 detect signal 推播已移除
  - 來源檔案：`src/index.ts`
- 有 dedupe。
  - `sendTelegramDeduped()` 的 dedupe 視窗是 5 秒
  - 目前主要用於啟動通知與 dry-run 通知
  - 來源檔案：`src/telegram.ts`、`src/index.ts`

## 8. 風險：可能導致「完全不下單」的點

- `DRY_RUN=true`
  - 這會讓 bot 永遠不送實單，只記 `dry_run`
  - 來源檔案：`src/config.ts`、`src/index.ts`

- `SOURCE_TRADER_WHITELIST` 或 `TARGET_WALLET` 設錯
  - 會直接導致沒有任何來源 trade 可進來
  - 來源檔案：`src/config.ts`、`src/monitor.ts`、`src/websocket-monitor.ts`

- `MARKET_SCOPE=crypto-only` 搭配 keyword 不完整
  - 會把實際要跟的市場全部判成 `non_crypto_market`
  - 來源檔案：`src/config.ts`、`src/filter.ts`

- `MIN_SOURCE_PRICE=0.97` 與 `MAX_SOURCE_PRICE=0.999`
  - 只允許極高價區間，非接近結算的單幾乎都會被排掉
  - 來源檔案：`src/config.ts`、`src/filter.ts`

- `MAX_SOURCE_TRADE_AGE_MS=30000`
  - 若資料源延遲或輪詢不穩，很多訊號可能在進來前就已變成 stale
  - 來源檔案：`src/config.ts`、`src/filter.ts`

- `MIN_SOURCE_TRADE_USD` 設太高
  - 會直接過濾掉小額來源單
  - 來源檔案：`src/config.ts`、`src/filter.ts`

- `ONE_TRADE_PER_MARKET=true`
  - 一旦某 market 已上鎖，後續同 market 訊號都會被 `market_locked`
  - 且 lock 目前會持久化 7 天
  - success 與 dry-run 都不會自動解鎖
  - 來源檔案：`src/config.ts`、`src/filter.ts`、`src/index.ts`、`src/db.ts`

- `MAX_ENTRY_PRICE_GAP_BPS` / `MAX_PRICE_DEVIATION` / `MIN_LIQUIDITY` 設太嚴
  - 會在 filter 階段直接大量 skip
  - 來源檔案：`src/config.ts`、`src/filter.ts`

- `MAX_SESSION_NOTIONAL` / `MAX_PER_MARKET_NOTIONAL` 啟用且值太小
  - 會在 risk check 階段擋掉全部 trade
  - 來源檔案：`src/config.ts`、`src/risk-manager.ts`

- `MAX_USD_PER_ORDER`、`MAX_TRADE_SIZE`、`POSITION_MULTIPLIER` 組合過小
  - 雖然不一定完全不下單，但可能讓單量長期貼近最小值
  - 在 `FOK/FAK` 下會被抬到至少 `1 USDC`
  - 來源檔案：`src/config.ts`、`src/trader.ts`

- 餘額 / allowance / API 權限問題
  - trade 會通過 filter，但 execution 全部失敗
  - 表面上看起來像「有偵測但沒有成功下單」
  - 來源檔案：`src/trader.ts`

- WebSocket/REST 與 dedupe 交互
  - 若同一筆 trade 先被判成 processed key，後來另一來源路徑再送來時會被直接略過
  - 這是預期行為，但若 trade key 設計過粗，可能造成誤去重
  - 來源檔案：`src/index.ts`

- outcome mapping 找不到不會直接阻止下單
  - 只會 fallback `UNKNOWN`
  - 來源檔案：`src/trader.ts`、`src/index.ts`、`src/websocket-monitor.ts`

## 補充結論

- 目前真正最強的「不下單」來源，不是 execution engine，而是前置 filter 與 market lock。
- 若之後要調整 bot 活躍度，優先檢查：
  - `DRY_RUN`
  - `SOURCE_TRADER_WHITELIST` / `TARGET_WALLET`
  - `MARKET_SCOPE` + `CRYPTO_KEYWORDS`
  - `MIN_SOURCE_PRICE` / `MAX_SOURCE_PRICE`
  - `ONE_TRADE_PER_MARKET`
  - `MAX_ENTRY_PRICE_GAP_BPS` / `MAX_PRICE_DEVIATION`
