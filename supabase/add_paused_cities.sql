-- ==============================================================================
-- Migration: 新增縣市級暫停名單 (paused_cities) 至 daily_status 資料表
-- ==============================================================================

ALTER TABLE public.daily_status
ADD COLUMN IF NOT EXISTS paused_cities TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.daily_status.paused_cities IS '當日因外部 API 連續失敗達 3 次而暫停檢核之縣市清單，避免單一縣市異常癱瘓全台其他正常縣市';
