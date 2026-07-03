/** All user-visible timestamps use UTC (GMT), never browser local time. */

const GMT = 'UTC';

export type LightweightTime =
  | number
  | string
  | {
      year: number;
      month: number;
      day: number;
    };

export function lightweightTimeToMs(time: LightweightTime): number | null {
  if (typeof time === 'number') {
    return time * 1000;
  }
  if (typeof time === 'string') {
    const ms = Date.parse(time);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof time === 'object' && time != null && 'year' in time) {
    return Date.UTC(time.year, time.month - 1, time.day);
  }
  return null;
}

/** Full label for tooltips and UI, e.g. `3 Jul 2026, 04:43 GMT`. */
export function formatGmtDateTime(ms: number, options?: { withSeconds?: boolean }): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: GMT,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: options?.withSeconds ? '2-digit' : undefined,
    hour12: false,
  }).formatToParts(new Date(ms));

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const base = `${pick('day')} ${pick('month')} ${pick('year')}, ${pick('hour')}:${pick('minute')}`;
  if (options?.withSeconds) {
    return `${base}:${pick('second')} GMT`;
  }
  return `${base} GMT`;
}

/** From Unix seconds (lightweight-charts UTCTimestamp). */
export function formatGmtFromSeconds(sec: number, options?: { withSeconds?: boolean }): string {
  return formatGmtDateTime(sec * 1000, options);
}

/** From ISO string stored in Supabase. */
export function formatGmtIso(iso: string | null | undefined, options?: { withSeconds?: boolean }): string {
  if (!iso) {
    return '—';
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return '—';
  }
  return formatGmtDateTime(ms, options);
}

/** Shorter axis label for chart time scale, e.g. `03 Jul 04:43`. */
export function formatGmtChartAxis(sec: number): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: GMT,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(sec * 1000));

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${pick('day')} ${pick('month')} ${pick('hour')}:${pick('minute')}`;
}

export function formatLightweightChartTime(time: LightweightTime): string {
  const ms = lightweightTimeToMs(time);
  if (ms == null) {
    return '—';
  }
  return formatGmtDateTime(ms);
}

export function formatLightweightChartAxis(time: LightweightTime): string | null {
  const ms = lightweightTimeToMs(time);
  if (ms == null) {
    return null;
  }
  return formatGmtChartAxis(Math.floor(ms / 1000));
}
