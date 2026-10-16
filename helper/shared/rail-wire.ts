import type {SearchResult, TicketPlan, TrainStop} from './rail-types';

// Many seat combinations share one complete route. Send/store it once without
// removing any ticket leg, inventory status, timestamp, or verification evidence.
export type PackedResult = Omit<SearchResult, 'plans'> & {
  format: 'rail-result-v1';
  routes: TrainStop[][];
  plans: (Omit<TicketPlan, 'route'> & {routeIndex: number})[];
};

export function packResult(result: SearchResult): PackedResult {
  const routes: TrainStop[][] = [];
  const indexes = new Map<string, number>();
  const plans = result.plans.map(({route, ...plan}) => {
    const key = JSON.stringify(route);
    let routeIndex = indexes.get(key);
    if (routeIndex === undefined) {
      routeIndex = routes.length;
      routes.push(route);
      indexes.set(key, routeIndex);
    }
    return {...plan, routeIndex};
  });
  return {...result, format: 'rail-result-v1', routes, plans};
}

export function unpackResult(result: SearchResult | PackedResult): SearchResult {
  if (!('format' in result)) return result;
  if (result.format !== 'rail-result-v1' || !Array.isArray(result.routes)) throw new Error('路线快照格式无法读取');
  const {format: _format, routes, plans, ...rest} = result;
  void _format;
  return {...rest, plans: plans.map(({routeIndex, ...plan}) => {
    if (!Number.isInteger(routeIndex) || routeIndex < 0 || !Array.isArray(routes[routeIndex])) throw new Error('路线快照引用失效');
    return {...plan, route: routes[routeIndex]};
  })};
}
