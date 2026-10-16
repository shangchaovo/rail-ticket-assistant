'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, MapPinned, RefreshCw, Route, Ticket, TrainFront, TriangleAlert, X } from 'lucide-react';
import { MAP_ROLE_COLORS } from '@/lib/rail-map';
import { completeJourney, journeyRange, journeySegment, journeyStop, stationSearchUrl } from '@/lib/rail-journey';
import { planPurchasePrice } from '@/lib/result-view';
import { SEAT_LABELS, type TicketPlan } from '@/lib/rail-types';
import { purchaseLinks, ticketLegUrl } from '@/lib/rail-purchase';
import UsageTour from './usage-tour';
import GeographicMap from './geographic-map';

const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const collected = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const dateTime = (value: string | null) => value ? formatter.format(new Date(value)) : '未提供';
const price = (value: number | null) => value === null ? '待确认' : `¥${value}`;
const availability = { available: '有票', sold_out: '无票', waitlist: '候补', not_on_sale: '未起售', unsupported: '不支持', unknown: '未确认' };
const coverageLabels = { covered: '票面覆盖', uncovered: '未覆盖 · 需补票', extra: '多买区间', other: '乘车区间外' };
const labels = { direct: '直达票', split: '同车两段票', long: '买长乘短', extension: '短票＋申请补票', transfer: '异车中转' };

