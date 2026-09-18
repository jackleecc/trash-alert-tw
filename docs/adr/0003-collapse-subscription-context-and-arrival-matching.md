# ADR 0003: 訂閱上下文與車輛到站比對管線之深模組重組

- **狀態**: Accepted
- **日期**: 2026-09-18
- **決策者**: Antigravity Pair Programming Team

## 背景與問題 (Context)

在既有架構中，`lib/coreProcessor.js` 承載了過多職責：
1. **資料庫跨表查詢與智慧縮時窗**：`getActiveSubscriptionContext` 負責查詢 `routes`、`stops`、`line_groups`、`subscriptions` 與 `notification_logs`，並計算活躍縣市與深度休眠。
2. **純空間幾何與車輛遙測比對**：`findNearbyTruckArrivals`、`computeClosestTrucks`、`isWithinScheduleWindow` 以及車速、方位角判定。
3. **車輛歷史遙測狀態快取**：`recentTruckHistory` 記憶體 Map 與快取大小管理。
4. **外部整合與流程協調**：`processTruckArrivals` 串接氣象預測、路線歷史信任車牌記錄 (`observe_route_linid`)、推播文案格式化與通知發送。

此外，HTTP 進入點 `api/check-trucks.js` 必須深度介入這些模組細節：
- 先呼叫 `getActiveSubscriptionContext` 並拆解其內部結構 (`activeCities`, `sleepingStops`, `outOfWindowStops`)。
- 再手動呼叫 `fetchTrucksWithRetry` 傳入 `activeCities`。
- 再將 `truckData` 與 `subContext` 傳遞給 `processTruckArrivals`。
- 最後手動提取 `closestTrucks` 組裝日誌字串。

這種淺接縫 (Shallow Seam) 導致 HTTP 控制器與底層運算邏輯高度耦合，資訊洩漏嚴重。

## 架構決策 (Decision)

1. **提取純運算深模組 `lib/arrivalMatcher.js`**：
   - 封裝自適應圍欄半徑計算、時速過濾、進場方位角檢驗、班表時間窗判定 (`isWithinScheduleWindow`)、到站訊息排版 (`formatArrivalMessage`) 以及已訂閱站點最近車輛分析 (`computeClosestTrucks`)。
   - 封裝車輛遙測歷史快取 `recentTruckHistory` 與時速/行車方向計算 (`updateTruckTelemetry`)。
   - 保持 100% 純函式與記憶體狀態，完全不依賴資料庫或外部 HTTP 網路，實現零 Mock 的極致單元測試與局部性 (Locality)。

2. **提取訂閱上下文解析模組 `lib/subscriptionContext.js`**：
   - 專職封裝營運路線、站點、群組訂閱、今日已通知記錄與縮時窗之資料庫查詢與智慧過濾。
   - 隱藏資料庫綱要與狀態查詢細節。

3. **深化 `lib/coreProcessor.js` 之排程循環協調**：
   - 提供深模組端到端流程：`executeTruckTrackingCycle({ taiwanNowInfo, suspendedCities, forceRun })`，將「解析訂閱 ➔ 依活躍縣市擷取車輛 ➔ 空間比對與遙測 ➔ 天候感知 ➔ 批次推播 ➔ 狀態摘要」完全內聚於深模組內部。
   - 保留原先匯出之 `getActiveSubscriptionContext`、`processTruckArrivals`、`findNearbyTruckArrivals` 等函式外觀以維持向後相容。

4. **精簡 HTTP 控制器 `api/check-trucks.js`**：
   - 控制器僅專注於 Secret 驗證、清運時段防禦、天災停收防禦與執行日誌記錄，其餘清運核心邏輯全面委派至深模組。

## 後果 (Consequences)

### 正向效益 (Positive)
- **資訊隱藏與介面深度**：呼叫端不需知曉訂閱上下文的內部鍵值結構或多階段過濾細節。
- **演算法測試隔離**：`lib/arrivalMatcher.js` 的空間比對、時間窗、自適應半徑可獨立進行高覆蓋單元測試，無須 Mock Supabase 或外部網路。
- **全面相容現有測試與腳本**：所有既有位置驗證腳本與測試檔案（如 `verifyYangmeiFull.js`, `yongkang.test.js` 等）完全無須修改即可順暢執行。

### 潛在風險與處置 (Risks & Mitigation)
- **狀態快取一致性**：`recentTruckHistory` 從 `coreProcessor` 移至 `arrivalMatcher` 後，由 `coreProcessor` 重新導出，確保引用同一記憶體實例。
