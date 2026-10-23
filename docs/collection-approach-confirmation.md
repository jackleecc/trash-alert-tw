# 汐止進場確認與上線順序

進場確認僅套用路線 `221010`、正式站點 `3`（汐萬路一段333巷口）。其他地點沿用既有判定。排程仍可提前18分鐘追蹤；進入時間窗與120公尺圍欄本身不等於已確認收運進場。

## 判定依據

同一車輛需先有343巷口的可信GPS前站證據，再沿官方前站至目標方向接近。相隔2至180秒、位移至少10公尺才建立新方向；可靠北上位移即使低速也拒絕。小於10公尺的漂移只能沿用180秒內的可信方向，不能延長方向證據期限。前站證據有效300秒。reported或推算速度高於25km/h拒絕。

GPS時間只接受已知新北主來源的逐車採樣時間，年齡為過去180秒至未來30秒。網站備援頂層時間是回應時間，不是GPS時間；僅有此來源時本保護站點保持待確認。這可能延後或漏報，不能把新鮮HTTP回應當成實車新鮮位置。

待確認與拒絕不建立通知意圖、不占冷卻鎖、不扣額度、不寫通知紀錄，因此不會使站點進入當日休眠。GPS軌跡不能直接證明車輛正在收垃圾；南下路過仍是實車驗收須觀察的限制。

## 資料庫與部署

本次程式交付不會自動修改正式資料庫或部署服務。正式採用時必須依序：

1. 由維運執行 `supabase/add_collection_approach_confirmation.sql`，建立共享狀態、判斷事件與原子版本提交RPC。
2. 確認 `service_role` 可以讀取共享狀態、執行RPC；`anon` 與 `authenticated` 不可讀寫軌跡或執行RPC。
3. 再部署本次程式，於實際清運時段核對來源、GPS新鮮度、前站與方向證據。不得以正式通知入口當作不耗額度的診斷工具。

未套migration或儲存失效時，此站保持待確認並輸出診斷，不回退成記憶體放行。其他地點繼續依舊規則運作。共享軌跡以台灣日期／路線／站點／車號隔離，狀態900秒到期；版本比較與判斷事件在同一交易寫入，避免不同Cloud Run實例覆寫較新證據。

每次觀測由adapter讀取狀態、重新計算純判斷並以預期版本提交，最多重試3次；只有回覆`applied: true`且版本恰為預期值加1時，才會向通知流程回報confirmed。讀取／提交錯誤、schema缺失、無效RPC回覆或CAS重試耗盡都回傳pending並寫診斷log。RPC以每個複合鍵的transaction advisory lock序列化競爭，不會為失敗CAS留下空狀態列。

`collection_approach_events` 保存來源、GPS採樣／實際觀測時間、原始位置、有效reported與推算速度、前次樣本、前站、方向、anchor、判斷結果、原因與提交版本；非可信GPS時間以null儲存，原始欄位留在details供診斷。它是判斷紀錄，不代表LINE已發送；發送結果仍由既有通知紀錄判讀。事件資料不含LINE憑證或群組收件人。此遷移不自動刪除事件；維運須依資料量與保存需求另訂保留政策。

本機離線回歸與SQL驗證不能替代正式權限、來源延遲、跨實例及實際清運驗收。

## 離線驗證

在專案根目錄執行 `npm test`。測試預載網路拒絕guard，測試只能使用本機mock，避免誤連LINE或正式資料庫。

SQL驗證工具使用另裝的PGlite，不新增應用程式依賴，也不讀取`.env`。先安裝隔離測試工具，再執行：

```powershell
npm install --prefix .scratch/collection-sql --no-save --no-package-lock --ignore-scripts @electric-sql/pglite@0.5.11
node --require ./test/helpers/denyNetwork.cjs scripts/verifyCollectionApproachSql.mjs .scratch/collection-sql/node_modules/@electric-sql/pglite/dist/index.js
```

驗證使用記憶體內PostgreSQL與合成角色／事件，檢查migration重跑、版本比較、事件失敗回滾、角色權限及RLS。PGlite的單連線佇列不等於正式PostgreSQL多連線競爭驗收。
