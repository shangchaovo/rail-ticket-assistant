import test from 'node:test';
import assert from 'node:assert/strict';
import { completeJourney, journeyRange, journeySegment, journeyStop, stationSearchUrl, ticketOffsets } from '../lib/rail-journey.ts';
import { planPurchasePrice } from '../lib/result-view.ts';
import type { TicketPlan } from '../lib/rail-types';

function plan(kind: TicketPlan['kind']): TicketPlan {
  const route = ['甲', '乙', '丙', '丁', '戊', '己'].map((name, offset) => {
    const date = offset > 1 ? '2026-10-06' : '2026-10-05';
    const times = [['22:00', '22:02'], ['23:55', '23:57'], ['00:08', '00:10'], ['00:40', '00:42'], ['00:59', '01:01'], ['01:15', '01:15']][offset];
    return { station: { code: `S${offset}`, name }, index: offset + 17, arrivalIso: `${date}T${times[0]}:00+08:00`, departureIso: `${date}T${times[1]}:00+08:00` };
  });
  const leg = (from: number, to: number, first = false) => ({ from: route[from].station, to: route[to].station, departureIso: route[from].departureIso, arrivalIso: route[to].arrivalIso, seat: first ? 'first' : 'second', inventory: { status: 'available', count: 2, price: first ? 80 : 45 }, fetchedAt: '2026-10-05T15:00:00Z' } as TicketPlan['legs'][number]);
  return { kind, route, origin: route[1].station, target: route[4].station, departureIso: route[1].departureIso, arrivalIso: route[4].arrivalIso,
    legs: kind === 'split' ? [leg(1, 3), leg(3, 4, true)] : [leg(1, kind === 'extension' ? 3 : kind === 'long' ? 5 : 4)],
    uncovered: kind === 'extension' ? { from: route[3].station, to: route[4].station } : null,
    totalPrice: kind === 'extension' ? null : kind === 'split' ? 125 : 45, relationEvidence: '同一列车标识、始发运营日期及完整停站序列核验' } as TicketPlan;
}

test('两张票按实际时刻定位：第二段跨日，一等/二等分别覆盖且接续停留正确', () => {
  const p = plan('split');
  assert.deepEqual(ticketOffsets(p, 0), { start: 1, end: 3 });
  assert.deepEqual(ticketOffsets(p, 1), { start: 3, end: 4 });
  assert.equal(journeySegment(p, 2).leg?.seat, 'second');
  assert.equal(journeySegment(p, 3).leg?.seat, 'first');
  assert.deepEqual(journeyStop(p, 3), { role: '接续 · 可能换座', arriving: 0, departing: 1, connecting: true, dwellMinutes: 2 });
  assert.deepEqual(journeyRange(p, 'trip'), { start: 1, end: 4 });
});

test('短票的后续区间保持未覆盖，票面价格不包含未知补票金额', () => {
  const p = plan('extension');
  assert.equal(journeySegment(p, 2).role, 'covered');
  assert.equal(journeySegment(p, 3).role, 'uncovered');
  assert.equal(journeySegment(p, 3).leg, null);
  assert.match(journeyStop(p, 3).role, /短票到站/);
  assert.equal(planPurchasePrice(p), 45);
  assert.equal(p.totalPrice, null);
});

test('买长乘短明确下车站与票面终点，紫色只表示多买区间', () => {
  const p = plan('long');
  assert.deepEqual(journeyRange(p, 'trip'), { start: 1, end: 5 });
  assert.equal(journeyStop(p, 4).role, '下车');
  assert.equal(journeyStop(p, 5).role, '票面到站');
  assert.equal(journeySegment(p, 4).role, 'extra');
  assert.equal(journeySegment(p, 4).legIndex, 0);
});

test('只有区间两端的临时直达结果不能宣称完整经停，也不能借用另一日的票段', () => {
  const p = plan('direct'); p.relationEvidence = '官方单区间查询结果';
  p.route = [p.route[1], p.route[4]];
  assert.equal(completeJourney(p), false);
  assert.deepEqual(ticketOffsets(p, 0), { start: 0, end: 1 });
  p.legs[0].departureIso = p.legs[0].departureIso.replace('2026-10-05', '2026-10-04');
  assert.equal(journeySegment(p, 0).leg, null);
  assert.equal(journeySegment(p, 0).role, 'other');
});

test('同名车站重复出现时，按乘车时刻选中本次票段而不是第一次同名站', () => {
  const p = plan('direct'); p.route[0].station = p.origin;
  assert.deepEqual(journeyRange(p, 'trip'), { start: 1, end: 4 });
  assert.equal(journeyStop(p, 0).role, '');
  assert.equal(journeyStop(p, 1).role, '上车');
  assert.equal(journeySegment(p, 0).role, 'other');
});

test('高德入口仅传车站搜索词，编码站名且不传会话、坐标或未知线路', () => {
  const url = new URL(stationSearchUrl('杭州东'));
  assert.equal(url.origin, 'https://uri.amap.com');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('keyword'), '杭州东火车站');
  assert.equal(url.searchParams.get('center'), null);
  assert.equal(url.searchParams.get('callnative'), '0');
});
