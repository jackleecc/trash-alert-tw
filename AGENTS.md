# Project Guidelines & Rules

## Mandatory Location Onboarding Rule (新地點加入驗證標準)

> **日後任何新地點加入，務必先確認撈得到該地點的歷史實際清運資料，才算真正加入地點成功。**

### 執行要點：
1. **先確認歷史實績**：在宣稱加入新站點或建立訂閱前，必須先透過 API 或外部端點實際撈取到該地點的歷史實際清運動態（包含實際到站時間戳記、執勤車號/車牌、實際收運記錄）。嚴禁僅憑靜態公告或推估座標直接宣告成功。
2. **驗證演算法相容**：建立測試套件驗證自適應地理圍欄、進場方位角、班表時間窗與車速過濾。
3. **產出驗證記錄**：在 `docs/reports/` 留下包含真實歷史數據佐證的地點報告。

詳細規範請參閱 [.agents/rules/location-verification.md](.agents/rules/location-verification.md)。

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

