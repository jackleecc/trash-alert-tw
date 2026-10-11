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
import { getTaiwanNow } from './timeUtils.js';
import { getQuotaMonthKey, CHANNEL_DEFAULT, getChannelCredentials } from './channelService.js';

export const MAX_MONTHLY_QUOTA = 200;
export const MELT_THRESHOLD = 200;

/**
 * 輔助函式：解析或格式化 quota key (支援 'YYYY-MM', 'YYYY-MM:taoyuan', 或 (yearMonth, channelId))
 * @param {string} yearMonth
 * @param {string} [channelId=CHANNEL_DEFAULT]
 * @returns {string}
 */
function resolveQuotaKey(yearMonth, channelId = CHANNEL_DEFAULT) {
  const baseMonth = yearMonth || getYearMonth();
  if (typeof baseMonth === 'string' && baseMonth.includes(':')) {
    return baseMonth;
  }
  return getQuotaMonthKey(baseMonth, channelId);
}

/**
 * 取得當前年月份字串 (YYYY-MM)，預設精準採用台灣時間 (UTC+8)
 * @param {Date} [twDate]
 * @returns {string}
 */
export function getYearMonth(twDate) {
  if (!twDate) {
    return getTaiwanNow().dateStr.slice(0, 7);
  }
  const d = twDate instanceof Date ? twDate : new Date(twDate);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * 查詢或初始化當月的 system_quota 資料表記錄
 * @param {string} yearMonth - 格式 'YYYY-MM' 或 quotaKey
 * @param {string} [channelId=CHANNEL_DEFAULT] - 頻道識別碼
 * @returns {Promise<{ month: string, used_count: number, is_melted: boolean }>}
 */
export async function getOrCreateQuotaRecord(yearMonth, channelId = CHANNEL_DEFAULT) {
  const monthKey = resolveQuotaKey(yearMonth, channelId);
  // 先以 month 查詢
  const { data, error } = await supabase
    .from('system_quota')
    .select('month, used_count, is_melted')
    .eq('month', monthKey)
    .maybeSingle();

  if (!error && data) {
    return data;
  }

  // 若不存在則初始化當月記錄
  const newRecord = {
    month: monthKey,
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
    return { month: monthKey, used_count: 0, is_melted: false };
  }

  return inserted || newRecord;
}

/**
 * 檢查目前配額是否允許發送通知。若達到 195 則但尚未標記熔斷，立即觸發熔斷並發送告警。
 *
 * @param {string} yearMonth - 格式 'YYYY-MM' 或 quotaKey
 * @param {string} [channelId=CHANNEL_DEFAULT] - 頻道識別碼
 * @returns {Promise<{ allowed: boolean, isMelted: boolean, usedCount: number }>}
 */
export async function checkQuotaStatus(yearMonth, channelId = CHANNEL_DEFAULT) {
  const monthKey = resolveQuotaKey(yearMonth, channelId);
  const quota = await getOrCreateQuotaRecord(monthKey);
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
        .eq('month', monthKey);

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
 * @param {string} [channelId=CHANNEL_DEFAULT]
 * @returns {Promise<number>} 更新後的 used_count
 */
export async function consumeQuota(yearMonth, incrementBy = 1, channelId = CHANNEL_DEFAULT) {
  const monthKey = resolveQuotaKey(yearMonth, channelId);
  const current = await getOrCreateQuotaRecord(monthKey);
  const newCount = current.used_count + incrementBy;
  const shouldMelt = newCount >= MELT_THRESHOLD;

  const { error } = await supabase
    .from('system_quota')
    .update({
      used_count: newCount,
      is_melted: shouldMelt,
    })
    .eq('month', monthKey);

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
 * 原子保留 LINE 推播額度，支援依據群組人數加權扣除，避免重疊 Cron 同時超過熔斷門檻。
 * @param {string} yearMonth
 * @param {number|string} [amount=1] - 扣除額度數量（群組人數），亦向下相容傳入 channelId
 * @param {string} [channelId=CHANNEL_DEFAULT]
 * @returns {Promise<{ reserved: boolean, usedCount: number, newlyMelted: boolean }>}
 */
export async function reserveQuota(yearMonth, channelIdOrAmount = CHANNEL_DEFAULT, incrementBy = 1) {
  let channelId = CHANNEL_DEFAULT;
  let inc = 1;
  const isThreeArg = arguments.length >= 3 || (typeof channelIdOrAmount === 'string' && typeof incrementBy === 'number' && incrementBy > 1);

  if (typeof channelIdOrAmount === 'number') {
    inc = channelIdOrAmount;
    channelId = CHANNEL_DEFAULT;
  } else if (typeof channelIdOrAmount === 'string') {
    if (yearMonth.includes(':')) {
      inc = typeof channelIdOrAmount === 'number' ? channelIdOrAmount : (Number(channelIdOrAmount) || 1);
    } else {
      channelId = channelIdOrAmount;
      inc = typeof incrementBy === 'number' ? incrementBy : 1;
    }
  }

  const monthKey = resolveQuotaKey(yearMonth, channelId);

  const rpcParams = {
    p_month: monthKey,
  };
  if (isThreeArg) {
    rpcParams.p_increment_by = inc;
  } else {
    rpcParams.p_amount = inc;
  }

  let { data, error } = await supabase.rpc('reserve_quota', rpcParams);

  // 若資料庫尚未升級支援參數，平穩降級呼叫舊版 reserve_quota(p_month)
  if (error && (error.code === 'PGRST202' || error.message?.includes('Could not find the function') || error.code === '42883')) {
    const fallbackRes = await supabase.rpc('reserve_quota', {
      p_month: monthKey,
    });
    data = fallbackRes.data;
    error = fallbackRes.error;
  }

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
 * LINE 發送失敗時釋放先前保留的額度。
 * @param {string} yearMonth
 * @param {number|string} [channelIdOrAmount=CHANNEL_DEFAULT]
 * @param {number} [decrementBy=1]
 * @returns {Promise<void>}
 */
export async function releaseQuotaReservation(yearMonth, channelIdOrAmount = CHANNEL_DEFAULT, decrementBy = 1) {
  let channelId = CHANNEL_DEFAULT;
  let dec = 1;
  const isThreeArg = arguments.length >= 3 || (typeof channelIdOrAmount === 'string' && typeof decrementBy === 'number' && decrementBy > 1);

  if (typeof channelIdOrAmount === 'number') {
    dec = channelIdOrAmount;
    channelId = CHANNEL_DEFAULT;
  } else if (typeof channelIdOrAmount === 'string') {
    if (yearMonth.includes(':')) {
      dec = typeof channelIdOrAmount === 'number' ? channelIdOrAmount : (Number(channelIdOrAmount) || 1);
    } else {
      channelId = channelIdOrAmount;
      dec = typeof decrementBy === 'number' ? decrementBy : 1;
    }
  }

  const monthKey = resolveQuotaKey(yearMonth, channelId);

  const rpcParams = {
    p_month: monthKey,
  };
  if (isThreeArg) {
    rpcParams.p_decrement_by = dec;
  } else {
    rpcParams.p_amount = dec;
  }

  let { error } = await supabase.rpc('release_quota_reservation', rpcParams);

  // 若資料庫尚未升級支援參數，平穩降級呼叫舊版 release_quota_reservation(p_month)
  if (error && (error.code === 'PGRST202' || error.message?.includes('Could not find the function') || error.code === '42883')) {
    const fallbackRes = await supabase.rpc('release_quota_reservation', {
      p_month: monthKey,
    });
    error = fallbackRes.error;
  }

  if (error) {
    console.error(`[Quota] 釋放保留額度失敗: ${error.message}`);
  }
}



export async function syncLineConsumption(yearMonth = getYearMonth(), customFetch = null, channelId = CHANNEL_DEFAULT) {
  const monthKey = resolveQuotaKey(yearMonth, channelId);
  const { token } = getChannelCredentials(channelId);
  if (!token) {
    return {
      ok: false,
      localCount: 0,
      lineCount: 0,
      remaining: 0,
      isMelted: false,
      synced: false,
      error: 'MISSING_LINE_TOKEN',
    };
  }

  const fetchFn = customFetch || globalThis.fetch;

  try {
    const res = await fetchFn('https://api.line.me/v2/bot/message/quota/consumption', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        localCount: 0,
        lineCount: 0,
        remaining: 0,
        isMelted: false,
        synced: false,
        error: `LINE_API_ERROR_${res.status}: ${errText}`,
      };
    }

    const data = await res.json();
    const lineCount = Number(data.totalUsage) || 0;

    const quota = await getOrCreateQuotaRecord(monthKey);
    const localCount = quota.used_count || 0;
    const effectiveCount = Math.max(localCount, lineCount);
    const remaining = Math.max(0, MAX_MONTHLY_QUOTA - effectiveCount);
    const isMelted = Boolean(quota.is_melted || effectiveCount >= MELT_THRESHOLD);

    // 僅在 LINE 官方用量大於本地計數時補正同步，避免反向覆蓋
    if (lineCount > localCount) {
      const shouldMelt = lineCount >= MELT_THRESHOLD;
      const { error: updateErr } = await supabase
        .from('system_quota')
        .update({
          used_count: lineCount,
          is_melted: shouldMelt,
        })
        .eq('month', monthKey);

      if (updateErr) {
        console.error(`[Quota] 更新 system_quota 失敗: ${updateErr.message}`);
      } else {
        console.log(
          `[Quota] 官方額度同步: 本地 ${localCount} ➔ LINE ${lineCount} (補正差異: +${lineCount - localCount} 則 | 剩餘可用: ${remaining} 則)`
        );
      }

      if (shouldMelt && !quota.is_melted) {
        const alertMsg = `🚨【系統配額熔斷警告】本月 LINE 推播使用量已達 ${lineCount} 則（熔斷門檻：${MELT_THRESHOLD} 則 / 上限：${MAX_MONTHLY_QUOTA} 則），系統已啟動熔斷保護！`;
        await broadcastLineAlert(alertMsg);
      }

      return {
        ok: true,
        localCount,
        lineCount,
        remaining,
        isMelted,
        synced: true,
      };
    }

    return {
      ok: true,
      localCount,
      lineCount,
      remaining,
      isMelted,
      synced: false,
    };
  } catch (err) {
    console.error(`[Quota] 同步 LINE 官方用量例外: ${err.message}`);
    return {
      ok: false,
      localCount: 0,
      lineCount: 0,
      remaining: 0,
      isMelted: false,
      synced: false,
      error: err.message,
    };
  }
}

/**
 * 取得當月推播額度快照 (含上限、已用與剩餘)
 * @param {string} [yearMonth] - 格式 'YYYY-MM' 或 quotaKey，預設當前月份
 * @param {string} [channelId=CHANNEL_DEFAULT] - 頻道識別碼
 * @returns {Promise<{ month: string, usedCount: number, maxQuota: number, remaining: number, isMelted: boolean }>}
 */
export async function getQuotaSnapshot(yearMonth = getYearMonth(), channelId = CHANNEL_DEFAULT) {
  const monthKey = resolveQuotaKey(yearMonth, channelId);
  const quota = await getOrCreateQuotaRecord(monthKey);
  const usedCount = quota.used_count || 0;
  const remaining = Math.max(0, MAX_MONTHLY_QUOTA - usedCount);
  return {
    month: quota.month,
    usedCount,
    maxQuota: MAX_MONTHLY_QUOTA,
    remaining,
    isMelted: Boolean(quota.is_melted),
  };
}
