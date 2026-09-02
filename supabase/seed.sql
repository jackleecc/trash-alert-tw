-- ==============================================================================
-- 範例測試資料 (Sample Seed Data)
-- ==============================================================================

-- 1. 新增範例清運路線 (週一、二、四、五、六 清運)
INSERT INTO public.routes (id, name, active_days, description)
VALUES 
    ('R101', '新興區清運A線', '{1,2,4,5,6}', '新興區中正三路與七賢一路沿線'),
    ('R102', '苓雅區清運B線', '{1,2,4,5,6}', '苓雅區三多三路與成功一路沿線')
ON CONFLICT (id) DO NOTHING;

-- 2. 新增範例清運站點
INSERT INTO public.stops (route_id, name, lat, lng, order_index, schedule_time)
VALUES 
    ('R101', '中正三路與復興一路口', 22.6312, 120.3098, 1, '17:15:00'),
    ('R101', '七賢一路與林森一路口', 22.6358, 120.3065, 2, '17:35:00'),
    ('R102', '三多三路與中華四路口', 22.6142, 120.3015, 1, '17:20:00'),
    ('R102', '成功一路與新光路口', 22.6105, 120.3002, 2, '17:40:00')
ON CONFLICT DO NOTHING;

-- 3. 新增範例 LINE 群組 (請將 group_id 替換為實際群組 ID)
INSERT INTO public.line_groups (group_id, group_name)
VALUES 
    ('C_DEMO_GROUP_001', '社區垃圾通知群組')
ON CONFLICT (group_id) DO NOTHING;

-- 4. 綁定群組與站點訂閱
INSERT INTO public.subscriptions (group_id, stop_id)
SELECT 'C_DEMO_GROUP_001', id FROM public.stops WHERE route_id = 'R101' AND order_index = 1
ON CONFLICT DO NOTHING;
