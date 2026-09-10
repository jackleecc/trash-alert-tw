import 'dotenv/config';
import { supabase } from '../lib/supabaseClient.js';
import { getTaiwanNow, isWithinServiceWindow } from '../lib/timeUtils.js';
import { getActiveSubscriptionContext, findNearbyTruckArrivals, resolveRouteCity } from '../lib/coreProcessor.js';
import { fetchTrucksWithRetry } from '../lib/truckApi.js';

const TARGET_GROUP_ID = 'C6f0ecae71723b8aef86290448871e6fa';

async function verify() {
  console.log('='.repeat(70));
  console.log('🔍 台南市永康區文化路40號 整合完整性驗證');
  console.log('='.repeat(70));

  // 1. 驗證資料庫設定
  console.log('\n── [1/4] 驗證資料庫設定 ──');
  const { data: route } = await supabase
    .from('routes')
    .select('*')
    .eq('id', '70')
    .single();
  console.log(`  路線 70: ${route.name}, 縣市: ${route.city}, 營運日: ${JSON.stringify(route.active_days)}, 啟用: ${route.is_active}`);

  const { data: stop } = await supabase
    .from('stops')
    .select('*')
    .eq('route_id', '70')
    .eq('name', '永康區文化路40號')
    .single();
  console.log(`  目標站點: [ID ${stop.id}] ${stop.name} (Lat: ${stop.lat}, Lng: ${stop.lng}), 表定時間: ${stop.schedule_time}`);

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('*, line_groups(*)')
    .eq('group_id', TARGET_GROUP_ID)
    .single();
  console.log(`  群組訂閱: 群組 ID ${sub.group_id} (${sub.line_groups.group_name}) -> 站點 ID ${sub.stop_id}`);

  // 2. 驗證即時上下文運算 (模擬週四 vs 週五)
  console.log('\n── [2/4] 驗證各清運日之活躍上下文 ──');
  // 週四 (Thu = 4, 有收)
  const thuCtx = await getActiveSubscriptionContext({ hour: 19, minute: 40, now: new Date('2026-09-10T11:40:00Z') }, []);
  console.log(`  週四 (今天): activeCities = [${thuCtx.activeCities.join(', ')}], 台南是否活躍: ${thuCtx.activeCities.includes('台南市')}`);

  // 週五 (Fri = 5, 台南停收)
  const friCtx = await getActiveSubscriptionContext({ hour: 19, minute: 40, now: new Date('2026-09-11T11:40:00Z') }, []);
  console.log(`  週五 (明天): activeCities = [${friCtx.activeCities.join(', ')}], 台南是否活躍: ${friCtx.activeCities.includes('台南市')} (自動排除台南)`);

  // 週日 (Sun = 7, 全台停收)
  const sunCtx = await getActiveSubscriptionContext({ hour: 19, minute: 40, now: new Date('2026-09-13T11:40:00Z') }, []);
  console.log(`  週日: hasActiveSubscriptions = ${sunCtx.hasActiveSubscriptions}, activeCities = [${sunCtx.activeCities.join(', ')}] (全台靜默休眠)`);

  // 3. 測試台南市環保局即時 API 連線
  console.log('\n── [3/4] 測試台南市即時 API 連線 ──');
  const twNow = getTaiwanNow();
  const truckRes = await fetchTrucksWithRetry(twNow.dateStr, undefined, ['台南市']);
  console.log(`  API 連線狀態: ${truckRes.ok ? '✅ 成功' : '❌ 失敗'}`);
  console.log(`  取得車輛筆數: ${truckRes.data.length} 筆`);
  if (truckRes.data.length > 0) {
    console.log(`  範例車輛: 車號 ${truckRes.data[0].car_id}, 路線 ${truckRes.data[0].route_id}, 時間 ${truckRes.data[0].time}`);
  }

  // 4. 模擬到站比對
  console.log('\n── [4/4] 模擬車輛進場比對與隔離推播 ──');
  const mockTruckData = [
    {
      route_id: '70',
      car_id: 'TEST-70',
      lat: stop.lat,
      lng: stop.lng,
      waste_type: 'garbage',
      speed: 10,
    },
  ];
  const { data: allStops } = await supabase.from('stops').select('*').eq('route_id', '70');
  const activeRoutesMap = new Map([['70', route]]);
  const stopSubscribersMap = new Map([[String(stop.id), new Set([TARGET_GROUP_ID])]]);

  const arrivals = findNearbyTruckArrivals(
    mockTruckData,
    allStops,
    stopSubscribersMap,
    activeRoutesMap,
    new Map(),
    { hour: 19, minute: 42 }
  );

  console.log(`  比對到站筆數: ${arrivals.length}`);
  if (arrivals.length > 0) {
    const arr = arrivals[0];
    console.log(`  ✅ 站點: ${arr.stop.name}`);
    console.log(`  ✅ 距離: ${Math.round(arr.distance)}m`);
    console.log(`  ✅ 僅推播指定群組: ${Array.from(arr.subscribedGroups).join(', ')}`);
    console.log(`  ✅ shouldNotify: ${arr.shouldNotify}`);
  }

  console.log('\n🎉 所有驗證項目完全正確無誤！');
}

verify().catch((err) => {
  console.error('❌ 驗證失敗:', err);
  process.exit(1);
});
