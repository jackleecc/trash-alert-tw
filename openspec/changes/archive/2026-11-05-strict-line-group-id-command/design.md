# Design

## Context

LINE Webhook 目前共用一個文字查詢條件來處理群組及私訊。群組查詢與回覆沿用 ADR 0005 的頻道路由。

## Goals / Non-Goals

本次調整的範圍是群組來源的文字查詢。現有事件分流與回覆介面提供驗收邊界。

## Decisions

- 沿用已去除首尾空白的訊息文字。來源含 `groupId` 的事件以小寫後的完整字串等於 `/id` 為查詢條件。房間與私訊沿用既有條件，正規化的識別碼繼續用於路由與回覆。
- 在 `test/line-webhook.test.js` 以已簽章的 Webhook 請求驗證 LINE 回覆的內容及次數。外部網路使用測試替身及現有的阻擋工具。
- 本變更沿用現有模組與詞彙。架構依循 ADR 0005，交付里程碑為離線回歸、雙軸審查及 OpenSpec 封存。

## Risks / Trade-offs

使用舊關鍵字的群組成員需改用 `/id`，README 同步更新操作指引。
