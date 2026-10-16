import type {
  Adapter, Inventory, PlanKind, RailSearch, SearchResult, SeatType, SegmentQuote,
  Station, StationAlternative, TicketLeg, TicketPlan, TrainIdentity, TrainStop,
} from './rail-types';
import { dominates, recommendPlans } from './rail-recommendation.ts';

export type RailHooks = {
  onProgress?: (result: SearchResult, message: string) => Promise<void> | void;
  isCancelled?: () => Promise<boolean>;
  limits?: Partial<Record<keyof typeof SEARCH_LIMITS, number>>;
};

// A search is a bounded sample of official inventory, never an exhaustive crawl.
// These limits also apply when callers do not supply a UI or cancellation hook.
export const SEARCH_LIMITS = Object.freeze({ requests: 60, expandedRuns: 8, splitStops: 4, longStops: 3,
  plans: 240, observations: 900, resultBytes: 1_600_000 });

function searchLimits(overrides: RailHooks['limits']) {
  return Object.fromEntries(Object.entries(SEARCH_LIMITS).map(([key,value]) => {
    const requested=overrides?.[key as keyof typeof SEARCH_LIMITS];
    return [key,Number.isInteger(requested)&&requested!>0?Math.min(value,requested!):value];
  })) as Record<keyof typeof SEARCH_LIMITS,number>;
}

const KIND_ORDER: Record<PlanKind, number> = { direct: 0, split: 1, transfer: 2, long: 3, extension: 4 };
const KNOWN_STATES = new Set(['available', 'sold_out', 'waitlist', 'not_on_sale', 'unsupported', 'unknown']);
const EXTENSION_WARNING = '仅已查到短区间可售。须在原车票到站前申请补票；能否继续乘车取决于列车运输能力，无法办理时须在短票到站下车。';

class Cancelled extends Error {}
class SearchStopped extends Error {}

function accessStop(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== 'SourceError') return null;
  const code = (error as Error & { code?: string }).code;
  if (code === 'rate') return '12306 已限流，本次停止继续请求；已确认的方案保留，请稍后再查。';
  if (code === 'verify') return '12306 需要本人登录或完成验证码，本次停止继续请求；已确认的方案保留，请在电脑的官方浏览器处理后重新查询。';
  if (code === 'budget') return '本次已达到官方请求预算，停止继续请求；已确认的方案保留，其余区间尚未核验。';
  return null;
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function splitCandidates(stops: TrainStop[], limit=SEARCH_LIMITS.splitStops as number): TrainStop[] {
  if (stops.length <= limit) return [...stops].reverse();
  const picked = new Map<number, TrainStop>();
  const add = (stop: TrainStop) => { if (picked.size < limit) picked.set(stop.index, stop); };
  // Prefer a longer covered first leg, then actual long stops (often larger stations),
  // and a midpoint. This ranking uses only the verified official stop table.
  add(stops[stops.length - 1]);
  add(stops[Math.floor(stops.length / 2)]);
  const byDwell = [...stops].sort((a, b) =>
    (timestamp(b.departureIso) - timestamp(b.arrivalIso)) - (timestamp(a.departureIso) - timestamp(a.arrivalIso)) || b.index - a.index);
  for (const stop of byDwell) add(stop);
  return [...picked.values()].sort((a, b) => b.index - a.index);
}

function longCandidates(stops: TrainStop[], limit=SEARCH_LIMITS.longStops as number): TrainStop[] {
  if (stops.length <= limit) return stops;
  // Nearby ends limit the extra fare; the terminus offers a distinct longer interval.
  return [...stops.slice(0, limit - 1), stops[stops.length - 1]];
}

// Railway dates always refer to China standard time, irrespective of the helper's timezone.
function railwayDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time + 8 * 3600_000).toISOString().slice(0, 10) : '';
}

function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && railwayDate(`${date}T12:00:00+08:00`) === date;
}

function timestamp(value: string | null): number {
  // An explicit timezone prevents a helper's local timezone from silently changing a service day.
  return value && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}

function stationEqual(a: Station, b: Station): boolean {
  return !!a?.code && a.code === b?.code;
}

function sameRun(a: TrainIdentity, b: TrainIdentity): boolean {
  if (a.runId !== b.runId || a.serviceDate !== b.serviceDate) return false;
  if (a.trainNo === b.trainNo && a.trainCode === b.trainCode) return true;
  // The adapter must explicitly attest an official alias; matching display numbers is insufficient.
  return !!a.relationEvidence?.trim() && a.relationEvidence === b.relationEvidence;
}

function identityKey(train: TrainIdentity): string {
  return JSON.stringify([train.runId, train.trainNo, train.serviceDate, train.trainCode]);
}

function quoteError(q: SegmentQuote, from: Station, to: Station, date: string): string | null {
  if (q.source !== '12306' || !stationEqual(q.from, from) || !stationEqual(q.to, to)) return '查询区间或来源不匹配';
  if (!q.train?.runId || !q.train.trainNo || !q.train.trainCode || !validDate(q.train.serviceDate)) return '班次身份不完整';
  if (typeof q.canBuy !== 'boolean') return '可售标记缺失';
  if (!Number.isInteger(q.fromIndex) || !Number.isInteger(q.toIndex) || q.fromIndex < 0 || q.toIndex <= q.fromIndex) return '停站序号不完整';
  if (!Number.isFinite(timestamp(q.departureIso)) || !Number.isFinite(timestamp(q.arrivalIso)) || timestamp(q.arrivalIso) < timestamp(q.departureIso)) return '区间日期时间无效';
  if (railwayDate(q.departureIso) !== date || q.train.serviceDate > date) return '乘车日期或始发运营日期不匹配';
  if (!Number.isFinite(timestamp(q.fetchedAt))) return '采集时间无效';
  return null;
}

