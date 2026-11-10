# 上游進場走廊提前通知實作與雙軸驗證報告（2026-11-10）

本報告記錄 OpenSpec 變更 `early-upstream-corridor-alerts` 之設計實作、資料庫校準實績、離線與 PGlite SQL 驗證證據、Standards ＋ Spec 雙軸審查結果，以及部署前維運必要操作。

> [!IMPORTANT]
> **部署 Cloud Run 前必行維運步驟（資料庫 DDL）**：
> 本機僅具備 Supabase Service Role REST 金鑰、不具 PostgreSQL DDL 權限。楊梅上游站點時間與座標已於本機完成校準寫入 `public.stops`，但更新版 `commit_collection_approach` SQL RPC 尚須由維運於 **Supabase Dashboard SQL Editor** 執行 [`supabase/update_collection_approach_corridor.sql`](../../supabase/update_collection_approach_corridor.sql) 後，再部署新版 Cloud Run 服務（未套用前楊梅 Stop 9 將安全失敗關閉並維持 `pending`，不致誤發或寫入垃圾狀態）。
>
> **安全宣告**：本次開發、測試與 Supabase 資料寫入全程未呼叫真實 LINE Messaging API，未消耗月配額亦未對群組推播測試訊息。

---

## 1. 變更摘要與路線物理邊界

| 站點 / 路線 | 調整重點 | 安全順向提早量與防護邏輯 |
| --- | --- | --- |
| **汐止 `221010` / Stop `3`**<br>（汐萬路一段333巷口，`19:56:00`） | 擴展為多段上游進場走廊（Approach Corridor）：<br>`Rank 14 37巷口 (19:44)` → `411號 (19:48)` → `343巷口 (19:52)` → `333巷口 (19:56)` | `deriveApproachCorridor` 於 `Rank 13 連峰街5巷` 大角度折返點自動切斷。實車每日 `19:43～19:47` 先北上通過 `333巷口`，直到 `19:48～19:49` 於 `37巷口` 折返南下時才建立錨點並確認推進（約提早 **4～6 分鐘**，不因北上路過誤報）。 |
| **楊梅 `lagi2-006_2_21` / Stop `9`**<br>（楊梅區中山南路146號，`17:15:00`） | 納入 `isProtectedCollectionStop` 保護與 `taoyuan-primary` GPS 採樣來源；校準上游站點 `大平街246號(右邊)`（`17:10:00`）與 `中山南路100號`（`17:14:00`）；維持 Stop 9 真實時間 `17:15:00` | 第 1 站 `大平街246號` 無更前一站仍可建立起站錨點，並針對 `大平街 → 中山南路100號` `435m` L 型街區轉彎將走廊橫向容許依段長放寬至 `196m`（上限 `200m`）；同時對 `120m` 以內之單點首次出現與逆向駛離維持阻斷（約提早 **4～6 分鐘**）。 |
| **台南 `70` / Stop `6`**<br>（永康區文化路40號） | [`api/tainan-relay.js`](../../api/tainan-relay.js) 配合「臺南環保通」App 提早 10 分鐘設定，文案更新為 `⏰ 預估抵達：約 10 分鐘內`，並支援同路線未訂閱上游站名自動導向唯一活躍訂閱站點 | 保留 `CRON_SECRET`、冷卻鎖與無關系統通知回傳 `404` 行為，實現 **10 分鐘內** 提早通知。 |
| **全域時間窗、逆向與動態 ETA** | `DEFAULT_SCHEDULE_BEFORE_MINUTES` 調整為 `25`（`isWithinScheduleWindow` 預設參數 `15` 維持不變）；`isMovingTowardsApproach` 位移 `>= 12m` 時停用低速豁免；`formatArrivalMessage` 支援 `computeApproachEtaText(distanceMeters)` 動態輸出 `⏰ 預估抵達：...` | 確保 17:00 服務時間窗無縫追蹤 17:15 楊梅站點、19:31 起追蹤 19:56 汐止站點；一般站點低速逆向（`>= 12m`）不再遭時速 `< 5 km/h` 豁免，且文案數學上絕不出現固定「2～5 分鐘」。 |

---

## 2. Supabase 楊梅站點資料庫校準實績

於授權下執行 `node scripts/applyYangmei.js` 並透過只讀查詢驗證 `public.stops`（`route_id = 'lagi2-006_2_21'`）：

| `stops.id` | 站點名稱 | `order_index` | `schedule_time` | 座標 (`lat`, `lng`) | 狀態 |
| --- | --- | --- | --- | --- | --- |
| `31` | `大平街246號(右邊)` | `1` | `17:10:00` | `24.910226, 121.140549` | 新增上游起站 |
| `8` | `中山南路100號` | `2` | `17:14:00` | `24.907498, 121.137464` | 由 `17:24:00` 校準為 `17:14:00`（修復負班表差） |
| `9` | `楊梅區中山南路146號` | `3` | `17:15:00` | `24.907648, 121.13654` | 保留原 `id=9` 與真實時間 `17:15:00`；原訂閱關聯 `subscriptions.id=14`（群組 `Cbc0aef28eb6226fafe1ea7e5a6e4487e`）完整維持 |
| `10` | `中山南路336巷口` | `4` | `17:27:00` | `24.906638, 121.13406` | 既有站點保留 |

