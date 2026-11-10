# Design

## Context

目前雲端輪詢在 [`lib/coreProcessor.js`](../../lib/coreProcessor.js) 對汐止 `221010/3` 僅依單一緊鄰前站（`343巷口`，距 `333巷口` 153m）與目標 120m 圍欄確認進場，實車在確認當下已在站前 70～115m（`19:52～19:55`），距離實際抵達不到 1～2 分鐘；而桃園楊梅 `lagi2-006_2_21/9` 仍走舊版單點圍欄且資料庫缺起站 `大平街246號(右邊)`、前站 `中山南路100號` 時間（`17:24`）又晚於 Stop `9` 真實時間（`17:15`），導致負時差豁免方向檢核。台南永康則採「臺南環保通」App＋MacroDroid 轉發至 [`api/tainan-relay.js`](../../api/tainan-relay.js)，使用者已在手機 App 設為提早 10 分鐘提醒，但後端仍顯示寫死「約 3～5 分鐘內」。

查核真實 `collection_approach_events`（2026-10-24 至 2026-11-09）顯示：汐止車 `647-BX` 每晚 `19:43～19:47` 會先北上經過 `333巷口` 到汐萬路二段折返，直到 `19:48～19:49` 在 `汐萬路二段37巷口`（北側 555m）轉為南下，再經 `411號`（355m）、`343巷口`（153m）於 `19:53～19:55` 到達 `333巷口`。楊梅官方路線軌跡 `lagifQueryTraceByRoute` 則顯示第 1 站 `大平街246號`（496m）→ 第 2 站 `中山南路100號`（95m）呈 L 型轉彎（最大弦偏 173m），第 2 站→第 3 站呈直線進場。

## Goals / Non-Goals

**Goals:**
- 維持每站每日單次通知與既有 LINE 額度／冷卻機制，透過上游順向走廊將通知提早發送，並維持 100% 順向確認與逆向／超速／平行車道阻斷。
- 將楊梅 Stop `9` 納入相同跨實例共享確認機制與桃園主來源 GPS 標記，校準上游班表時序並更新資料庫 SQL。
- 更新動態 ETA 與台南 10 分鐘中繼文案。

**Non-Goals:**
- 不為求提早 10 分鐘而在汐止 `19:43～19:47` 北上路過段或楊梅起站前未納管道路放寬逆向／首次單點放行規則（依實際路徑，汐止與楊梅最早安全順向確認均約提早 4～6 分鐘）。
- 不新增每日第二次通知、不新增地點或訂閱、不在測試或驗證期間呼叫真實 LINE API、不自動執行生產 Cloud Run 部署。

## Decisions

### 1. 上游進場走廊（Approach Corridor）推導與分段保護

- 新增純函式 `deriveApproachCorridor(targetStop, allRouteStops)`（於 [`lib/collectionApproach.js`](../../lib/collectionApproach.js) 匯出）：
  - 以 `targetStop` 為終點，依 `rank ?? order_index` 往前追溯相同 `route_id` 上游站點。
  - 納入條件：單段距離 `1～1500m`、距目標站直線距離 `<= 1500m`、班表時差 `0 <= segDt <= 15` 分鐘且累計至目標站 `<= 15` 分鐘、段方位角與末段主進場角夾角 `<= 65°`（以及與緊鄰後段夾角 `<= 75°`）。
  - 驗證結果：汐止 `221010/3` 自動切齊於 `[14: 37巷口, 15: 411號, 16: 343巷口, 17: 333巷口]`（於 `13: 連峰街5巷` 31.8° 大折返處自動停止）；楊梅 `lagi2-006_2_21/9` 自動涵蓋 `[1: 大平街246號(17:10), 2: 中山南路100號(17:14), 3: 中山南路146號(17:15)]`。
