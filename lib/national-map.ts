import type { Station, TicketPlan } from './rail-types';
import { journeyRange, journeySegment, journeyStop } from './rail-journey.ts';

export type Point = [number, number];
export type Camera = { x: number; y: number; width: number; height: number };
export type AtlasEntry = [name: string, longitude: number, latitude: number, osmType: string, osmId: number];
export type StationAtlas = { stations: Record<string, AtlasEntry>; ambiguous: Record<string, string>; collectedAt: string; dataTime: string | null };
export function project([lon, lat]: Point): Point {
  const mercator = (latitude: number) => Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) * 180 / Math.PI;
  return [(lon - 72) * 16, (mercator(55) - mercator(lat)) * 16];
}
const northWest = project([72,55]), southEast = project([137,3]);
export const NATIONAL_CAMERA: Camera = { x:northWest[0], y:northWest[1], width:southEast[0]-northWest[0], height:southEast[1]-northWest[1] };
export function nationalCamera(width: number, height: number): Camera {
  let w=NATIONAL_CAMERA.width,h=NATIONAL_CAMERA.height;
  const ratio=Math.max(1,width)/Math.max(1,height);
  if(w/h<ratio)w=h*ratio;else h=w/ratio;
  return {x:NATIONAL_CAMERA.x+(NATIONAL_CAMERA.width-w)/2,y:NATIONAL_CAMERA.y+(NATIONAL_CAMERA.height-h)/2,width:w,height:h};
}
export function atlasStation(station: Station, atlas: StationAtlas) {
  const record = atlas.stations[station.code];
  if (!record || record[0] !== station.name || atlas.ambiguous[station.code]) return null;
  const [,lon,lat,type,id] = record;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon<73 || lon>136 || lat<18 || lat>54 || !['n','w','r'].includes(type) || !Number.isSafeInteger(id) || id<=0) return null;
  return { point:project([lon,lat]), position:[lon,lat] as Point, osmUrl:`https://www.openstreetmap.org/${{n:'node',w:'way',r:'relation'}[type]}/${id}` };
}
export function fitCamera(points: Point[], width: number, height: number): Camera {
  if (!points.length || width<=0 || height<=0) return { ...NATIONAL_CAMERA };
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
  let w=Math.max(12,right-left)*1.45,h=Math.max(12,bottom-top)*1.5;
  if(w/h<width/height) w=h*width/height; else h=w*height/width;
  return { x:(left+right-w)/2,y:(top+bottom-h)/2,width:w,height:h };
}
export function tweenCamera(from: Camera, to: Camera, progress: number): Camera {
  const t=Math.max(0,Math.min(1,progress));
  if(t===0)return {...from};
  if(t===1)return {...to};
  const ease=t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
  return Object.fromEntries(Object.keys(from).map(key=>[key,from[key as keyof Camera]+(to[key as keyof Camera]-from[key as keyof Camera])*ease])) as Camera;
}
export function zoomCamera(camera: Camera, scale: number, anchor: Point = [.5,.5]): Camera {
  const width=Math.max(8,Math.min(NATIONAL_CAMERA.width*1.7,camera.width*scale)),height=camera.height*width/camera.width;
  return {x:camera.x+(camera.width-width)*anchor[0],y:camera.y+(camera.height-height)*anchor[1],width,height};
}
/** Preserve the geographic point beneath the fingers while pinching or panning. */
export function pinchCamera(camera: Camera, before: Point[], after: Point[], width: number, height: number): Camera {
  if(before.length!==2||after.length!==2||width<=0||height<=0)return {...camera};
  const distance=(points:Point[])=>Math.hypot(points[0][0]-points[1][0],points[0][1]-points[1][1]);
  const prior=distance(before),current=distance(after);
  if(prior<=0||current<=0)return {...camera};
  const center=(points:Point[]):Point=>[(points[0][0]+points[1][0])/2,(points[0][1]+points[1][1])/2];
  const from=center(before),to=center(after),zoom=zoomCamera(camera,prior/current,[from[0]/width,from[1]/height]);
  return {...zoom,x:zoom.x-(to[0]-from[0])*zoom.width/width,y:zoom.y-(to[1]-from[1])*zoom.height/height};
}
export function geographicJourney(plan: TicketPlan, scope: 'trip'|'train', atlas: StationAtlas) {
  const range=journeyRange(plan,scope);
  const stops=plan.route.map((stop,offset)=>({offset,station:stop.station,role:journeyStop(plan,offset).role,tone:journeySegment(plan,offset===range.end?offset-1:offset).role,location:atlasStation(stop.station,atlas)})).filter(stop=>stop.offset>=range.start&&stop.offset<=range.end);
  const segments=stops.slice(0,-1).flatMap((stop,index)=>{
    const next=stops[index+1];
    if(!stop.location||!next.location)return [];
    return [{from:stop.location.point,to:next.location.point,role:journeySegment(plan,stop.offset).role,offset:stop.offset}];
  });
  return {stops,segments,missing:stops.filter(stop=>!stop.location),points:stops.flatMap(stop=>stop.location?[stop.location.point]:[])};
}

export type MapLabel = { id: number; point: Point; name: string; important: boolean; selected: boolean; lines: number };
/** Place the most useful labels first; leave dense national views readable. */
export function mapLabels(labels: MapLabel[], camera: Camera, width: number, height: number) {
  const result = new Map<number, { dx: number; dy: number; anchor: 'start' | 'end' }>();
  const boxes: { left: number; right: number; top: number; bottom: number }[] = [];
  const ordered = [...labels].sort((a,b) => Number(b.selected)-Number(a.selected) || Number(b.important)-Number(a.important));
  for (const label of ordered) {
    const x=(label.point[0]-camera.x)/camera.width*width, y=(label.point[1]-camera.y)/camera.height*height;
    const w=Math.max(48,label.name.length*12+4),h=label.lines*15;
    if(x<0||x>width||y<0||y>height)continue;
    const positions = [{dx:12,dy:-12,anchor:'start'},{dx:12,dy:22,anchor:'start'},{dx:-12,dy:-12,anchor:'end'},{dx:-12,dy:22,anchor:'end'},{dx:12,dy:-32,anchor:'start'}] as const;
    for (const position of positions) {
      const left=x+position.dx-(position.anchor==='end'?w:0),top=y+position.dy-12;
      const box={left,right:left+w,top,bottom:top+h};
      if(box.left<4||box.right>width-4||box.top<45||box.bottom>height-36)continue;
      if(boxes.some(other=>box.left<other.right+4&&box.right>other.left-4&&box.top<other.bottom+3&&box.bottom>other.top-3))continue;
      result.set(label.id,position);boxes.push(box);break;
    }
  }
  return result;
}
