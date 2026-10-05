import { catalogs, FALLBACK_LOCALE, type LocaleCode } from './locales';
import { formatNumber } from './format';
import type { MessageKey, MessageValue, Msg, ParamValue, Translate } from './types';

const pluralRules = new Map<LocaleCode, Intl.PluralRules>();
function pluralCategory(locale: LocaleCode, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) { rules = new Intl.PluralRules(locale); pluralRules.set(locale, rules); }
  return rules.select(count);
}

/** The raw template for a key: a missing translation falls back to English, never to a blank. */
export function templateFor(locale: LocaleCode, key: MessageKey, params?: Record<string, unknown>): string {
  const value = (catalogs[locale][key] ?? catalogs[FALLBACK_LOCALE][key]) as MessageValue;
  if (typeof value === 'string') return value;
  const count = params?.count;
  return (typeof count === 'number' ? value[pluralCategory(locale, count)] : undefined) ?? value.other;
}

export const PLACEHOLDER = /\{(\w+)\}/g;

function stringify(locale: LocaleCode, value: ParamValue): string {
  if (typeof value === 'number') return formatNumber(locale, value, 0, 3);
  if (typeof value === 'string') return value;
  return renderMessage(locale, value);
}

/** Render a message descriptor. Number parameters follow the locale; nested messages are rendered recursively. */
export function renderMessage(locale: LocaleCode, { key, params }: Msg): string {
  return templateFor(locale, key, params).replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = params?.[name];
    return value === undefined ? placeholder : stringify(locale, value);
  });
}

export interface Translator {
  readonly locale: LocaleCode;
  /** Translate a key; parameters are checked against the placeholders of the English message. */
  t: Translate;
  /** Render a stored message descriptor (errors, status lines) in this language. */
  tMsg: (message: Msg) => string;
}

export function createTranslator(locale: LocaleCode): Translator {
  const t = ((key: MessageKey, params?: Record<string, ParamValue>) => renderMessage(locale, { key, params })) as Translate;
  return { locale, t, tMsg: message => renderMessage(locale, message) };
}
