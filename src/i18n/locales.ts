import { en } from './messages/en';
import { es } from './messages/es';
import { ja } from './messages/ja';
import { ko } from './messages/ko';
import { zhCN } from './messages/zh-CN';
import { zhTW } from './messages/zh-TW';
import type { Catalog } from './types';

/**
 * The registry of supported interface languages. To add one: create `messages/<code>.ts`
 * (the compiler lists every missing key) and add a line here.
 * `name` is the endonym, shown in the language menu independently of the current language.
 */
export const LOCALES = [
  { code: 'en', name: 'English', catalog: en },
  { code: 'zh-CN', name: '简体中文', catalog: zhCN },
  { code: 'zh-TW', name: '繁體中文', catalog: zhTW },
  { code: 'ja', name: '日本語', catalog: ja },
  { code: 'ko', name: '한국어', catalog: ko },
  { code: 'es', name: 'Español', catalog: es },
] as const satisfies readonly { code: string; name: string; catalog: Catalog }[];

export type LocaleCode = (typeof LOCALES)[number]['code'];

/** Used when none of the browser's languages is supported. */
export const FALLBACK_LOCALE: LocaleCode = 'en';

export const LOCALE_CODES: readonly LocaleCode[] = LOCALES.map(locale => locale.code);
export const catalogs: Record<LocaleCode, Catalog> = Object.fromEntries(LOCALES.map(locale => [locale.code, locale.catalog])) as Record<LocaleCode, Catalog>;

export const isLocaleCode = (value: unknown): value is LocaleCode => LOCALE_CODES.includes(value as LocaleCode);
export const localeName = (code: LocaleCode): string => LOCALES.find(locale => locale.code === code)!.name;
