import type { LocaleCode } from './locales';

const formats = new Map<string, Intl.NumberFormat>();
export function formatNumber(locale: LocaleCode, value: number, minimumFractionDigits: number, maximumFractionDigits = minimumFractionDigits): string {
  const id = `${locale}:${minimumFractionDigits}:${maximumFractionDigits}`;
  let format = formats.get(id);
  if (!format) { format = new Intl.NumberFormat(locale, { minimumFractionDigits, maximumFractionDigits }); formats.set(id, format); }
  return format.format(value);
}

const MISSING = '—';
const missing = (value: number | null | undefined): value is null | undefined => value === null || value === undefined || !Number.isFinite(value);

export interface Formatters {
  /** A number with a fixed number of decimals, or an em dash when there is no value. */
  n: (value: number | null | undefined, digits?: number) => string;
  /** A whole number with locale grouping. */
  int: (value: number) => string;
  /** A duration given in milliseconds, shown as ms or s. */
  time: (value: number | null | undefined) => string;
}

export function createFormatters(locale: LocaleCode): Formatters {
  const n: Formatters['n'] = (value, digits = 1) => missing(value) ? MISSING : formatNumber(locale, value, digits);
  return {
    n,
    int: value => formatNumber(locale, value, 0),
    time: value => value == null ? MISSING : value >= 1000 ? `${n(value / 1000, 2)} s` : `${n(value, 0)} ms`,
  };
}
