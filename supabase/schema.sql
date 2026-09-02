-- ==============================================================================
-- 高雄市垃圾車 LINE 追蹤通知系統 (Trash Alert System)
-- Supabase PostgreSQL 初始化 DDL 綱要
-- ==============================================================================

-- 1. 路線表 (routes)
CREATE TABLE IF NOT EXISTS public.routes (
    id TEXT PRIMARY KEY,                       -- 路線代碼 (例如: 'R101')
    name TEXT NOT NULL,                        -- 路線名稱 (例如: '新興區清運A線')
    active_days INTEGER[] NOT NULL DEFAULT '{1,2,4,5,6}'
        CHECK (
            cardinality(active_days) > 0
            AND array_position(active_days, NULL) IS NULL
            AND active_days <@ ARRAY[1,2,3,4,5,6,7]
        ),
    description TEXT,                          -- 路線說明
    is_active BOOLEAN NOT NULL DEFAULT TRUE,   -- 是否啟用
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. 站點表 (stops)
CREATE TABLE IF NOT EXISTS public.stops (
    id SERIAL PRIMARY KEY,
    route_id TEXT NOT NULL REFERENCES public.routes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                        -- 站點名稱 (例如: '中正三路與復興一路口')
    lat DOUBLE PRECISION NOT NULL,             -- 站點緯度
    lng DOUBLE PRECISION NOT NULL,             -- 站點經度
    order_index INTEGER NOT NULL DEFAULT 1,    -- 順序索引 (用於前置站點檢核)
    schedule_time TIME,                        -- 表定時間 (例如: '17:30:00')
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stops_route_order ON public.stops(route_id, order_index);

-- 官方即時 API 的 linid 與本地路線的自動觀測對照。
CREATE TABLE IF NOT EXISTS public.route_linids (
    route_id TEXT NOT NULL REFERENCES public.routes(id) ON DELETE CASCADE,
    linid TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    observed_count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (route_id, linid)
);

CREATE OR REPLACE FUNCTION public.observe_route_linid(p_route_id TEXT, p_linid TEXT)
RETURNS VOID
LANGUAGE sql
AS $$
    INSERT INTO public.route_linids (route_id, linid)
    VALUES (p_route_id, p_linid)
    ON CONFLICT (route_id, linid) DO UPDATE
    SET last_seen_at = NOW(),
        observed_count = public.route_linids.observed_count + 1;
$$;

-- 3. LINE 群組表 (line_groups)
CREATE TABLE IF NOT EXISTS public.line_groups (
    id SERIAL PRIMARY KEY,
    group_id TEXT NOT NULL UNIQUE,             -- LINE Group ID (例如: 'C1234567890abcdef')
    group_name TEXT,                           -- 群組名稱備註
    is_active BOOLEAN NOT NULL DEFAULT TRUE,   -- 是否啟用通知
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. 訂閱關係表 (subscriptions)
CREATE TABLE IF NOT EXISTS public.subscriptions (
    id SERIAL PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES public.line_groups(group_id) ON DELETE CASCADE,
    stop_id INTEGER NOT NULL REFERENCES public.stops(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_group_stop UNIQUE (group_id, stop_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stop ON public.subscriptions(stop_id);

-- 5. 推播日誌表 (notification_logs)
CREATE TABLE IF NOT EXISTS public.notification_logs (
    id SERIAL PRIMARY KEY,
    group_id TEXT NOT NULL,                    -- LINE Group ID
    route_id TEXT NOT NULL,                    -- 路線代碼
    stop_id INTEGER NOT NULL REFERENCES public.stops(id) ON DELETE CASCADE, -- 站點代碼 (INTEGER)
    car_id TEXT,                               -- 觸發車號
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW() -- 發送時間
);

-- 30 分鐘防洗版冷卻查詢索引
CREATE INDEX IF NOT EXISTS idx_notification_logs_cooldown 
ON public.notification_logs(group_id, route_id, stop_id, sent_at DESC);

-- 原子取得通知權：避免重疊的 Cron 在冷卻檢查後重複發送。
CREATE OR REPLACE FUNCTION public.claim_notification(
    p_group_id TEXT,
    p_route_id TEXT,
    p_stop_id INTEGER,
    p_car_id TEXT,
    p_cooldown_minutes INTEGER DEFAULT 30
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
    claimed_log_id BIGINT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(
        concat_ws(':', p_group_id, p_route_id, p_stop_id), 0
    ));

    IF EXISTS (
        SELECT 1
        FROM public.notification_logs
        WHERE group_id = p_group_id
          AND route_id = p_route_id
          AND stop_id = p_stop_id
          AND sent_at >= NOW() - make_interval(mins => p_cooldown_minutes)
    ) THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.notification_logs (group_id, route_id, stop_id, car_id)
    VALUES (p_group_id, p_route_id, p_stop_id, p_car_id)
    RETURNING id INTO claimed_log_id;

    RETURN claimed_log_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_notification_claim(p_log_id BIGINT)
RETURNS VOID
LANGUAGE sql
AS $$
    DELETE FROM public.notification_logs WHERE id = p_log_id;
$$;

-- 6. 每月配額表 (system_quota)
CREATE TABLE IF NOT EXISTS public.system_quota (
    month VARCHAR(7) PRIMARY KEY,              -- 格式: 'YYYY-MM' (例如: '2026-09')
    used_count INTEGER NOT NULL DEFAULT 0,     -- 當月已發送則數
    is_melted BOOLEAN NOT NULL DEFAULT FALSE   -- 熔斷旗標 (達到 195 則觸發)
);

-- 原子保留一則 LINE 額度；回傳是否保留成功、使用量與是否剛觸發熔斷。
CREATE OR REPLACE FUNCTION public.reserve_quota(p_month VARCHAR(7))
RETURNS TABLE (reserved BOOLEAN, used_count INTEGER, newly_melted BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
    v_used INTEGER;
BEGIN
    INSERT INTO public.system_quota (month, used_count, is_melted)
    VALUES (p_month, 0, FALSE)
    ON CONFLICT (month) DO NOTHING;

    UPDATE public.system_quota AS sq
    SET used_count = sq.used_count + 1,
        is_melted = sq.used_count + 1 >= 195
    WHERE sq.month = p_month
      AND sq.used_count < 195
    RETURNING sq.used_count INTO v_used;

    IF FOUND THEN
        reserved := TRUE;
        used_count := v_used;
        newly_melted := (v_used = 195);
        RETURN NEXT;
    ELSE
        SELECT FALSE, sq.used_count, FALSE
        INTO reserved, used_count, newly_melted
        FROM public.system_quota AS sq
        WHERE sq.month = p_month;
        RETURN NEXT;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_quota_reservation(p_month VARCHAR(7))
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE public.system_quota
    SET used_count = GREATEST(used_count - 1, 0),
        is_melted = used_count - 1 >= 195
    WHERE month = p_month;
$$;

-- 7. 每日狀態快取與鎖定表 (daily_status)
CREATE TABLE IF NOT EXISTS public.daily_status (
    date DATE PRIMARY KEY,                     -- 格式: 'YYYY-MM-DD'
    is_suspended BOOLEAN NOT NULL DEFAULT FALSE, -- 是否天災停收
    api_fail_count INTEGER NOT NULL DEFAULT 0, -- 連續失敗次數 (上限 3 次)
    is_paused BOOLEAN NOT NULL DEFAULT FALSE,  -- 是否已暫停當日檢核
    last_api_error TEXT,                       -- 最後錯誤原因
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 初始當月配額
INSERT INTO public.system_quota (month, used_count, is_melted)
VALUES (TO_CHAR(NOW() AT TIME ZONE 'Asia/Taipei', 'YYYY-MM'), 0, FALSE)
ON CONFLICT (month) DO NOTHING;
