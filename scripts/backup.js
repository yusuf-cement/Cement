import fs from 'node:fs';
import path from 'node:path';
import { openDb, DATA_DIR } from '../server/db.js';

const db = openDb();
const dir = path.resolve(process.env.BACKUP_DIR || 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `cement-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
// نسخ الصور المرفوعة
const up = path.join(DATA_DIR, 'uploads');
if (fs.existsSync(up)) fs.cpSync(up, file.replace(/\.db$/, '-uploads'), { recursive: true });
console.log('تم إنشاء النسخة الاحتياطية:', file);
// الاحتفاظ بآخر 30 نسخة
const olds = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().slice(0, -30);
for (const f of olds) { fs.rmSync(path.join(dir, f)); fs.rmSync(path.join(dir, f.replace(/\.db$/, '-uploads')), { recursive: true, force: true }); }
