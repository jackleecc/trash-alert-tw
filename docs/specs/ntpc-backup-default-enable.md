# 新北網站備援預設啟用變更

日期：2026-10-17。使用者要求「直接把上次的備援寫進去」，因此將既有同輪備援由選擇啟用改為預設啟用。本文件更新 [原規格](ntpc-website-backup.md) 的旗標預設與啟用程序；資料擷取、正規化及通知契約沿用原規格。

## 旗標契約

| 設定 | 有效狀態 |
| --- | --- |
| 環境變數未設定 | 啟用 |
| `NTPC_WEBSITE_BACKUP_ENABLED=true`（精確字串） | 啟用 |
| `NTPC_WEBSITE_BACKUP_ENABLED=false` | 關閉並回到既有 intake 行為 |
| 其他環境字串，包括空字串、`TRUE`、`1`、`true ` | 關閉，保留對不明設定的保守處理 |
| 呼叫選項 `ntpcWebsiteBackupEnabled: true/false` | 明確 boolean 優先於環境設定；其餘非 `undefined` 值仍關閉 |

`.env.example` 改為 `true`。既有環境若已明確設為 `false`，程式更新後仍關閉；移除環境變數會啟用，不能再作為回滾方式。回滾須明確設定 `false`，並讓執行程序載入更新後的環境。

## 範圍與證據

既有追蹤週期已將活躍訂閱的新北 Route IDs 傳入 `fetchActiveTrucks`。預設啟用只改變旗標解析；主來源有效資料優先、僅補缺口、無必要新北路線／暫停城市／override URL 不查網站等條件保持原契約。不新增 Stop、Subscription、資料庫欄位或到站事件。

網站 `TimeStamp` 仍只代表回應時間，不能視為逐車 GPS 採樣時間。2026-10-13 探查計畫沒有保存有效樣本，見 [採樣結案](../reports/ntpc-221010-sampling-2026-10-13.md)；連續位置更新與五分鐘 GPS 延遲的服務實證仍未完成。本次依使用者新的直接整合指示調整預設，並未取得上述證據，也不宣稱補資料能保證不漏報或不誤判。

本次完成條件為來源修改、離線測試與雙軸審查。此變更不包含修改秘密環境檔、部署、呼叫真實 LINE、寫入正式資料庫或執行 production handler／dry-run；正式環境是否生效須依實際部署版本與環境設定另行確認。後續服務時段仍應保存連續樣本，檢查位置更新、來源、路線覆蓋、拒絕原因與熔斷；異常時明確設 `false` 回滾。

## 驗收

- 由公開 `fetchActiveTrucks` 入口證明：未設定環境旗標且所需路線缺漏時會查備援；精確 `true` 同樣啟用；`false` 與不明字串不查備援。
- 明確 boolean 選項可覆蓋預設／環境旗標；既有 disabled、override、非新北、暫停及空 IDs 用例仍通過。
- 由公開 `executeTruckTrackingCycle` 入口，在未設定旗標時沿用真實 facade／intake／matcher，證明只有活躍訂閱路線進入備援。HTTP、DB 及 LINE 依賴全部 mock，拒絕未宣告網路，斷言零通知。
- 主來源正常且所需路線新鮮時不查備援；原時間邊界、provenance、網站資料拒絕、canonical sourceStats 與 matcher 回歸測試持續通過。
