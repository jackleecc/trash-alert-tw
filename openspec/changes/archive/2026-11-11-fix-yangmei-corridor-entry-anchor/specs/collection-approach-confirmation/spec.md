# Delta for collection-approach-confirmation

## MODIFIED Requirements

### Requirement: Continuous predecessor approach can span polling cycles

系統 SHALL 自目標站點依拓撲往前追溯連續同向且在班表時差範圍內的站點作為上游進場走廊（Approach Corridor），支援跨輪詢追蹤任一上游走廊站點之錨點，並以後續可信順向推進樣本在進入目標站前或目標圍欄內確認進場；不要求120公尺內兩輪觀測，亦不允許越過目標站點後於目標圍欄外確認。前站錨點有效300秒，可信方向有效180秒；無可靠位移的低速或漂移只能沿用未到期方向。相隔2至180秒且位移至少10公尺的可信順向樣本即使低速亦可建立方向。對段長不超過250公尺之筆直路段，走廊橫向偏差上限為60公尺；對段長超過250公尺之彎道／跨街區路段，橫向偏差上限依段長比例放寬至最多200公尺。當車輛自外部道路接近多段走廊之路線第1站（距目標站超過120公尺、距起站80公尺內且距起站距離縮短至少10公尺）時，系統 SHALL 允許建立起站待確認錨點而不因進場角度大於90度誤鎖逆向；且於段長超過250公尺之上游彎道段中，允許於走廊前中段（投影進度不超過段長65%）建立上游錨點，並將位移至少20公尺、夾角不超過85度、距該段終點縮短至少8公尺且沿段投影前進至少10公尺之移動視為可信順向推進。

#### Scenario: Two minute polling enters target once
- **WHEN** 同車先在343巷口有效前站區，120秒後南下移動進入333巷口120公尺內，前進及距離縮短皆至少20公尺、路廊橫向偏差不超過60公尺且速度不超過25km/h
- **THEN** 在第一次進入目標圍欄時即可確認，不多等一輪

#### Scenario: Predecessor spatial anchor
- **WHEN** 樣本距343巷口不超過100公尺且沿343→333軸向投影不超過50公尺
- **THEN** 可記為前站證據；不符合區域的目標站旁樣本不能替代前站證據

#### Scenario: Direction expires while stopped
- **WHEN** 車輛低速或漂移且最近可信同向方向已超過180秒
- **THEN** 待確認；相同座標的新時間不能延長方向有效期限

#### Scenario: Reliable slow southbound movement
- **WHEN** 同車由343巷口120秒後到達333巷口，位移約153公尺且推算速度約4.58km/h
- **THEN** 可建立可信南下方向並在其餘條件成立時確認，不因低於5km/h待確認

#### Scenario: Anchor expires or lateral movement
- **WHEN** 前站證據超過300秒，或當前樣本離作用中走廊路段軸線超過對應橫向偏差上限
- **THEN** 不確認，等待有效前站與進場證據

#### Scenario: Early confirmation along Xizhi upstream corridor
- **WHEN** 車輛於汐萬路二段37巷口（Rank 14）建立南下前站錨點，並於下一輪以 <= 25km/h 順向南下推進 >= 20公尺、距333巷口距離縮短 >= 20公尺且位於37巷口→411號→343巷口→333巷口走廊內
- **THEN** 在距333巷口約400～500公尺處即提前確認並僅觸發該日單次通知，而先前於連峰街或北上逆向通過時仍保持待確認／拒絕

#### Scenario: Yangmei first-stop anchor and L-bend corridor confirmation
- **WHEN** 車輛自清潔隊方向由西向東駛入楊梅起站大平街246號(右邊)（17:10）或於60～120秒輪詢間進入大平街上游段，後續依大平街→中山南路100號（17:14）→中山南路146號（17:15）L型走廊（含大平街南南東145°轉折段）以 <= 25km/h 順向推進（位移 >= 20公尺、投影前進 >= 10公尺且距該段終點縮短 >= 8公尺）
- **THEN** 進站時不誤鎖逆向、於大平街建立錨點並在順向推進時即提前確認通知；單點首次出現或由起站往東北逆向駛離則不通知

#### Scenario: Past target stop outside radius remains pending
- **WHEN** 車輛已通過目標站點且距離目標站點超過120公尺
- **THEN** 狀態為待確認（`outside_target`），不得於離站後確認發送

### Requirement: Shared approach RPC validates registered stops dynamically

`commit_collection_approach` SQL RPC MUST 驗證 `(routeId, stopId)` 已登錄於 `public.stops`，而非僅寫死單一 `(221010, 3)`，並拒絕未登錄路線／站點鍵且不建立空白狀態列；當 `observeCollectionApproach` 於初始版本（`expectedVersion = 0`）收到 RPC 回傳 `{ applied: false, version: null }` 時，系統 SHALL 輸出明確之 RPC 拒絕告警日誌以利維運辨識 SQL 遷移或站點登錄狀態。

#### Scenario: Registered stops across routes succeed while unregistered keys fail
- **WHEN** `public.stops` 包含 `(221010, 3)` 與 `(lagi2-006_2_21, 9)`，分別提交合法狀態與未登錄之 `(221032, 3)`
- **THEN** 已登錄站點可正常以原子版本遞增提交，未登錄鍵回傳 `applied: false` 且不留空白狀態列

#### Scenario: Initial RPC rejection logs explicit diagnostic warning
- **WHEN** `observeCollectionApproach` 在尚無既有狀態（`expectedVersion = 0`）下呼叫 `store.commit` 並收到 `{ applied: false, version: null }`
- **THEN** 結果維持待確認（`storage_conflict`），且輸出包含 `RPC rejected key or payload` 之告警日誌
