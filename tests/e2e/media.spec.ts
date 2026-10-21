import { expect, test, type Page } from '@playwright/test';

const server = 'http://127.0.0.1:4174';
async function configure(page: Page, id = 'A', prefix = '') {
  await page.getByLabel(`编辑端点 ${id}`, { exact: true }).click();
  await page.getByLabel(`端点 ${id} 地址`, { exact: true }).fill(`${server}${prefix}/v1`);
  await page.getByLabel(`端点 ${id} 模型`, { exact: true }).fill('media-fixture');
  await page.getByLabel(`端点 ${id} API Key`).fill('media-memory-key');
}

test.beforeEach(async ({ page, request }) => {
  await request.get(`${server}/test/reset`);
  await page.goto('/');
});

test('isolates modes, restores media parameters, and starts in language mode', async ({ page }) => {
  await expect(page.getByLabel('测速模式')).toHaveValue('language');
  await expect(page.getByLabel('并发请求数值')).toBeVisible();
  await page.getByLabel('输入长度数值').fill('2048');
  await page.getByLabel('测速模式').selectOption('image');
  await page.getByLabel('提示词输入', { exact: true }).fill('custom image prompt');
  await page.getByLabel('分辨率', { exact: true }).fill('1');
  await expect(page.getByLabel('宽度（px）')).toHaveValue('768');
  await page.getByLabel('宽度（px）').fill('896');
  await page.getByLabel('去噪步数数值').fill('24');
  await configure(page);
  await page.getByLabel('连接端点 A 并获取模型').click();
  await expect(page.getByRole('status')).toContainText('连接');
  await expect(page.getByLabel('测速模式')).toBeEnabled();
  await page.getByLabel('测速模式').selectOption('video');
  await expect(page.getByLabel('视频时长数值')).toHaveValue('5');
  await expect(page.getByLabel('并发请求数值')).toHaveCount(0);
  await expect(page.getByLabel('宽度（px）')).toHaveValue('1280');
  await expect(page.getByLabel('高度（px）')).toHaveValue('720');
  await expect(page.getByLabel('FPS', { exact: true })).toHaveValue('24');
  await page.getByLabel('提示词输入', { exact: true }).fill('custom video prompt');
  await page.getByLabel('测速模式').selectOption('language');
  await expect(page.getByLabel('输入长度数值')).toHaveValue('2048');
  await page.getByLabel('测速模式').selectOption('image');
  await expect(page.getByLabel('提示词输入', { exact: true })).toHaveValue('custom image prompt');
  await expect(page.getByLabel('宽度（px）')).toHaveValue('896');
  await expect(page.getByLabel('端点 A API Key')).toHaveValue('media-memory-key');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('media-memory-key');
  await page.reload();
  await expect(page.getByLabel('测速模式')).toHaveValue('language');
  await page.getByLabel('测速模式').selectOption('image');
  await expect(page.getByLabel('去噪步数数值')).toHaveValue('24');
  await expect(page.getByLabel('端点 A API Key')).toHaveValue('');
});

test('every image and video resolution preset is exactly 16:9', async ({ page }) => {
  for (const mode of ['image', 'video']) {
    await page.getByLabel('测速模式').selectOption(mode);
    const slider = page.getByLabel('分辨率', { exact: true });
    const max = Number(await slider.getAttribute('max'));
    for (let index = 0; index <= max; index++) {
      await slider.fill(String(index));
      const width = Number(await page.getByLabel('宽度（px）').inputValue());
      const height = Number(await page.getByLabel('高度（px）').inputValue());
      expect(width * 9).toBe(height * 16);
      await expect(page.locator('.media-resolution strong')).toContainText('16:9');
    }
  }
});

test('compares images with identical prompts and parameters and downloads a preview', async ({ page, request }) => {
  const recordings: string[] = [];
  page.on('request', req => { if (req.url().endsWith('/api/runs')) recordings.push(req.url()); });
  await page.getByLabel('测速模式').selectOption('image');
  await configure(page);
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  await configure(page, 'B', '/media-url');
  await expect(page.getByLabel('并发请求数值')).toHaveCount(0);
  await page.getByLabel('提示词输入', { exact: true }).fill('Exact prompt <script>window.injected=true</script>');
  await page.getByLabel('去噪步数数值').fill('12');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByLabel('测速模式')).toBeDisabled();
  await expect(page.getByRole('button', { name: '再次测试' })).toBeVisible();
  await expect(page.getByRole('img', { name: '生成结果' })).toHaveCount(2);
  await expect(page.locator('.media-results')).toContainText('B 相对 A');
  const requests = await (await request.get(`${server}/test/requests`)).json();
  const posts = requests.filter((req: any) => req.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(new Set(posts.map((req: any) => JSON.stringify(req.body))).size).toBe(1);
  expect(posts[0].body).toMatchObject({ prompt: 'Exact prompt <script>window.injected=true</script>', num_inference_steps: 12, n: 1 });
  expect(recordings).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载', exact: true }).first().click();
  expect((await download).suggestedFilename()).toBe('image-A-1.png');
  await page.screenshot({ path: 'test-results/media-image-results.png', fullPage: true });
  await page.getByLabel('测速模式').selectOption('video');
  await expect(page.getByLabel('提示词输入', { exact: true })).toBeVisible();
  await expect(page.getByTestId('media-output')).toHaveCount(0);
});

