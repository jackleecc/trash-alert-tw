# ADR 0008: 臺南中繼站點訂閱優先比對與邊緣轉發診斷強化 (Tainan Relay Active Subscriber Routing & Diagnostics)

## 狀態
Accepted

## 背景與問題陳述
使用者反映今日手機端「臺南環保通」App 原生有收到垃圾車到站提醒，但 LINE 臺南群組卻沒有轉發通知。
診斷發現：
1. **站點關鍵字比對歧異**：
   - 臺南目前唯一的活躍訂閱群組綁定於 **Stop 6（永康區文化路40號）**。
   - 但資料庫中尚有 **Stop 5（文化路128巷10號）**。
   - 原 `api/tainan-relay.js` 的模糊比對邏輯在收到「文化路」或「夜間31」等字眼時，`allStops.find(...)` 會先命中陣列前方的 Stop 5。
   - 因 Stop 5 無任何群組訂閱（0 subscribers），導致系統判定無訂閱並提早返回，造成「收到 App 通知卻未發 LINE」的靜默漏失。
2. **中繼端點與金鑰設定風險**：
   - MacroDroid 設定教學此前指向 Vercel URL（`https://trash-alert-tw.vercel.app/api/tainan-relay`），現後端已全面移轉至 Google Cloud Run（`https://trash-alert-tw-1062111076858.asia-east1.run.app/api/tainan-relay`）。
   - 若 MacroDroid 發送失敗或未帶 `stop_id`，原程式未在 Supabase `daily_status` 留下可視化除錯軌跡。

## 決策方案
1. **活躍訂閱站點優先匹配 (Active Subscriber Priority)**：
   - `api/tainan-relay.js` 進行文字比對時，優先檢索「**已具有活躍訂閱的站點**」，阻斷未訂閱相鄰站點的搶佔。
   - 支援 `req.body.stop_id` 顯式覆蓋（最高優先級）。
2. **MacroDroid 規範最佳化**：
   - 於 `docs/guides/macrodroid-setup.md` 指南中，將 HTTP POST Body 預設加入 `"stop_id": 6`，實現 100% 確定性匹配，免除 NLP/文字匹配的模糊風險。
   - 更新目標端點為 Google Cloud Run 專屬網址。
3. **無損診斷記錄**：
   - 若端點收到轉發但無法匹配站點或無訂閱，將收到之完整文字與時間戳記寫入 `daily_status.last_api_error`，杜絕靜默吞沒。
