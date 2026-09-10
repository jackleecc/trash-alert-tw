-- ==============================================================================
-- Migration: 新增自適應半徑 (radius_meters) 與進場方向 (approach_direction)
-- ==============================================================================

-- 1. 在 stops 資料表新增選用自訂半徑與進場方向欄位
ALTER TABLE public.stops 
ADD COLUMN IF NOT EXISTS radius_meters INTEGER DEFAULT NULL;

ALTER TABLE public.stops 
ADD COLUMN IF NOT EXISTS approach_direction TEXT DEFAULT NULL;

-- 2. 為高密度住宅區站點「汐萬路一段333巷口」(id: 3) 設定最優半徑與進場方向
--    • radius_meters = 120 (鄰站 343 巷口僅 153m，收縮至 120m 杜絕 171m 外隊部誤觸)
--    • approach_direction = 'southbound' (由北往南沿線收運，杜絕由南往北剛出庫車輛)
UPDATE public.stops
SET radius_meters = 120,
    approach_direction = 'southbound'
WHERE id = 3 OR name LIKE '%汐萬路一段333巷口%';

COMMENT ON COLUMN public.stops.radius_meters IS '站點自訂地理圍欄半徑（公尺）；若為 NULL 則由程式依前後相鄰站距自適應判定 (120m/150m/250m)';
COMMENT ON COLUMN public.stops.approach_direction IS '指定車輛進場方向（如 southbound 表由北往南收運，northbound 表由南往北）；為 NULL 則不限方向';
