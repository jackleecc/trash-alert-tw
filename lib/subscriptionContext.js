/**
 * lib/subscriptionContext.js
 * 訂閱上下文與智慧縮時窗過濾模組 (Subscription Context)
 */

import { supabase } from './supabaseClient.js';
import { resolveRouteCity } from './geoUtils.js';
import { isWithinScheduleWindow, getIsoDayOfWeek } from './arrivalMatcher.js';

/**
 * 查詢今日啟用的路線、站點、群組訂閱與有活躍訂閱的縣市清單 (Smart Context)
 *
 * @param {{ now: Date, hour: number, minute: number, dateStr: string }} taiwanNowInfo
 * @param {string[]} [suspendedCities]
 * @param {object} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   todayIsoDay: number,
 *   activeRoutesMap: Map<string, object>,
 *   stops: Array<object>,
 *   allRouteStops: Array<object>,
 *   stopSubscribersMap: Map<string, Set<string>>,
 *   activeCities: string[],
 *   hasActiveSubscriptions: boolean,
 *   sleepingStops?: Array<object>,
 *   outOfWindowStops?: Array<object>,
 *   reason?: string,
 *   error?: string
 * }>}
 */
export async function getActiveSubscriptionContext(
  taiwanNowInfo,
  suspendedCities = [],
  options = {}
) {
  const todayIsoDay = getIsoDayOfWeek(taiwanNowInfo.now);

  // 1. 查詢所有啟用路線
  const { data: routes, error: routeErr } = await supabase
    .from('routes')
    .select('*')
    .eq('is_active', true);

  if (routeErr) {
    console.error(`[Core] 查詢 routes 失敗: ${routeErr.message}`);
    return { ok: false, error: routeErr.message, reason: 'db-route-error', hasActiveSubscriptions: false };
  }

  if (!routes || routes.length === 0) {
    return { ok: true, todayIsoDay, activeRoutesMap: new Map(), stops: [], allRouteStops: [], stopSubscribersMap: new Map(), activeCities: [], hasActiveSubscriptions: false, reason: 'no-active-routes' };
  }

  // 過濾今日有營運的路線，並排除停班停課縣市的路線
  const activeRoutesMap = new Map();
  for (const r of routes) {
    const days = Array.isArray(r.active_days) ? r.active_days : [];
    if (!days.includes(todayIsoDay)) continue;

    const city = resolveRouteCity(r);
    if (city && suspendedCities.includes(city)) {
      console.log(`[Core] 路線 [${r.id}] ${r.name} 因 ${city} 天災停收，今日略過。`);
      continue;
    }

    activeRoutesMap.set(String(r.id), r);
  }

  const activeRouteIds = Array.from(activeRoutesMap.keys());
  if (activeRouteIds.length === 0) {
    return { ok: true, todayIsoDay, activeRoutesMap, stops: [], allRouteStops: [], stopSubscribersMap: new Map(), activeCities: [], hasActiveSubscriptions: false, reason: 'no-routes-today' };
  }

  // 2. 僅查詢今日啟用路線的站點
  const { data: stops, error: stopErr } = await supabase
    .from('stops')
    .select('id, route_id, name, lat, lng, order_index, schedule_time')
    .in('route_id', activeRouteIds);

  if (stopErr) {
    console.error(`[Core] 查詢 stops 失敗: ${stopErr.message}`);
    return { ok: false, error: stopErr.message, reason: 'db-stop-error', hasActiveSubscriptions: false };
  }

  // 3. 查詢啟用群組
  const { data: groups, error: groupErr } = await supabase
    .from('line_groups')
    .select('group_id')
    .eq('is_active', true);

  if (groupErr) {
    console.error(`[Core] 查詢 line_groups 失敗: ${groupErr.message}`);
    return { ok: false, error: groupErr.message, reason: 'db-group-error', hasActiveSubscriptions: false };
  }

  const activeGroupIds = (groups || []).map((group) => group.group_id);
  if (activeGroupIds.length === 0) {
    return { ok: true, todayIsoDay, activeRoutesMap, stops: [], allRouteStops: stops || [], stopSubscribersMap: new Map(), activeCities: [], hasActiveSubscriptions: false, reason: 'no-active-groups' };
  }

  // 4. 查詢活躍訂閱
  const { data: subscriptions, error: subErr } = await supabase
    .from('subscriptions')
    .select('group_id, stop_id')
    .in('group_id', activeGroupIds);

  if (subErr) {
    console.error(`[Core] 查詢 subscriptions 失敗: ${subErr.message}`);
    return { ok: false, error: subErr.message, reason: 'db-sub-error', hasActiveSubscriptions: false };
  }

  // 5. 查詢今日 (台灣時間 00:00:00+08:00 起) 已成功推播之記錄，落實當日推播後深度休眠
  const notifiedGroupStopSet = new Set();
  const dateStr = taiwanNowInfo.dateStr || new Date().toISOString().slice(0, 10);
  const todayStartIso = `${dateStr}T00:00:00+08:00`;

  if (!options.bypassSleep) {
    try {
      const { data: todayLogs, error: logErr } = await supabase
        .from('notification_logs')
        .select('stop_id, group_id, route_id')
        .neq('route_id', 'WEATHER')
        .gte('sent_at', todayStartIso);

      if (logErr) {
        console.warn(`[Core] 查詢 notification_logs 警告: ${logErr.message}`);
      } else if (todayLogs) {
        for (const log of todayLogs) {
          if (log.route_id === 'WEATHER') continue;
          if (log.stop_id && log.group_id) {
            notifiedGroupStopSet.add(`${log.stop_id}:${log.group_id}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[Core] 查詢 notification_logs 例外: ${e.message}`);
    }
  }

  // 整理 stopId -> 尚未通知的 group_ids 的對應
  const stopSubscribersMap = new Map();
  const subscribedStopIds = new Set();

  for (const sub of subscriptions || []) {
    const stopIdStr = String(sub.stop_id);
    subscribedStopIds.add(stopIdStr);
    const subKey = `${sub.stop_id}:${sub.group_id}`;

    if (notifiedGroupStopSet.has(subKey)) {
      continue;
    }

    if (!stopSubscribersMap.has(stopIdStr)) {
      stopSubscribersMap.set(stopIdStr, new Set());
    }
    stopSubscribersMap.get(stopIdStr).add(sub.group_id);
  }

  // 6. 檢核站點之智慧縮時窗口 (Smart Time Window) 與深度休眠過濾
  const activeStops = [];
  const sleepingStops = [];
  const outOfWindowStops = [];
  const activeCitiesSet = new Set();

  for (const stop of stops || []) {
    const stopIdStr = String(stop.id);
    if (!subscribedStopIds.has(stopIdStr)) {
      continue;
    }

    const remainingSubs = stopSubscribersMap.get(stopIdStr);
    if (!remainingSubs || remainingSubs.size === 0) {
      sleepingStops.push({
        id: stop.id,
        name: stop.name,
        routeId: stop.route_id,
        scheduleTime: stop.schedule_time,
      });
      continue;
    }

    const beforeMins = options.beforeMinutes ?? 18;
    const afterMins = options.afterMinutes ?? 40;
    const inWindow = options.bypassWindow
      ? true
      : isWithinScheduleWindow(stop.schedule_time, taiwanNowInfo, beforeMins, afterMins);

    if (!inWindow) {
      outOfWindowStops.push({
        id: stop.id,
        name: stop.name,
        routeId: stop.route_id,
        scheduleTime: stop.schedule_time,
      });
      continue;
    }

    activeStops.push(stop);

    const route = activeRoutesMap.get(String(stop.route_id));
    const city = route ? resolveRouteCity(route) : null;
    if (city) {
      if (
        (city === '台南市' || city === '臺南市') &&
        (process.env.SKIP_TAINAN_POLLING === 'true' || process.env.TAINAN_RELAY_MODE === 'phone')
      ) {
        console.log(`[Core] 📱 臺南市已配置為手機通知中繼模式 (SKIP_TAINAN_POLLING)，雲端排程略過主動輪詢天眼系統，以防連線逾時觸發熔斷。`);
      } else {
        activeCitiesSet.add(city);
      }
    }
  }

  const activeCities = Array.from(activeCitiesSet);
  const hasActiveSubscriptions = activeCities.length > 0;

  let reason = undefined;
  if (!hasActiveSubscriptions) {
    if (sleepingStops.length > 0 && outOfWindowStops.length === 0) {
      reason = 'all-subscriptions-sleeping-today';
      console.log(`[Core] 💤 今日所有訂閱站點皆已推播完成，啟動深度休眠 (${sleepingStops.map(s => s.name).join('、')})。`);
    } else if (outOfWindowStops.length > 0 && sleepingStops.length === 0) {
      reason = 'outside-schedule-window';
      console.log(`[Core] ⏳ 目前時間不在任何訂閱站點的智慧縮時窗內 (${outOfWindowStops.map(s => `${s.name}@${s.scheduleTime || '未定'}`).join('、')})，安全略過。`);
    } else if (sleepingStops.length > 0 && outOfWindowStops.length > 0) {
      reason = 'sleeping-or-outside-schedule-window';
      console.log(`[Core] 💤 站點休眠中或尚未進入清運縮時窗，安全略過。`);
    } else {
      reason = 'no-active-subscriptions';
    }
  }

  return {
    ok: true,
    todayIsoDay,
    activeRoutesMap,
    stops: activeStops,
    allRouteStops: stops || [],
    stopSubscribersMap,
    activeCities,
    hasActiveSubscriptions,
    sleepingStops,
    outOfWindowStops,
    reason,
  };
}
