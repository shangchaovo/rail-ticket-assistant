import test from 'node:test';
import assert from 'node:assert/strict';
import type { Adapter, RailSearch, SeatType, SegmentQuote, Station, TrainIdentity, TrainStop } from '../lib/rail-types';

// Loading through a URL keeps the application's bundler configuration free of Node-only import options.
const { searchRail, recheckRail }: typeof import('../lib/rail-planner') =
  await import(new URL('../lib/rail-planner.ts', import.meta.url).href);

const A: Station = { name: '甲站', code: 'AAA' };
const B: Station = { name: '乙站', code: 'BBB' };
const C: Station = { name: '丙站', code: 'CCC' };
const D: Station = { name: '丁站', code: 'DDD' };
const E: Station = { name: '戊站', code: 'EEE' };
const date = '2026-10-04';
const day = (time: string, dateValue = date) => `${dateValue}T${time}:00+08:00`;
const train: TrainIdentity = { trainNo: 'internal-1', trainCode: 'G123', serviceDate: date, runId: 'run-1-2026-10-04' };
const route: TrainStop[] = [
  { station: A, index: 1, arrivalIso: null, departureIso: day('08:00') },
  { station: B, index: 2, arrivalIso: day('08:29'), departureIso: day('08:30') },
  { station: C, index: 3, arrivalIso: day('08:59'), departureIso: day('09:00') },
  { station: D, index: 4, arrivalIso: day('09:29'), departureIso: day('09:30') },
  { station: E, index: 5, arrivalIso: day('10:00'), departureIso: null },
];

function quote(from: Station, to: Station, offered: Partial<Record<SeatType, number | null>> = {},
  options: Partial<SegmentQuote> = {}, schedule: TrainStop[] = route): SegmentQuote {
  const start = schedule.find(stop => stop.station.code === from.code)!;
  const end = schedule.find(stop => stop.station.code === to.code)!;
  const seats = Object.fromEntries(['business', 'first', 'second', 'standing'].map(seat => [seat,
    Object.hasOwn(offered, seat) ? { status: 'available', count: 1, price: offered[seat as SeatType] }
      : { status: 'sold_out', price: null }])) as SegmentQuote['seats'];
  return { train: { ...train }, from, to, fromIndex: start.index, toIndex: end.index,
    departureIso: start.departureIso!, arrivalIso: end.arrivalIso!, seats, canBuy: true,
    fetchedAt: day('07:30'), source: '12306', ...options };
}

function search(options: Partial<RailSearch> = {}): RailSearch {
  return { origin: A, destinations: [D], date, earliestTime: '08:00', trainTypes: ['G', 'D', 'C'],
    seats: ['second', 'standing'], includeLongTicket: true, includeExtension: true, ...options };
}

function fixture(rows: SegmentQuote[], schedules: Map<string, TrainStop[]> = new Map(), failKeys: string[] = []) {
  const calls: string[] = [];
  const stopCalls: string[] = [];
  const adapter: Adapter = {
    async query(from, to, requestedDate) {
      const key = `${from.code}-${to.code}-${requestedDate}`;
      calls.push(key);
      if (failKeys.includes(key)) throw new Error('page unavailable');
      return rows.filter(q => q.from.code === from.code && q.to.code === to.code
        && new Date(Date.parse(q.departureIso) + 8 * 3600_000).toISOString().slice(0, 10) === requestedDate);
    },
    async stops(seed) {
      stopCalls.push(seed.train.runId);
      return schedules.get(seed.train.runId) || route;
    },
  };
  return { adapter, calls, stopCalls };
}

function soldRows() {
  return [quote(A, D), quote(A, C), quote(A, B), quote(A, E)];
}
test('其他车站只产生重新查询建议，所选区间保持未知而非可售或无票', async () => {
  const pair={requestedFrom:A,requestedTo:D,from:B,to:E,date,fetchedAt:day('07:30')};
  const error=Object.assign(new Error('只返回同城其他站'),{name:'SourceError',stationAlternatives:[pair]});
  const result=await searchRail(search(),{query:async()=>{throw error;},stops:async()=>{throw new Error('must not request stops');}});
  assert.deepEqual(result.stationAlternatives,[pair]);assert.equal(result.complete,false);
  assert.deepEqual(result.plans,[]);assert.deepEqual(result.observations,[]);assert.match(result.issues[0],/余票未知/);
});
test('正常响应中的班次都早于所选时间时，显示条件原因而不是连接错误', async () => {
  const result=await searchRail(search({earliestTime:'23:00'}),fixture([quote(A,D,{second:50})]).adapter);
  assert.equal(result.complete,true);assert.deepEqual(result.plans,[]);assert.match(result.issues[0],/23:00 后/);
});

