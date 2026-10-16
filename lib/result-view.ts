import type { RailSearch, SeatType, SegmentQuote, TicketPlan } from './rail-types';

export type SortKey = 'rank' | 'departure' | 'duration' | 'price';
export type SortDirection = 'asc' | 'desc';
export type TripSortable = { recommendIndex: number; departureIso: string; arrivalIso: string; price: number | null };

export type WaitlistSeat = { seat: SeatType; count?: number; price: number | null };
export type WaitlistTrain = {
  id: string;
  trainCode: string;
  runId: string;
  fromName: string;
  toName: string;
  destinationRank: number;
  departureIso: string;
  arrivalIso: string;
  seats: WaitlistSeat[];
  price: number | null;
  fetchedAt: string;
};

export function planPurchasePrice(plan: TicketPlan): number | null {
  return plan.kind === 'extension' ? plan.legs[0]?.inventory.price ?? null : plan.totalPrice;
}

export function tripMinutes(start: string, end: string): number | null {
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60000);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

function directed(value: number, direction: SortDirection) {
  return direction === 'asc' ? value : -value;
}

function compareNullable(a: number | null, b: number | null, direction: SortDirection) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return directed(a - b, direction);
}

export function compareTrips(a: TripSortable, b: TripSortable, key: SortKey, direction: SortDirection): number {
  if (key === 'rank') return a.recommendIndex - b.recommendIndex;
  if (key === 'departure') {
    const delta = Date.parse(a.departureIso) - Date.parse(b.departureIso);
    return directed(Number.isFinite(delta) ? delta : 0, direction) || a.recommendIndex - b.recommendIndex;
  }
  if (key === 'duration') return compareNullable(tripMinutes(a.departureIso, a.arrivalIso), tripMinutes(b.departureIso, b.arrivalIso), direction) || a.recommendIndex - b.recommendIndex;
  return compareNullable(a.price, b.price, direction) || a.recommendIndex - b.recommendIndex;
}

export function sortTrips<T extends TripSortable>(items: T[], key: SortKey, direction: SortDirection): T[] {
  return [...items].sort((a, b) => compareTrips(a, b, key, direction));
}

function shanghaiDate(iso: string) {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time + 8 * 3600_000).toISOString().slice(0, 10) : '';
}

/** Direct trips whose selected seats are only waitlist, with no buyable plan for the same train and destination. */
export function collectWaitlist(observations: SegmentQuote[], input: RailSearch, plans: TicketPlan[]): WaitlistTrain[] {
  const earliest = Date.parse(`${input.date}T${input.earliestTime}:00+08:00`);
  const latest = new Map<string, SegmentQuote>();
  for (const quote of observations) {
    if (quote.from.code !== input.origin.code || !input.destinations.some(station => station.code === quote.to.code)) continue;
    const type = quote.train.trainCode.slice(0, 1);
    if (!input.trainTypes.includes(type as 'G' | 'D' | 'C')) continue;
    if (shanghaiDate(quote.departureIso) !== input.date || !(Date.parse(quote.departureIso) >= earliest)) continue;
    const key = `${quote.train.runId}:${quote.to.code}`;
    const previous = latest.get(key);
    if (!previous || Date.parse(quote.fetchedAt) >= Date.parse(previous.fetchedAt)) latest.set(key, quote);
  }
  const buyable = new Set(plans.map(plan => `${plan.train.runId}:${plan.target.code}`));
  const rows: WaitlistTrain[] = [];
  for (const quote of latest.values()) {
    const key = `${quote.train.runId}:${quote.to.code}`;
    if (buyable.has(key)) continue;
    if (input.seats.some(seat => quote.seats[seat]?.status === 'available')) continue;
    const seats = input.seats.filter(seat => quote.seats[seat]?.status === 'waitlist').map(seat => ({
      seat, count: quote.seats[seat].count, price: quote.seats[seat].price,
    }));
    if (!seats.length) continue;
    const known = seats.map(seat => seat.price).filter((value): value is number => value !== null);
    rows.push({
      id: `waitlist:${key}`,
      trainCode: quote.train.trainCode,
      runId: quote.train.runId,
      fromName: quote.from.name,
      toName: quote.to.name,
      destinationRank: input.destinations.findIndex(station => station.code === quote.to.code),
      departureIso: quote.departureIso,
      arrivalIso: quote.arrivalIso,
      seats,
      price: known.length ? Math.min(...known) : null,
      fetchedAt: quote.fetchedAt,
    });
  }
  return rows.sort((a, b) => a.destinationRank - b.destinationRank || Date.parse(a.departureIso) - Date.parse(b.departureIso) || a.id.localeCompare(b.id));
}
