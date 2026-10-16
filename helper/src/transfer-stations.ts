import type {Station} from '../shared/rail-types.ts';
import {STATION_LOCATIONS} from './station-locations.ts';

const HUBS=['深圳北','广州南','厦门北','潮汕','福州南','福州','宁波','杭州东','上海虹桥','南京南','合肥南','南昌西','赣州西','长沙南','衡阳东','武汉','汉口','郑州东','石家庄','北京西','北京南','天津西','天津南','济南西','徐州东','青岛北','西安北','兰州西','西宁','成都东','重庆西','重庆北','贵阳北','昆明南','南宁东','柳州','襄阳东','沈阳北','沈阳','长春西','哈尔滨西','大连北','乌鲁木齐'];
function position(station:Station):[number,number]|null {
  const value=STATION_LOCATIONS[station.code];
  return value&&value[0]===station.name?[value[1],value[2]]:null;
}
function distance(a:[number,number],b:[number,number]) {
  const rad=Math.PI/180,dy=(b[1]-a[1])*rad,dx=(b[0]-a[0])*rad;
  return 6371*2*Math.asin(Math.min(1,Math.sqrt(Math.sin(dy/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dx/2)**2)));
}
export function transferCandidates(from:Station,to:Station,stations:Station[]):{stations:Station[];limited:boolean} {
  const byName=new Map(stations.map(s=>[s.name,s]));
  const pool=HUBS.flatMap(name=>{const s=byName.get(name);return s&&s.code!==from.code&&s.code!==to.code?[s]:[];});
  const a=position(from),b=position(to);
  // Hong Kong rail crossings connect at these actual stations. These are only
  // discovery hints; each of the two tickets still requires current official inventory.
  const preferred=to.name==='香港西九龙'?['深圳北','广州南','潮汕','厦门北']:from.name==='香港西九龙'?['深圳北','广州南','厦门北','潮汕']:[];
  const ordered=[...pool].sort((x,y)=>{
    if(a&&b){
      const score=(s:Station)=>{const p=position(s);if(!p)return Infinity;const d1=distance(a,p),d2=distance(p,b);return d1+d2+Math.max(0,50-Math.min(d1,d2))*2;};
      return score(x)-score(y)||x.name.localeCompare(y.name,'zh');
    }
    return x.name.localeCompare(y.name,'zh');
  });
  const result=[...preferred.flatMap(name=>pool.filter(s=>s.name===name)),...ordered];
  return {stations:[...new Map(result.map(s=>[s.code,s])).values()].slice(0,4),limited:!a||!b};
}
