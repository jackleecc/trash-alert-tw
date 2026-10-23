# 汐止提前路過誤報修正驗證

## 查核事實與範圍

2026-10-23以Supabase唯讀GET確認，2026-10-22通知於台灣時間19:45:20發出，路線221010／Stop3、車號647-BX；同輪每日摘要記錄19公尺。站點表定時間仍為19:56。使用者補充19:45有車經過，但應為路過而非真正收運。當晚原始GPS、速度與前次位置未保留，`execution_logs`表查詢回PGRST205，因此不能斷言該次命中的精確程式分支。

離線合成軌跡已重現：同一路線車輛在19:45、距站19公尺、北上約3km/h時被舊判定放行；北上18km/h被拒絕；首次無歷史樣本亦被放行。合成資料只能證明缺陷可重現，不是當晚GPS重播。

使用者於本對話同意五點方案並授權實作、commit＋push。強化範圍僅路線221010／正式Stop3；共用文案取消無依據固定ETA。新SQL僅交付檔案，不套正式DB、不部署、不呼叫LINE。

## 基準

- 固定Git基準：`1e94d02a1b776aa98211b3b79919c01c95991f61`，開工時本機master與origin/master一致；Git查核由gpt-6-luna／Low執行。
- 修改前以拒絕真網路的guard執行全部測試，234／234通過。
- OpenSpec：`xizhi-arrival-confirmation`；架構決策ADR0012。

## TDD與離線驗收

| 驗收階段 | 已執行結果 |
| --- | --- |
| 首次19m觀測 | 舊核心實際matchedArrivals=1／dispatchCalls=1，預期皆為0，取得業務Red；gate加入後通過，全套235／235。 |
| 前站至目標跨實例 | 清除process Map後，從343巷中心到333巷北側19m、間隔120秒，舊gate通知0對預期1取得Red；共享確認接上後通過，全套236／236。 |
| 純進場狀態機 | 27案例通過，包含低速逆向、反向後漂移、可信低速南下、方向／前站／狀態期限、採樣時效、來源切換、走廊、超速與失序；全套263／263。 |
| 原子SQL與共享adapter | 9個store／observe測試通過，focused合計38／38，全套272／272；本機PostgreSQL SQL檢查11／11通過。 |
| 批次候選、intake與文案 | 批次14案例通過；主來源metadata與formatter各有真Red後Green。最新全套289／289通過，無跳過；SQL11／11及OpenSpec strict validate通過。 |
| 審查修正 | 首次19m案例改用成功store並驗證已提交first_sample；網站response時間稽核取得業務Red後修正，sampledAt仍為null。重審後主代理獨立重跑npm test 290／290，0 skipped。 |

純狀態機的有效Red包括：逆向後漂移重新建立anchor、方向期限未清除、過期狀態錯當失序、長輪詢間隔保留方向、未區分未來採樣、錯路線拓撲、來源切換保留GPS、duplicate錯分類、歧義方向沿用舊證據、走廊外原因缺失、較舊超速樣本破壞較新state、首次非法座標污染lastSample。原始輸出與逐步測試全文保存在本機`.scratch/xizhi-arrival-confirmation/red-*`，不把預期Red算作已修正或已完成正式驗收的證據。

本機資料庫Red已執行：PostgreSQL查詢顯示共享軌跡表不存在，assertion「shared predecessor evidence must have a durable state table」失敗；此為資料庫能力缺失，不是import或檔案讀取失敗。migration實作後，隔離PGlite 0.5.11／PostgreSQL 18.6驗證11項Green：migration可重跑、state與event同交易、CAS競爭單一成功、event失敗回滾、null／負版本／錯鍵／錯事件閉鎖、失敗不建立placeholder、anon／authenticated禁止讀取與執行、service_role僅表格讀取與RPC執行、兩表RLS及固定search_path。PGlite只有單連線佇列，不能據此宣稱已驗證正式資料庫多連線鎖競爭。

共享服務的業務Red另包含invalid observedAt導致RangeError與malformed CAS結果錯誤放行confirmed；修正後只接受`applied === true`且版本恰為expected＋1，最多3次重讀重算，失敗維持pending並輸出可見診斷。完整SQL驗證工具與輸出位於本機`.scratch/xizhi-arrival-confirmation/verify-sql.mjs`及`green-sql.output.txt`；不新增正式程式依賴。

批次階段的真Red包含較舊確認位置發送、矛盾來源／位置未保留batch_conflict稽核、重複樣本重複形成意圖、回收車建立前站證據、速度不同的觀測被錯誤去重，以及移除幾何motion欄位後遺失原始身份造成合法reported speed漏報。修正後以完整raw sample identity與幾何物件WeakMap關聯，僅每車最新無歧義樣本可形成候選；正常reported speed12的進場也能通知。這些合成情境不代表已取得10/22原始GPS。

