import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/src/store.js';
import { masterKey, passwordRecord, verifyPassword } from '../server/src/security.js';
import { occurrenceTimes, validateReminder } from '../server/src/schedule.js';
import { createApp } from '../server/src/app.js';
import { DeliveryWorker } from '../server/src/worker.js';
import { responseText } from '../server/src/chatgpt.js';
import type { ReminderInput } from '../shared/types.js';
import { createServer } from 'node:http';

const origin = 'http://127.0.0.1:5173';
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'line-test-')); const store = new Store(dir, masterKey(dir)); return { store, dir, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } }; }
function input(overrides: Partial<ReminderInput> = {}): ReminderInput { return { title: '会议', content: '', dueAt: new Date(Date.now() + 120_000).toISOString(), recurrence: 'once', weekdays: [], recipientIds: ['self'], channels: { alarm: true, web: false, wechat: false }, ...overrides }; }

test('北京时间重复规则不依赖操作系统时区，工作日排除周末', () => {
  const r = input({ dueAt: '2027-01-01T15:00:00+08:00', recurrence: 'weekdays' });
  assert.deepEqual(occurrenceTimes(r, new Date('2027-01-01T00:00:00Z'), new Date('2027-01-05T23:00:00Z')), ['2027-01-01T07:00:00.000Z', '2027-01-04T07:00:00.000Z', '2027-01-05T07:00:00.000Z']);
  assert.deepEqual(occurrenceTimes({ ...r, recurrence: 'weekly', weekdays: [7] }, new Date('2027-01-01T00:00:00Z'), new Date('2027-01-05T23:00:00Z')), ['2027-01-03T07:00:00.000Z']);
  assert.throws(() => validateReminder(input({ dueAt: '2020-01-01T00:00:00Z' })), /已经过去/);
  assert.throws(() => validateReminder(input({ recurrence: 'weekly' })), /重复的星期/);
  const precise = input({ dueAt: '2027-01-01T15:00:00.125+08:00', recurrence: 'daily' });
  assert.equal(occurrenceTimes(precise, new Date('2027-01-01T00:00:00Z'), new Date('2027-01-01T23:00:00Z'))[0], '2027-01-01T07:00:00.125Z');
});
test('重复确认只保存一条提醒，过期或过去的草稿不保存', () => {
  const f = fixture(); try {
    const draft = f.store.draft(input()); assert.equal(f.store.reminders().length, 0);
    assert.equal(f.store.confirmDraft(draft.id).id, f.store.confirmDraft(draft.id).id);
    assert.equal(f.store.reminders().length, 1);
    const old = f.store.draft(input({ dueAt: '2020-01-01T00:00:00Z' })); assert.throws(() => f.store.confirmDraft(old.id), /时间已过去/);
  } finally { f.close(); }
});
test('修改版本拒绝旧 ACK，关闭或取消闹钟仍提示待手机移除', () => {
  const f = fixture(); try {
    const r = f.store.confirmDraft(f.store.draft(input()).id), deviceId = '00000000-0000-4000-8000-000000000001';
    f.store.acknowledge({ reminderId: r.id, revision: 1, deviceId, status: 'registered', coverageUntil: new Date(Date.now() + 86400_000).toISOString() });
    assert.equal(f.store.reminder(r.id)?.syncStatus, 'registered');
    const updated = f.store.modify(r.id, 1, input({ channels: { alarm: false, web: true, wechat: false } }));
    assert.equal(updated.syncStatus, 'pending');
    assert.throws(() => f.store.acknowledge({ reminderId: r.id, revision: 1, deviceId, status: 'registered' }), /版本已改变/);
    f.store.acknowledge({ reminderId: r.id, revision: 2, deviceId, status: 'registered' }); assert.equal(f.store.reminder(r.id)?.syncStatus, 'registered');
    assert.equal(f.store.cancel(r.id, 2).syncStatus, 'pending');
    const unacknowledged = f.store.confirmDraft(f.store.draft(input()).id);
    assert.equal(f.store.modify(unacknowledged.id, 1, input({ channels: { alarm: false, web: true, wechat: false } })).syncStatus, 'pending');
  } finally { f.close(); }
});
test('密码摘要和密钥加密保存，公开配置不包含原始密钥', async () => {
  const record = await passwordRecord('A-safe-test-password'); assert.equal(await verifyPassword('A-safe-test-password', record), true); assert.equal(await verifyPassword('wrong-password', record), false);
  const f = fixture(); try {
    f.store.setSecret('provider:llm', 'sk-private-secret-1234'); f.store.setSecret('pushplus', 'push-private-value');
    assert.equal(f.store.getSecret('provider:llm'), 'sk-private-secret-1234');
    assert.equal(JSON.stringify(f.store.providers()).includes('sk-private-secret'), false);
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(readFileSync(join(f.dir, 'line.sqlite')).includes(Buffer.from('sk-private-secret')), false);
  } finally { f.close(); }
});
test('后台登录、来源限制、手动闭环、微信绑定和权限校验', async () => {
  const f = fixture(), { app } = await createApp(f.store, { origin, host: '127.0.0.1', worker: false, plan: true });
  try {
    assert.equal((await app.inject('/api/reminders')).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin: 'https://evil.example' }, payload: { username: 'me', password: 'safe-password-123' } })).statusCode, 403);
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin }, payload: { username: 'me', password: 'safe-password-123' } }); assert.equal(setup.statusCode, 200);
    const cookie = setup.headers['set-cookie']!.toString().split(';')[0], headers = { origin, cookie };
    const draft = await app.inject({ method: 'POST', url: '/api/drafts', headers, payload: input() }); assert.equal(draft.statusCode, 200);
    const confirm = { method: 'POST' as const, url: `/api/drafts/${draft.json().id}/confirm`, headers, payload: { confirmed: true } };
    const saved = await app.inject(confirm); assert.equal(saved.statusCode, 200); assert.equal((await app.inject(confirm)).json().id, saved.json().id);
    assert.equal((await app.inject({ method: 'POST', url: '/api/drafts', headers, payload: input({ channels: { alarm: false, web: false, wechat: true } }) })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/sync/ack', headers, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/parse', headers, payload: { text: '一小时后开会', endedAt: new Date().toISOString() } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/subscriptions', headers, payload: { endpoint: 'http://127.0.0.1/internal', keys: { p256dh: 'a'.repeat(40), auth: 'a'.repeat(20) } } })).statusCode, 400);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'me', password: 'safe-password-123', client: 'ios' } }); assert.equal(login.statusCode, 200);
    const auth = { authorization: `Bearer ${login.json().token}` };
    const ack = await app.inject({ method: 'POST', url: '/api/sync/ack', headers: auth, payload: { reminderId: saved.json().id, revision: 1, deviceId: '00000000-0000-4000-8000-000000000001', status: 'registered', coverageUntil: new Date(Date.now() + 86400_000).toISOString() } }); assert.equal(ack.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/reminders', headers })).json()[0].syncStatus, 'registered');
  } finally { await app.close(); f.close(); }
});
test('微信受理之后查询最终结果，不把 shortCode 当成功', async () => {
  const f = fixture(); let sends = 0;
  const fetcher = async (url: string | URL | Request) => {
    const value = String(url); const data = value.endsWith('/send') ? (sends++, { code: 200, data: 'test-short-code' }) : value.includes('getAccessKey') ? { code: 200, data: { accessKey: 'secret', expiresIn: 7200 } } : { code: 200, data: { status: 2 } };
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    f.store.setSecret('pushplus', 'test'); f.store.setSecret('pushplus-secret', 'test-secret');
    const due = new Date(Date.now() + 1000), worker = new DeliveryWorker(f.store, fetcher as typeof fetch);
    f.store.confirmDraft(f.store.draft(input({ dueAt: due.toISOString(), channels: { alarm: false, web: false, wechat: true } })).id);
    await worker.tick(due); assert.equal(worker.list()[0].status, 'processing');
    await worker.tick(new Date(due.getTime() + 20_000)); assert.equal(worker.list()[0].status, 'success'); assert.equal(sends, 1);
  } finally { f.close(); }
});
test('断网结果未知不重发，服务重启不重发，迟到超过五分钟不发送', async () => {
  const f = fixture(); let sends = 0;
  try {
    f.store.setSecret('pushplus', 'test');
    const due = new Date(Date.now() + 1000), worker = new DeliveryWorker(f.store, (async () => { sends++; throw new Error('network'); }) as typeof fetch);
    const r = f.store.confirmDraft(f.store.draft(input({ dueAt: due.toISOString(), channels: { alarm: false, web: false, wechat: true } })).id);
    await worker.tick(due); await worker.tick(new Date(due.getTime() + 30_000)); assert.equal(sends, 1); assert.equal(worker.list()[0].status, 'unknown');
    f.store.db.prepare("UPDATE deliveries SET status='processing',provider_ref=NULL WHERE id=?").run(worker.list()[0].id);
    const restarted = new DeliveryWorker(f.store, (async () => { sends++; throw new Error(); }) as typeof fetch);
    await restarted.tick(due); assert.equal(restarted.list()[0].status, 'unknown'); assert.equal(sends, 1);
    f.store.modify(r.id, 1, input({ dueAt: new Date(due.getTime() + 60_000).toISOString(), channels: { alarm: false, web: false, wechat: true } }));
    await restarted.tick(new Date(due.getTime() + 400_000)); assert.equal(restarted.list().find(d => d.dueAt === new Date(due.getTime() + 60_000).toISOString())?.status, 'missed'); assert.equal(sends, 1);
  } finally { f.close(); }
});
test('明确失败最多三次重试；修改取消不会发送旧版本', async () => {
  const f = fixture(); let sends = 0;
  try {
    f.store.setSecret('pushplus', 'test'); const due = new Date(Date.now() + 1000);
    const worker = new DeliveryWorker(f.store, (async () => { sends++; return new Response(JSON.stringify({ code: 400 })); }) as typeof fetch);
    const r = f.store.confirmDraft(f.store.draft(input({ dueAt: due.toISOString(), channels: { alarm: false, web: false, wechat: true } })).id);
    for (const seconds of [0, 16, 62, 153, 244]) await worker.tick(new Date(due.getTime() + seconds * 1000));
    assert.equal(sends, 3); assert.equal(worker.list()[0].status, 'failed'); assert.match(worker.list()[0].error!, /限额/);
    f.store.modify(r.id, 1, input({ dueAt: new Date(due.getTime() + 400_000).toISOString(), channels: { alarm: false, web: false, wechat: true } }));
    f.store.materialize(due); f.store.cancel(r.id, 2); await worker.tick(new Date(due.getTime() + 400_000)); assert.equal(sends, 3);
  } finally { f.close(); }
});
test('订阅响应必须完整结束，流中断不采用部分文字', async () => {
  const complete = 'data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ content: [{ type: 'output_text', text: '有效结果' }] }] } }) + '\n\n';
  assert.equal(await responseText(new Response(complete)), '有效结果');
  await assert.rejects(responseText(new Response('data: {"type":"response.output_text.delta","delta":"部分文字"}\n\n')), /连接中断/);
});
test('无浏览器订阅的明确失败最多执行初次加三次重试', async () => {
  const f = fixture(); try {
    const due = new Date(Date.now() + 1000), worker = new DeliveryWorker(f.store);
    f.store.confirmDraft(f.store.draft(input({ dueAt: due.toISOString(), channels: { alarm: false, web: true, wechat: false } })).id);
    for (const seconds of [0, 31, 62, 93, 124]) await worker.tick(new Date(due.getTime() + seconds * 1000));
    assert.equal(worker.list()[0].attempts, 4); assert.equal(worker.list()[0].status, 'exhausted');
  } finally { f.close(); }
});
test('云端不开放本机订阅授权，OAuth 回调检查 state 和超时生命周期', async () => {
  const f = fixture(); const { app, plan } = await createApp(f.store, { origin, host: '0.0.0.0', worker: false, plan: true });
  try { assert.equal(plan.status().available, false); await assert.rejects(plan.start(), /仅在本机/); } finally { await app.close(); f.close(); }
  const g = fixture(), local = await createApp(g.store, { origin, host: '127.0.0.1', worker: false, plan: true });
  try {
    const started = await local.plan.start(), url = new URL(started.url), redirect = url.searchParams.get('redirect_uri')!;
    assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('ext_agent_host_id')!, /^urn:uuid:/);
    const bad = await fetch(`${redirect}?state=wrong&error=access_denied`); assert.equal(bad.status, 400); assert.equal(local.plan.status().pending, true);
    const denied = await fetch(`${redirect}?state=${url.searchParams.get('state')}&error=access_denied`); assert.equal(denied.status, 400); assert.equal(local.plan.status().pending, false); assert.equal(local.plan.status().accounts.length, 0);
  } finally { await local.app.close(); g.close(); }
});
test('识别、模型追问、草稿和确认的真实接口闭环；录音不落入数据库', async () => {
  const f = fixture(); let mode = 'draft', receivedAudio = false, baseTime = new Date().toISOString();
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('Content-Type', 'application/json');
    if (body.model === 'test-asr') { receivedAudio = body.messages[0].content[0].input_audio.data.startsWith('data:audio/wav;base64,'); res.end(JSON.stringify({ choices: [{ message: { content: '一小时后提醒我开会' } }] })); return; }
    const payload = JSON.parse(body.messages[1].content); baseTime = body.messages[0].content.match(/说话结束 ([^ ]+) 计算/)[1];
    const result = mode === 'question' ? { question: '请问是今天还是明天？' } : { reminder: input({ dueAt: mode === 'past' ? '2020-01-01T00:00:00Z' : new Date(Date.parse(baseTime) + 3600_000).toISOString() }) };
    assert.equal(typeof payload.text, 'string'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('mock failed');
  for (const kind of ['asr', 'llm']) {
    f.store.set(`provider:${kind}`, { kind, adapter: kind === 'asr' ? 'qwen-asr' : 'compatible', baseUrl: `http://127.0.0.1:${address.port}`, model: `test-${kind}`, voice: '', enabled: true }); f.store.setSecret(`provider:${kind}`, 'test-key');
  }
  f.store.set('account', { username: 'me', ...await passwordRecord('safe-test-password') });
  const { app } = await createApp(f.store, { origin, host: '127.0.0.1', worker: false, allowLocal: true });
  try {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'me', password: 'safe-test-password', client: 'ios' } }), headers = { authorization: `Bearer ${login.json().token}` };
    const marker = 'private-raw-audio-marker';
    const audio = await app.inject({ method: 'POST', url: '/api/transcribe', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=LineTest' }, payload: Buffer.from(`--LineTest\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n${marker}\r\n--LineTest--\r\n`) });
    assert.equal(audio.statusCode, 200); assert.equal(receivedAudio, true);
    const endedAt = new Date(Date.now() - 3000).toISOString();
    const parsed = await app.inject({ method: 'POST', url: '/api/parse', headers, payload: { text: audio.json().text, endedAt } }); assert.equal(parsed.statusCode, 200);
    assert.equal(parsed.json().draft.reminder.dueAt, new Date(Date.parse(endedAt) + 3600_000).toISOString()); assert.equal(f.store.reminders().length, 0);
    const confirmed = await app.inject({ method: 'POST', url: `/api/drafts/${parsed.json().draft.id}/confirm`, headers, payload: { confirmed: true } }); assert.equal(confirmed.statusCode, 200); assert.equal(f.store.reminders().length, 1);
    mode = 'question'; assert.match((await app.inject({ method: 'POST', url: '/api/parse', headers, payload: { text: '下午三点', endedAt, context: [{ role: 'assistant', content: '请补充日期' }] } })).json().question, /今天/);
    mode = 'past'; assert.match((await app.inject({ method: 'POST', url: '/api/parse', headers, payload: { text: '过去的时间', endedAt } })).json().question, /已经过去/);
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); assert.equal(readFileSync(join(f.dir, 'line.sqlite')).includes(Buffer.from(marker)), false);
  } finally { await app.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); f.close(); }
});
