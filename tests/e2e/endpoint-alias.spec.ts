import { expect, test, type Page } from '@playwright/test';

async function configure(page: Page, id: 'A' | 'B', alias: string, path = '') {
  await page.getByLabel(`编辑端点 ${id}`, { exact: true }).click();
  await page.getByLabel(`端点 ${id} 别名`, { exact: true }).fill(alias);
  await page.getByLabel(`端点 ${id} 地址`, { exact: true }).fill(`http://127.0.0.1:4174${path}${id === 'B' ? '/v1' : ''}`);
  await page.getByLabel(`端点 ${id} 模型`, { exact: true }).fill('test-qwen');
  await page.getByLabel(`编辑端点 ${id}`, { exact: true }).click();
}

test('persists endpoint aliases and uses them across the race, monitors, and results without changing requests', async ({ page, request }) => {
  await request.get('http://127.0.0.1:4174/test/reset');
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await configure(page, 'A', '  本地 Qwen  ', '/race-fast');
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  await configure(page, 'B', '云端 Qwen', '/race-slow');
  await page.getByLabel('并发请求数值').fill('2');
  await page.reload();
  await expect(page.locator('.endpoint-A .endpoint-summary strong')).toHaveText('本地 Qwen');
  await expect(page.locator('.endpoint-B .endpoint-summary strong')).toHaveText('云端 Qwen');
  await expect(page.getByLabel('端点 A 别名', { exact: true })).toHaveValue('  本地 Qwen  ');
  await expect(page.getByLabel('端点 B 别名', { exact: true })).toHaveValue('云端 Qwen');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.endpoint-A .monitor-heading h2')).toHaveText('本地 Qwen');
  await expect(page.locator('.endpoint-B .monitor-heading h2')).toHaveText('云端 Qwen');
  await expect(page.locator('.race-A .race-identity')).toHaveText('本地 Qwen');
  await expect(page.locator('.race-B .race-identity')).toHaveText('云端 Qwen');
  await expect(page.getByRole('progressbar', { name: '本地 Qwen 输出进度（估算）' })).toBeVisible();
  await expect(page.getByRole('img', { name: '云端 Qwen 吞吐趋势' })).toBeVisible();
  await expect.poll(async () => (await (await request.get('http://127.0.0.1:4174/test/requests')).json()).length).toBe(4);
  const requests = await (await request.get('http://127.0.0.1:4174/test/requests')).json();
  for (const { body } of requests) {
    expect(body.model).toBe('test-qwen');
    expect(body).not.toHaveProperty('alias');
    expect(JSON.stringify(body)).not.toContain('Qwen');
  }
  await page.screenshot({ path: 'test-results/endpoint-alias-live.png' });
  await page.getByRole('button', { name: '停止测试' }).click();
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '本地 Qwen', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '云端 Qwen', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '云端 Qwen 相对 本地 Qwen', exact: true })).toBeVisible();
  await page.getByLabel('查看输出详情').click();
  await expect(page.locator('.endpoint-A .monitor-heading h2')).toHaveText('本地 Qwen');
  await expect(page.locator('.endpoint-B .monitor-heading h2')).toHaveText('云端 Qwen');
  await page.getByLabel('查看输出详情').click();
  await page.locator('.request-details > summary').click();
  await expect(page.locator('.request-details tbody tr td:first-child')).toHaveText(['本地 Qwen · 1', '本地 Qwen · 2', '云端 Qwen · 1', '云端 Qwen · 2']);
  await page.getByRole('button', { name: '再次测试' }).click();
  await page.getByLabel('编辑端点 A', { exact: true }).click();
  await expect(page.getByLabel('端点 A 别名', { exact: true })).toHaveValue('  本地 Qwen  ');
  await page.getByLabel('端点 A 别名', { exact: true }).fill('   ');
  await page.getByLabel('编辑端点 A', { exact: true }).click();
  await expect(page.locator('.endpoint-A .endpoint-summary strong')).toHaveText('test-qwen');
  // Previously saved configurations have no alias field.
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('llm-speedtest-config')!);
    for (const endpoint of stored.endpoints) delete endpoint.alias;
    localStorage.setItem('llm-speedtest-config', JSON.stringify(stored));
  });
  await page.reload();
  await expect(page.getByLabel('端点 A 别名', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('端点 B 别名', { exact: true })).toHaveValue('');
  await expect(page.locator('.endpoint-B .endpoint-summary strong')).toHaveText('test-qwen');
});

test('long aliases remain readable on hover and retain single-screen and mobile layouts', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 600 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const a = '这是一个较长的本地端点别名'.repeat(4);
  const b = 'Cloud inference '.repeat(4);
  await configure(page, 'A', a);
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  await configure(page, 'B', b);
  await expect(page.locator('.endpoint-A .endpoint-summary strong')).toHaveAttribute('title', a);
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.race-A .race-identity')).toHaveAttribute('title', a);
  await expect(page.locator('.endpoint-B .monitor-heading h2')).toHaveAttribute('title', b.trim());
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(601);
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  await expect(page.locator('.summary-table th:nth-child(2) .result-endpoint-name')).toHaveAttribute('title', a);
  await expect(page.locator('.summary-table th:nth-child(4) .result-endpoint-name')).toHaveAttribute('title', `${b.trim()} 相对 ${a}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(601);
  expect(await page.locator('.results-panel').evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/endpoint-alias-results.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: '再次测试' }).click();
  await expect(page.locator('.endpoint-A .endpoint-summary strong')).toHaveText(a);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