test('real quotes generate two continuous tickets, mixed selected seats, longer tickets and short-ticket candidates', async () => {
  const fx = fixture([
    quote(A, D), quote(A, C, { second: 30 }), quote(C, D, { standing: 10 }),
    quote(A, B, { standing: 20 }), quote(B, D, { second: 25 }), quote(A, E, { second: 65 }),
  ]);
  const result = await searchRail(search(), fx.adapter);
  assert.equal(result.complete, true);
  assert.deepEqual(result.plans.map(p => p.kind), ['split', 'split', 'long', 'extension', 'extension']);
  assert.deepEqual(result.plans[0].legs.map(l => l.seat), ['second', 'standing']);
  assert.equal(result.plans[0].totalPrice, 40);
  assert.equal(result.plans[0].legs[0].to.code, result.plans[0].legs[1].from.code);
  assert.equal(result.plans[0].shortEndIndex, 3);
  assert.equal(result.plans[1].shortEndIndex, 2);
  const longer = result.plans.find(p => p.kind === 'long')!;
  assert.equal(longer.target.code, D.code);
  assert.equal(longer.legs[0].to.code, E.code);
  assert.equal(longer.arrivalIso, day('09:29'));
  assert.equal(longer.totalPrice, 65);
  const extension = result.plans.find(p => p.kind === 'extension')!;
  assert.deepEqual(extension.uncovered, { from: C, to: D });
  assert.equal(extension.totalPrice, null);
  assert.match(extension.warning!, /无法办理时须在短票到站下车/);
  assert.equal(result.observations.length, 6);
  assert.equal(new Set(fx.calls).size, fx.calls.length);
});

test('a target query returns all trains; interval queries are cached across trains and destinations', async () => {
  const t2 = { ...train, trainNo: 'internal-2', trainCode: 'D456', runId: 'run-2' };
  const rows = soldRows();
  rows[0] = quote(A, D, { second: 40 });
  rows[1] = quote(A, C, { second: 30 });
  const fx = fixture([...rows, ...rows.map(q => ({ ...q, train: t2 }))]);
  const result = await searchRail(search({ destinations: [D, C] }), fx.adapter);
  assert.equal(result.plans.filter(p => p.kind === 'direct').length, 4);
  assert.equal(fx.calls.filter(key => key === `AAA-DDD-${date}`).length, 1);
  assert.equal(fx.calls.filter(key => key === `AAA-CCC-${date}`).length, 1);
  assert.equal(fx.stopCalls.length, 2);
  assert.deepEqual(result.suggestedDestinations?.map(s => s.code), ['DDD', 'CCC']);
  assert.ok(result.plans.slice(0, 2).every(p => p.destinationRank === 0));
});

test('filters exclude early trains, unselected train types and unselected seats without fabricating availability', async () => {
  const rows = [
    quote(A, D, { business: 200, second: 50 }),
    quote(A, D, { second: 30 }, { train: { ...train, trainCode: 'K111', runId: 'ordinary' } }),
    quote(A, D, { second: 30 }, { train: { ...train, runId: 'early' }, departureIso: day('07:59') }),
    quote(A, C), quote(A, B), quote(A, E),
  ];
  const result = await searchRail(search({ seats: ['second'], trainTypes: ['G'] }), fixture(rows).adapter);
  assert.equal(result.complete, true);
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].legs[0].seat, 'second');
  assert.equal(result.observations.length, 4);
  assert.ok(result.observations.every(q => q.train.runId === train.runId));
});

