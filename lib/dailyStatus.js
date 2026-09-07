/**
 * lib/dailyStatus.js
 * `daily_status` 資料表的 Lazy Load 快取邏輯。
 *
 * 規則：
 *   - 每日 17:00 第一次觸發時，查詢 DGPA 並將結果寫入 DB。
 *   - 17:01 之後，直接讀取 DB 快取，不再重複呼叫 DGPA。
 *   - 若 DB 查詢失敗，視為系統異常，對外拋出錯誤讓呼叫者決策。
 *
 * DB Schema (daily_status):
 *   date              DATE PRIMARY KEY
 *   is_suspended      BOOLEAN NOT NULL DEFAULT false   -- 舊欄位，保留向後相容
 *   suspended_cities  TEXT[] NOT NULL DEFAULT '{}'      -- 新欄位，停班停課縣市清單
 *   fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now()
 */

import { supabase } from './supabaseClient.js';
import { checkSuspendedCities } from './dgpa.js';

/**
 * 取得今日的停班停課縣市清單（Lazy Load）。
 *
 * @param {string} dateStr  格式 'YYYY-MM-DD'，由 getTaiwanNow() 提供
 * @returns {Promise<string[]>}  停班停課縣市名稱陣列（空陣列表示全部正常清運）
 */
export async function getTodaySuspendedCities(dateStr) {
  // ── Step 1: 嘗試從 DB 讀取快取 ─────────────────────────────────────────
  const { data: cached, error: selectError } = await supabase
    .from('daily_status')
    .select('*')
    .eq('date', dateStr)
    .maybeSingle();

  if (selectError) {
    throw new Error(
      `[daily_status] DB 讀取失敗（日期：${dateStr}）：${selectError.message}`
    );
  }

  // 快取命中：直接回傳 DB 結果
  if (cached !== null) {
    // 優先使用新欄位 suspended_cities；若為空或不存在，則退回 is_suspended 相容邏輯
    if (Array.isArray(cached.suspended_cities) && cached.suspended_cities.length > 0) {
      console.log(
        `[daily_status] 快取命中（${dateStr}）：suspended_cities=${JSON.stringify(cached.suspended_cities)}`
      );
      return cached.suspended_cities;
    }

    // 向後相容：如果 suspended_cities 為空但 is_suspended = true，
    // 代表是舊版寫入的紀錄，視為全部停收（安全起見）
    if (cached.is_suspended) {
      console.log(
        `[daily_status] 快取命中（${dateStr}，舊格式）：is_suspended=true（視為全部停收）`
      );
      return ['__ALL__'];
    }

    console.log(
      `[daily_status] 快取命中（${dateStr}）：正常清運`
    );
    return [];
  }

  // ── Step 2: 快取缺失 → 查詢 DGPA，並將結果寫入 DB ──────────────────────
  console.log(`[daily_status] 快取缺失（${dateStr}），向 DGPA 查詢...`);
  const suspendedCities = await checkSuspendedCities();

  const isSuspended = suspendedCities.length > 0;

  let { error: upsertError } = await supabase
    .from('daily_status')
    .upsert(
      {
        date: dateStr,
        is_suspended: isSuspended,
        suspended_cities: suspendedCities,
        fetched_at: new Date().toISOString(),
      },
      { onConflict: 'date' }
    );

  if (upsertError && (upsertError.message?.includes('suspended_cities') || upsertError.code === '42703')) {
    // 若 DB 尚未套用 migration，降級寫入基礎欄位以確保不中斷服務
    console.warn(`[daily_status] DB 尚無 suspended_cities 欄位，降級寫入基本欄位`);
    const fallback = await supabase
      .from('daily_status')
      .upsert(
        {
          date: dateStr,
          is_suspended: isSuspended,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: 'date' }
      );
    upsertError = fallback.error;
  }

  if (upsertError) {
    // 寫入失敗不阻斷當次運算，但記錄 warning
    console.warn(
      `[daily_status] DB 寫入失敗（${dateStr}）：${upsertError.message}`
    );
  } else {
    console.log(
      `[daily_status] 已寫入快取（${dateStr}）：suspended_cities=${JSON.stringify(suspendedCities)}`
    );
  }

  return suspendedCities;
}

/**
 * 保留向後相容的舊介面。
 * @param {string} dateStr
 * @returns {Promise<boolean>}  true = 有任何縣市停收
 * @deprecated 請改用 getTodaySuspendedCities()
 */
export async function getTodaySuspensionStatus(dateStr) {
  const cities = await getTodaySuspendedCities(dateStr);
  return cities.length > 0;
}
