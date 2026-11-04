# Spec Delta

## Purpose

讓 LINE 群組成員透過明確指令取得群組識別碼，避免一般對話或分享含相似字樣的網址時收到群組識別碼回覆。

## ADDED Requirements

### Requirement: 群組 ID 查詢須精確比對完整文字

對於通過簽章驗證且具有可用回覆 token 的群組文字事件，系統 SHALL 僅在去除首尾空白後整則訊息為 `/id` 時回覆群組 ID。比對時忽略英文字母大小寫。

#### Scenario: 完整指令及正規化
- **WHEN** 群組成員傳送 `/id` 或首尾有空白的 `/ID`
- **THEN** 系統回覆一次，內容包含該群組 ID

#### Scenario: 一般聊天及舊關鍵字
- **WHEN** 群組成員傳送 `id`、`群組`、`group`、`查詢`、`請輸入 /id`、`這個群組` 或 `video`
- **THEN** 系統 MUST NOT 回覆群組 ID

#### Scenario: 分享網址
- **WHEN** 群組成員傳送含 `/id` 的網址、查詢參數含 `/id` 的網址，或在同一則訊息貼上網址並另起一行輸入 `/id`
- **THEN** 系統 MUST NOT 回覆群組 ID
