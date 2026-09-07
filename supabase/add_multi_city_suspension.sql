-- ==============================================================================
-- Migration: 支援多縣市停班停課檢查
-- 為 routes 新增 city 欄位，為 daily_status 新增 suspended_cities 欄位
-- ==============================================================================

-- 1. routes 新增 city 欄位（縣市歸屬）
ALTER TABLE public.routes ADD COLUMN IF NOT EXISTS city TEXT;

-- 填入現有路線的縣市
UPDATE public.routes SET city = '高雄市' WHERE id = 'LZ01' AND city IS NULL;
UPDATE public.routes SET city = '新北市' WHERE id = '221010' AND city IS NULL;

-- 2. daily_status 新增 suspended_cities 欄位（停班停課縣市清單）
ALTER TABLE public.daily_status ADD COLUMN IF NOT EXISTS suspended_cities TEXT[] NOT NULL DEFAULT '{}';