test('all destinations publish direct inventory before route expansion, then replace provisional routes', async () => {
  const fx = fixture([quote(A, D, {second: 40}), quote(A, C, {second: 30}), quote(A, B), quote(A, E), quote(C, D)]);
  let earlyDirect = false;
  const result = await searchRail(search({destinations: [D, C]}), fx.adapter, {onProgress: snapshot => {
    if (snapshot.plans.filter(p => p.kind === 'direct').length === 2 && fx.stopCalls.length === 0) earlyDirect = true;
  }});
  assert.equal(earlyDirect, true);
  assert.equal(result.complete, true);
  const direct = result.plans.filter(p => p.kind === 'direct');
  assert.equal(direct.length, 2);
  assert.ok(direct.every(p => p.route.length === route.length && p.warning === null));
});

test('the same display number on another service day cannot complete a split ticket', async () => {
  const otherDay = { ...train, serviceDate: '2026-10-03' };
  const fx = fixture([quote(A, D), quote(A, C, { second: 30 }),
    quote(C, D, { second: 10 }, { train: otherDay }), quote(A, B), quote(A, E)]);
  const result = await searchRail(search(), fx.adapter);
  assert.equal(result.complete, false);
  assert.equal(result.plans.filter(p => p.kind === 'split').length, 0);
  assert.equal(result.plans.filter(p => p.kind === 'extension').length, 1);
  assert.ok(result.issues.some(issue => issue.includes('同班次')));
});

test('the same display number with a different run id is not the same physical train', async () => {
  const fx = fixture([quote(A, D), quote(A, C, { second: 30 }),
    quote(C, D, { second: 10 }, { train: { ...train, runId: 'other-run' } }), quote(A, B), quote(A, E)]);
  const result = await searchRail(search(), fx.adapter);
  assert.equal(result.plans.some(p => p.kind === 'split'), false);
  assert.equal(result.complete, false);
});

test('official aliases require explicit identical adapter evidence and never bridge service dates', async () => {
  const evidence = 'official identity link: internal-1/internal-alias on service 2026-10-04';
  const seed = quote(A, D, {}, { train: { ...train, relationEvidence: evidence } });
  const first = quote(A, C, { second: 30 }, { train: { ...train, relationEvidence: evidence } });
  const alias = quote(C, D, { standing: 10 }, { train: { ...train, trainNo: 'internal-alias', trainCode: 'G124', relationEvidence: evidence } });
  const result = await searchRail(search(), fixture([seed, first, alias, quote(A, B), quote(A, E)]).adapter);
  assert.equal(result.complete, true);
  assert.equal(result.plans.filter(p => p.kind === 'split').length, 1);
  alias.train = { ...alias.train, relationEvidence: undefined };
  const rejected = await searchRail(search(), fixture([seed, first, alias, quote(A, B), quote(A, E)]).adapter);
  assert.equal(rejected.plans.some(p => p.kind === 'split'), false);
});

test('midnight segments are queried on their boarding day while retaining the same service identity', async () => {
  const next = '2026-10-05';
  const midnight: TrainStop[] = [
    { station: A, index: 1, arrivalIso: null, departureIso: day('23:20') },
    { station: C, index: 2, arrivalIso: day('00:29', next), departureIso: day('00:30', next) },
    { station: D, index: 3, arrivalIso: day('01:00', next), departureIso: null },
  ];
  const fx = fixture([quote(A, D, {}, {}, midnight), quote(A, C, { second: 20 }, {}, midnight),
    quote(C, D, { standing: 10 }, {}, midnight)], new Map([[train.runId, midnight]]));
  const result = await searchRail(search({ earliestTime: '23:00', includeLongTicket: false }), fx.adapter);
  assert.equal(result.complete, true);
  assert.equal(result.plans.filter(p => p.kind === 'split').length, 1);
  assert.ok(fx.calls.includes('CCC-DDD-2026-10-05'));
  assert.ok(!fx.calls.includes('CCC-DDD-2026-10-04'));
});

