import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { AppError, digest, isLoopback, mask, passwordRecord, verifyPassword, validateProviderUrl } from './security.js';
import { TIMEZONE, occurrenceTimes, validateReminder } from './schedule.js';
import { ChatGPTPlan } from './chatgpt.js';
import { Providers } from './providers.js';
import { DeliveryWorker } from './worker.js';

const accountSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(12).max(128), client: z.enum(['web', 'ios']).default('web') }).strict();
export async function createApp(store: Store, options: { origin: string; host: string; production?: boolean; worker?: boolean; plan?: boolean; allowLocal?: boolean }) {
  const app = Fastify({ logger: false, bodyLimit: 512_000, trustProxy: false });
  const plan = new ChatGPTPlan(store, !!options.plan && isLoopback(options.host));
  const providers = new Providers(store, plan, options.allowLocal);
  const worker = new DeliveryWorker(store);
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], mediaSrc: ["'self'", 'blob:'], objectSrc: ["'none'"], upgradeInsecureRequests: options.production ? [] : null } } });
  await app.register(multipart, { limits: { fileSize: 10_000_000, files: 1, fields: 2 } });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: '输入格式不正确，请检查必填字段' });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    reply.code(status && status < 500 ? status : 500).send({ error: status === 429 ? '请求过于频繁，请稍后再试' : '请求未完成，请稍后重试' });
  });
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && origin !== options.origin) throw new AppError(403, '请求来源不受信任');
    if (req.method !== 'GET' && !origin && !req.headers.authorization && !['/api/auth/login', '/api/auth/setup'].includes(req.url)) throw new AppError(403, '缺少请求来源');
    if (req.url.startsWith('/api/auth/')) return;
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : req.cookies.line_session;
    const session = token ? store.db.prepare('SELECT expires FROM sessions WHERE hash=?').get(digest(token)) as { expires: number } | undefined : undefined;
    if (!session || session.expires <= Date.now()) throw new AppError(401, '请先登录');
  });
  const issueSession = (reply: any, client: string) => {
    const token = randomBytes(32).toString('base64url');
    store.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES (?,?)').run(digest(token), Date.now() + 30 * 86400_000);
    if (client === 'ios') return { token };
    reply.setCookie('line_session', token, { path: '/', httpOnly: true, sameSite: 'strict', secure: !!options.production, maxAge: 30 * 86400 }); return { ok: true };
  };
  app.get('/api/auth/status', async () => ({ setupNeeded: !store.get('account') }));
  app.post('/api/auth/setup', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    if (!isLoopback(req.ip) || req.headers.origin !== options.origin) throw new AppError(403, '首次账号只能在服务器本机页面建立；云端请先运行 setup 命令');
    if (store.get('account')) throw new AppError(409, '账号已经建立');
    const input = accountSchema.parse(req.body), record = await passwordRecord(input.password);
    // Recheck after asynchronous password hashing to prevent concurrent bootstrap.
    if (store.get('account')) throw new AppError(409, '账号已经建立');
    store.set('account', { username: input.username, ...record }); return issueSession(reply, input.client);
  });
  app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const input = accountSchema.parse(req.body), account = store.get<{ username: string; salt: string; hash: string }>('account');
    if (!account || !(await verifyPassword(input.password, account)) || account.username !== input.username) throw new AppError(401, '账号或密码不正确');
    return issueSession(reply, input.client);
  });
  app.get('/api/me', async () => ({ username: store.get<any>('account')?.username, timezone: TIMEZONE }));
  app.post('/api/logout', async (req, reply) => {
    const token = req.headers.authorization?.slice(7) ?? req.cookies.line_session;
    if (token) store.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token));
    reply.clearCookie('line_session', { path: '/' }); return { ok: true };
  });
  app.post('/api/password', async req => {
    const input = z.object({ current: z.string().max(128), password: z.string().min(12).max(128) }).parse(req.body), account = store.get<any>('account');
    if (!(await verifyPassword(input.current, account))) throw new AppError(400, '当前密码不正确');
    const record = await passwordRecord(input.password);
    store.transaction(() => { store.set('account', { username: account.username, ...record }); store.db.exec('DELETE FROM sessions'); });
    return { ok: true };
  });
  app.get('/api/contacts', async () => store.contacts());
  app.post('/api/contacts', async req => store.saveContact(z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(40), aliases: z.array(z.string().trim().min(1).max(40)).max(10), token: z.string().max(512).optional(), clearToken: z.boolean().optional() }).strict().parse(req.body)));
  app.delete('/api/contacts/:id', async req => {
    const id = (req.params as { id: string }).id;
    if (store.reminders().some(r => r.status === 'active' && r.recipientIds.includes(id))) throw new AppError(409, '请先取消或修改引用此联系人的提醒');
    store.db.prepare('DELETE FROM contacts WHERE id=?').run(id); return { ok: true };
  });
  app.get('/api/reminders', async () => store.reminders());
  app.post('/api/drafts', async req => { const input = validateReminder(req.body); store.validateRecipients(input); return store.draft(input); });
  app.post('/api/drafts/:id/confirm', async req => { z.object({ confirmed: z.literal(true) }).strict().parse(req.body); return store.confirmDraft((req.params as { id: string }).id); });
  app.put('/api/reminders/:id', async req => {
    const value = z.object({ revision: z.number().int().positive(), confirmed: z.literal(true), reminder: z.unknown() }).strict().parse(req.body);
    return store.modify((req.params as { id: string }).id, value.revision, validateReminder(value.reminder));
  });
  app.delete('/api/reminders/:id', async req => { const input = z.object({ revision: z.number().int().positive() }).parse(req.body); return store.cancel((req.params as { id: string }).id, input.revision); });
  app.post('/api/parse', async req => {
    const input = z.object({ text: z.string().trim().min(1).max(4000), endedAt: z.iso.datetime({ offset: true }), context: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(12).default([]) }).strict().parse(req.body);
    if (Math.abs(Date.now() - Date.parse(input.endedAt)) > 5 * 60_000) throw new AppError(400, '设备时间偏差过大，请校准后重试');
    return providers.parse(input.text, input.endedAt, input.context);
  });
  app.post('/api/transcribe', async req => {
    const part = await req.file();
    if (!part || !['audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4'].includes(part.mimetype)) throw new AppError(400, '请上传 WAV、WebM 或 M4A 录音');
    const data = await part.toBuffer();
    if (part.file.truncated) throw new AppError(413, '录音过大');
    const endedAt = new Date().toISOString();
    try { return { text: await providers.transcribe(data, part.mimetype), endedAt }; } finally { data.fill(0); }
  });
  app.post('/api/speak', async (req, reply) => {
    const { text } = z.object({ text: z.string().min(1).max(1500) }).parse(req.body), result = await providers.speak(text);
    if (!result) return reply.code(204).send();
    return reply.type(result.mime).send(result.audio);
  });
  app.get('/api/settings', async () => ({ providers: store.providers(), hasPushToken: !!store.getSecret('pushplus'), pushTokenMask: mask(store.getSecret('pushplus')), hasPushSecret: !!store.getSecret('pushplus-secret'), timezone: TIMEZONE, vapidPublicKey: store.get<string>('vapid:public') }));
  app.put('/api/settings/provider/:kind', async req => {
    const kind = z.enum(['asr', 'llm', 'tts']).parse((req.params as { kind: string }).kind);
    const input = z.object({ adapter: z.string(), baseUrl: z.string().max(512), model: z.string().max(128), voice: z.string().max(64).default('Cherry'), enabled: z.boolean(), key: z.string().max(4096).optional(), clearKey: z.boolean().optional() }).strict().parse(req.body);
    const adapters = { asr: ['qwen-asr', 'compatible-asr'], llm: ['compatible', 'openai-responses', 'chatgpt-plan'], tts: ['system', 'qwen-tts', 'compatible-tts'] };
    if (!adapters[kind].includes(input.adapter)) throw new AppError(400, '所选接口不适用于此功能');
    if (input.adapter === 'chatgpt-plan' && !plan.available) throw new AppError(400, '此部署环境不支持本地订阅授权，请使用 API Key');
    if (input.baseUrl) await validateProviderUrl(input.baseUrl, options.allowLocal);
    if (input.enabled && !['system', 'chatgpt-plan'].includes(input.adapter) && (!input.baseUrl || !input.model || !(input.key || store.getSecret(`provider:${kind}`)) || input.clearKey)) throw new AppError(400, '启用前请填写地址、模型和 API Key');
    if (input.enabled && input.adapter === 'chatgpt-plan' && !input.model) throw new AppError(400, '请填写授权后可用的模型');
    const { key, clearKey, ...config } = input;
    store.transaction(() => { store.set(`provider:${kind}`, { ...config, kind }); if (clearKey || key) store.setSecret(`provider:${kind}`, clearKey ? '' : key!); });
    return store.providers()[kind];
  });
  app.post('/api/settings/provider/:kind/test', async req => ({ message: await providers.test(z.enum(['asr', 'llm', 'tts']).parse((req.params as { kind: string }).kind)) }));
  app.put('/api/settings/pushplus', async req => {
    const input = z.object({ token: z.string().max(512).optional(), secretKey: z.string().max(512).optional(), clearToken: z.boolean().optional(), clearSecret: z.boolean().optional() }).strict().parse(req.body);
    if (input.clearToken && store.reminders().some(r => r.status === 'active' && r.channels.wechat)) throw new AppError(409, '请先关闭已有提醒的微信通知，再清除令牌');
    if (input.token || input.clearToken) store.setSecret('pushplus', input.clearToken ? '' : input.token!);
    if (input.secretKey || input.clearSecret) store.setSecret('pushplus-secret', input.clearSecret ? '' : input.secretKey!);
    return { ok: true };
  });
  app.get('/api/deliveries', async () => worker.list());
  app.get('/api/sync', async () => {
    const now = new Date(), until = new Date(now.getTime() + 7 * 86400_000);
    const reminders = store.reminders();
    return { serverTime: now.toISOString(), coverageUntil: until.toISOString(), reminders, alarms: reminders.filter(r => r.status === 'active' && r.channels.alarm).flatMap(r => occurrenceTimes(r, now, until).map(dueAt => ({ occurrenceKey: `${r.id}:${r.revision}:${dueAt}`, reminderId: r.id, revision: r.revision, dueAt, title: r.title }))) };
  });
  app.post('/api/sync/ack', async req => {
    if (!req.headers.authorization?.startsWith('Bearer ')) throw new AppError(403, '只有手机客户端可以确认系统闹钟登记');
    const input = z.object({ reminderId: z.string().uuid(), deviceId: z.string().uuid(), revision: z.number().int().positive(), status: z.enum(['registered', 'failed']), coverageUntil: z.iso.datetime({ offset: true }).nullable().optional(), error: z.string().max(500).nullable().optional() }).strict().parse(req.body);
    const r = store.reminder(input.reminderId);
    if (r?.status === 'active' && r.channels.alarm && input.status === 'registered' && (!input.coverageUntil || Date.parse(input.coverageUntil) < Date.now() || Date.parse(input.coverageUntil) > Date.now() + 7 * 86400_000 + 60_000)) throw new AppError(400, '闹钟覆盖期限不正确');
    store.acknowledge(input); return { ok: true };
  });
  app.post('/api/subscriptions', async req => {
    const value = z.object({ endpoint: z.url().max(2048), keys: z.object({ p256dh: z.string().min(20).max(256), auth: z.string().min(10).max(256) }) }).strict().parse(req.body);
    const url = new URL(value.endpoint);
    if (url.protocol !== 'https:' || !['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns2-par02p.notify.windows.com'].includes(url.hostname) && !url.hostname.endsWith('.notify.windows.com')) throw new AppError(400, '不支持这个浏览器推送服务器');
    const id = digest(value.endpoint); store.setSecret(`subscription:${id}`, JSON.stringify(value)); store.db.prepare('INSERT OR REPLACE INTO push_subscriptions VALUES (?,?)').run(id, 'encrypted'); return { ok: true };
  });
  const localPlan = (req: any) => { if (!isLoopback(req.ip) || !plan.available) throw new AppError(403, '请在本机开启订阅授权'); };
  app.get('/api/plan', async () => plan.status());
  app.post('/api/plan/start', async req => { localPlan(req); const input = z.object({ accountId: z.string().uuid().optional() }).parse(req.body); return plan.start(input.accountId); });
  app.get('/api/plan/models', async req => { localPlan(req); return plan.models(); });
  app.post('/api/plan/signout', async req => { localPlan(req); return plan.signOut(z.object({ id: z.string().uuid() }).parse(req.body).id); });
  const webRoot = resolve('dist/web');
  if (existsSync(webRoot)) {
    await app.register(serveStatic, { root: webRoot, index: 'index.html' });
    app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html'));
  }
  app.addHook('onClose', async () => { worker.close(); plan.close(); });
  if (options.worker !== false) worker.start();
  return { app, worker, plan, providers };
}
