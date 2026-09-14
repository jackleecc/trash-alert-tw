# 台灣出口代理伺服器建置指南 (Taiwan Egress Proxy Setup Guide)

本指南說明如何為 **Trash Alert TW** 快速建立一個位於台灣境內的輕量轉發代理（Egress Proxy），以解決臺南市政府環境保護局（`clean.tnepb.gov.tw`）伺服器阻擋境外 IP（如 Vercel 香港機房 `hkg1`）連線的問題。

---

## 為什麼需要台灣出口代理？

* **現況**：臺南市政府環保局天眼系統（`clean.tnepb.gov.tw`）之機房設有 Geo-IP 防火牆，僅接受台灣境內 IP 連線；境外雲端主機（包括 AWS、Vercel 香港節點）發起連線時，封包會被直接丟棄（Timeout）。
* **機制**：我們透過位於台灣原生機房的極輕量 Serverless 函數作為轉發中繼，Vercel 請求該代理，代理在台灣境內向天眼 WebService 撈取資料後回傳，完全避開防火牆阻斷。

---

## 方案 1：Google Cloud Functions（推薦，100% 台灣原生 IP）

GCP 在**台灣彰化 (`asia-east1`)** 設有大型實體機房，出口 IP 屬於 Google Taiwan，完全符合公家機關 HiNet 白名單。
* **費用**：每月前 **2,000,000 次** 呼叫完全免費（本系統每月僅需約 9,000 次，佔免費額度 0.45%，永久 $0 費用）。

### 部署步驟（3 分鐘完成）：

1. **登入 Google Cloud Console**：前往 [Google Cloud Functions](https://console.cloud.google.com/functions)。
2. **點擊「建立函式 (Create Function)」**：
   * **環境 (Environment)**：第 2 代 (2nd gen)。
   * **函式名稱 (Function name)**：`tainan-proxy`
   * **區域 (Region)**：選擇 **`asia-east1 (台灣 / Taiwan)`** ⚠️ **極為關鍵，務必選彰化！**
   * **觸發條件 (Trigger)**：HTTPS
   * **驗證 (Authentication)**：勾選「允許未驗證的叫用 (Allow unauthenticated invocations)」。
3. **設定環境變數（選用，保護代理不被公開濫用）**：
   * 展開「執行階段、環境變數...」
   * 新增環境變數：
     * 名稱：`PROXY_SECRET`
     * 值：自訂一組高強度密碼（例如 `mySecretKey2026`）
4. **進入程式碼編輯器 (Code)**：
   * **執行階段 (Runtime)**：選擇 `Node.js 20` 或 `Node.js 18`。
   * **進入點 (Entry point)**：填入 **`tainanProxy`**。
   * **將專案內的檔案貼入**：
     * `index.js`：複製專案內 [`proxy/gcp-function/index.js`](../proxy/gcp-function/index.js) 的完整代碼。
     * `package.json`：複製專案內 [`proxy/gcp-function/package.json`](../proxy/gcp-function/package.json) 的完整代碼。
5. **點擊「部署 (Deploy)」**：
   * 約 1 分鐘後部署完成，複製該函數的 **觸發網址 (Trigger URL)**。
   * 例如：`https://asia-east1-my-project-123.cloudfunctions.net/tainan-proxy`

---

## 方案 2：Google Cloud Run (搭配專案 Dockerfile 一鍵持續部署)

本專案根目錄已包含標準 [`Dockerfile`](../Dockerfile)，可直接透過 [Google Cloud Run](https://console.cloud.google.com/run) 連接 GitHub 儲存庫：
1. 進入 [Google Cloud Console - Cloud Run](https://console.cloud.google.com/run)。
2. 點選「建立服務 (Create Service)」，選擇「從存放區持續部署 (Continuous deployment from repository)」。
3. 連接此 GitHub 儲存庫 `trash-alert-tw`，建構類型選擇 `Dockerfile`。
4. 區域選擇 **`asia-east1 (台灣)`**，勾選「允許未驗證的叫用」。
5. 點擊建立，Cloud Build 將自動依據 `Dockerfile` 建立包含本機代理服務的容器修訂版本。

---

## 方案 3：Zeabur / 自建 Node.js / Docker（100% 台灣原生住宅 IP）

若您有台灣主機、NAS 或使用台灣原生 PaaS（Zeabur，預設區域為台灣 GCP）：
* 直接使用專案內 [`proxy/standalone/`](../proxy/standalone/) 目錄。
* 執行 `npm start`，即會在 Port 8080 提供轉發代理服務。

---

## 驗證代理端點是否生效

取得代理網址後，您可以在本地終端機執行測試腳本驗證：

```bash
node scripts/testProxy.js <您的代理網址> [您的密鑰]

# 範例：
node scripts/testProxy.js https://asia-east1-myproject.cloudfunctions.net/tainan-proxy mySecretKey2026
```

成功時將會輸出：
```text
⏱️ 請求完成，耗時: 180 ms，HTTP 狀態碼: 200
✅ 成功取得 JSON 回應！
🚛 經 truckAdapter 成功解析車輛數: 78 筆
🔍 範例車輛動態 (前 3 筆):
   [1] 車號: 218-UW, 路線: 永康-夜間31, 類別: garbage, 座標: (23.016963, 120.261576)
🎉 代理伺服器驗證成功！
```

---

## 綁定至 Vercel 線上生產環境

確認代理伺服器運作正常後，請至 Vercel 設定環境變數：

1. 開啟 [Vercel Dashboard](https://vercel.com/) -> 選擇 `trash-alert-tw` 專案。
2. 進入 **Settings** -> **Environment Variables**。
3. 新增變數：
   * **`TAINAN_PROXY_URL`**：填入您的代理網址（例如 `https://asia-east1-myproject.cloudfunctions.net/tainan-proxy`）。
   * **`TAINAN_PROXY_SECRET`**：若有啟用密鑰，填入該密鑰；若無可留空。
4. 點擊 **Save**。
5. 前往 **Deployments** 頁面，點選最新一筆部署右側的 `...` -> **Redeploy**（使新環境變數生效）。

完成後，Vercel 每次執行排程檢查台南市動態時，即會全自動透過台灣出口代理抓取天眼即時車輛，徹底終結請求逾時與通知漏發問題！
