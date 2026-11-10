# 進場走廊確認與上線順序

進場確認套用受保護站點清單：路線 `221010` 站點 `3`（汐萬路一段333巷口）與路線 `lagi2-006_2_21` 站點 `9`（楊梅區中山南路146號）。其他一般地點維持既有判定（`isMovingTowardsApproach` 僅於位移 `< 12m` 或缺少前次座標時依低速豁免；`DEFAULT_SCHEDULE_BEFORE_MINUTES` 為 `25` 分鐘，單獨呼叫 `isWithinScheduleWindow` 預設參數維持 `15` 分鐘）。進入時間窗、上游走廊或目標圍欄本身不等於已確認收運進場。

## 判定依據

透過 `deriveApproachCorridor` 由目標站往前追溯連續同向且符合班表時差（單段 `0～15` 分、累計 `<= 15` 分）之上游站點建立進場走廊（Approach Corridor）：汐止自動切齊於 `37巷口 → 411號 → 343巷口 → 333巷口`（於 `連峰街5巷` 折返處停止），楊梅涵蓋起站 `大平街246號(右邊)`（`17:10`）→ `中山南路100號`（`17:14`）→ `楊梅區中山南路146號`（`17:15`）。同一車輛需先於任一上游走廊站點建立可信GPS錨點，再沿作用中走廊區段順向接近並推進／縮短距目標站距離至少20公尺。短段（`<= 250m`）橫向走廊偏差嚴格限制 `60m`；超過 `250m` 之跨街區彎道（如楊梅 L 型轉彎段 `435m`）橫向容許依段長比例放寬至最多 `200m`。

相隔2至180秒、位移至少10公尺才建立新方向；大於 `90°` 之逆向位移即使低速也立即拒絕並鎖定需重新通過前站。小於10公尺的漂移只能沿用180秒內的可信方向，不能延長方向證據期限。前站錨點有效300秒。reported或推算速度高於25km/h拒絕，越過目標站超過120m則保持待確認（`outside_target`）。確認後由 `computeApproachEtaText` 動態推算預估抵達區間，不輸出寫死之「2～5 分鐘」。

GPS時間只接受已知主來源（`ntpc-primary`、`taoyuan-primary`）的逐車採樣時間，年齡為過去180秒至未來30秒。網站備援頂層時間是回應時間，不是GPS時間；僅有此來源時保護站點保持待確認。這可能延後或漏報，不能把新鮮HTTP回應當成實車新鮮位置。

待確認與拒絕不建立通知意圖、不占冷卻鎖、不扣額度、不寫通知紀錄，因此不會使站點進入當日休眠。GPS軌跡不能直接證明車輛正在收垃圾；順向路過仍是實車驗收須觀察的限制。

## 資料庫與部署

本次程式交付已透過 `scripts/applyYangmei.js` 同步校準 Supabase 楊梅 `stops` 上游站點時間序（維持 Stop 9 為 `17:15:00`），但因本機無 DDL 權限不會自動覆寫 PostgreSQL RPC。正式採用／部署前必須依序：

1. 若為全新資料庫，先執行 `supabase/add_collection_approach_confirmation.sql`；若已安裝舊版，則於 **Supabase SQL Editor** 執行增量遷移 `supabase/update_collection_approach_corridor.sql`，使 `commit_collection_approach` RPC 動態驗證 `(route_id, stop_id)` 是否已登錄於 `public.stops`（不再寫死僅允許 `221010/3`）。
2. 確認 `service_role` 可以讀取共享狀態、執行RPC；`anon` 與 `authenticated` 不可讀寫軌跡或執行RPC。
3. 完成 SQL 更新後再部署 Cloud Run 程式，於實際清運時段核對來源、GPS新鮮度、上游走廊錨點與方向證據。不得以正式通知入口當作不耗額度的診斷工具。

未套migration或儲存失效時，此站保持待確認並輸出診斷，不回退成記憶體放行。其他地點繼續依舊規則運作。共享軌跡以台灣日期／路線／站點／車號隔離，狀態900秒到期；版本比較與判斷事件在同一交易寫入，避免不同Cloud Run實例覆寫較新證據。

每次觀測由adapter讀取狀態、重新計算純判斷並以預期版本提交，最多重試3次；只有回覆`applied: true`且版本恰為預期值加1時，才會向通知流程回報confirmed。讀取／提交錯誤、schema缺失、無效RPC回覆或CAS重試耗盡都回傳pending並寫診斷log。RPC以每個複合鍵的transaction advisory lock序列化競爭，不會為失敗CAS留下空狀態列。

`collection_approach_events` 保存來源、GPS採樣／實際觀測時間、原始位置、有效reported與推算速度、前次樣本、前站、方向、anchor、判斷結果、原因與提交版本；非可信GPS時間以null儲存，原始欄位留在details供診斷。它是判斷紀錄，不代表LINE已發送；發送結果仍由既有通知紀錄判讀。事件資料不含LINE憑證或群組收件人。此遷移不自動刪除事件；維運須依資料量與保存需求另訂保留政策。

本機離線回歸與SQL驗證不能替代正式權限、來源延遲、跨實例及實際清運驗收。

## 離線驗證

在專案根目錄執行 `npm test`。測試預載網路拒絕guard，測試只能使用本機mock，避免誤連LINE或正式資料庫。

SQL驗證工具使用另裝的PGlite，不新增應用程式依賴，也不讀取`.env`。先安裝隔離測試工具，再執行：

```powershell
npm install --prefix .scratch/collection-sql --no-save --no-package-lock --ignore-scripts @electric-sql/pglite@0.5.11
node --require ./test/helpers/denyNetwork.cjs scripts/verifyCollectionApproachSql.mjs .scratch/collection-sql/node_modules/@electric-sql/pglite/dist/index.js
```

驗證使用記憶體內PostgreSQL與合成角色／事件，檢查migration重跑、版本比較、事件失敗回滾、角色權限及RLS。PGlite的單連線佇列不等於正式PostgreSQL多連線競爭驗收。
