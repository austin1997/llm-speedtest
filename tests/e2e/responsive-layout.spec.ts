import { expect, test } from '@playwright/test';

const viewports = [
  { width: 1366, height: 600 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3440, height: 1440 },
];

async function frameFits(page: import('@playwright/test').Page) {
  const size = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
    viewportWidth: innerWidth, viewportHeight: innerHeight,
    contentWidth: document.querySelector('.app-shell')!.getBoundingClientRect().width,
  }));
  expect(size.width).toBeLessThanOrEqual(size.viewportWidth);
  expect(size.height).toBeLessThanOrEqual(size.viewportHeight + 1);
  expect(size.contentWidth / size.viewportWidth).toBeGreaterThanOrEqual(.94);
}

test('all three stages grow with the window and use the available canvas', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(viewports[0]);
  await page.goto('/');
  await page.getByLabel('深色主题').click();
  const goSizes: number[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await frameFits(page);
    const dimensions = await page.evaluate(() => {
      const go = document.querySelector('.go-button')!.getBoundingClientRect();
      const workspace = document.querySelector('.configuration-workspace')!.getBoundingClientRect();
      const parameters = document.querySelector('.parameter-grid')!.getBoundingClientRect();
      return { goWidth: go.width, goCenter: go.left + go.width / 2, width: innerWidth, parameterFill: parameters.height / workspace.height };
    });
    expect(Math.abs(dimensions.goCenter - dimensions.width / 2)).toBeLessThan(2);
    expect(dimensions.parameterFill).toBeGreaterThan(.65);
    const length = page.getByLabel('输入长度数值');
    await length.fill('32768');
    const fits = await length.evaluate(node => {
      const input = node as HTMLInputElement;
      const style = getComputedStyle(input);
      const context = document.createElement('canvas').getContext('2d')!;
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return context.measureText(input.value).width + 20 <= input.clientWidth;
    });
    expect(fits).toBe(true);
    await length.fill('1024');
    goSizes.push(dimensions.goWidth);
    if (viewport.width === 3440) await page.screenshot({ path: 'test-results/responsive-configuration-ultrawide.png' });
  }
  expect(goSizes[3]).toBeGreaterThan(goSizes[0] * 1.6);

  await page.setViewportSize(viewports[0]);
  await page.getByLabel('编辑端点 A', { exact: true }).click();
  await page.getByLabel('端点 A 地址', { exact: true }).fill('http://127.0.0.1:4174/dashboard');
  await page.getByLabel('并发请求数值').fill('3');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.output-window')).toHaveCount(3);
  await expect(page.locator('.output-window pre').first()).toContainText('流式输出');
  const gaugeSizes: number[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await frameFits(page);
    const grid = (await page.locator('.output-grid').boundingBox())!;
    const last = (await page.locator('.output-window').last().boundingBox())!;
    expect(Math.abs(last.x - grid.x)).toBeLessThan(2);
    expect(Math.abs(last.x + last.width - grid.x - grid.width)).toBeLessThan(2);
    gaugeSizes.push((await page.locator('.speed-gauge').boundingBox())!.width);
    if (viewport.width === 3440) await page.screenshot({ path: 'test-results/responsive-live-ultrawide.png' });
  }
  expect(gaugeSizes[3]).toBeGreaterThan(gaugeSizes[0] * 1.5);
  await page.getByRole('button', { name: '停止测试' }).click();
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();

  const rowHeights: number[] = [];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await frameFits(page);
    const fill = await page.locator('.results-panel').evaluate(node => {
      const panel = node.getBoundingClientRect();
      const table = node.querySelector('.summary-table')!.getBoundingClientRect();
      const note = node.querySelector('.result-note')!.getBoundingClientRect();
      return { ratio: table.height / panel.height, unusedBottom: panel.bottom - note.bottom, innerScroll: node.scrollHeight > node.clientHeight + 1 };
    });
    expect(fill.ratio).toBeGreaterThan(.6);
    expect(fill.unusedBottom).toBeLessThan(35);
    expect(fill.innerScroll).toBe(false);
    await expect(page.locator('.output-window').first()).toBeHidden();
    rowHeights.push((await page.locator('.summary-table tbody tr').first().boundingBox())!.height);
    if (viewport.width === 3440) await page.screenshot({ path: 'test-results/responsive-results-ultrawide.png' });
  }
  expect(rowHeights[3]).toBeGreaterThan(rowHeights[0] * 2);
  await page.getByLabel('查看输出详情').click();
  await expect(page.locator('.output-window')).toHaveCount(3);
  await expect(page.locator('.output-window').first()).toBeVisible();
  await frameFits(page);
});

test('resizing to tablet, small desktop and phone keeps controls accessible', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  for (const viewport of [{ width: 1100, height: 600 }, { width: 1000, height: 700 }, { width: 820, height: 1180 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await expect(page.getByLabel('开始测试', { exact: true })).toBeVisible();
    await expect(page.getByLabel('输入长度滑块')).toBeVisible();
    await page.getByLabel('输入长度数值').fill('2048');
    await expect(page.getByTestId('prompt-preview')).toContainText('benchmark records');
  }
});
