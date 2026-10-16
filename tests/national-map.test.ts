import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { atlasStation, fitCamera, geographicJourney, mapLabels, nationalCamera, pinchCamera, project, tweenCamera, zoomCamera, type StationAtlas } from '../lib/national-map.ts';
import type { TicketPlan } from '../lib/rail-types';

const atlas = JSON.parse(readFileSync(new URL('../lib/maps/station-atlas.json',import.meta.url),'utf8')) as StationAtlas;
const background = JSON.parse(readFileSync(new URL('../lib/maps/national-background.json',import.meta.url),'utf8')) as {regions:{name:string;path:string}[];labels:{name:string;point:[number,number]}[]};
const stations = JSON.parse(readFileSync(new URL('../lib/stations.json',import.meta.url),'utf8')) as {name:string;code:string}[];
const station = (name:string) => { const item=stations.find(s=>s.name===name);assert.ok(item);return item; };
function plan(kind:TicketPlan['kind']='direct'):TicketPlan {
  const route=['杭州东','杭州南','丽水','温州南','苍南'].map((name,index)=>({station:station(name),index:index+10,arrivalIso:`2026-10-05T${String(18+index).padStart(2,'0')}:00:00+08:00`,departureIso:`2026-10-05T${String(18+index).padStart(2,'0')}:03:00+08:00`}));
  const leg=(from:number,to:number)=>({from:route[from].station,to:route[to].station,departureIso:route[from].departureIso,arrivalIso:route[to].arrivalIso,seat:'second',inventory:{status:'available',count:1,price:100},fetchedAt:'2026-10-05T07:00:00Z'} as TicketPlan['legs'][number]);
  return {id:'map-test',kind,route,origin:route[0].station,target:route[3].station,departureIso:route[0].departureIso,arrivalIso:route[3].arrivalIso,legs:kind==='split'?[leg(0,2),leg(2,3)]:[leg(0,kind==='extension'?2:kind==='long'?4:3)],uncovered:kind==='extension'?{from:route[2].station,to:route[3].station}:null,relationEvidence:'同一列车标识、始发运营日期及完整停站序列核验'} as TicketPlan;
}

