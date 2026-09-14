/**
 * proxy/standalone/server.js
 * 獨立 Node.js HTTP Proxy Server (適用於 Zeabur、台灣本機、NAS 或 Docker)
 */

import http from 'node:http';

const PORT = process.env.PORT || 8080;
const PROXY_SECRET = process.env.PROXY_SECRET;
const TARGET_API_URL = 'https://clean.tnepb.gov.tw/WebService/WsSkyeyes.asmx/NewgetCarsinfo';
const REFERER_URL = 'https://clean.tnepb.gov.tw/index.aspx';

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-proxy-secret');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 健康檢查
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'tainan-epa-proxy' }));
  }

  // 密鑰檢查
  if (PROXY_SECRET) {
    const incoming = req.headers['x-proxy-secret'];
    if (incoming !== PROXY_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid proxy secret' }));
    }
  }

  const start = Date.now();
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

    const elapsed = Date.now() - start;
    const body = await upstreamRes.text();
    res.writeHead(upstreamRes.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'x-proxy-elapsed-ms': String(elapsed),
    });
    return res.end(body);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`[Proxy] 台灣出口轉發代理已啟動於 port ${PORT}`);
});
