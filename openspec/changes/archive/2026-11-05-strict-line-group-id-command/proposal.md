# Proposal

## Why

LINE 群組文字目前以子字串比對查詢指令，日常聊天與網址也會收到群組 ID 回覆。使用者選定以完整 `/id` 指令查詢。

## What Changes

- **BREAKING** 群組文字查詢只接受整則 `/id`。比對時忽略前後空白及英文字母大小寫。
- 新增網址及一般聊天文字的離線回歸測試，並更新 README 的群組查詢指引。

## Capabilities

### New Capabilities

- `line-group-id-query` — LINE 群組 ID 文字查詢規則。

### Modified Capabilities

## Impact

變更集中於 LINE Webhook 的群組文字查詢分支、Webhook 測試及 README。
