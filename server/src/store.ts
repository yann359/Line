import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Contact, Draft, Reminder, ReminderInput, Provider, ProviderKind } from '../../shared/types.js';
import { AppError, mask, seal, unseal } from './security.js';
import { occurrenceTimes } from './schedule.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(public directory: string, private key: Buffer, memory = false) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = memory ? ':memory:' : resolve(directory, 'line.sqlite');
    this.db = new DatabaseSync(file);
    if (!memory) chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL, token TEXT);
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at TEXT NOT NULL, result_id TEXT);
      CREATE TABLE IF NOT EXISTS alarms(reminder_id TEXT NOT NULL, device_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, coverage TEXT, error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(reminder_id,device_id));
      CREATE TABLE IF NOT EXISTS occurrences(id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL, revision INTEGER NOT NULL, due_at TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, UNIQUE(reminder_id,revision,due_at));
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL, recipient_id TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, provider_ref TEXT, error TEXT, updated_at TEXT NOT NULL, UNIQUE(occurrence_id,recipient_id,channel));
      CREATE TABLE IF NOT EXISTS push_subscriptions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_requests(at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS push_content_requests(hash TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS delivery_pending ON deliveries(status,retry_at);
      CREATE INDEX IF NOT EXISTS occurrence_due ON occurrences(due_at);
      CREATE INDEX IF NOT EXISTS push_request_time ON push_requests(at);
    `);
  }
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : null;
  }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  getSecret(key: string) { const value = this.get<string>(`secret:${key}`); return value ? unseal(this.key, value) : ''; }
  setSecret(key: string, value: string) { this.set(`secret:${key}`, value ? seal(this.key, value) : ''); }
  delete(key: string) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  providers(): Record<ProviderKind, Provider> {
    return Object.fromEntries((['asr', 'llm', 'tts'] as const).map(kind => {
      const value = this.get<Omit<Provider, 'hasKey' | 'keyMask'>>(`provider:${kind}`) ?? { kind, adapter: kind === 'llm' ? 'compatible' : kind === 'asr' ? 'qwen-asr' : 'system', baseUrl: '', model: '', voice: 'Cherry', enabled: false };
      const key = this.getSecret(`provider:${kind}`);
      return [kind, { ...value, hasKey: !!key, keyMask: mask(key) }];
    })) as Record<ProviderKind, Provider>;
  }
  contacts(): Contact[] {
    const rows = this.db.prepare('SELECT id,name,aliases,token FROM contacts ORDER BY name').all() as unknown as { id: string; name: string; aliases: string; token: string | null }[];
    return rows.map(r => ({ id: r.id, name: r.name, aliases: JSON.parse(r.aliases), hasToken: !!r.token }));
  }
  saveContact(input: { id?: string; name: string; aliases: string[]; token?: string; clearToken?: boolean }): Contact {
    const id = input.id ?? randomUUID();
    const old = this.db.prepare('SELECT token FROM contacts WHERE id=?').get(id) as { token: string | null } | undefined;
    if (input.id && !old) throw new AppError(404, '联系人不存在');
    const token = input.clearToken ? null : input.token ? seal(this.key, input.token) : old?.token ?? null;
    this.db.prepare('INSERT INTO contacts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,aliases=excluded.aliases,token=excluded.token').run(id, input.name, JSON.stringify(input.aliases), token);
    return this.contacts().find(c => c.id === id)!;
  }
  contactToken(id: string): string {
    const row = this.db.prepare('SELECT token FROM contacts WHERE id=?').get(id) as { token: string | null } | undefined;
    return row?.token ? unseal(this.key, row.token) : '';
  }
  validateRecipients(input: ReminderInput) {
    if (input.channels.wechat && !this.getSecret('pushplus')) throw new AppError(400, '请先在设置中配置 pushplus 令牌，或关闭微信通知');
    for (const id of input.recipientIds) if (id !== 'self' && !this.contactToken(id)) throw new AppError(400, '接收人尚未绑定 pushplus 好友令牌，请先设置联系人');
  }
  reminders(): Reminder[] {
    return (this.db.prepare('SELECT * FROM reminders ORDER BY created_at DESC').all() as unknown as { id: string; revision: number; status: Reminder['status']; data: string; created_at: string }[]).map(row => {
      const data = JSON.parse(row.data) as ReminderInput;
      const ack = this.db.prepare('SELECT * FROM alarms WHERE reminder_id=? ORDER BY updated_at DESC LIMIT 1').get(row.id) as { revision: number; status: string; coverage: string | null; error: string | null } | undefined;
      const registered = ack?.revision === row.revision && ack.status === 'registered' && (!!ack.coverage && Date.parse(ack.coverage) > Date.now());
      const alarmHistory = data.channels.alarm || !!this.get<boolean>(`alarm-history:${row.id}`);
      const needsRemoval = (alarmHistory || !!ack) && (!data.channels.alarm || row.status === 'cancelled');
      const syncStatus = !alarmHistory && !ack ? 'not_required' : ack?.revision === row.revision && ack.status === 'failed' ? 'failed' : registered || (needsRemoval && ack?.revision === row.revision && ack.status === 'registered') ? 'registered' : 'pending';
      const now = new Date();
      const nextDueAt = row.status === 'active' ? occurrenceTimes(data, now, new Date(now.getTime() + 8 * 86400_000))[0] ?? null : null;
      return { ...data, id: row.id, revision: row.revision, status: row.status, createdAt: row.created_at, syncStatus, coverageUntil: ack?.revision === row.revision ? ack.coverage : null, syncError: ack?.revision === row.revision ? ack.error : null, nextDueAt };
    });
  }
  reminder(id: string) { return this.reminders().find(r => r.id === id); }
  draft(input: ReminderInput): Draft {
    const id = randomUUID(), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.db.prepare('INSERT INTO drafts VALUES (?,?,?,NULL)').run(id, JSON.stringify(input), expiresAt);
    return { id, reminder: input, expiresAt };
  }
  confirmDraft(id: string): Reminder {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM drafts WHERE id=?').get(id) as { data: string; expires_at: string; result_id: string | null } | undefined;
      if (!row) throw new AppError(404, '待确认的提醒不存在');
      if (row.result_id) return this.reminder(row.result_id)!;
      if (Date.parse(row.expires_at) < Date.now()) throw new AppError(409, '确认卡片已过期，请重新建立');
      const input = JSON.parse(row.data) as ReminderInput;
      if (Date.parse(input.dueAt) <= Date.now()) throw new AppError(409, '确认期间提醒时间已过去，请调整时间');
      this.validateRecipients(input);
      const reminderId = randomUUID();
      this.db.prepare('INSERT INTO reminders VALUES (?,1,?,?,?)').run(reminderId, 'active', row.data, new Date().toISOString());
      if (input.channels.alarm) this.set(`alarm-history:${reminderId}`, true);
      this.db.prepare('UPDATE drafts SET result_id=? WHERE id=?').run(reminderId, id);
      return this.reminder(reminderId)!;
    });
  }
  modify(id: string, revision: number, input: ReminderInput): Reminder {
    this.validateRecipients(input);
    return this.transaction(() => {
      const row = this.reminder(id);
      if (!row) throw new AppError(404, '提醒不存在');
      if (row.revision !== revision || row.status !== 'active') throw new AppError(409, '提醒已被其他设备修改，请刷新后重试');
      if (row.channels.alarm || input.channels.alarm) this.set(`alarm-history:${id}`, true);
      this.db.prepare('UPDATE reminders SET revision=revision+1,data=? WHERE id=?').run(JSON.stringify(input), id);
      return this.reminder(id)!;
    });
  }
  cancel(id: string, revision: number): Reminder {
    return this.transaction(() => {
      const row = this.reminder(id);
      if (!row) throw new AppError(404, '提醒不存在');
      if (row.status === 'cancelled') return row;
      if (row.revision !== revision) throw new AppError(409, '提醒已更新，请刷新后重试');
      this.db.prepare("UPDATE reminders SET revision=revision+1,status='cancelled' WHERE id=?").run(id);
      return this.reminder(id)!;
    });
  }
  materialize(now = new Date()) {
    const from = new Date(now.getTime() - 24 * 3600_000), until = new Date(now.getTime() + 7 * 24 * 3600_000);
    this.transaction(() => {
      for (const r of this.reminders().filter(r => r.status === 'active')) {
        const times = occurrenceTimes(r, from, until);
        if (r.recurrence === 'once' && Date.parse(r.dueAt) < from.getTime()) times.push(new Date(r.dueAt).toISOString());
        for (const dueAt of times) {
          const id = randomUUID();
          this.db.prepare('INSERT OR IGNORE INTO occurrences VALUES (?,?,?,?,?,?)').run(id, r.id, r.revision, dueAt, r.title, r.content);
          const occurrence = this.db.prepare('SELECT id FROM occurrences WHERE reminder_id=? AND revision=? AND due_at=?').get(r.id, r.revision, dueAt) as { id: string };
          const recipients = r.channels.wechat ? r.recipientIds.map(recipientId => ({ recipientId, channel: 'wechat' })) : [];
          if (r.channels.web && r.recipientIds.includes('self')) recipients.push({ recipientId: 'self', channel: 'web' });
          for (const item of recipients) this.db.prepare("INSERT OR IGNORE INTO deliveries(id,occurrence_id,recipient_id,channel,status,updated_at) VALUES (?,?,?,?,'pending',?)").run(randomUUID(), occurrence.id, item.recipientId, item.channel, now.toISOString());
        }
      }
      this.db.prepare("UPDATE deliveries SET status='cancelled',updated_at=? WHERE status IN ('pending','failed') AND occurrence_id IN (SELECT o.id FROM occurrences o JOIN reminders r ON r.id=o.reminder_id WHERE r.status='cancelled' OR r.revision!=o.revision)").run(now.toISOString());
    });
  }
  acknowledge(input: { reminderId: string; deviceId: string; revision: number; status: string; coverageUntil?: string | null; error?: string | null }) {
    const reminder = this.reminder(input.reminderId);
    if (!reminder || reminder.revision !== input.revision) throw new AppError(409, '提醒版本已改变，请重新同步');
    this.db.prepare('INSERT INTO alarms VALUES (?,?,?,?,?,?,?) ON CONFLICT(reminder_id,device_id) DO UPDATE SET revision=excluded.revision,status=excluded.status,coverage=excluded.coverage,error=excluded.error,updated_at=excluded.updated_at').run(input.reminderId, input.deviceId, input.revision, input.status, input.coverageUntil ?? null, input.error ?? null, new Date().toISOString());
  }
  close() { this.db.close(); }
}
