# Trash Alert TW

高雄市垃圾車 LINE 追蹤與到站通知系統。

## 正式服務

| 項目 | 網址 |
| --- | --- |
| 正式網站 | https://trash-alert-tw.vercel.app |
| 垃圾車檢查 API | https://trash-alert-tw.vercel.app/api/check-trucks |
| GitHub 專案 | https://github.com/jackleecc/trash-alert-tw |

## 資料庫

正式資料庫使用 Supabase PostgreSQL：

https://tjltndxwhxjfsgmkjmnd.supabase.co

資料表：

- `routes`
- `stops`
- `line_groups`
- `subscriptions`
- `notification_logs`
- `system_quota`
- `daily_status`
- `route_linids`

資料庫函式：

- `observe_route_linid`
- `claim_notification`
- `release_notification_claim`
- `reserve_quota`
- `release_quota_reservation`

## 外部服務

| 用途 | 網址 |
| --- | --- |
| 高雄市垃圾車即時動態 | https://api.kcg.gov.tw/api/service/Get/aaf4ce4b-4ca8-43de-bfaf-6dc97e89cac0 |
| 行政院人事行政總處停班停課資訊 | https://www.dgpa.gov.tw/typh/daily/nds.html |
| LINE Messaging API 推播 | https://api.line.me/v2/bot/message/push |

## 自動排程

GitHub Actions 為主要觸發器：

- Cron：`* 9-13 * * *`（UTC）
- 台灣時間：每日 `17:00-21:59`，每分鐘呼叫一次垃圾車檢查 API。
- Workflow：[.github/workflows/trigger.yml](.github/workflows/trigger.yml)
- GitHub Actions secrets：`CHECK_TRUCKS_URL`、`CRON_SECRET`

Vercel Cron 為備援：

- Cron：`0 9 * * *`（UTC）
- 台灣時間：每日 `17:00` 一次。
- 設定檔：[vercel.json](vercel.json)

## 環境變數

以下機密只設定於 Vercel Production 與 GitHub Actions Secrets，不可提交到 Git：

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `CRON_SECRET`
- `TRUCK_API_URL`

## 本機驗證

```bash
npm test
```
