# 新北官方清運網站備援規格

Status: implemented; all 225 offline tests passed; both-axis code review passed. Not deployed or activated. 2026-10-12.

使用者已同意推薦設計與兩個公開測試入口。此核准涵蓋實作、離線測試與審查；不涵蓋設定正式環境、部署或啟用備援。禁止呼叫任何 LINE API，包含推播、群組成員查詢及官方用量查詢。測試必須攔截相關依賴。

## 已確認的設計

只為本輪實際仍有訂閱、班表時間窗內且尚未深度休眠的新北路線補資料。不新增站點、訂閱、資料庫欄位、遷移或地點成功宣告。`subContext.activeRoutesMap` 含今日全部啟用路線，因此不可直接把整個 Map 的 key 當成網站查詢目標；必須從 `subContext.stops` 取得 route_id，再以對應 route 的 `resolveRouteCity` 篩選新北市。

主來源仍為 `NTPC_TRUCK_API_URL`。當本輪主來源連線失敗、所需路線缺失，或該路線只有不可靠時間／超過五分鐘的 GPS 樣本時，在同一輪 POST 官方網站 `/WebAPI/GetArrival`。不等待縣市連續失敗門檻。有效主來源資料優先，網站只填補本輪缺口，不能以網站錯誤或較差資料取代有效主來源。

`NTPC_WEBSITE_BACKUP_ENABLED=false` 為預設；只有精確值 `true` 啟動。整個新北補資料與新鮮度政策受此旗標控制，以維持舊呼叫向後相容。沒有所需新北路線、顯式 `overrideUrl`、或新北縣市被暫停時，不做網站查詢。取消旗標即回到既有資料擷取行為。

## 已確認事實與資料限制

本次設計依據已有本機探查檔案，未額外連網：

- `scratch/ntpc-MapCommon.js.txt` 的 `UpdatePreTime`：POST `/WebAPI/GetArrival`，表單 `LineID` 是逗號分隔字串。
- `scratch/ntpc-GetArrival-response.json`：頂層 `{ TimeStamp, LineCount, Line: [...] }`，各 Line 有 `LineID`, `CarNO`, `LocationLat`, `LocationLon`, `BarCode`, `ArrivalRank`, `Diff`, `Point`。2026-10-11 23:55 的 221010 樣本車號空白、座標零，不是有效車輛實績。
- 網站 `GetBarCodeStatus` 只有 `BarCode === LineID`、`000005`、`000007` 明確表示「執勤中」。`000003` 暫時離開、`000004` 回場轉運、`000006` 路況障礙、`000013`～`000015` 前往焚化廠，其餘／空白均不採用。
- `Diff` 是表定時間偏差（分鐘），不是 GPS 年齡。`Point[].PointTime` 是表定時間，不能轉為車輛位置時間。`Point[].Arrival` 也不能冒充現在的位置樣本。
- 頂層 `TimeStamp` 為網站回應時間來源，格式 `YYYYMMDDHHmmss`、台灣時區。尚無證據證明它是逐車 GPS 採樣時間。
- 既有 `arrivalMatcher` 不會驗證 GPS 年齡；`time` 主要用於跨輪車速／方向計算。因此不能宣稱「既有護欄已會擋過期 GPS」。本變更在啟用時於新北 intake 加上明確篩選，既有自適應圍欄、進場方向、班表、車速、信任 linid、防重複與額度護欄仍照原流程運作。

## 公開介面與時間契約

`fetchActiveTrucks(options)` 增加可選項：

| 選項 | 契約 |
| --- | --- |
| `requiredNtpcRouteIds` | 本輪需要的新北路線字串陣列；去空白、去重，拒絕非數字／含分隔符的值。缺省或空陣列不啟用網站查詢。 |
| `now` | 真正 UTC 瞬間的有效 `Date`，測試可固定；缺省為呼叫當下 `new Date()`。不可直接使用已經加八小時的 `taiwanNowInfo.now`。 |
| `ntpcWebsiteBackupEnabled` | 可選 boolean；未提供時讀取上述環境旗標，供離線測試明確控制。 |

`fetchTrucksWithRetry(dateStr, overrideUrl, targetCities, options)` 原介面保留，將上述三項逐一傳入 intake，保留既有 `timeoutMs` 選项。縣市暫停／熔斷先執行，網站不能繞過它。

