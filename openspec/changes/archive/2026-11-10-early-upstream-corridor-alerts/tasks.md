# Tasks

## 1. 上游進場走廊與逆向防護純運算 (Ticket 1)

- [x] 1.1 [Red] 新增走廊推導、汐止 37 巷口→333 巷口真實軌跡重播（含 19:43–19:47 北上／連峰街拒絕與 19:49 南下確認）、楊梅起站大平街 246 號 L 型彎道走廊確認、越站 `outside_target` 拒絕，以及 `isMovingTowardsApproach` 位移 >= 12m（15.5m）低速逆向阻斷之失敗測試（`test/collectionApproach.test.js`、`test/geoUtils.test.js`），留存業務 Red 失敗原文（`.scratch/early-upstream-corridor-alerts/red-ticket1.output.txt`，43 測試中 8 新測試皆為業務 AssertionError）。
- [x] 1.2 [Green] 實作 `lib/collectionApproach.js` 走廊推導與多段進場狀態機（支援 `ntpc-primary` 與 `taoyuan-primary`、維持短段 60m 與長彎道段比例上限）及 `lib/geoUtils.js` 位移優先逆向檢查，確認 Ticket 1 測試及既有純函式測試全數通過（`.scratch/early-upstream-corridor-alerts/green-ticket1.output.txt`，107／107 通過，0 失敗）。

## 2. 桃園來源標記、排程窗、核心閘道與動態 ETA (Ticket 2)

- [x] 2.1 [Red] 新增 `fetchActiveTrucks` 桃園 `taoyuan-primary`/`gps` 標記、`DEFAULT_SCHEDULE_BEFORE_MINUTES=25`、`processTruckArrivals` 汐止上游提前確認／楊梅 Stop 9 保護與 `formatArrivalMessage` 動態 `⏰ 預估抵達` 之失敗測試（`test/truckIntake.test.js`、`test/arrivalMatcher.test.js`、`test/collectionApproachCore.test.js`、`test/weightedCoreProcessor.test.js`），留存業務 Red 失敗原文（`.scratch/early-upstream-corridor-alerts/red-ticket2.output.txt`，20 測試中 6 測試為業務 AssertionError）。
- [x] 2.2 [Green] 實作 `lib/truckIntake.js` 桃園 GPS 標記與路線參數、調整 `lib/arrivalMatcher.js` 預設提前窗為 25 分鐘並抽出共用資格檢查與 `etaText` 格式化、更新 `lib/coreProcessor.js` 將汐止 Stop 3 與楊梅 Stop 9 納入多段走廊確認及 `computeApproachEtaText`，確認 Ticket 2 測試通過（`.scratch/early-upstream-corridor-alerts/green-ticket2.output.txt`，85／85 通過，0 失敗）。

## 3. 台南中繼文案、多路線 SQL RPC 與楊梅校準腳本 (Ticket 3)

- [x] 3.1 [Red] 新增 `/api/tainan-relay` 顯示「⏰ 預估抵達：約 10 分鐘內」與同路線上游站名導向 Stop 6 失敗測試（`test/tainanRelay.test.js`、`test/tainanRelayRouting.test.js`），及 PGlite SQL 驗證（`lagi2-006_2_21` Stop 9 已註冊可提交且未註冊鍵仍拒）失敗驗證。
- [x] 3.2 [Green] 更新 `api/tainan-relay.js`、新增 `supabase/update_collection_approach_corridor.sql`、同步更新 `supabase/add_collection_approach_confirmation.sql`、更新 `scripts/verifyCollectionApproachSql.mjs` 與 `scripts/applyYangmei.js`，通過單元測試與隔離 PGlite SQL 驗證。

## 4. 驗收、雙軸審查、資料庫校準與交付收尾 (Ticket 4)

- [x] 4.1 執行全套無網路測試 `npm test`、隔離 PGlite SQL 檢查及 `openspec validate early-upstream-corridor-alerts --strict`。
- [x] 4.2 依 `.agents/rules/code-review.md` 以固定基準執行 Standards ＋ Spec 雙軸高階審查、修復發現問題、重跑必要回歸測試並完成重審至兩軸 0 未解。
- [x] 4.3 依使用者授權更新 Supabase 楊梅 `stops` 資料（維持 Stop 9 `17:15:00`、校準 `大平街246號` `17:10:00` 與 `中山南路100號` `17:14:00`），更新 `docs/collection-approach-confirmation.md`、產出 `docs/reports/` 驗證報告、更新 `HANDOVER.md`、同步主規格並 archive 本變更，最後由 `flash_lite` 子代理執行 Git commit + push（提示維運於 Supabase SQL Editor 執行增量 RPC SQL 後再部署 Cloud Run）。
