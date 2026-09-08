/**
 * lib/weatherApi.js
 * 氣象 API 工具函式，使用 Open-Meteo 查詢未來的降雨機率與降雨量。
 */

/**
 * 檢查未來一小時內的天氣與空氣品質狀態
 * @param {number} lat 緯度
 * @param {number} lng 經度
 * @returns {Promise<{ shouldNotify: boolean, willRain: boolean, prob: number, precipitation: number, uvWarning: boolean, uvIndex: number, pmWarning: boolean, pm25: number, desc: string }>}
 */
export async function checkUpcomingRain(lat, lng) {
  const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=precipitation,precipitation_probability,uv_index&timezone=Asia%2FTaipei&forecast_hours=2`;
  const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}&hourly=pm2_5&timezone=Asia%2FTaipei&forecast_hours=2`;

  try {
    const [weatherRes, aqRes] = await Promise.all([
      fetch(weatherUrl),
      fetch(aqUrl)
    ]);

    if (!weatherRes.ok || !aqRes.ok) {
      throw new Error(`Open-Meteo API Error: Weather(${weatherRes.status}), AQ(${aqRes.status})`);
    }

    const [weatherData, aqData] = await Promise.all([
      weatherRes.json(),
      aqRes.json()
    ]);

    const wHourly = weatherData.hourly;
    const aHourly = aqData.hourly;

    if (!wHourly || !wHourly.time || wHourly.time.length < 2 || !aHourly || !aHourly.time || aHourly.time.length < 2) {
      return { shouldNotify: false, willRain: false, prob: 0, precipitation: 0, uvWarning: false, uvIndex: 0, pmWarning: false, pm25: 0, desc: '無法取得完整的預報資料' };
    }

    // 取得當下時間（小時）的下一筆預報，代表「未來 1 小時」
    const nextHourPrecipitation = wHourly.precipitation[1] || 0;
    const nextHourProb = wHourly.precipitation_probability[1] || 0;
    const nextHourUv = wHourly.uv_index[1] || 0;
    const nextHourPm25 = aHourly.pm2_5[1] || 0;

    // 定義各項異常條件
    const willRain = nextHourPrecipitation >= 0.1 || nextHourProb > 30;
    const uvWarning = nextHourUv >= 8; // UV >= 8 為危險/極危險
    const pmWarning = nextHourPm25 >= 35.5; // PM2.5 >= 35.5 為橘害 (對敏感族群不健康)

    const shouldNotify = willRain || uvWarning || pmWarning;

    let warnings = [];
    if (willRain) warnings.push(`🌧️ 將有降雨 (機率 ${nextHourProb}% / 雨量 ${nextHourPrecipitation}mm)，出門請攜帶雨具🌂`);
    if (uvWarning) warnings.push(`☀️ 紫外線過量 (UV指數 ${nextHourUv})，出門請注意防曬🕶️`);
    if (pmWarning) warnings.push(`😷 空氣品質不良 (PM2.5 濃度 ${nextHourPm25}μg/m³)，建議配戴口罩防護😷`);

    const desc = warnings.join('\n');

    return { 
      shouldNotify, 
      willRain, 
      prob: nextHourProb, 
      precipitation: nextHourPrecipitation, 
      uvWarning,
      uvIndex: nextHourUv,
      pmWarning,
      pm25: nextHourPm25,
      desc 
    };
  } catch (err) {
    console.error(`[WeatherAPI] 取得氣象預報失敗 (lat:${lat}, lng:${lng}):`, err.message);
    return { shouldNotify: false, willRain: false, prob: 0, precipitation: 0, uvWarning: false, uvIndex: 0, pmWarning: false, pm25: 0, desc: '氣象預報讀取失敗' };
  }
}
