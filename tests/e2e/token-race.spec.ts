import { expect, test } from '@playwright/test';

async function configure(page: import('@playwright/test').Page, a: string, b: string, concurrency = 1) {
  await page.goto('/');
  await page.getByLabel('编辑端点 A', { exact: true }).click();
  await page.getByLabel('端点 A 地址', { exact: true }).fill(`http://127.0.0.1:4174${a}`);
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  await page.getByLabel('编辑端点 B', { exact: true }).click();
  await page.getByLabel('端点 B 地址', { exact: true }).fill(`http://127.0.0.1:4174${b}/v1`);
  await page.getByLabel('并发请求数值').fill(String(concurrency));
  await page.getByLabel('输出上限数值').fill('256');
}

test('wide comparison cars use their own throughput and shared output budget', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await configure(page, '/race-fast', '/race-slow', 2);
  await page.getByLabel('深色主题').click();
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByRole('region', { name: '双端点输出竞速' })).toBeVisible();
  const a = page.locator('.race-row.race-A');
  const b = page.locator('.race-row.race-B');
  await expect(a).toHaveAttribute('data-budget', '512');
  await expect(b).toHaveAttribute('data-budget', '512');
  await expect.poll(async () => Number(await b.getAttribute('data-generated'))).toBeGreaterThan(0);
  const state = await page.evaluate(() => [...document.querySelectorAll('.race-row')].map(node => ({ generated: Number(node.getAttribute('data-generated')), speed: Number(node.getAttribute('data-speed')), progress: Number(node.getAttribute('data-progress')) })));
  expect(state[0].generated).toBeGreaterThan(state[1].generated);
  expect(state[0].speed).toBeGreaterThan(state[1].speed);
  expect(state[0].progress).toBeCloseTo(Math.min(1, state[0].generated / 512));
  const before = Number(await a.getAttribute('data-progress'));
  await expect.poll(async () => Number(await a.getAttribute('data-progress'))).toBeGreaterThan(before);
  await page.screenshot({ path: 'test-results/token-race-wide.png' });
  const boxes = await page.locator('.race-car').all();
  expect((await boxes[0].boundingBox())!.x).toBeGreaterThan((await boxes[1].boundingBox())!.x);
  await page.getByRole('button', { name: '停止测试' }).click();
  await expect(a).toHaveAttribute('data-state', 'cancelled');
  await expect(a).toHaveAttribute('data-speed', '0');
  await expect(page.locator('.race-car[data-moving]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  await expect(page.locator('.token-race')).toHaveCount(0);
});

test('completed cars stop short instead of inventing output to reach the finish', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await configure(page, '', '');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByRole('button', { name: '测试结束', exact: true })).toBeVisible();
  for (const id of ['A', 'B']) {
    const row = page.locator(`.race-${id}`);
    await expect(row).toHaveAttribute('data-state', 'early');
    await expect(row).toHaveAttribute('data-speed', '0');
    const fraction = Number(await row.getAttribute('data-progress'));
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);
  }
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
});

test('narrow windows hide the race and reduced motion avoids extra animation', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await configure(page, '/race-fast', '/race-slow');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.race-car[data-moving]').first()).toBeVisible();
  expect(await page.locator('.race-car').first().evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
  expect(await page.locator('.race-car').first().evaluate(node => getComputedStyle(node, '::before').animationName)).toBe('none');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.token-race')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: '停止测试' }).click();
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
});
