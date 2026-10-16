import type { JobStatus, SegmentQuote, TicketPlan } from './rail-types';

export const INVENTORY_FRESH_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 30_000;

/** UI eligibility only: this clock check never requests or refreshes inventory. */
export function currentInventory(fetchedAt: string, departureIso: string, status: JobStatus, now: number): boolean {
  if (status === 'unavailable' || status === 'cancelled' || !Number.isFinite(now)) return false;
  const sampled = Date.parse(fetchedAt), departure = Date.parse(departureIso);
  return Number.isFinite(sampled) && Number.isFinite(departure) && departure > now &&
    sampled <= now + CLOCK_SKEW_MS && now - sampled <= INVENTORY_FRESH_MS;
}

export function currentPlan(plan: TicketPlan, status: JobStatus, now: number): boolean {
  const departure = Date.parse(plan.departureIso);
  return Number.isFinite(departure) && departure > now && plan.legs.length > 0 &&
    plan.legs.every(leg => currentInventory(leg.fetchedAt, leg.departureIso, status, now));
}

export function currentQuote(quote: SegmentQuote, status: JobStatus, now: number): boolean {
  return currentInventory(quote.fetchedAt, quote.departureIso, status, now);
}
