# Design

## 1. 路線起站（Stop 1）車隊進場與逆向鎖定邊界

- 在楊梅路線 `lagi2-006_2_21` 中，`segments[0].from` 為全路線第 1 站 `大平街246號(右邊)`（`order_index = 1`），`segments[0]` 長度 `434.9m`（`> 250m`）。
- 車輛在 `17:10` 前從西北側清潔隊或西側幹道由西向東（約 `96°`）駛入 `大平街246號(右邊)` 時，由於尚未進入走廊收運方向（西南向 `225.7°`），若直接套用 `angle > 90°` 逆向拒絕，會在抵達起站瞬間清掉錨點並設 `requiresPredecessorPass = true`。
- **判定條件（`isOriginStopEntry`）**：
  - `segments.length >= 2` 且 `segments[0].len > 250`
  - `Number(segments[0].from.rank ?? segments[0].from.order_index ?? 0) === 1`
  - 當前樣本距目標站 `distanceMeters(sample, stop) > TARGET_RADIUS_METERS`（`120m`）
  - 當前樣本距起站 `toOriginStop <= 80m`，且相較於 `previousSample` 明顯朝起站接近（`prevToOriginStop - toOriginStop >= 10m`）
- 當 `isOriginStopEntry` 成立時：
  - 不因進站航向與走廊首段夾角 `> 90°` 而拒絕，亦不設定 `requiresPredecessorPass = true`（若先前在車隊出車途中曾被設為 `true`，抵達起站時解除之），允許在起站建立 `pending` 錨點。
  - 反之，若車輛已位於起站（如 `prevToOriginStop === 0`）卻往東北方駛離（`toOriginStop` 增加且與走廊夾角 `> 90°`），`isOriginStopEntry` 為 `false`，仍嚴格觸發 `rejected (opposite_direction)`。

## 2. 長彎道上游路段中段錨點與 L 型彎角順向推進

- 楊梅 `segments[0]`（`大平街246號(右邊)` ➔ `中山南路100號`，段長 `434.9m > 250m`）實際道路軌跡先沿大平街西南行（`237°`）、再轉南南東（`142°–161°`）、南行（`184°`），最後於路口右轉西北西（`280°`）進入中山南路。
- **上游長段錨點容許**：
  - 在 `findAnchorCandidate` 中，若為非末段之長距離上游路段（`k < segments.length - 1 && seg.len > 250`）且 `distanceMeters(sample, stop) > TARGET_RADIUS_METERS`，除原有的站點 `100m` 錨點外，只要樣本位於該段走廊前中段（`proj.along >= -20 && proj.along <= Math.round(seg.len * 0.65)` 且 `proj.lateral <= seg.segMaxLateral`），即可建立該段上游錨點（`distance` 以 `Math.max(0, proj.along)` 排序，優先取更靠近上游起點者）。這確保 60～120 秒輪詢即使跳過起站 `80m` 圈、落在 `大平街` `120m–260m` 處，仍能建立上游錨點。
- **L 型彎角順向判定（`isCurvedUpstreamForward`）**：
  - 當 `activeIdx < segments.length - 1`、`activeSeg.len > 250`、`distanceMeters(sample, stop) > TARGET_RADIUS_METERS`、`activeLateral <= activeSeg.segMaxLateral` 時，若 `angle <= 85°`（嚴格 `< 90°` 正向投影）、本輪位移 `movedDistance >= 20m`，且使「距該段終點站 `activeSeg.to` 距離縮短 `>= 8m`」，即視為可信順向移動（更新 `base.direction` 且不標記 `ambiguousMovement`），並允許在走廊投影前進 `progress >= 10m` 時確認進場（不因 L 型外弧轉折處對末站之瞬時歐氏半徑微幅外擴而阻斷）。
  - 所有段長 `<= 250m` 之路段（包含汐止 `221010` 全數路段 `153m–209m` 及楊梅末段 `95m`）完全維持既有 `angle <= 60°`、`progress >= 20m`、`targetProgress >= 20m` 門檻。

## 3. RPC 白名單／參數拒絕之診斷告警

- 在 `observeCollectionApproach` 中，當 `expectedVersion === 0` 且 `committed?.applied === false && committed?.version === null` 時，代表資料庫 RPC 的前置檢查（如 `public.stops` 存在性或舊版硬編碼白名單）直接拒絕了該筆請求，而非並行交易將版本推進至 `>= 1`。此時輸出明確之 `console.warn('[CollectionApproach] RPC rejected key or payload (check SQL migration / stops registration)', ...)` 後再進入衝突處理，方便維運立即從日誌辨識 SQL 遷移狀態。
