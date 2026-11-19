import readline from 'node:readline/promises';
import { openDb } from '../server/db.js';
import { createUser } from '../server/app.js';

const db = await openDb();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const username = (process.argv[2] || (await rl.question('اسم المستخدم: '))).trim();
const password = process.argv[3] || (await rl.question('كلمة المرور (8 أحرف على الأقل): '));
const role = process.argv[4] || 'owner';
rl.close();
await createUser(db, username, password, role);
console.log(`تم إنشاء المستخدم ${username} (${role})`);
await db.close();
