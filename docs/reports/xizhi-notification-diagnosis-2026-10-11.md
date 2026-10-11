# 汐止最近未通知診斷（2026-10-11）

## 結論

汐萬路一段333巷口（Stop 3，Route 221010，群組末碼 b291）自 2026-10-08 起無通知，證據指向新北市公開即時車輛資料缺失／停滯。現行來源回傳 HTTP 200，但只有一筆瑞芳區路線 224011 的 BWM-8121，資料時間固定為 2026/10/07 20:35:13。汐止路線 221010 完全不存在，無法產生到站通知。

這是已觀察到的資料供應異常；無法僅憑本系統紀錄判定政府平台內部故障原因，亦不能證明車輛實際未清運。

## 真實歷史佐證（台灣時間）

| 日期 | 汐止通知／每日備援紀錄 |
| --- | --- |
| 10/02 | 19:53:08 通知 647-BX；最近距離 102m |
| 10/03 | 19:53:08 通知 647-BX；最近距離 112m |
| 10/05 | 19:53:08 通知 647-BX；最近距離 116m |
| 10/06 | 19:53:09 通知 647-BX；最近距離 97m；為最近一筆汐止通知 |
| 10/08 | 無汐止通知；20:36:08 最近車輛 BWM-8121，16688m |
| 10/09 | 無汐止通知；20:36:09 最近車輛 BWM-8121，16688m |
| 10/10 | 無汐止通知；20:36:09 最近車輛 BWM-8121，16688m |

10/07（週三）、10/11（週日）不在路線 active_days [1,2,4,5,6] 內，依現行設定不應通知。

10/08～10/10 daily_status 均為 is_suspended=false、is_paused=false、api_fail_count=0，且 updated_at 約為台灣時間 21:59，證明每天有執行活動與車輛比對備援紀錄。這些是每日最後留下的摘要，並非完整逐分鐘追蹤。

## 上游查核

正式使用的端點：
https://data.ntpc.gov.tw/api/datasets/28ab4122-60e1-4065-98e5-abccb69aaca6/json?page=0&size=5000

2026-10-11 查核：

- page=0&size=5000：HTTP 200，1 筆，221010 共 0 筆。
- page=0&size=1000：HTTP 200，仍為相同 1 筆。
- page=0&size=5000 加查核參數，並送 Cache-Control: no-cache：仍相同 1 筆。
- page=1&size=1000：HTTP 200，0 筆。

唯一車輛：lineid=224011、car=BWM-8121、time=2026/10/07 20:35:13、latitude=25.1079583333333、longitude=121.811915、location=新北市瑞芳區明燈路二段15號。

現行 adapter 正確保留此車的路線、車號與座標。computeClosestTrucks 算出距離 Stop 3 為 16688m，與三天歷史摘要完全一致。該摘要在沒有目標路線車輛時會顯示其他路線最近車輛，所以 BWM-8121 不是汐止路線換車的證據。

## 離線重現

命令：`node scratch/xizhi-offline-replay.mjs`

網路完全封鎖，輸入為實際 API 回應與已去識別化資料庫快照；固定在表定 19:56，執行正式 adaptTruckData、findNearbyTruckArrivals、computeClosestTrucks。

連續兩次結果一致：inputRecords=1、targetRouteRecords=0、notificationCandidates=0、closest distance=16688。

失敗原文：

```
AssertionError [ERR_ASSERTION]: NO_XIZHI_NOTIFICATION: captured upstream response produces zero eligible notification candidates at scheduled arrival time
```

此斷言刻意檢查是否能產生汐止通知候選；紅燈代表症狀重現，不是程式語法或匯入失敗。輸入已最小化為上游唯一一筆車輛、一個訂閱站點及該路線信任名單。此次僅診斷，未修改功能，故不宣稱修復或綠燈。

## 其他原因排查

- Route 221010 is_active=true，清運日設定正常。
- Stop 3 座標 25.076252, 121.649942、order_index=17、schedule_time=19:56:00；資料庫共保有該路線 21 站拓撲。
- 群組末碼 b291 is_active=true，訂閱 Stop 3 仍存在，member_count=2。
- 信任名單 221010 -> 221010，observed_count=103，最後觀測為 10/06 19:53:08。
- 新北使用的 system_quota 2026-10：used_count=40，is_melted=false。此為資料庫數值；遵守限制未查 LINE 官方用量。
- 10/08～10/10 沒有汐止 notification_logs，因此沒有該站當日已通知休眠的證據。
- 名稱含汐止的其他群組並非都訂閱汐止：末碼 e6fa 訂閱的是台南 Route 70 / Stop 6；末碼 b94e 無訂閱。本結論針對真正訂閱汐止 Stop 3 的 b291。

## 可觀測性缺口與建議

public.execution_logs 尚不存在，Supabase 回傳 PGRST205；系統改寫 daily_status 作為備援，僅保存最後摘要，無法還原每一輪的匹配與發送錯誤。API 回傳成功且有一筆合法車輛，亦不會觸發目前以連線失敗為基準的失敗計數。

後續可另案驗證其他新北官方資料來源，加入資料新鮮度與已訂閱路線缺資料的監測，並建立 execution_logs。不可將遠方舊車輛當作到站，也不可為測試發送 LINE 訊息。

## 操作範圍與證據檔

全程未呼叫 LINE API，未使用正式追蹤入口、未寫入資料庫、未保留通知鎖或扣除配額，未部署。

保留在 scratch/ 的診斷專用證據：

- xizhi-diagnosis-snapshot.json：去識別化資料庫快照。
- xizhi-ntpc-current.json：實際官方回應。
- xizhi-endpoint-probes.json：參數與快取排查結果。
- xizhi-offline-replay.mjs：禁止網路的確定性重播。
- xizhi-readonly-diagnosis.mjs：只准 Supabase GET 的資料庫讀取器。
- xizhi-ntpc-readonly.mjs、xizhi-endpoint-probes.mjs：固定官方公開 GET 查核器。

未增加任何正式執行路徑的除錯日誌。
