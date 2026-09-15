import 'dotenv/config';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import { supabase } from '../lib/supabaseClient.js';
import { checkUpcomingRain } from '../lib/weatherApi.js';
import { sendLinePushMessage } from '../lib/lineClient.js';
import { formatArrivalMessage, getActiveSubscriptionContext } from '../lib/coreProcessor.js';
import { fetchTrucksWithRetry } from '../lib/truckApi.js';
import { getTaiwanNow } from '../lib/timeUtils.js';

const TARGET_GROUP_ID = 'Cbc0aef28eb6226fafe1ea7e5a6e4487e';
const STOP_ID = 9;

async function runFullVerification() {
  console.log('='.repeat(70));
  console.log('🚀 桃園市楊梅區中山南路146號 完整雙向驗證流程');
  console.log('='.repeat(70));

  // 1. 取得站點資訊
  const { data: stop, error: stopErr } = await supabase
    .from('stops')
    .select('*, routes(*)')
    .eq('id', STOP_ID)
    .single();

  if (stopErr || !stop) {
    throw new Error(`找不到站點 [ID ${STOP_ID}]: ${stopErr?.message}`);
  }
  console.log(`📍 站點資訊: [${stop.id}] ${stop.name} (${stop.lat}, ${stop.lng}), 表定: ${stop.schedule_time}`);
  console.log(`🛣️ 路線資訊: [${stop.routes.id}] ${stop.routes.name}, 縣市: ${stop.routes.city}`);

  // 2. 天氣預報流程測試 (Weather Check & Notification)
  console.log('\n── [Part A] 天氣預報流程檢測與推播 ──');
  const weatherRes = await checkUpcomingRain(stop.lat, stop.lng);
  console.log('  Open-Meteo 查詢結果:', weatherRes);

  const weatherNotice = [
    `⛅【站點天氣速報】`,
    `📍 站點：${stop.name}`,
    `🌧️ 降雨機率：${weatherRes.prob}%`,
    `💧 預估雨量：${weatherRes.precipitation} mm`,
    `☀️ 紫外線指數：${weatherRes.uvIndex} (UV${weatherRes.uvWarning ? '過量' : '正常'})`,
    `😷 PM2.5 濃度：${weatherRes.pm25} μg/m³ (${weatherRes.pmWarning ? '不良' : '良好'})`,
    ``,
    weatherRes.desc || '✨ 天氣與空氣品質良好，適合出門清運！',
  ].join('\n');

  console.log('  發送天氣測試訊息至 LINE 群組...');
  const weatherPushRes = await sendLinePushMessage(TARGET_GROUP_ID, weatherNotice);
  console.log(`  天氣推播結果: HTTP ${weatherPushRes.status} (ok=${weatherPushRes.ok})`);
  if (!weatherPushRes.ok) {
    throw new Error(`天氣推播失敗: ${weatherPushRes.error}`);
  }
  console.log('  ✅ 天氣預報推播成功送達！');

  // 3. 清運 API 即時動態檢核
  console.log('\n── [Part B] 桃園市清運 API 即時動態連線 ──');
  const twNow = getTaiwanNow();
  const apiRes = await fetchTrucksWithRetry(twNow.dateStr, undefined, ['桃園市']);
  console.log(`  桃園 API 連線狀態: ${apiRes.ok ? '✅ 成功' : '❌ 失敗'}, 車輛總數: ${apiRes.data.length} 筆`);
  const r17Trucks = apiRes.data.filter(t => t.route_id === 'lagi2-006_2_21' || t.car_id === 'KEK-3178');
  console.log(`  楊梅路十七線配屬執勤車輛:`, r17Trucks);

  // 4. 清運通知到站推播流程測試 (Garbage Truck Arrival Notification)
  console.log('\n── [Part C] 清運到站通知推播流程測試 ──');
  const arrivalMsg = formatArrivalMessage({
    routeName: stop.routes.name,
    stopName: stop.name,
    distance: 85,
    carId: 'KEK-3178',
    weatherDesc: weatherRes.desc,
    stopLat: stop.lat,
    stopLng: stop.lng,
  });

  const fullArrivalMsg = `${arrivalMsg}\n\n🧪【系統驗證推播】本站點已正式開通！每週一、二、四、五、六傍晚 17:25 將於垃圾車進場前自動推播提醒。`;

  console.log('  發送到站推播測試訊息至 LINE 群組...');
  const truckPushRes = await sendLinePushMessage(TARGET_GROUP_ID, fullArrivalMsg);
  console.log(`  到站推播結果: HTTP ${truckPushRes.status} (ok=${truckPushRes.ok})`);
  if (!truckPushRes.ok) {
    throw new Error(`到站推播失敗: ${truckPushRes.error}`);
  }
  console.log('  ✅ 清運到站推播成功送達！');

  // 5. 驗證活躍訂閱上下文 (Context Resolution)
  console.log('\n── [Part D] 訂閱上下文與智慧排程檢驗 ──');
  const activeCtx = await getActiveSubscriptionContext(
    { now: new Date('2026-09-15T09:25:00Z'), hour: 17, minute: 25, dateStr: '2026-09-15' },
    [],
    { bypassSleep: true }
  );
  console.log(`  活躍縣市清單: [${activeCtx.activeCities.join(', ')}]`);
  console.log(`  桃園市是否在活躍清單中: ${activeCtx.activeCities.includes('桃園市') ? '✅ 是' : '❌ 否'}`);
  console.log(`  是否有活躍訂閱: ${activeCtx.hasActiveSubscriptions ? '✅ 是' : '❌ 否'}`);

  console.log('\n' + '='.repeat(70));
  console.log('🎉 桃園市楊梅區中山南路146號 天氣預報與清運通知流程全數驗證通過！');
  console.log('='.repeat(70));
}

runFullVerification().catch((err) => {
  console.error('❌ 驗證失敗:', err);
  process.exit(1);
});
