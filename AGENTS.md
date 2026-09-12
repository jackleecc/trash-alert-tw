# Project Guidelines & Rules

## Mandatory Location Onboarding Rule (新地點加入驗證標準)

> **日後任何新地點加入，務必先確認撈得到該地點的歷史實際清運資料，才算真正加入地點成功。**

### 執行要點：
1. **先確認歷史實績**：在宣稱加入新站點或建立訂閱前，必須先透過 API 或外部端點實際撈取到該地點的歷史實際清運動態（包含實際到站時間戳記、執勤車號/車牌、實際收運記錄）。嚴禁僅憑靜態公告或推估座標直接宣告成功。
2. **驗證演算法相容**：建立測試套件驗證自適應地理圍欄、進場方位角、班表時間窗與車速過濾。
3. **產出驗證記錄**：在 `docs/reports/` 留下包含真實歷史數據佐證的地點報告。

詳細規範請參閱 [.agents/rules/location-verification.md](.agents/rules/location-verification.md)。
