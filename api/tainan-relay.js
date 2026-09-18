/**
 * api/tainan-relay.js
 * 接收 Android 手機端 (MacroDroid 等) 轉發之「臺南環保通」App 原生通知 Webhook
 *
 * 核心流程：
 *   1. 安全校驗：比對 CRON_SECRET，防禦 Timing Attack 與非授權外部呼叫。
 *   2. 站點辨識：根據傳入的 stop_id 或通知內容關鍵字匹配有效站點（預設支援 Stop 6 永康文化路）。
 *   3. 查詢群組：向 Supabase 查詢訂閱該站點且處於活躍狀態的 LINE 群組。
 *   4. 防重檢核：使用 cooldownService 進行 30 分鐘冷卻檢核，阻斷連續通知洗版。
 *   5. LINE 推播：格式化到站提醒文字並發送至群組。
 *   6. 歷程登記：寫入 notification_logs 與 execution_logs 供儀表板追蹤。
 */

import { supabase } from '../lib/supabaseClient.js';
import { dispatchNotification } from '../lib/notificationDispatcher.js';
import { recordExecutionLog, extractTriggerSource } from '../lib/logger.js';
import { guardEndpoint } from '../lib/endpointGuard.js';

export default async function handler(req, res) {
  const guardResult = await guardEndpoint(req, res, {
    endpointName: '/api/tainan-relay',
    unauthorizedReason: 'invalid-secret'
  });
  if (!guardResult.authorized) return;
  const { triggerSource } = guardResult;

  const {
    title = '',
    text = '',
    content = '',
    stop_id,
    car_id,
  } = req.body || {};

  const fullText = `${title} ${text} ${content}`.trim();
  console.log(`[TainanRelay] 收到手機通知轉發: title="${title}", text="${text}"`);

  try {
    // 2. 匹配站點：若有指定 stop_id 優先使用，否則依通知關鍵字或預設臺南活躍站點比對
    let targetStop = null;
    let targetRoute = null;

    if (stop_id) {
      const { data: stopData, error: stopErr } = await supabase
        .from('stops')
        .select('*, routes(*)')
        .eq('id', Number(stop_id))
        .single();
      if (!stopErr && stopData) {
        targetStop = stopData;
        targetRoute = stopData.routes;
      }
    }

    if (!targetStop) {
      // 查詢所有站點與路線
      const { data: allStops, error: stopsErr } = await supabase
        .from('stops')
        .select('*, routes(*)');

      if (!stopsErr && allStops && allStops.length > 0) {
        // 先以文字關鍵字精確匹配 (如 "文化路", "永康區文化路40號", "夜間31")
        targetStop = allStops.find(
          (s) =>
            (s.name && fullText.includes(s.name)) ||
            (s.name && fullText.includes(s.name.replace(/臺/g, '台'))) ||
            (s.routes?.name && fullText.includes(s.routes.name))
        );

        // 若無直接全名匹配，嘗試部分關鍵字比對 (如 "文化路"、"40號"、"永康")
        if (!targetStop) {
          targetStop = allStops.find(
            (s) =>
              (s.routes?.city === '台南市' || s.name?.includes('永康')) &&
              (fullText.includes('文化路') || fullText.includes('40號') || fullText.includes('永康') || fullText.includes('70') || fullText.includes('31'))
          );
        }

        // 若依然沒有匹配，但為臺南相關通知，預設指向 Stop 6 (永康區文化路40號)
        if (!targetStop) {
          targetStop = allStops.find((s) => s.id === 6) || allStops.find((s) => s.routes?.city === '台南市');
        }

        if (targetStop) {
          targetRoute = targetStop.routes;
        }
      }
    }

    if (!targetStop) {
      console.warn(`[TainanRelay] 無法辨識對應站點，通知全文: "${fullText}"`);
      return res.status(404).json({
        ok: false,
        error: 'Stop not matched from notification content',
        receivedText: fullText,
      });
    }

    console.log(`[TainanRelay] 成功匹配站點: [ID: ${targetStop.id}] ${targetStop.name}`);

    // 3. 查詢訂閱該站點的有效群組清單
    const { data: subscriptions, error: subErr } = await supabase
      .from('subscriptions')
      .select('group_id, line_groups!inner(group_id, is_active)')
      .eq('stop_id', targetStop.id)
      .eq('line_groups.is_active', true);

    if (subErr) {
      console.error(`[TainanRelay] 查詢訂閱失敗: ${subErr.message}`);
      return res.status(500).json({ ok: false, error: subErr.message });
    }

    const activeGroupIds = (subscriptions || []).map((s) => s.group_id);
    if (activeGroupIds.length === 0) {
      console.log(`[TainanRelay] 站點 [${targetStop.name}] 目前無活躍訂閱群組。`);
      return res.status(200).json({
        ok: true,
        stopId: targetStop.id,
        stopName: targetStop.name,
        notifiedGroups: 0,
        message: 'No active subscribers for this stop',
      });
    }

    // 4. 逐一執行冷卻檢核與 LINE 推播
    const routeIdStr = String(targetRoute?.id || targetStop.route_id || '70');
    const routeName = targetRoute?.name || '永康-夜間31';
    let successCount = 0;
    let cooldownCount = 0;

    for (const groupId of activeGroupIds) {
      // 格式化推播訊息 (特別註明為官方 App 原生即時連動)
      const alertMessage = [
        `🚛【垃圾車即將抵達提醒 (臺南環保通)】`,
        `📍 站點：${targetStop.name}`,
        `🛣️ 路線：${routeName}`,
        `⏰ 預估抵達：約 3～5 分鐘內`,
        car_id ? `🏷️ 車號：${car_id}` : null,
        targetStop.lat && targetStop.lng
          ? `🗺️ 站點地圖：https://www.google.com/maps/search/?api=1&query=${targetStop.lat},${targetStop.lng}`
          : null,
        ``,
        `💡 來源說明：手機端「臺南環保通」車機到站即時推播`,
      ]
        .filter(Boolean)
        .join('\n');

      const dispatchRes = await dispatchNotification({
        groupId,
        routeId: routeIdStr,
        stopId: targetStop.id,
        carId: car_id || 'TNEPB-APP',
        messageText: alertMessage,
        cooldownMinutes: 30,
      });

      if (dispatchRes.ok && dispatchRes.status === 'sent') {
        successCount++;
      } else if (dispatchRes.status === 'in_cooldown') {
        cooldownCount++;
      }
    }

    console.log(
      `[TainanRelay] 處理完畢: 成功推播 ${successCount} 群組, 冷卻阻斷 ${cooldownCount} 群組`
    );

    await recordExecutionLog({
      status: 'success',
      reason: 'tainan-mobile-relay',
      triggerSource,
      details: {
        stopId: targetStop.id,
        stopName: targetStop.name,
        successCount,
        cooldownCount,
        rawText: fullText,
      },
    });

    return res.status(200).json({
      ok: true,
      stopId: targetStop.id,
      stopName: targetStop.name,
      successCount,
      cooldownCount,
    });
  } catch (err) {
    console.error(`[TainanRelay] 處理異常: ${err.message}`, err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