- 走廊確認契約（[`evaluateCollectionApproach`](../../lib/collectionApproach.js)）：
  - 簽章相容保留 `({ sample, previousState, stop, predecessor, corridorStops, nowMs })`。未傳 `corridorStops` 時以 `[predecessor, stop]` 作為雙站走廊；僅允許受保護站點 `(221010, 3)` 與 `(lagi2-006_2_21, 9)` 進入評估。
  - **錨點建立**：任一上游站點 `C_k`（`k < m - 1`）距 `sample <= 100m`，沿段 `seg[k]` 投影在短段（`segLen <= 180m`）維持 `along <= 50m`、在長段（`segLen > 180m` 且距目標站 `> 120m`）允許 `along <= min(80, round(segLen * 0.45))`，且橫向偏差在段上限內、未受 `requiresPredecessorPass` 鎖定（或本次移動為可靠同向 `moved >= 10m && angle <= 60°`）即可建立錨點 `anchor = { sample, segmentIndex: k, progress: alongOnSegK, distanceToTarget }`。
  - **作用中路段與橫向走廊寬度**：依 `anchor.segmentIndex` 起算，從各段中選取當前幾何最貼合（在 `[ -30m .. segLen + 40m ]` 內或最鄰近目標段）之區段 `seg[activeIdx]` 提供基準 `approachBearing`；段長 `<= 250m` 橫向容許嚴格維持 `60m`（確保既有 `60.0m` 邊界測試與平行道路隔離不變），段長 `> 250m`（如楊梅 435m L 型街區轉折段）放寬為 `min(200, Math.round(segLen * 0.45))`（196m）。
  - **速度與逆向優先**：維持 2～180 秒可比間隔、reported 或推算速度 `> 25 km/h` 拒絕；`angle > 90°` 立即 `rejected (opposite_direction)` 清除錨點與方向並鎖定 `requiresPredecessorPass`，不受低速豁免；`60° < angle <= 90°` 標記 `ambiguous_direction`。
  - **確認與越站防護**：當 `anchor` 未逾 300s、具備 180s 內有效同向方向、非歧義移動、橫向位於容許走廊內、沿段推進 `>= 20m`（若切換至後續段則以累計段距/軸向總推進計算）、距目標站距離縮短 `targetProgress >= 20m`，且**尚未越過目標站後 120m 外**（即位於目標 120m 圍欄內，或處於走廊上游尚未超過末段終點超過 15m 且距目標站不超過走廊總長），狀態即為 `confirmed`。

替代方案：直接放寬目標圍欄半徑至 500m → 會讓汐止 `19:43～19:47` 北上路過或平行車道在單點出現時誤報，且無法通過楊梅 L 型轉角，故拒絕。

### 2. 核心閘道共用、桃園來源標記與預估抵達

- [`lib/truckIntake.js`](../../lib/truckIntake.js)：對桃園官方端點 `TAOYUAN_TRUCK_API_URL` 經 `parseNtpcTime(truck.time)` 解析成功者標記 `source: 'taoyuan-primary', timestamp_kind: 'gps', source_timestamp: timestamp.toISOString()`；`fetchTaoyuanTruckData` 接受 `options.requiredTaoyuanRouteIds`（預設 `['lagi2-006_2_21']`）。
- [`lib/coreProcessor.js`](../../lib/coreProcessor.js)：受保護站點條件抽共用 helper `isProtectedCollectionStop(stop)`（涵蓋 `221010/3` 與 `lagi2-006_2_21/9`）；`protectedSamples` 依 `String(truck.route_id)` 對應各受保護路線並僅接受 `ntpc-primary` / `taoyuan-primary` 之 `gps` 採樣。組裝 `corridorStops` 傳入 `observeCollectionApproach`，並共用 [`lib/arrivalMatcher.js`](../../lib/arrivalMatcher.js) 之基本資格檢查（`waste_type`、訂閱、排程窗、`route_linids` 信任名單）後，將 `confirmed` 結果交予既有通知調度與 `formatArrivalMessage`。
- ETA 推算 helper `computeApproachEtaText(distanceMeters)`：
  - 若 `distanceMeters <= 150`：`約 1～2 分鐘內`（避免與禁止之「2～5 分鐘」重複）。
  - 若 `distanceMeters > 150`：`minMins = Math.max(1, Math.floor(distanceMeters / 100))`、`maxMins = Math.max(minMins + 1, Math.ceil(distanceMeters / 75))`，輸出 `約 ${minMins}～${maxMins} 分鐘內`。
