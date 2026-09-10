/**
 * 驗證腳本：確認訂閱記錄是否存在 + 發送測試推播
 */
import 'dotenv/config';
import { supabase } from '../lib/supabaseClient.js';
import { sendLinePushMessage } from '../lib/lineClient.js';

const GROUP_ID = 'C8b514cecb1141d158bb44a19f33eb291';

async function verify() {
  console.log('='.repeat(60));
  console.log('🔍 驗證資料庫訂閱狀態與 LINE 推播連線');
  console.log('='.repeat(60));

  // 1. 檢查 line_groups
  console.log('\n[1/4] 檢查 line_groups...');
  const { data: groups, error: gErr } = await supabase
    .from('line_groups')
    .select('*')
    .eq('group_id', GROUP_ID);
  
  if (gErr) {
    console.error('❌ 查詢 line_groups 失敗:', gErr.message);
    return;
  }
  console.log(`  結果: ${groups.length > 0 ? '✅ 群組已登錄' : '❌ 群組不存在!'}`);
  if (groups.length > 0) console.log(`  ${JSON.stringify(groups[0])}`);

  // 2. 檢查 stops
  console.log('\n[2/4] 檢查 stops (221010 路線)...');
  const { data: stops, error: sErr } = await supabase
    .from('stops')
    .select('*')
    .eq('route_id', '221010');

  if (sErr) {
    console.error('❌ 查詢 stops 失敗:', sErr.message);
    return;
  }
  console.log(`  結果: ${stops.length > 0 ? `✅ 找到 ${stops.length} 個站點` : '❌ 無站點!'}`);
  stops.forEach(s => console.log(`  - [${s.id}] ${s.name} (${s.lat}, ${s.lng})`));

  // 3. 檢查 subscriptions
  console.log('\n[3/4] 檢查 subscriptions...');
  const { data: subs, error: subErr } = await supabase
    .from('subscriptions')
    .select('group_id, stop_id')
    .eq('group_id', GROUP_ID);

  if (subErr) {
    console.error('❌ 查詢 subscriptions 失敗:', subErr.message);
    return;
  }
  console.log(`  結果: ${subs.length > 0 ? `✅ 找到 ${subs.length} 筆訂閱` : '❌ 訂閱為空! 這是通知無法發送的根因!'}`);
  subs.forEach(s => console.log(`  - group: ${s.group_id}, stop_id: ${s.stop_id}`));

  // 4. 發送測試推播
  if (subs.length > 0) {
    console.log('\n[4/4] 發送 LINE 測試推播...');
    const msg = `✅【訂閱修復驗證】\n\n系統已成功建立站點訂閱關聯！\n📍 汐萬路一段333巷口\n🛣️ 路線：221010\n\n垃圾車靠近時（250m 內）將自動推播通知。\n⏰ 通知時段：每日 17:00-21:59`;
    const res = await sendLinePushMessage(GROUP_ID, msg);
    console.log(`  發送結果: status=${res.status}, ok=${res.ok}`);
    if (res.ok) {
      console.log('  🎉 推播成功！請檢查 LINE 群組是否收到訊息。');
    } else {
      console.error('  ❌ 推播失敗:', res.error);
    }
  } else {
    console.log('\n[4/4] ⏭️ 跳過推播測試（訂閱為空，請先執行修復 SQL）');
  }

  console.log('\n' + '='.repeat(60));
}

verify().catch(console.error);
