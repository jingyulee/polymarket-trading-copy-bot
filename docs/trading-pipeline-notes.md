# Trading Pipeline Notes

## 已完成驗證
- static CLOB credentials 生效
- signer / funder / target wallet 角色澄清
- on-chain balance / allowance / CLOB allowance 都已正確
- feeRateBps 修正後可成功送單
- maker fallback 可成功 placed / timeout / cancel

## 已確認問題已排除
- dynamic API credentials 導致 account context 混亂
- CLOB allowance 讀錯欄位
- empty/missing orderbook 被當作 hard fail
- feeRateBps=0 導致某些市場拒單

## 目前策略層現象
- 已從技術串接問題進入成交率優化階段
- 很多來源 BUY 在實際 orderbook 中 asks=0
- maker fallback 在極低 best bid（如 0.01）時通常不成交
- stale_trade 與 no_asks_in_orderbook 目前是主要 skip 原因
- 新增過濾條件後，主要會再觀察 `not_high_liquidity_symbol`、`spread_too_wide`、`asks_depth_too_low`、`maker_fallback_bid_too_low`
- 目前剩下的是「哪些 BUY 值得追」的策略問題

## 後續待優化
- source trade 條件收斂
- 可成交 orderbook 條件
- maker fallback 適用場景
- spread / depth / best bid 條件過濾
- 成交率與風險平衡
- 目標是提高「值得追的 BUY」比例，而不是盲目增加下單數
