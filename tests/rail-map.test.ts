import test from 'node:test';
import assert from 'node:assert/strict';
import type { TicketPlan } from '../lib/rail-types';
const { parseMapStations, parsePhotonStation, parseRailGeometry, planMapRange, segmentRole, stationRole }: typeof import('../lib/rail-map') = await import(new URL('../lib/rail-map.ts', import.meta.url).href);
const collected = '2026-10-05T12:00:00Z';
const stations = ['南京南', '杭州东', '杭州南', '丽水', '温州南', '瑞安'].map((name, index) => ({ name, code: `S${index}` }));
function plan(kind: TicketPlan['kind']): TicketPlan {
  const legs = kind === 'split' ? [{ from: stations[1], to: stations[3] }, { from: stations[3], to: stations[4] }] : [{ from: stations[1], to: kind === 'extension' ? stations[3] : kind === 'long' ? stations[5] : stations[4] }];
  return { kind, origin: stations[1], target: stations[4], route: stations.map((station, index) => ({ station, index: index + 7 })), legs, uncovered: kind === 'extension' ? { from: stations[3], to: stations[4] } : null } as TicketPlan;
}
test('地图按数组站序标记连续两段；接续站、区间外与乘车范围正确', () => {
  const p = plan('split');
  assert.deepEqual(planMapRange(p, 'trip'), { start: 1, end: 4 });
  assert.deepEqual(planMapRange(p, 'train'), { start: 0, end: 5 });
  assert.deepEqual([0, 1, 2, 3, 4].map(i => segmentRole(p, i)), ['other', 'covered', 'covered', 'covered', 'other']);
  assert.equal(stationRole(p, stations[3].code), '接续 · 可能换座');
});
test('短票未覆盖区间独立着色，买长乘短保留多买区间', () => {
  const short = plan('extension'), long = plan('long');
  assert.equal(segmentRole(short, 2), 'covered');
  assert.equal(segmentRole(short, 3), 'uncovered');
  assert.equal(segmentRole(short, 4), 'other');
  assert.deepEqual(planMapRange(long, 'trip'), { start: 1, end: 5 });
  assert.equal(segmentRole(long, 3), 'covered');
  assert.equal(segmentRole(long, 4), 'extra');
  assert.equal(stationRole(long, stations[4].code), '下车');
  assert.equal(stationRole(long, stations[5].code), '票面到站');
});
test('位置缺失、地铁、同名异地、错误响应都不能替代铁路站位置', () => {
  const node = { type: 'node', id: 42, lon: 120.2, lat: 30.2, tags: { railway: 'station', name: '杭州东站' } };
  assert.equal(parseMapStations({ elements: [node] }, [stations[1]], collected)[0].osmUrl, 'https://www.openstreetmap.org/node/42');
  assert.equal(parseMapStations({ elements: [{ ...node, tags: { ...node.tags, station: 'subway' } }] }, [stations[1]], collected)[0].position, null);
  assert.equal(parseMapStations({ elements: [node, { ...node, id: 43, lon: 120.9 }] }, [stations[1]], collected)[0].status, 'ambiguous');
  assert.equal(parseMapStations({ elements: [] }, [stations[1]], collected)[0].status, 'missing');
  assert.throws(() => parseMapStations({ elements: [], remark: 'timed out' }, [stations[1]], collected));
});
test('Photon 仅接受同名中国铁路站或站房，拒绝城市与普通地址', () => {
  const feature = { properties: { osm_type: 'W', osm_id: 123, osm_key: 'building', osm_value: 'train_station', countrycode: 'CN', name: '杭州东' }, geometry: { type: 'Point', coordinates: [120.2, 30.2] } };
  assert.deepEqual(parsePhotonStation({ features: [feature] }, stations[1], collected).position, [120.2, 30.2]);
  assert.equal(parsePhotonStation({ features: [{ ...feature, properties: { ...feature.properties, osm_value: 'city' } }] }, stations[1], collected).position, null);
  assert.equal(parsePhotonStation({ features: [feature] }, stations[2], collected).position, null);
  const rail = { ...feature, properties: { ...feature.properties, osm_type: 'N', osm_key: 'railway', osm_value: 'station' } };
  assert.deepEqual(parsePhotonStation({ features: [rail] }, stations[1], collected).position, [120.2, 30.2]);
  for (const subtype of ['subway', 'light_rail', 'tram', 'monorail']) {
    assert.equal(parsePhotonStation({ features: [{ ...rail, properties: { ...rail.properties, extra: { station: subtype } } }] }, stations[1], collected).position, null);
  }
});
function geometry(tags = 'railway=rail', coordinates: number[][] = [[120.2, 30.2], [120.201, 30.201], [120.202, 30.202]]) {
  return { features: [{ geometry: { type: 'LineString', coordinates }, properties: { messages: [['WayTags'], [tags]] } }] };
}
test('真实铁路线保留曲线与来源，拒绝公路、地铁和未经证明的几何', () => {
  const result = parseRailGeometry(geometry(), [120.2, 30.2], [120.202, 30.202], collected);
  assert.equal(result.coordinates.length, 3);
  assert.equal(result.precision, 'rail-network-reference');
  assert.equal(result.collectedAt, collected);
  assert.ok(result.distanceMeters > 250);
  assert.throws(() => parseRailGeometry(geometry('highway=primary'), [120.2, 30.2], [120.202, 30.202], collected));
  assert.throws(() => parseRailGeometry(geometry('railway=subway'), [120.2, 30.2], [120.202, 30.202], collected));
  assert.throws(() => parseRailGeometry({ features: [{ geometry: geometry().features[0].geometry, properties: {} }] }, [120.2, 30.2], [120.202, 30.202], collected));
});
test('不能把相距很远的车站吸附点或跳跃线路标成已绘制轨道', () => {
  assert.throws(() => parseRailGeometry(geometry(), [121, 31], [120.202, 30.202], collected));
  assert.throws(() => parseRailGeometry(geometry('railway=rail', [[120.2, 30.2], [121.5, 31.5], [120.202, 30.202]]), [120.2, 30.2], [120.202, 30.202], collected));
});
