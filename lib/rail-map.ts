import type { Station, TicketPlan } from './rail-types';

/** All geographic data uses WGS84; never mix it with GCJ-02 map tiles. */
export type Coordinate = [longitude: number, latitude: number];
export type MapStation = {
  code: string; name: string; position: Coordinate | null;
  status: 'located' | 'missing' | 'ambiguous'; reason: string | null;
  osmUrl: string | null; collectedAt: string;
};
export type RailGeometry = {
  coordinates: Coordinate[]; distanceMeters: number; collectedAt: string;
  source: 'BRouter / OpenStreetMap'; precision: 'rail-network-reference';
};
export type MapSourceRequest = {
  provider: 'photon' | 'brouter'; url: string; token: string; expiresAt: string;
};
export type SegmentRole = 'covered' | 'uncovered' | 'extra' | 'other';
export const MAP_ROLE_LABELS: Record<SegmentRole, string> = {
  covered: '车票覆盖的乘车区间', uncovered: '需申请补票', extra: '多买区间', other: '本次乘车区间外',
};
export const MAP_ROLE_COLORS: Record<SegmentRole, string> = {
  covered: '#2684e8', uncovered: '#e87518', extra: '#8059bc', other: '#a4b2c0',
};

export function planMapRange(plan: TicketPlan, scope: 'trip' | 'train') {
  if (scope === 'train') return { start: 0, end: plan.route.length - 1 };
  const start = plan.route.findIndex(s => s.station.code === plan.origin.code);
  const target = plan.route.findIndex(s => s.station.code === plan.target.code);
  const ticketEnd = plan.route.findIndex(s => s.station.code === plan.legs.at(-1)?.to.code);
  return { start, end: Math.max(target, ticketEnd) };
}

export function segmentRole(plan: TicketPlan, fromOffset: number): SegmentRole {
  const offset = (code: string) => plan.route.findIndex(s => s.station.code === code);
  const origin = offset(plan.origin.code), target = offset(plan.target.code);
  if (origin < 0 || target < 0 || fromOffset < origin) return 'other';
  if (plan.uncovered && fromOffset >= offset(plan.uncovered.from.code) && fromOffset < target) return 'uncovered';
  if (plan.kind === 'long' && fromOffset >= target && fromOffset < offset(plan.legs.at(-1)!.to.code)) return 'extra';
  if (fromOffset >= target) return 'other';
  return plan.legs.some(leg => fromOffset >= offset(leg.from.code) && fromOffset < offset(leg.to.code)) ? 'covered' : 'other';
}

export function stationRole(plan: TicketPlan, code: string) {
  if (code === plan.origin.code) return '上车';
  if (code === plan.target.code) return '下车';
  if (plan.kind === 'split' && code === plan.legs[0]?.to.code) return '接续 · 可能换座';
  if (plan.uncovered && code === plan.uncovered.from.code) return '短票到站 · 提前申请补票';
  if (plan.kind === 'long' && code === plan.legs.at(-1)?.to.code) return '票面到站';
  return '';
}