`executeTruckTrackingCycle` 自實際 `subContext.stops` 計算唯一的新北 route IDs，傳給 facade。由 `dateStr`、`hour`、`minute` 組成 `${dateStr}T${HH}:${MM}:00+08:00` 還原真實瞬間，而不是將偏移後 Date 視為 UTC；若這些欄位無效，採真實呼叫時間而不解析猜測字串。

兩個主要測試入口是 `fetchActiveTrucks` 與 `executeTruckTrackingCycle`。前者以 HTTP mock 驗證外部契約；後者執行真實 facade／intake／matcher，以 mock DB、HTTP 與時間等系統邊界，在不連接實際 LINE／DB 的條件下验证 route IDs／時間流經完整 orchestration。網站車輛採站點外遠距座標，使真實 matcher 不產生通知。全部 HTTP 需安裝拒絕未宣告網路的 guard；既有 `syncLineConsumption` 的背景請求也只能回傳本機 mock 回應，不能接觸 LINE 網路。不新增只為測試而存在的 skip flags 或平行流程。

## 啟用後主來源品質政策

1. 主來源正規化保留既有欄位校驗。
2. 所需路線的可用樣本必须有合法位置、可解析時間，且 `-60秒 <= now - sampleTime <= 300秒`。五分鐘整採用；超过五分鐘拒絕；未来超过六十秒拒絕。
3. 新北无時區 `YYYY/MM/DD HH:mm:ss`／`YYYY-MM-DD HH:mm:ss` 視為 `+08:00`，已有 ISO 时區依原偏移。嚴格校驗月份、日期及時分秒；不接受 JS 自動進位、非有限時間或任意模糊時間解析。
4. 同一路線有任何有效主來源樣本，保留所有有效主來源樣本，不向網站重抓該路線。該路線的過期／無效時間樣本不得送進 matcher。
5. 缺口集合才會放進 `LineID`，同一輪一次批次請求。主來源失敗時缺口為全部所需 route IDs。

## 網站 HTTP 與正規化契約

預設 URL：`https://crd-rubbish.epd.ntpc.gov.tw/WebAPI/GetArrival`。使用 POST、`application/x-www-form-urlencoded; charset=UTF-8`，以 `URLSearchParams({ LineID: missingIds.join(',') })` 建構表單。官方 Map 页 Referer／Origin 可作普通 HTTP 相容性標頭，不能依賴瀏覽器、登入、Cookie 或 LINE。

網站每輪至多一次請求、零重試、5,000 ms abort timeout；每輪主來源仍沿用原本至多兩次、12,000 ms／次及现有重试延迟。所有 timer 在 finally 清除；HTTP 不成功、HTML／壞 JSON、顶层非物件、`Line` 非陣列都作為備援失敗診斷，不拋出使其他城市資料被丟棄。

接受每筆 Line 的全部條件：

1. `LineID` 精確屬於本輪缺口集合；不能用車號、最近位置或 Point 推估路線。
2. `CarNO` 是非空字串；緯度／經度為有限數值且符合既有台灣位置界限（21.5～26.5、119～122.5），零座標拒絕。
3. `BarCode` 在上述執勤 whitelist。未知状态、非执勤及 `000006` 均拒絕。
4. 顶层 `TimeStamp` 可严格解析为台灣時間，且同样满足 `-60秒 <= responseAge <= 300秒`。此条件只验证响应新鲜度，不表示 GPS 新鲜度。

網站有效資料轉成 `{ route_id: LineID, car_id: CarNO, lat: LocationLat, lng: LocationLon, waste_type: 'garbage', source: 'ntpc-website', timestamp_kind: 'response', source_timestamp: ISO8601 }`。**不得将顶层 TimeStamp 放入 `truck.time`，也不得伪造 `speed=0`、GPS 时间或到站事件。** 没有逐車 GPS 時間／速度时，保持欄位缺省，由既有遥测逻辑依真实观察时间进行后续计算，且仍受启用前新鲜度证据门槛约束。按 route_id + car_id 去重，只填补缺口路線。

## 統計、熔斷與錯誤

新北始终只有一个逻辑 `sourceStats` entry；`url` 保持 `NTPC_TRUCK_API_URL`，不能额外加一个成功网站／失败主 API 的 entry，使 facade 同一轮同时清零与增加新北失败次数。

