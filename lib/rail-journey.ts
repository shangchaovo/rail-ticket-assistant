import type { SegmentRole } from './rail-map';
import type { TicketPlan } from './rail-types';

export function completeJourney(plan: TicketPlan) {
  return plan.kind !== 'transfer' && plan.route.length >= 2 && Boolean(plan.relationEvidence) && plan.relationEvidence !== '官方单区间查询结果';
}

function tripOffsets(plan: TicketPlan) {
  const origin = plan.route.findIndex(stop => stop.station.code === plan.origin.code && Date.parse(stop.departureIso || '') === Date.parse(plan.departureIso));
  const target = plan.route.findIndex((stop, index) => index > origin && stop.station.code === plan.target.code && Date.parse(stop.arrivalIso || '') === Date.parse(plan.arrivalIso));
  return { origin, target };
}

export function journeyRange(plan: TicketPlan, scope: 'trip' | 'train') {
  if (scope === 'train') return { start: 0, end: plan.route.length - 1 };
  const { origin, target } = tripOffsets(plan);
  return { start: origin, end: Math.max(target, ticketOffsets(plan, plan.legs.length - 1).end) };
}

export function ticketOffsets(plan: TicketPlan, legIndex: number) {
  const leg = plan.legs[legIndex];
  if (!leg) return { start: -1, end: -1 };
  const start = plan.route.findIndex(stop => stop.station.code === leg.from.code &&
    Date.parse(stop.departureIso || '') === Date.parse(leg.departureIso));
  const end = start < 0 ? -1 : plan.route.findIndex((stop, index) => index > start && stop.station.code === leg.to.code &&
    Date.parse(stop.arrivalIso || '') === Date.parse(leg.arrivalIso));
  return { start, end };
}

export function journeySegment(plan: TicketPlan, offset: number) {
  const legIndex = plan.legs.findIndex((_, index) => {
    const { start, end } = ticketOffsets(plan, index);
    return start >= 0 && end > start && offset >= start && offset < end;
  });
  const { origin, target } = tripOffsets(plan), end = ticketOffsets(plan, plan.legs.length - 1).end;
  let role: SegmentRole = 'other';
  if (origin >= 0 && target > origin && offset >= origin && offset < Math.max(target, end)) {
    if (plan.kind === 'extension' && offset >= end && offset < target) role = 'uncovered';
    else if (plan.kind === 'long' && offset >= target && offset < end) role = 'extra';
    else if (legIndex >= 0 && offset < target) role = 'covered';
  }
  return { role, legIndex, leg: legIndex >= 0 ? plan.legs[legIndex] : null };
}

export function journeyStop(plan: TicketPlan, offset: number) {
  const stop = plan.route[offset];
  const arriving = plan.legs.findIndex((_, i) => ticketOffsets(plan, i).end === offset);
  const departing = plan.legs.findIndex((_, i) => ticketOffsets(plan, i).start === offset);
  const connecting = (plan.kind === 'split'||plan.kind==='transfer') && arriving >= 0 && departing > arriving;
  const { origin, target } = tripOffsets(plan);
  const role = offset === origin ? '上车' : offset === target ? '下车' : connecting ? (plan.kind==='transfer'?'中转 · 换乘另一趟车':'接续 · 可能换座')
    : plan.kind === 'extension' && arriving === 0 ? '短票到站 · 提前申请补票'
    : plan.kind === 'long' && arriving === plan.legs.length - 1 ? '票面到站' : '';
  const dwell = stop?.arrivalIso && stop.departureIso
    ? (Date.parse(stop.departureIso) - Date.parse(stop.arrivalIso)) / 60_000 : 0;
  return { role: stop ? role : '', arriving, departing, connecting,
    dwellMinutes: Number.isFinite(dwell) && dwell > 0 ? dwell : null };
}

export function stationSearchUrl(name: string) {
  const url = new URL('https://uri.amap.com/search');
  url.search = new URLSearchParams({ keyword: name.endsWith('站') ? name : `${name}火车站`, view: 'map', src: 'rail-same-train', callnative: '0' }).toString();
  return url.href;
}