test('a next-day boarding date does not change the train origin service date', async () => {
  const next = '2026-10-05';
  const overnight: TrainStop[] = [
    { station: A, index: 1, arrivalIso: null, departureIso: day('23:00') },
    { station: B, index: 2, arrivalIso: day('00:09', next), departureIso: day('00:10', next) },
    { station: C, index: 3, arrivalIso: day('00:29', next), departureIso: day('00:30', next) },
    { station: D, index: 4, arrivalIso: day('01:00', next), departureIso: null },
  ];
  const fx = fixture([quote(B, D, {}, {}, overnight), quote(B, C, { second: 20 }, {}, overnight),
    quote(C, D, { standing: 10 }, {}, overnight)], new Map([[train.runId, overnight]]));
  const result = await searchRail(search({ origin: B, date: next, earliestTime: '00:00', includeLongTicket: false }), fx.adapter);
  assert.equal(result.complete, true);
  assert.equal(result.plans.find(p => p.kind === 'split')?.train.serviceDate, date);
});

test('query failure and a missing known train are unknown, not sold out', async () => {
  const fx = fixture([quote(A, D), quote(A, C, { second: 30 }), quote(A, E)], new Map(), [`AAA-BBB-${date}`]);
  const result = await searchRail(search(), fx.adapter);
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.includes('查询失败')));
  assert.ok(result.issues.some(issue => issue.includes('同班次')));
  assert.equal(result.observations.some(q => q.from.code === C.code), false);
  assert.equal(result.plans.filter(p => p.kind === 'extension').length, 1);
});

test('unknown selected inventory makes the query partial while known unavailable states do not', async () => {
  const bad = quote(A, D, { second: 40 });
  bad.seats.standing.status = 'unknown';
  const partial = await searchRail(search(), fixture([bad, ...soldRows().slice(1)]).adapter);
  assert.equal(partial.complete, false);
  assert.equal(partial.plans.length, 1);
  const known = quote(A, D);
  known.seats.second.status = 'not_on_sale';
  known.seats.standing.status = 'waitlist';
  const complete = await searchRail(search(), fixture([known, ...soldRows().slice(1)]).adapter);
  assert.equal(complete.complete, true);
  assert.equal(complete.plans.length, 0);
});

test('long-ticket and extension toggles remove their candidates and disable longer interval queries', async () => {
  const fx = fixture([quote(A, D), quote(A, C, { second: 30 }), quote(C, D), quote(A, B), quote(A, E, { second: 65 })]);
  const result = await searchRail(search({ includeLongTicket: false, includeExtension: false }), fx.adapter);
  assert.equal(result.complete, true);
  assert.equal(result.plans.length, 0);
  assert.ok(!fx.calls.some(key => key.includes('EEE')));
});

test('prices are sums of actual leg prices; missing prices and supplements remain unknown', async () => {
  const fx = fixture([quote(A, D, { second: null }), quote(A, C, { second: null }), quote(C, D, { standing: 10 }), quote(A, B), quote(A, E)]);
  const result = await searchRail(search(), fx.adapter);
  assert.equal(result.complete, true);
  assert.ok(result.plans.length > 1);
  assert.ok(result.plans.every(p => p.totalPrice === null));
  assert.equal(result.plans.find(p => p.kind === 'split')!.legs[1].inventory.price, 10);
});

test('malformed or changed stop chronology prevents alternatives; truthful direct inventory survives as partial', async () => {
  const wrongRoute = route.map(stop => ({ ...stop }));
  wrongRoute[2].departureIso = day('08:00');
  const fx = fixture([quote(A, D, { second: 40 })], new Map([[train.runId, wrongRoute]]));
  const result = await searchRail(search(), fx.adapter);
  assert.equal(result.complete, false);
  assert.equal(result.plans.length, 1);
  assert.equal(result.plans[0].kind, 'direct');
  assert.equal(result.plans[0].route.length, 2);
  assert.equal(fx.calls.length, 1);
});

test('destination missing from a complete route produces no unsupported alternative', async () => {
  const fx = fixture([quote(A, D)], new Map([[train.runId, route.filter(stop => stop.station.code !== D.code)]]));
  const result = await searchRail(search(), fx.adapter);
  assert.equal(result.complete, false);
  assert.equal(result.plans.length, 0);
});

