import { expect, test, type Page } from '@playwright/test';

const HAN = /[\u4e00-\u9fff]/;
const STORAGE_KEY = 'llm-speedtest-locale';

/** Browser language -> expected interface language, heading and a sample of translated chrome. */
const cases = [
  { browser: 'en-US', lang: 'en', heading: 'Measure your LLM', start: 'Start test' },
  { browser: 'zh-CN', lang: 'zh-CN', heading: '测量你的 LLM', start: '开始测试' },
  { browser: 'zh-HK', lang: 'zh-TW', heading: '測量你的 LLM', start: '開始測試' },
  { browser: 'ja-JP', lang: 'ja', heading: 'LLM の速度を測定', start: 'テスト開始' },
  { browser: 'ko-KR', lang: 'ko', heading: 'LLM 속도를 측정하세요', start: '테스트 시작' },
  { browser: 'es-MX', lang: 'es', heading: 'Mide tu LLM', start: 'Iniciar prueba' },
  { browser: 'fr-FR', lang: 'en', heading: 'Measure your LLM', start: 'Start test' },
];

const switcher = (page: Page) => page.locator('.lang-switch select');
const heading = (page: Page) => page.getByRole('heading', { level: 1 });

for (const { browser, lang, heading: title, start } of cases) {
  test.describe(`browser language ${browser}`, () => {
    test.use({ locale: browser });

    test(`defaults to ${lang}`, async ({ page }) => {
      await page.goto('/');
      await expect(heading(page)).toHaveText(title);
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page.getByLabel(start, { exact: true })).toBeVisible();
      await expect(switcher(page)).toHaveValue('system');
      await expect(page.locator('.lang-switch-name')).toHaveText(await page.locator(`.lang-switch option[value="${lang}"]`).textContent() as string);
      expect(await page.locator('meta[name="description"]').getAttribute('content')).toBeTruthy();
      // Nothing is stored until the user makes an explicit choice.
      expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
      // No untranslated Chinese is left in the page (the language menu itself lists endonyms).
      if (['en', 'es', 'ko'].includes(lang)) expect((await page.locator('main, nav, footer, .help-button, .theme-switch').allInnerTexts()).join('\n')).not.toMatch(HAN);
    });
  });
}

test.describe('manual switching', () => {
  test.use({ locale: 'en-US' });

  test('overrides the browser language, persists across reloads and can return to automatic', async ({ page }) => {
    await page.goto('/');
    const control = page.getByRole('combobox', { name: 'Interface language' });
    await expect(control).toHaveValue('system');
    await expect(control.locator('option').first()).toHaveText('Auto (English)');
    await expect(control.locator('option')).toHaveText(['Auto (English)', 'English', '简体中文', '繁體中文', '日本語', '한국어', 'Español']);

    await control.selectOption('ja');
    await expect(heading(page)).toHaveText('LLM の速度を測定');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
    expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe('ja');

    await page.reload();
    await expect(heading(page)).toHaveText('LLM の速度を測定');
    await expect(switcher(page)).toHaveValue('ja');
    await expect(page.locator('.lang-switch option').first()).toHaveText('自動（English）');

    await switcher(page).selectOption('system');
    await expect(heading(page)).toHaveText('Measure your LLM');
    expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBeNull();
    await page.reload();
    await expect(heading(page)).toHaveText('Measure your LLM');
  });

  test('ignores an unknown stored value and follows the browser again', async ({ page }) => {
    await page.addInitScript(key => localStorage.setItem(key, 'klingon'), STORAGE_KEY);
    await page.goto('/');
    await expect(heading(page)).toHaveText('Measure your LLM');
    await expect(switcher(page)).toHaveValue('system');
  });

  test('automatic mode follows a language change in the browser while an explicit choice does not', async ({ page }) => {
    await page.goto('/');
    const changeBrowserLanguage = (languages: string[]) => page.evaluate(list => {
      Object.defineProperty(navigator, 'languages', { value: list, configurable: true });
      window.dispatchEvent(new Event('languagechange'));
    }, languages);
    await changeBrowserLanguage(['ko-KR', 'en']);
    await expect(heading(page)).toHaveText('LLM 속도를 측정하세요');
    await expect(page.locator('.lang-switch option').first()).toHaveText('자동 (한국어)');
    await switcher(page).selectOption('es');
    await changeBrowserLanguage(['ja']);
    await expect(heading(page)).toHaveText('Mide tu LLM');
  });

  test('localizes dialogs and keeps the selector usable from the keyboard', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Connection guide' }).click();
    await expect(page.getByRole('heading', { name: 'Direct browser connection guide' })).toBeVisible();
    await expect(page.locator('.guide-grid code').first()).toHaveText('http://localhost:11434');
    await expect(page.locator('.guide-grid p').first()).toContainText('add the full origin of the site to OLLAMA_ORIGINS');
    await switcher(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.lang-switch')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close connection guide' })).toBeVisible();
    const outline = await page.locator('.lang-switch').evaluate(node => getComputedStyle(node).outlineStyle);
    expect(outline).toBe('solid');
  });
});

