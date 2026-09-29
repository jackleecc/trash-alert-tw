import crypto from 'node:crypto';

export const CHANNEL_DEFAULT = 'default';
export const CHANNEL_TAOYUAN = 'taoyuan';

/**
 * 依據意圖上下文判斷所屬 LINE 官方頻道
 *
 * @param {object} [intent={}]
 * @param {string} [intent.channelId]
 * @param {string} [intent.city]
 * @param {string} [intent.routeId]
 * @param {string} [intent.groupId]
 * @returns {string} CHANNEL_TAOYUAN 或 CHANNEL_DEFAULT
 */
export function resolveChannelForIntent(intent = {}) {
  const safeIntent = intent || {};

  if (safeIntent.channelId === CHANNEL_TAOYUAN) {
    return CHANNEL_TAOYUAN;
  }

  if (safeIntent.city === '桃園市') {
    return CHANNEL_TAOYUAN;
  }

  if (typeof safeIntent.routeId === 'string' && safeIntent.routeId.startsWith('lagi2')) {
    return CHANNEL_TAOYUAN;
  }

  if (safeIntent.groupId === 'Cbc0aef28eb6226fafe1ea7e5a6e4487e') {
    return CHANNEL_TAOYUAN;
  }

  if (typeof safeIntent.stopName === 'string' && (safeIntent.stopName.includes('楊梅') || safeIntent.stopName.includes('桃園'))) {
    return CHANNEL_TAOYUAN;
  }

  return CHANNEL_DEFAULT;
}

/**
 * 取得指定頻道的 LINE 存取憑證 (Access Token 與 Channel Secret)
 *
 * @param {string} [channelId=CHANNEL_DEFAULT]
 * @returns {{ channelId: string, token: string | undefined, secret: string | undefined }}
 */
export function getChannelCredentials(channelId = CHANNEL_DEFAULT) {
  if (channelId === CHANNEL_TAOYUAN) {
    return {
      channelId: CHANNEL_TAOYUAN,
      token: process.env.LINE_CHANNEL_ACCESS_TOKEN_TAOYUAN,
      secret: process.env.LINE_CHANNEL_SECRET_TAOYUAN,
    };
  }

  return {
    channelId: CHANNEL_DEFAULT,
    token: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    secret: process.env.LINE_CHANNEL_SECRET,
  };
}

/**
 * 內部輔助函式：以指定 Secret 驗證 HMAC-SHA256 簽章
 *
 * @param {string} bodyString
 * @param {string} signature
 * @param {string} secret
 * @returns {boolean}
 */
function verifyHmacSignature(bodyString, signature, secret) {
  if (!secret) return false;
  try {
    const hash = crypto
      .createHmac('SHA256', secret)
      .update(bodyString)
      .digest('base64');
    const hashBuf = Buffer.from(hash);
    const sigBuf = Buffer.from(signature);
    if (hashBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(hashBuf, sigBuf);
  } catch {
    return false;
  }
}

/**
 * 驗證 LINE Webhook 簽章並自動識別所屬頻道
 *
 * @param {string} bodyString
 * @param {string} signature
 * @returns {{ ok: boolean, channelId?: string }}
 */
export function verifyWebhookSignature(bodyString, signature) {
  if (!signature || typeof signature !== 'string') {
    return { ok: false };
  }

  const tySecret = process.env.LINE_CHANNEL_SECRET_TAOYUAN;
  const defaultSecret = process.env.LINE_CHANNEL_SECRET;

  // 若環境變數皆未配置 secret，寬鬆模式通過並歸為預設頻道
  if (!defaultSecret && !tySecret) {
    return { ok: true, channelId: CHANNEL_DEFAULT };
  }

  if (tySecret && verifyHmacSignature(bodyString, signature, tySecret)) {
    return { ok: true, channelId: CHANNEL_TAOYUAN };
  }

  if (defaultSecret && verifyHmacSignature(bodyString, signature, defaultSecret)) {
    return { ok: true, channelId: CHANNEL_DEFAULT };
  }

  return { ok: false };
}

/**
 * 產生分頻道獨立的每月份配額統計鍵名 (system_quota.month)
 *
 * @param {string} yearMonth - 格式 YYYY-MM
 * @param {string} [channelId=CHANNEL_DEFAULT] - 頻道識別碼
 * @returns {string} 預設頻道為 "YYYY-MM"，其他頻道為 "YYYY-MM:<channelId>"
 */
export function getQuotaMonthKey(yearMonth, channelId = CHANNEL_DEFAULT) {
  if (channelId && channelId !== CHANNEL_DEFAULT) {
    return `${yearMonth}:${channelId}`;
  }
  return yearMonth;
}
