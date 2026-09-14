/**
 * proxy/cloudflare-worker/worker.js
 * Cloudflare Worker 輕量轉發代理 (適用於 Cloudflare Dashboard 直接貼上部署)
 */

const TARGET_API_URL = 'https://clean.tnepb.gov.tw/WebService/WsSkyeyes.asmx/NewgetCarsinfo';
const REFERER_URL = 'https://clean.tnepb.gov.tw/index.aspx';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-proxy-secret',
        },
      });
    }

    // 密鑰檢查 (若 Worker 綁定了 PROXY_SECRET 變數)
    const secret = env.PROXY_SECRET;
    if (secret) {
      const incomingSecret = request.headers.get('x-proxy-secret');
      if (incomingSecret !== secret) {
        return new Response(JSON.stringify({ ok: false, error: 'Unauthorized: Invalid proxy secret' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

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

      const body = await upstreamRes.text();
      return new Response(body, {
        status: upstreamRes.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ ok: false, error: `Cloudflare Worker proxy error: ${err.message}` }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};
