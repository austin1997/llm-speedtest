import { expect, test, type Page } from '@playwright/test';

async function configure(page: Page, path: string, usage = true) {
  await page.goto('/');
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  await page.getByLabel('编辑端点 A', { exact: true }).click();
  await page.getByLabel('端点 A 地址', { exact: true }).fill('http://127.0.0.1:4174');
  await page.getByLabel('编辑端点 B', { exact: true }).click();
  await page.getByLabel('端点 B 地址', { exact: true }).fill(`http://127.0.0.1:4174${path}/v1`);
  await page.getByLabel('端点 B API Key', { exact: true }).fill('test-counter-memory-key');
  await page.locator('.endpoint-B .advanced > summary').click();
  await page.getByLabel('请求流式 usage', { exact: true }).setChecked(usage);
  await page.getByLabel('并发请求数值').fill('2');
}

test.beforeEach(async ({ request }) => { await request.get('http://127.0.0.1:4174/test/reset'); });

test('automatically detects tokenization and calibrates full prefixes in batches for the race and live gauge', async ({ page, request }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await configure(page, '/token-api');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.endpoint-B .speed-gauge')).toHaveAttribute('data-source', 'calibrated');
  await expect.poll(async () => Number(await page.locator('.endpoint-B .output-window').first().getAttribute('data-counted-tokens'))).toBeGreaterThan(0);
  const progress = await page.locator('.race-B').evaluate(node => ({ tokens: Number(node.getAttribute('data-tokens')), estimate: Number(node.getAttribute('data-generated')) }));
  expect(progress.tokens).toBeGreaterThan(progress.estimate);
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  const calls = await (await request.get('http://127.0.0.1:4174/test/token-requests')).json();
  const live = calls.filter((call: any) => call.text.startsWith('abcd'));
  expect(live.length).toBeGreaterThan(0); expect(live.length).toBeLessThanOrEqual(6);
  expect(live[0].text.length).toBe(128); // Eight small chunks form the first 32-token estimate.
  expect(live.every((call: any) => call.body.add_special_tokens === false && call.hasAuth)).toBe(true);
  expect(live.every((call: any) => call.text === 'abcd'.repeat(call.text.length / 4))).toBe(true);
  const queries = await (await request.get('http://127.0.0.1:4174/test/requests')).json();
  expect(queries).toHaveLength(4);
  expect(Math.max(...queries.map((r: any) => r.at)) - Math.min(...queries.map((r: any) => r.at))).toBeLessThan(300);
  const stored = await page.evaluate(() => localStorage.getItem('llm-speedtest-config')!);
  expect(stored).not.toContain('test-counter-memory-key'); expect(stored).not.toContain('tokenCounter');
  await page.getByRole('button', { name: '再次测试' }).click();
  await page.getByLabel('编辑端点 B', { exact: true }).click();
  await expect(page.locator('.endpoint-B .token-counter-setting')).toContainText('端点原文本分词');
});

for (const kind of ['token-llama', 'token-versioned', 'token-responses']) {
  test(`supports ${kind} and preserves final text counts without usage`, async ({ page, request }) => {
    await page.setViewportSize({ width: 1366, height: 600 });
    await configure(page, `/${kind}`, false);
    await page.getByLabel('端点 B 校准间隔').fill('64');
    await page.getByLabel('开始测试', { exact: true }).click();
    await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
    const windows = page.locator('.endpoint-B .output-window');
    await expect(windows).toHaveCount(2);
    for (const window of await windows.all()) {
      await expect(window).toHaveAttribute('data-counted-tokens', '192');
      await expect(window).toHaveAttribute('data-counted-chars', '192');
      await expect(window).toHaveAttribute('data-token-source', kind === 'token-responses' ? 'calibrated' : 'counted');
    }
    const calls = await (await request.get('http://127.0.0.1:4174/test/token-requests')).json();
    const live = calls.filter((call: any) => call.text.startsWith('abcd'));
    expect(live.length).toBeGreaterThan(0); expect(live.length).toBeLessThanOrEqual(2); // Final batch below the initial threshold.
    if (kind === 'token-responses') expect(live.every((call: any) => call.body.input[0].role === 'assistant')).toBe(true);
    if (kind === 'token-llama') expect(live.every((call: any) => call.body.add_special === false && call.body.parse_special === false)).toBe(true);
    const row = page.locator('.summary-table tbody tr').filter({ hasText: '整轮吞吐' });
    await expect(row.locator('td').nth(2)).toContainText(kind === 'token-responses' ? '校准 token' : '分词 token');
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(601);
    await page.getByRole('button', { name: '再次测试' }).click();
    await page.getByLabel('编辑端点 B', { exact: true }).click();
    await page.locator('.endpoint-B .advanced > summary').click();
    await expect(page.getByLabel('端点 B 校准间隔')).toHaveValue('64');
  });
}

