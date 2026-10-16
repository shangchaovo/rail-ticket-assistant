import stations from './stations.json' with { type: 'json' };

export type StationCatalogEntry = { name: string; code: string; pinyin: string; short: string; city: string };
export type StationChoice = { name: string; code: string; city: string; label: string };
export type StationSearchResult = { stations: StationChoice[]; cityOnly: boolean; cityQuery: boolean };

const catalog = stations as StationCatalogEntry[];
const stationNames = new Set(catalog.map(station => station.name));

/** Empty affiliation is omitted by the picker. A blank string is not a city name. */
export function stationCityLabel(city: string | null | undefined): string | null {
  const label = city?.trim() ?? '';
  return label || null;
}

/** The row uses the official station name. The city stays a separate annotation. */
export function stationOptionLabel(name: string, _city?: string | null): string {
  return name;
}

function choice(station: StationCatalogEntry): StationChoice {
  const city = stationCityLabel(station.city) ?? '';
  return { name: station.name, code: station.code, city, label: station.name };
}

/** Visible input for a committed station. This is the catalog name, never a city-wide choice. */
export function stationInputLabel(station: { name: string; code: string; city?: string }): string {
  return station.name;
}

/** A row whose name is the city is the city itself, not a station the user can pick. */
export function selectableStation(station: { name: string; city?: string | null }): boolean {
  const city = stationCityLabel(station.city);
  return !city || station.name !== city;
}

function normalizedQuery(query: string): string {
  return query.trim().toLowerCase().slice(0, 40);
}

/**
 * Only an official station name resolves. 温州 is the real station RZH.
 * 温州站、北京站 are not stations. A city with no station of that name, such as 南平, does not resolve.
 */
export function resolveStationName(query: string): { name: string; code: string } | null {
  const q = normalizedQuery(query);
  if (!q) return null;
  const exact = catalog.find(station => station.name.toLowerCase() === q);
  return exact ? { name: exact.name, code: exact.code } : null;
}

/**
 * Enter commits only a highlighted station row.
 * A typed city, with nothing highlighted, does not commit.
 */
export function commitStationInput(query: string, highlighted: { name: string; code: string } | null): { name: string; code: string } | null {
  if (!highlighted) return null;
  const known = catalog.find(station => station.name === highlighted.name && station.code === highlighted.code);
  if (!known || !selectableStation(known)) return null;
  void query;
  return { name: known.name, code: known.code };
}

export function searchStations(query: string, limit = 30): StationSearchResult {
  const q = normalizedQuery(query);
  if (!q) return { stations: catalog.slice(0, limit).map(choice), cityOnly: false, cityQuery: false };
  const cityOf = (station: StationCatalogEntry) => stationCityLabel(station.city)?.toLowerCase() ?? '';
  const cityQuery = catalog.some(station => cityOf(station) === q);
  const hasNamedStation = stationNames.has(query.trim()) || catalog.some(station => station.name.toLowerCase() === q);
  const matched = catalog.flatMap((station, index) => {
    const name = station.name.toLowerCase();
    const city = cityOf(station);
    const hit = name.includes(q) || station.pinyin.includes(q) || station.short.includes(q) || station.code.toLowerCase() === q || (city !== '' && city.includes(q));
    return hit ? [{ station, index }] : [];
  });
  const rank = (station: StationCatalogEntry) => {
    const name = station.name.toLowerCase();
    const city = cityOf(station);
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (city === q) return 2;
    if (name.includes(q) || city.includes(q)) return 3;
    return 4;
  };
  const stations = matched.sort((a, b) => rank(a.station) - rank(b.station) || a.index - b.index).slice(0, limit).map(item => choice(item.station));
  return {
    stations: stations.filter(station => stationNames.has(station.name)),
    cityOnly: cityQuery && !hasNamedStation,
    cityQuery,
  };
}