test('destination priority and reverse short-end order remain independent', async () => {
  const rows = [quote(A, D), quote(A, C, { second: 30 }), quote(C, D), quote(A, B, { standing: 20 }),
    quote(B, D), quote(B, C), quote(A, E)];
  const result = await searchRail(search({ destinations: [C, D] }), fixture(rows).adapter);
  assert.equal(result.complete, true);
  assert.deepEqual(result.suggestedDestinations?.map(s => s.code), [D.code, C.code]);
  const far = result.plans.filter(p => p.target.code === D.code && p.kind === 'extension');
  assert.deepEqual(far.map(p => p.shortEndIndex), [3, 2]);
  const ranks = result.plans.map(p => p.destinationRank);
  assert.deepEqual(ranks, [...ranks].sort());
});

test('different relative destination order or disjoint routes never yields a distance suggestion', async () => {
  const alternate = [route[0], { ...route[3], index: 2, arrivalIso: day('08:29'), departureIso: day('08:30') },
    { ...route[2], index: 3 }, route[4]];
  const t2 = { ...train, trainNo: 'internal-2', runId: 'alternate-run' };
  const rows = [quote(A, C), quote(A, D), quote(A, B), quote(A, E),
    quote(A, C, {}, { train: t2 }, alternate), quote(A, D, {}, { train: t2 }, alternate)];
  const fx = fixture(rows, new Map([[t2.runId, alternate]]));
  const result = await searchRail(search({ destinations: [D, C], includeLongTicket: false }), fx.adapter);
  assert.equal(result.suggestedDestinations, undefined);
});

test('recheck removes the complete split if either selected leg is no longer available and refreshes both legs', async () => {
  const rows = [quote(A, D), quote(A, C, { second: 30 }), quote(C, D, { standing: 10 }), quote(A, B), quote(A, E)];
  const initial = await searchRail(search(), fixture(rows).adapter);
  const plan = initial.plans.find(p => p.kind === 'split')!;
  const secondSold = quote(C, D);
  secondSold.fetchedAt = day('07:35');
  const fx = fixture([quote(A, C, { second: 30 }, { fetchedAt: day('07:34') }), secondSold]);
  const result = await recheckRail(search(), plan, fx.adapter);
  assert.equal(result.complete, true);
  assert.equal(result.plans.length, 0);
  assert.equal(result.observations.length, 2);
  assert.equal(fx.calls.length, 2);
  assert.ok(result.issues.some(issue => issue.includes('当前不可售')));
});

test('recheck retains the original selected seats and displays the actual capture span', async () => {
  const rows = [quote(A, D), quote(A, C, { second: 30 }), quote(C, D, { standing: 10 }), quote(A, B), quote(A, E)];
  const initial = await searchRail(search(), fixture(rows).adapter);
  const plan = initial.plans.find(p => p.kind === 'split')!;
  const fx = fixture([quote(A, C, { second: 31, business: 200 }, { fetchedAt: day('07:35') }),
    quote(C, D, { standing: 11, second: 10 }, { fetchedAt: day('07:36') })]);
  const result = await recheckRail(search(), plan, fx.adapter);
  assert.equal(result.complete, true);
  assert.equal(result.plans.length, 1);
  assert.deepEqual(result.plans[0].legs.map(l => l.seat), ['second', 'standing']);
  assert.equal(result.plans[0].totalPrice, 42);
  assert.equal(result.plans[0].fetchedFrom, day('07:35'));
  assert.equal(result.plans[0].fetchedTo, day('07:36'));
});

test('recheck does not replace an unknown or failed original leg with a different available seat', async () => {
  const rows = [quote(A, D), quote(A, C, { second: 30 }), quote(C, D, { standing: 10 }), quote(A, B), quote(A, E)];
  const plan = (await searchRail(search(), fixture(rows).adapter)).plans.find(p => p.kind === 'split')!;
  const failed = fixture([quote(C, D, { standing: 10 })], new Map(), [`AAA-CCC-${date}`]);
  const result = await recheckRail(search(), plan, failed.adapter);
  assert.equal(result.complete, false);
  assert.equal(result.plans.length, 0);
  assert.equal(failed.calls.length, 2);
});

