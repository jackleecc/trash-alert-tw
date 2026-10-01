# ADR 0009: 頻道獨立額度即時預測與到站推播呈現補正 (Per-Channel Realtime Quota Projection)

## 狀態
Accepted

## 背景與問題陳述
使用者反映今日（每月第一天）各群組收到的第一則到站通知中，頁尾顯示：
`📊 本月推播額度：已用 0 / 剩餘 200`
使用者期望：正在送達的這則推播本身應計入已用額度，顯示為：
`已用 1 / 剩餘 199`（或明確反映送達當下的已使用狀態）。
根本原因分析：
1. **快照時序偏遲**：
   - `coreProcessor.js` 在組裝通知文字時，先呼叫 `getQuotaSnapshot(currentMonth)`。
   - 此時資料庫的 `used_count` 仍為 `0`。
   - 文字組裝完畢後，才由 `dispatchNotification` 呼叫 `reserveQuota` 將資料庫更新為 `1`。
   - 導致送達給使用者的訊息內容永遠停留在「發送前」的計數，產生 off-by-one 延遲。
2. **多頻道隔離缺失**：
   - `coreProcessor.js` 的 `getQuotaSnapshot` 僅查詢全域預設頻道（`CHANNEL_DEFAULT`），未根據目標群組/路線之所屬頻道（如桃園 `CHANNEL_TAOYUAN` 對應 `2026-10:taoyuan`）動態索取獨立配額快照。

## 決策方案
1. **即時發送用量預測 (Realtime Quota Projection)**：
   - 當系統即將發送該則到站提醒時，於 `formatArrivalMessage` 中將此則正在送達的訊息納入用量呈現：
     - `displayUsed = quotaInfo.usedCount + 1`
     - `displayRem = Math.max(0, quotaInfo.maxQuota - displayUsed)`
   - 當月第 1 則通知精確顯示：`📊 本月推播額度：已用 1 / 剩餘 199`。
2. **多頻道動態額度掛載**：
   - `coreProcessor.js` 針對各站點/路線所屬頻道（透過 `resolveChannelForIntent` 解析），索取對應頻道的配額快照（如桃園專用 `2026-10:taoyuan`），確保桃園與汐止/臺南各群組的額度數據 100% 獨立且正確呈現。
