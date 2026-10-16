import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeCached, readRouteCache, writeRouteCache } from '../lib/rail-map-cache.ts';
import { tourPosition } from '../lib/tour-layout.ts';
import type { MapStation, RailGeometry } from '../lib/rail-map';
const route=[{code:'AAA',name:'甲'},{code:'BBB',name:'乙'},{code:'CCC',name:'丙'}];
const stations=Object.fromEntries(route.map(s=>[s.code,{...s,position:[120,30],status:'located',collectedAt:'2026-10-05T12:00:00Z',osmUrl:null}])) as Record<string,MapStation>;
const geometry={coordinates:[[120,30],[120.1,30.1]],distanceMeters:1000,collectedAt:'2026-10-05T12:00:00Z',source:'BRouter / OpenStreetMap',precision:'rail-network-reference'} as RailGeometry;
test('地图内存按完整经停顺序隔离，跨范围复用但不把偏移套给另一条路线',()=>{
  writeRouteCache(route,stations,{1:geometry},1000);
  const value=readRouteCache(route,1100)!;assert.deepEqual(value.tracks,{1:geometry});
  assert.equal(readRouteCache([route[1],route[0],route[2]],1100),null);
  assert.equal(rangeCached(value.stations,value.tracks,route,1,2),true);
  assert.equal(rangeCached(value.stations,value.tracks,route,0,2),false);
  (value.tracks as Record<number,RailGeometry>)[0]=geometry;assert.equal(readRouteCache(route,1100)?.tracks[0],undefined);
  assert.equal(readRouteCache(route,301001),null);
});
test('缺失站点或轨道不能当作完整地图缓存',()=>{
  assert.equal(rangeCached({AAA:stations.AAA},{},route,0,1),false);
  assert.equal(rangeCached(stations,{},route,0,1),false);
});
test('手机和窄电脑的浮窗始终在视口内，宽屏放在高亮控件旁',()=>{
  for(const viewport of [{width:390,height:844},{width:320,height:568},{width:800,height:600},{width:1440,height:900}]){
    const card={width:Math.min(350,viewport.width-24),height:330};
    const target={left:24,top:120,right:300,bottom:300};
    const result=tourPosition(target,viewport,card);
    assert.ok(result.left>=12&&result.top>=12);assert.ok(result.left+card.width<=viewport.width-12);assert.ok(result.top+card.height<=viewport.height-12);
    if(viewport.width===1440)assert.ok(result.left>target.right);
  }
});
test('手机经停列表无法继续向上滚动时，教程置于列表上方而不遮挡',()=>{
  const target={left:20,top:474,right:370,bottom:684},card={width:350,height:296};
  const result=tourPosition(target,{width:390,height:844},card);
  assert.ok(result.top>=12);
  assert.ok(result.top+card.height+16<=target.top);
});
