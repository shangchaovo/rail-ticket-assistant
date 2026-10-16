import type { MapStation, RailGeometry } from './rail-map';
import type { Station } from './rail-types';

export type MapSnapshot = { stations: MapStation[]; tracks: { fromOffset: number; geometry: RailGeometry }[] };
type Entry = { stations: Record<string, MapStation>; tracks: Record<number, RailGeometry>; until: number };
const entries = new Map<string, Entry>();
const key = (route: Station[]) => JSON.stringify(route.map(s => [s.code, s.name]));
export function readRouteCache(route: Station[], now = Date.now()): Entry | null {
  const value = entries.get(key(route));
  if (!value || value.until <= now) { entries.delete(key(route)); return null; }
  return { stations: { ...value.stations }, tracks: { ...value.tracks }, until: value.until };
}
export function writeRouteCache(route: Station[], stations: Record<string, MapStation>, tracks: Record<number, RailGeometry>, now = Date.now()) {
  const name = key(route);
  if (!entries.has(name) && entries.size >= 16) entries.delete(entries.keys().next().value!);
  entries.set(name, { stations: { ...stations }, tracks: { ...tracks }, until: now + 5 * 60_000 });
}
export function rangeCached(stations: Record<string, MapStation>, tracks: Record<number, RailGeometry>, route: Station[], start: number, end: number) {
  for (let i = start; i <= end; i++) {
    if (!stations[route[i].code]) return false;
    if (i < end && stations[route[i].code]?.position && stations[route[i + 1].code]?.position && !tracks[i]) return false;
  }
  return true;
}
