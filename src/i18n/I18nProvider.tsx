import { createContext, Fragment, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { createFormatters, formatNumber, type Formatters } from './format';
import { isLocaleCode, type LocaleCode } from './locales';
import { browserLanguages, negotiateLocale } from './negotiate';
import { createTranslator, PLACEHOLDER, renderMessage, templateFor, type Translator } from './translate';
import type { MessageKey, Msg, ParamNames } from './types';

export const LOCALE_STORAGE_KEY = 'llm-speedtest-locale';

/** `system` follows the browser's language list; a locale code pins the interface to that language. */
export type LocalePreference = 'system' | LocaleCode;

type RichParams<K extends MessageKey> = { [P in ParamNames<K>]: ReactNode | Msg };

export interface I18n extends Translator, Formatters {
  /** What the user chose: `system` (default) or an explicit language. */
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => void;
  /** The locale the browser's languages resolve to, whether or not it is currently used. */
  systemLocale: LocaleCode;
  /** Translate a message whose placeholders are filled with React nodes, e.g. inline `<code>`. */
  rich: <K extends MessageKey>(key: K, params: RichParams<K>) => ReactNode;
}

const I18nContext = createContext<I18n | null>(null);

function readPreference(): LocalePreference {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocaleCode(stored) ? stored : 'system';
  } catch { return 'system'; }
}

const isMessage = (value: unknown): value is Msg => typeof value === 'object' && value !== null && !isValidElement(value) && typeof (value as Msg).key === 'string' && !Array.isArray(value);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readPreference);
  const [systemLocale, setSystemLocale] = useState(() => negotiateLocale(browserLanguages()));
  const locale = preference === 'system' ? systemLocale : preference;

  useEffect(() => {
    const update = () => setSystemLocale(negotiateLocale(browserLanguages()));
    window.addEventListener('languagechange', update);
    return () => window.removeEventListener('languagechange', update);
  }, []);

  const setPreference = useCallback((next: LocalePreference) => {
    setPreferenceState(next);
    // Only an explicit choice is stored, so "system" keeps following the browser.
    try { if (next === 'system') localStorage.removeItem(LOCALE_STORAGE_KEY); else localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* Storage is optional. */ }
  }, []);

  const value = useMemo<I18n>(() => {
    const translator = createTranslator(locale);
    const rich: I18n['rich'] = (key, params) => {
      const values = params as Record<string, ReactNode | Msg>;
      const template = templateFor(locale, key, values);
      const parts: ReactNode[] = [];
      let last = 0;
      for (const match of template.matchAll(PLACEHOLDER)) {
        parts.push(template.slice(last, match.index));
        const part = values[match[1]];
        parts.push(<Fragment key={match.index}>{isMessage(part) ? renderMessage(locale, part) : typeof part === 'number' ? formatNumber(locale, part, 0, 3) : part}</Fragment>);
        last = match.index + match[0].length;
      }
      parts.push(template.slice(last));
      return parts;
    };
    return { ...translator, ...createFormatters(locale), preference, setPreference, systemLocale, rich };
  }, [locale, preference, setPreference, systemLocale]);

  // Keep the document in step with the interface: screen readers, hyphenation and CJK glyph selection follow `lang`.
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.querySelector('meta[name="description"]')?.setAttribute('content', value.t('meta.description'));
  }, [locale, value]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>.');
  return context;
}
