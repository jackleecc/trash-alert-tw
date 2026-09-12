# 地點評估與建置報告：台南市永康區文化路40號

本報告記錄「台南市永康區文化路40號」之垃圾車到站推播服務地理定位、歷史實際清運動態撈取佐證、演算法驗證與資料庫整合建置歷程。

---

## 1. 地理座標與站點基本資訊 (Geographical Profile)

| 項目 | 內容規格 | 說明 / 資料來源 |
| :--- | :--- | :--- |
| **門牌地址** | 台南市永康區文化路40號 (清運點牌告：文化路36號) | 郵遞區號：`710017` |
| **所屬行政區** | 台南市永康區永康里 | 責任分區：台南市政府環境保護局永康區清潔隊 |
| **WGS84 座標** | **緯度 (Lat)**: `23.016963`<br>**經度 (Lng)**: `120.261576` | 與天眼系統 `x=120.261576, y=23.016963` 完全吻合 |
| **相鄰站點** | • 前一站（Stop 78）：文化路128巷10號（距離約 427 公尺）<br>• 次一站（Stop 80）：永忠路18號（距離約 69.3 公尺） | 密集住宅區，次站距離 $< 200\text{m}$ |
| **自適應圍欄半徑** | **120 公尺**（自適應收縮） | 依相鄰站距自動從 250m 收斂至 120m，杜絕次站永忠路干擾 |

---

## 2. 歷史實際清運動態撈取佐證 (Historical Collection Data Evidence)

依據專案強制準則，本站點已實測成功撈取真實歷史清運動態，佐證該地點具備完整動態服務能力：

| 檢驗維度 | 實測撈取結果 | 說明 |
| :--- | :--- | :--- |
| **資料來源系統** | 台南市環保局即時便民系統<br>(`https://clean.tnepb.gov.tw`) | 透過天眼 WebService (`WsSkyeyes.asmx`) 取得 |
| **官方路線代碼** | `永康-夜間31` | 本地對應路線：`永康區第70線 (永康里/文化路)` |
| **當日執勤車牌** | **`218-UW`**（內部編號：`976475257`） | 確定有車輛派發執勤 |
| **表定清運時間** | **19:42** | 週一、二、四、六出車 (`active_days: [1,2,4,6]`) |
| **歷史實際到站記錄** | **`19:48:31 已到達`** | 實測撈得精確歷史抵達時間戳，誤點約 6.5 分鐘 |
| **清運車種型態** | **`cartype: 'N'`**（一般垃圾清運車） | 非資收車 (`R`)，符合一般垃圾推播條件 |
| **站點系統標籤** | `seq: 1332`, `sort: 79`, `pointnumber: 04572` | 系統站點序號第 79 號 |

### 歷史原始 Payload 擷取：
```json
{
  "caption": "文化路36號",
  "car_licence": "218-UW",
  "linename": "永康-夜間31",
  "todaystart": "19:42",
  "gotofire": "19:48:31 已到達",
  "wgs_x": "120.272993",
  "wgs_y": "23.057070",
  "cartype": "N",
  "sort": "79",
  "x": "120.261575999997",
  "y": "23.0169630003141"
}
```

---

## 3. 到站演算法驗證實績 (Algorithm Validation Metrics)

已於 `test/yongkang-algorithm.test.js` 與 `test/yongkang.test.js` 建立完整自動化測試：

1. **自適應地理圍欄**：相鄰永忠路僅 69.3m，圍欄自適應收縮至 **120m**；文化路 36/40 號（5m）順利入圈，永大路（250m）精確阻斷。
2. **班表時間窗**：表定 19:42:00，歷史實際到站時間 **19:48:31** 精準通過時間窗；提前出庫（17:30）與收工（21:30）全數攔截。
3. **360° 法定進場方位角**：推導由西向東方位角 **77.6°**；順向收運放行、逆向路過排除、停靠靜止漂移（$<5\text{km/h}$）自動豁免。
4. **時速過濾**：作業時速 12 km/h 放行，巡航 40 km/h 阻斷。
5. **車種精準過濾**：一般垃圾車 (`N`) 放行，資源回收車 (`R`) 自然靜音。

---

## 4. 資料庫設定 (Supabase SQL)

```sql
-- 1. 建立台南市永康區清運路線 (週一、二、四、六)
INSERT INTO public.routes (id, name, city, active_days, description, is_active)
VALUES (
    '70', 
    '永康區第70線 (永康里/文化路)', 
    '台南市',
    '{1,2,4,6}', 
    '台南市永康區永康里、網寮里、西灣里文化路及周邊清運路網', 
    true
)
ON CONFLICT (id) DO UPDATE 
SET name = EXCLUDED.name,
    city = EXCLUDED.city,
    active_days = EXCLUDED.active_days,
    description = EXCLUDED.description,
    is_active = true;

-- 2. 建立文化路40號站點
INSERT INTO public.stops (id, route_id, name, lat, lng, order_index, schedule_time)
VALUES (
    6,
    '70', 
    '永康區文化路40號', 
    23.016963, 
    120.261576, 
    79, 
    '19:42:00'
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    schedule_time = EXCLUDED.schedule_time;

-- 3. 綁定 LINE 群組訂閱 (C6f0ecae71723b8aef86290448871e6fa)
INSERT INTO public.subscriptions (group_id, stop_id)
VALUES ('C6f0ecae71723b8aef86290448871e6fa', 6)
ON CONFLICT DO NOTHING;
```
