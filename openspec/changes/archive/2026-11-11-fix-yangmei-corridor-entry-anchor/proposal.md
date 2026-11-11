# Proposal

## Why

2026-11-10 楊梅路線（`lagi2-006_2_21`、Stop `9` `楊梅區中山南路146號`）未發送通知之診斷結果顯示：
1. **直接阻斷原因**：正式區 Supabase 尚未於 SQL Editor 執行 `supabase/update_collection_approach_corridor.sql`，舊版 `public.commit_collection_approach` RPC 硬編碼僅允許 `('221010', '3')`，對楊梅回傳 `{ applied: false, version: null }`；而 `observeCollectionApproach` 在首次寫入（`expectedVersion === 0`）收到 `version: null` 時仍誤當作 CAS 衝突重試 3 次並輸出 `storage conflict retry limit reached`，掩蓋了 RPC 白名單／參數拒絕的真實原因。
2. **軌跡幾何邊界原因**：回放桃園官方 `lagifQueryTraceByRoute` 真實軌跡（60s／90s／120s 輪詢）發現，清運車 `KEK-3178` 於 `17:00–17:10` 由西北側清潔隊往東（約 `96°`）駛入路線起站 Rank 1 `大平街246號(右邊)` 時，與 Segment 0（西南向 `225.7°`）夾角 `> 90°`，在抵達起站瞬間被誤判為 `opposite_direction` 並鎖定 `requiresPredecessorPass = true`；且下一輪輪詢（60～120 秒後）車輛駛入大平街中段（距起站 `> 100m`）並進入大平街轉中山南路之 L 型彎角（局部航向 `142°–161°`，與 `225.7°` 弦向夾角 `64°–83°`），導致漏失第 1 站早期錨點或落入 `ambiguous_direction`。

## What Changes

- **起站進場免除逆向鎖定**：於 `lib/collectionApproach.js` 的 `evaluateCollectionApproach` 中，當車輛位於目標站 `120m` 圍欄外、正接近多段走廊之路線起站（`segments.length >= 2`、起站 `rank/order_index === 1`、段長 `> 250m`、距起站 `<= 80m` 且較前次採樣更接近起站）時，視為由清潔隊進入起站的正常進場，不觸發 `opposite_direction` 逆向鎖定，並允許建立起站錨點（狀態仍維持 `pending`，後續必須沿走廊順向推進才可 `confirmed`）。
- **長彎道上游路段中段錨點與 L 型彎角順向推進**：對長距離彎道上游路段（`k < segments.length - 1` 且 `seg.len > 250m`、距目標站 `> 120m`），放寬上游錨點建立範圍至走廊前中段（`along` 介於 `-20m` 至 `seg.len * 0.65` 且橫向偏差 `<= segMaxLateral`）；當車輛於該長彎道上游路段移動 `>= 20m` 且夾角 `<= 85°`（嚴格 `< 90°` 非逆向），同時距該段終點站距離縮短 `>= 8m`、沿走廊投影前進 `>= 10m` 時，視為有效順向推進，避免 L 型街區轉折外弧段被 `60°` 弦向夾角或直線歐氏距離誤判為 `ambiguous_direction` 或 `insufficient_progress`。
- **RPC 拒絕診斷可觀測性**：於 `observeCollectionApproach` 中，當 `expectedVersion === 0` 且 `store.commit` 回傳 `{ applied: false, version: null }` 時，額外記錄明確之 RPC 拒絕告警（提示檢查 SQL 遷移或 `public.stops` 登錄狀態），與一般 CAS 樂觀鎖版本衝突區隔。

## Capabilities

### Modified Capabilities

- `collection-approach-confirmation`: 補強路線起站（Stop 1）進場錨點建立、長距離 L 型彎道上游路段順向判定，以及 RPC 拒絕之診斷告警。

## Impact

- 影響檔案：`lib/collectionApproach.js`、`test/collectionApproach.test.js`、`test/collectionApproachStore.test.js`、`docs/adr/0013-early-upstream-corridor-approach.md`、`openspec/specs/collection-approach-confirmation/spec.md`。
- 既有保護不變：目標站 `120m` 內與短路段（`<= 250m`，含汐止 `221010` 全部路段與楊梅最後一段）之 `60°` 順向夾角、`> 90°` 逆向鎖定、`<= 25 km/h` 速度上限及起站東北向逆向駛離拒絕均完全維持。
