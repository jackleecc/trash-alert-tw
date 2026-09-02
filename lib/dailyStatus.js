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
 *   id           SERIAL PRIMARY KEY
 *   date         DATE NOT NULL UNIQUE  -- 'YYYY-MM-DD'
 *   is_suspended BOOLEAN NOT NULL DEFAULT false
 *   fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
 */

import { supabase } from './supabaseClient.js';
import { checkKaohsiungSuspension } from './dgpa.js';

/**
 * 取得今日的停收狀態（Lazy Load）。
 *
 * @param {string} dateStr  格式 'YYYY-MM-DD'，由 getTaiwanNow() 提供
 * @returns {Promise<boolean>}  true = 今日停收，false = 正常清運
 */
export async function getTodaySuspensionStatus(dateStr) {
  // ── Step 1: 嘗試從 DB 讀取快取 ─────────────────────────────────────────
  const { data: cached, error: selectError } = await supabase
    .from('daily_status')
    .select('is_suspended')
    .eq('date', dateStr)
    .maybeSingle();

  if (selectError) {
    throw new Error(
      `[daily_status] DB 讀取失敗（日期：${dateStr}）：${selectError.message}`
    );
  }

  // 快取命中：直接回傳 DB 結果
  if (cached !== null) {
    console.log(
      `[daily_status] 快取命中（${dateStr}）：is_suspended=${cached.is_suspended}`
    );
    return cached.is_suspended;
  }

  // ── Step 2: 快取缺失 → 查詢 DGPA，並將結果寫入 DB ──────────────────────
  console.log(`[daily_status] 快取缺失（${dateStr}），向 DGPA 查詢...`);
  const isSuspended = await checkKaohsiungSuspension(); // 若失敗，對外拋出錯誤

  const { error: upsertError } = await supabase
    .from('daily_status')
    .upsert(
      { date: dateStr, is_suspended: isSuspended, fetched_at: new Date().toISOString() },
      { onConflict: 'date' } // 如果同一天已有資料（例如重複插入），以 upsert 安全處理
    );

  if (upsertError) {
    // 寫入失敗不阻斷當次運算，但記錄 warning
    console.warn(
      `[daily_status] DB 寫入失敗（${dateStr}）：${upsertError.message}`
    );
  } else {
    console.log(
      `[daily_status] 已寫入快取（${dateStr}）：is_suspended=${isSuspended}`
    );
  }

  return isSuspended;
}
