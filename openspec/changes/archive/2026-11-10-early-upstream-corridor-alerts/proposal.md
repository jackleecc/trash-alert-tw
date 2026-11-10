# Proposal

## Why

目前系統須待垃圾車進入目標站點 120～250 公尺圍欄內才發送 LINE 通知，使用者僅剩約 1～3 分鐘打包垃圾並下樓移動；使用者希望維持每日單次通知（不額外消耗每月 200 則免費額度）且不放寬逆向／路過誤報防護的前提下，於上游順向進場路段提早發出通知。

## What Changes

- 將既有單前站進場確認擴展為「上游進場走廊（Approach Corridor）」，在保有嚴格順向（`<= 60°`）、逆向優先攔截（`> 90°` 不受低速豁免）、速度上限（`<= 25 km/h`）與可信 GPS 採樣檢驗下，於車輛自走廊上游站點順向推進時提前確認並發送每日單次通知。
- 將桃園楊梅（路線 `lagi2-006_2_21`、Stop `9`）納入相同共享軌跡確認機制，補齊桃園主來源（`taoyuan-primary`）GPS 採樣時間標記，保留真實到站時間 `17:15:00` 並校準上游起站 `大平街246號(右邊)`（`17:10:00`）與 `中山南路100號`（`17:14:00`），修復負班表時差導致的方向豁免。
- 將智慧排程提前時間窗 `DEFAULT_SCHEDULE_BEFORE_MINUTES` 由 18 分鐘放寬為 25 分鐘，確保上游進場走廊提前追蹤不遭時間窗阻斷；並補強 `geoUtils.isMovingTowardsApproach` 使其在位移 `>= 10` 公尺時不因低速豁免逆向。
- 更新 `commit_collection_approach` SQL RPC 驗證規則以支援 `public.stops` 內受保護之多路線站點（交付增量 SQL 遷移腳本，供上線前套用）。
- **BREAKING / 文案調整**：`formatArrivalMessage` 在獲得動態推算 `etaText` 時顯示 `⏰ 預估抵達：...`（未傳入時維持向後相容、絕不寫死 `2～5 分鐘`）；台南中繼端點 `/api/tainan-relay` 配合手機「臺南環保通」App 提早 10 分鐘設定，改顯示 `⏰ 預估抵達：約 10 分鐘內` 並支援同路線上游站名自動對應至已訂閱站點。

## Capabilities

### New Capabilities

- `tainan-relay-early-notification`: 台南手機通知中繼配合 App 提早 10 分鐘設定，支援同路線上游站名對應並輸出 `約 10 分鐘內` 預估抵達文案。

### Modified Capabilities

- `collection-approach-confirmation`: 擴展受保護站點範圍至楊梅 Stop `9`，支援多段上游順向進場走廊提前確認、桃園主來源 GPS 採樣標記、一般站點 `>= 10m` 低速逆向阻斷、25 分鐘排程提前窗，以及依確認位置動態計算之抵達預估行。

## Impact

- 影響檔案：`lib/collectionApproach.js`、`lib/coreProcessor.js`、`lib/arrivalMatcher.js`、`lib/geoUtils.js`、`lib/truckIntake.js`、`api/tainan-relay.js`、`CONTEXT.md`、`docs/adr/0013-early-upstream-corridor-approach.md`、`supabase/add_collection_approach_confirmation.sql`、新增 `supabase/update_collection_approach_corridor.sql`、`scripts/applyYangmei.js` 與 `scripts/verifyCollectionApproachSql.mjs`。
- 資料庫與部署相依：本次經使用者授權於本機完成規格、TDD 與審查後更新 Supabase 楊梅 `stops` 資料（保留 Stop `9` `17:15:00` 并補齊/校準上游站點），但因本機無 PostgreSQL DDL 權限，更新版 `commit_collection_approach` SQL 須由維運於 Supabase SQL Editor 執行後再部署 Cloud Run；本輪禁止呼叫真實 LINE API。
