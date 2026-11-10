# Handover Snapshot

- **Latest Change**: `early-upstream-corridor-alerts`（已歸檔於 `openspec/changes/archive/2026-11-10-early-upstream-corridor-alerts/`，主規格已同步至 `openspec/specs/collection-approach-confirmation/spec.md` 與 `openspec/specs/tainan-relay-early-notification/spec.md`；ADR：`docs/adr/0013-early-upstream-corridor-approach.md`）。
- **Verification Status**: `npm test` `319/319` 通過（無網路測試）；PGlite 0.5.11 `12/12` 項 SQL 檢查通過；`openspec validate --all --strict` 通過；Phase 5A/5B Standards 與 Spec 雙軸審查於 `review-02.diff` 皆達 0 未解、0 新增（報告：`docs/reports/early-upstream-corridor-alerts-2026-11-10.md`）。
- **Database State**: Supabase `public.stops` 楊梅 `lagi2-006_2_21` 已完成校準（`id=31` `大平街246號(右邊)` `17:10:00`、`id=8` `中山南路100號` `17:14:00`、保留 `id=9` `楊梅區中山南路146號` `17:15:00`、`id=10` `中山南路336巷口` `17:27:00`）；現有活躍訂閱 `id=14` 維持綁定 Stop `9`。
- **Pending Production Ops**: 本機無 PostgreSQL DDL 權限。**部署新版 Cloud Run 前，維運必須先於 Supabase Dashboard SQL Editor 執行 `supabase/update_collection_approach_corridor.sql`**，使 `commit_collection_approach` RPC 支援多站點驗證；尚未執行前楊梅 Stop `9` 將安全失敗關閉並維持 `pending`。
- **Safety Invariant**: 本變更驗證及資料同步全程未呼叫真實 LINE Messaging API，未消耗月配額；正式上線實車時段請依 `docs/collection-approach-confirmation.md` 觀察實際 `collection_approach_events`。
