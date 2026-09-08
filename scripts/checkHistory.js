/**
 * 歷史記錄查詢：找出通知未發送的真正原因
 */
import 'dotenv/config';
import { supabase } from '../lib/supabaseClient.js';

async function checkHistory() {
  console.log('='.repeat(70));
  console.log('📋 歷史記錄深度查詢');
  console.log('='.repeat(70));

  // 0. execution_logs — 排程執行與車輛距離稽核日誌
  console.log('\n── [0] execution_logs（排程執行與車輛距離稽核日誌）──');
  try {
    const { data: execLogs, error: execErr } = await supabase
      .from('execution_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(15);

    if (execErr) {
      if (execErr.code === '42P01' || execErr.message?.includes('does not exist') || execErr.message?.includes('schema cache')) {
        console.log('  ⚠️ 資料庫尚未建立 execution_logs 資料表（請在 Supabase SQL Editor 執行 supabase/add_execution_logs.sql）');
      } else {
        console.error('  查詢失敗:', execErr.message);
      }
    } else if (!execLogs || execLogs.length === 0) {
      console.log('  ℹ️ 目前尚無 execution_logs 記錄（尚未有外部排程呼叫或剛建立表）。');
    } else {
      console.log(`  共 ${execLogs.length} 筆最近呼叫記錄：`);
      execLogs.forEach((l) => {
        const badge = l.status === 'success' ? '✅' : l.status === 'unauthorized' ? '🚫' : l.status === 'skipped' ? '⏭️' : '⚠️';
        const closest = l.details?.closestSummary ? `| 最近: ${l.details.closestSummary}` : '';
        console.log(`  ${badge} [${l.taiwan_time || l.created_at}] 來源: ${l.trigger_source || 'unknown'} | 狀態: ${l.status} (${l.reason}) ${closest}`);
      });
    }
  } catch (err) {
    console.warn('  查詢 execution_logs 發生例外:', err.message);
  }

  // 1. notification_logs — 有沒有任何歷史推播記錄
  console.log('\n── [1] notification_logs（歷史推播記錄）──');
  const { data: logs, error: logErr } = await supabase
    .from('notification_logs')
    .select('*')
    .order('sent_at', { ascending: false })
    .limit(20);
  
  if (logErr) console.error('  查詢失敗:', logErr.message);
  else if (!logs || logs.length === 0) console.log('  ❌ 完全沒有任何推播記錄！系統從未成功發送過到站通知。');
  else {
    console.log(`  共 ${logs.length} 筆記錄：`);
    logs.forEach(l => console.log(`  ${l.sent_at} | group: ${l.group_id?.slice(-8)} | route: ${l.route_id} | stop: ${l.stop_id} | car: ${l.car_id}`));
  }

  // 2. system_quota — 配額使用歷史
  console.log('\n── [2] system_quota（配額使用歷史）──');
  const { data: quotas } = await supabase
    .from('system_quota')
    .select('*')
    .order('month', { ascending: false })
    .limit(5);
  
  if (!quotas || quotas.length === 0) console.log('  無記錄');
  else quotas.forEach(q => console.log(`  ${q.month}: used=${q.used_count}, melted=${q.is_melted}`));

  // 3. daily_status — 完整歷史（API 失敗、停收狀態）
  console.log('\n── [3] daily_status（每日狀態完整歷史）──');
  const { data: statuses } = await supabase
    .from('daily_status')
    .select('*')
    .order('date', { ascending: false })
    .limit(14);
  
  if (!statuses || statuses.length === 0) console.log('  無記錄');
  else {
    statuses.forEach(d => {
      const flags = [];
      if (d.is_suspended) flags.push('🛑停收');
      if (d.is_paused) flags.push('⏸暫停');
      if (d.api_fail_count > 0) flags.push(`⚠️fail=${d.api_fail_count}`);
      console.log(`  ${d.date} | ${flags.join(' ') || '✅正常'} | updated: ${d.updated_at || d.fetched_at} | error: ${d.last_api_error || 'none'}`);
    });
  }

  // 4. subscriptions — 歷史訂閱（含建立時間）
  console.log('\n── [4] subscriptions（訂閱記錄與建立時間）──');
  const { data: subs } = await supabase
    .from('subscriptions')
    .select('id, group_id, stop_id, created_at')
    .order('created_at', { ascending: true });
  
  if (!subs || subs.length === 0) console.log('  ❌ 訂閱表為空！');
  else subs.forEach(s => console.log(`  [${s.id}] group: ${s.group_id?.slice(-8)} → stop: ${s.stop_id} | created: ${s.created_at}`));

  // 5. line_groups — 群組登錄時間
  console.log('\n── [5] line_groups（群組登錄歷史）──');
  const { data: groups } = await supabase
    .from('line_groups')
    .select('*')
    .order('created_at', { ascending: true });
  
  if (!groups || groups.length === 0) console.log('  無群組');
  else groups.forEach(g => console.log(`  [${g.id}] ${g.group_id?.slice(0,8)}...${g.group_id?.slice(-4)} | name: ${g.group_name} | active: ${g.is_active} | created: ${g.created_at}`));

  // 6. route_linids — 車輛觀測記錄
  console.log('\n── [6] route_linids（車輛信任觀測記錄）──');
  const { data: linids } = await supabase
    .from('route_linids')
    .select('*')
    .order('last_seen_at', { ascending: false })
    .limit(20);
  
  if (!linids || linids.length === 0) console.log('  無觀測記錄（系統從未執行到 geofence 比對階段）');
  else linids.forEach(r => console.log(`  route: ${r.route_id} | linid: ${r.linid} | count: ${r.observed_count} | first: ${r.first_seen_at} | last: ${r.last_seen_at}`));

  // 7. routes & stops
  console.log('\n── [7] routes（路線設定）──');
  const { data: routes } = await supabase.from('routes').select('*');
  routes?.forEach(r => console.log(`  [${r.id}] ${r.name} | active_days: ${JSON.stringify(r.active_days)} | is_active: ${r.is_active}`));

  console.log('\n── [8] stops（站點設定）──');
  const { data: stops } = await supabase.from('stops').select('*');
  stops?.forEach(s => console.log(`  [${s.id}] ${s.name} | route: ${s.route_id} | (${s.lat}, ${s.lng}) | schedule: ${s.schedule_time}`));

  console.log('\n' + '='.repeat(70));
}

checkHistory().catch(console.error);
