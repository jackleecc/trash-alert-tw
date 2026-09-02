# 📋 系統交接規格書：高雄市垃圾車 LINE 追蹤通知系統 (Trash Alert System)

## 一、 專案基本資訊
*   **GitHub Repository:** `https://github.com/jackleecc/trash-alert-tw`
*   **系統定位:** 專為特定社區 LINE 群組設計的輕量化、零維運成本（Zero-Maintenance）、具備高防禦機制的垃圾車即時追蹤與到站通知系統。
*   **核心架構選擇:** 
    *   **託管與自動化部署:** GitHub 推送觸發 Vercel Serverless Functions
    *   **排程觸發器:** Vercel Cron
    *   **資料庫:** Supabase (Permanent PostgreSQL)
    *   **開發語言:** Node.js / JavaScript

---

## 二、 關鍵系統決策 (Hard Decisions & Architecture)

| 模組/功能 | 決策項目 | 選定方案與設計細節 |
| :--- | :--- | :--- |
| **運行與排程** | 時段與觸發 | **Vercel Cron (嚴格 UTC 轉換)**：排程於台灣時間 **每日 17:00** 觸發一次；程式碼首行再次校驗本地時間，阻斷非清運時段的無效運算。 |
| **天災停收防禦** | 停班課自動化 | **DGPA 法定資料源 + Lazy Load 快取**：每天 17:00 第一次觸發時，連線人事行政總處 API 獲取高雄市停班課狀態並寫入 DB。17:01 之後皆讀取快取，若停收則全系統靜默休眠。 |
| **資料持久化** | 資料庫選型 | **Supabase (Permanent PostgreSQL)**：使用永久免費的雲端 PostgreSQL，儲存路線、站點、訂閱、發送日誌與配額狀態。 |
| **抵達判定** | 地理與防誤判 | **半徑範圍 (Geofence) + 多點檢查點 (Checkpoint)**：垃圾車需先通過前置站點（`order_index` 檢核），再進入目標站點 200~300 公尺半徑，徹底避免平行街道誤判。 |
| **容錯與重試** | 外部 API 異常 | **失敗狀態記錄**：外部 API 抓取失敗時，記錄至 Supabase 狀態表，供後續排程診斷。每日一次排程無法在同日自動完成 3 次重試。 |
| **防洗版機制** | 訊息控制 | **30 分鐘冷卻時間 (Cooldown)**：針對同一群組與路線，寫入 `notification_logs`，30 分鐘內強制阻斷重複推播。 |
| **併發與重入** | 系統安全 | **資料庫狀態加鎖 (DB State Locking)**：防止 Vercel Cron 重複觸發或 API 延遲引發的重試風暴 (Retry Storm)。 |
| **成本控管** | LINE 額度防線 | **全局配額熔斷 (Global Throttling)**：嚴格控管每月 200 則免費額度。當 `system_quota` 達 195 則時觸發熔斷旗標，強制攔截後續推播並發出警告。 |
| **外部資料解析** | 欄位防禦 | **嚴格結構對應 (Strict Schema Mapping)**：內建 Adapter 層將外部 API 欄位強制清洗對齊為標準 `lat`、`lng`、`route_id` 格式，欄位缺失時安全略過。 |

---

## 三、 資料庫綱要 (DB Schema Overview)
系統依賴 Supabase 維護以下 7 張核心資料表：
1. **`routes`**: 記錄清運路線與發車日曆（`active_days`: 陣列存放週一至週日）。
2. **`stops`**: 記錄路線站點座標 (`lat`, `lng`)、表定時間與順序 (`order_index`)。
3. **`line_groups`**: 綁定的 LINE 群組身分 (Group ID)。
4. **`subscriptions`**: 記錄群組與站點的多對多訂閱關聯 (`group_id` <-> `stop_id`)。
5. **`notification_logs`**: 記錄發送歷程，支援 30 分鐘防洗版冷卻查詢與唯一索引。
6. **`system_quota`**: 追蹤每月 LINE 推播使用量 (`used_count`) 與熔斷旗標 (`is_melted`)。
7. **`daily_status`**: **[新增]** 記錄每日營運快取，包含日期與是否因天災停收 (`is_suspended`)。

---

## 四、 環境變數清單 (Environment Variables)
請確保 Vercel 專案後台 (Settings > Environment Variables) 已配置以下變數：
*   `SUPABASE_URL`: Supabase 專案 URL。
*   `SUPABASE_SERVICE_ROLE_KEY`: 擁有完全寫入權限的 Supabase 密鑰 (請勿外流至前端)。
*   `CRON_SECRET`: Vercel Cron 的授權金鑰，用於防止外部惡意觸發 API。
*   `LINE_CHANNEL_ACCESS_TOKEN`: LINE Bot 發送 Push Message 的授權憑證。

---

## 五、 工程任務清單 (Actionable Task List)
*   [x] **Task 1: Supabase 初始化** - 建立 7 張關聯表、索引，並寫入當月 `system_quota` 初始資料。
*   [x] **Task 2: Vercel 組態設定** - 建立 `vercel.json` 綁定每日 Cron (`0 9 * * *` 對應 UTC / 台灣時間 17:00)，並設定環境變數。
*   [x] **Task 3: API 防禦、時間窗與天災快取** - 實作 `api/check-trucks.js`，包含 Cron Secret 驗證、17:00-21:00 時間窗攜截、DGPA 人事行政總處 API 串接與 `daily_status` 狀態鎖。
*   [x] **Task 4: 外部 API Adapter 與重試** - 實作環保局 API 資料抓取、Schema 清洗，以及 3 次非同步重試告警邏輯。
*   [x] **Task 5: 核心運算與發送** - 實作 Geofencing 距離計算、30 分鐘冷卻檢核、配額熔斷攔截，最後串接 LINE API 推播。

---

## 六、 QE 驗證基準 (Acceptance Criteria)
1. **[時段驗證]** 系統在 16:59 或 20:01 收到觸發請求時，必須回傳 `200 OK - skipped` 且不執行任何資料庫寫入。
2. **[天災休眠驗證]** 手動將 `daily_status` 的今日 `is_suspended` 設為 `true`，Cron 觸發時系統必須不向高雄市環保局發出任何 API 請求。
3. **[防洗版驗證]** 模擬目標車輛在站點周圍 200m 內徘徊 10 分鐘，LINE 群組僅能收到 1 則通知。
4. **[熔斷驗證]** 將 `system_quota` 手動調整為 195，觸發推播時系統必須拒絕發送一般通知，並發出「額度耗盡」告警。
5. **[斷線驗證]** 封鎖外部環保局 API 網域模擬斷訊，系統應記錄 API 失敗原因至 `daily_status`。