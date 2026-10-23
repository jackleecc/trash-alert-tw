---
status: accepted
date: 2026-10-23
---

# ADR 0012: 汐止Stop 3以共享採樣軌跡確認進場

## Context

2026-10-22 19:45:20，647-BX距離19公尺通知與使用者觀察的路過未收運不符。離線已重現低速北上會被geoUtils豁免；當晚原始GPS未保留，無法斷言精確分支。ADR0007的完整21站拓撲仍必要，但其「100%阻斷」與實際低速／未知歷史行為不符，不作成功保證。正式Stop 3為路線221010的333巷口，前站為343巷口，法定南下約181.889度。

## Decision

僅在核心通知入口對route221010、stop.id3加入純進場狀態機與Supabase共享adapter。採可信GPS時間、100公尺前站anchor、343→333連續進場、180秒方向時效與120公尺目標圍欄；方向逆向優先於低速豁免，初次／未知／過期為待確認。前站可在目標圍欄外保存，允許第一次進目標圈便確認，避免強制兩輪小圍欄造成漏報。

共享狀態以台灣日期／路線／站點／車號隔離，CAS與逐次事件同transaction提交。資料庫、schema或衝突失效時保守待確認；不依賴process Map。既有純matcher只產生候選，受保護站點改用raw樣本，避免legacy衍生速度與方向干擾；其餘城市及站點維持原語意。原reported及可信GPS推算速度>25均拒絕。完整契約與界線見[design](../../openspec/changes/archive/2026-10-23-xizhi-arrival-confirmation/design.md)與[規格](../../openspec/specs/collection-approach-confirmation/spec.md)。

網站頂層TimeStamp僅為response，新鮮回應與連續座標變化皆不能證明逐車GPS新鮮度；本版不據此確認受保護站點，主／備切換不拼接時間與座標。僅confirmed進入既有dispatcher；pending/rejected不claim、不扣額度、不寫notification_logs、不啟動當日休眠。共同formatter改「車輛已接近站點」，取消未經估算的固定2～5分鐘。

## Alternatives

- 僅移動geoUtils低速if：仍保留首次觀測放行且跨實例失去方向，不採用。
- process Map保存軌跡：冷啟動與多實例不可靠，不採用。
- 一律要求圈內兩輪：1至2分鐘輪詢可能漏過，不採用。
- 全城市同時加嚴：來源與收運形態不同，超出已確認範圍，不採用。

## Consequences

多一次小型共享狀態讀寫換取可重播的判斷證據；嚴格採樣門檻可能延遲或漏報，且南下軌跡仍不能直接證明現場收運。交付僅SQL檔、程式、離線測試及審查；正式SQL套用、部署、跨實例RPC執行與實車freshness／latency待驗收。本次不花LINE額度驗證，也不新增地點或訂閱。
