-- Apply this migration once to an existing Supabase project.
-- It does not delete existing routes, stops, subscriptions, or logs.

ALTER TABLE public.routes
    DROP CONSTRAINT IF EXISTS routes_active_days_valid;

ALTER TABLE public.routes
    ADD CONSTRAINT routes_active_days_valid CHECK (
        cardinality(active_days) > 0
        AND array_position(active_days, NULL) IS NULL
        AND active_days <@ ARRAY[1,2,3,4,5,6,7]
    );

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

CREATE OR REPLACE FUNCTION public.reserve_quota(p_month VARCHAR(7))
RETURNS TABLE (reserved BOOLEAN, used_count INTEGER, newly_melted BOOLEAN)
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO public.system_quota (month, used_count, is_melted)
    VALUES (p_month, 0, FALSE)
    ON CONFLICT (month) DO NOTHING;

    RETURN QUERY
    WITH updated AS (
        UPDATE public.system_quota
        SET used_count = used_count + 1,
            is_melted = used_count + 1 >= 195
        WHERE month = p_month
          AND used_count < 195
        RETURNING used_count
    )
    SELECT TRUE, updated.used_count, updated.used_count = 195
    FROM updated;

    IF NOT FOUND THEN
        RETURN QUERY
        SELECT FALSE, quota.used_count, FALSE
        FROM public.system_quota AS quota
        WHERE quota.month = p_month;
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
