import 'dotenv/config';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { masterKey } from './security.js';
import { createApp } from './app.js';

const directory = resolve(process.env.DATA_DIR || 'data');
const store = new Store(directory, masterKey(directory));
const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 8787);
const production = process.env.NODE_ENV === 'production';
const origin = process.env.APP_ORIGIN || (production ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:5173');
const { app } = await createApp(store, { origin, host, production, plan: process.env.ENABLE_CHATGPT_PLAN !== 'false', allowLocal: process.env.ALLOW_LOCAL_PROVIDERS === 'true' });
await app.listen({ host, port });
console.log(`Line 后台已启动：http://${host}:${port}；数据目录：${directory}`);
const stop = async () => { await app.close(); store.close(); process.exit(0); };
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
