# tainan-relay-early-notification Specification

## Purpose

配合「臺南環保通」Android App 提早 10 分鐘設定，於 `/api/tainan-relay` LINE 推播訊息中顯示「約 10 分鐘內」預估抵達時間，並支援同路線未訂閱上游站名自動導向唯一活躍訂閱站點。

## Requirements

### Requirement: Tainan relay reflects 10-minute advance notice and resolves upstream route stops

`/api/tainan-relay` SHALL 配合手機端「臺南環保通」App 提早 10 分鐘設定，於 LINE 推播訊息中顯示「⏰ 預估抵達：約 10 分鐘內」取代既有「約 3～5 分鐘內」；當請求未指定 `stop_id` 且通知文字包含同路線未訂閱之上游站點名稱時，若該路線僅有唯一活躍訂閱站點（或對應目標站點），SHALL 自動導向該活躍訂閱站點發送，仍對無關系統通知回傳 404。

#### Scenario: Tainan relay pushes 10-minute advance ETA message
- **WHEN** 手機轉發 `stop_id: 6` 之臺南環保通到站提醒至 `/api/tainan-relay`
- **THEN** 推播至訂閱群組之 LINE 訊息包含「⏰ 預估抵達：約 10 分鐘內」且不含「約 3～5 分鐘內」

#### Scenario: Tainan relay resolves upstream route stop text to active subscriber stop
- **WHEN** 轉發通知未帶 `stop_id`，文字包含同路線上游站點名稱（如 `文化路128巷10號`）而非已訂閱站名（`永康區文化路40號`），且路線 `70` 僅有 Stop 6 為活躍訂閱站點
- **THEN** 系統解析並通知 Stop 6 所屬活躍訂閱群組，無關通知文字（如手機低電量提示）仍回傳 404