export default function RouteMap({ plan, plans = [plan], onPlanChange, onClose, onRecheck, recheckDisabled = true }: {
  plan: TicketPlan; plans?: TicketPlan[]; onPlanChange?: (id: string) => void; jobId: string; onClose: () => void; onRecheck?: () => void; recheckDisabled?: boolean;
}) {
  const heading = useId(), stopId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<'trip' | 'train'>('trip');
  const [view, setView] = useState<'map' | 'route'>('map');
  const [keyOnly, setKeyOnly] = useState(false);
  const [selection, setSelection] = useState(() => ({ planId: plan.id, offset: journeyRange(plan, 'trip').start }));
  const selected = selection.planId === plan.id ? selection.offset : journeyRange(plan, 'trip').start;
  const setSelected = (offset: number) => setSelection({ planId: plan.id, offset });
  const [tourOpen, setTourOpen] = useState(false);
  const [copiedPlan, setCopiedPlan] = useState('');
  const [copyError, setCopyError] = useState('');
  const closeTour = useCallback(() => setTourOpen(false), []);
  const verified = completeJourney(plan);
  const trainCodes = plan.kind==='transfer'?plan.legs.map(l=>l.train?.trainCode).join(' → '):plan.train.trainCode;
  const activeScope = verified ? scope : 'trip';
  const range = journeyRange(plan, activeScope);
  const planIndex = plans.findIndex(item => item.id === plan.id);
  const offsets = plan.route.map((_, index) => index).filter(index => index >= range.start && index <= range.end);
  const keyOffsets = offsets.filter(index => journeyStop(plan, index).role || index === range.start || index === range.end);
  const shown = keyOnly ? keyOffsets : offsets;
  const stop = plan.route[selected];
  const facts = journeyStop(plan, selected);
  const roles = [...new Set(offsets.slice(0, -1).map(index => journeySegment(plan, index).role))];
  const total = planPurchasePrice(plan);
  const minutes = Math.round((Date.parse(plan.arrivalIso) - Date.parse(plan.departureIso)) / 60000);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]') || [])].filter(element => element.getClientRects().length);
      if (event.shiftKey && (document.activeElement === elements[0] || document.activeElement === dialog.current)) { event.preventDefault(); elements.at(-1)?.focus(); }
      else if (!event.shiftKey && (document.activeElement === elements.at(-1) || document.activeElement === dialog.current)) { event.preventDefault(); elements[0]?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);

  function choose(offset: number) {
    setSelected(offset);
    if (view === 'route') document.getElementById(`${stopId}-${offset}`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    else if (innerWidth <= 760) requestAnimationFrame(() => dialog.current?.querySelector('.geographic-inspector')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }));
  }
  async function copy() {
    const lines = [`${trainCodes} · ${labels[plan.kind]}`, `${plan.origin.name} → ${plan.target.name}，${collected.format(new Date(plan.departureIso))} 上车`];
    plan.legs.forEach((leg, index) => lines.push(`第${index + 1}张：${leg.train?.trainCode||plan.train.trainCode} ${leg.from.name}（${leg.from.code}） → ${leg.to.name}（${leg.to.code}），${collected.format(new Date(leg.departureIso))}，${SEAT_LABELS[leg.seat]}，${price(leg.inventory.price)}\n${ticketLegUrl(leg)}`));
    if (plan.uncovered) lines.push(`尚未覆盖：${plan.uncovered.from.name} → ${plan.uncovered.to.name}；须在原票到站前申请补票，能否获准待确认。`);
    lines.push(`12306 采集 ${collected.format(new Date(plan.fetchedTo))}，候选票尚未购买。`);
    try { await navigator.clipboard.writeText(lines.join('\n')); setCopiedPlan(plan.id); setCopyError(''); }
    catch { setCopyError('复制未完成，请在方案中查看购票条件。'); }
  }

  return <div className="route-map-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="route-map-dialog journey-dialog" role="dialog" aria-modal="true" aria-labelledby={heading} tabIndex={-1} ref={dialog}>
      <header className="route-map-heading"><span className="map-heading-icon"><TrainFront size={25} /></span><div><h2 id={heading}>{trainCodes} 乘车路线</h2><p>{plan.origin.name}<ArrowRight size={13} />{plan.target.name}<span>· {labels[plan.kind]}</span></p></div><button className="map-tour-button" aria-label="路线教程" title="路线教程" onClick={() => { setView('map'); setTourOpen(true); }}><BookOpen size={15} />路线教程</button><button className="icon-button" onClick={onClose} aria-label="关闭乘车路线"><X size={22} /></button></header>
      {onPlanChange && plans.length > 1 && <div className="journey-plan-switcher" aria-label="切换班次与方案">
        <span>切换方案</span><button aria-label="上一个方案" disabled={planIndex <= 0} onClick={() => onPlanChange(plans[planIndex - 1].id)}><ChevronLeft size={18} /></button>
        <select aria-label="选择班次与方案" value={plan.id} onChange={event => onPlanChange(event.target.value)}>{plans.map(item => <option key={item.id} value={item.id}>{item.kind==='transfer'?item.legs.map(l=>l.train?.trainCode).join(' → '):item.train.trainCode} · {item.target.name} · {labels[item.kind]}{item.kind === 'split' ? ` · ${item.legs[0].to.name}接续` : item.kind === 'extension' ? ` · 买到${item.legs[0].to.name}` : item.kind === 'long' ? ` · 买到${item.legs.at(-1)?.to.name}` : ''} · {item.legs.map(leg => SEAT_LABELS[leg.seat]).join('＋')}</option>)}</select>
        <button aria-label="下一个方案" disabled={planIndex >= plans.length - 1} onClick={() => onPlanChange(plans[planIndex + 1].id)}><ChevronRight size={18} /></button><small>{planIndex + 1} / {plans.length}</small>
      </div>}
      <div className="route-map-toolbar"><div className="map-segmented" role="group" aria-label="路线范围"><button aria-pressed={activeScope === 'trip'} className={activeScope === 'trip' ? 'active' : ''} onClick={() => { setScope('trip'); setSelected(journeyRange(plan, 'trip').start); }}>我的乘车区间</button><button disabled={!verified} aria-pressed={activeScope === 'train'} className={activeScope === 'train' ? 'active' : ''} aria-label="全部经停" onClick={() => setScope('train')}>全部经停<small>{plan.route.length}站</small></button></div><div className="map-view-switch" role="group" aria-label="路线展示方式"><button aria-pressed={view === 'map'} className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}><MapPinned size={15} />地理地图</button><button aria-pressed={view === 'route'} className={view === 'route' ? 'active' : ''} onClick={() => setView('route')}><Route size={15} />站序图</button></div></div>
      <div className="route-map-scroll">
        <section className="journey-overview" aria-label="乘车概要"><div><span>出发 · {plan.origin.name}</span><strong>{dateTime(plan.departureIso)}</strong></div><div className="journey-duration"><ArrowRight size={21} /><span>{Number.isFinite(minutes) ? `${minutes} 分钟` : '用时待确认'}</span></div><div><span>到达 · {plan.target.name}</span><strong>{dateTime(plan.arrivalIso)}</strong></div><div className="journey-ticket-total"><span>{plan.legs.length} 张票 · 票面价格</span><strong>{price(total)}</strong>{plan.uncovered && <small>后续补票金额待确认</small>}</div></section>
        {plan.kind==='transfer'&&<p className="journey-notice"><RefreshCw size={15}/>在 {plan.transfer?.station.name} 换乘另一趟车 · 等待 {plan.transfer?.waitMinutes} 分钟{plan.transfer?.overnight?' · 次日换乘，需自行安排过夜':''}。票价不含住宿等费用。</p>}
        {plan.kind === 'split' && <p className="journey-notice"><RefreshCw size={15} />在 {plan.legs[0].to.name} 接续第 2 张票，{SEAT_LABELS[plan.legs[0].seat]} → {SEAT_LABELS[plan.legs[1].seat]}；同一班车，可能需要换座。</p>}
        {plan.uncovered && <p className="journey-notice uncovered"><TriangleAlert size={16} /><span>{plan.uncovered.from.name} → {plan.uncovered.to.name} 尚未覆盖。须在短票到站前申请补票；是否获准待确认。</span></p>}
        {plan.kind === 'long' && <p className="journey-notice extra"><Ticket size={15} />在 {plan.target.name} 下车；{plan.target.name} → {plan.legs.at(-1)?.to.name} 为多买区间。</p>}
        {!verified && <p className="journey-notice uncovered"><TriangleAlert size={16} />目前只确认各票段端点；完整经停尚未核验。</p>}
        <>
          <div className="map-legend">{roles.map(role => <span key={role}><i style={{ borderColor: MAP_ROLE_COLORS[role], borderStyle: role === 'uncovered' ? 'dashed' : 'solid' }} />{coverageLabels[role]}</span>)}<span className="journey-official"><Check size={13} />{verified ? '12306 经停顺序' : '已确认的票段端点'}</span></div>
          <div className="journey-key-jumps" aria-label="跳到关键车站">{keyOffsets.map(offset => <button key={offset} aria-label={`${journeyStop(plan, offset).role.split(' · ')[0] || '经停'} ${plan.route[offset].station.name}`} onClick={() => choose(offset)}><span className="journey-jump-role">{journeyStop(plan, offset).role.split(' · ')[0] || '经停'}</span><strong>{plan.route[offset].station.name}</strong></button>)}</div>
          <div className={`journey-route-layout ${view === 'map' ? 'geographic-layout' : ''}`}>
            <div className="journey-views">
              <div className="journey-view geographic-view" hidden={view !== 'map'}><GeographicMap plan={plan} scope={activeScope} selected={selected} onSelect={choose} /></div>
              <div className="journey-view sequence-view" hidden={view !== 'route'}><section className="map-diagram-panel journey-route-panel" aria-label="官方经停路线"><header className="journey-list-heading"><div><h3>{activeScope === 'trip' ? '我的乘车路线' : '全车经停'}</h3><small>{verified ? `${offsets.length} 站 · 按官方站序展示` : '已确认票段端点，完整经停尚未核验'}</small></div><button aria-pressed={keyOnly} onClick={() => { setKeyOnly(!keyOnly); if (!keyOnly && !keyOffsets.includes(selected)) setSelected(keyOffsets[0]); }}>{keyOnly ? '显示所有经停' : '只看关键站'}</button></header>
              <ol className="journey-stops">{shown.map((offset, index) => {
                const item = plan.route[offset], fact = journeyStop(plan, offset), segment = journeySegment(plan, offset);
                const color = MAP_ROLE_COLORS[index === shown.length - 1 ? journeySegment(plan, offset - 1).role : segment.role];
                return <li id={`${stopId}-${offset}`} key={offset} className={`${selected === offset ? 'selected' : ''} ${segment.role}`} style={{ '--stop-color': color } as React.CSSProperties}>
                  {index < shown.length - 1 && <span className={`journey-connector ${segment.role === 'uncovered' ? 'uncovered' : ''}`} />}
                  <button className="journey-stop-button" aria-pressed={selected === offset} onClick={() => choose(offset)}><span className="journey-dot">{offset - range.start + 1}</span><span className="journey-stop-name"><strong>{item.station.name}</strong>{fact.role && <em>{fact.role}</em>}</span><span className="journey-stop-times"><span>到 {dateTime(item.arrivalIso)}</span><span>发 {dateTime(item.departureIso)}</span></span></button>
                  {selected === offset && <div className="journey-inline-detail">{fact.connecting && <p>本站接续第 2 张票：{SEAT_LABELS[plan.legs[fact.arriving].seat]} → {SEAT_LABELS[plan.legs[fact.departing].seat]}{plan.kind==='transfer'?'，需换乘另一趟车。':'，可能换座。'}</p>}{plan.uncovered && fact.arriving === 0 && <p>短票在这里结束；应在到达本站前申请补票，后续区间尚未覆盖。</p>}<a href={stationSearchUrl(item.station.name)} target="_blank" rel="noopener noreferrer">在高德查看本站<ExternalLink size={12} /></a></div>}
                  {index < shown.length - 1 && <div className={`journey-segment ${segment.role}`}>{segment.role === 'uncovered' ? '未覆盖 · 补票待批准' : segment.role === 'extra' ? '多买区间 · 在目标站下车' : segment.leg ? `第 ${segment.legIndex + 1} 张票 · ${SEAT_LABELS[segment.leg.seat]}` : '本次乘车区间外'}{keyOnly && shown[index + 1] - offset > 1 && <small>另有 {shown[index + 1] - offset - 1} 个经停站，展开可查看</small>}</div>}
                </li>;
              })}</ol>
            </section></div>
            </div>
            {stop && <aside className={`map-station-panel journey-inspector ${view === 'map' ? 'geographic-inspector' : ''}`} aria-label="所选车站详情"><span className="journey-inspector-caption">已选车站</span><h3>{stop.station.name}</h3>{facts.role && <p className="journey-inspector-role">{facts.role}</p>}<dl><div><dt>到达</dt><dd>{dateTime(stop.arrivalIso)}</dd></div><div><dt>出发</dt><dd>{dateTime(stop.departureIso)}</dd></div>{facts.dwellMinutes && <div><dt>停留</dt><dd>{facts.dwellMinutes} 分钟</dd></div>}</dl>
              {facts.connecting && <div className="journey-inspector-action"><RefreshCw size={16} /><strong>在本站接续第 2 张票</strong><p>{SEAT_LABELS[plan.legs[facts.arriving].seat]} → {SEAT_LABELS[plan.legs[facts.departing].seat]}</p><small>{plan.kind==='transfer'?'请在本站换乘另一趟车；留意站内换乘指引，等待时间不保证晚点后仍能接上。':'座位可能改变，请按两张票分别就座。'}</small></div>}
              {plan.uncovered && facts.arriving === 0 && <div className="journey-inspector-action uncovered"><TriangleAlert size={16} /><strong>短票在这里结束</strong><p>应在到达本站前申请补票。</p><small>后续至 {plan.target.name} 尚未覆盖，不能保证补票获准。</small></div>}
              <a className="journey-station-link" href={stationSearchUrl(stop.station.name)} target="_blank" rel="noopener noreferrer"><MapPinned size={14} />在高德查看车站<ExternalLink size={12} /></a><small className="journey-inspector-footnote">点击地图上的车站或上方关键站，查看实际时刻与票面覆盖。</small>
            </aside>}
          </div>
        </>
        <details className="journey-ticket-details" key={plan.id}><summary><Ticket size={14} />查看 {plan.legs.length} 张票的席别、余票和实际票价<span>{price(total)}</span></summary><section className="journey-tickets" aria-label="每张票的覆盖区间">{plan.legs.map((leg, index) => <div className="journey-ticket" key={index}><div><b><Ticket size={14} />第 {index + 1} 张票 {leg.train?.trainCode}</b><span>{SEAT_LABELS[leg.seat]} · {availability[leg.inventory.status]}{leg.inventory.count !== undefined ? ` ${leg.inventory.count}` : ''}</span></div><strong>{leg.from.name}<ArrowRight size={14} />{leg.to.name}<em>{price(leg.inventory.price)}</em></strong><small>{dateTime(leg.departureIso)} → {dateTime(leg.arrivalIso)}</small></div>)}</section></details>
        <p className="map-source-note">经停与时刻来自 12306 · 采集 {collected.format(new Date(plan.fetchedTo))} · 北京时间。所有候选票尚未购买，购票前请重新核验。官网链接已带入每张票的车站和日期；进入后筛选 {trainCodes} 并核对席别。{!verified && '仅展示已核验票段的实际端点，不表示完整经停。'}</p>
        {copyError && <p className="journey-copy-error" role="alert">{copyError}</p>}
      </div>
      <footer className="journey-footer"><button onClick={() => void copy()}><Copy size={14} />{copiedPlan === plan.id ? '已复制条件' : '复制购票条件'}</button>{onRecheck && <button disabled={recheckDisabled} onClick={onRecheck}><RefreshCw size={14} />重新核验</button>}{purchaseLinks(plan).map(link => <a href={link.url} key={link.url} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={13} /></a>)}</footer>
    </div>
    {tourOpen && <UsageTour variant="map" onClose={closeTour} />}
  </div>;
}
