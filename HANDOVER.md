# HANDOVER

- **目前／目標 Phase**：Phase 5B 本機驗收與規格封存完成。
- **Change／Ticket／Milestone**：`strict-line-group-id-command`，3／3。封存於 `openspec/changes/archive/2026-11-05-strict-line-group-id-command`。主規格位於 `openspec/specs/line-group-id-query/spec.md`。
- **已確認規格版本**：2026-11-05 方案 A。完整 `/id`，忽略首尾空白與英文字母大小寫。網址和附帶 `/id` 的網址訊息均不得觸發。
- **依賴／阻礙**：沿用 ADR 0005 的 Webhook 與 LINE 回覆介面。正式部署與線上驗收待安排。
- **完成／待辦 Checklist**：需求、設計、TDD、README、雙軸審查與修正、全套離線回歸、主規格同步及封存均完成。
- **測試／驗收／審查證據**：群組 Red 6 通過、10 個拒絕案例因實際回覆 1 次、預期 0 次而失敗。聊天室相容性 Red 為實際 0 次、預期 1 次。最終 `npm test` 304／304 通過。變更與主規格 strict 驗證通過，封存後無進行中變更。Standards 首輪 2 項、最高 P3。Spec 首輪 1 項、最高 P2。兩軸重審各 0 未解決及 0 新增。基準 `15423e1f79f89b25940f6ac65ea38d69946a6bd7`，審查摘要與差異雜湊見封存 `tasks.md`。
- **子代理模型／effort**：Git `gpt-6-luna`／Low，TDD Red／Green 與修正 `gpt-6-luna`／Medium，兩軸審查及重審 `gpt-6.1-sol`／High。主代理維持初始模型與 effort。
- **下一步**：依使用者授權安排 Git 交付與部署。此輪驗收採離線 LINE 替身。
