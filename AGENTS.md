# Project Guidelines & Rules

## Mandatory Location Onboarding Rule (新地點加入驗證標準)

> **日後任何新地點加入，務必先確認撈得到該地點的歷史實際清運資料，才算真正加入地點成功。**

### 執行要點：
1. **先確認歷史實績**：在宣稱加入新站點或建立訂閱前，必須先透過 API 或外部端點實際撈取到該地點的歷史實際清運動態（包含實際到站時間戳記、執勤車號/車牌、實際收運記錄）。嚴禁僅憑靜態公告或推估座標直接宣告成功。
2. **驗證演算法相容**：建立測試套件驗證自適應地理圍欄、進場方位角、班表時間窗與車速過濾。
3. **產出驗證記錄**：在 `docs/reports/` 留下包含真實歷史數據佐證的地點報告。

詳細規範請參閱 [.agents/rules/location-verification.md](.agents/rules/location-verification.md)。

## Mandatory Development Workflow Rule (強制開發三階段流程與降檔規範)

> **凡有「新功能設計」或「原有功能修改」，務必嚴格依序使用三組技能：`grill-with-docs` ➔ `tdd` ➔ `code-review`。**
> **除了使用者明示「不需要隔離環境 (worktree)」外，施工與審查的 Model 與 Effort 降檔必須嚴格遵循政策。**

### 執行要點：
1. **三階段技能鏈 (Three-Skill Pipeline)**：
   - **Phase 1 & 2 發想與規格 (`grill-with-docs`)**：Model 使用最高階 (`pro`)、Effort 強制 **High 或以上**（省不得）。確立架構、產出 ADR、領域字典與完整規格。
   - **Phase 3 隔離環境**：**免除**（不需要建立 worktree，直接在現有環境執行）。
   - **Phase 4 實作委派 (`tdd`)**：必須低於 High（Low/Medium），嚴格依任務性質分層降檔：
     - **機械 (Mechanical)**：照樣板改、批次替換、純接線 ➔ `flash_lite` (Low)。
     - **新邏輯 (New Logic)**：新演算法、模組串接、狀態機 ➔ `flash` (Medium)。
     - **TDD Red (寫失敗測試)**：任何 task 測試 ➔ `flash` (Medium)（避免斷言寫鬆假綠導致無法觸發升級）。
     - **降檔決策**：不確定哪一層先用 `flash_lite`，失敗一次才升 `flash`。
     - **Green 實作兩道手續**：降至 `flash_lite` 必須確認 ① Red 為真失敗（指向業務邏輯 assertion 非 import/語法錯誤）且 ② 交接必須附「完整測試檔 + 失敗原文」。
   - **Phase 5 程式碼審查 (`code-review`)**：Model 使用 `flash` 或 `pro`、Effort 為 **High**（唯二例外之一）。雙軸審查（Standards 規範與壞味道 + Spec 規格一致性）。
2. **只有兩個例外可以升到 High Effort**：
   - **例外 1**：Phase 5 `code-review`（雙軸審查為高階推理判斷）。
   - **例外 2**：Phase 4 任務在 low/medium 下「實際失敗一次」（需填寫升 High 原因與失敗證據）。
   - ⛔ **禁令**：「任務看起來很難」或「想深一點」不准升檔，屬 Spec 未寫清楚，應退回 Phase 2 補 Spec！

詳細規範請參閱 [.agents/rules/development-workflow.md](.agents/rules/development-workflow.md) 與 [.agents/rules/code-review.md](.agents/rules/code-review.md)。

## Mandatory Code Review Rule (程式碼審查規範)

> **凡有「新功能開發」或「原有功能修改」，完成後務必使用 `code-review` skill 檢查寫好的程式碼，確認符合專案規範與規格要求後方可交付。**

### 執行要點：
1. **觸發時機**：
   - 新功能開發 (New Feature Development)
   - 原有功能修改、Bug 修復或重構 (Existing Feature Modification)
2. **雙軸審查標準**：
   - **Standards 軸**：檢查是否遵循專案規範與 Fowler 12 種程式碼壞味道（Smell baseline）。
   - **Spec 軸**：比對需求規格，檢查是否有遺漏、未預期的範圍蔓延 (Scope Creep) 或實作缺陷。
3. **完成條件**：雙軸審查皆通過並處理完回報問題後，方可進入測試與交付階段。

詳細規範請參閱 [.agents/rules/code-review.md](.agents/rules/code-review.md)。