function inventoryValid(inv: Inventory | undefined): boolean {
  return !!inv && KNOWN_STATES.has(inv.status)
    && (inv.price === null || (Number.isFinite(inv.price) && inv.price >= 0))
    && (inv.count === undefined || (Number.isInteger(inv.count) && inv.count >= 0))
    && !(inv.status === 'available' && inv.count === 0);
}

function available(q: SegmentQuote, seats: SeatType[], passengers = 1): SeatType[] {
  return q.canBuy ? seats.filter(seat => inventoryValid(q.seats?.[seat]) && q.seats[seat].status === 'available'
    && (q.seats[seat].count === undefined ? passengers === 1 : q.seats[seat].count! >= passengers)) : [];
}

function routeError(route: TrainStop[], seed: SegmentQuote): string | null {
  if (!Array.isArray(route) || route.length < 2) return '完整停站表不可用';
  let priorIndex = -1;
  let priorTime = -Infinity;
  for (const stop of route) {
    if (!stop.station?.code || !Number.isInteger(stop.index) || stop.index <= priorIndex) return '停站序列无效';
    const times = [stop.arrivalIso, stop.departureIso].filter((x): x is string => x !== null);
    if (!times.length) return '停站日期时间缺失';
    for (const time of times) {
      const at = timestamp(time);
      if (!Number.isFinite(at) || at < priorTime) return '停站日期时间顺序不一致';
      priorTime = at;
    }
    priorIndex = stop.index;
  }
  if (!route[0].departureIso || railwayDate(route[0].departureIso) !== seed.train.serviceDate) return '始发运营日期与停站表不一致';
  if (!quoteFitsRoute(seed, route, seed.fromIndex, seed.toIndex)) return '查询区间与完整停站表不一致';
  return null;
}

function quoteFitsRoute(q: SegmentQuote, route: TrainStop[], fromIndex: number, toIndex: number): boolean {
  const from = route.find(stop => stop.index === fromIndex);
  const to = route.find(stop => stop.index === toIndex);
  return q.fromIndex === fromIndex && q.toIndex === toIndex
    && !!from && !!to && stationEqual(q.from, from.station) && stationEqual(q.to, to.station)
    && Number.isFinite(timestamp(from.departureIso)) && Number.isFinite(timestamp(to.arrivalIso))
    && timestamp(q.departureIso) === timestamp(from.departureIso)
    && timestamp(q.arrivalIso) === timestamp(to.arrivalIso);
}

function fallbackRoute(q: SegmentQuote): TrainStop[] {
  return [
    { station: q.from, index: q.fromIndex, arrivalIso: null, departureIso: q.departureIso },
    { station: q.to, index: q.toIndex, arrivalIso: q.arrivalIso, departureIso: null },
  ];
}

function leg(q: SegmentQuote, seat: SeatType): TicketLeg {
  return { from: q.from, to: q.to, seat, inventory: { ...q.seats[seat] }, departureIso: q.departureIso,
    arrivalIso: q.arrivalIso, fetchedAt: q.fetchedAt };
}

function makePlan(kind: PlanKind, seed: SegmentQuote, target: Station, rank: number,
  route: TrainStop[], quotes: SegmentQuote[], seats: SeatType[], shortEndIndex: number): TicketPlan {
  const legs = quotes.map((q, i) => leg(q, seats[i]));
  const fetched = legs.map(item => item.fetchedAt).sort((a, b) => timestamp(a) - timestamp(b));
  const knownPrice = legs.every(item => item.inventory.price !== null);
  const totalPrice = kind !== 'extension' && knownPrice
    ? Math.round(legs.reduce((sum, item) => sum + item.inventory.price!, 0) * 100) / 100 : null;
  const evidence = Array.from(new Set(quotes.map(q => q.train.relationEvidence).filter(Boolean)));
  return {
    id: [kind, seed.train.runId, seed.train.serviceDate, target.code,
      ...quotes.map((q, i) => `${q.fromIndex}-${q.toIndex}-${seats[i]}`)].map(encodeURIComponent).join(':'),
    kind, train: seed.train, origin: seed.from, target, destinationRank: rank,
    departureIso: seed.departureIso, arrivalIso: seed.arrivalIso, legs, route, shortEndIndex, totalPrice,
    uncovered: kind === 'extension' ? { from: quotes[0].to, to: target } : null,
    fetchedFrom: fetched[0], fetchedTo: fetched[fetched.length - 1],
    relationEvidence: evidence.join('；') || '同一列车标识、始发运营日期及完整停站序列核验',
    warning: kind === 'extension' ? EXTENSION_WARNING
      : kind === 'split' ? '两段需分别购买，可能需要换座；查询余票不会保留车票。'
        : kind === 'long' ? '票面到站在目的地之后，按实际购票区间计价；未乘区间不退票款。' : null,
  };
}

function comparePlans(a: TicketPlan, b: TicketPlan): number {
  return a.destinationRank - b.destinationRank || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || ((a.kind === 'split' || a.kind === 'extension') ? b.shortEndIndex - a.shortEndIndex : 0)
    || timestamp(a.departureIso) - timestamp(b.departureIso)
    || (a.totalPrice === null ? (b.totalPrice === null ? 0 : 1)
      : b.totalPrice === null ? -1 : a.totalPrice - b.totalPrice)
    || a.id.localeCompare(b.id, 'en');
}

