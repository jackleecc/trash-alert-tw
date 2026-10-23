# Design

## Context

動機見proposal。`arrivalMatcher`目前把無previous或speed<5／位移<10公尺直接放行，`updateTruckTelemetry`依process Map推算previous，冷啟動及多實例無共同歷史。`coreProcessor`在幾何候選後才建立意圖並呼叫既有dispatcher。`subscriptionContext`已提供完整`allRouteStops`，但只查部分站點欄位。網站備援明確標示`timestamp_kind: response`；主來源目前只有`time`，需於已知新北主endpoint標明採樣來源。

既有正式Stop 3座標25.076252,121.649942，Rank17、19:56；前站343巷口25.077625,121.649992，Rank16（正式資料庫id25）、19:52。測試fixture的id是Rank，不能把fixture id17誤認正式id3。ADR0007的「100%阻斷」不適用現行低速漏洞，本次ADR0012補正其實證範圍。

## Goals / Non-Goals

**Goals:** 以小型純狀態機＋Supabase adapter補強一個既有站點；可注入時鐘與儲存，離線重播；在跨實例、失序與來源不足時保守待確認。

**Non-Goals:** 不建立泛用軌跡框架、不改其他城市／站點的方向規則、不改18分鐘提前窗、不保證GPS能證明現場實際收運、不新增地點、不自動套用正式SQL或部署。文案更新適用共同formatter。

## Decisions

### 1. 公開核心入口統一gate，幾何候選保持純運算

- scope為`String(stop.route_id)==='221010' && String(stop.id)==='3'`；不以站名、Rank或車牌硬編碼推測保護範圍。車輛必須`route_id===221010`且非recycling才可形成此站證據，空車號待確認。
- `processTruckArrivals`一開始保存原始樣本副本；在legacy telemetry變異前，對所有此路線樣本（包含120公尺外）呼叫共享確認service。逐車先依GPS時間排序處理，禁止從legacy `prev_lat`／`is_southbound`／衍生`speed`取得確認證據。
- 最小整合方式為分兩組呼叫既有matcher：非保護stops沿用telemetry；保護stop使用raw資料的幾何投影（移除speed、prev_lat、prev_lng、is_southbound），由新service獨自檢查原始有效reported speed與可信GPS推算speed。兩組合併前，以service結果過濾保護候選，只留committed confirmed；未取得結果必為pending。這避免legacy Map誤拒絕真車，亦避免把legacy低速豁免當許可。
- matcher所有原有schedule、radius、waste_type、trust與subscription條件仍生效；protected route mismatch必由gate拒絕。純matcher獨立呼叫只代表候選，既有純函式測試不必假造共享狀態。
- gate在observe_route_linid、天氣、Quota讀取及Notification Intent前，`matchedArrivals`只計可通知流程的已過濾候選。shared audit為獨立資料，不寫notification_logs。

替代方案：只修改geoUtils低速if仍無法解決首次放行、跨實例與前站連續性；改所有城市會破壞既有差異，故拒絕。

### 2. 純函式與服務契約

`evaluateCollectionApproach({ sample, previousState, stop, predecessor, nowMs }) -> { status, reason, nextState, evidence }`，無DB／時鐘／外部副作用。`status`為`confirmed | pending | rejected`。`sample`為`{routeId, carId, lat, lng, sampledAt: ISO|null, observedAt: ISO, source, timestampKind: gps|response|unknown, reportedSpeed: number|null}`；只有finite且>=0的speed才有效，NaN、負值、Infinity、空值均unknown而非0。

`observeCollectionApproach({ sample, stop, predecessor, dateStr, nowMs, store }) -> Promise<{status, reason, evidence}>`：read→evaluate→CAS commit，只有持久化成功才保留confirmed。store介面`read(key) -> {version,state}|null`、`commit({key,expectedVersion,nextState,event}) -> {applied,version}|{applied:false}`；null版本視為0。最多3次read/evaluate/CAS，衝突須重讀重算。任何錯誤／例外回pending `storage_unavailable`，衝突耗盡為`storage_conflict`。core可透過`options.collectionApproachStore`注入離線adapter；`options.observationNow`注入真實UTC Date，預設`new Date()`。

`key={date:台灣日期,routeId,stopId,carId}`。`dateStr`必須是有效曆日且對應nowMs在UTC+8的日期，否則從nowMs導出。`taiwanNowInfo.now`是+8小時平移後的Date，不可當真實UTC instant檢查freshness。既有schedule函式仍用hour/minute；新freshness僅用observationNow。

