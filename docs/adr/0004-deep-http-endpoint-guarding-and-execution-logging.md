# ADR 0004: 統一 HTTP 進入點防禦與排程執行稽核深模組

- **狀態**: Accepted
- **日期**: 2026-09-18
- **決策者**: Antigravity Pair Programming Team

## 背景與問題 (Context)

系統包含三個主要的排程與中繼 HTTP 進入點：
1. `/api/check-trucks`（核心垃圾車到站比對排程）
2. `/api/check-weather`（氣象降雨預警排程）
3. `/api/tainan-relay`（臺南手機通知轉發中繼 Webhook）

目前各端點存在以下架構缺陷：
- **重複程式碼與安全實作發散**：各檔案皆重複自行實作 `safeCompare` (以 `crypto.timingSafeEqual` 防範時序攻擊) 與 Bearer / Secret 解析邏輯。
- **可觀測性盲區 (Observability Blind Spot)**：`api/check-weather.js` 完全未整合 `recordExecutionLog`，在未授權阻斷、夜間靜音跳過 (quiet hours)、無啟用群組或執行崩潰時，不會在 `execution_logs` 留下任何稽核追蹤。
- **未授權回應與日誌規範不一致**：`/api/check-trucks` 與 `/api/tainan-relay` 在授權失敗時的回傳格式與日誌屬性略有歧異。

## 架構決策 (Decision)

1. **建立統一防禦深模組 `lib/endpointGuard.js`**：
   - 封裝時序安全比對：`safeCompare(a, b)`
   - 統一提取請求密鑰：`extractIncomingSecret(req)`，支援 `Authorization: Bearer <token>`、`x-cron-secret`、`x-relay-secret`、`req.body?.secret` 與 `req.query?.secret`。
   - 封裝統一驗證與稽核：`validateEndpointAuth(req, expectedSecret, options)`。若驗證失敗，自動擷取 `triggerSource` 並寫入 `status: 'unauthorized'` 稽核日誌。
   - 提供端點守門函式：`guardEndpoint(req, res, options)`，若授權失敗直接標準化回傳 HTTP 401。

2. **重構所有進入點**：
   - `api/check-trucks.js`：移除手動 `safeCompare` 與 Bearer 解析，改由 `guardEndpoint` 守門。
   - `api/tainan-relay.js`：移除重複的 `safeCompare` 與 header 提取，改用 `guardEndpoint`。
   - `api/check-weather.js`：全面接入 `guardEndpoint` 與 `recordExecutionLog`，補齊夜間靜音、無訂閱群組、執行成功與失敗時的稽核記錄。

## 後果 (Consequences)

### 正向效益 (Positive)
- **消除程式碼重複**：所有進入點的時序防禦與密鑰提取收斂至單一深模組接縫。
- **排程全面可觀測性**：`api/check-weather.js` 不再有觀測黑洞，所有排程與中繼事件皆能一致在儀表板與 `execution_logs` 追蹤。
- **高內聚低耦合**：控制器只需一行即可完成密鑰驗證、來源辨識與未授權日誌記錄。

### 潛在風險與處置 (Risks & Mitigation)
- **向後相容**：`extractIncomingSecret` 完整保留 Bearer、自訂 Header、Body 與 Query 等所有現行支援的傳輸方式，確保 GitHub Actions、cron-job.org 與 MacroDroid 轉發維持 100% 運作。
