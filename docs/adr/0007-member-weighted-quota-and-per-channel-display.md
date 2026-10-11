# ADR 0007: 群組成員數加權配額扣抵與多頻道獨立推播額度顯示

- **狀態**: Accepted
- **日期**: 2026-10-07
- **決策者**: Antigravity Pair Programming Team

## 背景與問題 (Context)

在目前的推播流程中：
1. **單一推播固定扣抵 1 則**：`reserveQuota(quotaKey)` 預存程序每次執行時僅將 `used_count` 遞增 1，並未考量該 LINE 群組的實際成員數（`member_count`）。然而 LINE Messaging API 對群組推播的實際計費計數為「推播次數 × 群組成員人數」。這導致資料庫統計的 `used_count` 嚴重低於真實消耗（例如楊梅群組 9 人，推播 5 次在 LINE 實際消耗 45 則，但資料庫僅記錄單次累計），甚至出現「4次紀錄 + 9人 = 13」的混亂推估數值。
2. **到站通知訊息額度顯示未依頻道分流**：`lib/coreProcessor.js` 在產生到站通知時，呼叫 `getQuotaSnapshot(currentMonth)` 未帶入目標群組或站點所屬的 `channelId`，固定讀取預設頻道 (`default`) 的配額，導致桃園楊梅群組的推播訊息顯示了新北/汐止的額度資訊。
3. **官方用量同步 (`syncLineConsumption`) 憑證未分流**：`syncLineConsumption` 固定使用全域預設之 `LINE_CHANNEL_ACCESS_TOKEN`，無法為 `taoyuan` 頻道（或其他獨立官方帳號）查詢官方 API 實際用量。

## 架構決策 (Decision)

### 1. 預存程序支援加權扣抵 (`p_increment_by`)
升級資料庫函式 `reserve_quota` 與 `release_quota_reservation`：
- `reserve_quota(p_month VARCHAR(50), p_increment_by INTEGER DEFAULT 1)`
  - 若 `used_count + p_increment_by >= 200`，標記 `is_melted = true`。
  - 當 `used_count + p_increment_by <= 200` 時保留成功，回傳 `reserved = true` 與最新 `used_count`。
- `release_quota_reservation(p_month VARCHAR(50), p_decrement_by INTEGER DEFAULT 1)`
  - 遞減 `GREATEST(used_count - p_decrement_by, 0)`。

### 2. 配額服務層介面更新 (`lib/quotaService.js`)
- `reserveQuota(yearMonth, channelId, incrementBy = 1)`：支援傳入頻道識別與增加數量。
- `releaseQuotaReservation(yearMonth, channelId, decrementBy = 1)`：支援傳入頻道識別與遞減數量。
- `syncLineConsumption(yearMonth, customFetch, channelId)`：
  - 透過 `getChannelCredentials(channelId)` 取得所屬 Access Token。
  - 若該頻道未配置 Token（例如透過本機預存計算），則優雅略過同步，不誤報或誤用預設 Token。
- `getQuotaSnapshot(yearMonth, channelId)`：正確獲取指定頻道的 `system_quota` 快照。

### 3. 到站比對與訊息排版 (`lib/coreProcessor.js` & `lib/arrivalMatcher.js`)
- 群組查詢快取帶出 `member_count` 與 `channel_id`。
- 在 `processTruckArrivals` 建立 `pendingNotifications` 時，依據各訂閱群組的 `channel_id` 注入對應的 `quotaInfo`（或在格式化訊息時解析）。
- `notificationIntents` 攜帶 `memberCount: group.member_count || 1`。

### 4. 調度器 (`lib/notificationDispatcher.js`)
- `dispatchNotification(intent)` 依據 `intent.memberCount || 1` 呼叫 `reserveQuota(quotaKey, memberCount)` 與失敗時的 `releaseQuotaReservation(quotaKey, memberCount)`。

### 5. 資料庫現狀修正 (訂正至真實使用量)
- `system_quota` 記錄 `2026-10:taoyuan` 訂正為 **45**（5 次 × 9 人）。
- `system_quota` 記錄 `2026-10` 維持 **30**（與 LINE 官方 API 記錄完全吻合）。

## 後果 (Consequences)

- **正向影響**：
  - 徹底解決推播額度「推播次數 vs 群組人數」計費脫節問題。
  - 各頻道到站通知顯示之「本月推播額度：已用 X / 剩餘 Y」完全符合所屬頻道真實消耗。
- **維護注意事項**：
  - 若群組人數變動，需在 `line_groups.member_count` 維護最新值（或於 LINE Webhook 成員進出事件自動更新）。
