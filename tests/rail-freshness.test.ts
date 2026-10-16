import test from 'node:test';
import assert from 'node:assert/strict';
import type { JobStatus, TicketPlan } from '../lib/rail-types';

const { currentInventory, currentPlan, INVENTORY_FRESH_MS }: typeof import('../lib/rail-freshness') =
  await import(new URL('../lib/rail-freshness.ts', import.meta.url).href);
const now = Date.parse('2026-10-06T23:58:00+08:00');
const later = '2026-10-07T00:15:00+08:00';
const sampled = (age: number) => new Date(now - age).toISOString();

test('库存到五分钟边界仍可展示，超过边界自动成为历史记录', () => {
  assert.equal(currentInventory(sampled(INVENTORY_FRESH_MS), later, 'complete', now), true);
  assert.equal(currentInventory(sampled(INVENTORY_FRESH_MS + 1), later, 'complete', now), false);
  assert.equal(currentInventory(sampled(0), later, 'complete', now + INVENTORY_FRESH_MS + 1), false);
  assert.equal(currentInventory(new Date(now + INVENTORY_FRESH_MS + 1).toISOString(), later, 'complete', now + INVENTORY_FRESH_MS + 1), true);
});

test('跨午夜按实际时间比较，发车时刻及之后不再展示为当前方案', () => {
  assert.equal(currentInventory(sampled(60_000), later, 'complete', now), true);
  assert.equal(currentInventory(sampled(0), new Date(now).toISOString(), 'complete', now), false);
  assert.equal(currentInventory(sampled(0), '2026-10-06T23:57:59+08:00', 'complete', now), false);
});

test('运行中与部分完成的已确认新库存继续展示，中断和取消均只作历史', () => {
  for (const status of ['running', 'waiting_user', 'partial', 'complete'] as JobStatus[]) assert.equal(currentInventory(sampled(20_000), later, status, now), true);
  for (const status of ['unavailable', 'cancelled'] as JobStatus[]) assert.equal(currentInventory(sampled(20_000), later, status, now), false);
});

test('两张票须全部新鲜，第二段新库存不能掩盖首段过期', () => {
  const plan = { departureIso: later, legs: [{ departureIso: later, fetchedAt: sampled(6 * 60_000) }, { departureIso: '2026-10-07T01:00:00+08:00', fetchedAt: sampled(0) }] } as TicketPlan;
  assert.equal(currentPlan(plan, 'partial', now), false);
  assert.equal(currentPlan({ ...plan, legs: plan.legs.map(leg => ({ ...leg, fetchedAt: sampled(60_000) })) }, 'partial', now), true);
  assert.equal(currentPlan({ ...plan, legs: [] }, 'complete', now), false);
});

test('无效时间与异常未来采集时间不能成为实时库存', () => {
  assert.equal(currentInventory('invalid', later, 'complete', now), false);
  assert.equal(currentInventory(sampled(0), 'invalid', 'complete', now), false);
  assert.equal(currentInventory(sampled(0), later, 'complete', NaN), false);
  assert.equal(currentInventory(sampled(-60_000), later, 'complete', now), false);
  assert.equal(currentInventory(sampled(-20_000), later, 'complete', now), true);
});
