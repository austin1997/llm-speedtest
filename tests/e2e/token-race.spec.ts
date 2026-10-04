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

test('lights 1st for the first fully successful endpoint and calibrates its digits while the other is still streaming', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await configure(page, '', '/scroll', 2);
  await page.route('http://127.0.0.1:4174/api/chat', route => route.fulfill({
    contentType: 'application/x-ndjson',
    body: JSON.stringify({ message: { content: 'abcd'.repeat(100) } }) + '\n' + JSON.stringify({ done: true, eval_count: 24 }) + '\n',
  }));
  await page.getByLabel('深色主题').click();
  await page.getByLabel('开始测试', { exact: true }).click();
  const winner = page.locator('.race-A .race-winner');
  await expect(winner).toHaveText('1st');
  await expect(page.locator('.race-B .race-winner')).toHaveCount(0);
  await expect(page.locator('.race-A')).toHaveAttribute('data-source', 'reported');
  await expect(page.locator('.race-A')).toHaveAttribute('data-tokens', '48');
  await expect(page.locator('.race-A .race-token-count')).toHaveText('48 / 512');
  await expect(page.locator('.race-B')).toHaveAttribute('data-source', 'estimated');
  await expect(page.locator('.endpoint-A .status-success')).toHaveCount(2);
  await expect(page.locator('.endpoint-B .status-running')).toHaveCount(2);
  const estimated = Number(await page.locator('.race-A').getAttribute('data-generated'));
  const distance = Number(await page.locator('.race-A').getAttribute('data-distance'));
  const fraction = Number(await page.locator('.race-A').getAttribute('data-progress'));
  expect(estimated).toBe(200);
  expect(distance).toBeGreaterThan(48);
  expect(distance).toBeLessThanOrEqual(estimated);
  expect(fraction).toBeCloseTo(distance / 512);
  expect(await page.locator('.race-A .race-car').evaluate(node => parseFloat((node as HTMLElement).style.left))).toBeCloseTo(fraction * 100);
  expect(await winner.evaluate(node => getComputedStyle(node).animationName)).toBe('race-first');
  await winner.evaluate(node => { for (const animation of node.getAnimations()) { animation.pause(); animation.currentTime = 350; } });
  await page.screenshot({ path: 'test-results/token-race-first.png' });
  await winner.evaluate(node => { for (const animation of node.getAnimations()) animation.finish(); });
  await expect(page.getByRole('button', { name: '测试结束', exact: true })).toBeVisible();
  await expect(page.locator('.race-B')).toHaveAttribute('data-source', 'reported');
  await expect(page.locator('.race-B .race-token-count')).toHaveText('48 / 512');
  await expect(page.locator('.race-winner')).toHaveCount(1);
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
});

test('an estimated finish-line crossing does not award 1st and cancellation leaves no winner', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await configure(page, '/race-fast', '/race-slow', 2);
  await page.getByLabel('输出上限数值').fill('32');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.locator('.race-A')).toHaveAttribute('data-progress', '1');
  await expect(page.locator('.race-A')).toHaveAttribute('data-state', 'budget');
  await expect(page.locator('.endpoint-A .status-running')).toHaveCount(2);
  await expect(page.locator('.race-winner')).toHaveCount(0);
  await page.getByRole('button', { name: '停止测试' }).click();
  await expect(page.getByRole('button', { name: '测试结束', exact: true })).toBeVisible();
  await expect(page.locator('.race-winner')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
});

test('a corrected car holds its position until concurrent output catches up, then resumes', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await configure(page, '/catchup', '/scroll', 2);
  await page.getByLabel('开始测试', { exact: true }).click();
  const car = page.locator('.race-A');
  await expect(car).toHaveAttribute('data-state', 'catchup');
  await expect(car).toHaveAttribute('data-distance', '120');
  await expect(car).toHaveAttribute('data-tokens', '40');
  const heldPosition = await page.locator('.race-A .race-car').evaluate(node => (node as HTMLElement).style.left);
  await expect(page.locator('.race-A .race-car')).not.toHaveAttribute('data-moving');
  await expect(car).toHaveAttribute('data-tokens', '80');
  await expect(car).toHaveAttribute('data-distance', '120');
  expect(await page.locator('.race-A .race-car').evaluate(node => (node as HTMLElement).style.left)).toBe(heldPosition);
  await expect(car).toHaveAttribute('data-tokens', '140');
  await expect(car).toHaveAttribute('data-distance', '140');
  await expect(car).toHaveAttribute('data-state', 'driving');
  await expect(page.locator('.race-A .race-car')).toHaveAttribute('data-moving');
  await page.getByRole('button', { name: '停止测试' }).click();
  await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
});

for (const mode of ['animated', 'reduced', 'resize', 'narrow-to-wide'] as const) {
  test(`results wait for the winner animation and the original one-second hold: ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: mode === 'narrow-to-wide' ? 390 : 1366, height: 768 });
    await page.emulateMedia({ reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
    const start = new Date('2026-10-04T00:00:00Z');
    await page.clock.install({ time: start });
    await page.clock.pauseAt(new Date(start.getTime() + 10000));
    await configure(page, '', '', 2);
    await page.getByLabel('开始测试', { exact: true }).click();
    await expect(page.getByRole('button', { name: '测试结束', exact: true })).toBeDisabled();
    const badge = page.locator('.race-winner');
    await expect(badge).toHaveCount(1);
    if (mode === 'narrow-to-wide') await page.setViewportSize({ width: 1366, height: 768 });
    if (mode !== 'reduced') {
      await expect.poll(async () => badge.evaluate(node => node.getAnimations().filter(animation => animation.playState !== 'finished').length)).toBe(1);
      await badge.evaluate(node => { for (const animation of node.getAnimations()) animation.pause(); });
    } else expect(await badge.evaluate(node => node.getAnimations().length)).toBe(0);
    const elapsed = await page.locator('.run-timer').textContent();
    if (mode === 'resize') await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.runFor(999);
    await expect(page.locator('.results-panel')).toHaveCount(0);
    await expect(page.locator('.run-timer')).toHaveText(elapsed!);
    await page.clock.runFor(1);
    if (mode === 'animated' || mode === 'narrow-to-wide') {
      await expect(page.locator('.results-panel')).toHaveCount(0);
      await expect(badge).toBeVisible();
      await badge.evaluate(node => { for (const animation of node.getAnimations()) animation.finish(); });
    }
    await expect(page.getByRole('region', { name: '本轮结果', exact: true })).toBeVisible();
    await expect(page.locator('.summary-table tbody tr').filter({ hasText: '平均总耗时' })).toContainText('0 ms');
    await page.getByRole('button', { name: '再次测试' }).click();
    await expect(page.locator('.race-winner')).toHaveCount(0);
    await expect(page.getByLabel('并发请求数值')).toHaveValue('2');
  });
}
