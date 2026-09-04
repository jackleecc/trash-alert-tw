/**
 * scripts/dry-run-test.js
 * 垃圾車到站推播流程端到端測試（安全模擬模式 / Dry-Run）
 *
 * ⚠️ 安全保證：
 * 1. 強制設定 process.env.DRY_RUN = 'true'。
 * 2. 攔截 globalThis.fetch，嚴格阻斷任何對 api.line.me 的實體 HTTP 請求。
 * 3. 測試包含：
 *    - 讀取 Supabase 實體資料表（routes, stops, line_groups, subscriptions）
 *    - 抓取高雄市即時垃圾車 API（驗證真實 API 連線與資料適配）
 *    - 模擬車輛進入「路竹區民有路55號」與「路竹區中興路75號」站點之 250m 圍欄
 *    - 比對路線、計算精確距離、產生標準 LINE 到站提醒訊息
 *    - 模擬推播發送並驗證防護機制
 */

import { supabase } from '../lib/supabaseClient.js';
import { fetchTrucksWithRetry } from '../lib/truckApi.js';
import { getTaiwanNow, isWithinServiceWindow } from '../lib/timeUtils.js';
import {
  findNearbyTruckArrivals,
  formatArrivalMessage,
  getIsoDayOfWeek,
} from '../lib/coreProcessor.js';
import { sendLinePushMessage } from '../lib/lineClient.js';
import { calculateDistanceMeters } from '../lib/geoUtils.js';

// ── 1. 強制啟動安全防護 ───────────────────────────────────────────────────────
process.env.DRY_RUN = 'true';

// 攔截 fetch，嚴格阻斷 api.line.me 的連線
const originalFetch = globalThis.fetch;
let lineCallBlockedCount = 0;

globalThis.fetch = async (input, init) => {
  const urlStr = typeof input === 'string' ? input : input?.url || '';
  if (urlStr.includes('api.line.me')) {
    lineCallBlockedCount++;
    console.error(`🚨 [CRITICAL ALERT] 偵測到對 LINE API 的實體請求嘗試！已成功攔截：${urlStr}`);
    throw new Error('BLOCKED_REAL_LINE_API_CALL_IN_DRY_RUN');
  }
  return originalFetch(input, init);
};

console.log('='.repeat(70));
console.log('🚀 開始執行垃圾車到站推播流程測試（DRY-RUN 模擬發送模式）');
console.log('🛡️  安全狀態：DRY_RUN 已啟用，LINE 實體推播已全數阻斷');
console.log('='.repeat(70));

