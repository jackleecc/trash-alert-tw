-- ==============================================================================
-- 地點配置 SQL：新北市汐止區汐萬路一段333巷口
-- ==============================================================================

-- 1. 建立或更新汐止區清運路線 (週一、二、四、五、六 清運)
-- 官方線路編號 lineid: '221010' (新北市汐止區第1區路線 晚上)
INSERT INTO public.routes (id, name, active_days, description, is_active)
VALUES (
    '221010', 
    '汐止區第1區路線(晚上)', 
    '{1,2,4,5,6}', 
    '新北市汐止區拱北里汐萬路一段至三段清運路網', 
    true
)
ON CONFLICT (id) DO UPDATE 
SET name = EXCLUDED.name,
    active_days = EXCLUDED.active_days,
    description = EXCLUDED.description,
    is_active = true;

-- 2. 新增清運站點：汐萬路一段333巷口 (Lat: 25.076252, Lng: 121.649942)
-- 表定收運時間：19:56:00
INSERT INTO public.stops (route_id, name, lat, lng, order_index, schedule_time)
VALUES (
    '221010', 
    '汐萬路一段333巷口', 
    25.076252, 
    121.649942, 
    1, 
    '19:56:00'
)
ON CONFLICT DO NOTHING;

-- 3. 範例：若需要綁定 LINE 群組，請取消以下註解並替換為實際 group_id：
-- INSERT INTO public.line_groups (group_id, group_name, is_active)
-- VALUES ('C_YOUR_XIZHI_GROUP_ID', '汐止汐萬路垃圾車通知', true)
-- ON CONFLICT (group_id) DO UPDATE SET is_active = true;

-- INSERT INTO public.subscriptions (group_id, stop_id)
-- SELECT 'C_YOUR_XIZHI_GROUP_ID', id 
-- FROM public.stops 
-- WHERE route_id = '221010' AND name = '汐萬路一段333巷口'
-- ON CONFLICT DO NOTHING;
