/** The public form and 12306 both use the calendar in Beijing (UTC+8). */
export function beijingDate(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

/** Calendar arithmetic without inheriting the browser's time zone or DST. */
export function addDays(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(days)) return '';
  const value = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) return '';
  value.setUTCDate(value.getUTCDate() + days);
  if (!Number.isFinite(value.getTime())) return '';
  const result = value.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : '';
}
