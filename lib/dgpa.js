/**
 * lib/dgpa.js
 * DGPA（行政院人事行政總處）天然災害停班停課狀態查詢。
 *
 * 策略：
 *   爬取 https://www.dgpa.gov.tw/typh/daily/nds.html
 *   解析頁面中各縣市的停班/停課公告。
 *   回傳處於停班停課狀態的縣市清單。
 */

const DGPA_URL = 'https://www.dgpa.gov.tw/typh/daily/nds.html';
const FETCH_TIMEOUT_MS = 10_000; // 10 秒逾時

/**
 * 系統關注的縣市清單。
 * 新增縣市時，只需在此陣列加入名稱並為對應路線設定 city 欄位即可。
 */
export const MONITORED_CITIES = ['高雄市', '新北市', '桃園市', '台南市'];

/**
 * 判斷 DGPA 頁面原始 HTML 中，指定縣市是否有停班停課公告。
 * @param {string} html
 * @param {string} cityName - 縣市名稱（例如 '高雄市'、'新北市'、'台南市'）
 * @returns {boolean}
 */
export function parseSuspensionForCity(html, cityName) {
  if (!html || typeof html !== 'string') return false;
  if (!cityName) return false;

  // 支援 臺/台 異體字相容比對
  const cityVariants = [cityName];
  if (cityName.startsWith('台')) {
    cityVariants.push('臺' + cityName.slice(1));
  } else if (cityName.startsWith('臺')) {
    cityVariants.push('台' + cityName.slice(1));
  }

  // 1. 若完全無該縣市字樣，直接視為正常清運
  const matchedVariant = cityVariants.find((v) => html.includes(v));
  if (!matchedVariant) {
    return false;
  }

  // 2. 排除常見的否定/排除語句 (例如「除高雄市外」)
  const excludePattern = new RegExp(`除\\s*(?:${cityVariants.join('|')})\\s*外`);
  if (excludePattern.test(html)) {
    return false;
  }

  // 3. 搜尋該縣市區塊，縮小匹配範圍至 100 字元內，避免跨到其他縣市的資訊
  const blockPattern = new RegExp(
    `(?:${cityVariants.join('|')})[\\s\\S]{1,100}?(停止上班|停止上課|全天停止|已達停止)`
  );
  const blockMatch = html.match(blockPattern);
  if (blockMatch) {
    // 檢查該鄰近區段是否明確標示為照常/正常上班上課
    const matchedSegment = blockMatch[0];
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
 * 保留向後相容：僅檢查高雄市的停班停課。
 * @param {string} html
 * @returns {boolean}
 * @deprecated 請改用 parseSuspensionForCity(html, '高雄市')
 */
export function parseHtmlForKaohsiung(html) {
  return parseSuspensionForCity(html, '高雄市');
}

/**
 * 向 DGPA 查詢今日各監控縣市是否有天然災害停班停課。
 * @param {string[]} [cities] - 要檢查的縣市清單，預設為 MONITORED_CITIES
 * @returns {Promise<string[]>} 處於停班停課狀態的縣市名稱陣列（空陣列表示全部正常）
 * @throws {Error} 若網路請求失敗或逾時
 */
export async function checkSuspendedCities(cities = MONITORED_CITIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(DGPA_URL, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; TrashAlertBot/1.0; +https://github.com/jackleecc/trash-alert-tw)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new Error(`DGPA API 回傳非預期狀態碼：${response.status}`);
    }

    const html = await response.text();
    const suspendedCities = [];

    for (const city of cities) {
      if (parseSuspensionForCity(html, city)) {
        suspendedCities.push(city);
      }
    }

    return suspendedCities;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 保留向後相容：僅檢查高雄市。
 * @returns {Promise<boolean>}
 * @deprecated 請改用 checkSuspendedCities()
 */
export async function checkKaohsiungSuspension() {
  const suspended = await checkSuspendedCities(['高雄市']);
  return suspended.includes('高雄市');
}