function createContext(input: RailSearch, adapter: Adapter, hooks: RailHooks) {
  const limits=searchLimits(hooks.limits);
  const result: SearchResult = { plans: [], observations: [], complete: false, issues: [], completedAt: null };
  const queryCache = new Map<string, Promise<SegmentQuote[] | null>>();
  const stopCache = new Map<string, Promise<TrainStop[] | null>>();
  const planIds = new Map<string, number>();
  const observationIds = new Set<string>();
  let relevantRuns: Set<string> | null = null;
  let partial = false;
  let requests = 0;
  let resultBytes = 1_024;

  function issue(message: string, unknown = true, required = false) {
    if (unknown) partial = true;
    if (!result.issues.includes(message)) {
      if (result.issues.length < 100) result.issues.push(message);
      else if (required) result.issues[result.issues.length - 1] = message;
    }
  }
  function snapshot(): SearchResult {
    return { ...result, plans: [...result.plans].sort(comparePlans), observations: [...result.observations], issues: [...result.issues] };
  }
  async function cancelCheck() {
    if (await hooks.isCancelled?.()) throw new Cancelled();
  }
  async function progress(message: string) {
    await hooks.onProgress?.(snapshot(), message);
  }
  function add(plan: TicketPlan) {
    const existing = planIds.get(plan.id);
    const bytes = byteSize(plan);
    const previousBytes = existing === undefined ? 0 : byteSize(result.plans[existing]);
    if ((existing === undefined && result.plans.length >= limits.plans)
      || resultBytes + bytes - previousBytes > limits.resultBytes) {
      issue('结果已达到安全容量，保留已展示的方案；其余方案未展示，请缩小查询条件后重查。');
      return;
    }
    resultBytes += bytes - previousBytes;
    if (existing !== undefined) result.plans[existing] = plan;
    else { planIds.set(plan.id, result.plans.length); result.plans.push(plan); }
  }
  function restrictObservations(runs: Set<string>) {
    relevantRuns = runs;
    result.observations = result.observations.filter(q => {
      if (runs.has(q.train.runId)) return true;
      resultBytes -= byteSize(q); return false;
    });
  }
  function request() {
    if (requests >= limits.requests) throw new SearchStopped(`本次已达到 ${limits.requests} 次官方查询预算（含经停查询）；已确认的方案保留，其余区间尚未核验。`);
    requests++;
  }
  function checkInventory(q: SegmentQuote, seats = input.seats) {
    for (const seat of seats) {
      if (!inventoryValid(q.seats?.[seat]) || q.seats[seat].status === 'unknown') {
        issue(`${q.train.trainCode} ${q.from.name}→${q.to.name} ${seat}余票状态未知`);
      } else if ((input.passengerCount ?? 1) > 1 && q.seats[seat].status === 'available' && q.seats[seat].count === undefined) {
        issue(`${q.train.trainCode} ${q.from.name}→${q.to.name} ${seat}官网只显示“有”，未确认足够 ${input.passengerCount} 人同时购买`);
      }
    }
  }
  async function query(from: Station, to: Station, date: string): Promise<SegmentQuote[] | null> {
    await cancelCheck();
    const key = JSON.stringify([from.code, to.code, date]);
    if (!queryCache.has(key)) {
      queryCache.set(key, (async () => {
        let rows: SegmentQuote[];
        try {
          request();
          rows = await adapter.query(from, to, date);
          if (!Array.isArray(rows)) throw new Error('结果格式无效');
        } catch (error) {
          if (error instanceof SearchStopped) throw error;
          const stopped = accessStop(error);
          if (stopped) throw new SearchStopped(stopped);
          const alternatives = error instanceof Error && error.name === 'SourceError'
            ? (error as Error & { stationAlternatives?: StationAlternative[] }).stationAlternatives : undefined;
          if (Array.isArray(alternatives) && stationEqual(from, input.origin) && input.destinations.some(d => stationEqual(d, to))) {
            const known = result.stationAlternatives ||= [];
            for (const pair of alternatives) {
              if (pair.requestedFrom.code === from.code && pair.requestedTo.code === to.code && pair.date === date
                && known.length < 80 && !known.some(p => p.requestedFrom.code === from.code && p.requestedTo.code === to.code && p.from.code === pair.from.code && p.to.code === pair.to.code)) known.push(pair);
            }
          }
          const detail = error instanceof Error && error.name === 'SourceError' ? `：${error.message.slice(0, 500)}` : '';
          issue(`${from.name}→${to.name}（${date}）查询失败，余票未知${detail}`);
          await progress(`未能查询 ${from.name}→${to.name}`);
          return null;
        }
        const valid: SegmentQuote[] = [];
        for (const q of rows) {
          if (q?.source === '12306' && (!relevantRuns || relevantRuns.has(q.train.runId))) {
            const observationId = JSON.stringify(q);
            if (!observationIds.has(observationId)) {
              observationIds.add(observationId);
              const bytes = byteSize(q);
              if (result.observations.length < limits.observations && resultBytes + bytes <= limits.resultBytes) {
                resultBytes += bytes; result.observations.push(q);
              } else issue('区间记录已达到安全容量，部分明细未展示；已确认的方案保留，请缩小查询条件后重查。');
            }
          }
          const error = q ? quoteError(q, from, to, date) : '查询行无效';
          if (error) { issue(`${from.name}→${to.name}：${error}`); continue; }
          valid.push(q);
        }
        await progress(`已查询 ${from.name}→${to.name}（${date}）`);
        return valid;
      })());
    }
    return queryCache.get(key)!;
  }
  async function schedule(seed: SegmentQuote): Promise<TrainStop[] | null> {
    await cancelCheck();
    const key = identityKey(seed.train);
    if (!stopCache.has(key)) {
      stopCache.set(key, (async () => {
        try { request(); return await adapter.stops(seed); }
        catch (error) {
          if (error instanceof SearchStopped) throw error;
          const stopped = accessStop(error);
          if (stopped) throw new SearchStopped(stopped);
          const detail = error instanceof Error && error.name === 'SourceError' ? `：${error.message.slice(0, 500)}` : '';
          issue(`${seed.train.trainCode} 完整停站表查询失败${detail}`); return null;
        }
      })());
    }
    const route = await stopCache.get(key)!;
    if (!route) return null;
    const error = routeError(route, seed);
    if (error) { issue(`${seed.train.trainCode}：${error}`); return null; }
    return route;
  }
  async function segment(seed: SegmentQuote, route: TrainStop[], from: TrainStop, to: TrainStop): Promise<SegmentQuote | null> {
    if (!from.departureIso || !to.arrivalIso) {
      issue(`${seed.train.trainCode} ${from.station.name}→${to.station.name}停站日期时间缺失`);
      return null;
    }
    const rows = await query(from.station, to.station, railwayDate(from.departureIso));
    if (rows === null) return null;
    const matches = rows.filter(q => sameRun(seed.train, q.train) && quoteFitsRoute(q, route, from.index, to.index))
      .sort((a, b) => timestamp(b.fetchedAt) - timestamp(a.fetchedAt));
    if (!matches.length) {
      issue(`${seed.train.trainCode} ${from.station.name}→${to.station.name}未返回可核验的同班次结果，余票未知`);
      return null;
    }
    checkInventory(matches[0]);
    return matches[0];
  }
  function finish(cancelled = false) {
    for (const plan of result.plans) if (plan.warning === '购票区间已核验；完整经停路线正在查询。') {
      plan.warning = '仅已核验当前购票区间，完整停站表尚未查询。';
    }
    result.complete = !partial && !cancelled;
    result.completedAt = cancelled ? null : new Date().toISOString();
    return snapshot();
  }
  return { result, issue, add, restrictObservations, checkInventory, query, schedule, segment, cancelCheck, progress, finish, limits, remaining: () => limits.requests - requests };
}

