# Proposal

## Why

2026-10-22 19:45:20，汐萬路一段333巷口收到距離19公尺的647-BX通知，使用者現場觀察為路過而未收運。離線重現證實現行低速豁免可讓北上車通過；缺少當時原始GPS，不能宣稱已證實該次通知的精確分支。

## What Changes

- 僅對路線221010、正式Stop 3建立待確認／確認／拒絕狀態；未知方向、低速漂移及初次觀測不直接通知。
- 使用含可信GPS採樣時間的343巷口前站證據與南下連續進場，明確逆向先攔截；不要求120公尺內連續兩輪。
- Supabase保存跨實例軌跡及逐次判斷稽核，以原子CAS避免失序與覆寫；儲存失效時待確認。
- 確認前不建立Notification Intent，不佔Cooldown Claim、不扣額度、不寫notification_logs或啟動每日休眠。
- 到站文案移除未經估算的固定2～5分鐘，改為「車輛已接近站點」。
- 交付SQL檔及離線證據；正式migration套用、部署與實車驗收另列待驗收。

## Capabilities

### New Capabilities

- `collection-approach-confirmation`: 指定站點以可信採樣、前站軌跡及共享狀態確認進場，並保留通知前的決策證據。

### Modified Capabilities

無；目前OpenSpec主規格清單為空。既有非汐止Stop 3的匹配語意保留。

## Impact

新增純運算模組`lib/collectionApproach.js`、共享狀態服務`lib/collectionApproachStore.js`與增量SQL；調整`lib/coreProcessor.js`、新北intake來源標記及到站文案。沿用既有排程窗、圍欄、訂閱、信任名單與通知調度。網站備援頂層時間仍為response，不能確認GPS新鮮度，因此保護站點在僅備援可用時可能延遲或漏報；其他站點保留備援原行為。無新增地點、訂閱或外部服務依賴，不呼叫真LINE、不部署、不套用正式DB。