test('recheck rejects a forged gap between two otherwise valid ticket legs before querying', async () => {
  const rows = [quote(A, D), quote(A, C, { second: 30 }), quote(C, D, { standing: 10 }), quote(A, B), quote(A, E)];
  const plan = (await searchRail(search(), fixture(rows).adapter)).plans.find(p => p.kind === 'split')!;
  const forged = { ...plan, legs: [plan.legs[0], { ...plan.legs[1], from: B, departureIso: day('08:30') }] };
  const fx = fixture([quote(A, C, { second: 30 }), quote(B, D, { standing: 10 })]);
  const result = await recheckRail(search(), forged, fx.adapter);
  assert.equal(result.complete, false);
  assert.equal(result.plans.length, 0);
  assert.equal(fx.calls.length, 0);
  assert.ok(result.issues.some(issue => issue.includes('缺口或重叠')));
});

test('recheck verifies every refreshed leg against the refreshed schedule, including a changed intermediate departure', async () => {
  const rows = [quote(A, D), quote(A, C, { second: 30 }), quote(C, D, { standing: 10 }), quote(A, B), quote(A, E)];
  const plan = (await searchRail(search(), fixture(rows).adapter)).plans.find(p => p.kind === 'split')!;
  const changed = route.map(stop => stop.station.code === C.code ? { ...stop, departureIso: day('09:01') } : stop);
  const fx = fixture([quote(A, C, { second: 30 }), quote(C, D, { standing: 10 })], new Map([[train.runId, changed]]));
  const result = await recheckRail(search(), plan, fx.adapter);
  assert.equal(result.complete, false);
  assert.equal(result.plans.length, 0);
  assert.ok(result.issues.some(issue => issue.includes('停站关系已变化')));
});

test('long-ticket and extension rechecks retain their original covered and uncovered geometry', async () => {
  const rows = [quote(A, D), quote(A, C, { second: 30 }), quote(C, D), quote(A, B), quote(A, E, { second: 65 })];
  const initial = await searchRail(search(), fixture(rows).adapter);
  const longer = initial.plans.find(p => p.kind === 'long')!;
  const short = initial.plans.find(p => p.kind === 'extension')!;
  const checkedLong = await recheckRail(search(), longer, fixture([quote(A, E, { second: 66 })]).adapter);
  assert.equal(checkedLong.complete, true);
  assert.equal(checkedLong.plans[0].arrivalIso, day('09:29'));
  assert.equal(checkedLong.plans[0].totalPrice, 66);
  const checkedShort = await recheckRail(search(), short, fixture([quote(A, C, { second: 31 })]).adapter);
  assert.equal(checkedShort.complete, true);
  assert.deepEqual(checkedShort.plans[0].uncovered, { from: C, to: D });
  assert.equal(checkedShort.plans[0].totalPrice, null);
});

test('recheck completeness depends on its selected seat, not another unselected unknown seat', async () => {
  const initial = await searchRail(search(), fixture([quote(A, D, { second: 40 }), ...soldRows().slice(1)]).adapter);
  const direct = initial.plans.find(p => p.kind === 'direct')!;
  const refreshed = quote(A, D, { second: 41 });
  refreshed.seats.standing.status = 'unknown';
  const result = await recheckRail(search(), direct, fixture([refreshed]).adapter);
  assert.equal(result.complete, true);
  assert.equal(result.plans[0].totalPrice, 41);
});

test('cancellation returns collected evidence as partial and prevents additional interval queries', async () => {
  const fx = fixture(soldRows());
  const result = await searchRail(search(), fx.adapter, { isCancelled: async () => fx.calls.length >= 1 });
  assert.equal(result.complete, false);
  assert.equal(result.completedAt, null);
  assert.equal(result.observations.length, 1);
  assert.equal(fx.calls.length, 1);
  assert.match(result.issues.join(' '), /查询已取消/);
});

test('invalid input and contradictory zero inventory are not treated as valid available tickets', async () => {
  const fx = fixture(soldRows());
  const invalid = await searchRail(search({ date: '2026-02-31' }), fx.adapter);
  assert.equal(invalid.complete, false);
  assert.equal(fx.calls.length, 0);
  const contradictory = quote(A, D, { second: 40 });
  contradictory.seats.second.count = 0;
  const result = await searchRail(search(), fixture([contradictory, ...soldRows().slice(1)]).adapter);
  assert.equal(result.complete, false);
  assert.equal(result.plans.length, 0);
});