function inputErrors(input: RailSearch): string[] {
  const errors: string[] = [];
  if (!input.origin?.code || !input.destinations?.length || input.destinations.some(d => !d.code || stationEqual(d, input.origin))) errors.push('请选择不同的有效起点与目的地');
  if (!validDate(input.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.earliestTime)) errors.push('乘车日期或最早出发时间无效');
  if (!input.trainTypes?.length || input.trainTypes.some(type => !['G', 'D', 'C'].includes(type))) errors.push('请选择有效的 G/D/C 车型');
  if (!input.seats?.length || input.seats.some(seat => !['business', 'first', 'second', 'standing'].includes(seat))) errors.push('请选择有效席别');
  if (input.passengerCount !== undefined && (!Number.isInteger(input.passengerCount) || input.passengerCount < 1 || input.passengerCount > 5)) errors.push('乘车人数应为 1 至 5 人');
  if (input.includeTransfer !== undefined && typeof input.includeTransfer !== 'boolean') errors.push('中转偏好无效');
  if (input.allowOvernightTransfer !== undefined && typeof input.allowOvernightTransfer !== 'boolean') errors.push('次日换乘偏好无效');
  if (input.minTransferMinutes !== undefined && (!Number.isInteger(input.minTransferMinutes) || input.minTransferMinutes < 20 || input.minTransferMinutes > 180)) errors.push('最短换乘等待应为 20 至 180 分钟');
  if (input.transferStations && (input.transferStations.length > 3 || new Set(input.transferStations.map(s => s.code)).size !== input.transferStations.length
    || input.transferStations.some(s => !/^[A-Z]{3}$/.test(s.code) || stationEqual(s,input.origin) || input.destinations.some(d => stationEqual(s,d))))) errors.push('请选择最多 3 个与起终点不同的实际中转站');
  return errors;
}

type SearchContext = ReturnType<typeof createContext>;
const nextDay = (date: string) => railwayDate(new Date(Date.parse(`${date}T12:00:00+08:00`)+86400_000).toISOString());
const trainTypeFits = (q:SegmentQuote,input:RailSearch) => input.trainTypes.includes(q.train.trainCode.slice(0,1) as 'G'|'D'|'C');

function transferPlan(input:RailSearch, first:SegmentQuote, second:SegmentQuote, seats:SeatType[], rank:number):TicketPlan {
  const firstLeg = {...leg(first,seats[0]),train:{...first.train},route:fallbackRoute(first)};
  const secondLeg = {...leg(second,seats[1]),train:{...second.train},route:fallbackRoute(second)};
  const waitMinutes = (timestamp(second.departureIso)-timestamp(first.arrivalIso))/60000;
  const fetched = [first.fetchedAt,second.fetchedAt].sort((a,b)=>timestamp(a)-timestamp(b));
  const known = firstLeg.inventory.price!==null && secondLeg.inventory.price!==null;
  return {
    id:['transfer',first.train.runId,second.train.runId,first.from.code,first.to.code,second.to.code,first.departureIso,second.departureIso,...seats].map(encodeURIComponent).join(':'),
    kind:'transfer',train:{...first.train},origin:first.from,target:second.to,destinationRank:rank,
    departureIso:first.departureIso,arrivalIso:second.arrivalIso,legs:[firstLeg,secondLeg],
    route:[{station:first.from,index:0,arrivalIso:null,departureIso:first.departureIso},
      {station:first.to,index:1,arrivalIso:first.arrivalIso,departureIso:second.departureIso},
      {station:second.to,index:2,arrivalIso:second.arrivalIso,departureIso:null}],
    shortEndIndex:1,totalPrice:known?Math.round((firstLeg.inventory.price!+secondLeg.inventory.price!)*100)/100:null,
    uncovered:null,fetchedFrom:fetched[0],fetchedTo:fetched[1],relationEvidence:'两趟列车分别由官方实际车站、内部车次、始发运行日和乘车日期核验；同站换乘，未核验完整经停',
    warning:'两张票需分别购买，余票不会保留；换乘等待不保证晚点时仍能接上。次日换乘需自行安排过夜，住宿等费用不含在票价中。',
    transfer:{station:first.to,waitMinutes,overnight:railwayDate(first.arrivalIso)!==railwayDate(second.departureIso),minMinutes:input.minTransferMinutes??45},
  };
}

