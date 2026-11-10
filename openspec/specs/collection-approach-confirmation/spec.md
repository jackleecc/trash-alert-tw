# collection-approach-confirmation Specification

## Purpose

對汐止既有訂閱清運點，以具可信採樣時間的車輛軌跡確認沿前站南下進場，降低低速逆向路過被當成到站的誤報；資料不足時保留待確認狀態，並留下能重建判斷的稽核證據，避免誤報提前消耗當日通知機會。

## Requirements

### Requirement: Protected stop notification requires confirmed approach

系統 SHALL 僅對受保護站點清單（路線 `221010` 站點 id `3`，以及路線 `lagi2-006_2_21` 站點 id `9`）套用進場確認；既有排程窗、走廊／目標範圍、垃圾車類別、訂閱及路線信任條件仍須成立。純幾何匹配不是通知許可；只有確認結果才能進入通知調度。其他站點維持既有匹配行為。

#### Scenario: Unknown first observation
- **WHEN** 保護站點19公尺內或上游站點第一次出現車輛，無可信歷史方向或前站證據
- **THEN** 結果為待確認且不發送通知

#### Scenario: Unrelated stop compatibility
- **WHEN** 非受保護清單內之既有測試車輛（例如站點 id `99`）依舊規則匹配
- **THEN** 匹配結果不因本能力而改變

#### Scenario: Existing gate still applies
- **WHEN** 進場已確認但超出排程窗、既不在上游走廊亦超出目標圍欄、未通過信任名單、路線代碼不符或屬資源回收車
- **THEN** 不發送到站通知

### Requirement: Position sampling provenance is mandatory

系統 MUST 區分GPS採樣時間與來源回應時間；保護站點只使用已知主來源（`ntpc-primary` 或 `taoyuan-primary`）且具備可信GPS採樣時間（`timestampKind='gps'`）形成確認證據。GPS年齡須介於未來30秒與過去180秒，時間缺失、無效、過期或無可信車號均不得確認。不得以排程執行時間補造GPS時間。

#### Scenario: Website response timestamp only
- **WHEN** 網站備援具有新鮮頂層TimeStamp但無逐車GPS時間，即使連續回應座標不同
- **THEN** 保護站點保持待確認，不把回應時間當作GPS時間；保留來源與時間種類供稽核

#### Scenario: Freshness boundaries
- **WHEN** GPS年齡為180秒或未來30秒
- **THEN** 可納入後續判斷；超過任一界線、錯誤時間、空車號均不得確認

#### Scenario: Source switching
- **WHEN** 車輛由主來源切換至僅回應時間的備援，再切回主來源
- **THEN** 不將備援時間與主來源座標組成速度或方向；新來源須重新建立可信前站與方向證據

#### Scenario: Taoyuan primary GPS provenance
- **WHEN** 桃園市即時端點回傳含有效車機 `gpstime` 之車輛位置且標記 `source='taoyuan-primary'`、`timestamp_kind='gps'`
- **THEN** 系統將其視為可信 GPS 採樣時間納入受保護站點進場確認

### Requirement: Opposite movement precedes low speed exemptions

系統 SHALL 以相隔2至180秒且位移至少10公尺的可信GPS樣本檢查方向；與343→333進場方位角夾角大於90度時拒絕並清除既有前站及同向證據，不能以車速低於5km/h豁免。有效reported或推算速度大於25km/h亦拒絕。

#### Scenario: Slow northbound road pass
- **WHEN** 車輛北上位移至少10公尺且reported speed為3km/h
- **THEN** 拒絕，即使車輛已在120公尺內

#### Scenario: Cruising southbound
- **WHEN** 南下車的有效reported或可信GPS推算速度大於25km/h
- **THEN** 拒絕而不確認收運進場

#### Scenario: Drift after reverse
- **WHEN** 拒絕北上後車輛低速或漂移少於10公尺
- **THEN** 不恢復已清除的南下證據，不能確認

### Requirement: Continuous predecessor approach can span polling cycles

系統 SHALL 自目標站點依拓撲往前追溯連續同向且在班表時差範圍內的站點作為上游進場走廊（Approach Corridor），支援跨輪詢追蹤任一上游走廊站點之錨點，並以後續可信順向推進樣本在進入目標站前或目標圍欄內確認進場；不要求120公尺內兩輪觀測，亦不允許越過目標站點後於目標圍欄外確認。前站錨點有效300秒，可信方向有效180秒；無可靠位移的低速或漂移只能沿用未到期方向。相隔2至180秒且位移至少10公尺的可信順向樣本即使低速亦可建立方向。對段長不超過250公尺之筆直路段，走廊橫向偏差上限為60公尺；對段長超過250公尺之彎道／跨街區路段，橫向偏差上限依段長比例放寬至最多200公尺。

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
- **WHEN** 車輛於楊梅起站大平街246號(右邊)（17:10）建立錨點，後續依大平街→中山南路100號（17:14）→中山南路146號（17:15）走廊以 <= 25km/h 順向西南推進 >= 20公尺且距離目標站縮短 >= 20公尺
- **THEN** 即使第1站無更前一站且路段含L型街區轉折，仍於確認順向推進時提前通知；單點首次出現或逆向駛離則不通知

#### Scenario: Past target stop outside radius remains pending
- **WHEN** 車輛已通過目標站點且距離目標站點超過120公尺
- **THEN** 狀態為待確認（`outside_target`），不得於離站後確認發送

### Requirement: Shared state survives instance changes and rejects ordering races

系統 MUST 依台灣日期、路線、站點及車號隔離共享狀態，跨實例以版本比較原子保存狀態與逐次判斷證據。重複與失序樣本不得覆寫較新狀態或形成新確認；儲存、schema或原子保存失敗時不得通知。狀態900秒到期後視為首次觀測。

