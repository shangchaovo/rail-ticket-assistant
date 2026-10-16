'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDown, ArrowRight, ArrowUp, BookOpen, Check, CheckCircle2, ChevronDown, Clock3,
  Copy, Download, ExternalLink, GripVertical, Info, LoaderCircle, MapPin, Route as RouteIcon,
  Monitor, Plus, RefreshCw, Search, Settings2, ShieldCheck, Ticket,
  TrainFront, TriangleAlert, Wifi, WifiOff, X,
} from 'lucide-react';
import { collectWaitlist, planPurchasePrice, sortTrips, type SortDirection, type SortKey, type WaitlistTrain } from '@/lib/result-view';
import { SEATS, SEAT_LABELS } from '@/lib/rail-types';
import type { Availability, HelperState, Inventory, PlanKind, RailJob, RailSearch, SeatType, SegmentQuote, Station, StationAlternative, TicketPlan } from '@/lib/rail-types';
import { unpackResult, type PackedResult } from '@/lib/rail-wire';
import { commitStationInput, resolveStationName, selectableStation, stationInputLabel, stationOptionLabel } from '@/lib/station-search';
import { OFFICIAL_TICKET_URL, officialTicketUrl, purchaseLinks, ticketLegUrl } from '@/lib/rail-purchase';
import { currentPlan, currentQuote } from '@/lib/rail-freshness';
import { recommendPlans, recommendationLabels, previewRecommendations } from '@/lib/rail-recommendation';
import RouteMap from './route-map';
import UsageTour from './usage-tour';
import WatchPanel from './watch-panel';
import HelpTip from './help-tip';
import PrivateAssistant from './private-assistant';
import type {PrivateAssistantForm} from '@/lib/private-assistant-types';

const OFFICIAL_URL = OFFICIAL_TICKET_URL;
const RULES_URL = 'https://mobile.12306.cn/otsmobile/h5/otsbussiness/info/transportationRules.html';
const KIND_LABELS: Record<PlanKind, string> = { direct: '直达票', split: '同车两段票', long: '买长乘短', extension: '短票＋申请补票', transfer: '异车中转' };
const KIND_HELP: Record<PlanKind, string> = {
  transfer: '换乘另一趟车：A → B、B → C，各买一张票。在同一个实际车站换车，按每段乘车日期核票；允许次日换乘时可能需要过夜。',
  direct: '一张票覆盖出发站到目标站。例如 A → C，直接购买 A → C 的车票。',
  split: '把同一趟车拆成两张连续车票：A → B、B → C。两张都要购买；到 B 站可能需要换座，不用换车。',
  long: '购买到更远站的车票，提前在目标站下车。例如想去 C，购买 A → D、在 C 下车；支付的是 A → D 的全程票价。',
  extension: '先买 A → B 的短票，想继续到 C。持有效票上车后，须在原票到站 B 之前向列车工作人员申请补票；运输能力允许才可能办理，可能被拒绝。B → C 尚未覆盖，补票金额待确认。',
};
const STATUS_LABELS: Record<RailJob['status'], string> = { queued: '等待查询', running: '正在查询', waiting_user: '需要在 Mac 上处理', partial: '部分完成', complete: '查询完成', unavailable: '查询不可用', cancelled: '已取消' };
const AVAILABILITY_LABELS: Record<Availability, string> = { available: '有票', sold_out: '无票', waitlist: '可候补', not_on_sale: '未起售', unsupported: '不支持', unknown: '未确认' };
const ACTIVE = new Set<RailJob['status']>(['queued', 'running', 'waiting_user']);
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'rank', label: '综合推荐' },
  { key: 'departure', label: '出发时间' },
  { key: 'duration', label: '用时' },
  { key: 'price', label: '价格' },
];

