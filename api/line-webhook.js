/**
 * api/line-webhook.js
 * Cloud Run HTTP Handler — LINE Messaging API Webhook
 *
 * 功能：
 *   1. 接收 LINE 平台送來的 Webhook 事件（支援 join, message 等）。
 *   2. 當收到來自群組的任何事件時，自動在 Console 輸出明顯的 Group ID，並自動登錄至 Supabase 資料庫。
 *   3. 當 Bot 被加入群組時，主動在群組回覆 Group ID。
 *   4. 當群組內有人傳送包含「群組ID」、「/id」、「id」、「group」等字眼時，主動回覆 Group ID。
 *   5. 一對一私訊時，自動回覆使用者的 User ID。
 */

import { replyLineMessage } from '../lib/lineClient.js';
import { supabase } from '../lib/supabaseClient.js';
import {
  verifyWebhookSignature,
  CHANNEL_TAOYUAN,
  CHANNEL_DEFAULT,
} from '../lib/channelService.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  const signature = req.headers['x-line-signature'] || '';
  const rawBody =
    req.rawBody ||
    (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

  const verifyResult = verifyWebhookSignature(rawBody, signature);
  if (!verifyResult.ok) {
    console.warn('[Webhook] LINE 簽章驗證失敗，拒絕處理此請求。');
    return res.status(401).json({ ok: false, error: 'Invalid signature' });
  }

  const channelId = verifyResult.channelId || CHANNEL_DEFAULT;
  const events = (req.body && req.body.events) || [];
  console.log(`[Webhook] 收到 ${events.length} 個 LINE 事件 (來源頻道: ${channelId})`);

  for (const event of events) {
    const replyToken = event.replyToken;
    const source = event.source || {};
    const groupId = source.groupId || source.roomId;
    const userId = source.userId;

    // 只要有任何群組事件，第一時間在日誌與 DB 記錄
    if (groupId) {
      console.log('================================================================');
      console.log(`🎯【LINE 群組 ID 偵測成功】: ${groupId}`);
      console.log('================================================================');

      // 自動嘗試寫入 Supabase line_groups 表，省去手動執行的麻煩
      try {
        const defaultGroupName =
          channelId === CHANNEL_TAOYUAN
            ? `桃園市/楊梅通知群組_${groupId.slice(-4)}`
            : `新北市/汐止通知群組_${groupId.slice(-4)}`;

        await supabase.from('line_groups').upsert(
          {
            group_id: groupId,
            group_name: defaultGroupName,
            channel_id: channelId,
            is_active: true,
          },
          { onConflict: 'group_id' }
        );
        console.log(`[Webhook] ✅ 已自動將群組 ${groupId} 登錄至資料庫 line_groups 表 (頻道: ${channelId})！`);
      } catch (err) {
        console.warn(`[Webhook] 自動登錄至 line_groups 略過: ${err.message}`);
      }
    }

    // 1. Bot 被邀請加入群組事件 (join)
    if (event.type === 'join' && groupId) {
      console.log(`[Webhook] 🤖 Bot 已加入新群組！Group ID: ${groupId} (頻道: ${channelId})`);
      const text = [
        `大家好！`,
        `我是【垃圾車即時到站通知】。`,
        `感謝邀請加入群組！🚛🎉`,
        ``,
        `💡【注意事項】`,
        `本帳號為「自動化到站推播與氣象預警」系統專用，採單向廣播運作，無法接收與個別回覆聊天訊息，敬請見諒。`,
        ``,
        `📌【功能說明】`,
        `1. 當清運車輛即將抵達時，系統將主動發布提醒。`,
        `2. 遭遇降雨或空氣不佳時，亦會同步發送環境預警。`,
        ``,
        `📍 本群組 ID 為：`,
        `${groupId}`,
        `（系統已自動將此群組登錄至資料庫！）`,
        ``,
        `祝大家今天也有美好的一天！ 😊`,
      ].join('\n');

      if (replyToken && replyToken !== '00000000000000000000000000000000') {
        const replyRes = await replyLineMessage(replyToken, text, { channelId });
        console.log(`[Webhook] 發送加入群組通知結果:`, replyRes);
      }
      continue;
    }

    // 2. 文字訊息事件 (message)
    if (event.type === 'message' && event.message?.type === 'text') {
      const userText = (event.message.text || '').trim();
      console.log(`[Webhook] 收到文字訊息: "${userText}"，來自對象: ${groupId || userId} (頻道: ${channelId})`);

      // 寬鬆比對查詢關鍵字：包含 id、群組、group 等皆觸發回覆
      const isIdQuery = /(id|群組|group|\/id|查詢)/i.test(userText);

      if (isIdQuery) {
        let replyText = '';
        if (groupId) {
          replyText = [
            `📍 本群組 ID 為：`,
            `${groupId}`,
            ``,
            `（系統已自動記錄此 ID 至資料庫 line_groups 表）`,
          ].join('\n');
        } else if (userId) {
          replyText = [
            `👤 您的個人 LINE User ID 為：`,
            `${userId}`,
          ].join('\n');
        }

        if (replyText && replyToken && replyToken !== '00000000000000000000000000000000') {
          const replyRes = await replyLineMessage(replyToken, replyText, { channelId });
          console.log(`[Webhook] 回覆查詢 ID 結果:`, replyRes);
        }
      }
    }
  }

  return res.status(200).json({ ok: true });
}
