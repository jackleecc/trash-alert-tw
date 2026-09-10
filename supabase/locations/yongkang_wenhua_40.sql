-- ==============================================================================
-- 地點配置 SQL：台南市永康區文化路40號
-- ==============================================================================

-- 1. 建立或更新永康區清運路線 (週一、二、四、六 清運；週三、五、日停收)
-- 官方路線編號 ROUTEID: '70' (永康區第70線)
INSERT INTO public.routes (id, name, city, active_days, description, is_active)
VALUES (
    '70', 
    '永康區第70線 (永康里/文化路)', 
    '台南市',
    '{1,2,4,6}', 
    '台南市永康區永康里、網寮里、西灣里文化路及周邊清運路網', 
    true
)
ON CONFLICT (id) DO UPDATE 
SET name = EXCLUDED.name,
    city = EXCLUDED.city,
    active_days = EXCLUDED.active_days,
    description = EXCLUDED.description,
    is_active = true;

-- 2. 新增清運站點（包含相鄰前置站點與後置站點以利自適應圍欄與進場方位角推導）
-- 前置站點：文化路128巷10號 (Lat: 23.016137, Lng: 120.257498) 表定 19:37:00
INSERT INTO public.stops (route_id, name, lat, lng, order_index, schedule_time)
VALUES (
    '70', 
    '文化路128巷10號', 
    23.016137, 
    120.257498, 
    78, 
    '19:37:00'
)
ON CONFLICT DO NOTHING;

-- 目標站點：永康區文化路40號 (近文化路36號清運點，Lat: 23.016963, Lng: 120.261576) 表定 19:42:00
INSERT INTO public.stops (route_id, name, lat, lng, order_index, schedule_time)
VALUES (
    '70', 
    '永康區文化路40號', 
    23.016963, 
    120.261576, 
    79, 
    '19:42:00'
)
ON CONFLICT DO NOTHING;

-- 後置站點：永忠路18號 (Lat: 23.017220, Lng: 120.260959) 表定 19:44:00
INSERT INTO public.stops (route_id, name, lat, lng, order_index, schedule_time)
VALUES (
    '70', 
    '永忠路18號', 
    23.017220, 
    120.260959, 
    80, 
    '19:44:00'
)
ON CONFLICT DO NOTHING;

-- 3. 綁定 LINE 群組 C6f0ecae71723b8aef86290448871e6fa
INSERT INTO public.line_groups (group_id, group_name, is_active)
VALUES ('C6f0ecae71723b8aef86290448871e6fa', '台南市/永康文化路_e6fa', true)
ON CONFLICT (group_id) DO UPDATE 
SET group_name = EXCLUDED.group_name,
    is_active = true;

-- 4. 建立群組對目標站點（永康區文化路40號）之專屬訂閱關聯
INSERT INTO public.subscriptions (group_id, stop_id)
SELECT 'C6f0ecae71723b8aef86290448871e6fa', id 
FROM public.stops 
WHERE route_id = '70' AND name = '永康區文化路40號'
ON CONFLICT (group_id, stop_id) DO NOTHING;
