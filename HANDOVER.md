# HANDOVER

- **目前／目標 Phase**：規範與技能上下文精簡；使用者已確認，準備提交與推送。
- **Change／Ticket／Milestone**：context-rules-draft（文件與本機設定整理，未建立或補造功能 OpenSpec 變更）。
- **確認範圍**：撤回技能清單 1,000 tokens 上限；精簡 AGENTS.md；詳細派工與門檻集中至開發流程文件；審查細節引用 code-review skill；依使用者指示移除兩份全域重複 git-ops，保留全部 45 個專案 skills。
- **依賴／阻礙**：以使用者最新 AGENTS.md 政策為準；不得採用舊流程文件中的 pro 或舊模型對應。全域技能移除後的清單更新須後續工作階段確認。
- **完成／待辦**：前次備援預設啟用、OpenSpec 安裝與使用者 AGENTS.md 已推送 da3d9cd；本次草稿的設定、引用與政策對照檢查已完成；1,000 上限與多餘設定檔已移除；使用者已確認本次四個文件的提交與推送。
- **測試／驗收／審查證據**：既有功能離線測試 234/234、雙軸審查通過；本次不改業務程式，僅檢查文件與設定。功能規格見 docs/specs/ntpc-backup-default-enable.md，工具與弱點稽核見 docs/reports/openspec-install-audit-2026-10-17.md。
- **子代理模型／Effort**：草稿整理 gpt-6-luna／Medium；Git 查詢 gpt-6-luna／Low。
- **下一步**：提交並推送本次核准的四個文件，確認遠端提交一致。正式部署、實車 GPS 新鮮度／延遲仍待驗收；禁止實際 LINE API。
