-- ==============================================================================
-- 資料庫綱要升級：支援多 LINE 官方帳號分流與獨立配額控制
-- ==============================================================================

-- 1. 擴充 system_quota.month 欄位長度至 VARCHAR(50)，允許儲存 'YYYY-MM' 與 'YYYY-MM:channelId'
ALTER TABLE public.system_quota ALTER COLUMN month TYPE VARCHAR(50);

-- 2. 更新原子配額保留預存程序 reserve_quota (支援最長 50 字元之月度與頻道複合鍵)
CREATE OR REPLACE FUNCTION public.reserve_quota(p_month VARCHAR(50))
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

-- 3. 更新原子配額釋放預存程序 release_quota_reservation
CREATE OR REPLACE FUNCTION public.release_quota_reservation(p_month VARCHAR(50))
RETURNS VOID
LANGUAGE sql
AS $$
    UPDATE public.system_quota
    SET used_count = GREATEST(used_count - 1, 0),
        is_melted = used_count - 1 >= 200
    WHERE month = p_month;
$$;

-- 4. 在 line_groups 新增 channel_id 欄位 (預設 'default')
ALTER TABLE public.line_groups 
ADD COLUMN IF NOT EXISTS channel_id VARCHAR(30) DEFAULT 'default';

-- 5. 將現有桃園楊梅清運群組標註為 taoyuan 頻道
UPDATE public.line_groups 
SET channel_id = 'taoyuan' 
WHERE group_id = 'Cbc0aef28eb6226fafe1ea7e5a6e4487e';

-- 6. 初始化桃園本月份配額
INSERT INTO public.system_quota (month, used_count, is_melted)
VALUES (concat(TO_CHAR(NOW() AT TIME ZONE 'Asia/Taipei', 'YYYY-MM'), ':taoyuan'), 0, FALSE)
ON CONFLICT (month) DO NOTHING;
