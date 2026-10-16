import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const service: typeof import('../lib/rail-map-service') = await import(new URL('../lib/rail-map-service.ts', import.meta.url).href);
const owner = 'test-private-owner', a = { name: '杭州东', code: 'HGH' }, b = { name: '杭州南', code: 'XHH' };
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0002_rail_maps.sql', import.meta.url), 'utf8'));
  type Bind = string | number | null;
  class Statement {
    sql: string;
    values: Bind[];
    constructor(sql: string, values: Bind[] = []) { this.sql = sql; this.values = values; }
    bind(...values: Bind[]) { return new Statement(this.sql, values); }
    async first() { return sqlite.prepare(this.sql).get(...this.values) || null; }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
    async run() { const result = sqlite.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
  }
  const db = { prepare: (sql: string) => new Statement(sql), async batch(statements: Statement[]) {
    sqlite.exec('BEGIN');
    try { const result = []; for (const statement of statements) result.push(await statement.run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  return { db, sqlite };
}
function payload(station = a, position = [120.2087334, 30.2937959]) {
  return { features: [{ properties: { osm_type: 'W', osm_id: 123, osm_key: 'building', osm_value: 'train_station', countrycode: 'CN', name: station.name }, geometry: { type: 'Point', coordinates: position } }] };
}
const status = (code: number) => (error: unknown) => error instanceof service.MapServiceError && error.status === code;
test('一次读取所选范围缓存，保持原经停偏移并忽略过期位置和越界区间', async t => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const before = { code: 'AAA', name: '前站' }, after = { code: 'CCC', name: '后站' };
  const geo = { coordinates: [[120.2,30.2],[120.202,30.202]], distanceMeters: 300, collectedAt: new Date().toISOString(), source: 'BRouter / OpenStreetMap', precision: 'rail-network-reference' };
  for (const [station, position] of [[a,[120.2,30.2]],[b,[120.202,30.202]]] as const) {
    sqlite.prepare('INSERT INTO rail_map_cache VALUES (?,?,?)').run(service.stationMapKey(station), JSON.stringify({ ...station, position, status: 'located' }), Date.now()+60_000);
  }
  sqlite.prepare('INSERT INTO rail_map_cache VALUES (?,?,?)').run(service.trackMapKey([120.2,30.2],[120.202,30.202]),JSON.stringify(geo),Date.now()+60_000);
  const snapshot=await service.mapSnapshot(db,[before,a,b,after],1,2);
  assert.deepEqual(snapshot.stations.map(s=>s.code).sort(),[a.code,b.code].sort());assert.deepEqual(snapshot.tracks,[{fromOffset:1,geometry:geo}]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rail_map_locks').get()!.n,0);
  sqlite.prepare('UPDATE rail_map_cache SET expires_at=0 WHERE cache_key=?').run(service.stationMapKey(b));
  assert.equal((await service.mapSnapshot(db,[before,a,b,after],1,2)).tracks.length,0);
});

test('地图采集地址限定公开来源，凭据独立；正确位置经过校验再缓存', async t => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const start = await service.locateStation(db, owner, a);
  assert.ok('sourceRequest' in start);
  const source = start.sourceRequest, url = new URL(source.url);
  assert.equal(url.origin, 'https://photon.komoot.io');
  assert.equal(url.searchParams.get('q'), a.name);
  assert.ok(!source.url.includes(source.token));
  const done = await service.locateStation(db, owner, a, { sourceToken: source.token, payload: payload() });
  assert.ok('stations' in done);
  assert.deepEqual(done.stations[0].position, [120.2087334, 30.2937959]);
  assert.deepEqual(await service.locateStation(db, owner, a), done);
  await assert.rejects(service.locateStation(db, owner, a, { sourceToken: source.token, payload: payload() }), status(409));
});
test('地图租约不能跨用户、跨车站提交，过期和伪造结果不覆盖缓存', async t => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const start = await service.locateStation(db, owner, a); assert.ok('sourceRequest' in start);
  const sourceToken = start.sourceRequest.token;
  await assert.rejects(service.locateStation(db, 'different-owner', a, { sourceToken, payload: payload() }), status(409));
  await assert.rejects(service.locateStation(db, owner, b, { sourceToken, payload: payload(b) }), status(409));
  await assert.rejects(service.locateStation(db, owner, a, { sourceToken: 'bad-value', payload: payload() }), status(400));
  sqlite.exec('UPDATE rail_map_locks SET until_ms=0');
  await assert.rejects(service.locateStation(db, owner, a, { sourceToken, payload: payload() }), status(409));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rail_map_cache').get()!.n, 0);
});
test('外部地图限流暂停采集，不保存成位置缺失或无票', async t => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  const start = await service.locateStation(db, owner, a); assert.ok('sourceRequest' in start);
  await assert.rejects(service.locateStation(db, owner, a, { sourceToken: start.sourceRequest.token, sourceFailure: 'limited' }), status(429));
  await assert.rejects(service.locateStation(db, owner, a), error => status(429)(error) && (error as InstanceType<typeof service.MapServiceError>).retryAfter > 290);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rail_map_cache').get()!.n, 0);
});
test('路线来源只使用已确认坐标与 rail；公路和缺失轨道不能提交', async t => {
  const { db, sqlite } = database(); t.after(() => sqlite.close());
  await assert.rejects(service.railwaySegment(db, owner, a, b), status(422));
  for (const [station, position] of [[a, [120.2, 30.2]], [b, [120.202, 30.202]]] as const) {
    sqlite.exec('UPDATE rail_map_locks SET until_ms=0');
    const start = await service.locateStation(db, owner, station); assert.ok('sourceRequest' in start);
    await service.locateStation(db, owner, station, { sourceToken: start.sourceRequest.token, payload: payload(station, [...position]) });
  }
  const start = await service.railwaySegment(db, owner, a, b); assert.ok('sourceRequest' in start);
  const url = new URL(start.sourceRequest.url);
  assert.equal(url.origin, 'https://brouter.de'); assert.equal(url.searchParams.get('profile'), 'rail');
  assert.equal(url.searchParams.get('lonlats'), '120.2,30.2|120.202,30.202');
  const road = { features: [{ geometry: { type: 'LineString', coordinates: [[120.2, 30.2], [120.202, 30.202]] }, properties: { messages: [['WayTags'], ['highway=primary']] } }] };
  await assert.rejects(service.railwaySegment(db, owner, a, b, { sourceToken: start.sourceRequest.token, payload: road }), status(422));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM rail_map_cache WHERE cache_key LIKE 'rail-%'").get()!.n, 0);
});
