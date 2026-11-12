import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../server/db.js';

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('الاستخدام: npm run restore -- <مسار ملف النسخة .db>  (أوقف الخادم أولًا)'); process.exit(1); }
const target = path.join(DATA_DIR, 'cement.db');
if (fs.existsSync(target)) fs.copyFileSync(target, target + '.before-restore');
for (const ext of ['-wal', '-shm']) fs.rmSync(target + ext, { force: true });
fs.copyFileSync(src, target);
const upSrc = src.replace(/\.db$/, '-uploads');
if (fs.existsSync(upSrc)) fs.cpSync(upSrc, path.join(DATA_DIR, 'uploads'), { recursive: true });
console.log('تمت الاستعادة. شغّل الخادم من جديد.');
