import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { masterKey, passwordRecord } from './security.js';

const dir = resolve(process.env.DATA_DIR || 'data'), store = new Store(dir, masterKey(dir));
if (store.get('account')) { console.log('账号已经建立，此命令不会覆盖它。'); store.close(); process.exit(0); }
const terminal = createInterface({ input: stdin, output: stdout });
const username = (await terminal.question('管理账号：')).trim();
console.log('请在可信的本机终端输入密码（终端会显示输入，请勿共享此窗口）。');
const password = await terminal.question('至少12位密码：');
terminal.close();
if (!username || password.length < 12 || password.length > 128) throw new Error('账号不能为空，密码应为12至128位');
store.set('account', { username, ...await passwordRecord(password) }); store.close(); console.log('私有管理账号已建立。');
