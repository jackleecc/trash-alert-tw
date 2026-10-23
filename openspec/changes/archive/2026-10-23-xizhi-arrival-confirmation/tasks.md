# Tasks

## 1. 通知入口防止首次路過誤報

- [x] 1.1 在公開 processTruckArrivals 入口以mock DB、HTTP與通知傳輸建立「19:45／19m首次樣本不得通知」業務Red，保存完整測試與原始assertion失敗；不以import錯誤驗收。
  - Red 證據：`test/collectionApproachCore.test.js`；完整副本與原始輸出：`.scratch/xizhi-arrival-confirmation/red-01.test.js`、`red-01.output.txt`。既有核心回傳 `matchedArrivals: 1` 並呼叫 dispatch 1 次，業務 assertion 預期兩者皆為 0。
- [x] 1.2 在核心通知前對exact route221010／Stop3套用保守確認gate，缺少confirmed結果即待確認，不進dispatch、claim、quota或notification_logs，其他站點沿用既有流程；以1.1測試Green及全套測試驗收。
  - Green證據：`node --require ./.scratch/ntpc-backup/deny-network.cjs --test test/collectionApproachCore.test.js`通過；全套`node --require ./.scratch/ntpc-backup/deny-network.cjs --test test/*.test.js`通過235/235，輸出見`.scratch/xizhi-arrival-confirmation/green-01.output.txt`。在Task 2.x確認服務接上前，受保護站點一律pending。

## 2. 可信軌跡與共享原子狀態

- [x] 2.1 逐一以業務Red／Green完成純evaluateCollectionApproach：低速逆向、首次待確認、343→333在120秒首次入圈確認、漂移方向期限、前站期限、freshness、來源切換、失序與缺拓撲；驗收公開純函式測試及原始Red證據，契約依design。
  - 測試：`test/collectionApproach.test.js` 27/27通過，包含duplicate／out-of-order不覆寫（含超速樣本）、方向歧義、60m走廊、速度、state／anchor／direction期限、freshness、source切換與無效首樣本不污染基準等邊界；真Red與完整測試快照／原始輸出見`.scratch/xizhi-arrival-confirmation/red-03-01`至`red-03-12`（red-03-10校正無效走廊fixture；red-03-11/12有效Red）。
  - 驗收：focused純函式＋公開core入口29/29通過，輸出`.scratch/xizhi-arrival-confirmation/green-03-focused.output.txt`；網路guard全套263/263通過，輸出`.scratch/xizhi-arrival-confirmation/green-03-all.output.txt`。
- [x] 2.2 以Red／Green實作observeCollectionApproach與Supabase store，覆蓋跨實例、CAS衝突重算、最多3次、DB錯誤待確認及提交成功才confirmed；新增兩表一RPC增量SQL與使用說明，本機Postgres驗證原子state/event、版本競爭及service_role權限，禁止套正式DB。
  - Store測試：`test/collectionApproachStore.test.js` 9/9通過；包含同一GPS並行最多一次confirmed、CAS衝突重讀重算、3次耗盡、讀寫錯誤／缺schema／malformed result fail-closed、UTC+8日期與車輛隔離、事件稽核欄位及無效採樣時間處理。真Red副本／輸出：`.scratch/xizhi-arrival-confirmation/red-04-01.test.js`、`red-04-01.output.txt`（無效觀測時間拋RangeError）、`red-04-02.test.js`、`red-04-02.output.txt`（`applied:'false'`錯誤地放行confirmed）。
  - SQL驗收：`node .scratch/xizhi-arrival-confirmation/verify-sql.mjs`使用本機PGlite PostgreSQL 18.6／PGlite 0.5.11，11項通過，輸出`.scratch/xizhi-arrival-confirmation/green-sql.output.txt`；包含重複執行、CAS、事件rollback、invalid input／無placeholder、RLS與權限、search_path及同expectedVersion單winner。未套用正式資料庫。
  - 回歸：2.1純函式＋core＋store focused 38/38通過，`.scratch/xizhi-arrival-confirmation/green-04-focused.output.txt`；網路guard全套272/272通過，`.scratch/xizhi-arrival-confirmation/green-04-all.output.txt`。
