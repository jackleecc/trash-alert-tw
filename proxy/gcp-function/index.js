import functions from '@google-cloud/functions-framework';

// 僅在特定環境缺少 TWCA/GCA 憑證庫且明確設定 ALLOW_INSECURE_TLS 時才允許降級，防範 MITM (FIX-7)
if (process.env.ALLOW_INSECURE_TLS === 'true') {
  console.warn('⚠️ [TLS Warning] ALLOW_INSECURE_TLS 已啟用，暫時停用嚴格 TLS 憑證檢查');
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const TARGET_API_URL = 'https://clean.tnepb.gov.tw/WebService/WsSkyeyes.asmx/NewgetCarsinfo';
const REFERER_URL = 'https://clean.tnepb.gov.tw/index.aspx';

functions.http('tainanProxy', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-proxy-secret');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  // 診斷端點：可在瀏覽器輸入 https://...run.app/diag 查看當前出口 IP 與上游連線
  if (req.path === '/diag' || req.url.includes('/diag') || req.query.diag) {
    let myIp = 'unknown';
    try {
      const ipRes = await fetch('https://api.ipify.org?format=json').then((r) => r.json());
      myIp = ipRes.ip;
    } catch (e) {
      myIp = e.message;
    }

    let upstreamStatus = 'unknown';
    try {
      const upRes = await fetch(TARGET_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Referer': REFERER_URL,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({}),
      });
      upstreamStatus = `HTTP ${upRes.status} OK`;
    } catch (e) {
      const cause = e.cause ? (e.cause.message || e.cause.code || JSON.stringify(e.cause)) : 'none';
      upstreamStatus = `Error: ${e.message} (Cause: ${cause})`;
    }

    return res.json({ outboundIp: myIp, upstreamStatus });
  }

  // 密鑰檢查 (若有在環境變數設定 PROXY_SECRET)
  const secret = process.env.PROXY_SECRET;
  if (secret) {
    const incomingSecret = req.headers['x-proxy-secret'];
    if (incomingSecret !== secret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized: Invalid proxy secret' });
    }
  }

  const start = Date.now();
  try {
    const upstreamRes = await fetch(TARGET_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Referer': REFERER_URL,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({}),
    });

    const elapsed = Date.now() - start;
    const body = await upstreamRes.text();

    res.status(upstreamRes.status);
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('x-proxy-elapsed-ms', String(elapsed));
    return res.send(body);
  } catch (err) {
    const elapsed = Date.now() - start;
    const causeMsg = err.cause ? (err.cause.message || err.cause.code || JSON.stringify(err.cause)) : '';
    return res.status(502).json({
      ok: false,
      error: `GCP asia-east1 proxy error: ${err.message}${causeMsg ? ' (' + causeMsg + ')' : ''}`,
      elapsedMs: elapsed,
    });
  }
});
