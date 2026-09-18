# 專案規則：程式碼審查規範 (Mandatory Code Review Rule)

## 核心準則 (Core Mandate)

> **每次進行「新功能開發」或「原有功能修改」，在提交或宣告完成前，務必使用 code-review skill 對異動程式碼進行審查，確認程式碼品質符合標準且符合規格。**

---

## 適用情境 (Applicability)

1. **新功能開發 (New Feature Development)**：
   * 凡新增模組、API 端點、演算法、資料模型或 UI 元件。
2. **原有功能修改 (Existing Feature Modification)**：
   * 凡修改現有商業邏輯、重構程式碼、修正 Bug 或調整資料流架構。

---

## 審查雙軸標準 (Two-Axis Review)

執行 code-review 時，應確保雙軸皆通過檢驗：

### 1. Standards 軸（標準與壞味道）
* **專案規範遵循**：是否符合既有程式風格、型別定義、專案目錄結構與命名一致性。
* **Fowler 程式碼壞味道檢核 (Code Smells Baseline)**：
  * **Mysterious Name**（命名不清晰）
  * **Duplicated Code**（重複邏輯）
  * **Feature Envy**（過度存取其他物件資料）
  * **Data Clumps**（多個參數/欄位未封裝）
  * **Primitive Obsession**（未建立領域概念型別）
  * **Repeated Switches**（重複的條件分支）
  * **Shotgun Surgery**（修改迫使多處散落修改）
  * **Divergent Change**（單一模組因多種不相關原因被修改）
  * **Speculative Generality**（過度超前設計但當前無需使用）
  * **Message Chains**（過長的調用鏈）
  * **Middle Man**（過度轉發無實質邏輯的類別/方法）
  * **Refused Bequest**（未妥善繼承或違反介面契約）

### 2. Spec 軸（規格與需求一致性）
* **需求完整性**：使用者要求或規格書中定義的功能是否全數落地，無遺漏或半成品。
* **避免範圍蔓延 (No Scope Creep)**：異動範圍是否專注於目標需求，未引入非必要的附帶修改。
* **實作正確性**：實作邏輯是否忠實體現原始規格，無邏輯缺陷或預期外的副作用。

---

## 執行流程 (Workflow)

1. **鎖定比對基準點 (Pin Fixed Point)**：
   * 比對分支基準或前次乾淨提交點（如 git diff main...HEAD 或 git diff <commit>...HEAD）。
2. **啟動 code-review**：
   * 呼叫 code-review skill 啟動雙軸平行審查。
3. **處理審查意見 (Act on Findings)**：
   * 針對回報的 Standards 違規與 Spec 偏離立即修正。
4. **確認通過方可交付**：
   * 兩軸確認無阻礙問題後，方可進入測試與交付。
