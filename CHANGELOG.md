# 2026-03-16 安全重建紀錄

- 發現 `big-nunber` 與 `ts-bign` 兩個已知可疑 typo-squatting 套件，同時存在於 `package.json` 與實際 import 路徑。
- 由於污染依賴已進入執行路徑，原 repo 不應再被視為可直接信任的執行基線。
- 已移除可疑依賴與對應 import，改用原生數值運算取代部位僅限持倉平均價與總額計算。
- 已刪除 `generate-api-creds` 與 `test-api-creds` 兩個非核心腳本，避免額外的私密資料落地與不必要攻擊面。
- 已重建最小化 `package.json`，只保留核心監控與交易流程需要的主流依賴。
- 已移除啟動時自動送出 `approve` / `setApprovalForAll` 的行為，改成只讀檢查錢包 readiness，降低誤授權與無上限授權風險。
- 審查期間未在 repo 原始碼中發現明確的 `.ssh` 竊取、`.env` 外傳、任意 shell 執行、惡意 webhook、或將資金轉往不明地址的硬編碼邏輯。
- 建議淘汰原 repo 的信任鏈，僅保留已人工審閱且可驗證的業務邏輯，作為後續二次開發基線。
