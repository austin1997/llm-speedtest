import { FALLBACK_LOCALE, LOCALE_CODES, type LocaleCode } from './locales';

const maximize = (tag: string): Intl.Locale | null => {
  try { return new Intl.Locale(tag).maximize(); } catch { return null; }
};

const supported = LOCALE_CODES.map(code => ({ code, locale: maximize(code)! }));

/**
 * Pick the supported locale that best serves a language tag. Tags are expanded with their likely script
 * and region (`zh-HK` → `zh-Hant-HK`, `zh-SG` → `zh-Hans-SG`), so Chinese variants resolve by script without
 * special cases. A different script of the same language is never accepted.
 */
function match(tag: string): LocaleCode | null {
  const wanted = maximize(tag);
  if (!wanted) return null;
  let best: { code: LocaleCode; score: number } | null = null;
  for (const { code, locale } of supported) {
    if (locale.language !== wanted.language || locale.script !== wanted.script) continue;
    const score = (locale.region === wanted.region ? 1 : 0) + (code.toLowerCase() === tag.toLowerCase() ? 2 : 0);
    if (!best || score > best.score) best = { code, score };
  }
  return best?.code ?? null;
}

/** Walk the browser's languages in priority order and return the first supported one. */
export function negotiateLocale(requested: readonly string[]): LocaleCode {
  for (const tag of requested) {
    const code = match(tag);
    if (code) return code;
  }
  return FALLBACK_LOCALE;
}

export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}