async function searchTransfers(input:RailSearch,adapter:Adapter,ctx:SearchContext):Promise<void> {
  if (!input.includeTransfer) return;
  ctx.result.transferSearch={stations:[],checked:0,scope:'limited'};
  let used=0;
  const checked=new Set<string>();
  const query=async(from:Station,to:Station,date:string)=>{
    if (used>=24 || ctx.remaining()<=1) return null;
    used++;const rows=await ctx.query(from,to,date);
    if(rows!==null){checked.add(`${from.code}:${to.code}:${date}`);ctx.result.transferSearch!.checked=checked.size;}
    return rows;
  };
  for (let rank=0;rank<input.destinations.length;rank++) {
    const target=input.destinations[rank];
    let candidates:Station[];
    try { candidates=input.transferStations?.length ? input.transferStations : await adapter.transferStations?.(input.origin,target) || []; }
    catch(error) {ctx.issue(`至 ${target.name} 的中转候选未能取得：${error instanceof Error?error.message:'未知原因'}`);continue;}
    candidates=candidates.filter((s,i,all)=>/^[A-Z]{3}$/.test(s.code)&&s.name&&!stationEqual(s,input.origin)&&!stationEqual(s,target)&&all.findIndex(x=>stationEqual(x,s))===i).slice(0,input.transferStations?.length?3:4);
    if (!candidates.length) {ctx.issue(`至 ${target.name} 未取得自动中转候选，请在中转条件中指定实际换乘站；本次不能判断所有中转是否可达。`);continue;}
    for (const mid of candidates) {
      if (!ctx.result.transferSearch.stations.some(s=>stationEqual(s,mid))) ctx.result.transferSearch.stations.push(mid);
      if (used>=24 || ctx.remaining()<=1) {ctx.issue('中转核验已达到本次预算；保留已确认方案，其他候选尚未核验。');return;}
      await ctx.cancelCheck();
      const firstRows=await query(input.origin,mid,input.date);
      if (firstRows===null) continue;
      for (const q of firstRows.filter(q=>eligible(q,input))) ctx.checkInventory(q);
      const usable=firstRows.filter(q=>eligible(q,input)&&timestamp(q.arrivalIso)-timestamp(q.departureIso)<=48*3600_000&&available(q,input.seats,input.passengerCount).length);
      // Keep both earlier arrivals and lower official fares, without exploding seat combinations.
      const byArrival=[...usable].sort((a,b)=>timestamp(a.arrivalIso)-timestamp(b.arrivalIso));
      const fare=(q:SegmentQuote)=>Math.min(...available(q,input.seats,input.passengerCount).map(s=>q.seats[s].price??Infinity));
      const byFare=[...usable].sort((a,b)=>fare(a)-fare(b)||timestamp(a.arrivalIso)-timestamp(b.arrivalIso));
      const picked=[...new Map([...byArrival.slice(0,6),...byFare.slice(0,6)].map(q=>[identityKey(q.train)+q.departureIso,q])).values()];
      const dates=[...new Set(picked.flatMap(q=>input.allowOvernightTransfer===false?[railwayDate(q.arrivalIso)]:[railwayDate(q.arrivalIso),nextDay(railwayDate(q.arrivalIso))]))].sort().slice(0,4);
      const combined:TicketPlan[]=[];
      for (const date of dates) {
        if (used>=24 || ctx.remaining()<=1) {ctx.issue('中转部分日期尚未核验，已确认方案保留。');break;}
        const rows=await query(mid,target,date);
        if (rows===null) continue;
        for (const first of picked) for (const second of rows) {
          const wait=(timestamp(second.departureIso)-timestamp(first.arrivalIso))/60000;
          if (!trainTypeFits(second,input)||sameRun(first.train,second.train)||wait<(input.minTransferMinutes??45)||wait>960
            || timestamp(second.arrivalIso)-timestamp(first.departureIso)>48*3600_000
            || (input.allowOvernightTransfer===false&&railwayDate(first.arrivalIso)!==railwayDate(second.departureIso))) continue;
          ctx.checkInventory(second);
          const firstSeats=available(first,input.seats,input.passengerCount),secondSeats=available(second,input.seats,input.passengerCount);
          for (const a of firstSeats) for (const b of secondSeats) {
            if (input.sameSeatOnly && a!==b) continue;
            const p=transferPlan(input,first,second,[a,b],rank);
            if(combined.some(other=>dominates(other,p)))continue;
            for(let i=combined.length-1;i>=0;i--)if(dominates(p,combined[i]))combined.splice(i,1);
            combined.push(p);
            if(combined.length>100){combined.splice(0,combined.length,...recommendPlans(combined).slice(0,100));ctx.issue('中转组合已收敛到本次优选候选；其余席别或车次组合未展示。',false);}
          }
        }
        for(const p of recommendPlans(combined).slice(0,16))ctx.add(p);
        await ctx.progress(`已确认 ${mid.name} 中转的 ${date} 票段，继续比较候选`);
      }
      // Publish each candidate as soon as both independently verified tickets connect.
      const frontier=combined.filter(p=>!combined.some(other=>other!==p&&dominates(other,p)));
      for (const p of recommendPlans(frontier).slice(0,16)) ctx.add(p);
      await ctx.progress(`已核验 ${mid.name} 同站换乘，继续比较价格与用时`);
    }
  }
}

function transferStructureError(input:RailSearch,plan:TicketPlan):string|null {
  const [a,b]=plan.legs,transfer=plan.transfer;
  if (plan.kind!=='transfer'||plan.legs.length!==2||!a.train||!b?.train||!a.route||!b.route||!transfer||plan.uncovered) return '中转票段身份或接续关系缺失';
  const wait=(timestamp(b.departureIso)-timestamp(a.arrivalIso))/60000;
  if (sameRun(a.train,b.train)||!stationEqual(a.from,plan.origin)||!stationEqual(b.to,plan.target)||!stationEqual(a.to,b.from)||!stationEqual(a.to,transfer.station)
    || timestamp(a.departureIso)!==timestamp(plan.departureIso)||timestamp(b.arrivalIso)!==timestamp(plan.arrivalIso)
    || !sameRun(a.train,plan.train)||wait<(input.minTransferMinutes??45)||wait>960||transfer.waitMinutes!==wait
    || transfer.overnight!==(railwayDate(a.arrivalIso)!==railwayDate(b.departureIso))
    ||timestamp(b.arrivalIso)-timestamp(a.departureIso)>48*3600_000) return '中转车次、站点或等待时间不一致';
  if (!input.includeTransfer||!stationEqual(plan.origin,input.origin)||!input.destinations.some(d=>stationEqual(d,plan.target))||!eligible({train:a.train,departureIso:a.departureIso} as SegmentQuote,input)||!input.trainTypes.includes(b.train.trainCode.charAt(0) as 'G'|'D'|'C')
    ||(input.allowOvernightTransfer===false&&transfer.overnight)||input.transferStations?.length&&!input.transferStations.some(s=>stationEqual(s,transfer.station))) return '原中转方案不符合当前查询条件';
  return null;
}

