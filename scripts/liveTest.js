import { supabase } from '../lib/supabaseClient.js';
import { fetchTrucksWithRetry } from '../lib/truckApi.js';
import { getTaiwanNow } from '../lib/timeUtils.js';
import {
  findNearbyTruckArrivals,
  formatArrivalMessage,
} from '../lib/coreProcessor.js';
import { sendLinePushMessage } from '../lib/lineClient.js';

// 強制關閉 DRY_RUN，因為我們要發送實體測試訊息
process.env.DRY_RUN = 'false';

async function runLiveTest() {
  console.log('='.repeat(70));
  console.log('🚀 開始執行垃圾車到站推播流程測試（實體發送模式）');
  console.log('='.repeat(70));

  // 1. 讀取 DB
  const { data: routes } = await supabase.from('routes').select('*').eq('is_active', true);
  const { data: stops } = await supabase.from('stops').select('*');
  const { data: lineGroups } = await supabase.from('line_groups').select('*').eq('is_active', true);

  // 2. 模擬車輛抵達「路竹區民有路55號」
  // 該站座標為 22.822194, 120.270422
  const simulatedTrucks = [
    {
      route_id: 'LZ01', // 假設這台車是跑 LZ01 路線
      car_id: 'TEST-8888',
      lat: 22.822100, // 距離約 135 公尺
      lng: 120.271500,
      time: new Date().toISOString(),
    },
    {
      route_id: 'LZ01', 
      car_id: 'TEST-9999',
      lat: 22.858100, // 距離中興路75號 (22.858, 120.259) 很近
      lng: 120.259100,
      time: new Date().toISOString(),
    }
  ];

  const stopSubscribersMap = new Map();
  for (const s of stops) {
    const groupIds = lineGroups.map((g) => g.group_id);
    stopSubscribersMap.set(String(s.id), new Set(groupIds));
  }

  const activeRoutesMap = new Map();
  for (const r of routes) {
    activeRoutesMap.set(String(r.id), r);
  }

  // 3. 執行核心比對
  const arrivals = findNearbyTruckArrivals(
    simulatedTrucks,
    stops,
    stopSubscribersMap,
    activeRoutesMap
  );

  console.log(`✓ 比對出 ${arrivals.length} 筆到站事件：`);
  arrivals.forEach((item, idx) => {
    console.log(`  [事件 ${idx + 1}] 車輛 ${item.truck.car_id} 到達站點「${item.stop.name}」 (距離: ${Math.round(item.distance)}m)`);
  });

  if (arrivals.length === 0) {
    console.error('未比對出任何事件，終止。');
    return;
  }

  // 4. 發送推播
  // 為了避免洗版，我們將兩個地點的結果合併成一則測試訊息發送
  let combinedMessage = '⚠️【系統測試】⚠️\n這是一則系統測試訊息，請忽略。\n\n目前測試涵蓋了兩個地點的接收狀況：\n';
  
  for (const arrival of arrivals) {
    combinedMessage += `\n📍 站點：${arrival.stop.name}\n`;
    combinedMessage += `🛣️ 路線：${arrival.route.name}\n`;
    combinedMessage += `📏 模擬距離：約 ${Math.round(arrival.distance)} 公尺\n`;
    combinedMessage += `🚛 測試車牌：${arrival.truck.car_id}\n`;
  }

  const targetGroup = lineGroups[0]?.group_id;
  if (!targetGroup) {
    console.error('找不到測試目標群組');
    return;
  }

  console.log(`\n準備發送測試訊息至群組: ${targetGroup}\n`);
  console.log('內容:\n' + combinedMessage);

  const res = await sendLinePushMessage(targetGroup, combinedMessage);
  
  console.log(`\n➤ 發送呼叫回傳狀態: status = ${res.status}, ok = ${res.ok}`);
  if (res.ok) {
    console.log('🎉 實體測試發送成功！');
  } else {
    console.error('❌ 發送失敗:', res.error);
  }
}

runLiveTest().catch(console.error);
