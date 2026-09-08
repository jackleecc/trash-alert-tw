# Trash Alert TW (台灣垃圾車 LINE 追蹤與到站通知系統)

台灣跨縣市垃圾車即時動態追蹤、智慧地理圍欄檢測、天災停收判定與環境氣象預警通知系統。

---

## 系統架構與服務端點

| 項目 | 說明 / 網址 |
| --- | --- |
| **正式生產站點** | https://trash-alert-tw.vercel.app |
| **垃圾車動態檢查 API** | `GET/POST` https://trash-alert-tw.vercel.app/api/check-trucks |
| **氣象環境預警 API** | `GET/POST` https://trash-alert-tw.vercel.app/api/check-weather |
| **LINE Webhook 接收端點** | `POST` https://trash-alert-tw.vercel.app/api/line-webhook |
| **GitHub 程式庫** | https://github.com/jackleecc/trash-alert-tw |
| **主機託管規格** | Vercel Serverless Functions（部署區域：`hkg1` 香港，降低台灣連線延遲） |

---

## 涵蓋外部資料源與串接服務

本系統整合了政府開放資料、氣象數值模型、行政人事公告及通訊平台：

| 服務類別 | 來源單位 / 服務名稱 | 串接端點與詳細用途 |
| --- | --- | --- |
| **車輛動態 (高雄市)** | 高雄市政府環保局開放資料 | [高雄市垃圾車即時動態 API](https://api.kcg.gov.tw/api/service/Get/aaf4ce4b-4ca8-43de-bfaf-6dc97e89cac0)<br>• 提供車號、路線代碼、即時 GPS 經緯度、清運時間戳記。 |
| **車輛動態 (新北市)** | 新北市政府環保局開放資料 | [新北市垃圾清運點即時位置 API](https://data.ntpc.gov.tw/api/datasets/28ab4122-60e1-4065-98e5-abccb69aaca6/json?page=0&size=5000)<br>• 涵蓋汐止區、板橋區等全區即時車輛動態資料。 |
| **車輛動態 (桃園市)** | 桃園市政府環境管理處 | [桃園市垃圾清運路線即時查詢系統](https://route.tyoem.gov.tw/api/trucks)<br>• 支援桃園全區清運動態（預設端點支援 `TAOYUAN_TRUCK_API_URL` 自訂覆寫；欄位已相容 `RouteNo`、`VehicleNo`、`px/py` 等規格）。 |
| **天然災害停班課** | 行政院人事行政總處 (DGPA) | [天然災害停止上班及上課情形](https://www.dgpa.gov.tw/typh/daily/nds.html)<br>• 即時爬蟲解析颱風/豪雨停班停課公告，支援多縣市（高雄市、新北市、桃園市等）個別判定。 |
| **即時氣象與空氣品質** | Open-Meteo 氣象預報生態系 | 1. [Weather Forecast API](https://api.open-meteo.com/v1/forecast)：精準依站點經緯度查詢未來 1 小時降雨量、降雨機率與紫外線 (UV Index)。<br>2. [Air Quality API](https://air-quality-api.open-meteo.com/v1/air-quality)：即時取得細懸浮微粒 (PM2.5) 濃度。 |
| **即時通訊推播平台** | LINE Messaging API | 1. `https://api.line.me/v2/bot/message/push`：主動向指定群組發送到站警報與氣象通知。<br>2. `https://api.line.me/v2/bot/message/reply`：Webhook 零額度回覆群組 ID。<br>3. 系統廣播：熔斷告警與連續失敗通知。 |
| **資料庫與 RPC 引擎** | Supabase (PostgreSQL 15+) | 專案實體：`https://tjltndxwhxjfsgmkjmnd.supabase.co`<br>• 存放空間地理資訊、群組綁定、冷卻狀態鎖與月用量原子扣抵。 |

---

## 系統核心執行流程

### 1. 垃圾車追蹤流程 (`/api/check-trucks`)

```text
定時排程觸發 (cron-job.org / GitHub Actions / Vercel Cron)
  │
  ├─► [防禦層 1] 安全比對 Header 之 Bearer CRON_SECRET（防範 Timing Attack）
  │
  ├─► [防禦層 2] 時間窗二次校驗：確認台灣時間 (UTC+8) 是否在清運時段 (17:00 ~ 21:59)
  │
  ├─► [防禦層 3] DGPA 停班停課 Lazy Load 快取（查詢 daily_status）
  │      └─ 若當日已宣布該縣市天災停收，則略過該縣市路線，避免無效運算
  │
  ├─► [資料抓取] 平行抓取高雄市、新北市與桃園市環保局即時 API（支援逾時重試、指數退避與 Schema 正規化）
  │      └─ 連續失敗達 3 次時自動標記 is_paused 並推播管理告警
  │
  ├─► [核心運算與比對]
  │      ├─ 依星期過濾 routes.active_days 營業日路線
  │      ├─ 班表時間窗過濾：比對 stops.schedule_time（限定表定前 20 分至後 40 分鐘），排除非當班路過車
  │      ├─ 車種精準分流：自動排除「資源回收車/廚餘車」，精準鎖定「一般垃圾清運車」
  │      ├─ 計算車輛 GPS 與訂閱站點之 Haversine 距離（預設 250m 地理圍欄）
  │      ├─ 信任常客過濾 (route_linids)：過濾偶然路過的非執勤車輛
  │      └─ 整合即時環境：車輛即將抵達前，即時向 Open-Meteo 查詢該站點當前是否降雨或空氣不佳
  │
  └─► [推播與額度控管]
         ├─ 呼叫 claim_notification 取得 30 分鐘防洗版冷卻鎖
         ├─ 呼叫 reserve_quota 保留當月 LINE 推播額度（達 195 則自動熔斷保護）
         └─ 發送整合 Google Maps 站點導航連結與即時天氣提醒的 LINE 到站訊息（發送失敗自動歸還額度與冷卻鎖）
```

---

### 2. 全天候氣象與環境預報流程 (`/api/check-weather`)

```text
每 30 分鐘自動排程觸發
  │
  ├─► 驗證 CRON_SECRET
  ├─► 查詢 Supabase 取得所有啟用中群組所訂閱之清運點座標 (lat, lng)
  ├─► 站點去重：相同清運點只向 Open-Meteo 查詢一次，節省頻寬與降低延遲
  ├─► 評估異常指標：
  │      • 降雨：預估雨量 ≥ 0.1mm 或降雨機率 > 30%
  │      • 紫外線：UV Index ≥ 8（危險 / 極危險級）
  │      • 空氣品質：PM2.5 ≥ 35.5 μg/m³（橘害敏感族群警示）
  │
  └─► 達標推播：
         ├─ 透過 claim_notification 設定 6 小時（360 分鐘）長冷卻期
         ├─ 扣抵 LINE system_quota
         └─ 推播提醒群組提早備傘或佩戴口罩
```

---

### 3. LINE Webhook 自動註冊流程 (`/api/line-webhook`)

* **群組加入 (Join)**：Bot 被邀請進入群組時，自動於 Console 輸出 Group ID，並在群組回覆引導訊息。
* **自動登錄資料庫**：收到群組事件時，自動呼叫 `supabase.from('line_groups').upsert()` 登記該群組，省去手動新增之繁瑣手續。
* **關鍵字查詢**：群組成員傳送包含 `id`、`群組`、`/id` 等關鍵字時，Bot 自動透過 Reply Token（不計入 Push 配額）回覆該群組的識別 ID。

---

## 資料庫綱要 (Database Schema)

資料庫建置於 Supabase PostgreSQL，核心資料表與函式如下：

### 核心資料表

1. **`routes`**：清運路線清單。
   - `id` (PK, TEXT)：路線代號（例如 `LZ01`、`221010`）。
   - `name` (TEXT)：路線名稱。
   - `city` (TEXT)：歸屬縣市（例如 `高雄市`、`新北市`、`桃園市`），供天災停班課比對。
   - `active_days` (INTEGER[])：每週出車日（預設 `{1,2,4,5,6}`，排除週三、週日）。
   - `is_active` (BOOLEAN)：是否啟用。
2. **`stops`**：清運站點與座標。
   - `id` (SERIAL PK)：站點代碼。
   - `route_id` (FK)：關聯路線。
   - `name` (TEXT)：站點名稱（例如 `汐萬路一段333巷口`）。
   - `lat`, `lng` (DOUBLE PRECISION)：經緯度座標。
   - `schedule_time` (TIME)：表定清運時間。
3. **`line_groups`**：LINE 訂閱群組。
   - `group_id` (PK, TEXT)：LINE 群組 ID。
   - `group_name` (TEXT)：群組備註名稱。
   - `is_active` (BOOLEAN)：是否啟用推播。
4. **`subscriptions`**：群組與站點之多對多訂閱關聯表。
   - 複合唯一鍵 `(group_id, stop_id)`。
5. **`notification_logs`**：推播歷史日誌。
   - 記錄 `group_id`、`route_id`、`stop_id`、`car_id`、`sent_at`。
   - 建立 `(group_id, route_id, stop_id, sent_at DESC)` 複合索引，供冷卻時間快查。
6. **`system_quota`**：LINE 官方帳號免費額度控管。
   - `month` (PK, 'YYYY-MM')：統計月份。
   - `used_count` (INTEGER)：當月已發送則數。
   - `is_melted` (BOOLEAN)：熔斷旗標（達到 195 則時啟動）。
7. **`daily_status`**：每日快取狀態。
   - `date` (PK, DATE)：日期。
   - `suspended_cities` (TEXT[])：當日停止清運的縣市清單。
   - `api_fail_count` (INTEGER)：車輛 API 連續失敗次數。
   - `is_paused` (BOOLEAN)：是否因連續失敗暫停當日檢核。
8. **`route_linids`**：官方動態 Linid 自動觀測與信任對照表。
   - 記錄官方代碼與本地路線代碼的觀測次數 (`observed_count`) 與最近觀測時間。

### 核心預存程序 (Stored Procedures)

* **`claim_notification(...)`**：使用 PostgreSQL `pg_advisory_xact_lock` 進行原子排他鎖定，確認處於冷卻期外後寫入 `notification_logs` 並回傳 Log ID，阻斷高併發重複推播。
* **`release_notification_claim(p_log_id)`**：推播失敗時釋放通知鎖。
* **`reserve_quota(p_month)`**：原子遞增當月推播計數，並於達到 195 則時回傳 `newly_melted=true` 觸發緊急告警。
* **`release_quota_reservation(p_month)`**：推播失敗時安全扣回已計入的額度。
* **`observe_route_linid(p_route_id, p_linid)`**：記錄並累積官方即時車輛於該站點出現之頻次。

---

## 訊息推播範例

### 1. 垃圾車即將到站（結合地圖導航與即時天氣提醒）
```text
🚛【垃圾車即將抵達提醒】
📍 站點：汐萬路一段333巷口
🛣️ 路線：汐止區清運路線
📏 當前距離：約 185 公尺
⏰ 預估抵達：約 2～5 分鐘內
🏷️ 車號：123-AB
🗺️ 站點地圖：https://www.google.com/maps/search/?api=1&query=25.076252,121.649942

💡【環境提醒】
🌧️ 將有降雨 (機率 85% / 雨量 2.1mm)，出門請攜帶雨具🌂
😷 空氣品質不良 (PM2.5 濃度 38μg/m³)，建議配戴口罩防護😷

請準備好垃圾袋前往站點等候！
```

### 2. 獨立環境與氣象預警（每 30 分鐘檢測）
```text
⚠️ 【環境與氣象預報提醒】
您關注的清運點「汐萬路一段333巷口」附近，未來一小時有以下狀況：

🌧️ 將有降雨 (機率 90% / 雨量 3.5mm)，出門請攜帶雨具🌂
☀️ 紫外線過量 (UV指數 8.5)，出門請注意防曬🕶️
```

---

## 自動排程配置說明

因 Vercel Hobby 免費方案限制每日僅能執行 1 次 Cron，本專案採用多元排程架構：

1. **外部定時器服務 (推薦: [cron-job.org](https://cron-job.org))**
   - 設定於清運時段（台灣時間 17:00 ~ 21:59）每分鐘呼叫 `/api/check-trucks`。
   - 設定全天每 30 分鐘呼叫 `/api/check-weather`。
   - Header 帶入：`Authorization: Bearer <CRON_SECRET>`。
2. **GitHub Actions ([.github/workflows/weather-trigger.yml](.github/workflows/weather-trigger.yml))**
   - 排程：`*/30 * * * *`。
   - 每 30 分鐘自動執行氣象預警偵測。
3. **Vercel Cron ([vercel.json](vercel.json))**
   - 每日 17:00（UTC 09:00）作為備援心跳觸發。

---

## 新增路線、站點與群組指南

若需要為新社區或行政區開通通知，僅需在 Supabase 寫入資料，系統會自動在下一次排程生效：

1. **建立路線 (`routes`)**：設定 `id`（例如 `Xizhi01`）、`name`、`city`（例如 `新北市`）、`active_days`（例如 `{1,2,4,5,6}`）。
2. **建立站點 (`stops`)**：設定 `route_id`、`name`、座標 `lat` 與 `lng`。
3. **邀請 Bot 並取得群組 ID**：將 LINE 官方帳號加入目標群組，在群組輸入「`查詢`」，Bot 即會回傳該群組的 `group_id`。
4. **綁定訂閱 (`subscriptions`)**：在 `subscriptions` 資料表新增一筆記錄，將 `group_id` 與目標 `stop_id` 關聯。

---

## 本機開發與測試驗證

本專案全面使用 Node.js 原生測試框架 (`node:test`)：

```bash
# 執行所有單元測試 (共 54 項測試)
npm test

# 模擬測試執行 (不實際對外部 LINE 伺服器發送推播)
npm run test:dryrun
```
