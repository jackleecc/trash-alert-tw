# Handover Snapshot

- **Latest Change**: `fix-yangmei-corridor-entry-anchor`（已歸檔於 `openspec/changes/archive/2026-11-11-fix-yangmei-corridor-entry-anchor/`，主規格已同步至 `openspec/specs/collection-approach-confirmation/spec.md`；ADR：`docs/adr/0013-early-upstream-corridor-approach.md`）。
- **Verification Status**: `npm test` `322/322` 通過（無網路測試）；`openspec validate --all --strict` `3/3` 通過；Phase 5A/5B Standards 與 Spec 雙軸審查於 `review-02.diff` 皆達 0 未解、0 新增。
- **Database & RPC State**:
  - Supabase `public.stops` 楊梅 `lagi2-006_2_21` 已校準（`id=31` `大平街246號(右邊)` `17:10:00`、`id=8` `中山南路100號` `17:14:00`、`id=9` `楊梅區中山南路146號` `17:15:00`、`id=10` `中山南路336巷口` `17:27:00`）。
  - 正式區 Supabase 已於 2026-11-11 執行 `supabase/update_collection_approach_corridor.sql`，並經唯讀差動探測確認 `public.commit_collection_approach` RPC 已放行已登錄之 `('lagi2-006_2_21', '9')` 同時攔截未登錄站點。
- **Safety Invariant**: 本變更診斷與驗證全程未呼叫真實 LINE Messaging API，未消耗月配額。
