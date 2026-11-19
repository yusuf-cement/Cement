import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { exportAll } from '../server/backup.js';

const db = await openDb();
const dir = path.resolve(process.env.BACKUP_DIR || 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `cement-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(await exportAll(db)));
await db.close();
console.log('تم إنشاء النسخة الاحتياطية (تشمل الصور):', file);
// الاحتفاظ بآخر 30 نسخة
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().slice(0, -30)) fs.rmSync(path.join(dir, f));
