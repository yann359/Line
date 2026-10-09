import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Store } from './store.js';
import { AppError } from './security.js';
import type { PlanStatus } from '../../shared/types.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
type Account = { id: string; clientId: string; sub: string; email: string };
type Tokens = { access_token: string; refresh_token: string; id_token?: string; expiresAt: number };
export async function responseText(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new AppError(502, `OpenAI 请求未成功（${response.status}），请检查授权和额度`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      size += value?.length ?? 0;
      if (size > 2_000_000) throw new AppError(502, '模型响应过大');
      buffer = buffer.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') continue;
        const item = JSON.parse(data);
        if (['response.failed', 'response.incomplete', 'error'].includes(item.type)) throw new AppError(502, '模型未完整完成，请重试');
        if (item.type === 'response.completed') {
          const text = (item.response?.output ?? []).flatMap((v: any) => v.content ?? []).filter((v: any) => v.type === 'output_text').map((v: any) => v.text).join('');
          if (!text) throw new AppError(502, '模型没有返回文字');
          return text;
        }
      }
      if (done) throw new AppError(502, '模型连接中断，没有建立提醒');
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export class ChatGPTPlan {
  private listener?: Server;
  private timeout?: NodeJS.Timeout;
  private refreshTasks = new Map<string, Promise<Tokens>>();
  private lastError: string | null = null;
  constructor(private store: Store, public available: boolean) {}
  status(): PlanStatus {
    return { available: this.available, pending: !!this.listener, lastError: this.lastError,
      accounts: (this.store.get<Account[]>('plan:accounts') ?? []).map(a => ({ id: a.id, email: a.email, active: this.store.get('plan:active') === a.id, authorized: !!this.store.getSecret(`plan:${a.id}`) })) };
  }
  private requireLocal() { if (!this.available) throw new AppError(400, '订阅授权仅在本机回环服务启用；云端请使用 API Key'); }
  async start(accountId?: string): Promise<{ url: string }> {
    this.requireLocal(); this.close(); this.lastError = null;
    const saved = (this.store.get<Account[]>('plan:accounts') ?? []).find(a => a.id === accountId);
    if (accountId && !saved) throw new AppError(404, '授权账户不存在');
    let host = this.store.get<string>('plan:host');
    if (!host) { host = `urn:uuid:${randomUUID()}`; this.store.set('plan:host', host); }
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    let consumed = false, redirect = '';
    const listener = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', redirect);
      if (url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
      if (url.searchParams.get('state') !== state || consumed) { res.writeHead(400).end('授权状态不匹配，请在应用中重新登录。'); return; }
      consumed = true;
      try {
        if (url.searchParams.has('error')) throw new Error('授权未完成或账户不符合当前预览条件');
        const clientId = url.searchParams.get('client_id') ?? saved?.clientId;
        const code = url.searchParams.get('code');
        if (!clientId || clientId === 'dynamic_agent_client' || !code || (saved && clientId !== saved.clientId)) throw new Error('授权回调缺少正确的客户端身份');
        const reply = await fetch(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
        if (!reply.ok) throw new Error('授权码交换未成功，请重新登录');
        const data = await reply.json() as any;
        if (!data.id_token || !data.access_token || !data.refresh_token || !(data.scope ?? '').split(' ').includes('chatgpt.tokens.use.direct')) throw new Error('未获得文字推理所需授权');
        const { payload } = await jwtVerify(data.id_token, jwks, { issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'] });
        if (payload.nonce !== nonce || (saved && payload.sub !== saved.sub)) throw new Error('账户身份校验失败');
        const accounts = this.store.get<Account[]>('plan:accounts') ?? [];
        const account = accounts.find(a => a.clientId === clientId && a.sub === payload.sub) ?? { id: randomUUID(), clientId, sub: payload.sub!, email: String(payload.email ?? 'ChatGPT 账户') };
        this.store.transaction(() => {
          if (!accounts.some(a => a.id === account.id)) this.store.set('plan:accounts', [...accounts, account]);
          this.store.setSecret(`plan:${account.id}`, JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, id_token: data.id_token, expiresAt: Date.now() + Number(data.expires_in) * 1000 }));
          this.store.set('plan:active', account.id);
        });
        res.end('ChatGPT 授权成功，请返回语音助理。在文字理解设置中选择 ChatGPT 订阅并测试连接。');
      } catch (error) {
        this.lastError = error instanceof AppError ? error.message : 'ChatGPT 授权未完成，请重新登录；账户可能不支持当前预览。';
        res.writeHead(400).end(this.lastError);
      } finally { this.close(); }
    });
    this.listener = listener;
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new AppError(500, '无法启动本地回调');
    redirect = `http://127.0.0.1:${address.port}/auth/callback`;
    this.timeout = setTimeout(() => { this.lastError = '授权已超时，请重新登录'; this.close(); }, 5 * 60_000); this.timeout.unref();
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    for (const [key, value] of Object.entries({ client_id: saved?.clientId ?? 'dynamic_agent_client', response_type: 'code', redirect_uri: redirect, scope: SCOPE, resource: RESOURCE, state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ext_agent_host_id: host })) url.searchParams.set(key, value);
    if (!saved) url.searchParams.set('agent_name_hint', 'Line Voice Reminders');
    else { const secret = this.store.getSecret(`plan:${saved.id}`); if (secret) { const t = JSON.parse(secret) as Tokens; if (t.id_token) url.searchParams.set('id_token_hint', t.id_token); } }
    return { url: url.toString() };
  }
  async token(): Promise<Tokens> {
    this.requireLocal();
    const id = this.store.get<string>('plan:active'), account = (this.store.get<Account[]>('plan:accounts') ?? []).find(a => a.id === id);
    const secret = id ? this.store.getSecret(`plan:${id}`) : '';
    if (!secret || !account || !id) throw new AppError(400, '请先 Continue with ChatGPT 完成订阅授权');
    const tokens = JSON.parse(secret) as Tokens;
    if (tokens.expiresAt > Date.now() + 60_000) return tokens;
    if (!this.refreshTasks.has(id)) this.refreshTasks.set(id, (async () => {
      const result = await fetch(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: tokens.refresh_token, resource: RESOURCE }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
      if (!result.ok) throw new AppError(401, '订阅授权过期，请重新登录 ChatGPT');
      const data = await result.json() as any;
      if (!data.access_token || !data.refresh_token) throw new AppError(502, '订阅授权刷新未完整完成');
      const updated = { ...tokens, ...data, expiresAt: Date.now() + Number(data.expires_in) * 1000 };
      if (this.store.getSecret(`plan:${id}`) !== secret) throw new AppError(401, '授权状态已改变，请重新登录');
      this.store.setSecret(`plan:${id}`, JSON.stringify(updated)); return updated;
    })().finally(() => { this.refreshTasks.delete(id); }));
    return this.refreshTasks.get(id)!;
  }
  async models() {
    const token = await this.token();
    const r = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!r.ok) throw new AppError(502, `读取订阅模型失败（${r.status}）`);
    const data = await r.json() as any;
    return (data.models ?? []).filter((m: any) => m.visibility === 'list').map((m: any) => ({ slug: m.slug, display_name: m.display_name }));
  }
  async infer(model: string, instructions: string, text: string) {
    const token = await this.token();
    return responseText(await fetch(`${RESOURCE}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, instructions, input: [{ role: 'user', content: [{ type: 'input_text', text }] }], store: false, stream: true }), signal: AbortSignal.timeout(90_000), redirect: 'error' }));
  }
  async signOut(id: string) {
    this.requireLocal();
    const account = (this.store.get<Account[]>('plan:accounts') ?? []).find(a => a.id === id);
    const value = this.store.getSecret(`plan:${id}`); let revoked = false;
    try {
      if (account && value) {
        const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) }).then(r => r.json()) as any;
        const endpoint = new URL(discovery.revocation_endpoint);
        if (endpoint.origin !== ISSUER) throw new Error('invalid endpoint');
        const result = await fetch(endpoint, { method: 'POST', body: new URLSearchParams({ token: (JSON.parse(value) as Tokens).refresh_token, token_type_hint: 'refresh_token', client_id: account.clientId }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
        revoked = result.ok;
      }
    } catch { /* Local deletion is still required when revocation is unavailable. */ }
    this.store.setSecret(`plan:${id}`, '');
    if (this.store.get('plan:active') === id) this.store.delete('plan:active');
    return { message: revoked ? '已撤销订阅授权并清除本地凭据' : '已清除本地凭据；请到 ChatGPT 设置中确认断开此应用授权' };
  }
  close() { clearTimeout(this.timeout); this.listener?.close(); this.listener = undefined; }
}