test('polls video, preserves generation success on download failure and retries only content', async ({ page, request }) => {
  await page.getByLabel('测速模式').selectOption('video');
  await configure(page, 'A', '/media-retry');
  await page.getByLabel('视频时长数值').fill('3');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByTestId('media-output')).toContainText('排队中');
  await expect(page.getByRole('button', { name: '再次测试' })).toBeVisible();
  await expect(page.locator('.media-results')).toContainText('RTF');
  await expect(page.getByRole('button', { name: '重新下载' })).toBeVisible();
  await expect(page.getByTestId('media-output')).toHaveClass(/status-success/);
  await page.getByRole('button', { name: '重新下载' }).click();
  await expect(page.locator('video')).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.duration)).toBe(1);
  const requests = await (await request.get(`${server}/test/requests`)).json();
  const posts = requests.filter((req: any) => req.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toMatchObject({ seconds: '3', fps: '24', num_inference_steps: '20', size: '1280x720' });
  expect(posts[0].body.num_frames).toBeUndefined();
  expect(JSON.parse(posts[0].body.extra_params)).toEqual({ aspect_ratio: '16:9' });
  expect(requests.filter((req: any) => req.url.endsWith('/content'))).toHaveLength(2);
  expect(requests.every((req: any) => req.hasAuth)).toBe(true);
  await page.screenshot({ path: 'test-results/media-video-results.png', fullPage: true });
});

test('migrates stored media defaults and sends a matching aspect ratio for custom video dimensions', async ({ page, request }) => {
  await page.evaluate(() => {
    localStorage.setItem('llm-speedtest-video-config', JSON.stringify({ version: 1, config: { width: 832, height: 480, fps: 16, concurrency: 8, prompt: 'saved video prompt' } }));
  });
  await page.reload();
  await page.getByLabel('测速模式').selectOption('video');
  await expect(page.getByLabel('宽度（px）')).toHaveValue('1280');
  await expect(page.getByLabel('高度（px）')).toHaveValue('720');
  await expect(page.getByLabel('FPS', { exact: true })).toHaveValue('24');
  await expect(page.getByLabel('并发请求数值')).toHaveCount(0);
  await expect(page.getByLabel('提示词输入', { exact: true })).toHaveValue('saved video prompt');
  await page.getByLabel('宽度（px）').fill('720');
  await page.getByLabel('高度（px）').fill('1280');
  await expect(page.locator('.media-resolution strong')).toContainText('9:16');
  await configure(page);
  await page.getByRole('button', { name: 'A/B 对比' }).click();
  await configure(page, 'B');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByRole('button', { name: '再次测试' })).toBeVisible();
  const requests = await (await request.get(`${server}/test/requests`)).json();
  const posts = requests.filter((req: any) => req.method === 'POST');
  expect(posts).toHaveLength(2);
  for (const post of posts) {
    expect(post.body).toMatchObject({ size: '720x1280', fps: '24' });
    expect(JSON.parse(post.body.extra_params)).toEqual({ aspect_ratio: '9:16' });
  }
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('llm-speedtest-video-config')!));
  expect(stored.version).toBe(2);
  expect(stored.config).not.toHaveProperty('concurrency');
});

test('cancels video jobs and reports generation failures', async ({ page, request }) => {
  await page.getByLabel('测速模式').selectOption('video');
  await configure(page, 'A', '/media-slow');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByTestId('media-output')).toContainText('排队中');
  await page.getByRole('button', { name: '停止测试' }).click();
  await expect(page.getByTestId('media-output')).toHaveClass(/status-cancelled/);
  await expect.poll(async () => (await (await request.get(`${server}/test/requests`)).json()).some((req: any) => req.method === 'DELETE')).toBe(true);
  await page.getByRole('button', { name: '再次测试' }).click();
  if (!(await page.getByLabel('端点 A 地址', { exact: true }).isVisible())) await page.getByLabel('编辑端点 A', { exact: true }).click();
  await page.getByLabel('端点 A 地址', { exact: true }).fill(`${server}/media-failed/v1`);
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByTestId('media-output')).toHaveClass(/status-error/);
  await expect(page.getByTestId('media-output')).toContainText('fixture generation failed');
});

test('requires a prompt and shows request validation errors', async ({ page }) => {
  await page.getByLabel('测速模式').selectOption('image');
  await configure(page, 'A', '/media-error');
  await page.getByLabel('提示词输入', { exact: true }).fill('  ');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('提示词');
  await page.getByLabel('提示词输入', { exact: true }).fill('a cat');
  await page.getByLabel('开始测试', { exact: true }).click();
  await expect(page.getByTestId('media-output')).toContainText('unsupported size');
});

for (const locale of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es']) {
  test(`media layouts support ${locale}, narrow screens, and both themes`, async ({ page }) => {
    await page.evaluate(locale => localStorage.setItem('llm-speedtest-locale', locale), locale);
    await page.reload();
    await page.locator('.mode-switch').selectOption('video');
    for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await expect(page.locator('textarea')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const overlaps = await page.evaluate(() => {
        const a = document.querySelector('.brand-group')!.getBoundingClientRect();
        const b = document.querySelector('.phase-nav')!.getBoundingClientRect();
        return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      });
      expect(overlaps).toBe(false);
      for (const button of [0, 2]) {
        await page.locator('.theme-switch button').nth(button).click();
        await page.screenshot({ path: `test-results/media-${locale}-${viewport.width}-${button}.png`, fullPage: true });
      }
    }
  });
}
