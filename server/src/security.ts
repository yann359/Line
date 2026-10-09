import { randomBytes, createCipheriv, createDecipheriv, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lookup } from 'node:dns/promises';

const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
export class AppError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export function masterKey(dir: string): Buffer {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = resolve(dir, 'master.key');
  if (!existsSync(file)) {
    if (existsSync(resolve(dir, 'line.sqlite'))) throw new Error('数据库已存在但 master.key 缺失，请恢复原始加密密钥。');
    writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const key = readFileSync(file);
  if (key.length !== 32) throw new Error('master.key 格式无效');
  return key;
}
export function seal(key: Buffer, value: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function unseal(key: Buffer, value: string): string {
  const data = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
}
export async function passwordRecord(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt);
  return { salt, hash: hash.toString('hex') };
}
export async function verifyPassword(password: string, record: { salt: string; hash: string }) {
  const hash = await derive(password, record.salt);
  const expected = Buffer.from(record.hash, 'hex');
  return expected.length === hash.length && timingSafeEqual(expected, hash);
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const mask = (value: string) => value ? `••••••${value.slice(-4)}` : '';
export const isLoopback = (ip: string) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

function privateAddress(ip: string): boolean {
  const value = ip.toLowerCase();
  if (value.includes(':')) return value === '::' || value === '::1' || /^(fc|fd|fe[89ab])/.test(value) || value.startsWith('::ffff:');
  const [a, b] = value.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
export async function validateProviderUrl(value: string, allowLocal = false): Promise<URL> {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(400, 'API 地址格式不正确'); }
  if (url.username || url.password || url.hash || url.search) throw new AppError(400, 'API 地址不能包含用户名、密码或查询参数');
  if (allowLocal && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) return url;
  if (url.protocol !== 'https:') throw new AppError(400, '模型 API 地址必须使用 HTTPS');
  let addresses;
  try { addresses = await lookup(url.hostname, { all: true }); } catch { throw new AppError(400, '无法解析 API 服务器地址'); }
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw new AppError(400, 'API 地址不能指向内网或本机服务');
  return url;
}
