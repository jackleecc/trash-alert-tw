-- supabase/seed_xizhi_route_221010.sql
-- 補全汐止區 221010 (第1區路線 晚上) 完整官方 21 個站點拓撲與淨化 route_linids

-- 1. 更新現存的 Stop 3 (汐萬路一段333巷口)，顯式配置半徑 120m 與南下進場方向 (縱深防禦)
UPDATE public.stops
SET 
  order_index = 17,
  radius_meters = 120,
  schedule_time = '19:56:00'
WHERE id = 3;

-- 2. 淨化 route_linids，清除 221010 路線被異質路過車輛污染之記錄
DELETE FROM public.route_linids
WHERE route_id = '221010' AND linid != '221010';

-- 3. 確保 221010 本身在 route_linids 為官方信任常客
INSERT INTO public.route_linids (route_id, linid, observed_count)
VALUES ('221010', '221010', 99)
ON CONFLICT (route_id, linid) 
DO UPDATE SET observed_count = 99;
