-- ==============================================================================
-- 資料庫綱要升級：支援群組成員數加權配額扣抵 (reserve_quota 與 release_quota_reservation)
-- ==============================================================================

-- 1. 更新 reserve_quota 預存程序，新增 p_increment_by 參數 (預設 1)
CREATE OR REPLACE FUNCTION public.reserve_quota(
    p_month VARCHAR(50),
    p_increment_by INTEGER DEFAULT 1
)
RETURNS TABLE (reserved BOOLEAN, used_count INTEGER, newly_melted BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
    v_used INTEGER;
    v_inc INTEGER := COALESCE(p_increment_by, 1);
BEGIN
    INSERT INTO public.system_quota (month, used_count, is_melted)
    VALUES (p_month, 0, FALSE)
    ON CONFLICT (month) DO NOTHING;

    UPDATE public.system_quota AS sq
    SET used_count = sq.used_count + v_inc,
        is_melted = sq.used_count + v_inc >= 200
    WHERE sq.month = p_month
      AND sq.used_count + v_inc <= 200
    RETURNING sq.used_count INTO v_used;

    IF FOUND THEN
        reserved := TRUE;
        used_count := v_used;
        newly_melted := (v_used >= 200);
        RETURN NEXT;
    ELSE
        -- 若增量後超出上限，標記熔斷保護
        UPDATE public.system_quota AS sq
        SET is_melted = TRUE
        WHERE sq.month = p_month
          AND sq.used_count + v_inc >= 200;

        SELECT FALSE, sq.used_count, sq.is_melted
        INTO reserved, used_count, newly_melted
        FROM public.system_quota AS sq
        WHERE sq.month = p_month;
        RETURN NEXT;
    END IF;
END;
$$;

-- 2. 更新 release_quota_reservation 預存程序，新增 p_decrement_by 參數 (預設 1)
CREATE OR REPLACE FUNCTION public.release_quota_reservation(
    p_month VARCHAR(50),
    p_decrement_by INTEGER DEFAULT 1
)
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE public.system_quota
    SET used_count = GREATEST(used_count - COALESCE(p_decrement_by, 1), 0),
        is_melted = GREATEST(used_count - COALESCE(p_decrement_by, 1), 0) >= 200
    WHERE month = p_month;
$$;

-- 3. 校正 2026-10:taoyuan 當前數值至實際發送額度 (5 次 × 9 人 = 45)
UPDATE public.system_quota
SET used_count = 45,
    is_melted = FALSE
WHERE month = '2026-10:taoyuan';
