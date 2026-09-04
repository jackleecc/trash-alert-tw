-- ==============================================================================
-- 地點配置 SQL：路竹區民有路55號
-- ==============================================================================

-- 1. 建立或更新路竹區清運路線 (週一、二、四、五、六)
INSERT INTO public.routes (id, name, active_days, description, is_active)
VALUES (
    'LZ01', 
    '路竹區北嶺線', 
    '{1,2,4,5,6}', 
    '路竹區北嶺里民有路、民權路及周邊清運路網', 
    true
)
ON CONFLICT (id) DO UPDATE 
SET name = EXCLUDED.name,
    active_days = EXCLUDED.active_days,
    is_active = true;

-- 2. 新增清運站點：路竹區民有路55號 (Lat: 22.822194, Lng: 120.270422)
INSERT INTO public.stops (route_id, name, lat, lng, order_index, schedule_time)
VALUES (
    'LZ01', 
    '路竹區民有路55號', 
    22.822194, 
    120.270422, 
    1, 
    '18:35:00'
)
ON CONFLICT DO NOTHING;

-- 3. 範例：若需要綁定 LINE 群組，取消以下註解並替換為實際 group_id：
-- INSERT INTO public.line_groups (group_id, group_name, is_active)
-- VALUES ('C_YOUR_GROUP_ID', '路竹民有路垃圾通知', true)
-- ON CONFLICT (group_id) DO UPDATE SET is_active = true;

-- INSERT INTO public.subscriptions (group_id, stop_id)
-- SELECT 'C_YOUR_GROUP_ID', id 
-- FROM public.stops 
-- WHERE route_id = 'LZ01' AND name = '路竹區民有路55號'
-- ON CONFLICT DO NOTHING;
