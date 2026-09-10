/**
 * 深度診斷腳本：模擬真實 check-trucks 完整流程
 * 使用真實 API 資料 + 真實 DB 查詢（含 subscriptions、trust、cooldown）
 */
import 'dotenv/config';
import { supabase } from '../lib/supabaseClient.js';
import { fetchTrucksWithRetry } from '../lib/truckApi.js';
import { adaptTruckData } from '../lib/truckAdapter.js';
import { calculateDistanceMeters } from '../lib/geoUtils.js';
import { getTaiwanNow, isWithinServiceWindow } from '../lib/timeUtils.js';
import { getIsoDayOfWeek, findNearbyTruckArrivals } from '../lib/coreProcessor.js';

const GROUP_ID = 'C8b514cecb1141d158bb44a19f33eb291';

async function diagnose() {
  console.log('='.repeat(70));
  console.log('🔬 垃圾車通知完整流程深度診斷');
  console.log('='.repeat(70));

  const twNow = getTaiwanNow();
  const isoDay = getIsoDayOfWeek(twNow.now);
  const dayNames = ['', '一', '二', '三', '四', '五', '六', '日'];
  
  console.log(`\n📅 台灣時間：${twNow.dateStr} ${twNow.hour}:${String(twNow.minute).padStart(2,'0')} (星期${dayNames[isoDay]})`);
  console.log(`⏰ 服務時間窗 (17:00-21:59)：${isWithinServiceWindow() ? '✅ 在時段內' : '❌ 不在時段內 — 真實 check-trucks 會在這裡被擋掉'}`);

  // 1. 清理重複站點
  console.log('\n── [1/8] 清理重複站點 ──');
  const { data: dupeStops } = await supabase
    .from('stops')
    .select('id, name, route_id')
    .eq('route_id', '221010')
    .eq('name', '汐萬路一段333巷口')
    .order('id', { ascending: true });
  
  if (dupeStops && dupeStops.length > 1) {
    const keepId = dupeStops[0].id;
    const removeIds = dupeStops.slice(1).map(s => s.id);
    console.log(`  保留 stop_id=${keepId}，刪除重複: ${removeIds.join(', ')}`);
    
    // 先移轉訂閱到保留的站點
    for (const rid of removeIds) {
      await supabase.from('subscriptions').delete().eq('stop_id', rid);
    }
    // 確保保留的站點有訂閱
    await supabase.from('subscriptions').upsert(
      { group_id: GROUP_ID, stop_id: keepId },
      { onConflict: 'group_id,stop_id' }
    );
    // 刪除重複站點
    for (const rid of removeIds) {
      await supabase.from('stops').delete().eq('id', rid);
    }
    console.log('  ✅ 清理完成');
  } else {
    console.log('  ✅ 無重複站點');
  }

  // 2. 檢查路線 active_days
  console.log('\n── [2/8] 檢查路線設定 ──');
  const { data: routes } = await supabase
    .from('routes')
    .select('*')
    .eq('id', '221010');
  
  if (!routes || routes.length === 0) {
    console.error('  ❌ 路線 221010 不存在！');
    return;
  }
  const route = routes[0];
  console.log(`  路線: ${route.name} (is_active=${route.is_active})`);
  console.log(`  營運日: ${JSON.stringify(route.active_days)}`);
  console.log(`  今日 (星期${isoDay}): ${route.active_days.includes(isoDay) ? '✅ 今日營運' : '❌ 今日不營運 — 通知不會發送'}`);

  // 3. 檢查訂閱
  console.log('\n── [3/8] 檢查訂閱關聯 ──');
  const { data: subs } = await supabase
    .from('subscriptions')
    .select('group_id, stop_id')
    .eq('group_id', GROUP_ID);
  console.log(`  訂閱數: ${subs?.length || 0}`);
  if (!subs || subs.length === 0) {
    console.error('  ❌ 訂閱為空！通知不可能發送！');
    return;
  }
  subs.forEach(s => console.log(`  ✅ group → stop_id: ${s.stop_id}`));

  // 4. 檢查站點座標
  console.log('\n── [4/8] 檢查站點座標 ──');
  const { data: stops } = await supabase
    .from('stops')
    .select('*')
    .eq('route_id', '221010');
  stops.forEach(s => console.log(`  站點 [${s.id}] ${s.name}: (${s.lat}, ${s.lng})`));

  // 5. 檢查信任機制 (route_linids)
  console.log('\n── [5/8] 檢查信任機制 (route_linids) ──');
  const { data: trustedData } = await supabase
    .from('route_linids')
    .select('*')
    .eq('route_id', '221010');
  
  if (!trustedData || trustedData.length === 0) {
    console.log('  ✅ 無信任記錄 → 所有車輛都會觸發通知（不過濾）');
  } else {
    console.log(`  ⚠️ 已有 ${trustedData.length} 筆信任記錄：`);
    const trusted3 = trustedData.filter(r => r.observed_count >= 3);
    const notTrusted = trustedData.filter(r => r.observed_count < 3);
    if (trusted3.length > 0) {
      console.log(`  🔒 已建立信任的 linid (observed_count >= 3)：`);
      trusted3.forEach(r => console.log(`    - linid: ${r.linid}, count: ${r.observed_count}`));
      console.log(`  ⚠️ 只有以上 linid 的車輛會觸發通知，其他車輛會被過濾！`);
    }
    if (notTrusted.length > 0) {
      console.log(`  🔓 尚未達信任門檻的 linid (count < 3)：`);
      notTrusted.forEach(r => console.log(`    - linid: ${r.linid}, count: ${r.observed_count}`));
    }
  }

  // 6. 檢查配額
  console.log('\n── [6/8] 檢查月度配額 ──');
  const yearMonth = `${twNow.now.getUTCFullYear()}-${String(twNow.now.getUTCMonth()+1).padStart(2,'0')}`;
  const { data: quota } = await supabase
    .from('system_quota')
    .select('*')
    .eq('month', yearMonth)
    .maybeSingle();
  
  if (quota) {
    console.log(`  ${yearMonth}: used=${quota.used_count}/195, is_melted=${quota.is_melted}`);
    if (quota.is_melted) console.error('  ❌ 配額已熔斷！所有通知被攔截！');
    else console.log('  ✅ 配額正常');
  } else {
    console.log('  ✅ 本月無配額記錄（首次使用）');
  }

  // 7. 抓取真實 API 資料
  console.log('\n── [7/8] 抓取新北市環保局即時 API ──');
  const apiUrl = 'https://data.ntpc.gov.tw/api/datasets/28ab4122-60e1-4065-98e5-abccb69aaca6/json?page=0&size=1000';
  
  let rawData;
  try {
    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'TrashAlertBot/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    rawData = await resp.json();
    console.log(`  HTTP ${resp.status}, 收到 ${Array.isArray(rawData) ? rawData.length : '?'} 筆原始資料`);
  } catch (e) {
    console.error(`  ❌ API 請求失敗: ${e.message}`);
    console.log('  💡 這可能是通知失敗的原因之一 — 如果營運時段 API 也掛掉');
    return;
  }

  // 看一下原始資料的欄位名稱
  if (Array.isArray(rawData) && rawData.length > 0) {
    console.log(`  原始資料欄位: ${Object.keys(rawData[0]).join(', ')}`);
    console.log(`  範例記錄: ${JSON.stringify(rawData[0])}`);
  }

  // 用 adapter 清洗
  const cleaned = adaptTruckData(rawData);
  console.log(`  清洗後有效車輛: ${cleaned.length} 筆`);

  // 找出 221010 路線的車輛
  const route221010 = cleaned.filter(t => t.route_id === '221010');
  console.log(`  其中 route_id=221010 的車輛: ${route221010.length} 筆`);
  route221010.slice(0, 5).forEach(t => 
    console.log(`    - car: ${t.car_id || '?'}, linid: ${t.route_id}, pos: (${t.lat}, ${t.lng})`)
  );

  // 8. 距離計算 — 找出最近的車輛
  console.log('\n── [8/8] 距離分析 ──');
  const stop = stops[0];
  
  if (route221010.length === 0) {
    console.log('  ⚠️ 目前無 221010 路線的車輛在線');
    console.log('  💡 這是正常的 — 車輛只在清運時段 (約17:00-21:00) 才會出現');
    
    // 找最近的任何車輛
    if (cleaned.length > 0) {
      const withDist = cleaned.map(t => ({
        ...t,
        dist: calculateDistanceMeters(t.lat, t.lng, stop.lat, stop.lng)
      })).sort((a, b) => a.dist - b.dist);
      
      console.log(`\n  📍 站點座標: (${stop.lat}, ${stop.lng})`);
      console.log(`  目前最近的 5 台車輛（任何路線）：`);
      withDist.slice(0, 5).forEach(t => 
        console.log(`    - route: ${t.route_id}, car: ${t.car_id || '?'}, dist: ${Math.round(t.dist)}m`)
      );
    }
  } else {
    const withDist = route221010.map(t => ({
      ...t,
      dist: calculateDistanceMeters(t.lat, t.lng, stop.lat, stop.lng)
    })).sort((a, b) => a.dist - b.dist);

    console.log(`  📍 站點座標: (${stop.lat}, ${stop.lng})`);
    console.log(`  221010 路線車輛距離排序：`);
    withDist.forEach(t => {
      const inRange = t.dist <= 250;
      console.log(`    ${inRange ? '🚨' : '  '} car: ${t.car_id || '?'}, dist: ${Math.round(t.dist)}m ${inRange ? '← 在 250m 圍欄內！會觸發通知' : ''}`);
    });

    const inFence = withDist.filter(t => t.dist <= 250);
    if (inFence.length > 0) {
      console.log(`\n  🎯 有 ${inFence.length} 台車在圍欄內！正常情況下應觸發通知。`);
    } else {
      console.log(`\n  ℹ️ 目前無車輛在 250m 圍欄內（最近: ${Math.round(withDist[0]?.dist)}m）`);
    }
  }

  // 檢查 daily_status
  console.log('\n── [補充] 檢查 daily_status ──');
  const { data: ds } = await supabase
    .from('daily_status')
    .select('*')
    .order('date', { ascending: false })
    .limit(3);
  if (ds && ds.length > 0) {
    ds.forEach(d => console.log(`  ${d.date}: suspended=${d.is_suspended}, api_fail=${d.api_fail_count}, paused=${d.is_paused}, error=${d.last_api_error || 'none'}`));
  } else {
    console.log('  無記錄');
  }

  console.log('\n' + '='.repeat(70));
  console.log('診斷完成');
  console.log('='.repeat(70));
}

diagnose().catch(console.error);