test('long routes inspect a small set of verified split and long endpoints instead of crawling every stop', async () => {
  const stops: TrainStop[] = Array.from({length: 40}, (_, index) => {
    const station = index === 0 ? A : index === 28 ? D : {name: `站${index}`, code: `S${String(index).padStart(2, '0')}`};
    const iso = new Date(Date.parse(day('08:00')) + index * 6 * 60_000).toISOString();
    return {station, index: index + 1, arrivalIso: index ? iso : null, departureIso: index === 39 ? null : iso};
  });
  const rows = [quote(A, D, {}, {}, stops),
    ...stops.slice(1).filter(s => s.station.code !== D.code).map(s => quote(A, s.station, {second: 20}, {}, stops)),
    ...stops.slice(1, 28).map(s => quote(s.station, D, {second: 20}, {}, stops))];
  const fx = fixture(rows, new Map([[train.runId, stops]]));
  const result = await searchRail(search({seats: ['second']}), fx.adapter);
  assert.equal(fx.calls.length, 12); // Direct, four pairs, and three longer endpoints.
  assert.equal(fx.stopCalls.length, 1);
  assert.equal(result.plans.filter(p => p.kind === 'split').length, 4);
  assert.equal(result.plans.filter(p => p.kind === 'long').length, 3);
  assert.ok(result.plans.some(p => p.kind === 'split' && p.shortEndIndex === 28));
  assert.deepEqual(result.plans.filter(p => p.kind === 'long').map(p => p.legs[0].to.code).sort(), ['S29', 'S30', 'S39']);
  assert.equal(result.complete, false);
  assert.match(result.issues.join(' '), /其余衔接区间尚未核验/);
  assert.match(result.issues.join(' '), /其余买长区间尚未核验/);
});

test('a global request budget includes schedules, preserves all direct inventory, and stops further requests', async () => {
  const rows: SegmentQuote[] = [];
  const schedules = new Map<string, TrainStop[]>();
  for (let i = 0; i < 10; i++) {
    const id = {...train, trainNo: `internal-${i}`, runId: `budget-run-${i}`, trainCode: `G${100 + i}`};
    const stations = [A, ...Array.from({length: 12}, (_, j) => ({name: `班次${i}站${j}`, code: `${i}${String(j).padStart(2, '0')}`})), D, E];
    const stops = stations.map((station, j) => {
      const iso = new Date(Date.parse(day('08:00')) + j * 10 * 60_000).toISOString();
      return {station, index: j + 1, arrivalIso: j ? iso : null, departureIso: j === stations.length - 1 ? null : iso};
    });
    schedules.set(id.runId, stops);
    rows.push(quote(A, D, {second: 40}, {train: id}, stops));
    for (const mid of stations.slice(1, -2)) rows.push(quote(A, mid, {second: 20}, {train: id}, stops), quote(mid, D, {second: 20}, {train: id}, stops));
    rows.push(quote(A, E, {second: 50}, {train: id}, stops));
  }
  const fx = fixture(rows, schedules);
  const result = await searchRail(search({seats: ['second']}), fx.adapter);
  assert.equal(fx.calls.length + fx.stopCalls.length, 60);
  assert.equal(result.plans.filter(p => p.kind === 'direct').length, 10);
  assert.equal(result.complete, false);
  assert.match(result.issues.join(' '), /60 次官方查询预算/);
  assert.ok(result.plans.every(p => !p.warning?.includes('正在查询')));
});

test('rate and verification blocks stop the whole task while retaining confirmed direct and short tickets', async () => {
  for (const code of ['rate', 'verify']) {
    const fx = fixture([quote(A, D, {second: 40}), quote(A, C, {second: 20}), quote(A, E, {second: 55})]);
    const realQuery = fx.adapter.query;
    fx.adapter.query = async (from, to, date) => {
      if (from.code === C.code) {fx.calls.push(`${from.code}-${to.code}-${date}`); throw Object.assign(new Error('blocked'), {name: 'SourceError', code});}
      return realQuery(from, to, date);
    };
    const result = await searchRail(search({seats: ['second']}), fx.adapter);
    assert.deepEqual(result.plans.map(p => p.kind), ['direct', 'extension']);
    assert.equal(fx.calls.length, 3);
    assert.equal(result.complete, false);
    assert.ok(result.completedAt);
    assert.match(result.issues.join(' '), code === 'rate' ? /已限流/ : /需要本人登录或完成验证码/);
    assert.ok(!fx.calls.some(key => key.includes('EEE')));
  }
});

