// Website timestamps describe the response, never an individual GPS sample.
export const NTPC_WEBSITE_URL = 'https://crd-rubbish.epd.ntpc.gov.tw/WebAPI/GetArrival';

// Validate calendar components before Date parsing; Date otherwise rolls invalid days forward.
export function parseNtpcTime(value, compact = false) {
  if (typeof value !== 'string') return null;
  const match = compact
    ? value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
    : value.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, s] = parts;
  const calendar = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (y < 100 || calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  const zone = compact ? '+08:00' : (match[8] || '+08:00');
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${compact ? '' : (match[7] || '')}${zone}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function isFreshNtpcTime(date, now) {
  if (!date) return false;
  const age = now.getTime() - date.getTime();
  return age >= -60000 && age <= 300000;
}

export async function fetchNtpcWebsiteBackup(requestedRouteIds, now) {
  const diagnostics = { attempted: true, requestedRouteIds, count: 0, rejections: {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(NTPC_WEBSITE_URL, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ LineID: requestedRouteIds.join(',') }),
    });
    if (!response.ok) throw new Error(`NTPC website HTTP ${response.status}`);
    const payload = JSON.parse(await response.text());
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.Line)) throw new Error('NTPC website invalid response shape');
    const timestamp = parseNtpcTime(payload.TimeStamp, true);
    if (!timestamp || !isFreshNtpcTime(timestamp, now)) {
      const reason = timestamp ? 'stale_response' : 'invalid_timestamp';
      diagnostics.rejections[reason] = payload.Line.length;
      throw new Error(`NTPC website ${reason}`);
    }
    const sourceTimestamp = timestamp.toISOString();
    diagnostics.responseTimestamp = sourceTimestamp;
    const data = [];
    const seen = new Set();
    const reject = (reason) => { diagnostics.rejections[reason] = (diagnostics.rejections[reason] || 0) + 1; };
    for (const line of payload.Line) {
      if (!line || !requestedRouteIds.includes(line.LineID)) { reject('route_mismatch'); continue; }
      if (![line.LineID, '000005', '000007'].includes(line.BarCode)) { reject('not_in_service'); continue; }
      if (typeof line.CarNO !== 'string' || !line.CarNO.trim()) { reject('missing_vehicle'); continue; }
      const lat = Number(line.LocationLat);
      const lng = Number(line.LocationLon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 21.5 || lat > 26.5 || lng < 119 || lng > 122.5) { reject('invalid_position'); continue; }
      const car_id = line.CarNO.trim();
      const key = `${line.LineID}:${car_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      data.push({ route_id: line.LineID, car_id, lat, lng, waste_type: 'garbage', source: 'ntpc-website', timestamp_kind: 'response', source_timestamp: sourceTimestamp });
    }
    diagnostics.count = data.length;
    return { data, diagnostics };
  } catch (err) {
    diagnostics.error = err.name === 'AbortError' ? 'NTPC website timeout (5000ms)' : err.message;
    return { data: [], diagnostics };
  } finally { clearTimeout(timer); }
}
