-- ==============================================================================
-- 將配額熔斷門檻調整至 200 則 (全額使用完畢後熔斷)
-- 請在 Supabase SQL Editor 執行此語法
-- ==============================================================================

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
        is_melted = sq.used_count + 1 >= 200
    WHERE sq.month = p_month
      AND sq.used_count < 200
    RETURNING sq.used_count INTO v_used;

    IF FOUND THEN
        reserved := TRUE;
        used_count := v_used;
        newly_melted := (v_used = 200);
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
        is_melted = used_count - 1 >= 200
    WHERE month = p_month;
$$;
