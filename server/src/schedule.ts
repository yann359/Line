import { DateTime } from 'luxon';
import { z } from 'zod';
import type { ReminderInput } from '../../shared/types.js';
import { AppError } from './security.js';

export const TIMEZONE = 'Asia/Shanghai';
export const reminderSchema = z.object({
  title: z.string().trim().min(1).max(100), content: z.string().max(2000).default(''),
  dueAt: z.iso.datetime({ offset: true }), recurrence: z.enum(['once', 'daily', 'weekdays', 'weekly']),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  recipientIds: z.array(z.string().min(1).max(64)).min(1).max(10),
  channels: z.object({ alarm: z.boolean(), web: z.boolean(), wechat: z.boolean() }).strict()
}).strict();
export function validateReminder(input: unknown, now = new Date()): ReminderInput {
  const value = reminderSchema.parse(input);
  if (DateTime.fromISO(value.dueAt).toMillis() <= now.getTime()) throw new AppError(400, '这个时间已经过去，请选择一个未来的时间');
  if (value.recurrence === 'weekly' && !value.weekdays.length) throw new AppError(400, '请选择重复的星期');
  if (!Object.values(value.channels).some(Boolean)) throw new AppError(400, '请至少开启一种提醒方式');
  value.recipientIds = [...new Set(value.recipientIds)];
  value.weekdays = [...new Set(value.weekdays)].sort();
  if (!value.recipientIds.includes('self') && (value.channels.alarm || value.channels.web)) throw new AppError(400, '手机闹钟和电脑通知仅能提醒本人');
  if (value.recipientIds.some(id => id !== 'self') && !value.channels.wechat) throw new AppError(400, '亲友提醒需要开启微信公众号通知');
  return value;
}
export function occurrenceTimes(reminder: ReminderInput, from: Date, until: Date): string[] {
  const anchor = DateTime.fromISO(reminder.dueAt, { setZone: true }).setZone(TIMEZONE);
  if (reminder.recurrence === 'once') return anchor.toMillis() <= until.getTime() && anchor.toMillis() >= from.getTime() ? [anchor.toUTC().toISO()!] : [];
  const start = DateTime.fromJSDate(from, { zone: TIMEZONE }).startOf('day');
  const end = DateTime.fromJSDate(until, { zone: TIMEZONE });
  const times: string[] = [];
  for (let day = start; day <= end; day = day.plus({ days: 1 })) {
    const date = day.set({ hour: anchor.hour, minute: anchor.minute, second: anchor.second, millisecond: anchor.millisecond });
    if (date < anchor || date.toMillis() < from.getTime() || date > end) continue;
    if (reminder.recurrence === 'weekdays' && date.weekday > 5) continue;
    if (reminder.recurrence === 'weekly' && !reminder.weekdays.includes(date.weekday)) continue;
    times.push(date.toUTC().toISO()!);
  }
  return times;
}