test('全国背景包含西部、东北、海南与台港澳标注，宽屏和手机都完整容纳全国范围',()=>{
  for(const name of ['新疆维吾尔自治区','西藏自治区','黑龙江省','海南省','浙江省']) assert.ok(background.regions.some(r=>r.name===name),name);
  for(const name of ['台湾','香港','澳门','南海']) assert.ok(background.labels.some(label=>label.name===name),name);
  for(const [width,height] of [[900,420],[320,360]]) {
    const camera=nationalCamera(width,height);
    for(const lonlat of [[73.6,39.5],[134.8,48.4],[110,18.2],[121,23.7],[114.18,22.32],[113.55,22.17],[115,3]] as [number,number][]) {
      const [x,y]=project(lonlat);assert.ok(x>=camera.x&&x<=camera.x+camera.width&&y>=camera.y&&y<=camera.y+camera.height);
    }
    assert.ok(Math.abs(camera.width/camera.height-width/height)<1e-10);
  }
});
test('离线位置按官方站码与站名查找，覆盖全国主要铁路站，歧义和错误数据不猜测',()=>{
  assert.ok(Object.keys(atlas.stations).length>3000);
  assert.equal(readFileSync(new URL('../public/maps/station-atlas.json',import.meta.url),'utf8'),readFileSync(new URL('../lib/maps/station-atlas.json',import.meta.url),'utf8'));
  for(const name of ['杭州东','北京南','沈阳北','乌鲁木齐','拉萨','海口东']) assert.ok(atlasStation(station(name),atlas),name);
  assert.equal(atlasStation({...station('杭州东'),name:'杭州'},atlas),null);
  const code=station('杭州东').code;
  assert.equal(atlasStation(station('杭州东'),{...atlas,ambiguous:{[code]:'杭州东'}}),null);
  assert.equal(atlasStation(station('杭州东'),{...atlas,stations:{[code]:['杭州东',NaN,30,'n',1]}}),null);
});
test('位置缺失时保留官方站序，但不跨过未知位置画连续路线',()=>{
  const p=plan(),code=p.route[1].station.code;
  const partial={...atlas,stations:{...atlas.stations}};delete partial.stations[code];
  const model=geographicJourney(p,'trip',partial);
  assert.equal(model.stops.length,4);assert.deepEqual(model.missing.map(s=>s.offset),[1]);
  assert.deepEqual(model.segments.map(s=>s.offset),[2]);
});
test('地图票面覆盖、补票虚线和多买区间沿用实际票段，跨日失配不显示为覆盖',()=>{
  assert.deepEqual(geographicJourney(plan('extension'),'trip',atlas).segments.map(s=>s.role),['covered','covered','uncovered']);
  assert.deepEqual(geographicJourney(plan('long'),'trip',atlas).segments.map(s=>s.role),['covered','covered','covered','extra']);
  const split=geographicJourney(plan('split'),'trip',atlas);assert.match(split.stops[2].role,/接续/);
  const otherDay=plan();otherDay.legs[0].departureIso=otherDay.legs[0].departureIso.replace('10-05','10-04');
  assert.ok(geographicJourney(otherDay,'trip',atlas).segments.every(s=>s.role==='other'));
});
test('路线自动适应各类屏幕，镜头平滑过渡从当前镜头开始且在目标结束',()=>{
  const points=geographicJourney(plan(),'trip',atlas).points;
  const from=nationalCamera(800,420),to=fitCamera(points,800,420);
  for(const [x,y] of points) assert.ok(x>=to.x&&x<=to.x+to.width&&y>=to.y&&y<=to.y+to.height);
  assert.deepEqual(tweenCamera(from,to,-1),from);assert.deepEqual(tweenCamera(from,to,2),to);
  const midway=tweenCamera(from,to,.5);assert.ok(Math.abs(midway.width-(from.width+to.width)/2)<1e-9);
  const resumed=tweenCamera(midway,from,0);assert.deepEqual(resumed,midway);
});
test('缩放限制极端倍率，保持触点对应的位置和视口比例',()=>{
  const camera=fitCamera(geographicJourney(plan(),'trip',atlas).points,320,360),anchor:[number,number]=[.2,.7];
  const next=zoomCamera(camera,.6,anchor);
  assert.ok(Math.abs(camera.x+camera.width*anchor[0]-next.x-next.width*anchor[0])<1e-9);
  assert.ok(Math.abs(next.width/next.height-320/360)<1e-9);
  assert.ok(zoomCamera(camera,1e-10).width>=8);
});
test('密集站名优先显示选中站，避免重叠；可见站点仍可独立点击',()=>{
  const labels=Array.from({length:25},(_,id)=>({id,name:'密集车站',point:[400+id*.1,200] as [number,number],important:id<3,selected:id===2,lines:2}));
  const placements=mapLabels(labels,{x:0,y:0,width:800,height:420},800,420);
  assert.ok(placements.has(2));assert.ok(placements.size<labels.length);
  assert.equal(mapLabels([{id:99,name:'界外',point:[999,200],important:true,selected:false,lines:1}],{x:0,y:0,width:800,height:420},800,420).size,0);
});


test('双指缩放与移动以触点中心为锚点，缩放后的站点仍停留在两指之间',()=>{
  const camera={x:200,y:300,width:800,height:600};
  const before:[number,number][]=[[80,120],[180,120]],after:[number,number][]=[[70,140],[210,160]];
  const next=pinchCamera(camera,before,after,320,240);
  const world=[camera.x+130*camera.width/320,camera.y+120*camera.height/240];
  assert.ok(Math.abs(world[0]-(next.x+140*next.width/320))<1e-9);
  assert.ok(Math.abs(world[1]-(next.y+150*next.height/240))<1e-9);
  assert.deepEqual(pinchCamera(camera,[[1,1]],after,320,240),camera);
});
