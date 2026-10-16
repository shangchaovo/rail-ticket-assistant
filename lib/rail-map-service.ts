import { distanceMeters, parsePhotonStation, parseRailGeometry } from './rail-map.ts';
import type { MapSourceRequest, MapStation, RailGeometry } from './rail-map';
import type { Station } from './rail-types';

const DAY = 86400_000;
const PHOTON = 'https://photon.komoot.io/api/';
const BROUTER = 'https://brouter.de/brouter';
const LEASE_MS = 90_000;
type Provider = MapSourceRequest['provider'];
export type SourceSubmission = { sourceToken?: unknown; payload?: unknown; sourceFailure?: unknown };

export class MapServiceError extends Error {
  retryAfter: number;
  status: number;
  constructor(message: string, retryAfter = 0, status = 503) { super(message); this.retryAfter = retryAfter; this.status = status; }
}
async function cached<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare('SELECT data_json FROM rail_map_cache WHERE cache_key=? AND expires_at>?').bind(key, Date.now()).first<{ data_json: string }>();
  return row ? JSON.parse(row.data_json) as T : null;
}
export function stationMapKey(station: Station) { return `station-v2:${station.code}:${station.name}`; }
export function trackMapKey(a: [number, number], b: [number, number]) { return `rail-v1:${a.join(',')}:${b.join(',')}`; }
async function cachedMany<T>(db: D1Database, keys: string[]): Promise<Map<string, T>> {
  const unique = [...new Set(keys)], batches = [];
  for (let i = 0; i < unique.length; i += 80) {
    const part = unique.slice(i, i + 80);
    batches.push(db.prepare(`SELECT cache_key,data_json FROM rail_map_cache WHERE expires_at>? AND cache_key IN (${part.map(() => '?').join(',')})`).bind(Date.now(), ...part).all<{ cache_key: string; data_json: string }>());
  }
  const results = await Promise.all(batches);
  return new Map(results.flatMap(result => result.results.map(row => [row.cache_key, JSON.parse(row.data_json) as T] as const)));
}
// This only reads normalized geographic caches. It never acquires a provider
// lease, refreshes ticket inventory, or accepts endpoints supplied by clients.
export async function mapSnapshot(db: D1Database, route: Station[], start: number, end: number) {
  const items = route.slice(start, end + 1);
  const known = await cachedMany<MapStation>(db, items.map(stationMapKey));
  const segments = items.slice(0, -1).flatMap((station, offset) => {
    const a = known.get(stationMapKey(station)), b = known.get(stationMapKey(items[offset + 1]));
    return a?.position && b?.position ? [{ fromOffset: start + offset, key: trackMapKey(a.position, b.position) }] : [];
  });
  const geometry = await cachedMany<RailGeometry>(db, segments.map(segment => segment.key));
  return {
    stations: [...known.values()],
    tracks: segments.flatMap(segment => { const value = geometry.get(segment.key); return value ? [{ fromOffset: segment.fromOffset, geometry: value }] : []; }),
  };
}
export function stationSourceUrl(station: Station) {
  const url = new URL(PHOTON);
  url.search = new URLSearchParams({ q: station.name, limit: '20', bbox: '73,18,136,54' }).toString();
  return url.href;
}
export function trackSourceUrl(a: [number, number], b: [number, number]) {
  const url = new URL(BROUTER);
  url.search = new URLSearchParams({ lonlats: `${a.join(',')}|${b.join(',')}`, profile: 'rail', alternativeidx: '0', format: 'geojson' }).toString();
  return url.href;
}
async function boundToken(token: string, owner: string, key: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${owner}\0${key}`));
  return `${token}:${[...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
async function acquire(db: D1Database, name: Provider, owner: string, key: string, url: string): Promise<MapSourceRequest> {
  const token = crypto.randomUUID(), now = Date.now(), until = now + LEASE_MS;
  const stored = await boundToken(token, owner, key);
  const lock = await db.prepare('INSERT INTO rail_map_locks (provider,token,until_ms) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET token=excluded.token,until_ms=excluded.until_ms WHERE rail_map_locks.until_ms<=? RETURNING token').bind(name, stored, until, now).first();
  if (!lock) {
    const row = await db.prepare('SELECT until_ms FROM rail_map_locks WHERE provider=?').bind(name).first<{ until_ms: number }>();
    throw new MapServiceError('地图服务正在处理其他区间，请稍后重试', Math.max(1, Math.ceil(((row?.until_ms ?? now) - now) / 1000)), 429);
  }
  // Only the public station name / railway endpoints go to the provider. The
  // lease is returned separately and must never appear in that public request.
  return { provider: name, url, token, expiresAt: new Date(until).toISOString() };
}
async function release(db: D1Database, name: Provider, stored: string, cooldown: number) {
  await db.prepare('UPDATE rail_map_locks SET token=?,until_ms=? WHERE provider=? AND token=?').bind(crypto.randomUUID(), Date.now() + cooldown, name, stored).run();
}
async function complete<T>(db: D1Database, name: Provider, owner: string, key: string, submission: SourceSubmission, parse: (raw: unknown, collectedAt: string) => T, ttl: (data: T) => number): Promise<T> {
  if (typeof submission.sourceToken !== 'string' || !/^[\da-f-]{36}$/i.test(submission.sourceToken)) throw new MapServiceError('地图采集凭据无效', 0, 400);
  const stored = await boundToken(submission.sourceToken, owner, key), now = Date.now();
  const lease = await db.prepare('SELECT token,until_ms FROM rail_map_locks WHERE provider=?').bind(name).first<{ token: string; until_ms: number }>();
  if (!lease || lease.token !== stored || lease.until_ms <= now) throw new MapServiceError('地图采集已失效，请重新加载', 0, 409);
  if (submission.sourceFailure !== undefined) {
    const failure = submission.sourceFailure;
    if (!['network', 'timeout', 'limited', 'response', 'invalid', 'cancelled'].includes(String(failure))) throw new MapServiceError('地图采集状态无效', 0, 400);
    const cooldown = failure === 'limited' ? 300_000 : failure === 'cancelled' ? 1000 : 30_000;
    await release(db, name, stored, cooldown);
    throw new MapServiceError(failure === 'limited' ? '地图来源正在限流，请稍后重试' : failure === 'timeout' ? '地图来源响应超时，请稍后重试' : failure === 'invalid' ? '地图来源的数据无法解析' : '暂时无法读取地图来源，请稍后重试', Math.ceil(cooldown / 1000), failure === 'limited' ? 429 : 503);
  }
  let result: T;
  try { result = parse(submission.payload, new Date().toISOString()); }
  catch (error) {
    await release(db, name, stored, 1000);
    throw new MapServiceError(error instanceof Error ? error.message : '地图来源的数据无法核对', 0, 422);
  }
  // Commit only while this owner and interval still hold the lease. Rotate the
  // token in the same transaction so replayed / late results cannot overwrite.
  const saved = await db.batch([
    db.prepare('INSERT INTO rail_map_cache (cache_key,data_json,expires_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM rail_map_locks WHERE provider=? AND token=? AND until_ms>?) ON CONFLICT(cache_key) DO UPDATE SET data_json=excluded.data_json,expires_at=excluded.expires_at').bind(key, JSON.stringify(result), Date.now() + ttl(result), name, stored, Date.now()),
    db.prepare('UPDATE rail_map_locks SET token=?,until_ms=? WHERE provider=? AND token=?').bind(crypto.randomUUID(), Date.now() + 1000, name, stored),
    db.prepare('DELETE FROM rail_map_cache WHERE expires_at<?').bind(Date.now()),
  ]);
  if (!saved[0].meta.changes) throw new MapServiceError('地图采集已失效，请重新加载', 0, 409);
  return result;
}

export async function locateStation(db: D1Database, owner: string, station: Station, submission: SourceSubmission = {}): Promise<{ stations: MapStation[] } | { sourceRequest: MapSourceRequest }> {
  const key = stationMapKey(station);
  if (submission.sourceToken !== undefined) {
    const value = await complete(db, 'photon', owner, key, submission, (raw, at) => parsePhotonStation(raw, station, at), data => data.position ? 30 * DAY : DAY);
    return { stations: [value] };
  }
  const hit = await cached<MapStation>(db, key);
  return hit ? { stations: [hit] } : { sourceRequest: await acquire(db, 'photon', owner, key, stationSourceUrl(station)) };
}

export async function railwaySegment(db: D1Database, owner: string, from: Station, to: Station, submission: SourceSubmission = {}): Promise<{ geometry: RailGeometry } | { sourceRequest: MapSourceRequest }> {
  const a = await cached<MapStation>(db, stationMapKey(from)), b = await cached<MapStation>(db, stationMapKey(to));
  if (!a?.position || !b?.position) throw new MapServiceError('该区间车站位置尚未确认，无法绘制铁路线路', 0, 422);
  if (distanceMeters(a.position, b.position) > 800_000) throw new MapServiceError('两站间距超过当前地图服务范围，可查看经停示意图', 0, 422);
  const key = trackMapKey(a.position, b.position);
  if (submission.sourceToken !== undefined) {
    const geometry = await complete(db, 'brouter', owner, key, submission, (raw, at) => parseRailGeometry(raw, a.position!, b.position!, at), () => 7 * DAY);
    return { geometry };
  }
  const hit = await cached<RailGeometry>(db, key);
  return hit ? { geometry: hit } : { sourceRequest: await acquire(db, 'brouter', owner, key, trackSourceUrl(a.position, b.position)) };
}
