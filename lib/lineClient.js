/**
 * lib/lineClient.js
 * LINE Messaging API 客戶端模組
 *
 * 用於向指定的 LINE 群組或使用者發送 Push Message。
 */

import { supabase } from './supabaseClient.js';
import { resolveRouteCity, normalizeCity } from './geoUtils.js';

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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(LINE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
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
    if (err.name === 'AbortError') {
      console.error('[LINE] 推播連線逾時 (10s)');
      return { ok: false, status: 504, error: 'LINE_PUSH_TIMEOUT' };
    }
    console.error(`[LINE] 網路連線錯誤: ${err.message}`);
    return { ok: false, status: 500, error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 向已註冊的 LINE 群組發送系統告警訊息（支援指定縣市精準發送）。
 *
 * @param {string} alertText - 告警文字內容
 * @param {string[]} [targetCities] - 可選的目標縣市清單 (例如: ['新北市'])。若未指定或為空，則向所有活躍群組發送。
 */
export async function broadcastLineAlert(alertText, targetCities = null) {
  try {
    let targetGroupIds = null;

    if (Array.isArray(targetCities) && targetCities.length > 0) {
      const normalizedTargets = targetCities.map((c) => normalizeCity(c));
      try {
        const { data: subs, error: subErr } = await supabase
          .from('subscriptions')
          .select(`
            group_id,
            stops (
              route_id,
              routes (
                city,
                name,
                description
              )
            )
          `);

        if (!subErr && Array.isArray(subs)) {
          const matched = new Set();
          for (const sub of subs) {
            const route = sub.stops?.routes;
            if (route) {
              const city = resolveRouteCity(route);
              if (city && normalizedTargets.includes(city)) {
                matched.add(sub.group_id);
              }
            }
          }
          targetGroupIds = matched;
        }
      } catch (subQueryErr) {
        console.warn(`[LINE] 依縣市過濾群組失敗，將降級為全域查詢: ${subQueryErr.message}`);
      }
    }

    if (targetGroupIds && targetGroupIds.size === 0) {
      console.log(`[LINE] 目標縣市 (${targetCities.join('、')}) 目前無關聯之 LINE 群組，略過告警推播。`);
      return;
    }

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

    const recipientGroups = targetGroupIds
      ? groups.filter((g) => targetGroupIds.has(g.group_id))
      : groups;

    if (recipientGroups.length === 0) {
      console.log('[LINE] 經篩選後無符合條件之活躍 LINE 群組，略過發送。');
      return;
    }

    for (const group of recipientGroups) {
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
  if (!replyToken || replyToken === '00000000000000000000000000000000') {
    return { ok: true, status: 200, dummy: true };
  }

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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(LINE_REPLY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
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
    if (err.name === 'AbortError') {
      console.error('[LINE] 回覆連線逾時 (10s)');
      return { ok: false, status: 504, error: 'LINE_REPLY_TIMEOUT' };
    }
    console.error(`[LINE] 回覆連線錯誤: ${err.message}`);
    return { ok: false, status: 500, error: err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

