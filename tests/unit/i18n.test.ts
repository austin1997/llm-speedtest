import { describe, expect, it } from 'vitest';
import { createFormatters } from '../../src/i18n/format';
import { FALLBACK_LOCALE, LOCALES, isLocaleCode, type LocaleCode } from '../../src/i18n/locales';
import { describeError, LocalizedError, msg } from '../../src/i18n/message';
import { negotiateLocale } from '../../src/i18n/negotiate';
import { createTranslator, renderMessage } from '../../src/i18n/translate';
import type { MessageValue } from '../../src/i18n/types';

const placeholders = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]));
const forms = (value: MessageValue) => typeof value === 'string' ? [value] : Object.values(value);
const english = LOCALES.find(locale => locale.code === FALLBACK_LOCALE)!.catalog as Record<string, MessageValue>;

describe('locale negotiation', () => {
  it.each([
    [['en-US'], 'en'], [['en-GB', 'fr'], 'en'], [['es-MX'], 'es'], [['es'], 'es'], [['ja-JP'], 'ja'], [['ko-KR'], 'ko'],
    [['zh-CN'], 'zh-CN'], [['zh'], 'zh-CN'], [['zh-SG'], 'zh-CN'], [['zh-Hans'], 'zh-CN'], [['zh-Hans-HK'], 'zh-CN'],
    [['zh-TW'], 'zh-TW'], [['zh-HK'], 'zh-TW'], [['zh-MO'], 'zh-TW'], [['zh-Hant'], 'zh-TW'], [['zh-Hant-CN'], 'zh-TW'],
  ] as [string[], LocaleCode][])('resolves %j to %s', (requested, expected) => {
    expect(negotiateLocale(requested)).toBe(expected);
  });

  it('honours the order of the browser language list and skips unsupported or invalid tags', () => {
    expect(negotiateLocale(['fr-FR', 'ja', 'en'])).toBe('ja');
    expect(negotiateLocale(['de', 'not a tag', 'zh-HK', 'en'])).toBe('zh-TW');
    expect(negotiateLocale(['EN-us'])).toBe('en');
  });

  it('falls back to English when nothing matches', () => {
    expect(negotiateLocale([])).toBe(FALLBACK_LOCALE);
    expect(negotiateLocale(['fr', 'de', 'pt-BR'])).toBe(FALLBACK_LOCALE);
    expect(FALLBACK_LOCALE).toBe('en');
  });

  it('validates stored preferences', () => {
    expect(isLocaleCode('ja')).toBe(true);
    expect(isLocaleCode('system')).toBe(false);
    expect(isLocaleCode('fr')).toBe(false);
    expect(isLocaleCode(null)).toBe(false);
  });
});

describe('message catalogs', () => {
  for (const { code, catalog } of LOCALES) {
    describe(code, () => {
      const messages = catalog as Record<string, MessageValue>;
      it('has exactly the keys of the English catalog', () => {
        expect(Object.keys(messages).sort()).toEqual(Object.keys(english).sort());
      });
      it('uses the same placeholders as English and has no empty text', () => {
        for (const [key, source] of Object.entries(english)) {
          const expected = placeholders(typeof source === 'string' ? source : source.other);
          if (typeof source !== 'string') expected.add('count');
          for (const form of forms(messages[key])) {
            expect(form.trim(), key).not.toBe('');
            const actual = placeholders(form);
            if (typeof messages[key] === 'object') actual.add('count');
            expect([...actual].sort(), key).toEqual([...expected].sort());
          }
        }
      });
      it('only defines plural categories the language has', () => {
        const categories = new Set(new Intl.PluralRules(code).resolvedOptions().pluralCategories);
        for (const [key, value] of Object.entries(messages)) {
          if (typeof value === 'string') continue;
          expect(value.other, key).toBeTruthy();
          for (const category of Object.keys(value)) expect(category === 'other' || categories.has(category as Intl.LDMLPluralRule), `${key}.${category}`).toBe(true);
        }
      });
    });
  }
});

describe('translator', () => {
  it('interpolates parameters and formats numbers for the locale', () => {
    expect(createTranslator('en').t('error.timeout', { seconds: 1800 })).toBe('The request exceeded 1,800 seconds and was terminated.');
    expect(createTranslator('zh-CN').t('error.timeout', { seconds: 30 })).toBe('请求超过 30 秒，已终止。');
    expect(createTranslator('ja').t('endpoint.editAria', { id: 'A' })).toBe('エンドポイント A を編集');
  });

  it('selects plural forms with the language rules', () => {
    const en = createTranslator('en').t, es = createTranslator('es').t, zh = createTranslator('zh-CN').t;
    expect(en('monitor.active', { count: 1 })).toBe('1 request in progress');
    expect(en('monitor.active', { count: 3 })).toBe('3 requests in progress');
    expect(es('connect.modelCount', { count: 1 })).toBe('1 modelo');
    expect(es('connect.modelCount', { count: 2 })).toBe('2 modelos');
    expect(zh('monitor.active', { count: 1 })).toBe('1 请求进行中');
  });

  it('renders nested messages in the active language', () => {
    const nested = msg('error.counter.fallback', { reason: msg('error.counter.http', { status: 503 }) });
    expect(renderMessage('en', nested)).toBe('Counting API fell back to estimates: Counting API HTTP 503');
    expect(renderMessage('zh-CN', nested)).toBe('计数 API 已回退估算：计数 API HTTP 503');
  });

  it('leaves unknown placeholders visible instead of failing', () => {
    expect(renderMessage('en', { key: 'error.timeout' })).toBe('The request exceeded {seconds} seconds and was terminated.');
  });
});

describe('localized errors', () => {
  it('carry a language-neutral descriptor and an English message', () => {
    const error = new LocalizedError('error.timeout', { seconds: 30 });
    expect(error).toBeInstanceOf(Error);
    expect(error.msg).toEqual({ key: 'error.timeout', params: { seconds: 30 } });
    expect(error.message).toBe('The request exceeded 30 seconds and was terminated.');
  });

  it('describe anything that can be thrown', () => {
    expect(describeError(new LocalizedError('error.noStream'))).toEqual({ key: 'error.noStream' });
    expect(describeError(new TypeError('Failed to fetch'))).toEqual({ key: 'error.connection' });
    expect(describeError(new Error('upstream said no'))).toEqual({ key: 'error.raw', params: { text: 'upstream said no' } });
    expect(describeError('plain')).toEqual({ key: 'error.raw', params: { text: 'plain' } });
  });
});

describe('formatters', () => {
  it('follow the decimal and grouping conventions of the locale', () => {
    expect(createFormatters('en').n(1234.5)).toBe('1,234.5');
    expect(createFormatters('es').n(1234.5)).toBe('1234,5');
    expect(createFormatters('es').int(12345)).toBe('12.345');
    expect(createFormatters('ja').int(12345)).toBe('12,345');
  });

  it('show an em dash for missing values and switch between ms and s', () => {
    const { n, time } = createFormatters('en');
    expect(n(null)).toBe('—');
    expect(n(Number.NaN)).toBe('—');
    expect(time(undefined)).toBe('—');
    expect(time(250)).toBe('250 ms');
    expect(time(1500)).toBe('1.50 s');
    expect(createFormatters('es').time(1500)).toBe('1,50 s');
  });
});
