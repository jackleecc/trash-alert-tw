import 'dotenv/config';
import { supabase } from '../lib/supabaseClient.js';
import { XIZHI_221010_REAL_STOPS } from '../test/fixtures/xizhi221010Stops.js';

async function main() {
  console.log('[Seed] 開始更新汐止 221010 路線拓撲與淨化信任名單...');

  // 1. 更新 Stop 3 (汐萬路一段333巷口)
  const { error: updateErr } = await supabase
    .from('stops')
    .update({
      order_index: 17,
      schedule_time: '19:56:00',
    })
    .eq('id', 3);

  if (updateErr) {
    console.error('[Seed] 更新 Stop 3 失敗:', updateErr.message);
  } else {
    console.log('[Seed] ✅ Stop 3 更新完成 (order_index: 17)');
  }

  // 2. 檢查目前已存在的 stops
  const { data: existingStops, error: checkErr } = await supabase
    .from('stops')
    .select('id, name, order_index')
    .eq('route_id', '221010');

  if (checkErr) {
    console.error('[Seed] 查詢現存站點失敗:', checkErr.message);
    process.exit(1);
  }

  const existingNames = new Set((existingStops || []).map((s) => s.name));
  const stopsToInsert = XIZHI_221010_REAL_STOPS
    .filter((s) => s.rank !== 17 && !existingNames.has(s.name))
    .map((s) => ({
      route_id: '221010',
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      order_index: s.rank,
      schedule_time: s.schedule_time,
    }));

  if (stopsToInsert.length > 0) {
    console.log(`[Seed] 正在插入 ${stopsToInsert.length} 個相鄰站點拓撲...`);
    const { data: inserted, error: insertErr } = await supabase
      .from('stops')
      .insert(stopsToInsert)
      .select('id, name');

    if (insertErr) {
      console.error('[Seed] 插入相鄰站點失敗:', insertErr.message);
    } else {
      console.log(`[Seed] ✅ 成功插入 ${inserted.length} 個站點！`);
    }
  } else {
    console.log('[Seed] 所有拓撲站點已存在，略過插入。');
  }

  // 3. 淨化 route_linids
  console.log('[Seed] 正在淨化 route_linids...');
  const { error: delErr } = await supabase
    .from('route_linids')
    .delete()
    .eq('route_id', '221010')
    .neq('linid', '221010');

  if (delErr) {
    console.error('[Seed] 刪除污染 linid 失敗:', delErr.message);
  } else {
    console.log('[Seed] ✅ 成功清除 221010 上的所有非官方污染 linid！');
  }

  // 4. 確保 221010 在 route_linids 具備高信任度
  const { error: upsertErr } = await supabase
    .from('route_linids')
    .upsert({
      route_id: '221010',
      linid: '221010',
      observed_count: 99,
      last_seen_at: new Date().toISOString(),
    });

  if (upsertErr) {
    console.error('[Seed] 更新 221010 信任度失敗:', upsertErr.message);
  } else {
    console.log('[Seed] ✅ 路線 221010 官方信任度已鎖定為 99！');
  }

  console.log('[Seed] 拓撲與信任名單更新完畢！');
  process.exit(0);
}

main().catch((err) => {
  console.error('[Seed] 例外錯誤:', err);
  process.exit(1);
});
