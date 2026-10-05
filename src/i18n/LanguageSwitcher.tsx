import { ChevronDown, Languages } from 'lucide-react';
import { useI18n, type LocalePreference } from './I18nProvider';
import { LOCALES, localeName } from './locales';

/**
 * A compact pill that shows the active language. The real control is a native <select> laid over it,
 * so keyboard, screen reader and mobile pickers work without any custom menu logic.
 */
export default function LanguageSwitcher() {
  const { t, locale, preference, systemLocale, setPreference } = useI18n();
  return <div className="lang-switch" data-auto={preference === 'system' || undefined}>
    <Languages size={16} aria-hidden="true" />
    <span className="lang-switch-name" lang={locale}>{localeName(locale)}</span>
    <ChevronDown className="lang-switch-chevron" size={13} aria-hidden="true" />
    <select aria-label={t('lang.label')} title={t('lang.label')} value={preference} onChange={event => setPreference(event.target.value as LocalePreference)}>
      <option value="system">{t('lang.auto', { language: localeName(systemLocale) })}</option>
      {LOCALES.map(({ code, name }) => <option key={code} value={code} lang={code}>{name}</option>)}
    </select>
  </div>;
}
