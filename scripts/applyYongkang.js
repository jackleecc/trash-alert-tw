import 'dotenv/config';
import { supabase } from '../lib/supabaseClient.js';

async function applyYongkang() {
  console.log('── [1/4] 建立/更新路線 (70 - 永康區第70線) ──');
  const routePayload = {
    id: '70',
    name: '永康區第70線 (永康里/文化路)',
    city: '台南市',
    active_days: [1, 2, 4, 6],
    description: '台南市永康區永康里、網寮里、西灣里文化路及周邊清運路網',
    is_active: true,
  };
  const { data: routeData, error: routeErr } = await supabase
    .from('routes')
    .upsert(routePayload, { onConflict: 'id' })
    .select();
  if (routeErr) throw new Error(`routes upsert 失敗: ${routeErr.message}`);
  console.log('✅ 路線已寫入:', routeData);

  console.log('\n── [2/4] 建立/更新清運站點 ──');
  const stopsPayload = [
    {
      route_id: '70',
      name: '文化路128巷10號',
      lat: 23.016137,
      lng: 120.257498,
      order_index: 78,
      schedule_time: '19:37:00',
    },
    {
      route_id: '70',
      name: '永康區文化路40號',
      lat: 23.016963,
      lng: 120.261576,
      order_index: 79,
      schedule_time: '19:42:00',
    },
    {
      route_id: '70',
      name: '永忠路18號',
      lat: 23.01722,
      lng: 120.260959,
      order_index: 80,
      schedule_time: '19:44:00',
    },
  ];

  for (const stop of stopsPayload) {
    // 檢查站點是否存在
    const { data: existing } = await supabase
      .from('stops')
      .select('id')
      .eq('route_id', stop.route_id)
      .eq('name', stop.name)
      .maybeSingle();

    if (existing) {
      await supabase.from('stops').update(stop).eq('id', existing.id);
      console.log(`  更新站點: ${stop.name} (id=${existing.id})`);
    } else {
      const { data: inserted, error: insertErr } = await supabase
        .from('stops')
        .insert(stop)
        .select()
        .single();
      if (insertErr) throw new Error(`新增站點失敗: ${insertErr.message}`);
      console.log(`  新增站點: ${stop.name} (id=${inserted.id})`);
    }
  }

  // 取得目標站點 ID
  const { data: targetStop } = await supabase
    .from('stops')
    .select('id, name')
    .eq('route_id', '70')
    .eq('name', '永康區文化路40號')
    .single();
  console.log(`✅ 目標站點 ID 為: ${targetStop.id} (${targetStop.name})`);

  console.log('\n── [3/4] 更新 LINE 群組資料 ──');
  const groupPayload = {
    group_id: 'C6f0ecae71723b8aef86290448871e6fa',
    group_name: '台南市/永康文化路_e6fa',
    is_active: true,
  };
  const { data: groupData, error: groupErr } = await supabase
    .from('line_groups')
    .upsert(groupPayload, { onConflict: 'group_id' })
    .select();
  if (groupErr) throw new Error(`line_groups upsert 失敗: ${groupErr.message}`);
  console.log('✅ LINE 群組已更新:', groupData);

  console.log('\n── [4/4] 建立群組與站點專屬訂閱綁定 ──');
  const subPayload = {
    group_id: 'C6f0ecae71723b8aef86290448871e6fa',
    stop_id: targetStop.id,
  };
  const { data: subData, error: subErr } = await supabase
    .from('subscriptions')
    .upsert(subPayload, { onConflict: 'group_id,stop_id' })
    .select();
  if (subErr) throw new Error(`subscriptions upsert 失敗: ${subErr.message}`);
  console.log('✅ 訂閱關聯已建立:', subData);

  console.log('\n🎉 台南市永康區文化路40號 綁定與資料建立全數成功！');
}

applyYongkang().catch((err) => {
  console.error('❌ 執行失敗:', err);
  process.exit(1);
});
