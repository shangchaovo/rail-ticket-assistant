import test from 'node:test';
import assert from 'node:assert/strict';
import type { TicketPlan } from '../lib/rail-types';

const { boardingDate, officialTicketUrl, purchaseLinks }: typeof import('../lib/rail-purchase') =
  await import(new URL('../lib/rail-purchase.ts', import.meta.url).href);

test('官方条件链接保留实际车站电报码和官方解析需要的字面逗号', () => {
  const link = officialTicketUrl({ name: '杭州东', code: 'HGH' }, { name: '温州南', code: 'VRH' }, '2026-10-06T23:50:00+08:00');
  const params = new URL(link).searchParams;
  assert.equal(params.get('fs'), '杭州东,HGH');
  assert.equal(params.get('ts'), '温州南,VRH');
  assert.equal(params.get('date'), '2026-10-06');
  assert.equal(params.get('flag'), 'N,N,Y');
  const officialDecoded = decodeURI(link).split('?')[1];
  assert.ok(officialDecoded.includes('fs=杭州东,HGH'));
  assert.ok(officialDecoded.includes('flag=N,N,Y'));
  assert.equal(params.has('trainCode'), false);
});

test('跨午夜两张票分别使用每段实际乘车日期', () => {
  const plan = { kind: 'split', legs: [
    { from: { name: '杭州东', code: 'HGH' }, to: { name: '温州南', code: 'VRH' }, departureIso: '2026-10-06T23:40:00+08:00' },
    { from: { name: '温州南', code: 'VRH' }, to: { name: '苍南', code: 'CEH' }, departureIso: '2026-10-06T16:30:00Z' },
  ] } as TicketPlan;
  const links = purchaseLinks(plan);
  assert.deepEqual(links.map(link => new URL(link.url).searchParams.get('date')), ['2026-10-06', '2026-10-07']);
  assert.deepEqual(links.map(link => new URL(link.url).searchParams.get('fs')), ['杭州东,HGH', '温州南,VRH']);
});

test('短票链接只指向已覆盖的短区间，不把未覆盖段当票', () => {
  const plan = { kind: 'extension', legs: [{ from: { name: '杭州东', code: 'HGH' }, to: { name: '温州南', code: 'VRH' }, departureIso: '2026-10-06T10:00:00+08:00' }], uncovered: { from: { name: '温州南', code: 'VRH' }, to: { name: '苍南', code: 'CEH' } } } as TicketPlan;
  const links = purchaseLinks(plan);
  assert.equal(links.length, 1);
  assert.equal(new URL(links[0].url).searchParams.get('ts'), '温州南,VRH');
  assert.equal(links[0].label, '打开短票');
  assert.throws(() => boardingDate('not a date'));
});
