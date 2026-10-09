import webpush from 'web-push';
import { DateTime } from 'luxon';
import type { Store } from './store.js';
import type { Delivery } from '../../shared/types.js';
import { digest } from './security.js';

type Row = { id: string; occurrence_id: string; recipient_id: string; channel: string; status: string; attempts: number; provider_ref: string | null; due_at: string; title: string; content: string; reminder_id: string; current_status: string; revision: number; current_revision: number; updated_at: string };
export class DeliveryWorker {
  private busy = false;
  private access?: { value: string; expires: number };
  private timer?: NodeJS.Timeout;
  constructor(private store: Store, private fetcher: typeof fetch = fetch) {
    if (!store.get<string>('vapid:public')) {
      const pair = webpush.generateVAPIDKeys(); store.set('vapid:public', pair.publicKey); store.setSecret('vapid:private', pair.privateKey);
    }
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:owner@example.com', store.get<string>('vapid:public')!, store.getSecret('vapid:private'));
    // A crash between sending and persisting the response must not trigger another send.
    store.db.prepare("UPDATE deliveries SET status='unknown',error='服务重启，无法确认上次请求结果；已停止自动重发' WHERE status='processing' AND provider_ref IS NULL").run();
  }
  list(): Delivery[] {
    return (this.store.db.prepare(`SELECT d.*,o.reminder_id,o.title,o.due_at FROM deliveries d JOIN occurrences o ON o.id=d.occurrence_id ORDER BY o.due_at DESC LIMIT 200`).all() as any[]).map(d => ({ id: d.id, reminderId: d.reminder_id, title: d.title, dueAt: d.due_at, recipientId: d.recipient_id, channel: d.channel, status: d.status, attempts: d.attempts, error: d.error, updatedAt: d.updated_at }));
  }
  start() { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 2000); this.timer.unref(); void this.tick().catch(() => {}); }
  close() { clearInterval(this.timer); }
  private update(id: string, status: string, error: string | null, retry = 0, ref?: string | null) {
    this.store.db.prepare('UPDATE deliveries SET status=?,error=?,retry_at=?,updated_at=?,provider_ref=COALESCE(?,provider_ref) WHERE id=?').run(status, error, retry, new Date().toISOString(), ref ?? null, id);
  }
  private permit(now: number, hash: string) {
    const start = DateTime.fromMillis(now, { zone: 'Asia/Shanghai' }).startOf('day').toMillis();
    this.store.db.prepare('DELETE FROM push_requests WHERE at<?').run(start);
    this.store.db.prepare('DELETE FROM push_content_requests WHERE at<?').run(now - 3600_000);
    const rows = this.store.db.prepare('SELECT at FROM push_requests').all() as { at: number }[];
    if (rows.length >= 200 || rows.filter(r => r.at > now - 60_000).length >= 5) return false;
    const identical = this.store.db.prepare('SELECT count(*) AS n FROM push_content_requests WHERE hash=?').get(hash) as { n: number };
    if (identical.n >= 3) return false;
    this.store.db.prepare('INSERT INTO push_requests VALUES (?)').run(now);
    this.store.db.prepare('INSERT INTO push_content_requests VALUES (?,?)').run(hash, now); return true;
  }
  private async json(url: string, body?: unknown, key?: string): Promise<any> {
    const r = await this.fetcher(url, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'access-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!r.ok) throw new Error('upstream transport status');
    return r.json();
  }
  private async result(ref: string): Promise<number | null> {
    const secretKey = this.store.getSecret('pushplus-secret');
    if (!secretKey) return null;
    if (!this.access || this.access.expires < Date.now() + 60_000) {
      const r = await this.json('https://www.pushplus.plus/api/common/openApi/getAccessKey', { token: this.store.getSecret('pushplus'), secretKey });
      if (r.code !== 200 || !r.data?.accessKey) throw new Error('query authorization failed');
      this.access = { value: r.data.accessKey, expires: Date.now() + Number(r.data.expiresIn) * 1000 };
    }
    const r = await this.json(`https://www.pushplus.plus/api/open/message/sendMessageResult?shortCode=${encodeURIComponent(ref)}`, undefined, this.access.value);
    if (r.code !== 200) { this.access = undefined; throw new Error('query failed'); }
    return r.data?.status ?? null;
  }
  async tick(now = new Date()) {
    if (this.busy) return; this.busy = true; const tickStarted = Date.now(), baseTime = now.getTime();
    try {
      this.store.materialize(now);
      const rows = this.store.db.prepare(`SELECT d.*,o.title,o.content,o.due_at,o.reminder_id,o.revision,r.revision AS current_revision,r.status AS current_status FROM deliveries d JOIN occurrences o ON d.occurrence_id=o.id JOIN reminders r ON o.reminder_id=r.id WHERE o.due_at<=? AND d.status IN ('pending','failed','processing') AND d.retry_at<=? ORDER BY o.due_at LIMIT 20`).all(now.toISOString(), now.getTime()) as unknown as Row[];
      for (const row of rows) {
        const instant = new Date(baseTime + Date.now() - tickStarted);
        if (row.status === 'processing') {
          if (!row.provider_ref) { this.update(row.id, 'unknown', '发送结果不明确，已停止自动重发'); continue; }
          try {
            const status = await this.result(row.provider_ref);
            if (status === 2) this.update(row.id, 'success', null);
            else if (status === 3) this.update(row.id, 'failed', 'pushplus 确认发送失败', now.getTime() + 15_000);
            else if (Date.parse(row.updated_at) < now.getTime() - 24 * 3600_000) this.update(row.id, 'unknown', '超过一天仍无法确认发送结果');
            else this.store.db.prepare('UPDATE deliveries SET retry_at=?,error=? WHERE id=?').run(now.getTime() + 30_000, status === null ? '已受理；请配置查询 secretKey 以核实最终结果' : null, row.id);
          } catch { this.store.db.prepare('UPDATE deliveries SET retry_at=?,error=? WHERE id=?').run(now.getTime() + 60_000, '结果查询失败，请检查 secretKey、开放接口和 IP 白名单', row.id); }
          continue;
        }
        if (row.current_status !== 'active' || row.revision !== row.current_revision) { this.update(row.id, 'cancelled', '提醒已取消或修改'); continue; }
        const late = instant.getTime() - Date.parse(row.due_at);
        if (late > 5 * 60_000) { this.update(row.id, 'missed', '超过五分钟补发期限，未发送'); continue; }
        if (row.attempts >= 4) { this.update(row.id, 'exhausted', '发送失败，已完成最多三次重试'); continue; }
        if (row.channel === 'wechat' && !this.permit(instant.getTime(), digest(`${row.recipient_id}|${row.title}|${row.content}|${row.due_at}`))) {
          this.store.db.prepare('UPDATE deliveries SET error=? WHERE id=?').run('达到 pushplus 每分钟、每日或同内容限额，等待配额恢复', row.id); continue;
        }
        this.store.db.prepare("UPDATE deliveries SET status='processing',attempts=attempts+1,provider_ref=NULL,updated_at=? WHERE id=?").run(now.toISOString(), row.id);
        const current = this.store.reminder(row.reminder_id);
        if (!current || current.status !== 'active' || current.revision !== row.revision) { this.update(row.id, 'cancelled', '提醒已更新'); continue; }
        const content = `${row.content || row.title}\n北京时间 ${DateTime.fromISO(row.due_at).setZone('Asia/Shanghai').toFormat('yyyy-MM-dd HH:mm')}${late >= 30_000 ? '\n（迟到补发）' : ''}`;
        if (row.channel === 'web') {
          const subscriptions = this.store.db.prepare('SELECT id,data FROM push_subscriptions').all() as { id: string; data: string }[];
          if (!subscriptions.length) { this.update(row.id, 'failed', '电脑尚未启用浏览器通知', now.getTime() + 30_000); continue; }
          let accepted = false, uncertain = false;
          for (const subscription of subscriptions) {
            try {
              const value = JSON.parse(this.store.getSecret(`subscription:${subscription.id}`));
              await webpush.sendNotification(value, JSON.stringify({ id: row.id, title: row.title, body: content, dueAt: row.due_at }), { TTL: Math.max(1, Math.floor((300_000 - late) / 1000)), timeout: 15_000 }); accepted = true;
            } catch (e: any) {
              if ([404, 410].includes(e.statusCode)) { this.store.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(subscription.id); this.store.delete(`secret:subscription:${subscription.id}`); }
              else uncertain = true;
            }
          }
          this.update(row.id, accepted ? 'success' : uncertain ? 'unknown' : 'failed', accepted ? '浏览器推送服务已接收；设备展示和阅读未核实' : uncertain ? '推送结果不明确，已停止自动重发' : '浏览器订阅已失效', now.getTime() + 30_000); continue;
        }
        try {
          const token = this.store.getSecret('pushplus'), to = row.recipient_id === 'self' ? '' : this.store.contactToken(row.recipient_id);
          if (!token || row.recipient_id !== 'self' && !to) { this.update(row.id, 'failed', '推送令牌缺失', now.getTime() + 30_000); continue; }
          const r = await this.json('https://www.pushplus.plus/send', { token, title: row.title, content, template: 'txt', channel: 'wechat', ...(to ? { to } : {}) });
          if (r.code === 200 && typeof r.data === 'string' && r.data) this.update(row.id, 'processing', null, now.getTime() + 15_000, r.data);
          else if (typeof r.code === 'number' && r.code !== 200) this.update(row.id, 'failed', `pushplus 拒绝请求（${r.code}）`, now.getTime() + [15, 45, 90, 90][Math.min(row.attempts, 3)] * 1000);
          else this.update(row.id, 'unknown', '响应不完整，无法确认是否已接收；已停止自动重发');
        } catch { this.update(row.id, 'unknown', '网络中断，无法确认是否已接收；已停止自动重发'); }
      }
    } finally { this.busy = false; }
  }
}
