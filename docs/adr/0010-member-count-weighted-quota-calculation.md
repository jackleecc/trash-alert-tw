# ADR 0010: LINE 群組人數加權推播額度計算與 200 則熔斷機制 (Member-Count Weighted Quota Calculation and 200 Melt Threshold)

## 狀態
Accepted

## 背景與問題陳述
使用者反映桃園群組收到的到站通知中顯示：
`📊 本月推播額度：已用 4 / 剩餘 196`
經查核 LINE Messaging API 官方計費與用量規則：
1. **官方計費標準**：對 LINE 群組發送 Push Message 時，消耗之推播額度為「推播次數 × 群組成員人數」，而非單純的推播次數。
2. **現狀落差**：
   - 桃園群組（`Cbc0...487e`）成員共有 9 人，10 月份至今推播 4 次，LINE 官方後台實際已扣除 36 則（$9 \times 4 = 36$）。
   - 原系統實作（`reserve_quota`、`formatArrivalMessage`、`tainan-relay.js`）皆固定每次推播累加 1 則，導致顯示與實際額度脫節。
   - 其他地區群組（台南、汐止等）亦各自擁有不同人數，同樣需要依群組人數校正計算。
3. **熔斷門檻明確化**：
   - 熔斷上限嚴格設定為 200 則（`MELT_THRESHOLD = 200`），當剩餘額度不足以支付該群組人數時（或累計達 200 則），立即觸發熔斷防護阻斷推播。

## 決策方案

1. **群組人數同步與持久化快取 (`line_groups.member_count`)**：
   - 於資料庫 `line_groups` 增加 `member_count` 欄位（`INTEGER NOT NULL DEFAULT 1`）。
   - 於推播流程或 Webhook 互動時，透過 LINE API `GET /v2/bot/group/{groupId}/members/count` 取得真實人數並寫入/更新 `line_groups.member_count`。
   - 若 LINE API 發生連線異常或 404，平穩降級讀取 DB 快取值（最低保底 1 人）。

2. **原子配額保留升級 (`reserveQuota` 與 `releaseQuotaReservation`)**：
   - 更新 PostgreSQL 預存程序 `reserve_quota(p_month VARCHAR(50), p_amount INTEGER DEFAULT 1)`：
     - 當 `sq.used_count + p_amount <= 200` 時，允許扣除並更新 `used_count = sq.used_count + p_amount`。
     - 若更新後達 200 則，標記 `is_melted = true`。
     - 若剩餘額度不足 `p_amount`（即 `sq.used_count + p_amount > 200`），則拒絕保留（`reserved = false`），並將該頻道標記為熔斷保護。
   - 更新釋放預存程序 `release_quota_reservation(p_month VARCHAR(50), p_amount INTEGER DEFAULT 1)`：
     - 若推播失敗，原子回滾 `p_amount` 點額度。

3. **到站通知文案額度呈現與即時投影 (`formatArrivalMessage`)**：
   - 到站推播維持簡潔文案：`📊 本月推播額度：已用 X / 剩餘 Y`。
   - 針對特定群組組裝訊息時，將該群組的 `member_count` 作為本次消耗量（`cost = member_count`）：
     - `displayUsed = usedCount + cost`
     - `displayRem = Math.max(0, 200 - displayUsed)`
   - 讓使用者看到的「已用 / 剩餘」精確反映該群組送達後的官方帳號額度狀態。

4. **歷史資料處理**：
   - 依使用者決策（Q4 > B），不回溯改寫當月歷史資料庫數字，自本次更新後的下一次推播開始依照新規則精確加權扣除。

## 影響範圍 (Consequences)
- `lib/quotaService.js`：`reserveQuota` 與 `releaseQuotaReservation` 支援傳入 `amount`。
- `supabase/migrations/add_group_member_count_and_weighted_quota.sql`：新增 `member_count` 欄位與升級預存程序。
- `lib/lineClient.js`：新增 `fetchGroupMemberCount(groupId, options)` 工具函式。
- `lib/notificationDispatcher.js`：調度時結合群組人數，保留與釋放對應的加權額度。
- `lib/coreProcessor.js` 與 `api/tainan-relay.js`：文案組裝納入群組人數計算。
