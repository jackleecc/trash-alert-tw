/**
 * api/line-webhook.js
 * Vercel Serverless Function — LINE Messaging API Webhook
 *
 * 功能：
 *   1. 接收 LINE 平台送來的 Webhook 事件（支援 join, message 等）。
 *   2. 當 Bot 被加入群組時，自動在群組回覆該群組的 Group ID。
 *   3. 當群組內發送「群組ID」、「/id」、「id」時，自動回覆該 Group ID。
 *   4. 一對一私訊時，自動回覆使用者的 User ID。
 *   5. 可選驗證 X-Line-Signature（若環境變數有設定 LINE_CHANNEL_SECRET）。
 */

import crypto from 'node:crypto';
import { replyLineMessage } from '../lib/lineClient.js';

/**
 * 驗證 LINE Webhook 簽章
 * @param {string} bodyString
 * @param {string} signature
 * @param {string} channelSecret
 * @returns {boolean}
 */
function verifyLineSignature(bodyString, signature, channelSecret) {
  if (!channelSecret || !signature) return true; // 若未設定 Secret 則安全略過
  try {
    const hash = crypto
      .createHmac('SHA256', channelSecret)
      .update(bodyString)
      .digest('base64');
    return hash === signature;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const signature = req.headers['x-line-signature'] || '';
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  // 取得原始 Body 字串用於簽章校驗
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});

  if (channelSecret && !verifyLineSignature(rawBody, signature, channelSecret)) {
    console.warn('[Webhook] 簽章驗證失敗，拒絕請求。');
    return res.status(401).json({ ok: false, error: 'Invalid Signature' });
  }

  const events = (req.body && req.body.events) || [];
  console.log(`[Webhook] 收到 ${events.length} 個 LINE 事件`);

  for (const event of events) {
    const replyToken = event.replyToken;
    const source = event.source || {};
    const groupId = source.groupId || source.roomId;
    const userId = source.userId;

    // 1. Bot 被邀請加入群組事件 (join)
    if (event.type === 'join' && groupId) {
      console.log(`[Webhook] 🤖 Bot 已加入新群組！Group ID: ${groupId}`);
      const text = [
        `🎉 垃圾車到站推播 Bot 已成功加入群組！`,
        ``,
        `📍 本群組 ID 為：`,
        `${groupId}`,
        ``,
        `請複製此 ID 並填入資料庫 line_groups 表以完成綁定。`,
      ].join('\n');

      if (replyToken) {
        await replyLineMessage(replyToken, text);
      }
      continue;
    }

    // 2. 文字訊息事件 (message)
    if (event.type === 'message' && event.message?.type === 'text') {
      const userText = (event.message.text || '').trim();

      // 檢查是否詢問 ID 關鍵字
      const isIdQuery = /^(群組id|id|\/id|groupid|\/groupid)$/i.test(userText);

      if (isIdQuery) {
        let replyText = '';
        if (groupId) {
          console.log(`[Webhook] 🔍 查詢群組 ID：${groupId}`);
          replyText = [
            `📍 本群組 ID 為：`,
            `${groupId}`,
            ``,
            `（可直接複製此 ID 填入資料庫 line_groups 與 subscriptions 完成訂閱）`,
          ].join('\n');
        } else if (userId) {
          console.log(`[Webhook] 🔍 查詢個人 User ID：${userId}`);
          replyText = [
            `👤 您的個人 LINE User ID 為：`,
            `${userId}`,
          ].join('\n');
        }

        if (replyText && replyToken) {
          await replyLineMessage(replyToken, replyText);
        }
      }
    }
  }

  return res.status(200).json({ ok: true });
}
