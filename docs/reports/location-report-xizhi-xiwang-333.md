# 地點評估與建置報告：新北市汐止區汐萬路一段333巷

本報告針對「新北市汐止區汐萬路一段333巷口」之垃圾車到站推播服務進行地理定位、清運路線、抵達時段分析與資料庫整合建置規劃。

---

## 1. 地理座標與環境定位 (Geographical Profile)

| 項目 | 內容規格 | 說明 / 資料來源 |
| :--- | :--- | :--- |
| **門牌地址** | 新北市汐止區汐萬路一段333巷口 | 郵遞區號：`221008` |
| **所屬行政區** | 新北市汐止區拱北里 | 責任分區：新北市環保局汐止區清潔隊 |
| **WGS84 座標** | **緯度 (Lat)**: `25.076252`<br>**經度 (Lng)**: `121.649942` | 經新北市政府環境保護局垃圾車路線開放資料校正 |
| **周邊重要地標** | • 汐萬路一段343巷口（約 150 公尺處）<br>• 汐萬路一段411號（約 350 公尺處）<br>• 拱北殿聯外主要幹道 | 位於汐萬路一段中段，為社區主要清運站點 |
| **地理圍欄半徑** | **250 公尺** (`GEOFENCE_RADIUS_METERS`) | 預留車輛由汐萬路二段轉入一段時之 2～5 分鐘前置準備時間 |

---

## 2. 清運路線與執勤動態分析 (Garbage Truck Route & Schedule)

### 2.1 清運排程與時段
- **官方清運線路代碼**：`221010`（第1區路線 晚上）
- **清運日 (active_days)**：每週一、二、四、五、六（週三、週日全市停收一般垃圾）。
- **表定抵達時間**：**19:56:00**（通常於 19:50 ～ 20:05 區間通過）。
- **清運類別**：
  - 一般垃圾：一、二、四、五、六
  - 資源回收：一、二、四、五、六隨車回收
  - 廚餘：一、二、四、五、六隨車回收

### 2.2 官方即時 API 車輛動態
- **資料來源**：新北市政府資料開放平臺「新北市垃圾清運車輛所在位置」即時 API：
  `https://data.ntpc.gov.tw/api/datasets/28ab4122-60e1-4065-98e5-abccb69aaca6/json?page=0&size=1000`
- **動態比對特徵**：
  - 車輛即時上傳欄位：`lineid`（路線代碼，如 `221010`）、`car`（車號）、`longitude` / `latitude`（WGS84 座標）。
  - 本系統已在 `truckAdapter.js` 與 `truckApi.js` 完整支援新北市開放資料欄位轉換與自動抓取。

---

## 3. 資料庫整合設定 (Supabase Setup SQL)

請在 Supabase SQL Editor 執行以下語法（或執行 [supabase/locations/xizhi_xiwang_333.sql](supabase/locations/xizhi_xiwang_333.sql)）：

```sql
-- 1. 建立/確認汐止區清運路線 (週一、二、四、五、六)
INSERT INTO public.routes (id, name, active_days, description, is_active)
VALUES (
    '221010', 
    '汐止區第1區路線(晚上)', 
    '{1,2,4,5,6}', 
    '新北市汐止區拱北里汐萬路一段至三段清運路網', 
    true
)
ON CONFLICT (id) DO UPDATE 
SET name = EXCLUDED.name,
    active_days = EXCLUDED.active_days,
    description = EXCLUDED.description,
    is_active = true;

-- 2. 新增清運站點：汐萬路一段333巷口
INSERT INTO public.stops (route_id, name, lat, lng, order_index, schedule_time)
VALUES (
    '221010', 
    '汐萬路一段333巷口', 
    25.076252, 
    121.649942, 
    1, 
    '19:56:00'
)
ON CONFLICT DO NOTHING;

-- 3. 登錄目標 LINE 群組 (請將 C_TARGET_GROUP_ID 替換為透過 Webhook 取得的實際 ID)
-- INSERT INTO public.line_groups (group_id, group_name, is_active)
-- VALUES ('C_TARGET_GROUP_ID', '汐止汐萬路垃圾車通知', true)
-- ON CONFLICT (group_id) DO UPDATE SET is_active = true;

-- 4. 綁定群組與站點訂閱
-- INSERT INTO public.subscriptions (group_id, stop_id)
-- SELECT 'C_TARGET_GROUP_ID', id 
-- FROM public.stops 
-- WHERE route_id = '221010' AND name = '汐萬路一段333巷口'
-- ON CONFLICT DO NOTHING;
```

---

## 4. 推播防護與通知邏輯

1. **地理圍欄觸發**：當執勤垃圾車接近至汐萬路一段333巷口座標 250 公尺內時觸發。
2. **推播訊息格式**：
   ```text
   🚛【垃圾車即將抵達提醒】
   📍 站點：汐萬路一段333巷口
   🛣️ 路線：汐止區第1區路線(晚上)
   📏 當前距離：約 210 公尺
   ⏰ 預估抵達：約 2～5 分鐘內
   🏷️ 車號：執勤車輛

   請準備好垃圾袋前往站點等候！
   ```
3. **冷卻防護**：每次成功發送推播後，啟動 30 分鐘防重複推播冷卻機制 (`claim_notification`)。
4. **智慧動態綁定**：系統會自動紀錄常客車牌，自動過濾路過非目標車輛。
