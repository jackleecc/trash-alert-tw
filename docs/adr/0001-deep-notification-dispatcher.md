# 0001. 整併推播協調流程至深 Notification Dispatcher 模組

## 背景與問題

系統推播流程涉及「原子冷卻搶佔 (claim_notification)」、「每月配額保留 (reserve_quota)」、「LINE 訊息發送 (sendLinePushMessage)」以及「失敗原子回滾」等多階段分散邏輯。各呼叫端（`lib/coreProcessor.js`、`api/check-weather.js`、`api/tainan-relay.js`）各自重複實作或手動拼裝 RPC 呼叫，導致 `api/tainan-relay.js` 出現遺漏配額保留與原子冷卻檢核之漏洞。

## 決策

建立深模組 `lib/notificationDispatcher.js`，對外僅暴露高槓桿介面：`dispatchNotification(intent)` 與 `dispatchNotificationBatch(intents)`。呼叫端僅需傳入發送意圖物件（Notification Intent），由該模組全權封裝原子冷卻鎖定、每月配額熔斷檢核、推播傳輸與錯誤回滾。底層冷卻與配額 RPC 介面自外部呼叫端完全封裝隱藏。

## 後果

- **正向影響**：
  - 徹底杜絕任何進入點繞過配額與冷卻搶佔的漏洞。
  - 呼叫端介面大幅縮減，測試時僅需在 `notificationDispatcher` 接縫替換單一適配器，免除模擬多個資料庫 RPC。
  - 集中管理批次併發（`Promise.allSettled`）與逐筆獨立回滾。
- **潛在取捨**：
  - 既有測試若直接依賴底層 `claimNotification` / `reserveQuota` 串接需配合重構至深模組接縫。