- [`lib/arrivalMatcher.js`](../../lib/arrivalMatcher.js)：`DEFAULT_SCHEDULE_BEFORE_MINUTES` 調整為 `25`；`formatArrivalMessage` 支援選用 `etaText`，僅在傳入時顯示 `⏰ 預估抵達：${etaText}`。
- [`lib/geoUtils.js`](../../lib/geoUtils.js)：`isMovingTowardsApproach` 改為先檢查 `displacement < 12`（容許約 0.0001° GPS 漂移）或無 `prev_lat/prev_lng` 時依 `speed < 5` 豁免，位移 `>= 12m` 一律強制檢查方位角；受保護站點狀態機則持續維持更嚴格之 `>= 10m` 門檻。

### 3. 資料庫遷移與台南中繼相容

- SQL：新增 `supabase/update_collection_approach_corridor.sql` 並同步更新 `supabase/add_collection_approach_confirmation.sql`，將 `commit_collection_approach` 之硬編碼 `v_route_id <> '221010' OR v_stop_id <> '3'` 改為檢查 `EXISTS (SELECT 1 FROM public.stops AS st WHERE st.route_id = v_route_id AND st.id::text = v_stop_id)`，保持 `SECURITY DEFINER`、`search_path`、RLS 與單 winner CAS 語意。
- 楊梅資料校準：更新 `scripts/applyYangmei.js`（並同步執行至 Supabase `stops` 表）建立/更新 `大平街246號(右邊)`（`order_index: 1, 17:10:00`）、`中山南路100號`（`order_index: 2, 17:14:00`）、保持 Stop `9` `楊梅區中山南路146號`（`order_index: 3, 17:15:00`）。
- [`api/tainan-relay.js`](../../api/tainan-relay.js)：將推播文字改為 `⏰ 預估抵達：約 10 分鐘內`；當無 `stop_id` 且文字命中某路線非訂閱站點（如 `文化路128巷10號`）時，若該路線於活躍訂閱站點中僅有唯一訂閱站（`永康區文化路40號`），自動解析導向該訂閱站。

## Risks / Trade-offs

- [未套更新版 SQL 即部署程式] → 楊梅 Stop 9 呼叫 `commit_collection_approach` 會因舊 RPC 白名單回傳 `applied: false` 而保守維持 `pending`（安全失敗關閉）；須在交付報告與給維運步驟明確提醒先執行 SQL。
- [實車提早量受路線起站與折返點限制] → 依真實軌跡，汐止 (`37巷口 19:48→333巷口 19:53`) 與楊梅 (`大平街 17:10→146號 17:15`) 在嚴格順向條件下約可穩定提早 4～6 分鐘，已在需求訪談階段向使用者誠實說明並獲同意。
- [既有 `weightedCoreProcessor.test.js` 借用 Stop 9 作為無狀態假資料] → 因 `lagi2-006_2_21/9` 改為受保護站點，該測試在未補兩段 GPS 確認前會因保護阻擋而紅燈；計畫中明確改為注入兩段 `taoyuan-primary` 確認流程，同時保留加權計數斷言。

## Migration Plan

1. 完成 TDD Red/Green、PGlite SQL 驗證（含多路線註冊與未註冊鍵拒絕）與雙軸 code review 修正。
2. 經使用者已授予之執行授權，執行校準腳本更新 Supabase `stops` 表內楊梅上游站點（不呼叫 LINE API）。
3. 交付增量 SQL 檔 `supabase/update_collection_approach_corridor.sql`，提醒使用者於 Supabase SQL Editor 執行後再部署 Cloud Run，並依授權執行 Git commit + push。
