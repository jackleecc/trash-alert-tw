-- ==============================================================================
-- 新增氣象預報查詢狀態追蹤表 (weather_check_status)
-- 用於記錄各站點上次向 Open-Meteo 查詢時間與上次發送推播時間，
-- 以實現動態查詢冷卻機制：
-- 1. 查詢後若未通知：冷卻 3 小時
-- 2. 若發送通知：冷卻 6 小時
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.weather_check_status (
    stop_id INTEGER PRIMARY KEY REFERENCES public.stops(id) ON DELETE CASCADE,
    last_checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_notified_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.update_weather_check_status_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_weather_check_status ON public.weather_check_status;
CREATE TRIGGER trg_update_weather_check_status
BEFORE UPDATE ON public.weather_check_status
FOR EACH ROW
EXECUTE FUNCTION public.update_weather_check_status_timestamp();
