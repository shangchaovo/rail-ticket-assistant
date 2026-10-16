import test from 'node:test';
import assert from 'node:assert/strict';
import type { RailSearch, SegmentQuote, TicketPlan } from '../lib/rail-types';
import type { TripSortable } from '../lib/result-view';

const { collectWaitlist, sortTrips, tripMinutes }: typeof import('../lib/result-view') =
  await import(new URL('../lib/result-view.ts', import.meta.url).href);

const date = '2026-10-05';
const input: RailSearch = {
  origin: { name: '杭州东', code: 'HGH' },
  destinations: [{ name: '苍南', code: 'CEH' }, { name: '温州南', code: 'VRH' }],
  date, earliestTime: '11:30', trainTypes: ['G', 'D', 'C'], seats: ['second'],
  includeLongTicket: true, includeExtension: true,
};

function seats(second: SegmentQuote['seats']['second']['status'], price: number | null = 120): SegmentQuote['seats'] {
  const blank = { status: 'unsupported' as const, price: null };
  return { business: blank, first: blank, second: { status: second, count: second === 'available' ? 2 : undefined, price }, standing: blank };
}

function quote(partial: Partial<SegmentQuote> & Pick<SegmentQuote, 'train' | 'from' | 'to' | 'departureIso' | 'arrivalIso'>): SegmentQuote {
  return {
    fromIndex: 1, toIndex: 3, canBuy: true, seats: seats('waitlist'), fetchedAt: `${date}T04:00:00.000Z`, source: '12306', ...partial,
  };
}

const sortable = (recommendIndex: number, departure: string, arrival: string, price: number | null): TripSortable =>
  ({ recommendIndex, departureIso: `${date}T${departure}:00+08:00`, arrivalIso: `${date}T${arrival}:00+08:00`, price });

test('出发时间、用时和价格可以升降序，缺失价格始终排在后面', () => {
  const rows = [sortable(0, '18:00', '20:00', 200), sortable(1, '12:00', '15:00', null), sortable(2, '12:00', '13:00', 80)];
  assert.deepEqual(sortTrips(rows, 'departure', 'asc').map(row => row.recommendIndex), [1, 2, 0]);
  assert.deepEqual(sortTrips(rows, 'departure', 'desc').map(row => row.recommendIndex), [0, 1, 2]);
  assert.deepEqual(sortTrips(rows, 'duration', 'asc').map(row => row.recommendIndex), [2, 0, 1]);
  assert.equal(tripMinutes(rows[2].departureIso, rows[2].arrivalIso), 60);
  assert.deepEqual(sortTrips(rows, 'price', 'asc').map(row => row.recommendIndex), [2, 0, 1]);
  assert.deepEqual(sortTrips(rows, 'price', 'desc').map(row => row.recommendIndex), [0, 2, 1]);
  assert.deepEqual(sortTrips(rows, 'rank', 'asc').map(row => row.recommendIndex), [0, 1, 2]);
});

test('候补只保留直达且没有可买方案的车次', () => {
  const waitG = quote({
    train: { trainNo: 'g1', trainCode: 'G1', serviceDate: date, runId: 'run-g1' },
    from: input.origin, to: input.destinations[0], departureIso: `${date}T13:00:00+08:00`, arrivalIso: `${date}T16:00:00+08:00`,
    fetchedAt: `${date}T03:00:00.000Z`,
  });
  const newer = { ...waitG, fetchedAt: `${date}T05:00:00.000Z`, seats: seats('waitlist', 150) };
  const buyable = quote({
    train: { trainNo: 'g2', trainCode: 'G2', serviceDate: date, runId: 'run-g2' },
    from: input.origin, to: input.destinations[1], departureIso: `${date}T14:00:00+08:00`, arrivalIso: `${date}T17:00:00+08:00`,
    seats: seats('available', 90),
  });
  const early = quote({
    train: { trainNo: 'g3', trainCode: 'G3', serviceDate: date, runId: 'run-g3' },
    from: input.origin, to: input.destinations[0], departureIso: `${date}T08:00:00+08:00`, arrivalIso: `${date}T11:00:00+08:00`,
  });
  const intermediate = quote({
    train: { trainNo: 'g4', trainCode: 'G4', serviceDate: date, runId: 'run-g4' },
    from: { name: '丽水', code: 'USH' }, to: input.destinations[0], departureIso: `${date}T15:00:00+08:00`, arrivalIso: `${date}T16:00:00+08:00`,
  });
  const plan = { train: { runId: 'run-g2' }, target: input.destinations[1] } as TicketPlan;
  const rows = collectWaitlist([waitG, newer, buyable, early, intermediate], input, [plan]);
  assert.deepEqual(rows.map(row => row.trainCode), ['G1']);
  assert.equal(rows[0].price, 150);
  assert.equal(rows[0].destinationRank, 0);
  assert.deepEqual(rows[0].seats.map(seat => seat.seat), ['second']);
});
