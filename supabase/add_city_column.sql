-- migration: 為 routes 表補齊 city 欄位 (FIX-12)
ALTER TABLE public.routes ADD COLUMN IF NOT EXISTS city TEXT;
COMMENT ON COLUMN public.routes.city IS '路線歸屬縣市 (例如: 高雄市、新北市、桃園市、台南市)';
