export function localDate(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}
export function addDays(date: string, count: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
export function dateDifference(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}
/** Convert a local wall-clock hour using IANA rules; handles 23/25-hour dates. */
export function atLocalHour(date: string, timezone: string, hour = 9): Date {
  const target = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  let guess = target;
  for (let pass = 0; pass < 4; pass++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const get = (type: string) => parts.find((part) => part.type === type)!.value;
    const rendered = Date.parse(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`);
    const change = target - rendered;
    guess += change;
    if (!change) break;
  }
  return new Date(guess);
}
