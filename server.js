/**
 * server.js
 * Google Cloud Run / Containerized Entrypoint for trash-alert-tw
 *
 * 支援以下路由：
 *   - GET  /               : 服務健康檢查
 *   - GET  /health         : 服務存活探針
 *   - ALL  /api/check-trucks : 垃圾車即時追蹤與推播排程
 *   - ALL  /api/check-weather: 氣象降雨預警排程
 *   - POST /api/line-webhook : LINE Messaging API Webhook
 */

import express from 'express';
import checkTrucksHandler from './api/check-trucks.js';
import checkWeatherHandler from './api/check-weather.js';
import lineWebhookHandler from './api/line-webhook.js';

// 全域未捕捉例外防護，避免容器無日誌靜默退出
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
const port = parseInt(process.env.PORT || '8080', 10);

console.log(`[Server] Initializing trash-alert-tw on Node.js ${process.version}...`);
console.log(`[Server] Configured listening PORT: ${port}`);

// 保留原始 Request Body 以供 LINE Webhook 進行精確 HMAC-SHA256 簽章比對
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
app.use(express.urlencoded({ extended: true }));

// 1. 健康檢查與存活探針 (Cloud Run Startup / Liveness Check)
app.get(['/', '/health'], (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'trash-alert-tw',
    timestamp: new Date().toISOString(),
  });
});

// 2. 核心 API 路由 (相容 Serverless HTTP 呼叫規格)
app.all('/api/check-trucks', (req, res) => checkTrucksHandler(req, res));
app.all('/api/check-weather', (req, res) => checkWeatherHandler(req, res));
app.all('/api/line-webhook', (req, res) => lineWebhookHandler(req, res));

// 3. 捕捉未定義路由
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not Found', path: req.path });
});

const server = app.listen(port, () => {
  console.log(`[Server] trash-alert-tw service successfully listening on port ${port}`);
});

// 優雅關機處理 (Graceful Shutdown)
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, closing HTTP server gracefully...');
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, closing HTTP server gracefully...');
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });
});