async function recheckTransfer(input:RailSearch,plan:TicketPlan,ctx:SearchContext):Promise<SearchResult> {
  const error=transferStructureError(input,plan);
  if(error){ctx.issue(`原中转方案不可复核：${error}`);return ctx.finish();}
  const fresh:SegmentQuote[]=[];
  for(const item of plan.legs){
    await ctx.cancelCheck();
    const rows=await ctx.query(item.from,item.to,railwayDate(item.departureIso));
    const endpoints=item.route!;
    const quote=rows?.filter(q=>sameRun(item.train!,q.train)&&quoteFitsRoute(q,endpoints,endpoints[0].index,endpoints.at(-1)!.index)
      &&timestamp(q.departureIso)===timestamp(item.departureIso)&&timestamp(q.arrivalIso)===timestamp(item.arrivalIso))
      .sort((a,b)=>timestamp(b.fetchedAt)-timestamp(a.fetchedAt))[0];
    if(!quote){ctx.issue(`${item.train!.trainCode} ${item.from.name}→${item.to.name} 原班次和时刻未能复核，旧方案不再可买`);continue;}
    ctx.checkInventory(quote,[item.seat]);
    if(!input.seats.includes(item.seat)||!available(quote,[item.seat],input.passengerCount).length){ctx.issue(`${item.train!.trainCode} 所选席别当前不可售或人数不足，旧方案不再可买`,quote.seats[item.seat].status==='unknown');continue;}
    fresh.push(quote);
  }
  if(fresh.length===2&&(!input.sameSeatOnly||plan.legs[0].seat===plan.legs[1].seat)) ctx.add(transferPlan(input,fresh[0],fresh[1],plan.legs.map(l=>l.seat),plan.destinationRank));
  await ctx.cancelCheck();return ctx.finish();
}

function eligible(seed: SegmentQuote, input: RailSearch): boolean {
  const earliest = timestamp(`${input.date}T${input.earliestTime}:00+08:00`);
  return input.trainTypes.includes(seed.train.trainCode.slice(0, 1) as 'G' | 'D' | 'C')
    && railwayDate(seed.departureIso) === input.date && timestamp(seed.departureIso) >= earliest;
}

function planStructureError(plan: TicketPlan): string | null {
  if (!Object.hasOwn(KIND_ORDER, plan.kind) || plan.legs.length !== (plan.kind === 'split' ? 2 : 1)) return '票段数量无效';
  const first = plan.legs[0];
  const last = plan.legs[plan.legs.length - 1];
  if (!stationEqual(first.from, plan.origin) || timestamp(first.departureIso) !== timestamp(plan.departureIso)) return '第一段不从实际起点出发';
  const target = plan.route.find(stop => stationEqual(stop.station, plan.target) && timestamp(stop.arrivalIso) === timestamp(plan.arrivalIso));
  const starts = plan.legs.map(item => plan.route.find(stop => stationEqual(stop.station, item.from)
    && timestamp(stop.departureIso) === timestamp(item.departureIso)));
  const ends = plan.legs.map(item => plan.route.find(stop => stationEqual(stop.station, item.to)
    && timestamp(stop.arrivalIso) === timestamp(item.arrivalIso)));
  if (!target || starts.some(stop => !stop) || ends.some(stop => !stop)) return '票段停站或目的地关系缺失';
  if (starts.some((start, i) => start!.index >= ends[i]!.index) || target.index <= starts[0]!.index) return '票段方向无效';
  if (plan.kind === 'direct' || plan.kind === 'split') {
    if (!stationEqual(last.to, plan.target) || timestamp(last.arrivalIso) !== timestamp(plan.arrivalIso) || plan.uncovered !== null) return '票段未完整覆盖目的地';
  }
  if (plan.kind === 'split' && (!stationEqual(first.to, last.from) || ends[0]!.index !== starts[1]!.index
    || timestamp(first.arrivalIso) > timestamp(last.departureIso))) return '两段区间存在缺口或重叠';
  if (plan.kind === 'long' && (target.index >= ends[0]!.index || plan.uncovered !== null)) return '买长乘短票段未经过目的地';
  if (plan.kind === 'extension' && (ends[0]!.index >= target.index
    || !plan.uncovered || !stationEqual(plan.uncovered.from, first.to) || !stationEqual(plan.uncovered.to, plan.target))) return '短票及待补区间不连续';
  return null;
}

function suggestOrder(input: RailSearch, routes: TrainStop[][], hasIncompleteRoute: boolean): Station[] | undefined {
  const destinations = input.destinations.filter((d, i, all) => all.findIndex(item => item.code === d.code) === i);
  if (destinations.length < 2 || !routes.length || hasIncompleteRoute) return undefined;
  let consensus: string[] | null = null;
  for (const route of routes) {
    const origin = route.filter(stop => stationEqual(stop.station, input.origin));
    if (origin.length !== 1) return undefined;
    const stops = destinations.map(d => route.filter(stop => stationEqual(stop.station, d) && stop.index > origin[0].index));
    if (stops.some(list => list.length !== 1)) return undefined;
    const codes = stops.map(list => list[0]).sort((a, b) => b.index - a.index).map(stop => stop.station.code);
    if (consensus && codes.some((code, i) => code !== consensus![i])) return undefined;
    consensus = codes;
  }
  return consensus?.map(code => destinations.find(d => d.code === code)!);
}

