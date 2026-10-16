/** GET/HEAD conditional requests use a weak comparison, including after CDN compression. */
export function matchesEntityTag(header: string | null, entityTag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const expected = entityTag.replace(/^W\//, '');
  return Array.from(header.matchAll(/(?:^|,)\s*(?:W\/)?("[^"]*")\s*(?=,|$)/g))
    .some(match => match[1] === expected);
}

export function jobEntityTag(id: string, version: number, updatedAt: string, compact: boolean): string {
  return `W/${JSON.stringify(`rail-${id}-${version}-${updatedAt}-${compact ? 'compact' : 'full'}`)}`;
}
