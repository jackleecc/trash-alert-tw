# Trash Alert TW (台灣垃圾車 LINE 追蹤與到站通知系統)

台灣跨縣市垃圾車即時動態追蹤、智慧地理圍欄檢測、天災停收判定與環境氣象預警通知系統。

---

## 系統架構與服務端點

| 項目 | 說明 / 網址 |
| --- | --- |
| **正式生產站點** | https://trash-alert-tw-1062111076858.asia-east1.run.app |
| **垃圾車動態檢查 API** | `GET/POST` https://trash-alert-tw-1062111076858.asia-east1.run.app/api/check-trucks |
| **氣象環境預警 API** | `GET/POST` https://trash-alert-tw-1062111076858.asia-east1.run.app/api/check-weather |
| **LINE Webhook 接收端點** | `POST` https://trash-alert-tw-1062111076858.asia-east1.run.app/api/line-webhook |
| **GitHub 程式庫** | https://github.com/jackleecc/trash-alert-tw |
| **主機託管規格** | Google Cloud Run（部署區域：`asia-east1` 台灣彰化，原生台灣 IP 出口） |

---

## 涵蓋外部資料源與串接服務

本系統整合了政府開放資料、氣象數值模型、行政人事公告及通訊平台：

| 服務類別 | 來源單位 / 服務名稱 | 串接端點與詳細用途 |
| --- | --- | --- |
| **車輛動態 (高雄市)** | 高雄市政府環保局開放資料 | [高雄市垃圾車即時動態 API](https://api.kcg.gov.tw/api/service/Get/aaf4ce4b-4ca8-43de-bfaf-6dc97e89cac0)<br>• 提供車號、路線代碼、即時 GPS 經緯度、清運時間戳記。 |
| **車輛動態 (新北市)** | 新北市政府環保局開放資料 | [新北市垃圾清運點即時位置 API](https://data.ntpc.gov.tw/api/datasets/28ab4122-60e1-4065-98e5-abccb69aaca6/json?page=0&size=5000)<br>• 涵蓋汐止區、板橋區等全區即時車輛動態資料。 |
| **車輛動態 (桃園市)** | 桃園市政府環境管理處 | [桃園市垃圾清運路線即時查詢系統](https://route.tyoem.gov.tw/api/trucks)<br>• 支援桃園全區清運動態（預設端點支援 `TAOYUAN_TRUCK_API_URL` 自訂覆寫；欄位已相容 `RouteNo`、`VehicleNo`、`px/py` 等規格）。 |
| **車輛動態 (台南市)** | 臺南市天眼系統 / 臺南環保通 (`clean.tnepb.gov.tw`) | [天眼即時車輛 WebService](https://clean.tnepb.gov.tw/WebService/WsSkyeyes.asmx/NewgetCarsinfo)<br>• ⭕ **完整清運路線**：涵蓋永康區第 70 線 (永康-夜間31) 等全區完整清運路線與站點。<br>• ⭕ **即時車機回傳**：真實到站 GPS 坐標與時間戳記。<br>• ❌ **公有雲全面阻擋**：中華電信 HiNet 防火牆封鎖所有公有雲機房（Cloudflare 522、GCP/AWS/Vercel 連線逾時），需本地/台灣實體住宅行動 IP 連線。<br>• 📱 **純手機通知中繼架構**：為徹底避免雲端連線逾時觸發熔斷告警，系統已**完全停止雲端主動輪詢天眼系統**；全面採用 **Android 手機邊緣中繼架構**（官方「臺南環保通」App 原生接收到站推播 + MacroDroid 免費自動化轉發至 `/api/tainan-relay`），免開電腦、零維護、100% 穩定推播。 |
| **天然災害停班課** | 行政院人事行政總處 (DGPA) | [天然災害停止上班及上課情形](https://www.dgpa.gov.tw/typh/daily/nds.html)<br>• 即時爬蟲解析颱風/豪雨停班停課公告，支援多縣市（高雄市、新北市、桃園市、台南市等）個別判定。 |
| **即時氣象與空氣品質** | Open-Meteo 氣象預報生態系 | 1. [Weather Forecast API](https://api.open-meteo.com/v1/forecast)：精準依站點經緯度查詢未來 1 小時降雨量、降雨機率與紫外線 (UV Index)。<br>2. [Air Quality API](https://air-quality-api.open-meteo.com/v1/air-quality)：即時取得細懸浮微粒 (PM2.5) 濃度。 |
| **即時通訊推播平台** | LINE Messaging API | 1. `https://api.line.me/v2/bot/message/push`：主動向指定群組發送到站警報與氣象通知。<br>2. `https://api.line.me/v2/bot/message/reply`：Webhook 零額度回覆群組 ID。<br>3. 系統廣播：熔斷告警與連續失敗通知。 |
| **資料庫與 RPC 引擎** | Supabase (PostgreSQL 15+) | 專案實體：`https://tjltndxwhxjfsgmkjmnd.supabase.co`<br>• 存放空間地理資訊、群組綁定、冷卻狀態鎖與月用量原子扣抵。 |

---

## 臺南市邊緣中繼架構 (Android Mobile Relay)

臺南市環保局天眼車輛動態系統主機（`clean.tnepb.gov.tw` / IP `59.120.96.115`，中華電信 HiNet）設有嚴格的 **Geo-IP 境外與資料中心防火牆**，會直接阻斷來自非台灣實體住宅/行動 IP（包括 Cloudflare Anycast、Vercel、GCP 彰化機房等雲端 IP）的連線。

為了解決「本機電腦關機時雲端無法直連」以及「避免頻繁連線失敗觸發系統熔斷 (Circuit Breaker)」的問題，專案全面導入 **Android 手機邊緣中繼架構**：

```text
[臺南市環保局清潔車隊]
       │ (車機 GPS 即時回報)
       ▼
[臺南市天眼伺服器 (clean.tnepb.gov.tw)]
       │ (透過台灣 4G/5G 原生推播至民眾手機)
       ▼
[您的 Android 手機 (隨身主力機)]
  ├─ 1.「臺南環保通」官方 App 收到原生到站推播
  └─ 2.「MacroDroid」自動攔截通知內容
       │
       │ (發送 HTTP POST Webhook)
       ▼
[雲端後端端點 (/api/tainan-relay)]
  ├─ 驗證 CRON_SECRET 安全密鑰 (防範 Timing Attack)
  ├─ 30 分鐘冷卻防洗版檢核 (cooldownService)
  └─ 呼叫 LINE Messaging API
       ▼
[LINE 專案群組收到格式化到站提醒！]
```

### 架構特色與防護保證：
1. **雲端定時排程全面免除天眼輪詢**：雲端 Cron（新北、桃園）在計算今日活躍城市時，預設自動排除臺南市輪詢，**絕不會因為天眼網路問題累積失敗計數或觸發連續失敗熔斷**。
2. **零耗電與零主機費用**：手機不需要 24 小時開著當伺服器，只在官方 App 跳出通知時觸發一次毫秒級 HTTP POST，MacroDroid 永久免費。
3. **出門在外移動切網無影響**：由 Google 原生 FCM 系統維護推播，無論手機使用 Wi-Fi 或 4G/5G 行動網路均能順暢轉發。

> 完整圖文手機設定指南請參閱：[docs/guides/macrodroid-setup.md](docs/guides/macrodroid-setup.md)。

---

## 自動排程

cron-job.org 為主要高頻觸發器：

- 台灣時間：每日 `17:00-21:59`（週一、二、四、五、六），每 1~2 分鐘呼叫一次垃圾車檢查 API。
- Request Header：`Authorization: Bearer <CRON_SECRET>`

> [!NOTE]
> **排程時間與提早監控邊界條件（Edge Condition）**：
> - 系統內部「防禦層 2」清運服務總時間窗（`isWithinServiceWindow`）目前鎖定於 **17:00 ~ 21:59**。
> - 站點之智慧班表時間窗（`isWithinScheduleWindow`）預設允許表定時間提前 15 分鐘監控。目前最早已營運站點（如楊梅中山南路146號，表定 17:15:00）其提前 15 分鐘監控起始點為 17:00:00，剛好與 17:00 排程無縫銜接。
> - **未來例外處理指引**：若日後加入之新站點表定時間早於 17:15（例如表定 17:00，提前 15 分為 16:45），欲讓排程提前開跑，**須同時調整兩處**：
>   1. **外部 Cron-job.org**：將定時觸發時間提早至 `16:45`（或 `16:30`）。
>   2. **服務總時間窗校驗**：修改 `lib/timeUtils.js` 中的 `isWithinServiceWindow()`，將門檻由 `hour >= 17` 放寬支援至含括 `16:45`。

GitHub Actions 為氣象預報排程觸發器：

- 排程：`*/30 23,0-15 * * *`（對應台灣時間 07:00~23:59）
- 每 30 分鐘自動執行氣象預警偵測。

## 系統核心執行流程

### 1. 垃圾車追蹤流程 (`/api/check-trucks`)

```text
定時排程觸發 (cron-job.org / GitHub Actions / Cloud Scheduler)
  │
  ├─► [防禦層 1] 安全比對 Header 之 Bearer CRON_SECRET（防範 Timing Attack）
  │
  ├─► [防禦層 2] 時間窗二次校驗：確認台灣時間 (UTC+8) 是否在清運時段 (17:00 ~ 21:59)
  │
  ├─► [防禦層 3] DGPA 停班停課 Lazy Load 快取（查詢 daily_status）
  │      └─ 若當日已宣布該縣市天災停收，則略過該縣市路線，避免無效運算
  │
  ├─► [資料抓取] 平行抓取新北市、桃園市等公有開放資料 API（臺南市已全面改由手機 App 邊緣中繼 Webhook 推播，免雲端輪詢，杜絕連線逾時）
  │      └─ 連續失敗達 10 次時自動標記 is_paused 並推播管理告警
  │
  ├─► [核心運算與比對]
  │      ├─ 依星期過濾 routes.active_days 營業日路線
  │      ├─ 智慧班表時間窗：比對 stops.schedule_time，動態阻隔非當班/提前出庫車輛（預設允許提前 15 分鐘、延後 40 分鐘）
  │      ├─ 自適應空間圍欄 (Adaptive Geofence)：依相鄰站距自動收斂，防範鄰近清潔隊部與巷弄串擾
  │      ├─ 執勤巡航車速分析：區隔慢速清運作業與快速巡航路過車輛
  │      ├─ 路線拓撲與進場航向驗證：自動比對路線前後向量，排除反向出庫車輛（兼顧彎道與原地作業漂移容許）
  │      ├─ 車種精準分流：自動排除「資源回收車/廚餘車」，精準鎖定「一般垃圾清運車」
  │      ├─ 信任常客過濾 (route_linids)：過濾偶然路過的非執勤車輛
  │      └─ 整合即時環境：車輛即將抵達前，即時向 Open-Meteo 查詢該站點當前是否降雨或空氣不佳
  │
  └─► [推播與額度控管]
         ├─ 呼叫 claim_notification 取得 30 分鐘防洗版冷卻鎖
         ├─ 呼叫 reserve_quota 保留當月 LINE 推播額度（達 200 則上限自動熔斷保護）
         └─ 發送整合 Google Maps 站點導航連結與即時天氣提醒的 LINE 到站訊息（發送失敗自動歸還額度與冷卻鎖）
```

---

### 2. 氣象與環境預報排程流程 (`/api/check-weather`)

```text
每 30 分鐘自動排程觸發 (避開台灣夜間 00:00~07:00 靜音期)
  │
  ├─► 驗證 CRON_SECRET
  ├─► 檢查夜間靜音時段 (00:00~07:00)：若處於靜音時段直接略過
  ├─► 查詢 Supabase 取得啟用中群組所訂閱之清運點座標 (lat, lng)
  ├─► 站點去重：相同清運點只向 Open-Meteo 查詢一次
  ├─► 動態冷卻檢查 (weather_check_status)：
  │      • 若上次發送過通知：冷卻 6 小時 (360 分鐘) 後方可再次查詢
  │      • 若上次查詢未發通知：冷卻 30 分鐘後方可再次查詢（每 30 分鐘常態監控）
  ├─► 呼叫 Open-Meteo 評估異常指標：
  │      • 降雨：降雨機率 ≥ 60%
  │      • 紫外線：UV Index ≥ 8（危險 / 極危險級）
  │      • 空氣品質：PM2.5 ≥ 35.5 μg/m³（橘害敏感族群警示）
  │      （單次推播整合所有異常指標，共用 1 次額度與冷卻鎖）
  │
  ├─► 達標推播：
  │      ├─ 透過 claim_notification 設定 6 小時長冷卻鎖
  │      ├─ 扣抵 LINE system_quota
  │      └─ 推播提醒群組提早備傘或佩戴口罩
  │
  └─► 更新 weather_check_status 紀錄本次查詢與通知時間戳
```

---

### 3. LINE Webhook 自動註冊流程 (`/api/line-webhook`)

* **群組加入 (Join)**：Bot 被邀請進入群組時，自動於 Console 輸出 Group ID，並在群組回覆引導訊息。
* **自動登錄資料庫**：收到群組事件時，自動呼叫 `supabase.from('line_groups').upsert()` 登記該群組，省去手動新增之繁瑣手續。
* **關鍵字查詢**：群組成員傳送包含 `id`、`群組`、`/id` 等關鍵字時，Bot 自動透過 Reply Token（不計入 Push 配額）回覆該群組的識別 ID。

---

## 智慧精準到站偵測機制 (Smart Arrival Detection Engine)

為解決都會與密集住宅區常見之「清潔隊部出庫路過誤報」、「資源回收車緊隨重複推播」、「密集巷弄鄰近站點串擾」等實務難題，系統內建多維度到站偵測防護引擎，無須人工維護車牌白名單即可達成高精準預警：

### 1. 智慧班表時間窗防護 (Dynamic Schedule Window Guard)
系統結合站點之官方表定時刻，動態管理感應時間窗。未到執勤時段之提前出庫、或是收運完畢之非執勤車輛，即便行經站點周邊亦會被時間窗主動阻隔，杜絕非當班路過誤報。

### 2. 自適應空間圍欄 (Adaptive Spatial Geofencing)
系統會依據路線前後站點之空間拓撲密度與相鄰間距，自動計算最適合該站點幾何特徵的圍欄感測半徑：
* **高密度住宅與狹小巷弄**：自動收縮感應範圍，杜絕鄰近清潔隊部、平行主幹道車流或鄰近站點之交叉誤觸發。
* **一般市區與郊區幹道**：維持最適感應半徑，確保在各類道路型態下均能穩定提供充裕的出門準備時間。

### 3. 執勤巡航車速動態辨識 (Kinematic Speed Analysis)
透過即時 GPS 位移精準推導車輛行駛動態，智慧區隔「慢速停靠收運作業」與「快速行經之巡航/出庫車輛」：
* 車輛以巡航速度通過站點周邊時，判定為非執勤路過車輛並自動靜音。
* 車輛減速進場停靠時，正常觸發到站推播。

### 4. 路線拓撲與進場航向驗證 (Topological Vector & Approach Verification)
系統從官方清運表之站點拓撲自動推導法定進場方向，免人工設定維護方向參數：
* **正向收運判定**：車輛沿路線依序收運進場時順利放行。
* **反向出庫阻絕**：剛由隊部出發、與清運方向相反之逆向出庫車輛予以攔截。
* **邊際情境容許補償**：系統兼顧道路自然彎道弧度寬容、原地停靠裝卸或停等紅燈時的 GPS 靜止漂移補償、路線首站自適應以及跨段長距調度等邊際條件，兼顧防誤報與零漏接。

### 5. 隨行車輛自然靜音 (Follower Suppression via Atomic Cooldown)
針對台灣清運常見之「一般垃圾車在前、資源回收車緊隨在後」作業模式，系統透過原子級推播鎖機制，在首輛垃圾車觸發成功後啟動冷卻保護。隨行之車輛將於冷卻期內被自然靜音，無須人工鎖定車牌清單，即可自然杜絕重複洗版。

---

## 資料庫綱要 (Database Schema)

資料庫建置於 Supabase PostgreSQL，核心資料表與函式如下：

### 核心資料表

1. **`routes`**：清運路線清單。
   - `id` (PK, TEXT)：路線代號（例如 `LZ01`、`221010`）。
   - `name` (TEXT)：路線名稱。
   - `city` (TEXT)：歸屬縣市（例如 `高雄市`、`新北市`、`桃園市`、`台南市`），供天災停班課比對。
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
   - `is_melted` (BOOLEAN)：熔斷旗標（達到 200 則時啟動）。
7. **`daily_status`**：每日快取狀態。
   - `date` (PK, DATE)：日期。
   - `suspended_cities` (TEXT[])：當日停止清運的縣市清單。
   - `api_fail_count` (INTEGER)：車輛 API 連續失敗次數。
   - `is_paused` (BOOLEAN)：是否因連續失敗暫停當日檢核。
8. **`route_linids`**：官方動態 Linid 自動觀測與信任對照表。
   - 記錄官方代碼與本地路線代碼的觀測次數 (`observed_count`) 與最近觀測時間。
9. **`weather_check_status`**：氣象預報查詢與通知狀態追蹤表。
   - `stop_id` (PK, INTEGER)：關聯清運站點。
   - `last_checked_at` (TIMESTAMPTZ)：上次向 Open-Meteo 查詢時間。
   - `last_notified_at` (TIMESTAMPTZ)：上次成功發送推播時間。
   - 實現未通知 30 分鐘 / 已通知 6 小時之動態查詢冷卻機制。

### 核心預存程序 (Stored Procedures)

* **`claim_notification(...)`**：使用 PostgreSQL `pg_advisory_xact_lock` 進行原子排他鎖定，確認處於冷卻期外後寫入 `notification_logs` 並回傳 Log ID，阻斷高併發重複推播。
* **`release_notification_claim(p_log_id)`**：推播失敗時釋放通知鎖。
* **`reserve_quota(p_month)`**：原子遞增當月推播計數，並於達到 200 則時回傳 `newly_melted=true` 觸發緊急告警。
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

### 2. 獨立環境與氣象預警（日間排程檢測）
```text
⚠️ 【環境與氣象預報提醒】
您關注的清運點「汐萬路一段333巷口」附近，未來一小時有以下狀況：

🌧️ 將有降雨 (機率 90% / 雨量 3.5mm)，出門請攜帶雨具🌂
☀️ 紫外線過量 (UV指數 8.5)，出門請注意防曬🕶️
```

---

## 自動排程配置說明

系統採用高可靠排程架構，確保車輛到站與氣象預報穩定觸發：

1. **外部定時器服務 (推薦: [cron-job.org](https://cron-job.org))**
   - 設定於清運時段（台灣時間 17:00 ~ 21:59）每分鐘呼叫 `/api/check-trucks`。
   - 設定日間每 30 分鐘呼叫 `/api/check-weather`（夜間 00:00~07:00 程式端自動靜音略過）。
   - Header 帶入：`Authorization: Bearer <CRON_SECRET>`。
2. **GitHub Actions ([.github/workflows/weather-trigger.yml](.github/workflows/weather-trigger.yml))**
   - 排程：`*/30 23,0-15 * * *`（對應台灣時間 07:00~23:59）。
   - 每 30 分鐘自動執行氣象預警偵測（具備 30 分鐘未通知 / 6 小時已通知之動態冷卻保護）。
3. **Google Cloud Scheduler（可選）**
   - 可在 GCP 控制台配置 Cloud Scheduler，直接內部呼叫 Cloud Run 服務端點。

---

## 新增路線、站點與群組指南

> [!IMPORTANT]
> **【強制準則：加入地點成功驗證標準】**
> **日後任何新地點加入，務必先確認撈得到該地點的歷史實際清運資料（如歷史實際到站時間戳、真實執勤車牌、歷史抵達記錄），才算真正加入地點成功！**
> 嚴禁僅憑官方靜態站名或地圖推估座標即宣告上線，必須提供歷史清運數據與演算法相容性測試佐證。詳情參閱 [專案新地點規範](.agents/rules/location-verification.md) 與 [驗證報告範本](docs/reports/location-report-yongkang-wenhua-40.md)。

若需要為新社區或行政區開通通知，標準作業程序如下：

1. **驗證歷史清運資料**：呼叫外部車輛即時或歷史 API，確認能成功查得該清運點之實際收運實績（實際到站時間、車號）。
2. **建立/確認路線 (`routes`)**：設定 `id`（例如 `70`）、`name`、`city`（例如 `台南市`）、`active_days`（例如 `{1,2,4,6}`）。
3. **建立站點 (`stops`)**：設定 `route_id`、`name`、座標 `lat`、`lng`、`order_index` 與表定清運時間 `schedule_time`。
4. **撰寫演算法測試驗證**：於 `test/` 建立專屬單元測試，驗證自適應圍欄、班表時間窗、進場方位角與車速過濾均能正確判定。
5. **邀請 Bot 並取得群組 ID**：將 LINE 官方帳號加入目標群組，在群組輸入「`查詢`」，Bot 即會回傳該群組的 `group_id`。
6. **綁定訂閱 (`subscriptions`)**：在 `subscriptions` 資料表新增記錄，將 `group_id` 與目標 `stop_id` 關聯。
7. **產出驗證報告**：於 `docs/reports/` 記錄歷史數據佐證與測試覆蓋。

---

## 本機開發與測試驗證

本專案全面使用 Node.js 原生測試框架 (`node:test`)：

```bash
# 執行全套單元與邊際條件測試 (21 組測試套件，共 111 項測試)
npm test

# 模擬測試執行 (不實際對外部 LINE 伺服器發送推播)
npm run test:dryrun
```