- [x] 2.3 以Red／Green在canonical新北主intake標示GPS來源，raw樣本在legacy telemetry之前追蹤，只有最新無歧義樣本形成保護候選；驗收source-only待確認、同車批次矛盾、舊確認後新逆向不通知、pending後真進場仍通知與其他地點相容。
  - Intake canonical provenance：`test/ntpcWebsiteBackup.test.js` 16/16，Red／Green材料`.scratch/xizhi-arrival-confirmation/red-05-01.*`、`green-05-01.*`；驗證canonical endpoint逐車valid time標`ntpc-primary/gps/source_timestamp`，invalid time不標，canonical exact override依endpoint仍標，response-only及他城保持原契約。
  - Core batch：`test/collectionApproachBatch.test.js`涵蓋最新pending/outside與northbound覆蓋舊confirmed、same-time座標衝突audit、primary/website矛盾保留原始response時間、exact duplicate最多一intent、speed3/26同座標樣本不因dedupe遺失超速、reported speed12正常確認、recycling不可建anchor或沿用較舊garbage、不同車隔離、source-only／缺topology待確認、legacy Map不影響raw確認、儲存錯誤不阻擋一般Stop99。Red材料`.scratch/xizhi-arrival-confirmation/red-05-02`至`red-05-11`及`red-05-14`；Green材料`green-05-02`至`green-05-14`，batch focused 14/14。
  - 純matcher幾何副本與raw sample identity以WeakMap關聯，避免移除motion fields後遺失valid reportedSpeed身份；core focused及全套網路guard 289/289，輸出`.scratch/xizhi-arrival-confirmation/green-05-all.output.txt`；OpenSpec strict validate通過。未改SQL，因此本階段未重跑PGlite。

## 3. 文案、稽核與整體驗收

- [x] 3.1 以formatter業務Red／Green移除固定2～5分鐘，顯示「車輛已接近站點」並保留其餘欄位；決策稽核包含來源／採樣／接收時間、位置、速度／方向、前站與reason，SQL不可用時有可見診斷。
  - Red：`.scratch/xizhi-arrival-confirmation/red-05-13.test.js`／`red-05-13.output.txt`，公開`formatArrivalMessage` assertion證實缺少「車輛已接近站點」。Green將標題替換並移除固定ETA，其他位置、路線、距離、車號、天氣、地圖與額度欄位保留；`test/arrivalMatcher.test.js`＋`test/coreProcessor.test.js` 26/26，輸出`green-05-13.output.txt`。稽核／storage可見診斷已在2.2完成並由上述batch事件驗證。
- [x] 3.2 拒絕真實網路下執行全部測試、OpenSpec strict validate與本機SQL檢查；在docs/reports記錄Red／Green、SQL、資料限制與未部署／未套正式migration，更新HANDOVER。
  - 主代理獨立執行納入guard的新預設`npm test`：289／289，0 skipped；納入版本控制的SQL verifier使用隔離PGlite0.5.11驗證11／11，strict validate通過。報告docs/reports/xizhi-arrival-confirmation-2026-10-23.md，最終本機輸出final-tests.txt／final-sql.txt；正式DB與部署仍未操作。
- [x] 3.3 以固定基準1e94d02a1b776aa98211b3b79919c01c95991f61及完整差異執行Standards／Spec兩個High代理審查；修正所有阻礙問題、必要回歸及重審，在報告分軸保存原findings與結論。
  - 首輪Standards 3項（最嚴重P2）、Spec 1項（P2），原findings分軸保留於報告；補成功store的first_sample測試、response raw時間稽核Red／Green、共用state更新與直接export。重審固定完整差異SHA256 8165cb3f6192d01068e1d2c0199987adc4e9339717133abd8ecf3b24c190ba78；兩位gpt-6.1-sol／High獨立確認皆0未解問題／0新增問題，focused39／39各自通過。主代理重跑npm test 290／290，0 skipped，輸出final-tests-02.txt。

## Workflow follow-up

- 同步主規格、驗證後archive本change並更新ADR連結及HANDOVER；依使用者明示授權由Git Low代理只提交本次allowlist、push並核對遠端SHA。
- 正式SQL套用、部署、跨Cloud Run實例與服務時段GPS／實際清運驗收均待另行授權，不以本次離線結果宣告正式恢復。
