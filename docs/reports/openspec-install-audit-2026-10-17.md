# OpenSpec 與專案 Skills 安裝稽核（2026-10-17）

## 結果

- 專案本機開發相依套件：`@fission-ai/openspec` **1.14.2**，精確鎖版於 `package.json` / `package-lock.json`；未安裝全域 CLI。
- `package.json` 提供 `npm run openspec -- <args>`，方便從專案使用鎖定版本。
- Node.js 驗證版本為 **v24.19.0**。OpenSpec 1.14.2 要求 Node.js **>=20.19.0**；專案應用程式仍宣告 `>=18.0.0`，所以 Node 18 執行應用程式不受此開發工具支援要求影響，但需 Node 20.19 以上才能執行 OpenSpec CLI。
- 官方 Codex 初始化產生 6 個核心 workflow skills：`openspec-propose`、`openspec-explore`、`openspec-apply-change`、`openspec-update-change`、`openspec-sync-specs`、`openspec-archive-change`。
- 官方 `spec-driven` schema 已設定；變更產物預設使用繁體中文，OpenSpec 結構標題與 SHALL/MUST 保留英文。
- OpenSpec 專案結構包含 `openspec/specs/`、`openspec/changes/`、`openspec/changes/archive/`。沒有建立或偽造任何已完成的 change。
- 這次安裝前後 `AGENTS.md` SHA-256 相同：`942439EEA2EF6679434B86EFFEF4D081FB8D7D85B7990DACA6169A50CDC001DA`。

## 專案範圍設定

`openspec/config.yaml` 註明這是 Trash Alert TW 專案，檢查時不得發送 LINE 通知、未經明確要求不得部署正式環境；專案詞彙沿用根目錄 `CONTEXT.md`，長期技術決策放在 `docs/adr/`。新收運地點仍須遵守 `AGENTS.md` 與 `.agents/rules/location-verification.md` 的歷史實際資料驗證要求。驗收條件與檢查要寫入 change，未執行的檢查標示待驗收。

## Skills 覆蓋

初始化前的 39 個專案 skills 均保留；其中 AGENTS.md 直接提到的 `grill-with-docs`、`code-review`、`domain-modeling`、`tdd`、`git-ops` 均有各自的 `SKILL.md`。`grill-with-docs` 明確呼叫的 `grilling` 與 `domain-modeling` 也已安裝；`ask-matt` 路由提及的 `grill-me`、`grilling` 及會使用 grilling 的 `triage`、`wayfinder`、`improve-codebase-architecture` 皆有對應技能目錄與 `SKILL.md`。Grilling、domain-modeling 所需的 `CONTEXT-FORMAT.md`、`ADR-FORMAT.md`、`AGENT-BRIEF.md` 等支援文件均存在。本次只新增上述 6 個官方 OpenSpec skills，共 45 個專案 skill 目錄。

已掃描 `.agents/skills/**/*.md` 的相對 Markdown 檔案連結。僅有四個指向範例情境的路徑不存在：`domain-modeling/CONTEXT-FORMAT.md` 中的三個示例 `src/*/CONTEXT.md`，以及 `setup-ts-deep-modules/SKILL.md` 中示例 `src/packages/README.md`。這些是說明用目錄範例，並非缺少的 skill 支援文件。OpenSpec 核心 workflow skills 的本地支援文件連結均可解析；它們互相呼叫的 proposal、apply、sync、archive workflow 均已安裝。

OpenSpec CLI 列出 6 個額外 workflow（`new`、`continue`、`ff`、`bulk-archive`、`verify`、`onboard`），但 AGENTS.md、既有 skills 與新產生的核心 skills 沒有依賴它們，因此本次未改動全域 profile，也未啟用額外 workflow。

## npm audit

已執行完整 `npm audit --json` 與 `npm audit --omit=dev --json`。完整樹有 5 個受影響套件項目（4 high、1 critical）；production-only 結果剩下 1 個 critical。完整 JSON、production-only JSON、人類可讀輸出與 dependency paths 原始記錄均保存在 `.scratch/openspec-install-audit/`。

- **新增的 OpenSpec 開發相依鏈（dev only）**：`@fission-ai/openspec@1.14.2` → `fast-glob@3.3.3` → `micromatch@4.0.8` → `braces@3.0.3`。npm 回報 **high**，advisory [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)，標題為 deeply nested patterns 可造成 stack-exhaustion denial of service。此一 advisory 在報表中分別計為 `braces`、`micromatch`、`fast-glob`、`@fission-ai/openspec` 四個受影響套件項目，並非四個不同 advisory。npm 沒有提供相容於目前鎖定 CLI 的修補；`fixAvailable` 指向 `@fission-ai/openspec@0.17.2`，屬 major downgrade。未降版或自動修補，以保留使用者要求的 1.14.2。
- **Production-only 的既有應用依賴鏈**：root `express@5.2.1` → `proxy-addr@2.0.7`。npm 回報 **critical**，advisory [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)，標題為 IPv4-mapped IPv6 trust subnet 可造成 IP spoofing；受影響範圍 `>=1.1.0 <2.0.8`。它來自本次安裝前已列在 package.json 的 Express runtime dependency，而非 OpenSpec；npm 顯示可透過 `npm audit fix` 修補。此次未執行修補，需另行處理既有 runtime 依賴弱點。

## 驗證與限制

- CLI 版本、schema 清單、空變更清單及 `validate --all --json` 已以專案安裝版本確認。當下沒有 change/spec，因此驗證結果只證明 CLI 與空結構可讀，不代表任何功能 change 已驗收。
- 上述 audit 的結果區分為 OpenSpec dev-only high advisory 與 Express runtime critical advisory；本次未執行自動修補。
- 本次沒有執行應用程式測試；安裝只加入開發 CLI 與文件設定，沒有修改應用程式程式碼。