const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
function point(lon: unknown, lat: unknown): Coordinate | null {
  return typeof lon === 'number' && typeof lat === 'number' && Number.isFinite(lon) && Number.isFinite(lat) && lon >= 73 && lon <= 136 && lat >= 18 && lat <= 54 ? [lon, lat] : null;
}
export function distanceMeters(a: Coordinate, b: Coordinate) {
  const radians = Math.PI / 180;
  const dLat = (b[1] - a[1]) * radians, dLon = (b[0] - a[0]) * radians;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function parseMapStations(raw: unknown, stations: Station[], collectedAt: string): MapStation[] {
  const data = record(raw);
  if (!data || !Array.isArray(data.elements) || data.remark) throw new Error('车站位置服务返回不完整数据');
  const elements = data.elements;
  const normalize = (value: unknown) => typeof value === 'string' ? value.replace(/站$/, '').trim() : '';
  return stations.map(station => {
    const candidates = elements.flatMap(value => {
      const item = record(value), tags = record(item?.tags), center = record(item?.center);
      if (!item || !tags || tags.railway !== 'station' || tags.subway === 'yes' || tags.light_rail === 'yes' || ['subway', 'light_rail', 'tram', 'monorail'].includes(String(tags.station))) return [];
      if (![tags.name, tags['name:zh'], tags['name:zh-Hans']].some(name => normalize(name) === normalize(station.name))) return [];
      const position = point(item.lon ?? center?.lon, item.lat ?? center?.lat);
      if (!position || !['node', 'way', 'relation'].includes(String(item.type)) || !Number.isSafeInteger(item.id)) return [];
      return [{ position, osmUrl: `https://www.openstreetmap.org/${item.type}/${item.id}`, priority: item.type === 'node' ? 0 : 1 }];
    }).sort((a, b) => a.priority - b.priority);
    const ambiguous = candidates.some(c => distanceMeters(c.position, candidates[0].position) > 2500);
    const chosen = ambiguous ? undefined : candidates[0];
    return { code: station.code, name: station.name, position: chosen?.position ?? null, status: ambiguous ? 'ambiguous' : chosen ? 'located' : 'missing', reason: ambiguous ? '存在多个同名铁路站，暂不自动选取位置' : chosen ? null : '地图数据中未找到唯一的铁路车站位置', osmUrl: chosen?.osmUrl ?? null, collectedAt };
  });
}

export function parsePhotonStation(raw: unknown, station: Station, collectedAt: string): MapStation {
  const data = record(raw);
  if (!data || !Array.isArray(data.features)) throw new Error('车站位置服务返回无效数据');
  const types: Record<string, string> = { N: 'node', W: 'way', R: 'relation' };
  const elements = data.features.flatMap(value => {
    const feature = record(value), tags = record(feature?.properties), geometry = record(feature?.geometry);
    if (!tags || tags.countrycode !== 'CN' || geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) return [];
    // A named railway station building is also a valid station location; POIs,
    // road addresses, metro stops and city centroids are never substituted.
    const extra = record(tags.extra);
    // Photon often omits the optional station=train subtype (e.g. 丽水 and
    // 温州南). railway=station remains an explicit station classification;
    // a subtype is not required, but any supplied urban-rail flags are retained.
    if (!(tags.osm_key === 'railway' && tags.osm_value === 'station') && !(tags.osm_key === 'building' && tags.osm_value === 'train_station')) return [];
    return [{ type: types[String(tags.osm_type)], id: tags.osm_id, lon: geometry.coordinates[0], lat: geometry.coordinates[1], tags: { name: tags.name, railway: 'station', station: extra?.station ?? tags.station, subway: extra?.subway ?? tags.subway, light_rail: extra?.light_rail ?? tags.light_rail } }];
  });
  return parseMapStations({ elements }, [station], collectedAt)[0];
}

/** Only accept a rail-tagged track, with endpoints near the selected stations. */
export function parseRailGeometry(raw: unknown, from: Coordinate, to: Coordinate, collectedAt: string): RailGeometry {
  const data = record(raw);
  const feature = Array.isArray(data?.features) ? record(data.features[0]) : null;
  const geometry = record(feature?.geometry), properties = record(feature?.properties);
  if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2 || geometry.coordinates.length > 100000) throw new Error('未取得可绘制的铁路线路');
  const coordinates = geometry.coordinates.map(value => Array.isArray(value) ? point(value[0], value[1]) : null);
  if (coordinates.some(value => !value)) throw new Error('铁路坐标无效');
  const track = coordinates as Coordinate[];
  if (distanceMeters(track[0], from) > 1500 || distanceMeters(track.at(-1)!, to) > 1500) throw new Error('铁路线路未能接到所选车站');
  const messages = properties?.messages;
  if (!Array.isArray(messages) || !Array.isArray(messages[0])) throw new Error('线路来源未提供铁路属性，暂不绘制');
  const column = messages[0].indexOf('WayTags');
  const tags = messages.slice(1).map(row => Array.isArray(row) ? row[column] : '').filter(value => typeof value === 'string' && value.trim());
  if (column < 0 || !tags.length || tags.some(value => !/(?:^|\s)railway=(?:rail|narrow_gauge)(?:\s|$)/.test(value))) throw new Error('路线包含非铁路区间，暂不绘制');
  let total = 0;
  for (let i = 1; i < track.length; i++) {
    const length = distanceMeters(track[i - 1], track[i]);
    if (length > 20000) throw new Error('线路存在未确认的跳跃区间');
    total += length;
  }
  // Keep a small response while retaining the real curvature; no straight-line fallback.
  const reduced = track.filter((p, i) => i === 0 || i === track.length - 1 || distanceMeters(p, track[i - 1]) >= 5 || i % 4 === 0);
  return { coordinates: reduced, distanceMeters: Math.round(total), collectedAt, source: 'BRouter / OpenStreetMap', precision: 'rail-network-reference' };
}
