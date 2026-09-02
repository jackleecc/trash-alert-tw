/**
 * lib/quotaService.js
 * LINE 訊息每月額度管理與全局配額熔斷 (Global Throttling)
 *
 * 規格：
 *   - 每月免費額度 200 則。
 *   - 當 used_count 達到 195 則 (MELT_THRESHOLD) 時，觸發 is_melted = true。
 *   - 熔斷時發出一次緊急告警，並強制攔截後續所有一般到站通知。
 */

import { supabase } from './supabaseClient.js';
import { broadcastLineAlert } from './lineClient.js';

export const MAX_MONTHLY_QUOTA = 200;
export const MELT_THRESHOLD = 195;

/**
 * 取得當前年月份字串 (YYYY-MM)
 * @param {Date} [twDate]
 * @returns {string}
 */
export function getYearMonth(twDate = new Date()) {
  const year = twDate.getUTCFullYear();
  const month = String(twDate.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * 查詢或初始化當月的 system_quota 資料表記錄
 * @param {string} yearMonth - 格式 'YYYY-MM'
 * @returns {Promise<{ month: string, used_count: number, is_melted: boolean }>}
 */
export async function getOrCreateQuotaRecord(yearMonth) {
  // 先以 month 查詢
  const { data, error } = await supabase
    .from('system_quota')
    .select('month, used_count, is_melted')
    .eq('month', yearMonth)
    .maybeSingle();

  if (!error && data) {
    return data;
  }

  // 若不存在則初始化當月記錄
  const newRecord = {
    month: yearMonth,
    used_count: 0,
    is_melted: false,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('system_quota')
    .upsert(newRecord, { onConflict: 'month' })
    .select('month, used_count, is_melted')
    .maybeSingle();

  if (insertErr) {
    console.error(`[Quota] 初始化 system_quota 失敗: ${insertErr.message}`);
    return { month: yearMonth, used_count: 0, is_melted: false };
  }

  return inserted || newRecord;
}

/**
 * 檢查目前配額是否允許發送通知。若達到 195 則但尚未標記熔斷，立即觸發熔斷並發送告警。
 *
 * @param {string} yearMonth - 格式 'YYYY-MM'
 * @returns {Promise<{ allowed: boolean, isMelted: boolean, usedCount: number }>}
 */
export async function checkQuotaStatus(yearMonth) {
  const quota = await getOrCreateQuotaRecord(yearMonth);
  const isOverThreshold = quota.used_count >= MELT_THRESHOLD;
  const isMelted = Boolean(quota.is_melted || isOverThreshold);

  if (isMelted) {
    // 若尚未在 DB 標記熔斷，執行熔斷升級並推播告警
    if (!quota.is_melted) {
      await supabase
        .from('system_quota')
        .update({
          is_melted: true,
        })
        .eq('month', yearMonth);

      const alertMsg = `🚨【系統配額熔斷警告】本月 LINE 推播使用量已達 ${quota.used_count} 則（熔斷門檻：${MELT_THRESHOLD} 則 / 上限：${MAX_MONTHLY_QUOTA} 則），系統已啟動熔斷保護，本月將暫停發送一般到站通知！`;
      console.warn(`[Quota] 觸發配額熔斷: ${alertMsg}`);
      await broadcastLineAlert(alertMsg);
    }

    return {
      allowed: false,
      isMelted: true,
      usedCount: quota.used_count,
    };
  }

  return {
    allowed: true,
    isMelted: false,
    usedCount: quota.used_count,
  };
}

/**
 * 增加配額使用量計數
 *
 * @param {string} yearMonth
 * @param {number} [incrementBy=1]
 * @returns {Promise<number>} 更新後的 used_count
 */
export async function consumeQuota(yearMonth, incrementBy = 1) {
  const current = await getOrCreateQuotaRecord(yearMonth);
  const newCount = current.used_count + incrementBy;
  const shouldMelt = newCount >= MELT_THRESHOLD;

  const { error } = await supabase
    .from('system_quota')
    .update({
      used_count: newCount,
      is_melted: shouldMelt,
    })
    .eq('month', yearMonth);

  if (error) {
    console.error(`[Quota] 更新配額失敗: ${error.message}`);
  }

  if (shouldMelt && !current.is_melted) {
    const alertMsg = `🚨【系統配額熔斷警告】本月 LINE 推播使用量已達 ${newCount} 則（熔斷門檻：${MELT_THRESHOLD} 則），系統已啟動熔斷保護！`;
    await broadcastLineAlert(alertMsg);
  }

  return newCount;
}

/**
 * 原子保留一則 LINE 推播額度，避免重疊 Cron 同時超過熔斷門檻。
 * @param {string} yearMonth
 * @returns {Promise<{ reserved: boolean, usedCount: number, newlyMelted: boolean }>}
 */
export async function reserveQuota(yearMonth) {
  const { data, error } = await supabase.rpc('reserve_quota', {
    p_month: yearMonth,
  });

  if (error || !data || data.length === 0) {
    if (error) {
      console.error(`[Quota] 保留額度失敗: ${error.message}`);
    }
    return { reserved: false, usedCount: 0, newlyMelted: false };
  }

  const result = data[0];
  const reservation = {
    reserved: Boolean(result.reserved),
    usedCount: Number(result.used_count),
    newlyMelted: Boolean(result.newly_melted),
  };

  if (reservation.newlyMelted) {
    const alertMsg = `🚨【系統配額熔斷警告】本月 LINE 推播使用量已達 ${reservation.usedCount} 則（熔斷門檻：${MELT_THRESHOLD} 則 / 上限：${MAX_MONTHLY_QUOTA} 則），系統已啟動熔斷保護！`;
    await broadcastLineAlert(alertMsg);
  }

  return reservation;
}

/**
 * LINE 發送失敗時釋放先前保留的一則額度。
 * @param {string} yearMonth
 * @returns {Promise<void>}
 */
export async function releaseQuotaReservation(yearMonth) {
  const { error } = await supabase.rpc('release_quota_reservation', {
    p_month: yearMonth,
  });

  if (error) {
    console.error(`[Quota] 釋放保留額度失敗: ${error.message}`);
  }
}
