# ADR 0005: 多 LINE 官方帳號動態分流與獨立配額架構

- **狀態**: Accepted
- **日期**: 2026-09-28
- **決策者**: Antigravity Pair Programming Team

## 背景與問題 (Context)

系統最初設計僅支援單一 LINE 官方帳號（透過全域環境變數 `LINE_CHANNEL_ACCESS_TOKEN` 與 `LINE_CHANNEL_SECRET` 運作）。隨著跨縣市清運站點拓展至台南永康、新北汐止以及桃園楊梅，單一 LINE 官方帳號每月份 200 則的免費 Push Message 額度已逼近上限（本月已達 199 則）。

為解除單一額度瓶頸並區隔不同行政區的推播管道，使用者決定：
1. 現有預設官方帳號專供「台南」與「汐止」群組使用。
2. 新增 LINE 官方帳號 `@039fysvd`（Channel ID: `2011776780`）專供「桃園」清運通知使用。

這帶來以下架構挑戰：
1. **推播目標如何自動路由至正確的 Channel Token**？
2. **LINE Webhook 如何在單一服務端點驗證不同 Channel 的簽章並以正確憑證回覆**？
3. **每月配額 (`system_quota`) 如何為各 Channel 獨立統計與熔斷，避免桃園新開通即被舊帳號的 199 則額度鎖死**？

## 架構決策 (Decision)

1. **建立深頻道服務模組 `lib/channelService.js`**：
   - 集中封裝所有已配置之 Channel 憑證（`default` 與 `taoyuan`）。
   - 提供 `resolveChannelForIntent({ city, routeId, groupId })`：
     - 若目標路線 `city === '桃園市'`、路線以 `lagi2` 開頭、或為楊梅群組，自動路由至 `taoyuan` 頻道。
     - 其餘情況（台南、新北汐止等）自動路由至 `default` 頻道。
   - 提供 `getRegisteredWebhookSecrets()` 與 `verifyWebhookSignature(rawBody, signature)`：支援多 Secret 迭代比對，成功時返回所屬 `channelId`。

2. **擴充 `lib/lineClient.js` 支援動態憑證**：
   - `sendLinePushMessage(to, text, options)` 支援 `options.channelId` 或 `options.token`。
   - `replyLineMessage(replyToken, text, options)` 支援帶入來源頻道之 Access Token。
   - 保留未帶參數時退回預設憑證之向後相容性。

3. **調度器 `lib/notificationDispatcher.js` 注入頻道感知**：
   - 在執行推播前，自動解析目標意圖所屬 `channelId`。
   - 依頻道傳入配額保留金鑰與推播呼叫，確保每筆到站通知從正確的官方帳號送出。

4. **分頻道獨立配額 (`system_quota`) 統計**：
   - 擴充資料庫 `system_quota.month` 長度（自 `VARCHAR(7)` 擴充至 `VARCHAR(50)`），使配額金鑰能以 `YYYY-MM`（預設/台南汐止）與 `YYYY-MM:<channelId>`（例如 `YYYY-MM:taoyuan`）獨立記帳與熔斷。
   - 提供 Supabase 遷移腳本 `supabase/migrations/add_multi_channel_support.sql`。

5. **Webhook 單一端點多憑證自動適配 (`api/line-webhook.js`)**：
   - 收到 Webhook 事件時，比對各頻道 Secret。
   - 回覆群組 `/id` 或加入事件時，使用所屬頻道 Token 回覆，並自動將群組標註為所屬行政區與頻道。

## 後果 (Consequences)

- **正向影響**：
  - 徹底分散 LINE 免費額度，桃園站點享有獨立的每月份 200 則額度。
  - 推播發送全面自動化，清運站點依縣市屬性自動尋徑至對應 Bot，無需手動修改 DB。
  - Webhook 端點統一，多 Bot 可共用同一個 Cloud Run 網址，簡化部署架構。
- **潛在取捨**：
  - 資料庫需執行一次欄位長度擴充 SQL，若未執行，桃園配額在寫入長度超過 7 字元時需有平穩降級或告警防護。
