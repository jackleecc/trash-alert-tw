-- ==============================================================================
-- 資料庫綱要升級：支援 LINE 群組成員人數加權扣額與 200 則熔斷機制
-- ==============================================================================

-- 1. 在 line_groups 新增 member_count 欄位 (預設 1 人)
ALTER TABLE public.line_groups 
ADD COLUMN IF NOT EXISTS member_count INTEGER NOT NULL DEFAULT 1;

-- 2. 升級原子配額保留預存程序 reserve_quota (支援依群組人數加權扣除 p_amount)
DROP FUNCTION IF EXISTS public.reserve_quota(VARCHAR(50));
DROP FUNCTION IF EXISTS public.reserve_quota(VARCHAR(7));
DROP FUNCTION IF EXISTS public.reserve_quota(VARCHAR(50), INTEGER);

CREATE OR REPLACE FUNCTION public.reserve_quota(p_month VARCHAR(50), p_amount INTEGER DEFAULT 1)
RETURNS TABLE (reserved BOOLEAN, used_count INTEGER, newly_melted BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
    v_amount INTEGER := COALESCE(p_amount, 1);
    v_was_melted BOOLEAN := FALSE;
BEGIN
    INSERT INTO public.system_quota (month, used_count, is_melted)
    VALUES (p_month, 0, FALSE)
    ON CONFLICT (month) DO NOTHING;

    -- 查詢當前熔斷狀態
    SELECT sq.is_melted INTO v_was_melted
    FROM public.system_quota AS sq
    WHERE sq.month = p_month;

    -- 檢查剩餘額度是否足夠支付本次群組推播 (上限 200 則且當前未熔斷)
    UPDATE public.system_quota AS sq
    SET used_count = sq.used_count + v_amount,
        is_melted = (sq.used_count + v_amount >= 200)
    WHERE sq.month = p_month
      AND sq.is_melted = FALSE
      AND sq.used_count + v_amount <= 200;

    IF FOUND THEN
        SELECT TRUE, sq.used_count, (NOT v_was_melted AND sq.used_count >= 200)
        INTO reserved, used_count, newly_melted
        FROM public.system_quota AS sq
        WHERE sq.month = p_month;
        RETURN NEXT;
    ELSE
        -- 額度不足以扣除本次推播或已超過 200 則，觸發熔斷保護
        UPDATE public.system_quota AS sq
        SET is_melted = TRUE
        WHERE sq.month = p_month;

        SELECT FALSE, sq.used_count, (NOT v_was_melted)
        INTO reserved, used_count, newly_melted
        FROM public.system_quota AS sq
        WHERE sq.month = p_month;
        RETURN NEXT;
    END IF;
END;
$$;

-- 3. 升級原子配額釋放預存程序 release_quota_reservation (支援依群組人數加權釋放 p_amount)
DROP FUNCTION IF EXISTS public.release_quota_reservation(VARCHAR(50));
DROP FUNCTION IF EXISTS public.release_quota_reservation(VARCHAR(7));
DROP FUNCTION IF EXISTS public.release_quota_reservation(VARCHAR(50), INTEGER);

CREATE OR REPLACE FUNCTION public.release_quota_reservation(p_month VARCHAR(50), p_amount INTEGER DEFAULT 1)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_amount INTEGER := COALESCE(p_amount, 1);
BEGIN
    UPDATE public.system_quota
    SET used_count = GREATEST(0, used_count - v_amount),
        is_melted = (GREATEST(0, used_count - v_amount) >= 200)
    WHERE month = p_month;
END;
$$;