test('a blocked schedule leaves direct evidence and prevents alternative queries', async () => {
  const fx = fixture([quote(A, D, {second: 40})]);
  fx.adapter.stops = async () => {throw Object.assign(new Error('HTTP 429'), {name: 'SourceError', code: 'rate'});};
  const result = await searchRail(search(), fx.adapter);
  assert.equal(fx.calls.length, 1);
  assert.equal(result.plans.length, 1);
  assert.match(result.issues.join(' '), /已限流/);
  assert.equal(result.complete, false);
});

test('party size requires enough official counted inventory on every leg; unspecified 有 is not enough for a group', async () => {
  const enough = quote(A, D, {second: 40}); enough.seats.second.count = 2;
  const limited = quote(A, C, {second: 20});
  const unknown = quote(A, B, {second: 10}); delete unknown.seats.second.count;
  const result = await searchRail(search({passengerCount: 2, seats: ['second']}), fixture([enough, limited, unknown, quote(A, E)]).adapter);
  assert.deepEqual(result.plans.map(p => p.kind), ['direct']);
  assert.equal(result.complete, false);
  assert.match(result.issues.join(' '), /未确认足够 2 人/);
  const direct = result.plans[0];
  const rechecked = await recheckRail(search({passengerCount: 2, seats: ['second']}), direct, fixture([quote(A, D, {second: 40})]).adapter);
  assert.deepEqual(rechecked.plans, []);
  assert.match(rechecked.issues.join(' '), /张数不足/);
});

test('same-seat searches and rechecks never accept mixed-seat split tickets', async () => {
  const fx = fixture([quote(A, D), quote(A, C, {second: 20}), quote(C, D, {standing: 10}), quote(A, B), quote(A, E)]);
  const original = await searchRail(search(), fx.adapter);
  const mixed = original.plans.find(p => p.kind === 'split')!;
  const filtered = await searchRail(search({sameSeatOnly: true}), fx.adapter);
  assert.ok(!filtered.plans.some(p => p.kind === 'split'));
  const checked = await recheckRail(search({sameSeatOnly: true}), mixed, fx.adapter);
  assert.deepEqual(checked.plans, []);
  assert.match(checked.issues.join(' '), /不符合当前查询条件/);
});

test('large direct responses remain below upload capacity and report omitted results', async () => {
  const rows = Array.from({length: 1_200}, (_, i) => quote(A, D, {business: 100, first: 60, second: 40, standing: 30},
    {train: {...train, trainCode: `G${i + 1}`, runId: `volume-${i}`, trainNo: `volume-${i}`}}));
  const result = await searchRail(search({seats: ['business', 'first', 'second', 'standing']}), fixture(rows).adapter);
  assert.ok(result.plans.length <= 240);
  assert.ok(result.observations.length <= 900);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength < 1_900_000);
  assert.equal(result.complete, false);
  assert.match(result.issues.join(' '), /安全容量/);
});

test('the explicit stop reason remains visible even after many unknown inventory issues', async () => {
  const rows = Array.from({length: 120}, (_, i) => {
    const row = quote(A, D, {}, {train:{...train, trainNo:`unknown-${i}`, runId:`unknown-${i}`, trainCode:`G${i + 1}`}});
    row.seats.second.status = 'unknown'; return row;
  });
  const fx = fixture(rows);
  fx.adapter.stops = async () => {throw Object.assign(new Error('blocked'), {name:'SourceError', code:'rate'});};
  const result = await searchRail(search({seats:['second']}), fx.adapter);
  assert.equal(result.issues.length, 100);
  assert.match(result.issues.join(' '), /12306 已限流/);
});
