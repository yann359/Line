import { test, expect } from '@playwright/test';

test('真实后台：首次登录、手动确认、修改、取消、模型入口和手机布局', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  if (await page.getByRole('button', { name: '建立私人空间' }).isVisible()) {
    await page.getByLabel('账号', { exact: true }).fill('test-owner'); await page.getByLabel('密码', { exact: true }).fill('test-password-12345'); await page.getByRole('button', { name: '建立私人空间' }).click();
  } else { await page.getByLabel('账号', { exact: true }).fill('test-owner'); await page.getByLabel('密码', { exact: true }).fill('test-password-12345'); await page.getByRole('button', { name: '登录', exact: true }).click(); }
  await expect(page.getByRole('button', { name: '开始语音提醒' })).toBeVisible();
  await page.screenshot({ path: 'test-results/assistant-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '手动建立提醒' }).click();
  await page.getByLabel('提醒内容', { exact: true }).fill('端到端测试会议');
  await page.getByRole('button', { name: '查看并确认' }).click();
  await expect(page.getByRole('heading', { name: '准备好这条提醒了' })).toBeVisible();
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('提醒已保存');
  await page.locator('.bottom-nav').getByRole('button', { name: '提醒', exact: true }).click();
  await expect(page.locator('.reminder-card')).toHaveCount(1); await expect(page.locator('.reminder-card')).toContainText('待手机同步');
  await page.getByRole('button', { name: '修改端到端测试会议' }).click();
  await page.getByLabel('提醒内容', { exact: true }).fill('已修改测试会议'); await page.getByRole('button', { name: '查看并确认' }).click(); await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '确认修改整个系列' })).toHaveCount(0);
  await page.locator('.bottom-nav').getByRole('button', { name: '提醒', exact: true }).click();
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '取消已修改测试会议' }).click(); await expect(page.locator('.reminder-card .pill')).toHaveText('已取消');
  await page.locator('.bottom-nav').getByRole('button', { name: '联系人', exact: true }).click(); await page.getByRole('button', { name: '添加联系人', exact: true }).click(); await page.getByLabel('姓名', { exact: true }).fill('小明'); await page.getByRole('button', { name: '保存联系人' }).click(); await expect(page.getByRole('heading', { name: '小明', exact: true })).toBeVisible();
  await page.locator('.bottom-nav').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue with ChatGPT' })).toBeVisible(); await expect(page.getByRole('link', { name: '打开官方 Key 管理' })).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
  await page.screenshot({ path: 'test-results/settings-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload(); await expect(page.getByRole('button', { name: '开始语音提醒' })).toBeVisible();
  await page.screenshot({ path: 'test-results/assistant-desktop.png', fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('模拟语音：问候结束收音、静音提交、复述后语音确认只保存一次', async ({ page }) => {
  await page.addInitScript(() => {
    // Replace hardware and playback, not the database or the confirmation endpoint.
    const getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    class FakeContext {
      sampleRate = 16000;
      destination = {};
      resume() { return Promise.resolve(); }
      close() { return Promise.resolve(); }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
      createScriptProcessor() {
        let count = 0, timer: number;
        const processor = { onaudioprocess: null as any, connect() { timer = window.setInterval(() => { const samples = new Float32Array(1600).fill(count++ < 3 ? 0.05 : 0); processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } }); }, 100); }, disconnect() { clearInterval(timer); } };
        return processor;
      }
    }
    Object.defineProperty(window, 'AudioContext', { value: FakeContext });
    Object.defineProperty(window, 'speechSynthesis', { value: { cancel() {}, speak(utterance: any) { setTimeout(() => utterance.onend?.(new Event('end')), 20); } } });
  });
  await page.route('**/api/settings', async route => { const response = await route.fetch(); const data = await response.json(); data.providers.asr.enabled = true; data.providers.llm.enabled = true; await route.fulfill({ response, json: data }); });
  let asrCalls = 0, parseCalls = 0;
  await page.route('**/api/transcribe', route => route.fulfill({ json: { text: asrCalls++ === 0 ? '一小时后提醒我语音测试会议' : '确认' } }));
  await page.route('**/api/parse', async route => {
    parseCalls++;
    const draft = await page.request.post('/api/drafts', { headers: { origin: 'http://127.0.0.1:5183' }, data: { title: '语音确认测试会议', content: '', dueAt: new Date(Date.now() + 3600_000).toISOString(), recurrence: 'once', weekdays: [], recipientIds: ['self'], channels: { alarm: true, web: false, wechat: false } } });
    await route.fulfill({ json: { draft: await draft.json() } });
  });
  await page.goto('/'); await page.getByLabel('账号', { exact: true }).fill('test-owner'); await page.getByLabel('密码', { exact: true }).fill('test-password-12345'); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '开始语音提醒' }).click();
  await expect(page.getByRole('status')).toContainText('提醒已保存', { timeout: 15000 });
  expect(asrCalls).toBe(2); expect(parseCalls).toBe(1);
  const reminders = await (await page.request.get('/api/reminders')).json(); expect(reminders.filter((r: any) => r.title === '语音确认测试会议')).toHaveLength(1);
  await expect(page.getByRole('button', { name: '开始语音提醒' })).toBeEnabled();
});