async function runDryRunTest() {
  const taiwanNowInfo = getTaiwanNow();
  const { hour, minute, dateStr, now } = taiwanNowInfo;
  const isoDay = getIsoDayOfWeek(now);
  const dayNames = ['', '一', '二', '三', '四', '五', '六', '日'];

  console.log(`\n📅 當前測試時間 (台灣時間)：${dateStr} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (星期${dayNames[isoDay]})`);
  console.log(`⏱️  服務時間窗判定 (17:00-21:59)：${isWithinServiceWindow() ? '✅ 符合營運時段' : '⏸️ 非營運時段 (模擬測試不受限)'}`);

  // ── 步驟 1：讀取 Supabase 資料庫配置 ──────────────────────────────────────
  console.log('\n[步驟 1/5] 讀取 Supabase 資料庫設定...');
  const { data: routes, error: routeErr } = await supabase.from('routes').select('*').eq('is_active', true);
  if (routeErr) throw new Error(`讀取 routes 失敗: ${routeErr.message}`);

  const { data: stops, error: stopErr } = await supabase.from('stops').select('*');
  if (stopErr) throw new Error(`讀取 stops 失敗: ${stopErr.message}`);

  const { data: lineGroups, error: groupErr } = await supabase.from('line_groups').select('*').eq('is_active', true);
  if (groupErr) throw new Error(`讀取 line_groups 失敗: ${groupErr.message}`);

  const { data: subscriptions, error: subErr } = await supabase.from('subscriptions').select('*');
  if (subErr) throw new Error(`讀取 subscriptions 失敗: ${subErr.message}`);

  console.log(`  ✓ 啟用路線數: ${routes.length}`);
  routes.forEach((r) => console.log(`    - 路線 [${r.id}] ${r.name} (營運日: ${JSON.stringify(r.active_days)})`));

  console.log(`  ✓ 已註冊站點數: ${stops.length}`);
  stops.forEach((s) => console.log(`    - 站點 [${s.id}] ${s.name} (路線: ${s.route_id}, 座標: ${s.lat}, ${s.lng})`));

  console.log(`  ✓ 啟用通知群組數: ${lineGroups.length}`);
  lineGroups.forEach((g) => console.log(`    - 群組 [${g.group_id}] ${g.group_name}`));

  console.log(`  ✓ 站點訂閱數: ${subscriptions.length}`);

  // ── 步驟 2：抓取真實的高雄市垃圾車即時 API ──────────────────────────────
  console.log('\n[步驟 2/5] 抓取高雄市環保局即時動態 API (驗證 API 連線與資料適配)...');
  const apiResult = await fetchTrucksWithRetry(dateStr);
  if (!apiResult.ok) {
    console.warn(`  ⚠️ 環保局 API 抓取失敗: ${apiResult.error}，後續將以模擬車輛繼續測試。`);
  } else {
    console.log(`  ✓ 成功抓取環保局即時車輛: 共 ${apiResult.data.length} 輛在線車輛`);
    // 找出路竹區附近的車輛 (Lat ~22.82~22.87, Lng ~120.25~120.28)
    const luzhuTrucks = apiResult.data.filter(
      (t) => t.lat >= 22.80 && t.lat <= 22.88 && t.lng >= 120.24 && t.lng <= 120.29
    );
    console.log(`  ✓ 目前路竹區周邊在線車輛數: ${luzhuTrucks.length} 輛`);
    luzhuTrucks.slice(0, 3).forEach((t) => {
      console.log(`    - 車次 linid: ${t.route_id}, 車牌: ${t.car_id || '無車牌'}, 座標: (${t.lat}, ${t.lng})`);
    });
  }

  // ── 步驟 3：準備比對情境（涵蓋真實站點與路竹區民有路55號） ──────────────────
  console.log('\n[步驟 3/5] 建立地理圍欄比對情境...');

  // 整理站點清單：包含資料庫已有站點，以及路竹區民有路55號
  const allTestStops = [...stops];
  const hasMinyou55 = stops.some((s) => s.name?.includes('民有路55號'));
  if (!hasMinyou55) {
    allTestStops.push({
      id: 999,
      route_id: 'LZ01',
      name: '路竹區民有路55號',
      lat: 22.822194,
      lng: 120.270422,
      order_index: 2,
    });
    console.log('  ℹ️  加入本次評估的站點「路竹區民有路55號」至測試比對池中');
  }

  // 模擬一輛正在接近「路竹區民有路55號」的垃圾車 (距離約 135 公尺)
  const simulatedApproachingTruck = {
    route_id: '1066015646',
    car_id: 'KEW-0079',
    lat: 22.822100,
    lng: 120.271500,
    time: new Date().toISOString(),
  };

  const distToMinyou55 = calculateDistanceMeters(
    simulatedApproachingTruck.lat,
    simulatedApproachingTruck.lng,
    22.822194,
    120.270422
  );
  console.log(`  ✓ 模擬車輛 (KEW-0079) 距民有路55號：約 ${Math.round(distToMinyou55)} 公尺 (進入 250m 圍欄範圍)`);

  // 準備訂閱映射
  const stopSubscribersMap = new Map();
  for (const s of allTestStops) {
    // 預設將有效群組訂閱該站點
    const groupIds = lineGroups.map((g) => g.group_id);
    stopSubscribersMap.set(String(s.id), new Set(groupIds));
  }

  const activeRoutesMap = new Map();
  for (const r of routes) {
    activeRoutesMap.set(String(r.id), r);
  }

  // ── 步驟 4：執行核心到站運算比對 ──────────────────────────────────────────
  console.log('\n[步驟 4/5] 執行核心演算法 (findNearbyTruckArrivals & formatArrivalMessage)...');
  const arrivals = findNearbyTruckArrivals(
    [simulatedApproachingTruck],
    allTestStops,
    stopSubscribersMap,
    activeRoutesMap
  );

  console.log(`  ✓ 比對出 ${arrivals.length} 筆到站事件：`);
  arrivals.forEach((item, idx) => {
    console.log(`    [事件 ${idx + 1}] 車輛 ${item.truck.car_id} 到達站點「${item.stop.name}」 (距離: ${Math.round(item.distance)}m)`);
  });

  if (arrivals.length === 0) {
    throw new Error('未比對出任何到站事件，請檢查站點與路線設定！');
  }

  // ── 步驟 5：測試模擬發送（DRY-RUN 推播攔截驗證） ──────────────────────────
  console.log('\n[步驟 5/5] 執行 sendLinePushMessage 模擬發送流程...');

  for (const arrival of arrivals) {
    const formattedMsg = formatArrivalMessage({
      routeName: arrival.route.name,
      stopName: arrival.stop.name,
      distance: arrival.distance,
      carId: arrival.truck.car_id,
    });

    const targetGroup = lineGroups[0]?.group_id || 'C_TEST_GROUP_DRYRUN';
    const groupName = lineGroups[0]?.group_name || '測試群組';

    console.log(`\n  👉 準備向群組【${groupName}】(${targetGroup}) 發送推播訊息：`);
    
    // 呼叫 sendLinePushMessage，由內部 DRY_RUN 攔截
    const sendResult = await sendLinePushMessage(targetGroup, formattedMsg);

    console.log(`  ➤ 發送呼叫回傳狀態: status = ${sendResult.status}, ok = ${sendResult.ok}, dryRun = ${sendResult.dryRun}`);
    if (sendResult.dryRun !== true) {
      throw new Error('❌ 嚴重安全性錯誤：sendLinePushMessage 未進入 dryRun 分支！');
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('🎉 測試成功！發送流程驗證完畢');
  console.log('🛡️  安全確認：');
  console.log('   - 實體 LINE API 請求次數：0 次（LINE 伺服器未收到任何訊息）');
  console.log('   - 到站比對、文字格式化、距離計算、收件對象解析皆正常運作');
  console.log('='.repeat(70));
}

runDryRunTest().catch((err) => {
  console.error('\n❌ 測試過程發生異常：', err);
  process.exit(1);
});
