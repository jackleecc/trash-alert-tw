/**
 * lib/lineClient.js
 * LINE Messaging API 客戶端模組
 *
 * 用於向指定的 LINE 群組或使用者發送 Push Message。
 */

import { supabase } from './supabaseClient.js';

const LINE_API_URL = 'https://api.line.me/v2/bot/message/push';

/**
 * 向單一 LINE Group 或 User ID 發送文字推播訊息。
 *
 * @param {string} to - LINE Group ID 或 User ID
 * @param {string} text - 要發送的文字訊息
 * @returns {Promise<{ ok: boolean, status: number, data?: any, error?: string }>}
 */
export async function sendLinePushMessage(to, text) {
  if (process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1') {
    console.log(`[LINE][DRY_RUN] 🛡️ 模擬推播模式（已攔截，未對 LINE 伺服器發送）：`);
    console.log(`[LINE][DRY_RUN]   ➤ 收件對象: ${to}`);
    console.log(`[LINE][DRY_RUN]   ➤ 訊息內容:\n${text}\n`);
    return { ok: true, status: 200, dryRun: true };
  }

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.warn('[LINE] 尚未設定 LINE_CHANNEL_ACCESS_TOKEN，跳過實際推播。');
    return { ok: false, status: 0, error: 'MISSING_LINE_TOKEN' };
  }

  if (!to || !text) {
    return { ok: false, status: 400, error: 'INVALID_PAYLOAD' };
  }

  try {
    const response = await fetch(LINE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to,
        messages: [
          {
            type: 'text',
            text,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[LINE] 推播失敗 (HTTP ${response.status}): ${errBody}`);
      return { ok: false, status: response.status, error: errBody };
    }

    return { ok: true, status: response.status };
  } catch (err) {
    console.error(`[LINE] 網路連線錯誤: ${err.message}`);
    return { ok: false, status: 500, error: err.message };
  }
}

/**
 * 向所有已註冊的 LINE 群組發送系統廣播告警訊息。
 *
 * @param {string} alertText - 告警文字內容
 */
export async function broadcastLineAlert(alertText) {
  try {
    const { data: groups, error } = await supabase
      .from('line_groups')
      .select('group_id')
      .eq('is_active', true);

    if (error) {
      console.error(`[LINE] 讀取 line_groups 失敗: ${error.message}`);
      return;
    }

    if (!groups || groups.length === 0) {
      console.warn('[LINE] 目前無任何註冊的 LINE 群組可接收告警。');
      return;
    }

    for (const group of groups) {
      if (group.group_id) {
        await sendLinePushMessage(group.group_id, alertText);
      }
    }
  } catch (err) {
    console.error(`[LINE] 廣播告警發生未預期錯誤: ${err.message}`);
  }
}

const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

/**
 * 回覆 LINE Webhook 訊息 (Reply Message，不佔用 Push Message 額度)
 *
 * @param {string} replyToken
 * @param {string} text
 * @returns {Promise<{ ok: boolean, status: number, error?: string, dryRun?: boolean }>}
 */
export async function replyLineMessage(replyToken, text) {
  if (process.env.DRY_RUN === 'true' || process.env.DRY_RUN === '1') {
    console.log(`[LINE][DRY_RUN] 🛡️ 模擬回覆模式（已攔截）：`);
    console.log(`[LINE][DRY_RUN]   ➤ 回覆 Token: ${replyToken}`);
    console.log(`[LINE][DRY_RUN]   ➤ 訊息內容:\n${text}\n`);
    return { ok: true, status: 200, dryRun: true };
  }

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.warn('[LINE] 尚未設定 LINE_CHANNEL_ACCESS_TOKEN，跳過實際回覆。');
    return { ok: false, status: 0, error: 'MISSING_LINE_TOKEN' };
  }

  try {
    const response = await fetch(LINE_REPLY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: 'text', text }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[LINE] 回覆失敗 (HTTP ${response.status}): ${errBody}`);
      return { ok: false, status: response.status, error: errBody };
    }

    return { ok: true, status: response.status };
  } catch (err) {
    console.error(`[LINE] 回覆連線錯誤: ${err.message}`);
    return { ok: false, status: 500, error: err.message };
  }
}

