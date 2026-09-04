/**
 * lib/dgpa.js
 * DGPA（行政院人事行政總處）天然災害停班停課狀態查詢。
 *
 * 策略：
 *   爬取 https://www.dgpa.gov.tw/typh/daily/nds.html
 *   若頁面包含「高雄市」停班/停課公告文字，視為高雄市當日停收。
 *   正常上班日頁面無任何縣市記錄（僅顯示更新時間）。
 */

const DGPA_URL = 'https://www.dgpa.gov.tw/typh/daily/nds.html';
const FETCH_TIMEOUT_MS = 10_000; // 10 秒逾時

/**
 * 判斷 DGPA 頁面原始 HTML 是否顯示高雄市有停班停課公告。
 * @param {string} html
 * @returns {boolean}
 */
export function parseHtmlForKaohsiung(html) {
  if (!html || typeof html !== 'string') return false;

  // 1. 若完全無「高雄市」字樣，直接視為正常清運
  if (!html.includes('高雄市')) {
    return false;
  }

  // 2. 排除常見的否定/排除語句 (例如「除高雄市外」)
  if (/除\s*高雄市\s*外/.test(html)) {
    return false;
  }

  // 3. 搜尋高雄市區塊，縮小匹配範圍至 100 字元內，避免跨到其他縣市的停班停課資訊
  const kaohsiungBlockMatch = html.match(/高雄市[\s\S]{1,100}?(停止上班|停止上課|全天停止|已達停止)/);
  if (kaohsiungBlockMatch) {
    // 檢查該鄰近區段是否明確標示為照常/正常上班上課
    const matchedSegment = kaohsiungBlockMatch[0];
    if (
      (matchedSegment.includes('照常上班') || matchedSegment.includes('正常上班')) &&
      (matchedSegment.includes('照常上課') || matchedSegment.includes('正常上課'))
    ) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * 向 DGPA 查詢今日高雄市是否有天然災害停班停課。
 * @returns {Promise<boolean>} true = 高雄市停收，false = 正常清運
 * @throws {Error} 若網路請求失敗或逾時
 */
export async function checkKaohsiungSuspension() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(DGPA_URL, {
      signal: controller.signal,
      headers: {
        // 模擬瀏覽器 User-Agent，避免政府網站的 bot 封鎖
        'User-Agent':
          'Mozilla/5.0 (compatible; TrashAlertBot/1.0; +https://github.com/jackleecc/trash-alert-tw)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new Error(`DGPA API 回傳非預期狀態碼：${response.status}`);
    }

    const html = await response.text();
    return parseHtmlForKaohsiung(html);
  } finally {
    clearTimeout(timeoutId);
  }
}
