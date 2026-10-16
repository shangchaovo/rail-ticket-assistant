import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {chromium, type BrowserContext, type Page} from 'playwright';
import {OfficialAdapter, type AdapterHooks} from '../src/official-adapter.ts';
import {OFFICIAL_REQUEST_LIMIT} from '../src/official-api.ts';
import type {SegmentQuote, Station} from '../shared/rail-types.ts';

const from = {name: '甲站', code: 'AAA'};
const to = {name: '丙站', code: 'CCC'};
const date = '2026-10-05';
function tickets(count = '2') {
  const p = Array(60).fill('');
  Object.assign(p, {1:'预订',2:'550000G12340',3:'G1234',4:'AAA',5:'CCC',6:'AAA',7:'CCC',8:'23:30',9:'01:15',10:'01:45',11:'Y',13:'20261005',16:'01',17:'03',26:'无',30:count,31:'--',32:'--'});
  return {status:true, data:{result:[p.join('|')], map:{AAA:'甲站',CCC:'丙站'}}};
}
// Use the real adapter's request, cache and access handling with a fake official
// transport. No test launches a browser or sends requests to 12306.
type FakeAdapter = {
  page: Page; ticketPath: string; stationList: Station[];
  session: (headed: boolean) => Promise<void>;
  prepare: () => Promise<void>; pace: () => Promise<void>;
  queryByClick: () => Promise<SegmentQuote[]>;
};
function transport(hooks: AdapterHooks, answer: () => {status: number; payload: unknown; text?: string}) {
  const adapter = new OfficialAdapter(hooks);
  const internal = adapter as unknown as FakeAdapter;
  const calls = {requests: 0, fallback: 0, headed: 0};
  internal.ticketPath = '/otn/leftTicket/query'; internal.stationList = [from, to];
  internal.session = async headed => {if (headed) calls.headed++;};
  internal.prepare = async () => {}; internal.pace = async () => {};
  internal.queryByClick = async () => {calls.fallback++; throw new Error('blocked requests must not use UI fallback');};
  internal.page = {request:{get: async () => {
    calls.requests++; const got = answer();
    return {status: () => got.status, text: async () => got.text ?? JSON.stringify(got.payload), dispose: async () => {}};
  }}} as unknown as Page;
  return {adapter, calls};
}

test('HTTP 429 stops immediately without a delay retry or official UI fallback', async () => {
  const {adapter, calls} = transport({}, () => ({status:429, payload:null}));
  await assert.rejects(adapter.query(from, to, date), error => (error as {code?: string}).code === 'rate');
  await assert.rejects(adapter.query(from, to, date), error => (error as {code?: string}).code === 'rate');
  assert.equal(calls.requests, 1); assert.equal(calls.fallback, 0);
});

test('verification calls the human recovery hook, then ends this task without resuming interval requests', async () => {
  let humanPrompts = 0;
  const {adapter, calls} = transport({waitForUser: async () => {humanPrompts++;}}, () => ({status:200, payload:null, text:'<html>Captcha verification required</html>'}));
  await assert.rejects(adapter.query(from, to, date), error => (error as {code?: string}).code === 'verify');
  await assert.rejects(adapter.query(from, to, date), error => (error as {code?: string}).code === 'verify');
  assert.equal(humanPrompts, 1); assert.equal(calls.headed, 1);
  assert.equal(calls.requests, 1); assert.equal(calls.fallback, 0);
});

test('configureForJob resets inventory cache so a recheck receives fresh official inventory', async () => {
  let inventory = '2';
  const {adapter, calls} = transport({}, () => ({status:200, payload:tickets(inventory)}));
  assert.equal((await adapter.query(from, to, date))[0].seats.second.count, 2);
  inventory = '无';
  assert.equal((await adapter.query(from, to, date))[0].seats.second.count, 2);
  adapter.configureForJob({});
  assert.equal((await adapter.query(from, to, date))[0].seats.second.status, 'sold_out');
  assert.equal(calls.requests, 2);
});

test('the transport request budget includes distinct official queries and blocks the next request', async () => {
  const {adapter, calls} = transport({}, () => ({status:200, payload:{status:true,data:{result:[],map:{}}}}));
  for (let i = 0; i < OFFICIAL_REQUEST_LIMIT; i++) await adapter.query(from, {name:`目的${i}`,code:`${i}`}, date);
  await assert.rejects(adapter.query(from, to, date), error => (error as {code?: string}).code === 'budget');
  assert.equal(calls.requests, OFFICIAL_REQUEST_LIMIT);
});

test('a blocked train-stop response ends the task without retrying or opening stop details', async () => {
  const {adapter, calls} = transport({}, () => ({status:429, payload:null}));
  const seed = {train:{trainNo:'550000G12340',serviceDate:date},from,to} as SegmentQuote;
  await assert.rejects(adapter.stops(seed), error => (error as {code?: string}).code === 'rate');
  assert.equal(calls.requests, 1); assert.equal(calls.headed, 0);
});

test('cancelling while the browser launches prevents a subsequent official navigation', async () => {
  let cancelled = false, newPages = 0, closed = 0;
  let begin!: () => void, complete!: (context: BrowserContext) => void;
  const begun = new Promise<void>(resolve => {begin = resolve;});
  const pending = new Promise<BrowserContext>(resolve => {complete = resolve;});
  const replacement = mock.method(chromium, 'launchPersistentContext', async () => {begin(); return pending;});
  const adapter = new OfficialAdapter({isCancelled: async () => cancelled});
  const opening = adapter.open();
  try {
    await begun;
    cancelled = true;
    await adapter.close(); // The launched context has not returned yet.
    complete({newPage: async () => {newPages++; throw new Error('must not navigate');}, close: async () => {closed++;}} as unknown as BrowserContext);
    await assert.rejects(opening, /查询已取消/);
    await adapter.close(); // The CLI finally closes the newly assigned context.
    assert.equal(newPages, 0); assert.equal(closed, 1);
  } finally {replacement.mock.restore(); await adapter.close();}
});
