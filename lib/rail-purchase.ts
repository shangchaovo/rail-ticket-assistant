import type { Station, TicketLeg, TicketPlan } from './rail-types';

export const OFFICIAL_TICKET_URL = 'https://kyfw.12306.cn/otn/leftTicket/init';

/** Each ticket uses the boarding station's calendar day, including overnight runs. */
export function boardingDate(departureIso: string): string {
  const timestamp = Date.parse(departureIso);
  if (!Number.isFinite(timestamp)) throw new Error('购票区间的乘车日期尚未确认。');
  return new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * Verified against the official page's initParams and aR on 2026-10-06:
 * https://kyfw.12306.cn/otn/resources/merged/common_js.js?scriptVersion=1.95054
 * https://kyfw.12306.cn/otn/resources/merged/queryLeftTicket_end_js.js?scriptVersion=1.95054
 * fs/ts = name,telecode; date = boarding day; flag = student,GDC,query.
 * The page uses decodeURI then split(','): commas must remain literal.
 * Its URL parser has no train-code parameter. Users select the displayed train.
 * auto_query only clicks 查询; this link does not enable automatic submission.
 */
export function officialTicketUrl(from: Station, to: Station, departureIso: string): string {
  if (!/^[A-Z]{3}$/.test(from.code) || !/^[A-Z]{3}$/.test(to.code) || !from.name || !to.name) {
    throw new Error('购票区间的实际车站尚未确认。');
  }
  return `${OFFICIAL_TICKET_URL}?linktypeid=dc&fs=${encodeURIComponent(from.name)},${from.code}&ts=${encodeURIComponent(to.name)},${to.code}&date=${boardingDate(departureIso)}&flag=N,N,Y`;
}

export function ticketLegUrl(leg: TicketLeg): string {
  return officialTicketUrl(leg.from, leg.to, leg.departureIso);
}

export function purchaseLinks(plan: TicketPlan): { label: string; url: string }[] {
  return plan.legs.map((leg, index) => ({
    label: plan.legs.length > 1 ? `打开第 ${index + 1} 张票` : plan.kind === 'extension' ? '打开短票' : '打开这张票',
    url: ticketLegUrl(leg),
  }));
}