export async function searchRail(input: RailSearch, adapter: Adapter, hooks: RailHooks = {}): Promise<SearchResult> {
  const ctx = createContext(input, adapter, hooks);
  const errors = inputErrors(input);
  if (errors.length) { errors.forEach(error => ctx.issue(error)); return ctx.finish(); }
  const routes: TrainStop[][] = [];
  const expandedRuns = new Set<string>();
  let incompleteRoute = false;
  try {
    const destinations = input.destinations.filter((d, i, all) => all.findIndex(item => item.code === d.code) === i);
    const targets: { target: Station; rank: number; seeds: SegmentQuote[] }[] = [];
    // Publish direct inventory for every destination before expanding any train.
    // Full-route verification replaces these provisional route details below.
    for (let rank = 0; rank < destinations.length; rank++) {
      const target = destinations[rank];
      const rows = await ctx.query(input.origin, target, input.date);
      if (rows === null) { incompleteRoute = true; continue; }
      const seeds = rows.filter(q => eligible(q, input)).sort((a, b) => timestamp(b.fetchedAt) - timestamp(a.fetchedAt));
      if (!seeds.length) {
        incompleteRoute = true;
        ctx.issue(`${input.origin.name}→${target.name}：本次官方响应没有 ${input.earliestTime} 后符合 ${input.trainTypes.join('/')} 条件的直达班次。${input.includeTransfer ? '中转仍会独立核验；无直达不代表无法到达。' : '可调整车站、日期或最早出发时间。'}`, false);
      }
      targets.push({ target, rank, seeds });
      for (const seed of seeds) {
        ctx.checkInventory(seed);
        for (const seat of available(seed, input.seats, input.passengerCount)) {
          const plan = makePlan('direct', seed, target, rank, fallbackRoute(seed), [seed], [seat], seed.toIndex);
          plan.warning = '购票区间已核验；完整经停路线正在查询。';
          plan.relationEvidence = '官方单区间查询结果';
          ctx.add(plan);
        }
      }
      await ctx.progress(`已取得至 ${target.name} 的直达余票与候补状态，继续核验同车路线`);
    }
    await searchTransfers(input,adapter,ctx);
    ctx.restrictObservations(new Set([...targets.flatMap(item => item.seeds.map(q => q.train.runId)),...ctx.result.plans.flatMap(p=>p.legs.map(l=>l.train?.runId||p.train.runId))]));
    for (const { target, rank, seeds } of targets) {
      const visited = new Set<string>();
      for (const seed of seeds) {
        await ctx.cancelCheck();
        const key = identityKey(seed.train);
        if (visited.has(key)) continue;
        visited.add(key);
        if (!expandedRuns.has(key) && expandedRuns.size >= ctx.limits.expandedRuns) {
          incompleteRoute = true;
          ctx.issue(`本次仅扩展前 ${ctx.limits.expandedRuns} 个班次的同车方案；其余班次保留直达结果，衔接与买长区间尚未核验。`);
          continue;
        }
        expandedRuns.add(key);
        const route = await ctx.schedule(seed);
        if (route) routes.push(route); else incompleteRoute = true;
        for (const seat of available(seed, input.seats, input.passengerCount)) {
          const plan = makePlan('direct', seed, target, rank, route || fallbackRoute(seed), [seed], [seat], seed.toIndex);
          if (!route) { plan.warning = '仅已核验当前购票区间，完整停站表未能取得。'; plan.relationEvidence = '官方单区间查询结果'; }
          ctx.add(plan);
        }
        if (!route) continue;
        const originStop = route.find(stop => stop.index === seed.fromIndex)!;
        const targetStop = route.find(stop => stop.index === seed.toIndex)!;
        const allMids = route.filter(stop => stop.index > originStop.index && stop.index < targetStop.index);
        const mids = splitCandidates(allMids,ctx.limits.splitStops);
        if (mids.length < allMids.length) ctx.issue(`${seed.train.trainCode} 至 ${target.name} 本次优先核验 ${mids.length} 个衔接站（共 ${allMids.length} 个），其余衔接区间尚未核验。`);
        for (const mid of mids) {
          await ctx.cancelCheck();
          const first = await ctx.segment(seed, route, originStop, mid);
          if (!first) continue;
          const firstSeats = available(first, input.seats, input.passengerCount);
          if (!firstSeats.length) continue;
          // A verified short interval survives even when the second query is blocked.
          if (input.includeExtension) for (const seat of firstSeats) {
            ctx.add(makePlan('extension', seed, target, rank, route, [first], [seat], mid.index));
          }
          if (input.includeExtension) await ctx.progress(`已确认 ${seed.train.trainCode} 至 ${mid.station.name} 的短票，继续核验后段`);
          const second = await ctx.segment(seed, route, mid, targetStop);
          if (second) {
            for (const firstSeat of firstSeats) for (const secondSeat of available(second, input.seats, input.passengerCount)) {
              if (input.sameSeatOnly && firstSeat !== secondSeat) continue;
              ctx.add(makePlan('split', seed, target, rank, route, [first, second], [firstSeat, secondSeat], mid.index));
            }
          }
        }
        const allLong = route.filter(stop => stop.index > targetStop.index);
        const longerEnds = longCandidates(allLong,ctx.limits.longStops);
        if (input.includeLongTicket && longerEnds.length < allLong.length) ctx.issue(`${seed.train.trainCode} 至 ${target.name} 本次优先核验 ${longerEnds.length} 个买长到站（共 ${allLong.length} 个），其余买长区间尚未核验。`);
        if (input.includeLongTicket) for (const end of longerEnds) {
          const longer = await ctx.segment(seed, route, originStop, end);
          if (longer) for (const seat of available(longer, input.seats, input.passengerCount)) {
            ctx.add(makePlan('long', seed, target, rank, route, [longer], [seat], end.index));
          }
        }
        await ctx.progress(`已分析 ${seed.train.trainCode} 至 ${target.name} 的同车方案`);
      }
    }
    ctx.result.suggestedDestinations = suggestOrder(input, routes, incompleteRoute);
    await ctx.cancelCheck();
    return ctx.finish();
  } catch (error) {
    if (error instanceof SearchStopped) { ctx.issue(error.message, true, true); return ctx.finish(); }
    if (!(error instanceof Cancelled)) throw error;
    ctx.issue('查询已取消', true, true);
    return ctx.finish(true);
  }
}

