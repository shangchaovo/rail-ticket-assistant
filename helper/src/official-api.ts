import type {SegmentQuote, Station} from '../shared/rail-types.ts';
import {SourceError} from './parsers.ts';

const TICKET_PATH = /^\/otn\/leftTicket\/query[A-Z]?$/;

export function officialTicketPath(value: string): string | null {
  const trimmed = value.trim().replace(/^\/+/, '');
  const relative = trimmed.startsWith('otn/') ? trimmed.slice(4) : trimmed;
  const pathname = `/otn/${relative}`;
  return TICKET_PATH.test(pathname) ? pathname : null;
}

export function leftTicketUrl(path: string, from: Station, to: Station, date: string): string {
  const pathname = officialTicketPath(path);
  if (!pathname) throw new SourceError('官方余票接口地址无法识别');
  const url = new URL(`https://kyfw.12306.cn${pathname}`);
  url.searchParams.set('leftTicketDTO.train_date', date);
  url.searchParams.set('leftTicketDTO.from_station', from.code);
  url.searchParams.set('leftTicketDTO.to_station', to.code);
  url.searchParams.set('purpose_codes', 'ADULT');
  return url.toString();
}

export function trainStopUrl(quote: SegmentQuote): string {
  const url = new URL('https://kyfw.12306.cn/otn/czxx/queryByTrainNo');
  url.searchParams.set('train_no', quote.train.trainNo.trim());
  url.searchParams.set('from_station_telecode', quote.from.code);
  url.searchParams.set('to_station_telecode', quote.to.code);
  url.searchParams.set('depart_date', quote.train.serviceDate);
  return url.toString();
}

export function rotatedTicketPath(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const hint = (payload as {c_url?: unknown}).c_url;
  return typeof hint === 'string' ? officialTicketPath(hint) : null;
}

export type OfficialAccess = 'ok' | 'rotate' | 'verify' | 'rate' | 'unavailable';
export const OFFICIAL_REQUEST_LIMIT = 60;

export function officialAccessError(access: 'verify' | 'rate' | 'budget'): SourceError & {code: typeof access} {
  const message = access === 'verify' ? '需要本人在电脑官方浏览器完成登录或验证码；本次停止查询，已确认的方案保留。处理完成后恢复助手，再发起新的查询。'
    : access === 'rate' ? '12306 已限流，本次停止查询并保留已确认方案，请稍后再查。'
      : '本次已达到官方请求预算，停止查询并保留已确认方案。';
  return Object.assign(new SourceError(message), {code: access});
}

export function officialAccess(status: number, payload: unknown, text: string): OfficialAccess {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as {status?: unknown; data?: unknown; messages?: unknown} : null;
  if (status === 429) return 'rate';
  if (status === 401 || status === 403) return 'verify';
  if (status === 200 && record?.status === true && record.data && typeof record.data === 'object') return 'ok';
  if (rotatedTicketPath(payload)) return 'rotate';
  const messages = Array.isArray(record?.messages) ? record.messages.filter((item): item is string => typeof item === 'string').join(' ') : '';
  const sample = `${text.slice(0, 8_000)}\n${messages}`;
  if (/验证码|滑动验证|请先登录|login\.html|captcha|verification|verify\s+(?:you|your|that)|security\s+check|please\s+(?:log|sign)\s*in|\/passport\//i.test(sample)) return 'verify';
  if (/频率|稍后再试|系统繁忙|网络可能存在问题|too\s+many\s+requests|rate\s*limit/i.test(sample)) return 'rate';
  return 'unavailable';
}
