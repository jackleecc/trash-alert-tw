---
status: accepted
date: 2026-11-10
---

# ADR 0013: 上游順向走廊提前進場確認與跨站點保護擴展

## Context

使用者希望在不增加每日推播則數（維持每站每日單次通知，避免雙倍消耗 LINE 月配額）且維持「絕不誤觸發路過或逆向、必須順向才通知」的前提下，將 LINE 提醒提早以便打包與下樓移動。

經查核 Supabase `collection_approach_events`（2026-10-24 至 2026-11-09）、`notification_logs` 與官方路線／軌跡 API，確認以下實證限制：

1. **新北汐止（路線 `221010`、Stop `3` `汐萬路一段333巷口`，表定 `19:56:00`）**：
   - `647-BX` 每晚約 `19:38～19:42` 在連峰街5巷（Rank 13），`19:43～19:47` 出巷並**北上**逆向經過 333 巷口／343 巷口前往汐萬路二段折返（歷史 10/22 19:45 誤報即發生於此北上路段）。
   - 約 `19:48` 在 Rank 14 `汐萬路二段37巷口`（北側 555m）折返轉為**南下收運**，經 Rank 15 `411號`（355m）、Rank 16 `343巷口`（153m）於 `19:52～19:55` 抵達 Stop 3。
   - 若要求嚴格順向，最早安全確認起點為 Rank 14 `37巷口` 轉南下開始推進（約 `19:49`，比原 `19:53` 提早約 4～6 分鐘）；更早的 `19:43～19:47` 屬逆向／出巷路段，不可放行。

2. **桃園楊梅（路線 `lagi2-006_2_21`、Stop `9` `楊梅區中山南路146號`，實際到站 `17:15:00`）**：
   - 歷史 `notification_logs` 證實實際通知皆在 `17:15:20～17:18:13`，`17:15:00` 才是真實到站時間（官方班表 `17:25:00` 晚約 10 分鐘）。
   - 但資料庫既有的 Rank 2 `中山南路100號` 仍設為 `17:24:00`，造成 `17:15 - 17:24 = -9` 負時差，使 `deriveOfficialApproachBearing` 回傳 `null` 而豁免方向檢核；且缺少路線起站 Rank 1 `大平街246號(右邊)`。
   - 桃園官方即時 API（`lagifQueryRealtimeByRoute`）具備逐車真實 `gpstime` 與 `speed`，路線軌跡（`lagifQueryTraceByRoute`）顯示 Rank 1 → Rank 2（435m，`225.7°`）呈 L 型轉彎（弦線最大橫偏達 173m），Rank 2 → Rank 3（95m，`280.1°`）為直線路段；將 Rank 1 設為走廊起站錨點並往 Rank 2 順向推進即可提供嚴格兩點順向保護（提早約 4～6 分鐘）。

3. **台南永康（路線 `70`、Stop `6` `永康區文化路40號`）**：
   - 採 Android「臺南環保通」App＋MacroDroid 轉發至 `/api/tainan-relay`，使用者已將手機 App 同站點改設為提早 10 分鐘通知。

## Decision

1. **多段上游進場走廊（Approach Corridor）**：
   - 在 [`lib/collectionApproach.js`](../../lib/collectionApproach.js) 實作 `deriveApproachCorridor(targetStop, allRouteStops)`，自目標站往前追溯站距 `<= 1500m`、累計距離 `<= 1500m`、總班表時差 `0～15` 分鐘且段方向夾角與主進場角差 `<= 65°` 的連續上游站點，自動包含汐止 Rank 14–17（排除 Rank 13 `31.8°` 大折返）與楊梅 Rank 1–3。
   - 允許車輛於任一上游站點建立錨點（`<= 100m`，`along` 上限對短段維持 `50m`、對 `> 180m` 長段放寬至 `min(80, segLen * 0.45)` 且需於目標圈外；對 `> 250m` 非末段長彎道上游段則允許於走廊前中段 `along <= segLen * 0.65` 建立錨點，並對自車隊方向接近路線起站 `rank/order_index = 1` 且距起站縮短 `>= 10m` 之進站樣本免除逆向誤鎖），並在同向低速（`<= 25 km/h`）、不逆向（逆向 `> 90°` 優先於低速豁免；`> 250m` 長彎道上游段在位移 `>= 20m`、夾角 `<= 85°`、距段終點縮短 `>= 8m` 且投影前進 `>= 10m` 時視為有效順向）、橫向偏差不超過段容許值（段長 `<= 250m` 維持 `60m`；較長彎道段採 `min(200, round(segLen * 0.45))`）、沿走廊前進達門檻且尚未越過目標站時，提前於上游走廊內轉為 `confirmed`。

