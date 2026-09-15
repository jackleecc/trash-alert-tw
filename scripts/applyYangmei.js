import 'dotenv/config';
import { supabase } from '../lib/supabaseClient.js';

const TARGET_GROUP_ID = 'Cbc0aef28eb6226fafe1ea7e5a6e4487e';

async function applyYangmei() {
  console.log('── [1/5] 建立/更新路線 (lagi2-006_2_21 - 楊梅區 垃圾清運路十七線) ──');
  const routePayload = {
    id: 'lagi2-006_2_21',
    name: '楊梅區 垃圾清運路十七線',
    city: '桃園市',
    active_days: [1, 2, 4, 5, 6],
    description: '桃園市楊梅區大平里、中山南路及周邊清運路網',
    is_active: true,
  };
  const { data: routeData, error: routeErr } = await supabase
    .from('routes')
    .upsert(routePayload, { onConflict: 'id' })
    .select();
  if (routeErr) throw new Error(`routes upsert 失敗: ${routeErr.message}`);
  console.log('✅ 路線已寫入:', routeData);

  console.log('\n── [2/5] 建立/更新清運站點 ──');
  const stopsPayload = [
    {
      route_id: 'lagi2-006_2_21',
      name: '中山南路100號',
      lat: 24.907498,
      lng: 121.137464,
      order_index: 2,
      schedule_time: '17:24:00',
    },
    {
      route_id: 'lagi2-006_2_21',
      name: '楊梅區中山南路146號',
      lat: 24.907648,
      lng: 121.136540,
      order_index: 3,
      schedule_time: '17:25:00',
    },
    {
      route_id: 'lagi2-006_2_21',
      name: '中山南路336巷口',
      lat: 24.906638,
      lng: 121.134060,
      order_index: 4,
      schedule_time: '17:27:00',
    },
  ];

  for (const stop of stopsPayload) {
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
    .eq('route_id', 'lagi2-006_2_21')
    .eq('name', '楊梅區中山南路146號')
    .single();
  console.log(`✅ 目標站點 ID 為: ${targetStop.id} (${targetStop.name})`);

  console.log('\n── [3/5] 建立/更新信任車號與路線 linids ──');
  const linidsPayload = [
    {
      route_id: 'lagi2-006_2_21',
      linid: 'KEK-3178',
      observed_count: 1,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
    {
      route_id: 'lagi2-006_2_21',
      linid: 'lagi2-006_2_21',
      observed_count: 1,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    },
  ];

  for (const item of linidsPayload) {
    await supabase
      .from('route_linids')
      .upsert(item, { onConflict: 'route_id,linid' });
    console.log(`  信任車次登錄: route=${item.route_id}, linid=${item.linid}`);
  }

  console.log('\n── [4/5] 更新 LINE 群組資料 ──');
  const groupPayload = {
    group_id: TARGET_GROUP_ID,
    group_name: '桃園市/楊梅中山南路146號_487e',
    is_active: true,
  };
  const { data: groupData, error: groupErr } = await supabase
    .from('line_groups')
    .upsert(groupPayload, { onConflict: 'group_id' })
    .select();
  if (groupErr) throw new Error(`line_groups upsert 失敗: ${groupErr.message}`);
  console.log('✅ LINE 群組已更新:', groupData);

  console.log('\n── [5/5] 建立群組與站點專屬訂閱綁定 ──');
  const subPayload = {
    group_id: TARGET_GROUP_ID,
    stop_id: targetStop.id,
  };
  const { data: subData, error: subErr } = await supabase
    .from('subscriptions')
    .upsert(subPayload, { onConflict: 'group_id,stop_id' })
    .select();
  if (subErr) throw new Error(`subscriptions upsert 失敗: ${subErr.message}`);
  console.log('✅ 訂閱關聯已建立:', subData);

  console.log('\n🎉 桃園市楊梅區中山南路146號 站點資料建立與訂閱綁定全數成功！');
}

applyYangmei().catch((err) => {
  console.error('❌ 執行失敗:', err);
  process.exit(1);
});