type DestinationRow = { key: string; station: Station | null; defaultName?: string };
type DeviceDetails = { deviceId: string; deviceToken: string; siteOrigin: string };
type StationHit = Station & { city?: string; label?: string };
type StationQuery = { stations: StationHit[]; cityOnly?: boolean; cityQuery?: boolean };
const stationSuggestions = new Map<string, StationQuery>();
const timeFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const stampFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function beijingNow() {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}
function timeOf(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未确认' : timeFormatter.format(date);
}
function dateOf(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未确认' : dateFormatter.format(date);
}
function stamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未确认';
  return `${dateOf(value)} ${stampFormatter.format(date)}`;
}
function price(value: number | null) { return value === null ? '待确认' : `¥${value.toFixed(value % 1 ? 1 : 0)}`; }
function duration(start: string, end: string) {
  const minutes = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return '时长待确认';
  return `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}小时` : ''}${minutes % 60 ? `${minutes % 60}分` : ''}` || '0分';
}
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const data: unknown = await response.json().catch(() => null);
  const problem = data && typeof data === 'object' ? data as { error?: string; message?: string } : null;
  if (!response.ok) throw new Error(problem?.error || problem?.message || `请求失败（${response.status}），请稍后重试。`);
  if (!data) throw new Error('服务未返回可读取的数据，请稍后重试。');
  const value = data as { job?: Omit<RailJob, 'result'> & { result: RailJob['result'] | PackedResult } };
  if (value.job?.result) value.job.result = unpackResult(value.job.result);
  return data as T;
}
function inventoryText(inventory: Inventory) {
  return inventory.status === 'available' && inventory.count !== undefined ? `${inventory.count} 张` : AVAILABILITY_LABELS[inventory.status];
}
function searchKey(input: RailSearch) {
  return JSON.stringify([input.origin, input.destinations, input.date, input.earliestTime, input.trainTypes, input.seats, input.includeLongTicket, input.includeExtension, input.passengerCount ?? 1, input.sameSeatOnly ?? true, input.includeTransfer ?? false, input.transferStations ?? [], input.minTransferMinutes ?? 45, input.allowOvernightTransfer ?? true]);
}
function directNotOnSale(observations: SegmentQuote[], input: RailSearch) {
  const latest = new Map<string, SegmentQuote>();
  for (const quote of observations) {
    if (quote.from.code !== input.origin.code || !input.destinations.some(station => station.code === quote.to.code) || dateOf(quote.departureIso) !== input.date || Date.parse(quote.departureIso) < Date.parse(`${input.date}T${input.earliestTime}:00+08:00`) || !input.trainTypes.includes(quote.train.trainCode[0] as 'G' | 'D' | 'C')) continue;
    const key = `${quote.train.runId}:${quote.to.code}`;
    if (!latest.has(key) || Date.parse(quote.fetchedAt) >= Date.parse(latest.get(key)!.fetchedAt)) latest.set(key, quote);
  }
  return [...latest.values()].filter(quote => input.seats.some(seat => quote.seats[seat].status === 'not_on_sale'));
}
function stationOnly(station: StationHit): Station {
  return { name: station.name, code: station.code };
}
function StationPicker({ value, onChange, defaultName = '', label, compact = false }: { value: Station | null; onChange: (value: Station | null) => void; defaultName?: string; label: string; compact?: boolean }) {
  const id = useId();
  const [text, setText] = useState(value ? stationInputLabel(value) : defaultName);
  const [matches, setMatches] = useState<{ query: string; stations: StationHit[] }>({ query: '', stations: [] });
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const [requestVersion, setRequestVersion] = useState(0);
  const revision = useRef(0);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const query = value?.name ?? text;
  const displayValue = value ? stationInputLabel(value) : text;
  const trimmedQuery = query.trim();
  const suggestions = (matches.query === trimmedQuery ? matches.stations : []).filter(selectableStation);
  useEffect(() => {
    if (!trimmedQuery) return;
    const controller = new AbortController();
    const requestRevision = revision.current;
    const isCurrent = () => !controller.signal.aborted && revision.current === requestRevision;
    const normalized = trimmedQuery.toLowerCase();
    const timeout = setTimeout(() => {
      setLoading(true); setError('');
      const cached = stationSuggestions.get(normalized);
      (cached ? Promise.resolve(cached) : api<StationQuery>(`/api/stations?q=${encodeURIComponent(trimmedQuery)}`, { signal: controller.signal })).then(data => {
        if (!isCurrent()) return;
        const payload = { stations: data.stations, cityOnly: Boolean(data.cityOnly), cityQuery: Boolean(data.cityQuery) };
        if (stationSuggestions.size >= 80) stationSuggestions.delete(stationSuggestions.keys().next().value!);
        stationSuggestions.set(normalized, payload);
        setMatches({ query: trimmedQuery, stations: payload.stations }); setHighlight(-1);
        const resolved = resolveStationName(trimmedQuery);
        const exact = resolved ? payload.stations.find(station => station.name === resolved.name && station.code === resolved.code) : undefined;
        if (exact && selectableStation(exact)) onChangeRef.current(stationOnly(exact));
      }).catch(error => {
        if (isCurrent()) { setError(error.message); setMatches({ query: trimmedQuery, stations: [] }); }
      }).finally(() => { if (isCurrent()) setLoading(false); });
    }, stationSuggestions.has(normalized) ? 0 : 120);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [trimmedQuery, requestVersion]);
  const choose = (station: StationHit) => {
    if (!selectableStation(station)) return;
    revision.current++; setHighlight(-1); setLoading(false); setError('');
    setText(station.label || stationOptionLabel(station.name, station.city));
    onChange(stationOnly(station)); setOpen(false);
  };
  return <div className={`station-picker ${compact ? 'compact' : ''}`}>
    <div className={`station-input ${value ? 'selected' : ''}`}>
      {!compact && <MapPin size={18} aria-hidden="true" />}
      <input id={id} aria-label={label} role="combobox" aria-expanded={open} aria-controls={`${id}-suggestions`} aria-autocomplete="list" aria-activedescendant={open && highlight >= 0 && suggestions[highlight] ? `${id}-option-${highlight}` : undefined} value={displayValue} placeholder="输入车站名 / 拼音" autoComplete="off" onChange={event => { revision.current++; setRequestVersion(version => version + 1); setHighlight(-1); setText(event.target.value); setMatches({ query: '', stations: [] }); setError(''); setLoading(Boolean(event.target.value.trim())); onChange(null); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => { setTimeout(() => setOpen(false), 150); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setHighlight(current => suggestions.length ? Math.min(current < 0 ? 0 : current + 1, suggestions.length - 1) : -1); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight(current => suggestions.length ? Math.max(current - 1, 0) : -1); }
        if (event.key === 'Enter') {
          event.preventDefault();
          const highlighted = highlight >= 0 ? suggestions[highlight] : undefined;
          const committed = commitStationInput(displayValue, highlighted ? { name: highlighted.name, code: highlighted.code } : null);
          if (!committed || !highlighted || highlighted.name !== committed.name || highlighted.code !== committed.code) return;
          choose(highlighted);
        }
        if (event.key === 'Escape') setOpen(false);
      }} />
      {value && <Check size={16} className="station-check" aria-label="车站已选择" />}
      {loading && !value && <LoaderCircle size={16} className="spin" aria-label="搜索车站中" />}
    </div>
    {open && <div className="station-options" id={`${id}-suggestions`} role="listbox" aria-label={`${label}匹配车站`}>
      {suggestions.length ? suggestions.map((station, index) => {
          const city = station.city?.trim() || '';
          const stationLabel = station.label || stationOptionLabel(station.name, city);
          return <div className={`station-option${highlight === index ? ' highlighted' : ''}`} key={station.code} onMouseEnter={() => setHighlight(index)}>
            <button type="button" role="option" aria-selected={highlight === index} id={`${id}-option-${index}`} aria-label={city ? `${stationLabel}，所属城市 ${city}` : stationLabel} onMouseDown={event => event.preventDefault()} onClick={() => choose(station)}><span className="station-name">{stationLabel}</span></button>
            {city ? <span className="station-city" onMouseDown={event => event.preventDefault()} onClick={event => { event.preventDefault(); event.stopPropagation(); }}>所属城市 {city}</span> : null}
            <span className="station-code" onMouseDown={event => event.preventDefault()} onClick={() => choose(station)}>{station.code}</span>
          </div>;
        }) : <p>{loading ? '正在查找车站…' : error ? '车站目录暂不可用，请重试' : text ? '未找到车站，请尝试完整站名' : '输入完整站名或拼音'}</p>}
    </div>}
  </div>;
}

export default function RailApp({privateLogin=false}:{privateLogin?:boolean}) {
  const [loggingOut,setLoggingOut]=useState(false);
  const [origin, setOrigin] = useState<Station | null>(null);
  const [destinations, setDestinations] = useState<DestinationRow[]>([{ key: 'd1', station: null, defaultName: '苍南' }, { key: 'd2', station: null, defaultName: '温州南' }, { key: 'd3', station: null, defaultName: '温州北' }]);
  const [date, setDate] = useState('');
  const [earliestTime, setEarliestTime] = useState('');
  const [clock, setClock] = useState({ date: '', time: '--:--' });
  const [inventoryNow, setInventoryNow] = useState(0);
  const [trainTypes, setTrainTypes] = useState<RailSearch['trainTypes']>(['G', 'D', 'C']);
  const [seats, setSeats] = useState<SeatType[]>(['second']);
  const [passengerCount, setPassengerCount] = useState(1);
  const [sameSeatOnly, setSameSeatOnly] = useState(true);
  const [includeLongTicket, setIncludeLongTicket] = useState(true);
  const [includeExtension, setIncludeExtension] = useState(false);
  const [includeTransfer, setIncludeTransfer] = useState(true);
  const [transferRows, setTransferRows] = useState<DestinationRow[]>([]);
  const [minTransferMinutes, setMinTransferMinutes] = useState(45);
  const [allowOvernightTransfer, setAllowOvernightTransfer] = useState(true);
  const [showAllPlans, setShowAllPlans] = useState(false);
  const [helper, setHelper] = useState<HelperState>({ online: false, lastSeen: null, message: '正在检查查询助手…' });
  const [checkingHelper, setCheckingHelper] = useState(true);
  const [job, setJob] = useState<RailJob | null>(null);
  const [error, setError] = useState('');
  const [stationValidation, setStationValidation] = useState(false);
  const [pollError, setPollError] = useState('');
  const [busy, setBusy] = useState<'search' | 'recheck' | 'cancel' | null>(null);
  const [tab, setTab] = useState<'all' | PlanKind>('all');
  const [stock, setStock] = useState<'ticket' | 'waitlist'>('ticket');
  const [sortKey, setSortKey] = useState<SortKey>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [device, setDevice] = useState<DeviceDetails | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceError, setDeviceError] = useState('');
  const [resuming, setResuming] = useState(false);
  const [copied, setCopied] = useState('');
  const [invalidated, setInvalidated] = useState(false);
  const [mapPlanId, setMapPlanId] = useState<string | null>(null);
  const [tourOpen, setTourOpen] = useState(false);
  const [observationsOpen, setObservationsOpen] = useState(false);
  const [assistantBusy,setAssistantBusy]=useState(false);
  const closeTour = useCallback(() => setTourOpen(false), []);
  const closeMap = useCallback(() => setMapPlanId(null), []);
  const dragging = useRef<number | null>(null);
  const activeJob = Boolean(job && ACTIVE.has(job.status));
  const input: RailSearch | null = origin && destinations.length && destinations.every(d => d.station) && (!includeTransfer || transferRows.every(r=>r.station)) ? { origin, destinations: destinations.map(d => d.station!), date, earliestTime, trainTypes, seats, includeLongTicket, includeExtension, passengerCount, sameSeatOnly, includeTransfer, ...(includeTransfer ? {transferStations:transferRows.map(r=>r.station!),minTransferMinutes,allowOvernightTransfer} : {}) } : null;
  const missingStations = [...(!origin ? ['出发站'] : []), ...destinations.flatMap((row, index) => row.station ? [] : [`第 ${index + 1} 优先到站`]), ...(includeTransfer ? transferRows.flatMap((row,index)=>row.station?[]:[`第 ${index+1} 中转站`]) : [])];
  const stationError = stationValidation && !input ? `请确认${missingStations.join('、')}：输入完整官方站名，或从下拉列表选择。` : '';
  const dirty = Boolean(job && (!input || searchKey(input) !== searchKey(job.input)));
  const stale = dirty || invalidated || busy === 'recheck';
  const result = job?.result;
  const plans = stale ? [] : (result?.plans || []).filter(plan =>
    currentPlan(plan, job!.status, inventoryNow) &&
    (job?.input.sameSeatOnly === false || plan.legs.every(leg => leg.seat === plan.legs[0].seat)) &&
    ((job?.input.passengerCount ?? 1) <= 1 || plan.legs.every(leg => (leg.inventory.count ?? 0) >= (job?.input.passengerCount ?? 1))));
  const mapPlan = mapPlanId ? plans.find(plan => plan.id === mapPlanId) ?? null : null;
  const freshObservations = !job ? [] : (result?.observations || []).filter(quote => currentQuote(quote, job.status, inventoryNow));
  const historicalPlanCount = job ? (result?.plans || []).filter(plan => !currentPlan(plan, job.status, inventoryNow)).length : 0;
  const historicalObservationCount = (result?.observations.length ?? 0) - freshObservations.length;
  const hasHistory = historicalPlanCount > 0 || historicalObservationCount > 0;
  const historyOnly = hasHistory && plans.length === 0 && freshObservations.length === 0;
  const waitlist = stale || !job ? [] : collectWaitlist(freshObservations, job.input, plans);
  const notOnSale = stale || !job ? [] : directNotOnSale(freshObservations, job.input);
  const ticketPlans = plans.filter(plan => tab === 'all' || plan.kind === tab);
  const recommended = recommendPlans(ticketPlans);
  const planLabels = recommendationLabels(plans);
  const allSortedTickets = sortTrips(recommended.map((plan,index) => ({ plan, recommendIndex:index, departureIso: plan.departureIso, arrivalIso: plan.arrivalIso, price: planPurchasePrice(plan) })), sortKey, sortDirection).map(item => item.plan);
  const simpleTickets = tab==='all' ? allSortedTickets.filter(p=>p.kind!=='extension') : allSortedTickets;
  const sortedTickets = showAllPlans ? allSortedTickets : sortKey==='rank' ? previewRecommendations(simpleTickets) : simpleTickets.slice(0,6);
  const sortedWaitlist = sortTrips(waitlist.map((train, index) => ({ train, recommendIndex: index, departureIso: train.departureIso, arrivalIso: train.arrivalIso, price: train.price })), sortKey, sortDirection).map(item => item.train);
  const showingTickets = stock === 'ticket';
  const shownCount = showingTickets ? sortedTickets.length : sortedWaitlist.length;
  function chooseSort(key: SortKey) {
    setShowAllPlans(false);
    if (key === 'rank' || key !== sortKey) { setSortKey(key); if (key !== 'rank') setSortDirection('asc'); return; }
    setSortDirection(current => current === 'asc' ? 'desc' : 'asc');
  }

  useEffect(() => {
    const controller = new AbortController();
    const initial = setTimeout(() => {
      const now = beijingNow(); setDate(now.date); setEarliestTime(now.time); setClock(now); setInventoryNow(Date.now());
      const savedId = new URLSearchParams(window.location.search).get('query');
      if (!savedId) return;
      if (!/^[0-9a-f-]{36}$/i.test(savedId)) { setError('查询链接无效，请重新查询。'); return; }
      void api<{ job: RailJob }>(`/api/jobs/${savedId}?format=compact`, { signal: controller.signal }).then(({ job: saved }) => {
        if (controller.signal.aborted) return;
        setOrigin(saved.input.origin);
        setDestinations(saved.input.destinations.map((station, index) => ({ key: `saved-${index}`, station })));
        setDate(saved.input.date); setEarliestTime(saved.input.earliestTime);
        setTrainTypes(saved.input.trainTypes); setSeats(saved.input.seats);
        setPassengerCount(saved.input.passengerCount ?? 1); setSameSeatOnly(saved.input.sameSeatOnly ?? true);
        setIncludeLongTicket(saved.input.includeLongTicket); setIncludeExtension(saved.input.includeExtension);
        setIncludeTransfer(saved.input.includeTransfer ?? false); setTransferRows((saved.input.transferStations || []).map(station=>({key:crypto.randomUUID(),station}))); setMinTransferMinutes(saved.input.minTransferMinutes ?? 45); setAllowOvernightTransfer(saved.input.allowOvernightTransfer ?? true);
        setJob(saved);
      }).catch(error => { if (!controller.signal.aborted) setError((error as Error).message); });
    }, 0);
    const interval = setInterval(() => setClock(beijingNow()), 15000);
    const inventoryInterval = setInterval(() => setInventoryNow(Date.now()), 30000);
    const onVisible = () => { if (!document.hidden) setInventoryNow(Date.now()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { controller.abort(); clearTimeout(initial); clearInterval(interval); clearInterval(inventoryInterval); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  const refreshHelper = useCallback(async () => {
    setCheckingHelper(true);
    try { const data = await api<{ helper: HelperState }>('/api/helper/state'); setHelper(data.helper); return data.helper.online; }
    catch (error) { setHelper({ online: false, lastSeen: null, message: (error as Error).message }); return false; }
    finally { setCheckingHelper(false); }
  }, []);
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const online = await refreshHelper();
      if (!stopped) timer = setTimeout(() => void poll(), document.hidden ? 15000 : online ? 12000 : 3000);
    };
    timer = setTimeout(() => void poll(), 0);
    return () => { stopped = true; clearTimeout(timer); };
  }, [refreshHelper]);
  const jobId = job?.id;
  const jobStatus = job?.status;
  const jobUpdatedAt = job?.updatedAt;
  useEffect(() => {
    const timer = setTimeout(() => setInventoryNow(Date.now()), 0);
    return () => clearTimeout(timer);
  }, [jobId, jobUpdatedAt]);
  useEffect(() => {
    if (!jobId) return;
    const url = new URL(window.location.href);
    url.searchParams.set('query', jobId);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [jobId]);
  useEffect(() => {
    if (!jobId || !jobStatus || !ACTIVE.has(jobStatus)) return;
    let stopped = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>, etag = '';
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}?format=compact`, { credentials: 'same-origin', signal: controller.signal, headers: etag ? { 'If-None-Match': etag } : {} });
        if (response.status === 304) { if (!stopped) setPollError(''); return; }
        const data = await response.json() as { job: RailJob; error?: string };
        if (!response.ok) throw new Error(data.error || '进度暂时无法读取');
        etag = response.headers.get('etag') || '';
        if (data.job.result) data.job.result = unpackResult(data.job.result);
        if (!stopped) { setJob(current => current?.id === data.job.id && data.job.version >= current.version ? data.job : current); setPollError(''); }
      } catch (error) { if (!stopped) setPollError((error as Error).message); }
      finally { if (!stopped) timer = setTimeout(() => void poll(), document.hidden ? 5000 : 1250); }
    };
    timer = setTimeout(() => void poll(), 250);
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [jobId, jobStatus]);
  useEffect(() => {
    if (!deviceOpen) return;
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') setDeviceOpen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [deviceOpen]);

  function moveDestination(from: number, to: number) {
    if (to < 0 || to >= destinations.length || from === to) return;
    setDestinations(current => { const next = [...current]; const [row] = next.splice(from, 1); next.splice(to, 0, row); return next; });
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setStationValidation(false);
    if (!input) { setStationValidation(true); return; }
    if (!trainTypes.length || !seats.length) { setError('请至少选择一种车型和一个席别。'); return; }
    if (new Set(input.destinations.map(s => s.code)).size !== input.destinations.length || input.destinations.some(s => s.code === input.origin.code)) { setError('到站不能重复，也不能与出发站相同。'); return; }
    if (input.transferStations && (new Set(input.transferStations.map(s=>s.code)).size!==input.transferStations.length || input.transferStations.some(s=>s.code===input.origin.code||input.destinations.some(d=>d.code===s.code)))) {setError('中转站不能重复，也不能与起终点相同。');return;}
    if (!helper.online) { setError('查询助手当前离线，请先连接 Mac。'); return; }
    await startSearch(input);
  }
  async function startSearch(next: RailSearch) {
    setBusy('search'); setJob(null); setInvalidated(false); setPollError(''); setTab('all'); setShowAllPlans(false); setObservationsOpen(false);
    try { const data = await api<{ job: RailJob }>('/api/jobs', { method: 'POST', body: JSON.stringify({ input: next }) }); setJob(data.job); return data.job; }
    catch (error) { setError((error as Error).message); return null; }
    finally { setBusy(null); }
  }
  async function cancel() {
    if (!job) return; setBusy('cancel'); setError('');
    try { const data = await api<{ job: RailJob }>(`/api/jobs/${job.id}/cancel`, { method: 'POST' }); setJob(data.job); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(null); }
  }
  async function queryAlternative(pair: StationAlternative) {
    if (!job || activeJob || busy) return;
    const next = { ...job.input, origin: pair.from, destinations: [pair.to] };
    setOrigin(next.origin); setDestinations([{ key: crypto.randomUUID(), station: pair.to }]); setError('');
    if (!helper.online) { setError('查询助手当前离线，请先连接 Mac。已为你填好这两个车站。'); return; }
    await startSearch(next);
  }
  async function recheck(planId: string) {
    if (!job) return; setBusy('recheck'); setInvalidated(true); setError('');
    try { const data = await api<{ job: RailJob }>(`/api/jobs/${job.id}/recheck`, { method: 'POST', body: JSON.stringify({ planId }) }); setJob(data.job); setInvalidated(false); setTab('all'); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(null); }
  }
  async function copy(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 2500); }
    catch { setError('浏览器无法复制，请手动选择内容复制。'); }
  }
  async function createDevice() {
    setDeviceBusy(true); setDeviceError('');
    try { setDevice(await api<DeviceDetails>('/api/device', { method: 'POST', body: JSON.stringify({ deviceName: '我的Mac' }) })); }
    catch (error) { setDeviceError((error as Error).message); }
    finally { setDeviceBusy(false); }
  }
  async function revokeDevice() {
    setDeviceBusy(true); setDeviceError('');
    try { await api('/api/device', { method: 'DELETE' }); setDevice(null); await refreshHelper(); }
    catch (error) { setDeviceError((error as Error).message); }
    finally { setDeviceBusy(false); }
  }
  async function resumeHelper(jobId?: string) {
    setResuming(true); setError(''); setDeviceError('');
    try { await api('/api/helper/resume', { method: 'POST', body: JSON.stringify(jobId ? { jobId } : {}) }); await refreshHelper(); }
    catch (error) { setError((error as Error).message); setDeviceError((error as Error).message); }
    finally { setResuming(false); }
  }
  async function openSavedJob(id: string) {
    setError('');
    try {
      const { job: saved } = await api<{ job: RailJob }>(`/api/jobs/${id}?format=compact`);
      setOrigin(saved.input.origin); setDestinations(saved.input.destinations.map((station, index) => ({ key: `watch-${index}`, station })));
      setDate(saved.input.date); setEarliestTime(saved.input.earliestTime); setTrainTypes(saved.input.trainTypes); setSeats(saved.input.seats);
      setPassengerCount(saved.input.passengerCount ?? 1); setSameSeatOnly(saved.input.sameSeatOnly ?? true);
      setIncludeLongTicket(saved.input.includeLongTicket); setIncludeExtension(saved.input.includeExtension);
        setIncludeTransfer(saved.input.includeTransfer ?? false); setTransferRows((saved.input.transferStations || []).map(station=>({key:crypto.randomUUID(),station}))); setMinTransferMinutes(saved.input.minTransferMinutes ?? 45); setAllowOvernightTransfer(saved.input.allowOvernightTransfer ?? true);
      setInvalidated(false); setJob(saved); setTab('all'); setStock('ticket');
      document.getElementById('query-results')?.scrollIntoView({ block: 'start' });
    } catch (error) { setError((error as Error).message); }
  }
  async function logout() {
    setLoggingOut(true);
    try { await api('/api/auth',{method:'POST',body:JSON.stringify({action:'logout'})}); window.location.replace(new URL('/login',window.location.origin).href); }
    catch(error) { setError((error as Error).message); setLoggingOut(false); }
  }

  const assistantForm:PrivateAssistantForm={origin:origin?.name??'',destination:destinations[0]?.station?.name??destinations[0]?.defaultName??'',destinations:destinations.map(d=>d.station?.name??d.defaultName??''),date,earliestTime,passengerCount,seats,trainTypes,includeTransfer,sameSeatOnly,allowOvernightTransfer,includeLongTicket,includeExtension,middle:transferRows[0]?.station?.name??'',middleStations:transferRows.map(r=>r.station?.name??''),minTransferMinutes};
  async function assistantSearch(next:RailSearch){
    setOrigin(next.origin);setDestinations(next.destinations.map(station=>({key:crypto.randomUUID(),station})));setDate(next.date);setEarliestTime(next.earliestTime);setSeats(next.seats);setTrainTypes(next.trainTypes);setPassengerCount(next.passengerCount??1);setSameSeatOnly(next.sameSeatOnly??true);setIncludeTransfer(next.includeTransfer??false);setIncludeLongTicket(next.includeLongTicket);setIncludeExtension(next.includeExtension);setAllowOvernightTransfer(next.allowOvernightTransfer??true);setMinTransferMinutes(next.minTransferMinutes??45);setTransferRows((next.transferStations??[]).map(station=>({key:crypto.randomUUID(),station})));setError('');
    return startSearch(next);
  }
  function assistantPlan(id:string){
    if(!plans.some(plan=>plan.id===id&&currentPlan(plan,job!.status,Date.now()))){setError('这条 AI 引用已过期或对应其他查询，请重新查询新库存。');return false;}
    setStock('ticket');setTab('all');if(!sortedTickets.some(plan=>plan.id===id))setShowAllPlans(true);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{const element=document.getElementById(`plan-${id}`);element?.scrollIntoView({block:'center',behavior:'smooth'});element?.focus({preventScroll:true});}));return true;
  }

  return <div className="rail-shell">
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" prefetch={false} onClick={event=>{event.preventDefault();window.location.assign(new URL('/',window.location.origin).href);}} className="brand" aria-label="同车余票首页"><span className="brand-mark"><TrainFront size={30} /></span><span>同车余票<span className="brand-subtitle">12306 余票与中转助手</span></span></Link>
        <div className="header-tools"><Link className="personal-label" href="/" prefetch={false} onClick={event=>{event.preventDefault();window.location.assign(new URL('/',window.location.origin).href);}}>公开查询</Link><span className="workspace-label">私人工作台</span><div className="header-clock"><Clock3 size={15} /><span>{clock.time}<small>北京时间</small></span></div></div>
      </div>
    </header>
    <nav aria-label="主导航" className="rail-nav"><div className="rail-nav-inner"><a href="#query-panel" className="nav-active"><Ticket size={17} />车票查询</a><a href="#query-results"><TrainFront size={17} />到达方案</a><button onClick={() => setDeviceOpen(true)}><Monitor size={17} />查询助手</button><button onClick={() => setTourOpen(true)}><BookOpen size={17} />使用教程</button><a href={OFFICIAL_URL} target="_blank" rel="noreferrer">12306 官网<ExternalLink size={14} /></a></div></nav>
    <main className="workspace">
      <div className="page-heading"><div><p className="eyebrow">车票查询 <span>›</span> 到达方案</p><h1>余票与中转查询</h1><p className="intro">直达、同车分段或换车中转，比较价格与总用时。</p></div><button className={`helper-pill ${helper.online ? 'online' : 'offline'}`} onClick={() => setDeviceOpen(true)}>{helper.online ? <Wifi size={16} /> : <WifiOff size={16} />}<span>{checkingHelper && !helper.lastSeen ? '检查助手中' : helper.online ? 'Mac 查询助手在线' : 'Mac 查询助手离线'}</span><ChevronDown size={15} /></button></div>
      <div className="workspace-grid">
        <aside className="query-column">
          <form className="query-panel" id="query-panel" onSubmit={submit} inert={assistantBusy}>
            <div className="panel-title"><div><Settings2 size={18} /><h2>车票查询条件</h2></div><span className="passenger-type">单程 · {passengerCount} 名成人</span></div>
            <div className="field-block origin-block"><div className="field-caption"><label className="field-label">出发站</label><HelpTip label="选择车站">请点选具体车站。城市名不能选中；杭州站与杭州东、上海站与上海虹桥是不同车站。蓝勾表示已确认实际车站。</HelpTip></div><StationPicker value={origin} onChange={station => { setOrigin(station); setStationValidation(false); }} defaultName="杭州东" label="出发站" /></div>
            <div className="field-block destination-block"><div className="field-label-row"><div className="field-caption"><label className="field-label">备选到站</label><HelpTip label="备选到站与优先级">可接受的到站可以填多个。排在前面的更优先，可拖动或用箭头调整；不是要求途经所有这些车站。只去一个站时保留一行即可。</HelpTip></div><span className="subtle">按优先级排序</span></div><div className="destination-list">
              {destinations.map((row, index) => <div key={row.key} className="destination-row" draggable onDragStart={event => { dragging.current = index; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={event => { event.preventDefault(); if (dragging.current !== null) moveDestination(dragging.current, index); dragging.current = null; }} onDragEnd={() => { dragging.current = null; }}>
                <span className="drag-handle" title="拖动调整优先级"><GripVertical size={15} /></span><span className="destination-rank">{index + 1}</span><StationPicker value={row.station} defaultName={row.defaultName} compact label={`第${index + 1}优先到站`} onChange={station => { setStationValidation(false); setDestinations(current => current.map(item => item.key === row.key ? { ...item, station } : item)); }} /><div className="destination-actions"><button type="button" className="icon-button" aria-label={`上移第${index + 1}个到站`} disabled={index === 0} onClick={() => moveDestination(index, index - 1)}><ArrowUp size={14} /></button><button type="button" className="icon-button" aria-label={`下移第${index + 1}个到站`} disabled={index === destinations.length - 1} onClick={() => moveDestination(index, index + 1)}><ArrowDown size={14} /></button><button type="button" className="icon-button remove-button" aria-label={`删除第${index + 1}个到站`} disabled={destinations.length === 1} onClick={() => { setStationValidation(false); setDestinations(current => current.filter(item => item.key !== row.key)); }}><X size={15} /></button></div>
              </div>)}
            </div><button type="button" className="add-destination" disabled={destinations.length >= 8} onClick={() => { setStationValidation(false); setDestinations(current => [...current, { key: crypto.randomUUID(), station: null }]); }}><Plus size={16} />添加备选到站</button></div>
            <div className="date-time-row"><div className="field-block"><div className="field-caption"><label className="field-label" htmlFor="departure-date">出发日期</label></div><input id="departure-date" type="date" required value={date} min={clock.date || undefined} onChange={event => setDate(event.target.value)} /></div><div className="field-block"><div className="field-caption"><label className="field-label" htmlFor="earliest-time">最早出发</label><HelpTip label="最早出发">只看在所选出发站此时间之后开出的车次。日期和时间均按北京时间；跨午夜的后续车票按实际乘车日期计算。</HelpTip></div><input id="earliest-time" type="time" required value={earliestTime} onChange={event => setEarliestTime(event.target.value)} /></div></div>
            <fieldset className="field-block train-block"><legend className="field-label">车次类型</legend><div className="choice-grid train-choices">{(['G', 'D', 'C'] as const).map(type => <label className={`choice ${trainTypes.includes(type) ? 'checked' : ''}`} key={type}><input type="checkbox" checked={trainTypes.includes(type)} onChange={() => setTrainTypes(current => current.includes(type) ? current.filter(value => value !== type) : [...current, type])} /><span>{type}<small>{type === 'G' ? '高铁' : type === 'D' ? '动车' : '城际'}</small></span><Check size={15} /></label>)}</div></fieldset>
            <fieldset className="field-block seat-block"><legend className="field-label">车次席别<HelpTip label="车次席别">勾选可接受的席别。勾选多个表示任意一种都可考虑，不代表需要同时购买多个席别。</HelpTip></legend><div className="choice-grid seat-choices">{SEATS.map(seat => <label className={`choice ${seats.includes(seat) ? 'checked' : ''}`} key={seat}><input type="checkbox" checked={seats.includes(seat)} onChange={() => setSeats(current => current.includes(seat) ? current.filter(value => value !== seat) : [...current, seat])} /><span>{SEAT_LABELS[seat]}</span><Check size={15} /></label>)}</div></fieldset>
            <div className="passenger-options"><div className="option-with-help"><label htmlFor="passenger-count">成人乘车人数<select id="passenger-count" value={passengerCount} onChange={event => setPassengerCount(Number(event.target.value))}>{[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count} 人</option>)}</select></label><HelpTip label="成人乘车人数">每一张车票的已确认余票数量都要满足乘车人数。库存没有明确张数时，多人方案不会被列为可买；不保证相邻座位。</HelpTip></div><div className="option-with-help"><label className="choice"><input type="checkbox" checked={sameSeatOnly} onChange={event => setSameSeatOnly(event.target.checked)} />两张票使用同一席别</label><HelpTip label="两张票使用同一席别">适用于同车两段票和异车中转。例如两张都选二等座；关闭后可搭配已勾选的不同席别。同席别不等于同一个座位，也不保证同行人坐在一起。</HelpTip></div></div><div className="strategy-options"><div className="option-with-help"><label className="switch-row"><span><strong>异车中转</strong></span><input type="checkbox" role="switch" checked={includeTransfer} onChange={event=>setIncludeTransfer(event.target.checked)} /><span className="switch-track" aria-hidden="true" /></label><HelpTip label="异车中转">{KIND_HELP.transfer}</HelpTip></div><div className="option-with-help"><label className="switch-row"><span><strong>买长乘短</strong></span><input type="checkbox" role="switch" checked={includeLongTicket} onChange={event => setIncludeLongTicket(event.target.checked)} /><span className="switch-track" aria-hidden="true" /></label><HelpTip label="买长乘短">{KIND_HELP.long}</HelpTip></div><div className="option-with-help"><label className="switch-row"><span><strong>短票＋申请补票</strong></span><input type="checkbox" role="switch" checked={includeExtension} onChange={event => setIncludeExtension(event.target.checked)} /><span className="switch-track" aria-hidden="true" /></label><HelpTip label="短票与申请补票">{KIND_HELP.extension}</HelpTip></div></div>
            {includeTransfer && <details className="transfer-options"><summary>中转条件<span>同站换车 · 至少 {minTransferMinutes} 分钟{allowOvernightTransfer ? ' · 可过夜等车' : ' · 不跨夜等车'}</span></summary><div className="transfer-fields"><div className="field-caption"><span>换乘站</span><HelpTip label="自动与指定换乘站">默认优先核验少量合适枢纽，也可指定最多 3 个实际车站。结果是已核验候选中的优选，不代表查遍全国所有路线；本次支持同站换乘一次。</HelpTip></div><small>{transferRows.length ? '只核验下方指定车站' : '自动选择合适枢纽'}</small>{transferRows.map((row,index)=><div className="transfer-station-row" key={row.key}><StationPicker label={`中转站 ${index+1}`} value={row.station} onChange={station=>{setTransferRows(rows=>rows.map((r,i)=>i===index?{...r,station}:r));setStationValidation(false);}} /><button type="button" className="icon-button" aria-label={`删除中转站 ${index+1}`} onClick={()=>setTransferRows(rows=>rows.filter((_,i)=>i!==index))}><X size={16}/></button></div>)}{transferRows.length<3&&<button type="button" className="text-button" onClick={()=>setTransferRows(rows=>[...rows,{key:crypto.randomUUID(),station:null}])}><Plus size={14}/>指定换乘站</button>}<div className="transfer-preferences"><label>最短换乘等待<select aria-label="最短换乘等待" value={minTransferMinutes} onChange={event=>setMinTransferMinutes(Number(event.target.value))}>{[20,30,45,60,90,120,180].map(n=><option key={n} value={n}>{n} 分钟</option>)}</select></label><label className="choice"><input type="checkbox" checked={allowOvernightTransfer} onChange={event=>setAllowOvernightTransfer(event.target.checked)}/>允许过夜等车</label><HelpTip label="换乘等待与过夜">总用时包括等车。默认至少留 45 分钟，最长等待 16 小时、总行程不超过 48 小时。允许过夜等车时可能需要自行安排住宿，住宿费用不计入票价；等待时间不能保证晚点后仍能接上。</HelpTip></div></div></details>}
            {(error || stationError) && <div className="inline-error" role="alert"><TriangleAlert size={17} /><span>{error || stationError}</span></div>}
            <button type="submit" className="primary-button search-button" disabled={Boolean(busy) || activeJob || !helper.online || checkingHelper}>{busy === 'search' || activeJob ? <LoaderCircle size={19} className="spin" /> : <Search size={19} />}{busy === 'search' ? '提交查询中…' : activeJob ? '查询进行中…' : '查询实时余票'}</button>
            <p className="query-footnote"><ShieldCheck size={14} />余票来自 12306 · 不自动购票</p>
          </form>
          <div className="connection-note"><Monitor size={20} /><div><h3>Mac 保持唤醒，手机也能查询</h3><p>后台服务运行时可关闭终端。休眠或断网期间不能查票。</p><button onClick={() => setDeviceOpen(true)}>连接查询助手</button></div></div>
          <WatchPanel input={input} helper={helper} onOpenJob={id => void openSavedJob(id)} />
        </aside>
        <section className="results-column" id="query-results" aria-label="查询结果">
          <div className="results-heading"><div><p className="eyebrow">路线规划</p><h2>{historyOnly ? '历史查询快照' : job ? '本次查询结果' : '你的到达方案'}{shownCount > 0 && <span className="total-count">{shownCount}</span>}</h2></div></div>
          {job && <div className={`job-summary ${job.status === 'waiting_user' || job.status === 'unavailable' ? 'attention' : ''}`} aria-live="polite"><div className="job-status">{ACTIVE.has(job.status) ? <LoaderCircle size={18} className="spin" /> : job.status === 'complete' ? <CheckCircle2 size={18} /> : <Info size={18} />}<strong>{job.mode === 'recheck' && job.status === 'complete' ? '重新核验完成' : STATUS_LABELS[job.status]}</strong>{activeJob && <button className="text-button" onClick={cancel} disabled={Boolean(busy)}>取消查询</button>}</div><p>{job.message}</p><div className="submitted-query"><span>{job.input.origin.name} <ArrowRight size={13} />{job.input.destinations.map(s => s.name).join(' / ')}</span><span>{job.input.date} · {job.input.earliestTime} 后</span><span>{job.input.trainTypes.join('/')} · {job.input.seats.map(s => SEAT_LABELS[s]).join('、')}</span><span>{job.input.passengerCount ?? 1} 名成人 · {job.input.sameSeatOnly === false ? '允许两段不同席别' : '两段同席别'}</span><span>{job.input.includeTransfer ? `异车中转 · 等待至少 ${job.input.minTransferMinutes ?? 45} 分钟 · ${job.input.allowOvernightTransfer === false ? '不跨夜等车' : '可过夜等车'}` : '中转关闭'}</span><span>买长乘短{job.input.includeLongTicket ? '开启' : '关闭'} · 补票{job.input.includeExtension ? '开启' : '关闭'}</span></div>{result?.completedAt && <p className="query-time">最后采集 {stamp(result.completedAt)}（北京时间）</p>}</div>}
          {job?.status === 'waiting_user' && <div className="notice warning"><TriangleAlert size={18} /><div><strong>请本人回到 Mac 完成官网登录或验证码</strong><p>在查询助手浏览器中处理完毕后，点击下方按钮。手机不能代答验证。</p><button type="button" className="secondary-button" disabled={resuming || !helper.online} onClick={() => void resumeHelper(job.id)}>{resuming ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}我已完成验证，继续查询</button></div></div>}
          {pollError && <div className="notice warning" role="alert"><TriangleAlert size={18} /><span>进度读取失败：{pollError} 页面将继续重试；当前信息尚未更新。</span></div>}
          {stale && <div className="notice warning"><RefreshCw size={18} /><span>{busy === 'recheck' ? '正在重新核验，旧方案已暂时隐藏。' : dirty ? '查询条件已更改。请重新查询，获取符合新条件的余票。' : '重新核验未成功，请重试查询；旧余票不能作为当前可购买依据。'}</span></div>}
          {hasHistory && <div className="notice history-notice" role="status"><Clock3 size={18} /><div><strong>历史快照 · 不能作为当前余票</strong><p>{job?.status === 'unavailable' || job?.status === 'cancelled' ? '查询已中断或取消，本轮库存只保留为历史记录。' : '采集超过 5 分钟、已经发车或时间未确认的方案已从当前列表移除。'}{historicalPlanCount > 0 ? ` ${historicalPlanCount} 个方案已过期。` : ''}各区间明细仍保留采集时的状态；请重新查询取得新库存。</p><button type="button" className="secondary-button" disabled={!input || !helper.online || activeJob || Boolean(busy)} onClick={() => { if (input) void startSearch(input); }}><RefreshCw size={15} />按当前条件重新查询</button></div></div>}
          {result?.issues?.length ? <div className="notice warning"><TriangleAlert size={18} /><div><strong>{result.complete ? '方案核验说明' : '部分区间尚未确认'}</strong>{result.issues.map((issue, index) => <p key={index}>{issue}</p>)}</div></div> : null}
          {notOnSale.length > 0 && <div className="not-on-sale-summary"><div><Clock3 size={18} /><strong>{notOnSale.length} 个直达区间尚未起售</strong></div><p>已识别官网未起售状态，具体起售时间尚未确认。先去官网查本站起售时间，再按上方当前行程设置盯票。</p><div className="not-on-sale-trains">{notOnSale.slice(0, 12).map(quote => <a key={`${quote.train.runId}:${quote.to.code}`} href={officialTicketUrl(quote.from, quote.to, quote.departureIso)} target="_blank" rel="noopener noreferrer">{quote.train.trainCode} · {quote.to.name} · {timeOf(quote.departureIso)}<ExternalLink size={12} /></a>)}</div><a href="https://www.12306.cn/index/view/infos/sale_time.html" target="_blank" rel="noopener noreferrer">查询官网起售时间<ExternalLink size={12} /></a><a href="#watch-panel">设置当前行程盯票<Clock3 size={12} /></a></div>}
          {!!result?.stationAlternatives?.length && !stale && <div className="station-alternatives"><div><MapPin size={19} /><h3>官网返回了同城其他车站</h3></div><p>当前选的是 {job?.input.origin.name} → {job?.input.destinations.map(s => s.name).join(' / ')}。以下是本次响应中的实际站点组合，尚未核验为当前条件下可购；点击会切换这两个车站并重新查询。</p><div className="station-alternative-buttons">{result.stationAlternatives.filter(p => p.requestedFrom.code === job?.input.origin.code && job?.input.destinations.some(s => s.code === p.requestedTo.code)).map(pair => <button key={`${pair.requestedTo.code}-${pair.from.code}-${pair.to.code}`} disabled={Boolean(busy) || activeJob} onClick={() => void queryAlternative(pair)}>{pair.from.name}<ArrowRight size={13} />{pair.to.name}<Search size={14} /></button>)}</div><small>站点组合采集 {stamp(result.stationAlternatives[0].fetchedAt)} · 其他车站余票不会充当所选区间有票</small></div>}
          {result?.suggestedDestinations?.length && !stale ? <div className="destination-suggestion"><span><Info size={16} />经停顺序建议：{result.suggestedDestinations.map(s => s.name).join(' → ')}</span><button onClick={() => setDestinations(result.suggestedDestinations!.map((station, index) => ({ key: `suggest-${index}`, station })))}>采用由远到近顺序</button></div> : null}
          {job && !stale && (plans.length > 0 || waitlist.length > 0) && <div className="result-toolbar"><div className="stock-toggle" role="tablist" aria-label="票的确定程度"><button type="button" role="tab" aria-selected={showingTickets} className={showingTickets ? 'active' : ''} onClick={() => setStock('ticket')}>有票<span>{plans.length}</span></button><button type="button" role="tab" aria-selected={!showingTickets} className={!showingTickets ? 'active waitlist-active' : ''} onClick={() => setStock('waitlist')}>候补<span>{waitlist.length}</span></button></div><div className="sort-controls" role="group" aria-label="排序">{SORTS.map(item => { const active = sortKey === item.key; const ascending = sortDirection === 'asc'; return <button type="button" key={item.key} className={active ? 'active' : ''} aria-pressed={active} onClick={() => chooseSort(item.key)}>{item.label}{active && item.key !== 'rank' && (ascending ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}<span className="sr-only">{active && item.key !== 'rank' ? (ascending ? '，当前升序，再次点击改为降序' : '，当前降序，再次点击改为升序') : ''}</span></button>; })}</div></div>}
          {showingTickets && <div className="result-tabs" role="tablist" aria-label="方案类型">{(['all', 'direct', 'split', 'transfer', 'long', 'extension'] as const).map(kind => <div key={kind} className={`result-tab-item ${tab === kind ? 'active' : ''}`} role="presentation"><button type="button" role="tab" aria-selected={tab === kind} className="result-tab" onClick={() => {setTab(kind);setShowAllPlans(false);}}>{kind === 'all' ? '全部方案' : KIND_LABELS[kind]}<span>{job && !stale ? (kind === 'all' ? plans.length : plans.filter(p => p.kind === kind).length) : '—'}</span></button><HelpTip label={kind === 'all' ? '全部方案与数量' : KIND_LABELS[kind]}>{kind === 'all' ? '汇总本次查询的各类方案。数字是方案数，不是车票张数；“—”表示尚无当前结果，0 表示本次没有找到这一类方案。' : KIND_HELP[kind]}</HelpTip></div>)}</div>}
          {job && !stale && !showingTickets && <p className="result-disclaimer"><Info size={15} />候补不能直接购买，兑现不确定。需要确定能买到的车次时，请看「有票」。</p>}
          {showingTickets && plans.length > 0 && !stale && <p className="result-disclaimer"><Clock3 size={15} />有票仅指列出的购票区间可售；短票方案的后续区间尚未覆盖。候选票尚未购买，购票前请重新核验。</p>}
          <div className="train-list-heading" aria-hidden="true"><span>车次 / 方案</span><span>出发站 / 到达站</span><span>出发 / 到达时间</span><span>历时</span><span>席别 / 余票</span><span>购票金额</span><span>操作</span></div>
          {job && showingTickets && !stale && allSortedTickets.length>0 && <p className="recommendation-note">{showAllPlans ? '显示全部已确认方案' : `先看 ${sortedTickets.length} 个优选方案`}<HelpTip label="推荐如何比较价格与时间">在本次已核验候选内，分别比较车票合计和包括等待的总用时；明显更贵又更慢的组合靠后，价时各占一半选择折中。未确认价格不参与低价推荐；优先完整覆盖，短票补票单独查看。到站仍按你设定的优先级排列。</HelpTip></p>}
          {result?.transferSearch && !stale && <details className="transfer-scope"><summary>中转核验范围 · {result.transferSearch.checked} 个候选区间</summary><p>{result.transferSearch.stations.map(s=>s.name).join('、') || '尚未取得候选车站'}。仅核验有限枢纽的一次同站换乘；未找到方案不能据此判断两站无法到达。</p></details>}
          {showingTickets && sortedTickets.map(plan => <PlanCard key={plan.id} plan={plan} labels={planLabels[plan.id] || []} onMap={() => setMapPlanId(plan.id)} onRecheck={() => recheck(plan.id)} onCopy={() => copy(planCopy(plan), plan.id)} copied={copied === plan.id} disabled={Boolean(busy) || stale} recheckDisabled={Boolean(busy) || activeJob || !helper.online || stale} />)}
          {showingTickets && !showAllPlans && allSortedTickets.length>sortedTickets.length && <button type="button" className="show-more-plans" onClick={()=>setShowAllPlans(true)}>查看其余 {allSortedTickets.length-sortedTickets.length} 个方案<ChevronDown size={16}/></button>}
          {!showingTickets && sortedWaitlist.map(train => <WaitlistCard key={train.id} train={train} officialUrl={officialTicketUrl(job!.input.origin, job!.input.destinations[train.destinationRank], train.departureIso)} onCopy={() => copy(waitlistCopy(train), train.id)} copied={copied === train.id} />)}
          {shownCount === 0 && <div className={`empty-state ${job ? 'has-query' : ''}`}>
            <div className="empty-route"><span className="empty-station"><span className="route-dot" /><small>出发站</small><strong>{origin?.name || '选择出发站'}</strong></span><span className="empty-route-line"><TrainFront size={25} /><span /></span><span className="empty-station"><span className="route-dot end" /><small>优先到站</small><strong>{destinations[0]?.station?.name || destinations[0]?.defaultName || '选择到站'}</strong></span></div>
            <h3>{stale ? '等待新的查询结果' : activeJob ? (job?.status === 'waiting_user' ? '请在 Mac 上继续操作' : '正在核验直达、同车分段与中转') : historyOnly ? '历史库存已隐藏，请重新查询' : job?.status === 'unavailable' ? '当前无法取得真实余票' : job?.status === 'cancelled' ? '本次查询已取消' : job && !showingTickets ? '没有仅候补的直达车次' : result ? (tab !== 'all' && plans.length ? '暂无这一类方案' : plans.length === 0 && waitlist.length > 0 ? '没有可直接购买的方案' : result.complete ? (job?.mode === 'recheck' ? '重新核验：原方案当前已不可售' : '本次未找到符合条件的可购方案') : '尚未取得完整的余票数据') : '找到适合你的到达方案'}</h3>
            <p>{stale ? '当前条件对应的旧余票已隐藏。重新查询后，新的方案会显示在这里。' : activeJob ? (job?.status === 'waiting_user' ? '在 Mac 官方浏览器处理完成后确认恢复；本轮会保留结果并结束，再次查询取得新余票。' : '正在逐个核对区间余票、经停站与列车运行日期。可随时取消。') : historyOnly ? '以下区间明细是历史快照，不能用于判断当前可买。重新查询后，已确认的新库存会恢复显示。' : job && !showingTickets ? '候补车次不能直接出票。可切换到「有票」查看能购买的方案。' : result && plans.length === 0 && waitlist.length > 0 ? `有 ${waitlist.length} 趟直达车次只有候补。候补不等于有票，可在上方单独查看。` : result ? (job?.input.includeTransfer ? '本次有限中转候选未找到符合条件的方案。可指定换乘站、调整出发时间或允许过夜等车；这不代表两站无法到达。' : '可在下方查看各区间的查询状态，或调整到站、车型与席别重新查询。') : '选择实际车站，比较直达、同车分段与一次换车中转。'}</p>
            {!job && !helper.online && <div className="empty-offline"><span className="status-dot" /><span>{checkingHelper ? '正在检查查询助手…' : '查询助手离线，连接后即可开始'}</span><button onClick={() => setDeviceOpen(true)}>连接 Mac</button></div>}
            {!job && <div className="strategy-guide"><div><span className="guide-number">01</span><strong>先找直达</strong><p>优先查出发站到目标站</p></div><div><span className="guide-number">02</span><strong>再比较中转与分段</strong><p>核对两张票、接续时间与总价</p></div><div><span className="guide-number">03</span><strong>扩展购票区间</strong><p>买长乘短或申请补票</p></div></div>}
          </div>}
          {result && <details className={`observations ${hasHistory ? 'has-history' : ''}`} open={observationsOpen} onToggle={event => setObservationsOpen(event.currentTarget.open)}><summary><span><Search size={17} />{historyOnly ? '各区间历史快照' : '各区间余票记录'} <span className="observation-count">{result.observations.length}</span></span><ChevronDown size={17} /></summary><p>保留无票、候补、未起售、不支持和未确认状态；未确认不代表无票。{hasHistory && ' 含历史快照：超过 5 分钟、已发车或本轮不可用的记录只表示采集当时的状态。'}{stale && ' 以下为上次查询记录。'}</p>{result.observations.length ? observationsOpen && <div className="observation-scroll"><table><caption className="sr-only">各列车区间独立采集的余票状态</caption><thead><tr><th>车次 / 区间</th>{SEATS.map(seat => <th key={seat}>{SEAT_LABELS[seat]}</th>)}<th>采集时间</th></tr></thead><tbody>{result.observations.map((quote, index) => <tr className={stale || !currentQuote(quote, job!.status, inventoryNow) ? 'historical-row' : undefined} key={`${quote.train.runId}-${quote.from.code}-${quote.to.code}-${index}`}><td><strong>{quote.train.trainCode}</strong>{(stale || !currentQuote(quote, job!.status, inventoryNow)) && <span className="snapshot-label">历史快照</span>}<span>{quote.from.name} → {quote.to.name}</span><small>{dateOf(quote.departureIso)} {timeOf(quote.departureIso)} 出发</small></td>{SEATS.map(seat => <td key={seat}><span className={`availability ${quote.seats[seat].status}`}>{inventoryText(quote.seats[seat])}</span><small>{price(quote.seats[seat].price)}</small></td>)}<td><span>{timeOf(quote.fetchedAt)}</span><small>{dateOf(quote.fetchedAt)}</small></td></tr>)}</tbody></table></div> : <p>尚未取得可核验的区间数据。</p>}</details>}
          <div className="rules-note"><Info size={18} /><p>短票仅覆盖票面区间。须在原票到站前申请补票，能否获准取决于列车运输能力。<a href={RULES_URL} target="_blank" rel="noreferrer">查看 12306 规定<ExternalLink size={12} /></a></p></div>
        </section>
      </div>
      <footer className="site-footer"><span><TrainFront size={15} />同车余票</span><p>以 12306 官方实际售票结果为准 · 所有时间均为北京时间</p>{privateLogin&&<button className="text-button" onClick={logout} disabled={loggingOut}>{loggingOut?'正在退出…':'退出登录'}</button>}<a href={OFFICIAL_URL} target="_blank" rel="noreferrer">打开 12306<ExternalLink size={13} /></a></footer>
    </main>
    <PrivateAssistant form={assistantForm} job={stale?null:job} queryBusy={activeJob||Boolean(busy)} hidden={Boolean(mapPlan)||tourOpen||deviceOpen} onBusy={setAssistantBusy} onSearch={assistantSearch} onCancel={async(id)=>{const data=await api<{job:RailJob}>(`/api/jobs/${id}/cancel`,{method:'POST'});setJob(current=>current?.id===id?data.job:current);}} onPlan={assistantPlan} onSort={sort=>{setSortKey(sort==='balanced'?'rank':sort);setSortDirection('asc');setShowAllPlans(false);}} />
    {tourOpen && <UsageTour onClose={closeTour} />}
    {deviceOpen && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setDeviceOpen(false); }}><DeviceModal helper={helper} checking={checkingHelper} device={device} busy={deviceBusy} error={deviceError} copied={copied === 'device'} onClose={() => setDeviceOpen(false)} onCreate={createDevice} onRevoke={revokeDevice} onResume={() => void resumeHelper(helper.waitingJobId || undefined)} resuming={resuming} onRefresh={refreshHelper} onCopy={() => device && copy(device.deviceToken, 'device')} /></div>}
    {mapPlan && job && <RouteMap key={job.id} plan={mapPlan} plans={sortedTickets.length ? sortedTickets : plans} onPlanChange={setMapPlanId} jobId={job.id} onClose={closeMap} onRecheck={() => recheck(mapPlan.id)} recheckDisabled={Boolean(busy) || activeJob || !helper.online || stale} />}
  </div>;
}

