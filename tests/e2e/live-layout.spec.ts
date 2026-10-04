import { expect, test } from '@playwright/test';

const scenarios = [
  { name: 'laptop-single', width: 1280, height: 720, concurrency: 1, compare: false },
  { name: 'laptop-comparison', width: 1366, height: 650, concurrency: 4, compare: true },
  { name: 'compact-max-concurrency', width: 1366, height: 600, concurrency: 16, compare: true },
  { name: 'desktop-comparison', width: 1920, height: 1080, concurrency: 8, compare: true },
  { name: 'single-max-concurrency', width: 1440, height: 900, concurrency: 16, compare: false },
];

for (const scenario of scenarios) {
  test(`live dashboard fits without page scrolling: ${scenario.name}`, async ({ page }) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByLabel('深色主题').click();
    await page.getByLabel('编辑端点 A', { exact: true }).click();
    await page.getByLabel('端点 A 地址', { exact: true }).fill('http://127.0.0.1:4174/dashboard');
    await page.getByLabel('端点 A 模型', { exact: true }).fill('test-qwen');
    if (scenario.compare) {
      await page.getByRole('button', { name: 'A/B 对比' }).click();
      await page.getByLabel('编辑端点 B', { exact: true }).click();
      await page.getByLabel('端点 B 地址', { exact: true }).fill('http://127.0.0.1:4174/dashboard/v1');
      await page.getByLabel('端点 B 模型', { exact: true }).fill('test-qwen');
    }
    await page.getByLabel('并发请求数值').fill(String(scenario.concurrency));
    await page.getByLabel('开始测试', { exact: true }).click();
    const count = scenario.concurrency * (scenario.compare ? 2 : 1);
    await expect(page.locator('.output-window')).toHaveCount(count);
    const firstOutput = page.locator('.output-window pre').first();
    await expect(firstOutput).toContainText('流式输出');
    await expect.poll(() => firstOutput.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);

    const geometry = await page.evaluate(() => {
      const selectors = '.site-header, .phase-nav, .page-heading, .run-config-strip, .monitor-heading, .speed-gauge, .gauge-source, .metric-grid, .trend, .output-window, .site-footer';
      const outside = [...document.querySelectorAll(selectors)].filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width <= 0 || rect.height <= 0 || rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1;
      }).map(node => node.className);
      const outputHeights = [...document.querySelectorAll('.output-window pre')].map(node => node.getBoundingClientRect().height);
      const readable = [...document.querySelectorAll('.output-window pre')].every(node => { const style = getComputedStyle(node); return node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) >= parseFloat(style.lineHeight); });
      const dimensions = [...document.querySelectorAll('.monitor, .monitor-overview, .monitor-heading, .output-grid, .output-window:first-child header, .output-window:first-child footer')].map(node => ({ element: node.className || node.tagName, height: node.getBoundingClientRect().height }));
      return { outside, outputHeights, readable, dimensions, height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth, viewportHeight: innerHeight, viewportWidth: innerWidth };
    });
    expect(geometry.outside).toEqual([]);
    expect(geometry.height).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    expect(geometry.width).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(Math.min(...geometry.outputHeights), JSON.stringify(geometry.dimensions)).toBeGreaterThanOrEqual(18);
    expect(geometry.readable, JSON.stringify(geometry.dimensions)).toBe(true);
    await firstOutput.evaluate(node => { node.scrollTop = 0; });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: `test-results/live-${scenario.name}.png` });

    if (!scenario.compare) {
      await page.getByRole('button', { name: '连接指南' }).click();
      await expect(page.getByRole('heading', { name: '浏览器直连指南' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(scenario.height + 1);
      await page.getByLabel('关闭连接指南').click();
    }
    await page.getByRole('button', { name: '停止测试' }).click();
    await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  });
}

test('narrow live layouts keep readable output and all requests accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('编辑端点 A', { exact: true }).click();
  await page.getByLabel('端点 A 地址', { exact: true }).fill('http://127.0.0.1:4174/dashboard');
  await page.getByLabel('并发请求数值').fill('4');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.output-window')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(await page.locator('.output-window pre').first().evaluate(node => node.clientHeight)).toBeGreaterThan(100);
  await page.locator('.output-window').last().scrollIntoViewIfNeeded();
  await expect(page.locator('.output-window').last()).toBeInViewport();
  await page.getByRole('button', { name: '停止测试' }).click();
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
});
