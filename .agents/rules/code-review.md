# 程式碼審查規則

新功能或既有功能修改（含商業邏輯、重構、Bug 修正與資料流架構）在提交或宣告完成前，必須對程式碼異動完成 code-review skill 的雙軸正式審查。

- **Standards**：檢查專案規範、程式風格、型別、目錄與命名；逐項考慮 `code-review` skill 所列 Fowler 壞味道。壞味道是判斷提示，不是硬性違規；專案明文標準優先，工具已強制的項目略過。
- **Spec**：核對需求是否完整、是否有範圍蔓延，以及實作是否符合規格且無非預期副作用。
- **程序**：先鎖定並驗證使用者指定的固定 Git 基準，確認差異非空；提供差異、提交清單、規格來源及標準來源，依 skill 平行執行兩軸審查。依 findings 修正；兩軸均無阻礙問題後才交付。報告分軸呈現原 findings，不合併重排，並各自列出問題數與最嚴重問題；缺少規格時標明 Spec 無可用規格。

完整 smell 清單、雙代理輸入格式與審查報告細節依 [.agents/skills/code-review/SKILL.md](../skills/code-review/SKILL.md) 為準。正式審查使用 High，模型與委派依 [.agents/rules/development-workflow.md](development-workflow.md) 表格辦理。