2. **桃園楊梅納入共享確認與校準**：
   - 擴展受保護站點範圍至 `(route_id='221010', id='3')` 與 `(route_id='lagi2-006_2_21', id='9')`。
   - [`lib/truckIntake.js`](../../lib/truckIntake.js) 為桃園官方端點可信 `gpstime` 加上 `source: 'taoyuan-primary', timestamp_kind: 'gps', source_timestamp`，`coreProcessor.js` 依 `String(truck.route_id) === String(stop.route_id)` 隔離匹配 `lagifQueryRealtimeByRoute` 記錄。
   - 更新 SQL 遷移（`supabase/update_collection_approach_corridor.sql` 及同步更新 `supabase/add_collection_approach_confirmation.sql`），將 `commit_collection_approach` 的白名單改為驗證 `(v_route_id, v_stop_id)` 存在於 `public.stops`，維持失敗關閉、RLS 與單連線/交易原子性。
   - 保留楊梅 Stop 9 `17:15:00` 真實時間，將上游 Rank 1 `大平街246號(右邊)` 校準為 `17:10:00`、Rank 2 `中山南路100號` 校準為 `17:14:00`。

3. **排程時間窗與一般站點逆向補強**：
   - `DEFAULT_SCHEDULE_BEFORE_MINUTES` 由 `18` 放寬為 `25`（保留 `isWithinScheduleWindow` 參數預設 `15` 與既有測試相容）。
   - [`lib/geoUtils.js`](../../lib/geoUtils.js) 的 `isMovingTowardsApproach` 調整為僅在「位移 `< 12m`（容許 0.0001° GPS 漂移）或無前次座標」時才套用低速（`< 5 km/h`）漂移豁免，確保一般站點在 `>= 12m` 低速逆向時同樣被阻斷（受保護站點仍維持嚴格 `>= 10m` 門檻）。

4. **動態預估抵達顯示與台南中繼文案**：
   - [`api/tainan-relay.js`](../../api/tainan-relay.js) 改顯示 `⏰ 預估抵達：約 10 分鐘內`，並支援同路線上游站名自動對應已訂閱站點。
   - [`lib/arrivalMatcher.js`](../../lib/arrivalMatcher.js) `formatArrivalMessage` 保持標題 `🚛【車輛已接近站點】` 與向後相容（未傳入 `etaText` 時不顯示預估行、絕不寫死 `2～5 分鐘`），由 [`lib/coreProcessor.js`](../../lib/coreProcessor.js) 依確認當下距目標站實際距離推算合理區間（例如 `> 150m` 時約 `ceil/floor` 分鐘區間，並參考剩餘班表時差上限）傳入顯示 `⏰ 預估抵達：...`。

## Consequences

- 汐止實車在 `19:48～19:49` 折返南下起即通知（比原本提早約 4～6 分鐘）；楊梅在 Rank 1 順向駛出起即通知（比原本提早約 4～6 分鐘）；台南依手機 App 提前 10 分鐘通知。維持每站每日僅 1 則通知。
- 上線前必須先於 Supabase SQL Editor 執行更新版 `commit_collection_approach` SQL（`supabase/update_collection_approach_corridor.sql`），否則楊梅保護站點將因 RPC 舊版僅允許 `221010/3` 而保守維持 `pending`。
- 上游走廊確認仍在真實路段下依賴來源 GPS 新鮮度與 1 分鐘輪詢密度；實際提早效益待部署後於夜間清運時段唯讀查核 `collection_approach_events` 與 `notification_logs` 驗證。
