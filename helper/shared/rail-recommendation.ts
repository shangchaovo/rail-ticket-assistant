import type { TicketPlan } from './rail-types';

export type RecommendationMode = 'balanced' | 'price' | 'duration';
const minutes = (p: TicketPlan) => (Date.parse(p.arrivalIso) - Date.parse(p.departureIso)) / 60000;
const covered = (p: TicketPlan) => p.kind !== 'extension' && !p.uncovered;
const seatPreference = (p: TicketPlan) => p.legs.filter(l => l.seat === 'standing').length;
const priceOrder = (a: TicketPlan, b: TicketPlan) => a.totalPrice === null ? (b.totalPrice === null ? 0 : 1) : b.totalPrice === null ? -1 : a.totalPrice - b.totalPrice;
const stable = (a: TicketPlan, b: TicketPlan) => seatPreference(a) - seatPreference(b) || a.legs.length - b.legs.length || Date.parse(a.arrivalIso) - Date.parse(b.arrivalIso) || a.id.localeCompare(b.id);

/** Unknown fares cannot establish a price advantage; comparisons stay within one actual destination. */
export function dominates(a: TicketPlan, b: TicketPlan): boolean {
  return a.target.code === b.target.code && covered(a) && covered(b) && a.totalPrice !== null && b.totalPrice !== null
    && a.totalPrice <= b.totalPrice && minutes(a) <= minutes(b)
    && (a.totalPrice < b.totalPrice || minutes(a) < minutes(b) || stable(a, b) < 0);
}

/** The optimum is among verified candidates, not an exhaustive national route search. */
export function recommendPlans(plans: TicketPlan[], mode: RecommendationMode = 'balanced'): TicketPlan[] {
  const ranges = new Map<string, {priceMin:number;priceMax:number;timeMin:number;timeMax:number}>();
  for (const p of plans.filter(covered)) {
    const r = ranges.get(p.target.code) || {priceMin:Infinity,priceMax:0,timeMin:Infinity,timeMax:0};
    if (p.totalPrice !== null) { r.priceMin = Math.min(r.priceMin,p.totalPrice); r.priceMax = Math.max(r.priceMax,p.totalPrice); }
    r.timeMin = Math.min(r.timeMin,minutes(p)); r.timeMax = Math.max(r.timeMax,minutes(p)); ranges.set(p.target.code,r);
  }
  const score = (p: TicketPlan) => {
    const r = ranges.get(p.target.code);
    if (!r || p.totalPrice === null) return Infinity;
    return (p.totalPrice-r.priceMin)/Math.max(1,r.priceMax-r.priceMin) + (minutes(p)-r.timeMin)/Math.max(1,r.timeMax-r.timeMin);
  };
  const dominated = new Set(plans.filter(p=>plans.some(other=>other!==p&&dominates(other,p))).map(p=>p.id));
  return [...plans].sort((a,b)=>a.destinationRank-b.destinationRank || Number(!covered(a))-Number(!covered(b))
    || (mode==='price' ? priceOrder(a,b)||minutes(a)-minutes(b)
      : mode==='duration' ? minutes(a)-minutes(b)||priceOrder(a,b)
        : Number(dominated.has(a.id))-Number(dominated.has(b.id)) || Number(a.totalPrice===null)-Number(b.totalPrice===null) || score(a)-score(b) || priceOrder(a,b)||minutes(a)-minutes(b))
    || stable(a,b));
}

export function recommendationLabels(plans: TicketPlan[]): Record<string,string[]> {
  const labels:Record<string,string[]> = {};
  for (const target of new Set(plans.filter(covered).map(p=>p.target.code))) {
    const group = plans.filter(p=>covered(p)&&p.target.code===target);
    const known = group.filter(p=>p.totalPrice!==null);
    const cheapest = recommendPlans(known,'price')[0], fastest = recommendPlans(group,'duration')[0], balanced = recommendPlans(known)[0];
    for (const [p,label] of [[cheapest,'本次较省'],[fastest,'本次较快'],[balanced,'价格与用时折中']] as const) {
      if (p) (labels[p.id] ||= []).push(label);
    }
  }
  return labels;
}

/** Keep the price/time extremes for the highest-priority destination in a short balanced list. */
export function previewRecommendations(ordered: TicketPlan[], limit=6): TicketPlan[] {
  if(ordered.length<=limit)return ordered;
  const group=ordered.filter(p=>p.target.code===ordered[0].target.code&&covered(p));
  const important=[recommendPlans(group.filter(p=>p.totalPrice!==null),'price')[0],recommendPlans(group,'duration')[0]].filter((p):p is TicketPlan=>!!p);
  const selected=new Set(ordered.slice(0,limit).map(p=>p.id));
  for(const plan of important){
    if(selected.has(plan.id))continue;
    const replace=[...ordered.slice(0,limit)].reverse().find(p=>selected.has(p.id)&&!important.some(q=>q.id===p.id));
    if(replace){selected.delete(replace.id);selected.add(plan.id);}
  }
  return ordered.filter(p=>selected.has(p.id));
}
