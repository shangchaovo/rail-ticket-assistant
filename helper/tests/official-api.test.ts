import {test} from 'node:test';
import assert from 'node:assert/strict';
import {leftTicketUrl, officialAccess, officialTicketPath, rotatedTicketPath, trainStopUrl} from '../src/official-api.ts';
import type {SegmentQuote} from '../shared/rail-types.ts';

const from = {name: '杭州东', code: 'HGH'};
const to = {name: '温州南', code: 'VRH'};

test('只接受官网余票查询路径', () => {
  assert.equal(officialTicketPath('leftTicket/queryG'), '/otn/leftTicket/queryG');
  assert.equal(officialTicketPath('/otn/leftTicket/query'), '/otn/leftTicket/query');
  assert.equal(officialTicketPath('https://kyfw.12306.cn/otn/leftTicket/queryZ'), null);
  assert.equal(officialTicketPath('leftTicket/queryXX'), null);
  assert.equal(officialTicketPath('/otn/czxx/queryByTrainNo'), null);
});

test('余票地址使用官网查询字段', () => {
  const url = new URL(leftTicketUrl('leftTicket/queryA', from, to, '2026-10-05'));
  assert.equal(url.origin, 'https://kyfw.12306.cn');
  assert.equal(url.pathname, '/otn/leftTicket/queryA');
  assert.equal(url.searchParams.get('leftTicketDTO.train_date'), '2026-10-05');
  assert.equal(url.searchParams.get('leftTicketDTO.from_station'), 'HGH');
  assert.equal(url.searchParams.get('leftTicketDTO.to_station'), 'VRH');
  assert.equal(url.searchParams.get('purpose_codes'), 'ADULT');
});

test('经停地址带列车身份和乘车日期', () => {
  const quote = {train: {trainNo: '5l000G762900', serviceDate: '2026-10-05'}, from, to} as SegmentQuote;
  const url = new URL(trainStopUrl(quote));
  assert.equal(url.pathname, '/otn/czxx/queryByTrainNo');
  assert.equal(url.searchParams.get('train_no'), '5l000G762900');
  assert.equal(url.searchParams.get('from_station_telecode'), 'HGH');
  assert.equal(url.searchParams.get('to_station_telecode'), 'VRH');
  assert.equal(url.searchParams.get('depart_date'), '2026-10-05');
});

test('区分正常响应、接口轮换、验证和限流', () => {
  assert.equal(officialAccess(200, {status: true, data: {result: []}}, ''), 'ok');
  assert.equal(officialAccess(200, {status: false, c_url: 'leftTicket/queryG'}, ''), 'rotate');
  assert.equal(rotatedTicketPath({c_url: 'leftTicket/queryG'}), '/otn/leftTicket/queryG');
  assert.equal(officialAccess(200, {status: false, messages: ['请先登录系统']}, '<html>验证码</html>'), 'verify');
  assert.equal(officialAccess(200, {status: false, messages: ['系统繁忙，请稍后再试']}, ''), 'rate');
  assert.equal(officialAccess(500, null, 'bad gateway'), 'unavailable');
});

test('HTTP 429 and English verification pages remain explicit access blocks', () => {
  assert.equal(officialAccess(429, null, ''), 'rate');
  assert.equal(officialAccess(429, {status: true, data: {result: []}}, ''), 'rate');
  assert.equal(officialAccess(200, null, '<html>Captcha verification required</html>'), 'verify');
  assert.equal(officialAccess(200, null, '<html>Please sign in</html>'), 'verify');
  assert.equal(officialAccess(200, null, '<html>Verify you are human</html>'), 'verify');
  assert.equal(officialAccess(403, null, ''), 'verify');
  assert.equal(officialAccess(200, {status: false, messages: ['Too many requests']}, ''), 'rate');
});