`state={schemaVersion:1, source, timestampKind, lastSample, anchor:null|{sample,progress,distanceToTarget}, direction:null|{bearing,observedSampleAt}, expiresAt}`。版本為資料列欄位。方向時間永遠是產生方向的GPS時間，不能以新漂移延長。expiresAt為最後有效更新的observedAt+900秒，超時視為null。lastSample僅保存同source的可信GPS；response-only觀測不成為GPS。來源或時間種類切換須清空anchor、direction與lastSample，保存新的來源標記；切回GPS也從首次觀測開始。不同車、日期、route、stop不能共用。

### 3. 最小幾何與時效決策（全部界線含等號）

| 參數 | 本版值 |
|---|---|
| GPS age | -30至180秒；更早／更晚pending |
| 可比樣本間距 | 2至180秒；小於2秒pending，不推進lastSample；大於180秒清除direction、重建lastSample |
| 可辨方向位移 | >=10公尺 |
| 同向可信方位 | 與343→333的181.889度差<=60度 |
| 明確逆向 | 角差>90度，先拒絕，不受低速豁免 |
| 可信同向方向 | 2至180秒且位移>=10公尺即可建立；不設5km/h最低速門檻 |
| 速度拒絕 | 有效reported speed或可比GPS推算任一>25km/h |
| 無可靠位移的低速／漂移 | 位移<10公尺時不產生新方向；只可沿用180秒內最近可信同向方向 |
| 前站anchor | 距343巷口<=100公尺，沿343→333軸向投影<=50公尺，橫向偏差<=60公尺 |
| 前站時效 | 目前sampledAt-anchor.sampledAt<=300秒 |
| 連續進場 | 相較anchor沿軸前進>=20公尺且距333縮短>=20公尺，當前橫向偏差<=60公尺 |
| 目標圍欄 | 沿用既有半徑推導，此完整拓撲為120公尺 |
| 狀態過期 | observedAt後900秒 |

投影使用前站為原點、官方前站→目標向量為軸，以局部公尺平面／等價球面計算；不依賴原始緯度差假裝正南。predecessor由allRouteStops相同route按rank/order_index取緊鄰前站，優先id對應保護stop本身；缺拓撲、錯座標、無可用方位為pending `missing_topology`。不可因缺資料回退首站豁免。

順序：驗證identity/座標/來源/時間→重複失序→來源切換或過期重設→速度與方向→前站anchor→確認區域。有效逆向（不論reported低速）或超速須清除anchor及同向direction，保存該新樣本，回rejected。角差60至90度不建立可信方向且當輪pending `ambiguous_direction`；不以舊方向覆蓋當輪可辨橫向移動。位移>=10公尺的低速可靠同向亦可建立方向；低於10公尺才沿用尚新方向，無方向pending `unknown_direction`／`direction_expired`。first sample可保存anchor但必pending；最早由下一個可比樣本確認。每次選取anchor只在尚無有效anchor時保存，不把靠近目標的點反覆覆寫anchor以消除前進距離。反向後必須重新經過前站建立證據。

重複定義同source及同GPS timestamp（即使座標不同），失序定義timestamp較小：pending `duplicate_sample`／`out_of_order`，不能覆寫state。批次同timestamp有矛盾位置時保守待確認，不能用任意一筆確認。source timestamp改變但GPS沒改仍為重複。新時間相同座標可以更新lastSample但不能更新direction時間。

批次同車多筆樣本可按GPS時間推進state，但只有最新無歧義樣本可形成保護候選；結果須綁定完整sample identity（以JSON陣列編碼route、car、source、timestampKind、sampledAt、座標、valid reportedSpeed及wasteType），不可用carId最後confirmed套用較舊candidate。完全相同觀測只形成一個候選；若最新為北上／pending，本輪較早confirmed亦不可通知。最新同timestamp不同位置、主備同車同輪矛盾來源一律pending，內部`batchConflict`只可阻擋確認並將兩方原始來源時間及位置寫入稽核；response時間保持raw response metadata，不冒充GPS sampledAt。
所有保護路線樣本都參與批次最新樣本排序；recycling以`non_collection_vehicle`待確認並供稽核，但不能建立垃圾收運前站、方向或到站證據，也不能讓同輪較舊garbage候選通知。核心通知filter以latest complete identity隔離各車輛及站點。