export async function recheckRail(input: RailSearch, plan: TicketPlan, adapter: Adapter, hooks: RailHooks = {}): Promise<SearchResult> {
  const ctx = createContext(input, adapter, hooks);
  const errors = inputErrors(input);
  if (errors.length) { errors.forEach(error => ctx.issue(error)); return ctx.finish(); }
  if (plan.kind === 'transfer') {
    try { return await recheckTransfer(input,plan,ctx); }
    catch(error) { if(error instanceof SearchStopped) {ctx.issue(error.message,true,true);return ctx.finish();} if(error instanceof Cancelled) {ctx.issue('查询已取消',true,true);return ctx.finish(true);} throw error; }
  }
  const structureError = planStructureError(plan);
  if (structureError) { ctx.issue(`原方案不可复核：${structureError}`); return ctx.finish(); }
  ctx.restrictObservations(new Set([plan.train.runId]));
  if (!stationEqual(plan.origin, input.origin) || !input.destinations.some(d => stationEqual(d, plan.target))
    || !eligible({ train: plan.train, departureIso: plan.departureIso } as SegmentQuote, input)
    || plan.legs.some(item => !input.seats.includes(item.seat))
    || (input.sameSeatOnly && plan.legs.some(item => item.seat !== plan.legs[0].seat))
    || (plan.kind === 'long' && !input.includeLongTicket) || (plan.kind === 'extension' && !input.includeExtension)) {
    ctx.issue('原方案不符合当前查询条件', false);
    return ctx.finish();
  }
  try {
    const refreshed: SegmentQuote[] = [];
    let route: TrainStop[] | null = null;
    let lost = false;
    for (const item of plan.legs) {
      await ctx.cancelCheck();
      const rows = await ctx.query(item.from, item.to, railwayDate(item.departureIso));
      if (rows === null) { lost = true; continue; }
      const expectedFrom = plan.route.find(stop => stationEqual(stop.station, item.from) && timestamp(stop.departureIso) === timestamp(item.departureIso));
      const expectedTo = plan.route.find(stop => stationEqual(stop.station, item.to) && timestamp(stop.arrivalIso) === timestamp(item.arrivalIso));
      const quote = rows.filter(q => sameRun(plan.train, q.train)
        && !!expectedFrom && !!expectedTo && quoteFitsRoute(q, plan.route, expectedFrom.index, expectedTo.index))
        .sort((a, b) => timestamp(b.fetchedAt) - timestamp(a.fetchedAt))[0];
      if (!quote) { ctx.issue(`${item.from.name}→${item.to.name}原班次关系未能复核，余票未知`); lost = true; continue; }
      ctx.checkInventory(quote, [item.seat]);
      if (!available(quote, [item.seat], input.passengerCount).length) {
        const inventory = quote.seats[item.seat];
        const unknown = !inventoryValid(inventory) || inventory.status === 'unknown'
          || ((input.passengerCount ?? 1) > 1 && inventory.status === 'available' && inventory.count === undefined);
        ctx.issue(`${item.from.name}→${item.to.name}所选席别${unknown ? '状态或人数余量未知' : inventory.status === 'available' ? '张数不足所选人数' : '当前不可售'}`, unknown);
        lost = true;
      }
      refreshed.push(quote);
      if (!route) route = await ctx.schedule(quote);
    }
    if (!lost && refreshed.length === plan.legs.length) {
      // Alternatives require the refreshed complete route; a truthful direct quote can survive a schedule outage.
      if (!route && plan.kind !== 'direct') ctx.issue('完整停站关系未能复核，原方案暂不可确认');
      else {
        const target = route?.find(stop => stationEqual(stop.station, plan.target) && timestamp(stop.arrivalIso) === timestamp(plan.arrivalIso));
        const from = route?.find(stop => stationEqual(stop.station, plan.origin) && timestamp(stop.departureIso) === timestamp(plan.departureIso));
        if (route && (!target || !from || target.index <= from.index
          || refreshed.some(q => !quoteFitsRoute(q, route!, q.fromIndex, q.toIndex)))) ctx.issue('目的地或票段与原方案的停站关系已变化');
        else {
          const seed: SegmentQuote = { ...refreshed[0], from: plan.origin, to: plan.target,
            fromIndex: from?.index ?? refreshed[0].fromIndex, toIndex: target?.index ?? refreshed[0].toIndex,
            departureIso: plan.departureIso, arrivalIso: plan.arrivalIso };
          const updated = makePlan(plan.kind, seed, plan.target, plan.destinationRank, route || fallbackRoute(refreshed[0]),
            refreshed, plan.legs.map(item => item.seat), plan.shortEndIndex);
          if (!route) { updated.warning = '仅已核验当前购票区间，完整停站表未能取得。'; updated.relationEvidence = '官方单区间查询结果'; }
          const updatedError = planStructureError(updated);
          if (updatedError) ctx.issue(`原方案不可确认：${updatedError}`);
          else ctx.add(updated);
        }
      }
    }
    await ctx.cancelCheck();
    return ctx.finish();
  } catch (error) {
    if (error instanceof SearchStopped) { ctx.issue(error.message, true, true); return ctx.finish(); }
    if (!(error instanceof Cancelled)) throw error;
    ctx.issue('查询已取消', true, true);
    return ctx.finish(true);
  }
}
