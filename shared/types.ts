export type Recurrence = 'once' | 'daily' | 'weekdays' | 'weekly';
export type Channels = { alarm: boolean; web: boolean; wechat: boolean };
export type ReminderInput = {
  title: string; content: string; dueAt: string; recurrence: Recurrence;
  weekdays: number[]; recipientIds: string[]; channels: Channels;
};
export type Reminder = ReminderInput & {
  id: string; revision: number; status: 'active' | 'cancelled'; createdAt: string;
  syncStatus: 'pending' | 'registered' | 'failed' | 'not_required';
  coverageUntil: string | null; syncError: string | null;
  nextDueAt: string | null;
};
export type Contact = { id: string; name: string; aliases: string[]; hasToken: boolean };
export type ProviderKind = 'asr' | 'llm' | 'tts';
export type Provider = {
  kind: ProviderKind; adapter: string; baseUrl: string; model: string; voice: string;
  enabled: boolean; hasKey: boolean; keyMask: string;
};
export type Delivery = {
  id: string; reminderId: string; title: string; dueAt: string; recipientId: string;
  channel: 'wechat' | 'web'; status: string; attempts: number;
  error: string | null; updatedAt: string;
};
export type Settings = {
  providers: Record<ProviderKind, Provider>; hasPushToken: boolean; pushTokenMask: string;
  timezone: string; vapidPublicKey: string;
  hasPushSecret: boolean;
};
export type Draft = { id: string; reminder: ReminderInput; expiresAt: string };
export type ParseResult = { draft?: Draft; question?: string; transcript?: string; configured?: boolean };
export type PlanAccount = { id: string; email: string; active: boolean; authorized: boolean };
export type PlanStatus = {
  available: boolean; accounts: PlanAccount[]; lastError: string | null;
  pending: boolean; models?: { slug: string; display_name: string }[];
};
