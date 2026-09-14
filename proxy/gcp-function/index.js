/**
 * proxy/gcp-function/index.js
 * Google Cloud Functions (2nd gen) / Cloud Run 輕量轉發代理 (Region: asia-east1 台灣彰化)
 *
 * 用途：
 *   讓託管於境外 (如 Vercel 香港) 的服務透過 GCP 台灣原生機房 IP 存取臺南市環保局天眼系統，
 *   避開公家機關 HiNet Geo-IP 境外防火牆阻斷。
 */

const TARGET_API_URL = 'https://clean.tnepb.gov.tw/WebService/WsSkyeyes.asmx/NewgetCarsinfo';
const REFERER_URL = 'https://clean.tnepb.gov.tw/index.aspx';

/**
 * Cloud Function Entrypoint
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function tainanProxy(req, res) {
  // 1. 跨來源與請求方法支援 (支援 GET 與 POST)
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-proxy-secret');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  // 2. 密鑰授權驗證 (若有設定環境變數 PROXY_SECRET)
  const configuredSecret = process.env.PROXY_SECRET;
  if (configuredSecret) {
    const incomingSecret = req.headers['x-proxy-secret'];
    if (incomingSecret !== configuredSecret) {
      console.warn('[Proxy] 未授權的連線請求，密鑰不相符。');
      return res.status(401).json({ ok: false, error: 'Unauthorized: Invalid proxy secret' });
    }
  }

  // 3. 轉發請求至臺南市環保局天眼 WebService
  const startTime = Date.now();
  try {
    const upstreamRes = await fetch(TARGET_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Referer': REFERER_URL,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({}),
    });

    const elapsedMs = Date.now() - startTime;
    if (!upstreamRes.ok) {
      console.error(`[Proxy] 上游 API 回傳錯誤 HTTP ${upstreamRes.status} (${elapsedMs}ms)`);
      return res.status(upstreamRes.status).json({
        ok: false,
        error: `Upstream HTTP ${upstreamRes.status}`,
        elapsedMs,
      });
    }

    const jsonText = await upstreamRes.text();
    console.log(`[Proxy] 成功抓取上游天眼資料 (${elapsedMs}ms, 長度: ${jsonText.length} bytes)`);

    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('x-proxy-elapsed-ms', String(elapsedMs));
    return res.status(200).send(jsonText);
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    console.error(`[Proxy] 連線上游失敗 (${elapsedMs}ms):`, err);
    return res.status(502).json({
      ok: false,
      error: `Proxy upstream connect error: ${err.message}`,
      elapsedMs,
    });
  }
}
