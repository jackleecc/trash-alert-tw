/**
 * lib/truckAdapter.js
 * 外部環保局垃圾車即時 API 欄位清洗與轉換 Adapter (Strict Schema Mapping)
 *
 * 設計原則：
 *   1. 支援外部 API 可能的命名變體 (如 RouteId, route_id, lat, Y, lng, X 等)。
 *   2. 嚴格型別校驗與數值邊界檢查（經緯度需在台灣/高雄合理範圍內）。
 *   3. 若必要欄位 (route_id, lat, lng) 缺失或不合法，安全略過該筆資料，不拋出中斷性例外。
 */

/**
 * 台灣/高雄地區合理經緯度範圍
 */
const GEO_BOUNDS = {
  MIN_LAT: 21.5,
  MAX_LAT: 26.5,
  MIN_LNG: 119.0,
  MAX_LNG: 122.5,
};

/**
 * 從物件中安全提取可能存在的鍵值
 * @param {Record<string, any>} obj
 * @param {string[]} keys
 * @returns {any}
 */
function getFirstAvailableValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      return obj[key];
    }
  }
  return undefined;
}

/**
 * 解析並驗證數值座標
 * @param {any} val
 * @param {number} min
 * @param {number} max
 * @returns {number | null}
 */
function parseCoordinate(val, min, max) {
  if (val === undefined || val === null) return null;
  const num = typeof val === 'number' ? val : parseFloat(String(val).trim());
  if (isNaN(num) || !isFinite(num)) return null;
  if (num < min || num > max) return null;
  return num;
}

/**
 * 將單筆原始資料正規化為標準車輛動態物件
 * @param {Record<string, any>} raw
 * @returns {{ route_id: string, lat: number, lng: number, car_id?: string, time?: string } | null}
 */
export function normalizeTruckRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // 1. 提取 route_id
  const rawRouteId = getFirstAvailableValue(raw, [
    'linename',
    'line_name',
    'LineName',
    'route_id',
    'routeId',
    'RouteId',
    'RouteID',
    'Route_Id',
    'route_no',
    'RouteNo',
    'Route_No',
    'route',
    'Route',
    'line_id',
    'lineId',
    'LineId',
    'LineID',
    'lineid',
    'Lineid',
    'linid',
    'lineno',
    'LineNo',
    'line_no',
    'line',
    'Line',
    'car_id',
    'carId',
  ]);
  if (rawRouteId === undefined || rawRouteId === null) return null;
  const route_id = String(rawRouteId).trim();
  if (!route_id) return null;

  // 2. 提取 lat (緯度)
  const rawLat = getFirstAvailableValue(raw, [
    'wgs_y',
    'Wgs_y',
    'WGS_Y',
    'lat',
    'Lat',
    'LAT',
    'latitude',
    'Latitude',
    'y',
    'Y',
    'py',
    'Py',
  ]);
  const lat = parseCoordinate(rawLat, GEO_BOUNDS.MIN_LAT, GEO_BOUNDS.MAX_LAT);
  if (lat === null) return null;

  // 3. 提取 lng (經度)
  const rawLng = getFirstAvailableValue(raw, [
    'wgs_x',
    'Wgs_x',
    'WGS_X',
    'lng',
    'Lng',
    'LNG',
    'lon',
    'Lon',
    'LON',
    'longitude',
    'Longitude',
    'x',
    'X',
    'px',
    'Px',
  ]);
  const lng = parseCoordinate(rawLng, GEO_BOUNDS.MIN_LNG, GEO_BOUNDS.MAX_LNG);
  if (lng === null) return null;

  // 4. 提取選用欄位 (car_id / time)
  const rawCarId = getFirstAvailableValue(raw, [
    'car_licence',
    'carLicence',
    'CarLicence',
    'car_id',
    'carId',
    'CarId',
    'CarID',
    'car',
    'carno',
    'CarNo',
    'plate',
    'PlateNo',
    'vehicleno',
    'VehicleNo',
  ]);
  const car_id = rawCarId ? String(rawCarId).trim() : undefined;

  const rawTime = getFirstAvailableValue(raw, [
    'dt',
    'Dt',
    'gotofire',
    'time',
    'Time',
    'datetime',
    'update_time',
    'UpdateTime',
    'gpstime',
    'GpsTime',
  ]);
  const time = rawTime ? String(rawTime).trim() : undefined;

  // 5. 提取車種 / 清運類別 (waste_type: 'garbage' | 'recycling')
  const rawCarType = getFirstAvailableValue(raw, [
    'cartype',
    'car_type',
    'carType',
    'CarType',
    'trash_type',
    'trashType',
    'TrashType',
    'garbage_type',
    'waste_type',
    'type',
    'Type',
    'kind',
    'Kind',
    'unit',
    'Unit',
    'dep_name',
    'memo',
  ]);

  let waste_type = 'garbage';
  if (rawCarType) {
    const text = String(rawCarType).trim();
    if (
      text === 'R' ||
      text.includes('回收') ||
      text.includes('資源') ||
      text.includes('廚餘') ||
      text.includes('資收')
    ) {
      waste_type = 'recycling';
    }
  }

  return {
    route_id,
    lat,
    lng,
    waste_type,
    ...(car_id ? { car_id } : {}),
    ...(time ? { time } : {}),
  };
}

/**
 * 外部 API 資料適配器：將外部回應結構轉換為標準格式陣列
 *
 * @param {any} rawData - 外部 API 回傳的原始資料 (可能是 Array 或包在 { data: [...] } 等結構)
 * @returns {{ route_id: string, lat: number, lng: number, car_id?: string, time?: string }[]}
 */
export function adaptTruckData(rawData) {
  if (!rawData) return [];

  let unwrap = rawData;
  // 支援 ASP.NET ASMX 回傳的 { d: "..." } 或 { d: { ... } }
  if (unwrap && typeof unwrap === 'object' && unwrap.d !== undefined) {
    if (typeof unwrap.d === 'string') {
      try {
        unwrap = JSON.parse(unwrap.d);
      } catch {
        unwrap = {};
      }
    } else {
      unwrap = unwrap.d;
    }
  }

  let list = [];
  if (Array.isArray(unwrap)) {
    list = unwrap;
  } else if (typeof unwrap === 'object') {
    // 支援可能包在 DATA / data / records / items / result 的常見 API 結構
    if (Array.isArray(unwrap.DATA)) list = unwrap.DATA;
    else if (Array.isArray(unwrap.data)) list = unwrap.data;
    else if (Array.isArray(unwrap.records)) list = unwrap.records;
    else if (Array.isArray(unwrap.items)) list = unwrap.items;
    else if (Array.isArray(unwrap.result)) list = unwrap.result;
    else if (Array.isArray(unwrap.features)) {
      // 支援 GeoJSON 格式
      list = unwrap.features.map((f) => ({
        ...f.properties,
        lng: f.geometry?.coordinates?.[0],
        lat: f.geometry?.coordinates?.[1],
      }));
    }
  }

  const validRecords = [];
  for (const item of list) {
    const normalized = normalizeTruckRecord(item);
    if (normalized) {
      validRecords.push(normalized);
    }
  }

  return validRecords;
}
