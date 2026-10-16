# 專案工作入口

## 全域護欄

- Git 查詢與所有 Git 操作一律交由 GPT `gpt-6-luna`／Low 或 Gemini `flash_lite`／Low 執行；主代理不得執行 Git 命令。`git-ops` 技能不需載入。未獲使用者明示授權，不 push、不改寫歷史、不做刪除或破壞性操作。
- 主代理維持本對話初始模型與 effort；不切換、不要求使用者代為切換，也不建立 worktree。所有平台與階段均禁用 `pro`。
- 新功能設計或既有功能修改：依序完成需求訪談、架構決策、OpenSpec、TDD、雙軸審查與交付收尾。模型／effort、派工材料、升階例外、停工門檻及完成條件，以 [.agents/rules/development-workflow.md](.agents/rules/development-workflow.md) 為唯一準則；開工或派發施工前先核對規格、依賴與驗收條件。
- 新地點：只有在取得含實際到站時間戳、車號／車牌及收運紀錄的歷史清運資料，完成演算法驗證並留下 `docs/reports/` 報告後，才可宣告成功或建立訂閱。加入地點時必讀 [.agents/rules/location-verification.md](.agents/rules/location-verification.md)。
- 程式碼變更交付前必須完成 Standards 與 Spec 雙軸審查；觸發條件、固定基準與報告規則見 [.agents/rules/code-review.md](.agents/rules/code-review.md)，壞味道清單依該規則指向的 `code-review` skill。

## 接手與狀態

新對話先讀本檔、`HANDOVER.md` 及目標 OpenSpec。每張 Ticket 與階段完成後更新 `tasks.md` 和 HANDOVER；其快照格式、必填證據與清理時點依 development-workflow 規則辦理。
