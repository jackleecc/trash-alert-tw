# 專案規則：強制開發流程與階層降檔政策 (Mandatory Development Workflow & Tiering Policy)

## 核心準則 (Core Mandate)

> **凡有「新功能設計」或「原有功能修改」，務必嚴格依序使用三組技能：`grill-with-docs` ➔ `tdd` ➔ `code-review`。**
> **除了使用者明示「不需要隔離環境 (worktree)」外，各階段的 Model 選擇與 Effort 降檔必須嚴格遵循附檔政策。**

---

## 流程概覽 (Sequential Pipeline)

```
[Phase 1 & 2: grill-with-docs] ──(規格與架構確立)──> [Phase 4: tdd] ──(Red-Green-Refactor)──> [Phase 5: code-review]
       (強制 High / Pro)                               (分層降檔 Low-Medium)                        (雙軸審查 High / Pro)
```
*(註：原 Phase 3 隔離環境 worktree 依使用者要求免除，直接在現有環境執行)*

---

## 核心規則 1：跨階段 Model / Effort 政策 (硬性規定)

| 階段 | 任務內容 / Skill | Model (Antigravity 對應) | Effort / 級別 | 規範備註 |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 1** | **發想與深度訪談 (`grill-with-docs`)** | 最高階 (`pro`) | **強制 High 或以上** | 省不得，透過無情盤問對齊需求與邊界 |
| **Phase 2** | **寫 Spec / ADR / 領域詞彙** | 最高階 (`pro`) | **強制 High 或以上** | 省不得，確立架構設計與完整規格 |
| **Phase 3** | 隔離環境 (worktree) | - | - | **依指示免除，不需建立 worktree** |
| **Phase 4** | **實作委派 (`tdd` / subagent 施工)** | `flash_lite` 或 `flash` | **必須低於 High (low / medium)** | 嚴格依任務性質分層降檔 (見核心規則 2) |
| **Phase 5** | **審查 (`code-review`)** | `flash` 或 `pro` | **High (唯二例外之一)** | 雙軸審查為高階推理判斷，天生需要高階思考 |
| **Phase 6+**| **收尾 / 歸檔 / 清理測試資料** | `flash_lite` | **Low** | 機械性清理與整理 |

---

## 核心規則 2：Phase 4 實作委派——依任務性質分層降檔

在 `tdd` 與實作階段，委派任務至 subagent 或執行時，依性質精確分層：

| 層級 | 判準 (舉例) | Model (Antigravity) | Effort |
| :--- | :--- | :--- | :--- |
| **機械 (Mechanical)** | 照樣板改、批次替換、純接線 (wiring)、參數補齊 | `flash_lite` | low |
| **新邏輯 (New Logic)** | 設計新演算法、模組串接 (API/DB schema)、狀態機、代碼生成腳本 | `flash` | medium |
| **TDD Red (寫失敗測試)** | 任何 task 的測試，不論該 task 屬於哪一層 | `flash` | medium |

### 降檔執行細則：
1. **未定預設原則**：不確定該任務屬於哪一層 ➔ **先用 `flash_lite` (low)**；該 task 錯一次才升級到 `flash` (medium)（**嚴禁一開始就上高階模型**）。
2. **測試 (TDD Red) 獨立 medium 的原因**：
   - 測試即規格——斷言若寫得太鬆或測錯對象會直接通過（假綠）。若採取「錯一次才升級」將永遠無法觸發升檔，導致錯誤靜默通過。因此撰寫測試一律至少使用 medium (`flash`)。
3. **Green 階段 (實作) 降檔至 `flash_lite` 的兩道必經手續**：
   實作代碼可依表降至 `flash_lite` (low)，但必須通過以下兩道檢驗：
   - **手續 ① 確認 Red 是真失敗**：失敗訊息必須明確指向被測邏輯的 assertion（例如斷言值不符），絕不可以是 import 失敗、模組遺失、語法錯誤或測試收集錯誤。
   - **手續 ② 完整交接上下文**：委派給 green 的 subagent 時，必須提供「測試檔全文 + 失敗訊息原文」，嚴禁只給口頭任務摘要——否則 subagent 需多耗費一輪探索，抵銷降級所節省的 token。

---

## 核心規則 3：只有兩個例外可以升到 High Effort

在整個施工過程中，**僅有以下兩種情況允許使用 High Effort**：

* **例外 1：Phase 5 `code-review`**
  - Standards（專案規範與 12 種壞味道）+ Spec（需求規格與邊界覆蓋）雙軸審查本質上是判斷與推理工作，並非機械施工，天生需要高階推理能力。
* **例外 2：Phase 4 某 task 在 low/medium 下已實際失敗一次**
  - 條件：測試持續報紅、實作方向跑偏、或 subagent 明確回報無法解決 ➔ 才准升級至 High (`pro`)。
  - 溯源義務：一旦升級，必須在該 task 的回報紀錄中清晰註明：**「升 High 的具體原因 + 前次失敗證據（包含錯誤訊息與分析）」**，嚴禁憑感覺升檔。

### ⛔ 嚴格禁令（以下說法一律『不算』例外，禁止升檔）：
- ❌ *「這 task 看起來很難」*
- ❌ *「模組之間怎麼串接應該想深一點」*

> **關鍵原則**：遇到上述疑慮，代表 **Phase 2 的 Spec 根本沒有寫清楚**！
> 正確做法是**退回 Phase 2 補全 Spec 與介面契約**，而不是在施工階段拿 High Effort 硬幹補救！