function planCopy(plan: TicketPlan) {
  return [`${KIND_LABELS[plan.kind]} · ${plan.kind==='transfer'?plan.legs.map(l=>l.train?.trainCode).join(' → '):plan.train.trainCode}`, `实际乘车日期：${dateOf(plan.departureIso)}，${timeOf(plan.departureIso)} ${plan.origin.name}出发 → ${stamp(plan.arrivalIso)} ${plan.target.name}到达`, `用时 ${duration(plan.departureIso, plan.arrivalIso)}`, ...plan.legs.map((leg, index) => `第${index + 1}张：${leg.train?.trainCode || plan.train.trainCode} ${leg.from.name}（${leg.from.code}） → ${leg.to.name}（${leg.to.code}），${dateOf(leg.departureIso)} ${timeOf(leg.departureIso)}，${SEAT_LABELS[leg.seat]}，${inventoryText(leg.inventory)}，${price(leg.inventory.price)}，采集 ${stamp(leg.fetchedAt)}\n${ticketLegUrl(leg)}`), `${plan.kind === 'extension' ? '短票票价' : '已知购票合计'}：${price(planPurchasePrice(plan))}`, plan.uncovered ? `未覆盖区间：${plan.uncovered.from.name} → ${plan.uncovered.to.name}，补票是否获准及金额待确认。` : '', plan.warning || '', `官网链接已带入区间和乘车日期；进入后分别筛选 ${plan.kind==='transfer'?plan.legs.map(l=>l.train?.trainCode).join('、'):plan.train.trainCode}。候选票尚未购买，请在 12306 核验后购票。`].filter(Boolean).join('\n');
}
function waitlistCopy(train: WaitlistTrain) {
  return [`仅候补 · ${train.trainCode}`, `${dateOf(train.departureIso)} ${timeOf(train.departureIso)} ${train.fromName} → ${timeOf(train.arrivalIso)} ${train.toName}`, `用时 ${duration(train.departureIso, train.arrivalIso)}`, ...train.seats.map(seat => `${SEAT_LABELS[seat.seat]}：候补，${price(seat.price)}`), '候补不能直接购买，兑现不确定。'].join('\n');
}
function TripActions({onCopy, onRecheck, copied, disabled = false, recheckDisabled = false, copyLabel = '复制条件', links = []}: {onCopy: () => void; onRecheck?: () => void; copied: boolean; disabled?: boolean; recheckDisabled?: boolean; copyLabel?: string; links?: { label: string; url: string }[]}) {
  return <div className="plan-actions">
    <button onClick={onCopy} disabled={disabled} className="card-button">{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : copyLabel}</button>
    {onRecheck && <button onClick={onRecheck} disabled={recheckDisabled} className="card-button"><RefreshCw size={13} />重新核验</button>}
    {!disabled && links.map(link => <a href={link.url} key={link.url} target="_blank" rel="noopener noreferrer" className="official-button">{link.label}<ExternalLink size={13} /></a>)}
  </div>;
}
function TripStations({from, to}: {from: string; to: string}) {
  return <div className="station-pair"><span><small>发</small><strong>{from}</strong></span><span><small>到</small><strong>{to}</strong></span></div>;
}
function TripTimes({departure, arrival}: {departure: string; arrival: string}) {
  return <div className="time-pair"><strong>{timeOf(departure)}</strong><strong>{timeOf(arrival)}</strong><small>{dateOf(departure) !== dateOf(arrival) ? `${dateOf(arrival)} 到达` : '当日到达'}</small></div>;
}
function PlanCard({ plan, labels, onMap, onRecheck, onCopy, copied, disabled, recheckDisabled }: { plan: TicketPlan; labels: string[]; onMap: () => void; onRecheck: () => void; onCopy: () => void; copied: boolean; disabled: boolean; recheckDisabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const routeId = useId();
  const longEnd = plan.legs[plan.legs.length - 1]?.to;
  const trainCodes = plan.kind==='transfer' ? plan.legs.map(l=>l.train?.trainCode).join(' → ') : plan.train.trainCode;
  return <article id={`plan-${plan.id}`} tabIndex={-1} className={`plan-card kind-${plan.kind}`}>
    <div className="plan-main train-grid">
      <div className="train-identity"><button className="train-map-number" onClick={onMap} aria-label={`${trainCodes}，查看乘车路线`}>{trainCodes}</button><span>{dateOf(plan.departureIso)} 乘车</span><span className={`kind-badge ${plan.kind}`}>{KIND_LABELS[plan.kind]}</span>{labels.map(label=><small className="recommendation-badge" key={label}>{label}</small>)}<button className="train-map-link" onClick={onMap}><RouteIcon size={13} />乘车路线</button><button onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls={routeId}>经停路线<ChevronDown size={13} className={expanded ? 'rotated' : ''} /></button></div>
      <TripStations from={plan.origin.name} to={plan.target.name} />
      <TripTimes departure={plan.departureIso} arrival={plan.arrivalIso} />
      <div className="journey-duration"><strong>{duration(plan.departureIso, plan.arrivalIso)}</strong><small>{plan.kind==='transfer' ? `${plan.transfer?.station.name}换车 · 等 ${plan.transfer?.waitMinutes} 分钟` : plan.kind === 'split' ? `${plan.legs[0]?.to.name}接续` : '同一趟列车'}</small></div>
      <div className="seat-summary">{plan.legs.map((leg, index) => <div key={`${leg.from.code}-${leg.to.code}-${index}`}><span>{SEAT_LABELS[leg.seat]}{plan.legs.length > 1 && <small>第 {index + 1} 段</small>}</span><strong className={`availability ${leg.inventory.status}`}>{inventoryText(leg.inventory)}</strong></div>)}</div>
      <div className="plan-total"><strong>{price(planPurchasePrice(plan))}</strong><span>{plan.kind === 'extension' ? '短票价格' : '购票合计'}</span>{plan.kind === 'extension' && <small>补票金额待确认</small>}</div>
      <TripActions onCopy={onCopy} onRecheck={onRecheck} copied={copied} disabled={disabled} recheckDisabled={recheckDisabled} links={purchaseLinks(plan)} />
    </div>
    {expanded && <div className="route-detail" id={routeId}><p><ShieldCheck size={14} />{plan.kind==='transfer'?'票段核验':'同车核验'}：{plan.relationEvidence}</p><ol className="route-timeline">{plan.route.map(stop => <li key={`${stop.index}-${stop.station.code}`} className={stop.station.code === plan.target.code ? 'target-stop' : ''}><span className="timeline-dot" /><strong>{stop.station.name}</strong><span>{stop.departureIso ? `${dateOf(stop.departureIso)} ${timeOf(stop.departureIso)}` : stop.arrivalIso ? `${dateOf(stop.arrivalIso)} ${timeOf(stop.arrivalIso)}` : '时刻未确认'}</span>{stop.station.code === plan.target.code && <small>目标到站</small>}</li>)}</ol><p className="run-evidence">{plan.kind==='transfer'?plan.legs.map(l=>`${l.train?.trainCode} · 始发运行日 ${l.train?.serviceDate} · 内部列车标识 ${l.train?.trainNo}`).join(' / '):`始发运行日 ${plan.train.serviceDate} · 内部列车标识 ${plan.train.trainNo}`}</p></div>}
    {plan.kind==='transfer' ? <details className="transfer-ticket-details"><summary>两张票与换乘说明</summary><div className="ticket-legs">{plan.legs.map((leg, index) => <div className="ticket-leg" key={`${leg.from.code}-${leg.to.code}-${index}`}><span className="leg-number"><Ticket size={14} />{plan.legs.length > 1 ? `第 ${index + 1} 张` : '购票区间'}</span><div className="leg-route"><strong>{leg.train&&<b className="leg-train-code">{leg.train.trainCode}</b>}{leg.from.name}<ArrowRight size={13} />{leg.to.name}</strong><small>{dateOf(leg.departureIso)} {timeOf(leg.departureIso)} → {stamp(leg.arrivalIso)}</small></div><span className="leg-seat">{SEAT_LABELS[leg.seat]}</span><span className={`availability ${leg.inventory.status}`}>{inventoryText(leg.inventory)}</span><strong className="leg-price">{price(leg.inventory.price)}</strong></div>)}</div><div className="plan-note purchase-hint"><ExternalLink size={15} /><span>官网已带入每张票的实际车站与乘车日期；进入后筛选 <strong>{trainCodes}</strong> 并核对席别。</span></div>{plan.warning && <p className="plan-note custom-warning"><Info size={15} />{plan.warning}</p>}</details> : <><div className="ticket-legs">{plan.legs.map((leg, index) => <div className="ticket-leg" key={`${leg.from.code}-${leg.to.code}-${index}`}><span className="leg-number"><Ticket size={14} />{plan.legs.length > 1 ? `第 ${index + 1} 张` : '购票区间'}</span><div className="leg-route"><strong>{leg.train&&<b className="leg-train-code">{leg.train.trainCode}</b>}{leg.from.name}<ArrowRight size={13} />{leg.to.name}</strong><small>{dateOf(leg.departureIso)} {timeOf(leg.departureIso)} → {stamp(leg.arrivalIso)}</small></div><span className="leg-seat">{SEAT_LABELS[leg.seat]}</span><span className={`availability ${leg.inventory.status}`}>{inventoryText(leg.inventory)}</span><strong className="leg-price">{price(leg.inventory.price)}</strong></div>)}</div><div className="plan-note purchase-hint"><ExternalLink size={15} /><span>官网已带入每张票的实际车站与乘车日期；进入后筛选 <strong>{trainCodes}</strong> 并核对席别。</span></div>{plan.warning && <p className="plan-note custom-warning"><Info size={15} />{plan.warning}</p>}</>}
    {plan.kind==='transfer'&&<div className={`plan-note transfer-note ${plan.transfer?.overnight?'overnight':''}`}><RefreshCw size={15}/><span>在 <strong>{plan.transfer?.station.name}</strong> 换乘另一趟车，等待 {plan.transfer?.waitMinutes} 分钟。分别购票，晚点可能错过接续。{plan.transfer?.overnight&&<strong>次日换乘 · 需自行安排过夜</strong>}</span></div>}
    {plan.kind === 'split' && <div className="plan-note"><Info size={15} /><span>两段均需分别购买；在 {plan.legs[0]?.to.name} 接续，可能需要换座。</span></div>}

    {plan.kind === 'long' && <div className="plan-note"><Info size={15} /><span>实际购票到 {longEnd?.name}，在 {plan.target.name} 提前下车。多买区间：{plan.target.name} → {longEnd?.name}。</span></div>}
    {plan.uncovered && <div className="plan-extension-warning"><TriangleAlert size={16} /><div><strong>{plan.uncovered.from.name} → {plan.uncovered.to.name} 尚无车票覆盖</strong><p>原票到站前申请补票；能否获准和补票金额均待确认。<a href={RULES_URL} target="_blank" rel="noreferrer">查看规定<ExternalLink size={12} /></a></p></div></div>}

    <div className="plan-footer"><span><Clock3 size={13} />12306 · 采集 {stamp(plan.fetchedTo)}{plan.fetchedFrom !== plan.fetchedTo ? `（首段 ${timeOf(plan.fetchedFrom)}）` : ''}</span><span>到站优先级 {plan.destinationRank + 1} · 候选，待购买</span></div>
  </article>;
}
function WaitlistCard({ train, onCopy, copied, officialUrl }: { train: WaitlistTrain; onCopy: () => void; copied: boolean; officialUrl: string }) {
  return <article className="plan-card waitlist-card">
    <div className="plan-main train-grid">
      <div className="train-identity"><strong>{train.trainCode}</strong><span>{dateOf(train.departureIso)} 乘车</span><span className="kind-badge waitlist">仅候补</span></div>
      <TripStations from={train.fromName} to={train.toName} />
      <TripTimes departure={train.departureIso} arrival={train.arrivalIso} />
      <div className="journey-duration"><strong>{duration(train.departureIso, train.arrivalIso)}</strong><small>直达车次</small></div>
      <div className="seat-summary">{train.seats.map(seat => <div key={seat.seat}><span>{SEAT_LABELS[seat.seat]}</span><strong className="availability waitlist">候补</strong></div>)}</div>
      <div className="plan-total"><strong>{price(train.price)}</strong><span>参考票价</span><small>候补金额待确认</small></div>
      <TripActions onCopy={onCopy} copied={copied} copyLabel="复制车次" links={[{ label: '去官网候补', url: officialUrl }]} />
    </div>
    <div className="plan-extension-warning"><TriangleAlert size={16} /><div><strong>所选席别当前仅支持候补，不能直接购买</strong><p>候补是否兑现不确定。官网已带入实际区间与日期，进入后筛选 {train.trainCode}，由你本人提交候补。</p></div></div>
    <div className="plan-footer"><span><Clock3 size={13} />12306 · 采集 {stamp(train.fetchedAt)}</span><span>到站优先级 {train.destinationRank + 1}</span></div>
  </article>;
}
function DeviceModal({ helper, checking, device, busy, error, copied, onClose, onCreate, onRevoke, onResume, resuming, onRefresh, onCopy }: { helper: HelperState; checking: boolean; device: DeviceDetails | null; busy: boolean; error: string; copied: boolean; onClose: () => void; onCreate: () => void; onRevoke: () => void; onResume: () => void; resuming: boolean; onRefresh: () => void; onCopy: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, textarea');
      if (!elements?.length) return;
      if (event.shiftKey && (document.activeElement === elements[0] || document.activeElement === dialogRef.current)) { event.preventDefault(); elements[elements.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === elements[elements.length - 1]) { event.preventDefault(); elements[0].focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, []);
  return <div className="device-modal" role="dialog" aria-modal="true" aria-labelledby="device-heading" tabIndex={-1} ref={dialogRef}><div className="modal-heading"><span className="modal-icon"><Monitor size={23} /></span><button className="icon-button close-modal" onClick={onClose} aria-label="关闭查询助手设置"><X size={21} /></button></div><h2 id="device-heading">连接你的 Mac 查询助手</h2><p className="modal-intro">将助手安装为 Mac 后台服务后，可关闭终端。电脑须保持开机、联网和唤醒，休眠期间无法查票。</p><div className={`device-status ${helper.online ? 'online' : ''}`}><span className="status-dot" /><div><strong>{helper.online ? `${helper.deviceName || 'Mac 查询助手'}在线` : '查询助手离线'}</strong><p>{helper.message}{helper.lastSeen ? ` · 最近连接 ${stamp(helper.lastSeen)}` : ''}</p></div><button className="icon-button" onClick={onRefresh} disabled={checking} aria-label="刷新助手状态"><RefreshCw size={17} className={checking ? 'spin' : ''} /></button></div><ol className="setup-steps"><li><span>1</span><div><strong>在 Mac 下载助手</strong><p>解压后打开 setup.command 安装并配置，再运行 install-service.command 启用登录后自动运行。可用 start.command 手动调试。</p><div className="download-actions"><a href="/downloads/rail-helper.zip" className="secondary-button" download><Download size={16} />下载 Mac 助手</a><a href="/downloads/使用说明.md" target="_blank" rel="noreferrer">阅读使用说明<ExternalLink size={13} /></a></div></div></li><li><span>2</span><div><strong>生成设备令牌</strong><p>只保留一台查询助手。生成新令牌会作废旧令牌；令牌只在本次创建后显示，请及时保存。</p>{!device && <button className="secondary-button" onClick={onCreate} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}{busy ? '正在创建…' : '生成设备令牌'}</button>}</div></li><li><span>3</span><div><strong>保持官方浏览器可用</strong><p>需要人工处理时，回到 Mac 的查询助手浏览器正常登录或完成验证码。处理完后，可在本页点击继续查询。</p></div></li></ol>{helper.waitingJobId && <div className="helper-resume"><strong>官网需要本人操作</strong><p>请先回到 Mac 的查询助手浏览器完成登录或验证码，再点击继续。</p><button className="secondary-button" onClick={onResume} disabled={resuming || !helper.online}>{resuming ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}我已完成验证，继续查询</button></div>}<div className="device-revoke"><button className="text-button" onClick={onRevoke} disabled={busy}>作废当前设备令牌</button><p>立即断开已配对助手。重新生成令牌并配置后才能查询。</p></div>{error && <p className="inline-error" role="alert">{error}</p>}{device && <div className="device-config"><div><strong>设备配对信息</strong><button onClick={onCopy}><Copy size={14} />{copied ? '已复制' : '复制设备令牌'}</button></div><p>网站地址</p><pre>{device.siteOrigin}</pre><p>设备令牌</p><pre>{device.deviceToken}</pre><p>运行 setup.command 时输入上方网站地址，再仅粘贴设备令牌。凭据会存入 macOS 钥匙串，无需保存配置文件。</p></div>}<div className="device-privacy"><ShieldCheck size={17} /><p>12306 登录状态和原始响应保留在 Mac；网页只接收站点、时刻与余票规划结果。</p></div><button className="primary-button modal-done" onClick={onClose}>返回查询</button></div>;
}