test('count API failure falls back without failing or retrying inference', async ({ page, request }) => {
  await configure(page, '/token-fail');
  await page.getByLabel('端点 B 校准间隔').fill('8');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.endpoint-B .trend')).toContainText('计数 API 回退估算');
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  await expect(page.locator('.status-success')).toHaveCount(4);
  const requests = await (await request.get('http://127.0.0.1:4174/test/requests')).json();
  expect(requests).toHaveLength(4);
});

test('capability detection can be cancelled before any inference request is sent', async ({ page, request }) => {
  await configure(page, '/token-preflight');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByLabel('取消 token API 检测', { exact: true })).toBeVisible();
  await page.getByLabel('取消 token API 检测', { exact: true }).click();
  await expect(page.getByLabel('开始测试', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '测量你的 LLM', exact: true })).toBeVisible();
  expect(await (await request.get('http://127.0.0.1:4174/test/requests')).json()).toEqual([]);
});

test('editing an endpoint aborts stale capability detection and a fresh check succeeds', async ({ page }) => {
  await configure(page, '/token-preflight');
  await page.getByLabel('检测端点 B token API', { exact: true }).click();
  await expect(page.locator('.endpoint-B .token-counter-setting')).toContainText('检测中');
  await page.getByLabel('端点 B 地址', { exact: true }).fill('http://127.0.0.1:4174/token-api/v1');
  await page.getByLabel('检测端点 B token API', { exact: true }).click();
  await expect(page.locator('.endpoint-B .token-counter-setting')).toContainText('端点原文本分词');
  await page.waitForTimeout(1100);
  await expect(page.locator('.endpoint-B .token-counter-setting')).toContainText('端点原文本分词');
});

test('stopping cancels pending counting as well as generation and prevents subsequent count queries', async ({ page, request }) => {
  await configure(page, '/token-delay');
  await page.getByLabel('端点 B 校准间隔').fill('8');
  const failedCounting: string[] = [];
  page.on('requestfailed', req => { if (req.url().endsWith('/tokenize')) failedCounting.push(req.url()); });
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect.poll(async () => (await (await request.get('http://127.0.0.1:4174/test/token-requests')).json()).filter((call: any) => call.text.startsWith('abcd')).length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '停止测试' }).click();
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  expect(failedCounting.length).toBeGreaterThan(0);
  const before = (await (await request.get('http://127.0.0.1:4174/test/token-requests')).json()).length;
  await page.waitForTimeout(500);
  expect((await (await request.get('http://127.0.0.1:4174/test/token-requests')).json()).length).toBe(before);
});

test('disabling token calibration avoids capability probes and keeps that setting on reload', async ({ page, request }) => {
  await configure(page, '/token-api');
  await page.getByLabel('端点 B 实时 token API').uncheck();
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.endpoint-B .speed-gauge')).toHaveAttribute('data-source', 'estimated');
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
  expect(await (await request.get('http://127.0.0.1:4174/test/token-requests')).json()).toEqual([]);
  await page.getByRole('button', { name: '再次测试' }).click();
  await page.reload();
  await page.getByLabel('编辑端点 B', { exact: true }).click();
  await page.locator('.endpoint-B .advanced > summary').click();
  await expect(page.getByLabel('端点 B 实时 token API')).not.toBeChecked();
});
