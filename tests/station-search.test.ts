import test from 'node:test';
import assert from 'node:assert/strict';
import stations from '../lib/stations.json' with { type: 'json' };
import { commitStationInput, resolveStationName, searchStations, selectableStation, stationCityLabel, stationOptionLabel } from '../lib/station-search.ts';

const names = new Set(stations.map(station => station.name));

test('官方站名可以搜到，不存在的站名不会被造出来', () => {
  assert.equal(stationCityLabel(''), null);
  assert.equal(stationCityLabel('温州'), '温州');
  assert.equal(names.has('温州站'), false);
  assert.equal(names.has('北京站'), false);
  assert.equal(names.has('南平站'), false);

  const wenzhou = searchStations('温州');
  assert.equal(wenzhou.cityOnly, false);
  assert.equal(wenzhou.cityQuery, true);
  assert.deepEqual(resolveStationName('温州'), { name: '温州', code: 'RZH' });
  assert.equal(resolveStationName('温州站'), null);
  assert.equal(commitStationInput('温州', null), null);
  assert.equal(selectableStation(wenzhou.stations[0]!), false);
  assert.equal(commitStationInput('温州', wenzhou.stations[0]!), null);
  assert.equal(wenzhou.stations[0]?.code, 'RZH');
  assert.equal(wenzhou.stations[0]?.label, '温州');
  assert.equal(wenzhou.stations.find(item => item.name === '温州南')?.code, 'VRH');
  assert.equal(selectableStation(wenzhou.stations.find(item => item.name === '温州南')!), true);
  assert.equal(wenzhou.stations.find(item => item.name === '乐清')?.code, 'UPH');
  assert.ok(wenzhou.stations.every(item => names.has(item.name) && item.label === item.name && item.label !== '温州站'));
  assert.equal(searchStations('温州站').stations.some(item => item.name === '温州站'), false);

  const city = searchStations('南平');
  assert.equal(city.cityOnly, true);
  assert.equal(resolveStationName('南平'), null);
  assert.equal(resolveStationName('南平站'), null);
  assert.equal(commitStationInput('南平', null), null);
  assert.equal(city.stations.find(station => station.name === '南平市')?.code, 'NOS');
  assert.ok(city.stations.every(station => station.name !== '南平' && station.name !== '南平站' && names.has(station.name)));
});

test('没有同名车站的城市只返回真实车站', () => {
  const cities = new Set(stations.map(station => station.city).filter(Boolean));
  for (const city of cities) {
    const result = searchStations(city);
    assert.ok(result.stations.every(station => names.has(station.name) && station.label === station.name));
    assert.equal(result.stations.some(station => station.name === `${city}站`), false);
    if (!names.has(city)) {
      assert.equal(result.cityOnly, true);
      assert.equal(resolveStationName(city), null);
      assert.equal(result.stations.some(station => station.name === city), false);
    } else {
      assert.equal(result.cityOnly, false);
      const sameName = result.stations.find(station => station.name === city);
      assert.ok(sameName);
      if (sameName.city === city) {
        assert.equal(selectableStation(sameName), false);
        assert.equal(commitStationInput(city, sameName), null);
      }
    }
    assert.ok(result.stations.filter(selectableStation).every(station => station.name !== station.city));
  }

  const hulun = searchStations('呼伦贝尔');
  assert.equal(hulun.cityOnly, true);
  assert.equal(names.has('呼伦贝尔'), false);
  assert.ok(hulun.stations.some(station => station.name === '海拉尔'));
  assert.ok(hulun.stations.every(station => station.city === '呼伦贝尔' && station.name !== '呼伦贝尔'));

  assert.deepEqual(resolveStationName('北京'), { name: '北京', code: 'BJP' });
  assert.equal(resolveStationName('北京站'), null);
  assert.equal(searchStations('北京').stations[0]?.name, '北京');
  assert.equal(searchStations('北京').stations.find(station => station.name === '北京南')?.code, 'VNP');
  assert.deepEqual(resolveStationName('杭州东'), { name: '杭州东', code: 'HGH' });
  assert.deepEqual(resolveStationName('南京南'), { name: '南京南', code: 'NKH' });
  assert.equal(searchStations('上海虹桥').stations.find(station => station.name === '上海虹桥')?.city, '上海');
  for (const station of stations) assert.equal(stationOptionLabel(station.name, station.city), station.name);
});
