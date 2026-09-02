/**
 * lib/cooldownService.js
 * 防洗版冷卻機制 (Cooldown Service)
 *
 * 規格：
 *   - 針對同一群組 (group_id)、同一路線 (route_id) 或站點 (stop_id)，
 *     若 30 分鐘內已發送過通知，強制阻斷重複發送。
 *   - 每次成功發送通知後，寫入 notification_logs。
 */

import { supabase } from './supabaseClient.js';

const DEFAULT_COOLDOWN_MINUTES = 30;

/**
 * 檢查指定的群組、路線與站點是否仍處於 30 分鐘冷卻期內。
 *
 * @param {string} groupId - LINE Group ID
 * @param {string} routeId - 路線編號
 * @param {string | number} stopId - 站點編號
 * @param {number} [cooldownMinutes=30] - 冷卻分鐘數
 * @returns {Promise<boolean>} true 表示冷卻中（不可發送），false 表示可發送
 */
export async function isInCooldown(
  groupId,
  routeId,
  stopId,
  cooldownMinutes = DEFAULT_COOLDOWN_MINUTES
) {
  const cutoffTime = new Date(
    Date.now() - cooldownMinutes * 60 * 1000
  ).toISOString();

  let query = supabase
    .from('notification_logs')
    .select('id, sent_at')
    .eq('group_id', groupId)
    .eq('route_id', String(routeId))
    .gte('sent_at', cutoffTime)
    .limit(1);

  if (stopId !== undefined && stopId !== null) {
    query = query.eq('stop_id', Number(stopId));
  }

  const { data, error } = await query;

  if (error) {
    console.error(`[Cooldown] 查詢 notification_logs 失敗: ${error.message}`);
    // 安全起見：若 DB 查詢異常，不阻斷但記錄 log
    return false;
  }

  const inCooldown = data && data.length > 0;
  if (inCooldown) {
    console.log(
      `[Cooldown] 群組 ${groupId} 對路線 ${routeId} / 站點 ${stopId} 仍處於冷卻期內 (前次發送於: ${data[0].sent_at})，阻斷重複推播。`
    );
  }

  return inCooldown;
}

/**
 * 記錄發送歷程至 notification_logs
 *
 * @param {string} groupId
 * @param {string} routeId
 * @param {string | number} stopId
 * @param {string} [carId]
 * @returns {Promise<boolean>}
 */
export async function recordNotificationLog(groupId, routeId, stopId, carId) {
  const { error } = await supabase.from('notification_logs').insert({
    group_id: groupId,
    route_id: String(routeId),
    stop_id: Number(stopId),
    car_id: carId || null,
    sent_at: new Date().toISOString(),
  });

  if (error) {
    console.error(`[Cooldown] 寫入 notification_logs 失敗: ${error.message}`);
    return false;
  }

  return true;
}

/**
 * 原子取得通知權並建立冷卻紀錄。
 * @returns {Promise<number | null>} 新建紀錄 ID；null 代表仍在冷卻期或取得失敗
 */
export async function claimNotification(groupId, routeId, stopId, carId) {
  const { data, error } = await supabase.rpc('claim_notification', {
    p_group_id: groupId,
    p_route_id: String(routeId),
    p_stop_id: Number(stopId),
    p_car_id: carId || null,
  });

  if (error) {
    console.error(`[Cooldown] 取得通知權失敗: ${error.message}`);
    return null;
  }

  return data === null ? null : Number(data);
}

/**
 * LINE 發送失敗時移除尚未成功送出的冷卻紀錄。
 * @param {number} logId
 * @returns {Promise<void>}
 */
export async function releaseNotificationClaim(logId) {
  const { error } = await supabase.rpc('release_notification_claim', {
    p_log_id: logId,
  });

  if (error) {
    console.error(`[Cooldown] 釋放通知權失敗: ${error.message}`);
  }
}
