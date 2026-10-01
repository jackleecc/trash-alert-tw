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
import { getQuotaSnapshot } from '../lib/quotaService.js';
import { getTaiwanNow } from '../lib/timeUtils.js';

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
      // 查詢活躍訂閱站點集合
      let activeSubs = [];
      try {
        const resSubs = await supabase
          .from('subscriptions')
          .select('stop_id, line_groups!inner(is_active)')
          .eq('line_groups.is_active', true);
        activeSubs = resSubs.data || [];
      } catch (e) {
        console.warn(`[TainanRelay] 查詢活躍訂閱警告: ${e.message}`);
      }
      const subscribedStopIdSet = new Set((activeSubs || []).map((s) => Number(s.stop_id)));

      // 查詢所有站點與路線
      const { data: allStops, error: stopsErr } = await supabase
        .from('stops')
        .select('*, routes(*)');

      if (!stopsErr && allStops && allStops.length > 0) {
        const sortedStops = [...(allStops || [])].sort((a, b) => {
          const subA = subscribedStopIdSet.has(Number(a.id)) ? 1 : 0;
          const subB = subscribedStopIdSet.has(Number(b.id)) ? 1 : 0;
          return subB - subA; // Subscribed stops first!
        });

        // 先以文字關鍵字精確匹配 (如 "文化路", "永康區文化路40號", "夜間31")
        targetStop = sortedStops.find(
          (s) =>
            (s.name && fullText.includes(s.name)) ||
            (s.name && fullText.includes(s.name.replace(/臺/g, '台'))) ||
            (s.routes?.name && fullText.includes(s.routes.name))
        );

        // 若無直接全名匹配，嘗試部分關鍵字比對 (如 "文化路"、"40號"、"永康")
        if (!targetStop) {
          targetStop = sortedStops.find(
            (s) =>
              (s.routes?.city === '台南市' || s.name?.includes('永康')) &&
              (fullText.includes('文化路') || fullText.includes('40號') || fullText.includes('永康') || fullText.includes('70') || fullText.includes('31'))
          );
        }

        if (targetStop) {
          targetRoute = targetStop.routes;
        }
      }
    }

    if (!targetStop) {
      const warnMsg = `[TainanRelay Warning] 無法辨識對應站點，收到通知: "${fullText.slice(0, 100)}"`;
      console.warn(warnMsg);
      try {
        await supabase
          .from('daily_status')
          .update({ last_api_error: warnMsg, updated_at: new Date().toISOString() })
          .eq('date', getTaiwanNow().dateStr);
      } catch (dsErr) {
        // ignore daily_status fallback errors
      }

      await recordExecutionLog({
        status: 'warning',
        reason: 'tainan-relay-stop-not-matched',
        triggerSource,
        details: { rawText: fullText },
      });
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
      const warnMsg = `[TainanRelay Warning] 站點 [${targetStop.name}] 目前無活躍訂閱群組`;
      console.log(warnMsg);
      try {
        await supabase
          .from('daily_status')
          .update({ last_api_error: warnMsg, updated_at: new Date().toISOString() })
          .eq('date', getTaiwanNow().dateStr);
      } catch (dsErr) {
        // ignore
      }

      return res.status(200).json({
        ok: true,
        stopId: targetStop.id,
        stopName: targetStop.name,
        notifiedGroups: 0,
        message: 'No active subscribers for this stop',
      });
    }

    // 4. 取得當前頻道額度快照 (台南使用預設頻道)
    let quotaLine = null;
    try {
      const quotaInfo = await getQuotaSnapshot();
      if (quotaInfo && typeof quotaInfo.usedCount === 'number') {
        const maxQuota = typeof quotaInfo.maxQuota === 'number' ? quotaInfo.maxQuota : 200;
        const displayUsed = quotaInfo.usedCount + 1;
        const displayRem = Math.max(0, maxQuota - displayUsed);
        quotaLine = `📊 本月推播額度：已用 ${displayUsed} / 剩餘 ${displayRem}`;
      }
    } catch (qErr) {
      console.warn(`[TainanRelay] 取得額度快照警告: ${qErr.message}`);
    }

    // 5. 逐一執行冷卻檢核與 LINE 推播
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
        quotaLine,
      ]
        .filter(Boolean)
        .join('\n');

      const dispatchRes = await dispatchNotification({
        groupId,
        routeId: routeIdStr,
        stopId: targetStop.id,
        stopName: targetStop.name,
        city: '台南市',
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