可重現的最終驗證：

- `npm test`：已將拒絕真網路guard納入預設測試入口，審查修正後290／290通過、0 skipped；主代理本機輸出`.scratch/xizhi-arrival-confirmation/final-tests-02.txt`。
- `scripts/verifyCollectionApproachSql.mjs`：驗證程式納入版本控制，隔離安裝PGlite0.5.11後依[說明](../collection-approach-confirmation.md)執行；11／11通過，本機輸出`final-sql.txt`。不連正式DB、不讀`.env`。
- `openspec validate xizhi-arrival-confirmation --strict`：封存前通過。主規格同步後`openspec validate --specs --strict`通過；比對Purpose與全部需求／情境逐字相符後封存，8／8任務完成，active changes為空。

主規格：[collection-approach-confirmation](../../openspec/specs/collection-approach-confirmation/spec.md)。變更與TDD任務封存於[2026-10-23-xizhi-arrival-confirmation](../../openspec/changes/archive/2026-10-23-xizhi-arrival-confirmation/tasks.md)，ADR0012已更新連結。審查後封存只移動規劃文件、同步相同規格及補完證據；沒有再改程式、SQL或測試。

## Standards

首輪由gpt-6.1-sol／High獨立審查，固定基準如上。因規則要求commit前審查，採`git diff --cached 1e94d02a1b776aa98211b3b79919c01c95991f61 --`，base..HEAD提交清單為空；完整差異SHA256為`0d198a242b20fa1d108eae9b493aa886e6462f4445bb08ea0c26e426a482de5c`。

原始findings依原順序保留：

- P2 測試因儲存失敗通過，未驗證首次觀測規則（test/collectionApproachCore.test.js:37,115）。首次19m測試未提供有效共享store，Supabase mock對collection_approach_state回傳空物件，實際記錄storage_unavailable及select不是函式，測試仍通過。因此首次觀測錯誤確認可能被儲存失敗遮蔽。依tdd skill「Tests verify behavior through public interfaces」，應注入可成功read／commit的空store，驗證零通知並留下first_sample決策。這是測試品質缺口，非已證實正式行為缺陷。
- P3 Possible Duplicated Code（lib/collectionApproach.js:130–131,156–157,174–175,183–184,210–211）：五處重複lastSample與observedAt＋900秒expiresAt更新，可抽小型helper，避免退出分支漏改。屬Fowler判斷，非硬性規範違反。
- P3 Possible Middle Man（lib/collectionApproach.js:246–248）：evaluateCollectionApproach僅return evaluateOnce(args)，沒有額外契約；可直接命名並匯出實作。屬Fowler判斷，非硬性規範違反。

首輪合計3項，最嚴重P2。P2改以可成功read／CAS的空store驗證持久化pending／first_sample；兩項P3分別以updateLastSample helper及直接匯出實作處理。

重審使用完整固定差異review-02.diff，SHA256 `8165cb3f6192d01068e1d2c0199987adc4e9339717133abd8ecf3b24c190ba78`（同基準、同staged命令及空提交清單）。Standards代理確認原3項全解決、0新增問題，獨立執行拒絕真網路的core／pure／store測試39／39通過。最終未解0項，最嚴重程度無。

## Spec

首輪由另一gpt-6.1-sol／High獨立審查，使用相同固定差異，原始finding：

- P2 一般備援觀測遺失原始來源時間（lib/coreProcessor.js:182）：response-only的sampledAt為null，但未保留source_timestamp／time，後續事件rawSampledAt亦為null；只有batch-conflict保留原時間。以mock store輸入網站時間11:56:00Z、接收時間11:56:10Z，持久化事件只能重建接收時間。違反design「details存原始位置／時間」及「response時間保持raw response metadata，不冒充GPS sampledAt」。應透傳獨立原始來源時間至details，維持GPS sampledAt:null，並加公開core入口測試。

首輪合計1項，最嚴重P2；未發現其他具體缺漏或範圍蔓延。新增公開core測試以來源11:56:00Z、接收11:56:10Z及malformed raw time取得真實Red：rawSourceTimestamp／rawTime為undefined；完整測試與失敗原文在本機red-06.test.js／red-06.output.txt。修正透傳獨立raw欄位，維持sampledAt:null與pending／零dispatch，Green後全套290／290。

另一High代理對同review-02完整差異重審，確認原P2已解決、未新增缺漏或範圍蔓延，獨立core／pure／store測試39／39通過。最終未解0項，最嚴重程度無。

## 正式環境待驗收

正式SQL套用、service_role實際權限、部署版本、跨Cloud Run實例軌跡延續、服務時段GPS新鮮度／延遲與實際清運誤報率均未驗收。只有網站response時間時保護站點保持待確認，可能漏報；連續GPS南下亦無法直接證明實際收垃圾。不得把本機結果宣稱為正式通知已恢復。
