import fs from 'node:fs';
import { openDb } from '../server/db.js';
import { importAll } from '../server/backup.js';

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('الاستخدام: npm run restore -- <مسار ملف النسخة .json>\nتنبيه: الاستعادة تستبدل كل بيانات القاعدة الحالية.'); process.exit(1); }
const db = await openDb();
const counts = await importAll(db, JSON.parse(fs.readFileSync(src, 'utf8')));
await db.close();
console.log('تمت الاستعادة:', counts);