#### Scenario: Different instance confirms
- **WHEN** 實例A保存前站樣本，實例B收到新鮮南下進場樣本
- **THEN** B讀取共享證據後可確認，無須依賴實例A記憶體

#### Scenario: Concurrent or out of order observations
- **WHEN** 兩個實例同時處理同鍵、同採樣時間或較舊採樣時間
- **THEN** 最多一筆可推進該版本；其他結果不得新增確認或覆寫已提交的新狀態

#### Scenario: Latest sample governs batch candidate
- **WHEN** 同輪同車先有確認樣本、後有逆向或待確認樣本
- **THEN** 只以最新無歧義樣本形成保護候選，不發送較舊確認位置的通知

#### Scenario: Conflicting latest observations
- **WHEN** 同車最新採樣時間相同卻有矛盾座標，或同輪主備來源互相衝突
- **THEN** 保守待確認，不任意挑一筆或把另一筆車號的結果套到此候選

#### Scenario: Storage unavailable
- **WHEN** 共享資料表或RPC尚未安裝、回傳錯誤、例外或衝突重試用盡
- **THEN** 保護站點待確認且記錄可見診斷；其他站點仍可依舊規則處理

#### Scenario: Identity and date isolation
- **WHEN** 車號、路線、站點或台灣日期不同，或狀態超過900秒未更新
- **THEN** 不沿用先前車輛／前日／過期的前站或方向證據

### Requirement: Pending decisions preserve notification opportunity

系統 MUST 在待確認與拒絕時不建立Notification Intent、不佔Cooldown Claim、不扣LINE額度、不寫notification_logs、不造成當日休眠。判斷稽核 SHALL 保存採樣／觀測時間、來源時間種類、位置、速度與方向證據、結果及原因；不能只保留每日彙總。

#### Scenario: Pending then true collection
- **WHEN** 同日先待確認或拒絕，之後有通過全部條件的確認樣本
- **THEN** 前次結果未佔通知機會，後續可正常進入既有原子通知調度

#### Scenario: Decision reconstruction
- **WHEN** 檢視某次已成功保存的判斷
- **THEN** 可識別來源、車號、GPS與接收時間、方向／前站證據及未通知原因；不得誤記為已發送

### Requirement: Arrival text avoids unsupported ETA

到站提醒 SHALL 使用「車輛已接近站點」，不得出現未經估算的固定「約2～5分鐘」字樣；未提供動態預估欄位時保留向後相容不顯示預估行，當系統依確認距離與走廊進場上下文提供動態預估時 SHALL 顯示「⏰ 預估抵達：<動態區間>」，其餘站點、路線、車號、距離、地圖、天氣與配額資訊保留。

#### Scenario: Arrival notification rendering
- **WHEN** 未傳入動態 `etaText` 產生到站提醒文字
- **THEN** 顯示「車輛已接近站點」且不含固定2～5分鐘估計或預估行

#### Scenario: Dynamic ETA rendering on confirmed approach
- **WHEN** 傳入依已確認距離或走廊計算之 `etaText` 產生到站提醒文字
- **THEN** 顯示「車輛已接近站點」、保留距離與各既有欄位，並顯示對應「⏰ 預估抵達：...」且不包含固定「2～5 分鐘」

### Requirement: Schedule window lead time covers upstream tracking

智慧排程預設提前監控分鐘數 `DEFAULT_SCHEDULE_BEFORE_MINUTES` SHALL 調整為 25 分鐘，以涵蓋上游走廊提前偵測並銜接 17:00 服務時間窗開跑；`isWithinScheduleWindow` 未顯式傳入提前分鐘數時之預設參數 15 分鐘維持相容不變。

#### Scenario: Upstream schedule window at 25 minutes early
- **WHEN** 透過 `DEFAULT_SCHEDULE_BEFORE_MINUTES` 檢核汐止 19:56:00（如 19:31 起）或楊梅 17:15:00（如 17:00 起）之訂閱上下文
- **THEN** 均判定在表定監控時間窗內

### Requirement: Non-protected approach bearing check blocks slow reverse passes

`isMovingTowardsApproach` SHALL 僅在位移小於 12 公尺或缺少前次座標時套用靜止／低速漂移豁免；當具有前次座標且位移至少 12 公尺、方位角與法定進場角夾角大於 90 度時，即使車速低於 5 km/h 亦 MUST 回傳 `false` 阻斷（受保護站點之狀態機仍維持 10 公尺門檻）。

#### Scenario: Low-speed reverse with reliable displacement is rejected
- **WHEN** 車輛具備前次座標且位移 >= 12 公尺、時速為 3 km/h、行進方向與進場方位角相反（夾角 180 度）
- **THEN** `isMovingTowardsApproach` 回傳 `false`

#### Scenario: Sub-12m stationary GPS jitter remains exempt
- **WHEN** 車輛位移小於 12 公尺且時速低於 5 km/h
- **THEN** `isMovingTowardsApproach` 維持回傳 `true`

### Requirement: Shared approach RPC validates registered stops dynamically

`commit_collection_approach` SQL RPC MUST 驗證 `(routeId, stopId)` 已登錄於 `public.stops`，而非僅寫死單一 `(221010, 3)`，並拒絕未登錄路線／站點鍵且不建立空白狀態列。

#### Scenario: Registered stops across routes succeed while unregistered keys fail
- **WHEN** `public.stops` 包含 `(221010, 3)` 與 `(lagi2-006_2_21, 9)`，分別提交合法狀態與未登錄之 `(221032, 3)`
- **THEN** 已登錄站點可正常以原子版本遞增提交，未登錄鍵回傳 `applied: false` 且不留空白狀態列
