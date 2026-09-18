# 0002. 深化車輛資料擷取模組並分離運作狀態

## 背景與問題

原有 `lib/truckApi.js` 長達 659 行，高度混雜了外部 HTTP 抓取（高雄 REST、新北 REST、桃園 Cookie/HTML 解析、臺南 ASMX POST）、Supabase `daily_status` 資料表寫入、字串正規表示式編解碼（`[PAUSED_CITIES:...]` 與 `[CITY_FAILS:...]`）、重試計數與熔斷暫停邏輯，以及向 LINE Client 廣播系統故障告警。這種設計破壞了局部性（Locality），使得車輛資料抓取的單元測試必須模擬龐大的資料庫與 LINE 發送邏輯，且門檻常數的調整容易導致脆性斷言失敗。

## 決策

1. **職責分離**：
   - 將外部資料抓取邏輯收斂為深模組 `lib/truckIntake.js`，對外僅暴露高槓桿介面 `fetchActiveTrucks(targetCities, options)`，內部依縣市劃分獨立傳輸適配器（`kcg`, `ntpc`, `taoyuan`, `tainan`），回傳統一清洗後的 `TruckRecord[]`。
   - 將資料庫狀態持久化（`daily_status` 的失敗次數、暫停縣市列表、正則字串降級編解碼）以及告警觸發邏輯收斂至專門的 `lib/cityCircuitBreaker.js`（或擴充 `lib/dailyStatus.js`）。
2. **保持相容性與門檻參數化**：
   - `lib/truckApi.js` 保留 `fetchTrucksWithRetry` 作為上層 Facade，協調 `truckIntake` 與 `cityCircuitBreaker`，使 `api/check-trucks.js` 無痛升級。
   - 將重試熔斷門檻明確參數化，解決既有測試中斷言過期的問題。

## 後果

- **正向影響**：
  - 新增或調整任一縣市的 API 連線協定時，僅需修改該縣市的內部適配器，不影響狀態追蹤與其他縣市。
  - 車輛擷取單元測試成為純 HTTP/In-memory 測試，執行速度快且不需要 mock Supabase 資料庫。
  - 運作狀態與熔斷規則集中管理，資料庫錯誤解碼邏輯單獨受測。
- **潛在取捨**：
  - 需要在 `truckIntake` 與狀態模組之間定義清晰的結果物件契約。