既有 `city`, `url`, `ok`, `count`, `error` 契約保留。可追加 `primary` 与 `fallback` diagnostics（是否 attempted、requestedRouteIds、accepted count、rejection counts、response timestamp、error）。所有计数指採用後資料，不能把站点 Point 数当作車數。拒絕原因至少區分 `not_in_service`, `invalid_position`, `route_mismatch`, `missing_vehicle`, `invalid_timestamp`, `stale_response`。

- 主來源成功时，新北逻辑来源保持 `ok: true`；网站失败／无有效车辆只记补資料失败诊断与 partial error，不能把仍正常的主來源变成县市連線失敗。
- 主來源失败且网站提供至少一筆可採用车辆：新北逻辑来源 `ok: true`，主来源失败留在 diagnostics；facade 依 canonical URL 识别新北成功。
- 主來源失败且网站失败或无可採用车辆：新北 `ok: false`，errors 汇总两端原因，沿用既有 city fail count／pause 机制。
- 有效其他城市資料始终保留；旗標关闭、无必要 routes、暂停城市、override URL 时不产生网站请求。

## 啟動程序與驗證門檻

完成實作與通過離線 TDD／雙軸 code-review 不等於正式啟用。

1. 保持 `NTPC_WEBSITE_BACKUP_ENABLED` 未設定或 false，只跑離線 fixtures，不透過 production handler／dry-run 間接觸發 LINE。
2. 於既有路線真实服务时段進行另行核准的唯讀公用網站探查，保存多个连续原始样本、真实抓取瞬间、路线、车牌、状态、坐标变化、Point 的历史实际 Arrival，以及对照來源。不能把週日空車號樣本宣稱歷史實績成功。
3. 在 `docs/reports/` 建立驗證报告，明确區分回應時間與位置採樣時間；证明位置更新与实际执勤有关、延迟符合五分钟容忍值。若只能看见 TimeStamp 更新而无法证实位置更新，仍不符合启用门槛，继续关闭。
4. 说明資料缺口、两端均过期、輪詢间隔跨过站点等情境仍可能漏报。既有护栏與无时间数据无法构成「保证不会漏报」。
5. 使用者另行核准啟用與部署後，才能把旗標设為 true；本次不能修改秘密环境文件或部署。
6. 启用后的首批真实服務轮次检查採用來源、route coverage、拒絕原因与县市熔断；发现坐标冻结／错误路线／异常大量拒绝即旗标回滚 false，保留审计证据。

## 必要測試與施工交接

TDD Red 使用 `gpt-6.1-sol`／Medium，必须先观察业务 assertion 真失败。Green 新逻辑使用 `gpt-6.1-sol`／Medium；纯接线若交由 `gpt-6-luna`／Low，必须提供完整测试档与原始 Red 失败讯息。不得以 import／语法失敗当作 Red 成功。根代理固定審查基準並執行 `code-review` Standards／Spec 雙軸 High；本文件不执行 Git。

必要用例：

- flags off 与 legacy／override／非新北／paused／empty IDs：零网站请求、原输出保留。
- 主來源正常且所需路线新鲜：零网站请求。
- 主來源错误、只有其他新北路线、所需路線超過5分鐘、無效／空時間：同轮只查缺口路線。
- 两路线一新鲜一过期：新鲜 primary 保留，网站只替补过期路线；五分钟整、未来60秒整／超过边界、台灣跨日與日期自动进位拒绝。
- POST form、URL、次数、timeout cleanup；HTTP错误／HTML／坏JSON不会丢掉其他城市。
- 网站执勤 whitelist、未知／非执勤／障碍、空牌、零／非数坐标、错路線、旧／无效服务器时间；真实周日 fixture拒绝。
- 成功网站字段 provenance、无 `time`／speed 伪造、去重；新北 canonical sourceStats 只一笔，主／備成败四种组合與部分失败语义。
- facade 明确转交 required IDs、真 UTC now、flag；核心只选实际 active NTPC subscribed stops，忽略其他县市与无 active stops 的路線，時區換算正確且无 LINE 呼叫。
- 在既有 matcher 公开入口回归自适应围栏、方位角、班表窗、速度过滤；备援不能直接产出通知，既有 notify／quota／cooldown 逻辑不改动。

后续修改正式使用说明，并记录离线测试、实际服务数据与部署启用为三个不同状态。
