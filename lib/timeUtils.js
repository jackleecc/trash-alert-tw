/**
 * lib/timeUtils.js
 * 時間工具函式：處理 UTC <-> 台灣時間 (UTC+8) 的轉換與時段驗證。
 */

const TW_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8 = +8 小時

/**
 * 將 UTC Date 物件轉換為台灣時間的 Date 物件（數值上等同 UTC+8）。
 * @param {Date} utcDate
 * @returns {Date}
 */
export function toTaiwanTime(utcDate) {
  return new Date(utcDate.getTime() + TW_OFFSET_MS);
}

/**
 * 取得目前的台灣時間。
 * @returns {{ now: Date, hour: number, minute: number, dateStr: string }}
 *   now      - 台灣時間 Date 物件
 *   hour     - 台灣時間的小時 (0-23)
 *   minute   - 台灣時間的分鐘 (0-59)
 *   dateStr  - 台灣今日日期字串，格式 'YYYY-MM-DD'（用於 daily_status 主鍵）
 */
export function getTaiwanNow() {
  const now = toTaiwanTime(new Date());
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();

  // 以 UTC getUTC* 方法從偏移後的物件取得台灣當地時間各欄位
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  return { now, hour, minute, dateStr };
}

/**
 * 判斷目前是否在清運服務時間窗內（台灣時間 17:00 ~ 21:59）。
 * Vercel Cron 的 UTC 排程已限縮，但此函式為二次校驗防線。
 * @returns {boolean}
 */
export function isWithinServiceWindow() {
  const { hour } = getTaiwanNow();
  return hour >= 17 && hour <= 21;
}
