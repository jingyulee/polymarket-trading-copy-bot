# Telegram 指令說明

本文說明 copy-bot 目前支援的 Telegram 查詢指令、用途、顯示欄位與輸出範例。

## /stats
用途：顯示整體績效總覽，合併 `positions_sim` 與 `positions_live`。

顯示內容：
- 已結算：筆數、勝率、投入、redeem、pnl
- 未結算：筆數、佔用資金
- 整體：總投入、當前 pnl（已結算）

範例：

```text
📊 總覽

已結算
筆數: 14
🎯 勝率: 64.29%
💵 投入: 60.00 USDC
🏦 redeem: 68.50 USDC
📈 pnl: +8.50 USDC

未結算
筆數: 4
💵 佔用資金: 12.50 USDC

整體
💵 總投入: 72.50 USDC
📊 當前 pnl（已結算）: +8.50 USDC
```

## /simstats
用途：顯示模擬倉位績效，資料來源為 `positions_sim`。

顯示內容：
- 已結算：筆數、勝率、投入、redeem、pnl
- 未結算：筆數、佔用資金
- 整體：總投入、當前 pnl（已結算）

範例：

```text
🧪 SIM

已結算
筆數: 7
🎯 勝率: 57.14%
💵 投入: 24.00 USDC
🏦 redeem: 26.50 USDC
📈 pnl: +2.50 USDC

未結算
筆數: 3
💵 佔用資金: 8.50 USDC

整體
💵 總投入: 32.50 USDC
📊 當前 pnl（已結算）: +2.50 USDC
```

## /livestats
用途：顯示正式倉位績效，資料來源為 `positions_live`。

顯示內容：
- 已結算：筆數、勝率、投入、redeem、pnl
- 未結算：筆數、佔用資金
- 整體：總投入、當前 pnl（已結算）

範例：

```text
📊 LIVE

已結算
筆數: 7
🎯 勝率: 71.43%
💵 投入: 35.00 USDC
🏦 redeem: 41.00 USDC
📈 pnl: +6.00 USDC

未結算
筆數: 1
💵 佔用資金: 5.00 USDC

整體
💵 總投入: 40.00 USDC
📊 當前 pnl（已結算）: +6.00 USDC
```

## /open
用途：顯示目前未結算部位，合併 `positions_sim` 與 `positions_live` 後取前 10 筆。

顯示內容：
- 類型（SIM / LIVE）
- market_slug
- outcome
- entry_price
- entry_notional
- entry_ts

範例：

```text
📌 未結算 (前 4 筆)
LIVE btc-up-or-down-march-18-10am | UP @ 0.5420 | 5.00 USDC | 2026-03-18 09:58:11
SIM eth-up-or-down-march-18-10am | DOWN @ 0.4610 | 3.50 USDC | 2026-03-18 09:56:42
LIVE sol-up-or-down-march-18-10am | UP @ 0.6035 | 4.00 USDC | 2026-03-18 09:55:03
SIM btc-up-or-down-march-18-9am | DOWN @ 0.4880 | 2.50 USDC | 2026-03-18 09:12:28
```

## /recent
用途：顯示最近的 `trade_log` 紀錄，預設回傳最近 10 筆。

顯示內容：
- 時間
- market_slug
- action
- reason
- copy_notional

範例：

```text
🕘 recent (最近 5 筆)
2026-03-18 10:01:12 | btc-up-or-down-march-18-10am | copy_success | executed | 5.00 USDC
2026-03-18 10:00:57 | eth-up-or-down-march-18-10am | skip | stale_trade | -
2026-03-18 09:59:44 | sol-up-or-down-march-18-10am | dry_run | dry_run_enabled | 4.00 USDC
2026-03-18 09:58:20 | btc-up-or-down-march-18-9am | copy_fail | insufficient balance | 5.00 USDC
2026-03-18 09:57:03 | xrp-up-or-down-march-18-10am | skip | non_crypto_market | -
```

## /skips
用途：統計最近一批 skip 紀錄中的主要原因，預設以最近 200 筆 `trade_log(action=skip)` 為基礎。

顯示內容：
- stale_trade
- market_locked
- source_trade_usd_too_small
- non_crypto_market
- slippage_gap_too_high

範例：

```text
🚫 skips (最近 200 筆 skip)
stale_trade: 7
market_locked: 3
source_trade_usd_too_small: 5
non_crypto_market: 2
slippage_gap_too_high: 1
```

## 交易通知格式
用途：所有交易通知共用同一套版型，DRY RUN 與 LIVE 只有第一行 status header 不同。

欄位說明：
- `HEADER`：模式與 decision 組合，例如 `🟡 DRY RUN — WOULD COPY`
- `market_title`：直接顯示原始 market 字串，不拆分、不縮寫
- `原因`：僅在 `SKIP` / `FAILED` 時顯示
- `side_line`：顯示方向、outcome 與價格，例如 `🟢 BUY UP @ 0.9900`
- `risk_line`：依價格區間顯示風險提示
- `Copy`：本次 copy notional
- `Source`：來源 trader 的原始下單金額
- `Fill / Size`：僅在 `LIVE — ORDER PLACED` 顯示實際成交價格與成交數量
- `延遲`：來源交易到 bot 偵測的延遲秒數

DRY RUN — WOULD COPY 範例：

```text
🟡 DRY RUN — WOULD COPY

📌 BNB Up or Down - March 17, 3:05PM-3:10PM ET

🟢 BUY UP @ 0.9900
⚠️ 高價區（風險高）

💰 Copy: 5.00 USDC
📊 Source: 24.00 USDC

⏱ 延遲: 1.4s
```

DRY RUN — SKIP 範例：

```text
🔴 DRY RUN — SKIP

📌 BNB Up or Down - March 17, 3:05PM-3:10PM ET

原因: stale_trade

🟢 BUY UP @ 0.9900
⚠️ 高價區（風險高）

💰 Copy: 5.00 USDC
📊 Source: 24.00 USDC

🎯 Fill: 0.9912
📦 Size: 5.0456

⏱ 延遲: 1.4s
```

LIVE — ORDER PLACED 範例：

```text
🟢 LIVE — ORDER PLACED

📌 BNB Up or Down - March 17, 3:05PM-3:10PM ET

🟢 BUY UP @ 0.9900
⚠️ 高價區（風險高）

💰 Copy: 5.00 USDC
📊 Source: 24.00 USDC

⏱ 延遲: 1.4s
```

LIVE — FAILED 範例：

```text
❌ LIVE — FAILED

📌 BNB Up or Down - March 17, 3:05PM-3:10PM ET

原因: insufficient balance

🟢 BUY UP @ 0.9900
⚠️ 高價區（風險高）

💰 Copy: 5.00 USDC
📊 Source: 24.00 USDC

⏱ 延遲: 1.4s
```

補充：
- `LIVE — ORDER PLACED` 會顯示 `🎯 Fill` 與 `📦 Size`
- `DRY RUN — WOULD COPY`、`SKIP`、`FAILED` 不顯示 `Fill / Size`

價格風險提示規則：
- `price >= 0.99`：`⚠️ 高價區（風險高）`
- `0.97 <= price < 0.99`：`⚡ 中價區（可觀察）`
- `price < 0.97`：`🟢 低價區（較佳）`

## 無資料時的回覆
若查詢結果為空，bot 會回覆：

```text
目前無資料
```

例如：

```text
📌 未結算
目前無資料
```
