import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

function rows(sql: string): Record<string, unknown>[] {
  const output = execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', '.wrangler/e2e', '--json', '--command', sql], { encoding: 'utf8' });
  const parsed = JSON.parse(output.slice(output.indexOf('[')));
  return parsed[0].results;
}
const count = (table: string) => Number(rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);

async function configure(page: Page, key: string) {
  if (!(await page.getByLabel('端点 A 地址', { exact: true }).isVisible())) await page.getByLabel('编辑端点 A', { exact: true }).click();
  await page.getByLabel('端点 A 地址', { exact: true }).fill('http://127.0.0.1:4174');
  await page.getByLabel('端点 A 模型', { exact: true }).fill('test-qwen');
  await page.getByLabel('端点 A 别名').fill('夹具');
  await page.getByLabel('端点 A API Key').fill(key);
}

test('records endpoint results and the source address, without repeating known dimensions', async ({ page }) => {
  const key = `e2e-key-${Date.now()}`;
  await page.goto('/');
  const toggle = page.getByRole('checkbox', { name: /记录结果/ });
  await expect(toggle).toBeChecked();
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const box = (await toggle.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await configure(page, key);
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByTestId('record-status')).toHaveText('已记录');
  const stored = rows(`SELECT e.base_url, m.name AS model, re.alias, k.secret AS api_key, s.ip AS source_ip, re.success_count FROM runs r JOIN run_endpoints re ON re.run_id = r.id JOIN endpoints e ON e.id = re.endpoint_id JOIN models m ON m.id = re.model_id LEFT JOIN api_keys k ON k.id = re.api_key_id LEFT JOIN source_ips s ON s.id = r.source_ip_id WHERE k.secret = '${key}'`);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ base_url: 'http://127.0.0.1:4174', model: 'test-qwen', alias: '夹具', api_key: key, success_count: 1 });
  expect([null, '127.0.0.1', '::1', '0000:0000:0000:0000:0000:0000:0000:0001']).toContain(stored[0].source_ip);
  const dimensions = { endpoints: count('endpoints'), models: count('models'), apiKeys: count('api_keys'), sourceIps: count('source_ips') };
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(key);

  await page.getByRole('button', { name: '再次测试' }).click();
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByTestId('record-status')).toHaveText('已记录');
  expect(rows(`SELECT COUNT(*) AS n FROM api_keys k WHERE k.secret = '${key}'`)[0].n).toBe(1);
  expect(count('endpoints')).toBe(dimensions.endpoints);
  expect(count('models')).toBe(dimensions.models);
  expect(count('api_keys')).toBe(dimensions.apiKeys);
  expect(count('source_ips')).toBe(dimensions.sourceIps);
  expect(Number(rows(`SELECT COUNT(*) AS n FROM run_endpoints re JOIN api_keys k ON k.id = re.api_key_id WHERE k.secret = '${key}'`)[0].n)).toBe(2);

  await page.getByRole('button', { name: '再次测试' }).click();
  await toggle.uncheck();
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByRole('button', { name: '再次测试' })).toBeVisible();
  await expect(page.getByTestId('record-status')).toHaveCount(0);
  expect(Number(rows(`SELECT COUNT(*) AS n FROM run_endpoints re JOIN api_keys k ON k.id = re.api_key_id WHERE k.secret = '${key}'`)[0].n)).toBe(2);
});
