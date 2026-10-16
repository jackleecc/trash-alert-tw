# 開發流程、派工與交付規則

## 適用範圍與階段

新功能設計或既有功能修改須依序完成：Phase 1 需求訪談（`grill-with-docs`）、Phase 2 架構決策（模組職責、介面契約、ADR、領域字典、Milestone）、Phase 3 OpenSpec（proposal、specs、design、tasks、依賴與可執行驗收標準）、Phase 4 TDD Red／Green、Phase 5A Standards＋Spec 雙軸審查、Phase 5B 修正、回歸、規格同步與 archive。Phase 1–3 可由主代理執行或高階委派；派發表中的模型與 effort 是子代理選擇。主代理維持初始模型與 effort。

| 階段／工作 | Gemini 子代理 | GPT 子代理 | Effort | 派發要求 |
|---|---|---|---|---|
| Phase 1 需求訪談 | `flash` | `gpt-6.1-sol` | High | 需求、範圍、邊界、待決問題 |
| Phase 2 架構決策 | `flash` | `gpt-6.1-sol` | High | 模組職責、契約、ADR、領域字典、Milestone |
| Phase 3 OpenSpec | `flash` | `gpt-6.1-sol` | High | proposal、specs、design、tasks、依賴、驗收 |
| Phase 4 TDD Red | `flash` | `gpt-6-luna` | Medium | 附 Ticket 規格與驗收情境；確認真實業務 assertion 失敗 |
| Phase 4 新邏輯 Green | `flash` | `gpt-6-luna` | Medium | 必附完整測試檔及真實失敗原文 |
| Phase 4 機械 Green | `flash_lite` | `gpt-6-luna` | Low | 必附完整測試檔及真實失敗原文 |
| Phase 5A 正式審查 | `flash` 雙代理 | `gpt-6.1-sol` 雙代理 | High | 附固定 Git 基準、差異與規格 |
| Phase 5B 交付收尾 | `flash` | `gpt-6-luna` | Medium | 修正若影響審查結論，重跑 5A |
| 中途重大問題分析 | `flash` | `gpt-6.1-sol` | High | 僅符合下述升階例外；分析後回 Medium |
| 獨立 Git 作業 | `flash_lite` | `gpt-6-luna` | Low | 所有 Git 查詢、diff/log、暫存、commit、push、branch、merge/rebase 均依 AGENTS.md 委派 |

全域禁用 `pro`。主代理維持初始高階模型，負責全域狀態、HANDOVER、Phase 1–3 對齊、派工與驗收，不切換模型或 effort、不建立 worktree，也不直接執行 Git 命令；Git 工作由指定 Low 子代理完成。已授權的動作直接執行；push、歷史改寫與破壞性操作須有使用者明示授權。

## 開工與升階門檻

派發每張施工 Ticket 前，核對 proposal、specs、design、tasks、ADR、前置 Ticket 完成證據與可執行驗收標準。規格未定、契約模糊、架構需重決策或依賴未完成時停止施工，回 Phase 2／3 補齊；不得以 High 代替規格工作。

Phase 1–3 依派工表固定使用 High；Phase 5A 正式雙軸審查也固定使用 High。以下升階限制適用於 Phase 4／5B：High Effort 僅有兩種情況，Phase 5A 正式雙軸審查，或 Phase 4／5B 實作在 Low／Medium 下已實際失敗一次。後者不包括預期 TDD Red、語法錯誤或 import 錯誤。升 High 的派發與交接必須記錄具體原因、前次失敗原文及分析。子代理遇阻、失敗或能力受限時回報主代理，不自行升階、不假稱完成、不再派發；是否升階或重派由主代理裁決。

TDD Red 必須是業務 assertion 的真失敗。Green 派工須附測試全文和失敗原文。若任務性質不清，先停止並釐清規格，不得自行以 High 開工。

## 完成條件與交接

只有全部 tasks、必要測試、雙軸審查及規格 archive 完成後才能宣告交付；無法執行的驗收明確標為「待驗收」。每張 Ticket 與階段完成後更新 OpenSpec `tasks.md` 和根目錄 `HANDOVER.md`；若 `.scratch/zoo-escape-roguelike/HANDOVER.md` 已存在，也同步更新，不得為此新建該檔。新對話先讀 AGENTS.md、HANDOVER.md 與目標 OpenSpec（若存在）。HANDOVER 僅留最新快照；前次任務驗收完成後清除舊章節，歷史交由 Git 與 archive 保留。快照須包含：目前／目標 Phase、change／Ticket／Milestone、已確認規格版本、依賴與阻礙、完成與待辦 Checklist、測試／驗收／審查證據、子代理模型／effort、下一步。