test.describe('live content follows the language', () => {
  test.use({ locale: 'zh-CN' });

  async function configure(page: Page, path: string) {
    await page.goto('/');
    await page.locator('.endpoint-A > summary').click();
    await page.locator('.endpoint-A .endpoint-editor input').nth(1).fill(`http://127.0.0.1:4174${path}`);
    await page.locator('.endpoint-A .endpoint-editor input').nth(2).fill('test-qwen');
    await page.locator('.endpoint-A > summary').click();
  }

  test('re-renders results, stored errors and number formats when the language changes', async ({ page, request }) => {
    await request.get('http://127.0.0.1:4174/test/reset');
    await configure(page, '');
    await page.locator('.go-button').click();
    await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.summary-table')).toContainText('平均总耗时');

    await switcher(page).selectOption('en');
    await expect(page.getByRole('region', { name: 'Run results', exact: true })).toBeVisible();
    await expect(page.locator('.summary-table')).toContainText('Mean total time');
    await expect(page.locator('.summary-table')).toContainText('Succeeded / failed / stopped');
    await expect(page.getByRole('button', { name: 'Test again' })).toBeVisible();
    await expect(page.locator('.request-details summary')).toContainText('View per-request usage and server data');
    await expect(page.locator('.run-config-strip')).toContainText('Input ≈ 1,024');

    await switcher(page).selectOption('es');
    await expect(page.locator('.run-config-strip')).toContainText('Entrada ≈ 1024');
    await expect(page.locator('.summary-table')).toContainText('Tiempo total medio');
    await expect(page.locator('.summary-table')).not.toContainText('Mean total time');
  });

  test('renders a stored request error in the language chosen afterwards', async ({ page, request }) => {
    await request.get('http://127.0.0.1:4174/test/reset');
    await configure(page, '/error');
    await page.locator('.go-button').click();
    const error = page.locator('.request-error').first();
    await expect(error).toHaveText('HTTP 503：fixture overloaded');
    await switcher(page).selectOption('en');
    await expect(error).toHaveText('HTTP 503: fixture overloaded');
    await switcher(page).selectOption('ja');
    await expect(error).toHaveText('HTTP 503: fixture overloaded');
  });

  test('reports validation errors in the active language', async ({ page }) => {
    await page.goto('/');
    await page.locator('.endpoint-A > summary').click();
    await page.locator('.endpoint-A .endpoint-editor input').nth(2).fill('');
    await page.locator('.go-button').click();
    await expect(page.locator('.launch-error')).toHaveText('请填写端点 A 的模型名称。');
    await switcher(page).selectOption('es');
    await expect(page.locator('.launch-error')).toHaveText('Indica el nombre del modelo del endpoint A.');
  });
});
