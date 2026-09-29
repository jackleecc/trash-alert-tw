# ADR 0006: 排除測試推播觸發站點深度休眠機制

- **狀態**: Accepted
- **日期**: 2026-09-29
- **決策者**: Antigravity Pair Programming Team

## 背景與問題 (Context)

系統設計有「當日推播後深度休眠 (Post-Notification Deep Sleep)」機制：當清運站點於當日（台灣時間 00:00 起）已成功發布到站推播後，為防止隨後非執勤車輛或重複收運打擾群組，系統會將該站點納入 `sleepingStops`（深度休眠），略過後續的即時車輛輪詢。

然而，在開發、驗證或手動連線測試時，若向真實群組發布測試推播（例如 `car_id: 'TEST-BOT'`、`route_id: 'TEST'` 或含 `MOCK` 之測試車次），該筆日誌會被寫入 `notification_logs`。當日稍後真實清運時段到達時，排程將誤判該站點「今日已完成清運通知」，導致當日正式清運通知被誤殺靜音。

## 架構決策 (Decision)

1. **定義測試推播識別函式 `isTestNotification(log)`**：
   - 檢查 `notification_logs` 紀錄中的 `car_id` 與 `route_id`。
   - 若 `car_id` 包含 `TEST` 或 `MOCK`（不分大小寫，例如 `TEST-BOT`、`mock-car`），或 `route_id` 包含 `TEST`，一律判定為測試推播。
2. **在 `getActiveSubscriptionContext` 中排除測試推播**：
   - 查詢今日 `notification_logs` 時，除了既有的 `route_id === 'WEATHER'` 外，同步調用 `isTestNotification(log)` 進行排除。
   - 測試推播不加入 `notifiedGroupStopSet`，確保站點不會因測試而進入深度休眠。

## 後果 (Consequences)

- **正向影響**：
  - 測試推播與日常維護驗證不再影響當日後續正式清運通知。
  - 免去測試後需手動進入資料庫清理日誌的繁瑣手續與人為風險。
- **相容性**：
  - 完全相容既有正式清運車牌（如 3 碼英文-4 碼數字）與路線代碼。
