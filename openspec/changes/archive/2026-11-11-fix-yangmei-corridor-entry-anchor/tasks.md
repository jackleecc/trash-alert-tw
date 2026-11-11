# Tasks

## 1. 楊梅走廊起站進場、大平街 L 型彎道錨點與 RPC 拒絕告警 (Ticket 1)

- [x] 1.1 [Red] 於 `test/collectionApproach.test.js` 與 `test/collectionApproachStore.test.js` 新增失敗測試：(a) 車輛自西側／清潔隊方向東行進入楊梅第 1 站 `大平街246號(右邊)` 不誤判為 `opposite_direction`，並於下一輪沿大平街順向推進時 `confirmed`；(b) 60s/90s 輪詢跳過起站 80m 圈直接落在大平街中段（`24.90951, 121.13932`）建立錨點，下一輪經大平街 `145°` 南南東彎角（`24.90903, 121.13969`）順向推進即 `confirmed`；(c) `observeCollectionApproach` 在 `expectedVersion === 0` 遭遇 `{ applied: false, version: null }` 時記錄 RPC 拒絕診斷告警。確認業務 assertion 真失敗（`.scratch/fix-yangmei-corridor-entry-anchor/red-ticket1.output.txt`，46 測試中 43 通過、3 新增測試皆為業務 AssertionError）。
- [x] 1.2 [Green] 於 `lib/collectionApproach.js` 實作起站進場免鎖逆向（`isOriginStopEntry`）、長彎道上游段中段錨點與 L 型彎角順向推進（`isCurvedUpstreamForward`）及 RPC 拒絕診斷日誌，確認新增測試與既有測試全數通過（`.scratch/fix-yangmei-corridor-entry-anchor/green-ticket1.output.txt`，46/46 通過，全套 `npm test` 322/322 通過）。

## 2. 驗收、雙軸審查與歸檔交付 (Ticket 2)

- [x] 2.1 執行 `npm test` 全套測試（`322/322` 通過）及 `openspec validate fix-yangmei-corridor-entry-anchor --strict`（通過）。
- [x] 2.2 依 `.agents/rules/code-review.md` 執行 Standards ＋ Spec 雙軸高階審查至 0 未解問題（Round 2 於 `review-02.diff` 兩軸皆 PASS，0 未解、0 新增），同步主規格並 archive 變更、更新 `HANDOVER.md`。
