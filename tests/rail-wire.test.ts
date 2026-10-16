import {test} from 'node:test';
import assert from 'node:assert/strict';
import {packResult, unpackResult} from '../lib/rail-wire.ts';
import {helperUpdateSchema} from '../lib/rail-validation.ts';
import type {SearchResult, TicketPlan} from '../lib/rail-types';

const from = {name: '甲站', code: 'AAA'}, to = {name: '乙站', code: 'BBB'};
const departureIso = '2026-10-05T23:30:00+08:00', arrivalIso = '2026-10-06T01:30:00+08:00', fetchedAt = '2026-10-05T14:00:00Z';
const plan: TicketPlan = {
  id: 'direct-test', kind: 'direct', train: {trainCode: 'G1', trainNo: 'internal-1', runId: '2026-10-05:internal-1', serviceDate: '2026-10-05'},
  origin: from, target: to, destinationRank: 0, departureIso, arrivalIso,
  legs: [{from, to, seat: 'second', inventory: {status: 'available', count: 1, price: 100}, departureIso, arrivalIso, fetchedAt}],
  route: [{station: from, index: 1, arrivalIso: null, departureIso}, {station: to, index: 2, arrivalIso, departureIso: null}],
  shortEndIndex: 2, totalPrice: 100, uncovered: null, fetchedFrom: fetchedAt, fetchedTo: fetchedAt, relationEvidence: 'same official run', warning: null,
};
const result: SearchResult = {plans: Array.from({length: 100}, (_, i) => ({...plan, id: String(i)})), observations: [], complete: true, issues: [], completedAt: fetchedAt};
const update = (value: unknown) => ({leaseToken: 'synthetic-lease-token-long-enough', version: 7, status: 'complete', message: 'done', result: value});

test('shared routes round-trip without losing cross-midnight dates, inventories, prices or evidence', () => {
  const packed = packResult(result);
  assert.equal(packed.routes.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(JSON.stringify(result)));
  assert.deepEqual(unpackResult(packed), result);
  assert.deepEqual(unpackResult(result), result);
  assert.deepEqual(helperUpdateSchema.parse(update(packed)).result, result);
  assert.deepEqual(helperUpdateSchema.parse(update(result)).result, result);
});

test('invalid route references and unsellable legs are rejected in the packed protocol', () => {
  const packed = packResult(result);
  const badReference = {...packed, plans: [{...packed.plans[0], routeIndex: 99}]};
  assert.equal(helperUpdateSchema.safeParse(update(badReference)).success, false);
  assert.throws(() => unpackResult(badReference), /引用失效/);
  const unsellable = {...packed, plans: [{...packed.plans[0], legs: [{...plan.legs[0], inventory: {status: 'waitlist', price: 100}}]}]};
  assert.equal(helperUpdateSchema.safeParse(update(unsellable)).success, false);
});
