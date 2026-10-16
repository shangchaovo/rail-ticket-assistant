'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Expand, Globe2, Minus, Plus } from 'lucide-react';
import background from '@/lib/maps/national-background.json';
import atlasData from '@/lib/maps/station-atlas.json';
import { fitCamera, geographicJourney, mapLabels, nationalCamera, pinchCamera, NATIONAL_CAMERA, tweenCamera, zoomCamera, type Camera, type StationAtlas } from '@/lib/national-map';
import { MAP_ROLE_COLORS } from '@/lib/rail-map';
import type { TicketPlan } from '@/lib/rail-types';

const atlas=atlasData as unknown as StationAtlas;
type Model=ReturnType<typeof geographicJourney>;

export default function GeographicMap({plan,scope,selected,onSelect}: {plan:TicketPlan;scope:'trip'|'train';selected:number;onSelect:(offset:number)=>void}) {
  const mapId=useId(),gradientId=useId();
  const svg=useRef<SVGSVGElement>(null),miniRect=useRef<SVGRectElement>(null);
  const camera=useRef<Camera>({...NATIONAL_CAMERA});
  const cameraMode=useRef<'route'|'national'|'custom'>('route');
  const animation=useRef(0),dimensions=useRef({width:800,height:430});
  const pointers=useRef(new Map<number,{x:number;y:number}>());
  const dragged=useRef(false);
  const model=useMemo(()=>geographicJourney(plan,scope,atlas),[plan,scope]);
  const previousModel=useRef<Model|null>(null);
  const [ghost,setGhost]=useState<Model|null>(null);

  const paint=useCallback((next:Camera)=>{
    camera.current=next;
    const node=svg.current;if(!node)return;
    node.setAttribute('viewBox',`${next.x} ${next.y} ${next.width} ${next.height}`);
    const unit=next.width/dimensions.current.width;
    node.style.setProperty('--map-unit',String(unit));
    node.style.setProperty('--map-label-size',`${12*unit}px`);
    const overview=next.width>450;
    node.setAttribute('data-overview',String(overview));
    node.style.setProperty('--map-dot-size',`${(overview?2.8:5)*unit}px`);
    node.style.setProperty('--map-key-dot-size',`${(overview?4.5:6)*unit}px`);
    const stations=[...node.querySelectorAll<SVGGElement>('.geo-route-layer:not(.ghost) > .geo-station')];
    const placements=mapLabels(stations.filter(station=>!overview||station.classList.contains('key-stop')||station.classList.contains('selected')).map(station=>({id:Number(station.dataset.station),point:[Number(station.dataset.mapX),Number(station.dataset.mapY)] as [number,number],name:station.dataset.name||'',important:station.classList.contains('key-stop'),selected:station.classList.contains('selected'),lines:station.classList.contains('key-stop')?2:1})),next,dimensions.current.width,dimensions.current.height);
    for(const station of stations){
      const placement=placements.get(Number(station.dataset.station));
      station.setAttribute('data-label-hidden',String(!placement));
      const label=station.querySelector('text'),role=label?.querySelector('tspan');
      if(placement&&label){label.setAttribute('dx',`${placement.dx*unit}px`);label.setAttribute('dy',`${placement.dy*unit}px`);label.setAttribute('text-anchor',placement.anchor);role?.setAttribute('dx',`${placement.dx*unit}px`);}
    }
    const rect=miniRect.current;
    if(rect){rect.setAttribute('x',String(next.x));rect.setAttribute('y',String(next.y));rect.setAttribute('width',String(next.width));rect.setAttribute('height',String(next.height));}
  },[]);
  const stop=useCallback(()=>{
    cancelAnimationFrame(animation.current);
    svg.current?.setAttribute('data-moving','false');
  },[]);
  const fly=useCallback((to:Camera,duration=760)=>{
    stop();
    if(matchMedia('(prefers-reduced-motion: reduce)').matches){paint(to);return;}
    const from={...camera.current},started=performance.now();
    svg.current?.setAttribute('data-moving','true');
    const frame=(now:number)=>{
      const progress=Math.min(1,(now-started)/duration);
      paint(tweenCamera(from,to,progress));
      if(progress<1)animation.current=requestAnimationFrame(frame);
      else svg.current?.setAttribute('data-moving','false');
    };
    animation.current=requestAnimationFrame(frame);
  },[paint,stop]);
  const fit=useCallback(()=>{cameraMode.current='route';fly(model.points.length?fitCamera(model.points,dimensions.current.width,dimensions.current.height):nationalCamera(dimensions.current.width,dimensions.current.height));},[fly,model]);
  function showNational(){cameraMode.current='national';fly(nationalCamera(dimensions.current.width,dimensions.current.height));}

  useEffect(()=>{
    const node=svg.current;if(!node)return;
    const resize=new ResizeObserver(entries=>{
      const {width,height}=entries[0].contentRect;
      if(width<=0||height<=0)return;
      if(width===dimensions.current.width&&height===dimensions.current.height)return;
      const previous=dimensions.current,current=camera.current;
      dimensions.current={width,height};
      stop();
      if(cameraMode.current==='custom'){const w=current.width*width/previous.width,h=w*height/width;paint({x:current.x+(current.width-w)/2,y:current.y+(current.height-h)/2,width:w,height:h});}
      else fly(cameraMode.current==='national'||!model.points.length?nationalCamera(width,height):fitCamera(model.points,width,height),620);
    });
    resize.observe(node);
    return()=>resize.disconnect();
  },[fly,model,paint,stop]);

  useEffect(()=>{
    const old=previousModel.current;
    previousModel.current=model;
    const frame=requestAnimationFrame(()=>{setGhost(old);fit();});
    const timeout=setTimeout(()=>setGhost(null),440);
    return()=>{cancelAnimationFrame(frame);clearTimeout(timeout);stop();};
  },[model,fit,stop]);

  useEffect(()=>{
    const node=svg.current;if(!node)return;
    const wheel=(event:WheelEvent)=>{
      event.preventDefault();stop();cameraMode.current='custom';
      const rect=node.getBoundingClientRect();
      paint(zoomCamera(camera.current,Math.exp(Math.max(-.24,Math.min(.24,event.deltaY*.0015))),[(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height]));
    };
    node.addEventListener('wheel',wheel,{passive:false});
    return()=>{node.removeEventListener('wheel',wheel);stop();};
  },[paint,stop]);

  useEffect(()=>{
    const frame=requestAnimationFrame(()=>paint(camera.current));
    return()=>cancelAnimationFrame(frame);
  },[selected,paint]);

  function down(event:ReactPointerEvent<SVGSVGElement>){
    if(event.button!==0)return;
    stop();dragged.current=false;
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(!(event.target as Element).closest('[data-station]')) event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event:ReactPointerEvent<SVGSVGElement>){
    const previous=pointers.current.get(event.pointerId);if(!previous)return;
    const before=[...pointers.current.values()];
    pointers.current.set(event.pointerId,{x:event.clientX,y:event.clientY});
    const after=[...pointers.current.values()];
    if(after.length===2){
      const rect=event.currentTarget.getBoundingClientRect();
      const relative=(points:typeof after)=>points.map(point=>[point.x-rect.left,point.y-rect.top] as [number,number]);
      cameraMode.current='custom';
      paint(pinchCamera(camera.current,relative(before),relative(after),rect.width,rect.height));
      dragged.current=true;
    }else{
      const dx=event.clientX-previous.x,dy=event.clientY-previous.y;
      if(Math.abs(dx)+Math.abs(dy)>2){dragged.current=true;cameraMode.current='custom';}
      const current=camera.current;
      paint({...current,x:current.x-dx*current.width/dimensions.current.width,y:current.y-dy*current.height/dimensions.current.height});
    }
  }
  function up(event:ReactPointerEvent<SVGSVGElement>){pointers.current.delete(event.pointerId);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}

  function routeLayer(route:Model,old=false){
    return <g className={old?'geo-route-layer ghost':'geo-route-layer'} key={old?'ghost':`${plan.id}-${scope}`} aria-hidden={old||undefined}>
      {route.segments.map(segment=><g key={segment.offset}><path d={`M${segment.from.join(',')}L${segment.to.join(',')}`} stroke="#fff" strokeWidth={segment.role==='other'?4:8} fill="none" vectorEffect="non-scaling-stroke"/><path className={`geo-segment ${segment.role}`} d={`M${segment.from.join(',')}L${segment.to.join(',')}`} stroke={MAP_ROLE_COLORS[segment.role]} strokeWidth={segment.role==='other'?2:4} strokeDasharray={segment.role==='uncovered'?'8 6':undefined} fill="none" vectorEffect="non-scaling-stroke"/></g>)}
      {route.stops.map(item=>item.location&&<g data-station={item.offset} data-name={item.station.name} data-map-x={item.location.point[0]} data-map-y={item.location.point[1]} className={`geo-station ${selected===item.offset&&!old?'selected':''} ${item.role?'key-stop':''}`} key={item.offset} role={old?undefined:'button'} tabIndex={old?-1:0} aria-label={`${item.station.name} ${item.role||'经停'}，查看车站详情`} aria-pressed={old?undefined:selected===item.offset} onClick={()=>{if(!old&&!dragged.current)onSelect(item.offset);}} onKeyDown={event=>{if(!old&&(event.key==='Enter'||event.key===' ')){event.preventDefault();onSelect(item.offset);}}} transform={`translate(${item.location.point.join(',')})`}>
        <circle className="geo-hit-area" r={15} fill="transparent"/>
        <circle className="geo-station-halo" r={11} fill={item.role?`${MAP_ROLE_COLORS[item.tone]}22`:'transparent'}/>
        <circle className="geo-station-dot" r={6} fill={item.role?MAP_ROLE_COLORS[item.tone]:'#fff'} stroke={MAP_ROLE_COLORS[item.tone]} strokeWidth={2} vectorEffect="non-scaling-stroke"/>
        <text className="geo-station-label" dx=".9em" dy={item.offset%2===0?'-.8em':'1.6em'}>{item.station.name}{item.role&&<tspan className="geo-station-role" x={0} dx=".9em" dy="1.25em">{item.role.split(' · ')[0]}</tspan>}</text>
      </g>)}
    </g>;
  }

  return <section className="national-map-panel" aria-label="全国地理地图">
    <div className="national-map-title"><span><Globe2 size={15}/><b>中国 · 经停位置</b></span><small>{model.stops.length-model.missing.length}/{model.stops.length} 站已定位</small></div>
    <div className="national-map-canvas">
      <svg className="national-map-viewport" id={mapId} ref={svg} viewBox={`${NATIONAL_CAMERA.x} ${NATIONAL_CAMERA.y} ${NATIONAL_CAMERA.width} ${NATIONAL_CAMERA.height}`} role="group" aria-label="全国车站地理位置，连线表示经停顺序" data-map-instance={mapId} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <defs><linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#eef7fc"/><stop offset="1" stopColor="#dceef9"/></linearGradient></defs>
        <rect x={-2000} y={-2000} width={6000} height={6000} fill={`url(#${gradientId})`}/>
        <g className="geo-provinces">{background.regions.map((region,index)=><path key={index} d={region.path} fill={index%3===0?'#f0f6ec':index%3===1?'#eaf3e6':'#f4f7ed'} stroke="#b6c9b4" strokeWidth={.7} fillRule="evenodd" vectorEffect="non-scaling-stroke"/>)}</g>
        <g className="geo-province-labels" aria-hidden="true">{background.labels.map((label,index)=><text key={index} x={label.point[0]} y={label.point[1]} textAnchor="middle">{label.name}</text>)}</g>
        {ghost&&routeLayer(ghost,true)}{routeLayer(model)}
      </svg>
      <div className="national-map-controls"><button onClick={showNational}><Globe2 size={14}/>全国</button><button onClick={fit}><Expand size={14}/>当前路线</button><div><button aria-label="地图放大" onClick={()=>{cameraMode.current='custom';fly(zoomCamera(camera.current,.65),300);}}><Plus size={16}/></button><button aria-label="地图缩小" onClick={()=>{cameraMode.current='custom';fly(zoomCamera(camera.current,1.5),300);}}><Minus size={16}/></button></div></div>
      <span className="national-map-north" aria-hidden="true">↑<small>北</small></span>
      <button className="national-map-mini" aria-label="全国概览，切换到全国地图" onClick={showNational}><svg viewBox={`${NATIONAL_CAMERA.x} ${NATIONAL_CAMERA.y} ${NATIONAL_CAMERA.width} ${NATIONAL_CAMERA.height}`} aria-hidden="true">{background.regions.map((region,index)=><path key={index} d={region.path} fill="#d9e7d4" stroke="#b7ceb0" strokeWidth={2}/>)}{model.segments.map(segment=><path key={segment.offset} d={`M${segment.from.join(',')}L${segment.to.join(',')}`} fill="none" stroke={MAP_ROLE_COLORS[segment.role]} strokeWidth={10}/>)}<rect ref={miniRect} className="national-map-mini-frame" fill="#4e94e919" stroke="#4e94e9" strokeWidth={3}/></svg><span>全国概览</span></button>
      <span className="national-map-hint">拖动地图 · 滚轮 / 双指缩放</span>
    </div>
    <div className="national-map-caption"><span>经停连线示意，非实际轨道或列车位置</span><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a><a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a></div>
    {model.missing.length>0&&<p className="national-map-missing">{model.missing.map(item=>item.station.name).join('、')} 位置未确认；地图保留缺口，请在站序图查看经停。</p>}
  </section>;
}