reason最少涵蓋：`first_sample, unknown_direction, direction_expired, missing_predecessor, predecessor_expired, outside_corridor, outside_target, insufficient_progress, confirmed_approach, opposite_direction, cruising_speed, invalid_identity, invalid_position, invalid_sample_time, stale_sample, future_sample, untrusted_sample_time, duplicate_sample, out_of_order, ambiguous_direction, missing_topology, storage_unavailable, storage_conflict, batch_conflict, non_collection_vehicle`；測試鎖定主要業務reason，不綁console文案。

### 4. 來源與採樣證據

只在`truckIntake`已知canonical新北主endpoint，對`parseNtpcTime(truck.time)`成功的資料附`source:'ntpc-primary', timestamp_kind:'gps', source_timestamp:ISO`；不得在通用adapter把任意`time`一律宣告GPS。既有其他城市資料結構保留。website維持`ntpc-website/response/source_timestamp`，不填`time`，新service的sampledAt為null。主來源time採官方逐車欄位的現有映射；正式新鮮度仍需live佐證，離線不能證明上游是否持續更新。

直接呼叫core而未附可信來源／timestamp_kind的保護樣本為pending，即使有prev_lat或time。不把`Date.now()`補成採樣時間。source切換與raw副本不得混合前一來源位置與新來源時間。已知僅response的網站觀測可供稽核與closest分析，本版無法升級confirmed；之後取得逐車採樣契約再另做規格。

### 5. Supabase原子狀態＋事件，不新增通知鎖

新增`supabase/add_collection_approach_confirmation.sql`，表`collection_approach_state`複合主鍵(date,route_id,stop_id,car_id)，`version bigint`、`state jsonb`、`updated_at timestamptz`、`expires_at timestamptz`。事件表`collection_approach_events`含id、同鍵欄位、observed_at、sampled_at nullable、source、timestamp_kind、status、reason、details jsonb。details存原始位置／時間、reported與推算速度、前站及previous、bearing/angle、anchor、state version；不存LINE token或訊息收件人。

RPC `commit_collection_approach(p_key jsonb,p_expected_version bigint,p_state jsonb,p_event jsonb)`在同transaction鎖定／插入目標鍵，首次競爭以unique＋version0處理，僅版本相符才更新version+1並append事件；失敗不得留下confirmed事件。RPC不得以null、缺欄位或錯鍵繞過CAS；返回`{applied:boolean,version:number}`。查詢state用一般select精確eq複合鍵。RPC不寫quota、notification_logs或daily_status。對duplicate/out_of_order等無狀態改變的判斷，可提交相同state加版本及事件，但lastSample不動；CAS retry重算不得再次confirmed。

兩表啟用RLS，預設不給anon/authenticated讀寫；RPC僅service_role可execute（撤銷PUBLIC），固定search_path並完整限定schema，既有service key工作。以隔離PGlite執行真實SQL，驗證獨特鍵／CAS競爭／事件失敗rollback／service_role權限／固定search_path；測試建立Supabase所需角色但不連正式DB。本機SQL與離線mock不代表正式RPC已可用。事件保留政策後續由維運另決，本次不做自動清除或破壞性腳本。

storage failure時console輸出鍵、status/reason與非機密evidence，無DB事件可保存時明確可見；不得fallback到Map放行。既有dispatcher的Cooldown Claim仍處理不同新樣本或多執行通知去重，本次不建立第二套通知鎖。

## Risks / Trade-offs

- [只有網站response時間] → 保護stop保持pending，可能整晚漏報；取證後才能另增確認路徑。備援預設啟用不代表具GPS新鮮度。
- [1至2分鐘輪詢錯過小圍欄] → 前站可於外圈保存，第一次進入120公尺即可確認；若整段完全漏採仍可能漏報，不放寬成未知即通知。
- [南下路過也可能通過軌跡條件] → 本版確認的是有證據的收運進場，不能直接證明現場收運；實際清運歷史與誤報率仍待驗收。
- [額外DB延遲／未套SQL] → 失敗只阻擋保護stop，其他站點繼續；錯誤須在log可見，不宣告live修復。
- [既有測試使用fixture id17] → 純matcher測試保留其定位，新整合測試必用正式id3驗證gate。

## Migration Plan

本次交付code、增量SQL、離線測試與雙軸審查，archive後依使用者授權commit/push。SQL僅寫檔，不套正式DB；部署、RPC實際執行／跨Cloud Run實例觀測、服務時段GPS新鮮度／延遲與實車通知均標待驗收，非本次archive前硬task。正式採用時先套SQL與service_role權限驗證，再部署程式及read-only觀測；此步須另獲授權。回滾程式須由維運明確處理其恢復舊誤報語意風險，保留新表作證據，不隨程式回滾刪除。
