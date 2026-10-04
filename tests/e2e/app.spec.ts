import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page, request }) => { await request.get('http://127.0.0.1:4174/test/reset'); await page.goto('/'); });

async function configure(page: import('@playwright/test').Page, id = 'A', address = 'http://127.0.0.1:4174') {
  if (!(await page.getByLabel(`端点 ${id} 地址`, { exact: true }).isVisible())) await page.getByLabel(`编辑端点 ${id}`, { exact: true }).click();
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
  await page.locator('.parameter-options > summary').click();
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
  await page.getByLabel('编辑端点 A', { exact: true }).click();
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

test('keeps GO centered between the preview and sliders with collapsed endpoint summaries', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.getByLabel('端点 A 地址', { exact: true })).toBeHidden();
  await expect(page.locator('.endpoint-summary')).toContainText('qwen3.6:latest');
  const go = (await page.getByLabel('开始测试', { exact: true }).boundingBox())!;
  const preview = (await page.getByTestId('prompt-preview').boundingBox())!;
  const parameters = (await page.getByRole('region', { name: '测试参数', exact: true }).boundingBox())!;
  expect(Math.abs(go.x + go.width / 2 - 640)).toBeLessThan(2);
  expect(preview.x + preview.width).toBeLessThan(go.x);
  expect(parameters.x).toBeGreaterThan(go.x + go.width);
  expect(go.y + go.height).toBeLessThan(720);
  await configure(page);
  await page.getByLabel('编辑端点 A', { exact: true }).click();
  await expect(page.getByLabel('端点 A 地址', { exact: true })).toBeHidden();
  await expect(page.locator('.endpoint-summary')).toContainText('test-qwen');
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  await expect(page.getByLabel('端点 B 地址', { exact: true })).toBeHidden();
  await configure(page, 'B', 'http://127.0.0.1:4174/v1');
  await page.getByLabel('编辑端点 B', { exact: true }).click();
  await expect(page.locator('.endpoint-B .endpoint-summary')).toContainText('127.0.0.1:4174');
});

test('removes focus outlines on the heading and select without removing keyboard button feedback', async ({ page }) => {
  const heading = page.getByRole('heading', { name: '测量你的 LLM' });
  await heading.focus();
  expect(await heading.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none');
  await page.locator('.parameter-options > summary').click();
  const select = page.getByLabel('思考模式');
  await select.focus();
  expect(await select.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none');
  await select.selectOption('off');
  await expect(select).toHaveValue('off');
  const compare = page.getByRole('button', { name: 'A/B 对比' });
  await compare.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(compare).toBeFocused();
  const focusStyle = await compare.evaluate(node => { const style = getComputedStyle(node); return { outline: style.outlineStyle, color: style.outlineColor, text: style.color }; });
  expect(focusStyle.outline).toBe('solid');
  expect(focusStyle.color).toBe(focusStyle.text);
});

test('scrolls to the results after completion when viewing lower output windows', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await configure(page, 'A', 'http://127.0.0.1:4174/scroll');
  await page.getByLabel('并发请求数值').fill('8');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.output-window')).toHaveCount(8);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  const results = page.getByRole('region', { name: '本轮结果', exact: true });
  await expect(results).toBeVisible();
  await expect.poll(() => results.evaluate(node => Math.abs(node.getBoundingClientRect().top - 24))).toBeLessThan(3);
  await expect(results).toBeFocused();
  await page.getByRole('button', { name: '再次测试' }).click();
  await expect(page.getByLabel('开始测试', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});
