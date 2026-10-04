import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page, request }) => { await request.get('http://127.0.0.1:4174/test/reset'); await page.goto('/'); });

async function configure(page: import('@playwright/test').Page, id = 'A', address = 'http://127.0.0.1:4174') {
  await page.getByLabel(`端点 ${id} 地址`, { exact: true }).fill(address);
  await page.getByLabel(`端点 ${id} 模型`, { exact: true }).fill('test-qwen');
}

test('preview changes with the slider and sends its exact content in a single round', async ({ page, request }) => {
  await configure(page);
  const preview = page.getByTestId('prompt-preview');
  const before = await preview.textContent();
  await page.getByLabel('输入长度滑块').fill('4');
  await expect(page.getByLabel('输入长度数值')).toHaveValue('2048');
  const prompt = await preview.textContent();
  expect(prompt!.length).toBeGreaterThan(before!.length);
  await page.getByLabel('思考模式').selectOption('on');
  await page.getByLabel('端点 A API Key').fill('test-key-memory-only');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('button', { name: '再次测试' })).toBeVisible();
  const data = await (await request.get('http://127.0.0.1:4174/test/requests')).json();
  expect(data).toHaveLength(1);
  expect(data[0].body.messages[0].content).toBe(prompt);
  expect(data[0].body.think).toBe(true);
  await expect(page.locator('.output-window pre')).toContainText('先检查输入数据。');
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  expect(storage).not.toContain('test-key-memory-only');
  await page.getByRole('button', { name: '再次测试' }).click();
  await expect(preview).toHaveText(prompt!);
  await page.reload();
  await expect(page.getByLabel('端点 A API Key')).toHaveValue('');
});

test('compares two protocols with two concurrent windows each', async ({ page, request }) => {
  await configure(page);
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  await configure(page, 'B', 'http://127.0.0.1:4174/v1');
  await page.getByLabel('并发请求数值').fill('2');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.output-window')).toHaveCount(4);
  await expect(page.getByRole('button', { name: '再次测试' })).toBeVisible();
  const data = await (await request.get('http://127.0.0.1:4174/test/requests')).json();
  expect(data).toHaveLength(4);
  expect(new Set(data.map((r: any) => r.body.messages[0].content)).size).toBe(1);
  expect(Math.max(...data.map((r: any) => r.at)) - Math.min(...data.map((r: any) => r.at))).toBeLessThan(300);
  await expect(page.locator('.results-panel')).toContainText('B 相对 A');
  await page.getByLabel('深色主题').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/results-comparison.png', fullPage: true });
  expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
});

test('stops all requests and keeps the successful flow available after errors', async ({ page }) => {
  await configure(page, 'A', 'http://127.0.0.1:4174/slow');
  await page.getByLabel('并发请求数值').fill('2');
  await page.getByLabel('开始测试', { exact: true }).click();
  await page.getByRole('button', { name: '停止测试' }).click();
  await expect(page.getByRole('button', { name: '再次测试' })).toBeVisible();
  await expect(page.locator('.status-cancelled')).toHaveCount(2);
  await page.getByRole('button', { name: '再次测试' }).click();
  await configure(page, 'A', 'http://127.0.0.1:4174/error');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.status-error')).toHaveCount(2);
  await expect(page.locator('.request-error').first()).toContainText('503');
});

test('discovers models, applies themes, and fits narrow and enlarged viewports', async ({ page }) => {
  await configure(page);
  await page.getByLabel('连接端点 A 并获取模型').click();
  await expect(page.getByRole('status')).toContainText('支持思考');
  await page.getByLabel('深色主题').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/config-dark.png', fullPage: true });
  await page.getByLabel('浅色主题').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/config-light.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/config-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByLabel('开始测试', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/config-enlarged.png', fullPage: true });
});
