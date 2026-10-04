import { expect, test } from '@playwright/test';

async function geometry(page: import('@playwright/test').Page, selector: string) {
  return page.evaluate(selector => {
    const outside = [...document.querySelectorAll(selector)].filter(node => {
      const r = node.getBoundingClientRect();
      return r.width <= 0 || r.height <= 0 || r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1;
    }).map(node => node.className || node.tagName);
    return { outside, height: document.documentElement.scrollHeight, viewport: innerHeight, width: document.documentElement.scrollWidth, viewportWidth: innerWidth };
  }, selector);
}

for (const scenario of [
  { name: 'compact-single', width: 1366, height: 600, compare: false },
  { name: 'compact-comparison', width: 1366, height: 600, compare: true },
  { name: 'laptop-comparison', width: 1280, height: 720, compare: true },
  { name: 'desktop-comparison', width: 1920, height: 1080, compare: true },
]) {
  test(`configuration and default results fit one screen: ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByLabel('深色主题').click();
    if (scenario.compare) await page.getByRole('button', { name: 'A/B 对比' }).click();
    const config = await geometry(page, '.site-header, .phase-nav, .page-heading, .preview-panel, .go-button, .parameters-panel, .endpoint-settings, .site-footer');
    expect(config.outside).toEqual([]);
    expect(config.height).toBeLessThanOrEqual(config.viewport + 1);
    expect(config.width).toBeLessThanOrEqual(config.viewportWidth);
    const endpoints = (await page.locator('.endpoint-settings').boundingBox())!;
    for (const selector of ['.preview-panel', '.parameters-panel']) {
      const panel = (await page.locator(selector).boundingBox())!;
      expect(panel.y + panel.height).toBeLessThanOrEqual(endpoints.y - 8);
    }
    await page.screenshot({ path: `test-results/config-screen-${scenario.name}.png` });

    for (const id of scenario.compare ? ['A', 'B'] : ['A']) {
      await page.getByLabel(`编辑端点 ${id}`, { exact: true }).click();
      await page.getByLabel(`端点 ${id} 地址`, { exact: true }).fill(`http://127.0.0.1:4174${id === 'B' ? '/v1' : ''}`);
      await page.getByLabel(`端点 ${id} 模型`, { exact: true }).fill('test-qwen');
      const editor = await geometry(page, `.endpoint-${id} .endpoint-editor`);
      expect(editor.outside).toEqual([]);
      expect(editor.height).toBeLessThanOrEqual(editor.viewport + 1);
      await page.getByLabel(`编辑端点 ${id}`, { exact: true }).click();
    }
    await page.locator('.parameter-options > summary').click();
    const options = await geometry(page, '.secondary-parameters');
    expect(options.outside).toEqual([]);
    expect(options.height).toBeLessThanOrEqual(options.viewport + 1);
    await page.getByLabel('思考模式').selectOption('on');
    await page.locator('.parameter-options > summary').click();
    await page.getByLabel('并发请求数值').fill('2');
    await page.getByLabel('开始测试', { exact: true }).click();
    const results = page.getByRole('region', { name: '本轮结果', exact: true });
    await expect(results).toBeVisible();
    await expect(page.locator('.output-window').first()).toBeHidden();
    await expect(page.locator('.request-details')).not.toHaveAttribute('open');
    const result = await geometry(page, '.site-header, .phase-nav, .page-heading, .run-config-strip, .results-panel, .summary-table, .stat-ranges, .result-disclosures, .result-note, .site-footer');
    expect(result.outside).toEqual([]);
    expect(result.height).toBeLessThanOrEqual(result.viewport + 1);
    expect(await results.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
    await expect(page.locator('.summary-table tbody tr')).toHaveCount(8);
    await page.screenshot({ path: `test-results/results-screen-${scenario.name}.png` });

    await page.getByLabel('查看输出详情').click();
    await expect(page.locator('.output-details .benchmark-dashboard')).toBeVisible();
    await expect(page.locator('.output-window')).toHaveCount(scenario.compare ? 4 : 2);
    expect(await page.locator('.output-details .monitor-overview').first().evaluate(node => getComputedStyle(node).display)).toBe('grid');
    expect(await page.locator('.output-details .speed-gauge').first().evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThanOrEqual(176);
    await expect(page.locator('.output-window pre').first()).toContainText('先检查输入数据。');
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(scenario.height + 1);
    await page.getByLabel('查看输出详情').click();
    await expect(page.locator('.output-window').first()).toBeHidden();
    await page.getByRole('button', { name: '再次测试' }).click();
    await expect(page.getByLabel('思考模式')).toHaveValue('on');
  });
}

test('folded results retain all 32 outputs and request usage when expanded', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 600 });
  await page.goto('/');
  await page.getByLabel('编辑端点 A', { exact: true }).click();
  await page.getByLabel('端点 A 地址', { exact: true }).fill('http://127.0.0.1:4174');
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  await page.getByLabel('编辑端点 B', { exact: true }).click();
  await page.getByLabel('端点 B 地址', { exact: true }).fill('http://127.0.0.1:4174/v1');
  await page.getByLabel('并发请求数值').fill('16');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  await expect(page.locator('.output-window').first()).toBeHidden();
  await page.getByLabel('查看输出详情').click();
  await expect(page.locator('.output-window')).toHaveCount(32);
  await expect(page.locator('.status-success')).toHaveCount(32);
  await page.getByLabel('查看输出详情').click();
  await page.locator('.request-details > summary').click();
  await expect(page.locator('.request-details tbody tr')).toHaveCount(32);
  await expect(page.locator('.request-details tbody')).toContainText('24');
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(601);
});
