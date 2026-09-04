# 地點評估與建置報告：路竹區民有路55號

本報告針對「高雄市路竹區民有路55號」之垃圾車到站通知服務進行地理定位、清運路線、抵達時段分析與資料庫整合建置規劃。

---

## 1. 地理座標與環境定位 (Geographical Profile)

| 項目 | 內容規格 | 說明 / 資料來源 |
| :--- | :--- | :--- |
| **門牌地址** | 高雄市路竹區民有路55號 | 郵遞區號：`821011` |
| **所屬行政區** | 高雄市路竹區北嶺里 | 責任分區：路竹區清潔隊 |
| **WGS84 座標** | **緯度 (Lat)**: `22.822194`<br>**經度 (Lng)**: `120.270422` | 經 OpenStreetMap 建物門牌圖資實測校正 |
| **周邊重要地標** | • 北嶺古安宮（民有路121號）：約 240 公尺處<br>• 台1線中山路：約 290 公尺處（西側）<br>• 北嶺國小：約 600 公尺處 | 位於路竹區南側北嶺社區主要聯外生活圈 |
| **地理圍欄半徑** | **250 公尺** (`GEOFENCE_RADIUS_METERS`) | 涵蓋民有路 25 號～85 號路段，預留車輛轉入通知前置時間 |

---

## 2. 清運路線與執勤動態分析 (Garbage Truck Route & Schedule)

### 2.1 清運排程與時段
- **清運日 (active_days)**：每週一、二、四、五、六（週三、週日全市停收）。
- **預估抵達時間**：約 **18:30 ～ 18:40** 區間。
  > **註**：官方於民有路121號（北嶺古安宮）預計表定時間為 18:37 左右。55號位於古安宮西側前段，車輛通常於 18:33～18:36 間通過。
- **清運類別**：
  - 一般垃圾、廚餘：一、二、四、五、六
  - 資源回收：依路竹區隊排定每週特定日（通常為一、二、五）隨車回收

### 2.2 官方即時 API 車輛觀測
- **資料來源**：高雄市政府環保局即時動態 API (`/api/service/Get/aaf4ce4b-4ca8-43de-bfaf-6dc97e89cac0`)。
- **動態車牌與 linid**：
  - 本區常見執勤車牌包括：`KEW-0079`、`KEH-6616`、`KEM-3296`、`KEF-5533`、`KEH-6272` 等。
  - 本系統採用動態 `observe_route_linid` 自動觀測機制，當官方車輛進入民有路55號 250m 圍欄時，系統會自動將該車次 `linid` 寫入 `route_linids`，不需人工作業硬編碼官方內部路線編號。

---

## 3. 資料庫整合設定 (Supabase Setup SQL)

請在 Supabase SQL Editor 執行以下語法完成站點與路線登錄：

```sql
-- ==============================================================================
-- 路竹區民有路55號 站點建置 SQL
-- ==============================================================================

-- 1. 建立/確認路竹區清運路線 (週一、二、四、五、六)
INSERT INTO public.routes (id, name, active_days, description, is_active)
VALUES (
    'LZ01', 
    '路竹區北嶺線', 
    '{1,2,4,5,6}', 
    '路竹區北嶺里民有路、民權路及周邊清運路網', 
    true
)
ON CONFLICT (id) DO UPDATE 
SET name = EXCLUDED.name,
    active_days = EXCLUDED.active_days,
    is_active = true;

-- 2. 新增清運站點：路竹區民有路55號
INSERT INTO public.stops (route_id, name, lat, lng, order_index, schedule_time)
VALUES (
    'LZ01', 
    '路竹區民有路55號', 
    22.822194, 
    120.270422, 
    1, 
    '18:35:00'
)
ON CONFLICT DO NOTHING;

-- 3. 登錄目標 LINE 群組 (請將 C_TARGET_GROUP_ID 替換為實際 LINE Group ID)
-- INSERT INTO public.line_groups (group_id, group_name, is_active)
-- VALUES ('C_TARGET_GROUP_ID', '路竹民有路通知群組', true)
-- ON CONFLICT (group_id) DO UPDATE SET is_active = true;

-- 4. 綁定群組與站點訂閱
-- INSERT INTO public.subscriptions (group_id, stop_id)
-- SELECT 'C_TARGET_GROUP_ID', id 
-- FROM public.stops 
-- WHERE route_id = 'LZ01' AND name = '路竹區民有路55號'
-- ON CONFLICT DO NOTHING;
```

---

## 4. 推播防護與通知邏輯

1. **地理圍欄觸發**：當執勤垃圾車接近至民有路55號座標 250 公尺內時觸發。
2. **推播訊息格式**：
   ```text
   🚛【垃圾車即將抵達提醒】
   📍 站點：路竹區民有路55號
   🛣️ 路線：路竹區北嶺線
   📏 當前距離：約 210 公尺
   ⏰ 預估抵達：約 2～5 分鐘內
   🏷️ 車號：KEW-0079

   請準備好垃圾袋前往站點等候！
   ```
3. **冷卻防護**：每次成功發送推播後，啟動 30 分鐘防重複推播冷卻機制 (`claim_notification`)。
4. **天然災害停班課防護**：若高雄市發布停班停課，DGPA 快取機制將當日直接跳過檢核。
