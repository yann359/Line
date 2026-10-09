import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { mkdirSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
const dir = resolve(process.env.DATA_DIR || 'data'), backup = resolve(dir, 'backups');
mkdirSync(backup, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-'), target = resolve(backup, stamp);
mkdirSync(target, { mode: 0o700 });
const db = new DatabaseSync(resolve(dir, 'line.sqlite'));
db.prepare('VACUUM INTO ?').run(resolve(target, 'line.sqlite')); db.close();
copyFileSync(resolve(dir, 'master.key'), resolve(target, 'master.key'));
const names = readdirSync(backup).filter(n => /^\d{4}-/.test(n)).sort().reverse();
for (const old of names.slice(7)) { const absolute = resolve(backup, old); if (!absolute.startsWith(backup + '\\') && !absolute.startsWith(backup + '/')) throw new Error('备份路径越界'); rmSync(absolute, { recursive: true }); }
console.log(`备份已保存：${target}（保留最近7份）`);
