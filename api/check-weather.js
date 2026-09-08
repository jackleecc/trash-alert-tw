/**
 * api/check-weather.js
 * Vercel Serverless Function — 氣象預報排程入口
 *
 * 觸發排程：透過 GitHub Actions 每 30 分鐘觸發一次。
 * 流程：
 * 1. 驗證 CRON_SECRET。
 * 2. 從資料庫取得所有啟用中的群組與其訂閱站點。
 * 3. 整合站點（同一站點只需查詢一次氣象）。
 * 4. 呼叫 Open-Meteo API 查詢降雨預報。
 * 5. 若會下雨，檢查 6 小時冷卻期 (claim_notification)。
 * 6. 若取得推播權，檢查當月發送額度 (reserve_quota)。
 * 7. 若有額度，發送 LINE 氣象推播通知。
 */

import crypto from 'node:crypto';
import { supabase } from '../lib/supabaseClient.js';
import { sendLinePushMessage } from '../lib/lineClient.js';
import { checkUpcomingRain } from '../lib/weatherApi.js';
import { getTaiwanNow } from '../lib/timeUtils.js';

/**
 * 安全字串比對，防禦 Timing Attack
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET;
  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  // 1. 驗證 CRON_SECRET
  if (!CRON_SECRET || !safeCompare(token, CRON_SECRET)) {
    console.warn('[CheckWeather] 授權失敗，拒絕請求。');
    return res.status(401).json({ ok: false, reason: 'Unauthorized' });
  }

  const { dateStr } = getTaiwanNow();
  console.log(`[CheckWeather] 開始執行氣象檢查排程 (${dateStr})...`);

  try {
    // 2. 取得所有啟用的群組，以及他們訂閱的站點經緯度
    const { data: subs, error: subsError } = await supabase
      .from('subscriptions')
      .select(`
        group_id,
        stop_id,
        line_groups!inner(is_active),
        stops!inner(lat, lng, name)
      `)
      .eq('line_groups.is_active', true);

    if (subsError) {
      throw new Error(`查詢訂閱資料失敗: ${subsError.message}`);
    }

    if (!subs || subs.length === 0) {
      console.log('[CheckWeather] 無任何啟用中的群組或訂閱站點，略過。');
      return res.status(200).json({ ok: true, skipped: true, reason: 'no-active-groups' });
    }

    // 3. 以站點 (stop_id) 為單位進行去重，減少氣象 API 請求
    const stopMap = new Map();
    for (const sub of subs) {
      if (!stopMap.has(sub.stop_id)) {
        stopMap.set(sub.stop_id, {
          stop_id: sub.stop_id,
          lat: sub.stops.lat,
          lng: sub.stops.lng,
          name: sub.stops.name,
          groups: []
        });
      }
      stopMap.get(sub.stop_id).groups.push(sub.group_id);
    }

    let notificationsSent = 0;
    const currentMonth = dateStr.slice(0, 7); // 'YYYY-MM'

    // 4. 針對每個站點查詢天氣
    for (const stop of stopMap.values()) {
      const { shouldNotify, desc } = await checkUpcomingRain(stop.lat, stop.lng);

      if (shouldNotify) {
        console.log(`[CheckWeather] 站點 ${stop.name} (${stop.stop_id}) 觸發環境警報:\n${desc}`);
        
        // 5. 對每個訂閱該站點的群組進行通知檢查
        for (const groupId of stop.groups) {
          // 檢查冷卻時間：6 小時 (360 分鐘)
          // 參數: p_group_id, p_route_id, p_stop_id, p_car_id, p_cooldown_minutes
          const { data: logId, error: claimError } = await supabase.rpc('claim_notification', {
            p_group_id: groupId,
            p_route_id: 'WEATHER',
            p_stop_id: stop.stop_id,
            p_car_id: 'OpenMeteo',
            p_cooldown_minutes: 360
          });

          if (claimError || !logId) {
            // 沒有取得 logId 代表還在冷卻期內，略過
            continue;
          }

          // 6. 檢查發送額度
          const { data: quotaResult, error: quotaError } = await supabase.rpc('reserve_quota', {
            p_month: currentMonth
          });

          if (quotaError) {
            console.error(`[CheckWeather] 額度保留失敗 (${groupId}):`, quotaError.message);
            // 釋放剛才取得的推播權
            await supabase.rpc('release_notification_claim', { p_log_id: logId });
            continue;
          }

          // reserve_quota 回傳 table，supabase-js 會回傳陣列
          const row = Array.isArray(quotaResult) ? quotaResult[0] : quotaResult;
          if (!row || !row.reserved) {
            console.warn(`[CheckWeather] 額度耗盡或已熔斷，無法發送氣象推播 (${groupId})。`);
            await supabase.rpc('release_notification_claim', { p_log_id: logId });
            break;
          }

          // 7. 發送推播
          const message = `⚠️ 【環境與氣象預報提醒】\n您關注的清運點「${stop.name}」附近，未來一小時有以下狀況：\n\n${desc}`;
          const pushRes = await sendLinePushMessage(groupId, message);

          if (pushRes.ok) {
            notificationsSent++;
            console.log(`[CheckWeather] 已發送警報至群組 ${groupId} (站點 ${stop.name})`);
          } else {
            console.error(`[CheckWeather] 發送 LINE 訊息失敗 (${groupId}):`, pushRes.error);
            // 歸還額度與推播權
            await supabase.rpc('release_notification_claim', { p_log_id: logId });
            await supabase.rpc('release_quota_reservation', { p_month: currentMonth });
          }
        }
      } else {
         console.log(`[CheckWeather] 站點 ${stop.name} (${stop.stop_id}) 環境指標正常。`);
      }
    }

    return res.status(200).json({ ok: true, checkedStops: stopMap.size, notificationsSent });

  } catch (err) {
    console.error(`[CheckWeather] 執行過程發生錯誤:`, err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
