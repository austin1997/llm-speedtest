import { expect, test, type Page } from '@playwright/test';

/** Longer languages must not break the viewport-fitted layouts that were tuned for Chinese. */
const languages = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es'];
const viewports = [
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'mobile', width: 390, height: 844 },
];

/** Text that is cut off without an ellipsis, or content that spills outside the viewport. */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > innerWidth) problems.push(`page scrolls horizontally (${root.scrollWidth} > ${innerWidth})`);
    if (innerWidth >= 1100 && innerHeight >= 600 && root.scrollHeight > innerHeight + 1) problems.push(`page scrolls vertically (${root.scrollHeight} > ${innerHeight})`);
    const name = (element: Element) => `${element.tagName.toLowerCase()}${typeof element.className === 'string' && element.className ? '.' + element.className.trim().split(/\s+/).join('.') : ''} "${(element.textContent ?? '').trim().slice(0, 48)}"`;
    // Content of a closed <details> is not rendered, whatever stale geometry it reports.
    const folded = (element: Element) => {
      for (let details = element.closest('details'); details; details = details.parentElement?.closest('details') ?? null) {
        if (!details.open && !details.querySelector(':scope > summary')?.contains(element)) return true;
      }
      return false;
    };
    for (const element of document.querySelectorAll('body *')) {
      if (folded(element)) continue;
      // The phase connectors are absolutely positioned pseudo-elements that extend scrollWidth by design.
      if (element.closest('svg, .table-scroll, pre, datalist, option, select, .phase-nav')) continue;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (rect.right > innerWidth + 1 || rect.left < -1) problems.push(`outside the viewport: ${name(element)}`);
      const hasOwnText = [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      const clips = style.overflowX === 'hidden' || style.overflowX === 'clip';
      if (hasOwnText && clips && style.textOverflow !== 'ellipsis' && element.scrollWidth > element.clientWidth + 1) problems.push(`clipped text: ${name(element)}`);
      if (hasOwnText && style.whiteSpace === 'nowrap' && style.overflowX === 'visible' && element.scrollWidth > element.clientWidth + 1) problems.push(`overflowing nowrap text: ${name(element)}`);
    }
    return problems;
  });
}

async function check(page: Page, found: string[], stage: string, language: string, viewport: string) {
  found.push(...(await layoutProblems(page)).map(problem => `${stage}: ${problem}`));
  await page.screenshot({ path: `test-results/i18n-${language}-${viewport}-${stage}.png`, fullPage: viewport === 'mobile' });
}

const inputs = (page: Page, id: 'A' | 'B') => page.locator(`.endpoint-${id} .endpoint-editor input`);
async function point(page: Page, id: 'A' | 'B', address: string) {
  await page.locator(`.endpoint-${id} > summary`).click();
  await inputs(page, id).nth(1).fill(`http://127.0.0.1:4174${address}`);
  await inputs(page, id).nth(2).fill('test-qwen');
  await page.locator(`.endpoint-${id} > summary`).click();
}

test.describe.configure({ timeout: 90000 });

for (const language of languages) {
  for (const viewport of viewports) {
    test(`${language} fits every stage at ${viewport.name}`, async ({ page, request }) => {
      await request.get('http://127.0.0.1:4174/test/reset');
      await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['llm-speedtest-locale', language]);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const found: string[] = [];
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await page.locator('.compare-toggle').click();
      await point(page, 'A', '/race-fast');
      await point(page, 'B', '/race-slow/v1');
      await check(page, found, 'config', language, viewport.name);

      await page.locator('.go-button').click();
      await expect(page.locator('.running-shell')).toBeVisible();
      await expect(page.locator('.output-window pre').first()).not.toBeEmpty({ timeout: 5000 });
      await page.waitForTimeout(800);
      await check(page, found, 'live', language, viewport.name);
      await page.locator('.stop-button').click();
      await expect(page.locator('.results-panel')).toBeVisible({ timeout: 10000 });
      await check(page, found, 'results-stopped', language, viewport.name);

      await page.locator('.primary-button').click();
      await point(page, 'A', '');
      await point(page, 'B', '/v1');
      await page.locator('.go-button').click();
      await expect(page.locator('.results-panel')).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(400);
      await check(page, found, 'results', language, viewport.name);
      await page.locator('.request-details summary').click();
      await check(page, found, 'results-details', language, viewport.name);
      await page.locator('.request-details summary').click();
      await page.locator('.output-details > summary').click();
      await expect(page.locator('.output-details .output-window').first()).toBeVisible();
      await check(page, found, 'results-output', language, viewport.name);
      expect([...new Set(found)], `${language} at ${viewport.name}`).toEqual([]);
    });
  }
}
