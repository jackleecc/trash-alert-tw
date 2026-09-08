-- ==============================================================================
-- 新增排程執行稽核記錄表 (execution_logs)
-- 用於追蹤每一次 /api/check-trucks 的觸發時間、來源、授權狀態與最近車輛距離
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.execution_logs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    taiwan_time TEXT NOT NULL,                         -- 格式: 'YYYY-MM-DD HH:mm:ss'
    trigger_source TEXT,                               -- 觸發來源 (例如: 'cron-job.org', 'vercel-cron', 'curl')
    status TEXT NOT NULL,                              -- 狀態: 'success', 'unauthorized', 'skipped', 'warning', 'error'
    reason TEXT,                                       -- 原因: 'notified', 'no-truck-in-geofence', 'outside-service-window', 'auth-failed', 等
    records_count INTEGER DEFAULT 0,                   -- 本次抓取到的車輛總數
    matched_arrivals INTEGER DEFAULT 0,                -- 進入 250m 站點數
    sent_notifications INTEGER DEFAULT 0,              -- 成功發送推播數
    details JSONB                                      -- 詳細資訊 (包含各站點最近車輛車牌、距離、經緯度、錯誤訊息等)
);

-- 依建立時間倒序查詢索引
CREATE INDEX IF NOT EXISTS idx_execution_logs_created_at 
ON public.execution_logs(created_at DESC);

-- 自動維護機制：保留最近 1000 筆或 7 天內記錄，防止資料庫膨脹
CREATE OR REPLACE FUNCTION public.cleanup_old_execution_logs()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM public.execution_logs
    WHERE created_at < NOW() - INTERVAL '7 days';
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_execution_logs ON public.execution_logs;
CREATE TRIGGER trg_cleanup_execution_logs
AFTER INSERT ON public.execution_logs
FOR EACH STATEMENT
EXECUTE FUNCTION public.cleanup_old_execution_logs();