---

## 3. 離線測試與隔離 SQL 驗證證據

以下均於最終程式碼修改完成後執行並觀測通過（預載 `test/helpers/denyNetwork.cjs` 封鎖真實網路）：

1. **全套離線單元／整合測試 (`npm test`)**：
   - 結果：**`319 / 319` 通過（0 失敗、0 略過、0 取消）**。
   - 證據檔：`.scratch/early-upstream-corridor-alerts/post-review1-test.output.txt`。
2. **隔離 PGlite SQL 驗證 (`scripts/verifyCollectionApproachSql.mjs`, PostgreSQL 18.6 / PGlite 0.5.11)**：
   - 結果：**`12 / 12` 項檢查全數通過**，涵蓋 migration 冪等重跑、狀態與事件同交易原子提交、版本競爭單一勝出與失敗回滾、`anon`／`authenticated` 禁用權限、`service_role` 只讀與 RPC 執行權、`search_path` 固定，以及 `lagi2-006_2_21` Stop `9` 成功提交且未登錄路線／站點遭拒。
   - 證據檔：`.scratch/early-upstream-corridor-alerts/post-review1-sql.output.txt`。
3. **OpenSpec 嚴格驗證**：
   - `npx openspec validate early-upstream-corridor-alerts --strict` 通過（`Change 'early-upstream-corridor-alerts' is valid`）。

---

## 4. 雙軸程式碼審查紀錄（固定基準：`d36089d8649e553360fa5112a565d32a8030a7e9`）

依 `.agents/rules/code-review.md` 與 `code-review` skill 採 Standards ＋ Spec 雙軸獨立審查，兩軸結論分列如下。

### Round 1（快照 `review-01.diff`，SHA256 `277127D6824E6D80ED6B7F9A5975953430DA2B66EC6E9FFAA089AEF1BBF9FC7D`）

#### Standards
- **Hard Violation（1 項）**：`lib/collectionApproach.js` 區域變數 `toStation` 違反 [`CONTEXT.md`](../../CONTEXT.md) 核心術語 `Stop` 之禁用詞規範（`_Avoid_: Station`）。
- **Baseline Code Smells（3 項）與正確性建議（1 項）**：
  - `lib/collectionApproach.js` 兩處重複建構 `base.anchor` 物件（Duplicated Code）。
  - `lib/collectionApproach.js` 重複計算 `(to - from + 1440) % 1440` 時差（Duplicated Code）。
  - `evaluateCollectionApproach` 與 `observeCollectionApproach` 重複呼叫 `deriveApproachCorridor`（冗餘計算）。
  - `deriveApproachCorridor` 之 `.filter(...)` 缺少元素非空檢核（`Boolean(s)`）。
  - `test/geoUtils.test.js` 測試標題寫為 `displacement >= 10m`，與實際驗證 `< 12m` 邊界（`15.5m` 測試向量）不符（Mysterious Name）。
- SQL 安全與權限（`SECURITY DEFINER`、`search_path`、`REVOKE/GRANT`）審查通過。

#### Spec
- **Missing / Partial Requirements**：0 項。
- **Scope Creep**：0 項。
- **Wrong Logic**：0 項（汐止／楊梅走廊段落、196m L 型彎道橫向容許、`> 90°` 逆向鎖定、`outside_target`、`taoyuan-primary` GPS、`25` 分鐘窗、動態 ETA 避開 `2～5 分鐘`、`isMovingTowardsApproach` 12m 門檻、台南中繼文案與唯一訂閱導向、SQL RPC 動態驗證與楊梅 `17:15:00` 皆符合規格）。
- **Non-blocking Notes（2 項）**：`test/geoUtils.test.js` 測試名稱寫 `>= 10m`；`design.md` 早期草擬 `computeApproachEtaText({ distance, stop, corridorStops })` 簽章與實作 `computeApproachEtaText(distanceMeters)` 有字面落差。

### Phase 5B 修正與 Round 2 重審（快照 `review-02.diff`，SHA256 `7A52DF3E403EEB143963EA03A2B6DB8F241A0A03B652FCD99C84C711616C628A`）

已於 [`lib/collectionApproach.js`](../../lib/collectionApproach.js) 完成全數重構與規範修正（改名為 `toStop`、抽出 `createApproachAnchor` 與 `scheduleDiffMinutes`、`observeCollectionApproach` 單次推導 `resolvedCorridor`、補上 `Boolean(s)` 保護），更新 [`test/geoUtils.test.js`](../../test/geoUtils.test.js) 標題為 `displacement >= 12m`，並同步對齊 `design.md` 簽章與公式說明，重跑全數 319 項測試與 12 項 PGlite 檢查通過後執行第二輪雙軸重審：

#### Standards
- **未解決項目**：0 項。
- **新增問題**：0 項。
- **結論**：**PASS**。

#### Spec
- **未解決項目**：0 項。
- **新增問題**：0 項。
- **結論**：**PASS**。
