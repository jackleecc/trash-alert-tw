# HANDOVER

## 目前／目標 Phase

目前 Phase 5B：備援預設啟用已完成離線測試與正式雙軸審查；正在補齊使用者新版 AGENTS.md 所需的專案 OpenSpec 工具與 skills，準備 commit + push。目標為完成技能檢查並將核准變更同步至遠端。

## Change／Ticket／Milestone

- 功能：New Taipei website backup default enable。
- 既有基準：cc2efe9；本次提交編號以最後 Git 子代理回報為準。
- 核准規格：docs/specs/ntpc-backup-default-enable.md；延續 docs/specs/ntpc-website-backup.md 與 ADR 0011。
- 本次技能安裝屬工具準備，不補造先前功能的 OpenSpec 開工／archive 歷史。後續新功能依新版 AGENTS.md 建立 proposal、specs、design、tasks 與 ADR。

## 依賴與阻礙

- 使用者已授權 commit + push，並明示包含其修改的 AGENTS.md；保留該檔原文。
- OpenSpec 原先未安裝，現已安裝並確認引用相依技能；工具版本與結果以 docs/reports/openspec-install-audit-2026-10-17.md 為準。
- 服務時段備援 GPS 更新與延遲仍未取得充分實證；10/13 採樣缺檔，不能宣稱驗證成功。
- 正式部署與雲端設定尚未執行／確認。禁止本次作業呼叫實際 LINE API、正式 handler 或 dry-run。

## 完成與待辦

- [x] 未設定旗標／精確 true 預設啟用，false 或不明字串關閉；保留 boolean override 與既有資料／通知護欄。
- [x] 真正業務 assertion 的 Red，之後 Green；完整離線測試 234/234 通過。
- [x] Standards 與 Spec 雙軸 High 審查皆為 0 項問題。
- [x] 實際通知紀錄查核與限制記錄於 docs/reports/ntpc-notification-recovery-2026-10-17.md。
- [x] 官方 OpenSpec 1.14.2 本專案 CLI 與 6 個核心 skills 已安裝；既有 39 個 skills 及引用檔案完整。
- [x] 新增工具檔已通過 Standards／Spec 雙軸 High 複查；AGENTS.md 原文保留，相依技能完整。
- [ ] 只暫存核准檔案，commit + push，核對本機與遠端提交一致。
- [ ] 正式部署：待使用者後續指示；本次不執行。
- [ ] 實車 GPS 新鮮度／延遲：待驗收，不因設定啟用而變成已驗證。

## 測試／驗收／審查證據

- 功能測試：.scratch/ntpc-backup-default-enable/full-output.txt（234/234；網路拒絕 preloader 啟用）。
- Red 原文與完整測試：.scratch/ntpc-backup-default-enable/red-output.txt、red-full-test.js。
- 功能審查基準：cc2efe9；準備差異 .scratch/ntpc-backup-default-enable/review.diff。
- 上述 scratch 證據為本機診斷資料，不納入提交；版本化文件保留具體結論與限制。

## 子代理模型／Effort

- 功能設計與規格：gpt-6.1-sol／High（在本次 AGENTS 更新前依當時對應表執行）。
- 功能 Red／Green：gpt-6.1-sol／Medium（在本次 AGENTS 更新前執行）。
- Standards／Spec 正式審查：各 gpt-6.1-sol／High。
- 本次 OpenSpec 安裝與機械設定：gpt-6-luna／Low。
- Git 查詢／提交／推送：gpt-6-luna／Low；主對話未執行 Git 命令。

## 下一步

完成專案技能安裝稽核與工具檔審查後，由 Git Low 子代理統一提交備援、使用者 AGENTS.md、工具與交接文件，再核對推送結果。保留 .env、scratch、.scratch、原始 API 回應與使用者未要求的未追蹤檔案於本地。
