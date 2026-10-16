# Project Guidelines & Rules

## Mandatory Location Onboarding Rule (新地點加入驗證標準)

> **日後任何新地點加入，務必先確認撈得到該地點的歷史實際清運資料，才算真正加入地點成功。**

### 執行要點：
1. **先確認歷史實績**：在宣稱加入新站點或建立訂閱前，必須先透過 API 或外部端點實際撈取到該地點的歷史實際清運動態（包含實際到站時間戳記、執勤車號/車牌、實際收運記錄）。嚴禁僅憑靜態公告或推估座標直接宣告成功。
2. **驗證演算法相容**：建立測試套件驗證自適應地理圍欄、進場方位角、班表時間窗與車速過濾。
3. **產出驗證記錄**：在 `docs/reports/` 留下包含真實歷史數據佐證的地點報告。

詳細規範請參閱 [.agents/rules/location-verification.md](.agents/rules/location-verification.md)。

# Project Guidelines & Rules

## 1. Git 作業規範
 
- **直接使用最輕量級模型**：所有 Git 查詢、diff/log、暫存、commit、push、branch、merge/rebase 等版本控制作業，一律直接由最輕量級模型執行或自動委派 Low 子代理（Gemini: `flash_lite` / Low；GPT: `gpt-6-luna` / Low），免除手動確認模型，亦不需載入或讀取 `git-ops` 技能。
- ⛔ **Orchestrator Git 執行禁令**：主對話模型（Orchestrator）**嚴禁直接執行任何 `git` 相關命令**。凡在主對話中遇到或需要執行任何 Git 操作（包含 git status/diff/add/commit/push/pull 等），主對話必須一律調用 `invoke_subagent` 委派 `flash_lite`（Low）子代理執行，待子代理完成並回報後由主對話接續。
- **權限邊界**：已授權動作直接執行；未經使用者明示授權，嚴禁 push、改寫歷史、刪除或破壞性操作。

## 2. 開發流程與 Subagent 分層派工

- **Orchestrator 模式**：主對話全程維持初始高階模型（負責全域狀態、`HANDOVER.md`、Phase 1–3 對齊、派工與驗收），**不在主對話中途切換模型／effort**，亦不暫停要求使用者手動切換或確認。所有工作直接在現有環境執行，不建立 worktree。
- ⛔ **全域模型禁令**：所有階段、主對話、子代理與升檔例外，**一律禁止使用 `pro` 模型**。

| 階段 / 工作類型 | 工作與交付物 | Gemini 子代理 | GPT 子代理 | Effort | 派發規範 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Phase 1：需求訪談** | `grill-with-docs`；需求、範圍、邊界與待決問題 | `flash` | `gpt-6.1-sol` | High | 主對話執行或高階委派 |
| **Phase 2：架構決策** | 模組職責、介面契約、ADR、領域字典、Milestone | `flash` | `gpt-6.1-sol` | High | 主對話執行或高階委派 |
| **Phase 3：OpenSpec** | `proposal`、`specs`、`design`、`tasks`、依賴與驗收 | `flash` | `gpt-6.1-sol` | High | 主對話執行或高階委派 |
| **Phase 4：TDD Red** | 撰寫業務驗收測試，確認真業務 assertion 失敗 | `flash` | `gpt-6-luna` | Medium | 附 Ticket 規格與驗收情境 |
| **Phase 4：新邏輯 Green** | 新演算法、模組串接、狀態機、業務邏輯實作 | `flash` | `gpt-6-luna` | Medium | 必附測試檔全文＋失敗原文 |
| **Phase 4：機械 Green** | 照樣板改、批次替換、純接線、參數補齊 | `flash_lite` | `gpt-6-luna` | Low | 必附測試檔全文＋失敗原文 |
| **Phase 5A：正式審查** | `code-review` Standards＋Spec 雙軸平行審查 | `flash` (雙代理) | `gpt-6.1-sol` (雙代理) | High | 附固定 Git 基準、差異與規格 |
| **Phase 5B：交付收尾** | 依 findings 修正、回歸測試、同步規格、archive | `flash` | `gpt-6-luna` | Medium | 修正影響結論時重跑 5A |
| **中途重大問題分析** | 實作卡關排查、跨模組契約衝突分析 | `flash` | `gpt-6.1-sol` | High | 須符合下方例外 2，分析完回 Medium |
| **獨立 Git 作業** | Git 查詢、commit 訊息、暫存、提交等 | `flash_lite` | `gpt-6-luna` | Low | 直接使用最輕量級模型執行／委派 |

## 3. High Effort 限制、開工門檻與停下條件（Stop Criteria）

- **High Effort 唯二例外**：
  1. **Phase 5A `code-review`** 雙軸正式審查。
  2. **Phase 4 / 5B 實作在 Low／Medium 下已實際失敗一次**（測試持續報紅或方向跑偏，不含預期 TDD Red 或語法／import 錯誤）。派發與交接時必須記錄**「升 High 原因＋前次失敗原文與分析」**。
- **禁止自行升階與越權委派**：子代理（Subagent）遇阻、測試失敗或能力受限時，必須如實回報主代理，**嚴禁子代理自行升階、假裝已完成、或擅自再派發子代理**；所有升階與重派均由主代理依上述唯二例外裁決。
- **立即停下條件（When to Stop）**：
  - **開工前缺項即停**：派發每張 Ticket 前，必須核對 OpenSpec（`proposal`、`specs`、`design`、`tasks`、ADR）、前置 Ticket 完成證據與可執行驗收標準。若規格未定、契約模糊、架構需重決策或依賴未完成，**立即停止施工**，退回主對話 Phase 2／3 補齊規格或向使用者提問，禁止派發 High 硬幹。
  - **完成條件即停**：所有 tasks、測試、雙軸審查（詳見 [.agents/rules/code-review.md](.agents/rules/code-review.md)）與規格 archive（詳見 [.agents/rules/development-workflow.md](.agents/rules/development-workflow.md)）全數通過才可宣告完成；無法執行的驗收必須標記為「待驗收」。

## 4. 狀態追蹤與單態交接（HANDOVER）

- **進度維護**：每張 Ticket 與階段完成後，同步更新 OpenSpec `tasks.md`、根目錄 `HANDOVER.md`（及存在的 `.scratch/zoo-escape-roguelike/HANDOVER.md`）。新對話接手時先讀本檔、`HANDOVER.md` 與目標 OpenSpec 直接接續。
- **單態快照（Single-state Snapshot）**：`HANDOVER.md` 永遠只保留最新一次交接快照，前次任務驗收完成後即清除舊章節（歷史依賴 Git 與 archive）。
- **必填欄位**：目前／目標 Phase、change／Ticket／Milestone、已確認規格版本、依賴與阻礙、完成與待辦 Checklist、測試／驗收／審查證據、子代理模型／effort、下一步。

