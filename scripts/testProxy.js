/**
 * scripts/testProxy.js
 * 驗證台南轉發代理伺服器連線與天眼資料解包
 *
 * 使用方式：
 *   node scripts/testProxy.js <PROXY_URL> [PROXY_SECRET]
 * 或設定環境變數：
 *   TAINAN_PROXY_URL=https://... node scripts/testProxy.js
 */

import 'dotenv/config';
import { adaptTruckData } from '../lib/truckAdapter.js';

async function main() {
  const proxyUrl = process.argv[2] || process.env.TAINAN_PROXY_URL;
  const proxySecret = process.argv[3] || process.env.TAINAN_PROXY_SECRET;

  if (!proxyUrl) {
    console.error('❌ 請提供欲測試的代理網址:');
    console.error('   node scripts/testProxy.js <PROXY_URL> [PROXY_SECRET]');
    console.error('   例如: node scripts/testProxy.js https://asia-east1-myproject.cloudfunctions.net/tainanProxy mySecret123');
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log('🔍 測試台南出口代理端點:', proxyUrl);
  console.log('🔒 代理密鑰:', proxySecret ? '已設定 (隱藏)' : '無');
  console.log('='.repeat(70));

  const startTime = Date.now();
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TrashAlertTester/1.0',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (proxySecret) {
      headers['x-proxy-secret'] = proxySecret;
    }

    const res = await fetch(proxyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });

    const elapsed = Date.now() - startTime;
    console.log(`⏱️ 請求完成，耗時: ${elapsed} ms，HTTP 狀態碼: ${res.status}`);

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`❌ 代理端點回傳錯誤狀態碼 HTTP ${res.status}:`, errBody);
      process.exit(1);
    }

    const json = await res.json();
    console.log('✅ 成功取得 JSON 回應！');

    // 驗證能否透過 truckAdapter 解包
    const trucks = adaptTruckData(json);
    console.log(`🚛 經 truckAdapter 成功解析車輛數: ${trucks.length} 筆`);

    if (trucks.length > 0) {
      console.log('🔍 範例車輛動態 (前 3 筆):');
      trucks.slice(0, 3).forEach((t, idx) => {
        console.log(`   [${idx + 1}] 車號: ${t.car_id}, 路線: ${t.route_id}, 類別: ${t.waste_type}, 座標: (${t.lat}, ${t.lng})`);
      });

      const yongkang = trucks.filter((t) => t.route_id?.includes('永康') || t.car_id === '218-UW');
      console.log(`📍 永康相關車輛數: ${yongkang.length} 筆`);
    } else {
      console.warn('⚠️ 警告：取得資料為空或格式未被 truckAdapter 識別。');
    }

    console.log('\n🎉 代理伺服器驗證成功！可直接將此 URL 配置於 Vercel 的 TAINAN_PROXY_URL 環境變數。');
  } catch (err) {
    console.error('❌ 連線代理端點失敗:', err);
    process.exit(1);
  }
}

main();
