import { expect, test } from '@playwright/test';

async function configure(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByLabel('编辑端点 A', { exact: true }).click();
  await page.getByLabel('端点 A 地址', { exact: true }).fill('http://127.0.0.1:4174');
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  await page.getByLabel('编辑端点 B', { exact: true }).click();
  await page.getByLabel('端点 B 地址', { exact: true }).fill('http://127.0.0.1:4174/v1');
  await page.getByLabel('并发请求数值').fill('2');
}

test('final browser decode uses actual tokens, exposes calculation times, and keeps stage rates separate', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await configure(page);
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  const decode = page.locator('.summary-table tbody tr').filter({ hasText: '浏览器 decode' });
  await expect(decode.locator('td').nth(1)).toContainText('实测');
  await expect(decode.locator('td').nth(2)).toContainText('实测');
  await expect(decode).not.toContainText('估算');
  const overall = page.locator('.summary-table tbody tr').filter({ hasText: '整轮吞吐' });
  await expect(overall.locator('td').nth(1)).toContainText('实际 token · 浏览器计时');
  await expect(overall.locator('td').nth(1)).toHaveAttribute('title', /成功输出 48 token/);
  await page.locator('.request-details > summary').click();
  const rows = page.locator('.request-details tbody tr');
  await expect(rows).toHaveCount(4);
  for (const row of await rows.all()) {
    const cells = row.locator('td');
    await expect(cells.nth(4)).toHaveText('24');
    const rate = parseFloat((await cells.nth(7).textContent())!);
    const rawTime = (await cells.nth(8).textContent())!;
    const milliseconds = parseFloat(rawTime.replaceAll(',', '')) * (rawTime.endsWith('ms') ? 1 : 1000);
    expect(rate).toBeCloseTo(24 * 1000 / milliseconds, 0);
  }
  await expect(rows.first().locator('td').nth(9)).toHaveText('30.0 tok/s');
  await expect(rows.first().locator('td').nth(10)).toHaveAttribute('title', 'eval_duration = 800,000,000 ns');
  await expect(rows.first().locator('td').nth(11)).toHaveText('1,010.0 tok/s');
  await expect(rows.first().locator('td').nth(12)).toHaveAttribute('title', 'prompt_eval_duration = 100,000,000 ns');
  await page.locator('.request-details > summary').click();
  await page.getByLabel('查看输出详情').click();
  const card = page.locator('.endpoint-A .metric-card').filter({ hasText: '浏览器 decode' });
  await expect(card.locator('.source')).toHaveText('浏览器测量');
});

test('missing final usage stays estimated and incompatible decode sources are not compared', async ({ page }) => {
  await configure(page);
  await page.locator('.endpoint-B .advanced > summary').click();
  await page.getByLabel('请求流式 usage', { exact: true }).uncheck();
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  const decode = page.locator('.summary-table tbody tr').filter({ hasText: '浏览器 decode' });
  await expect(decode.locator('td').nth(1)).toContainText('实测');
  await expect(decode.locator('td').nth(2)).toContainText('估算');
  await expect(decode.locator('.comparison-cell')).toHaveText('口径不同或数据不足');
  const overall = page.locator('.summary-table tbody tr').filter({ hasText: '整轮吞吐' });
  await expect(overall.locator('td').nth(2)).toContainText('估算 token · 浏览器计时');
});
