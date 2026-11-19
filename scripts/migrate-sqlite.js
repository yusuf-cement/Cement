// نقل بيانات المتجر القديم (SQLite) إلى PostgreSQL دون حذف القديم.
// الاستخدام:
//   DATABASE_URL=... node scripts/migrate-sqlite.js <cement.db> [--uploads <مجلد الصور>] [--site https://موقعك.onrender.com] [--dry-run] [--force] [--allow-empty]
// الصور: تُقرأ من --uploads إن وُجد، وإلا تُحمَّل من --site (الصور عامة على الموقع القديم).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { TABLES, importAll } from '../server/backup.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const src = args.find((a, i) => !a.startsWith('--') && !['--uploads', '--site'].includes(args[i - 1]));
if (!src || !fs.existsSync(src)) {
  console.error('الاستخدام: node scripts/migrate-sqlite.js <cement.db> [--uploads <مجلد>] [--site <رابط الموقع القديم>] [--dry-run] [--force]');
  process.exit(1);
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const ORDER_BY = { settings: 'key', customer_prices: 'customer_id,product_id' };

const lite = new DatabaseSync(src, { readOnly: true });
const have = new Set(lite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
for (const need of ['settings', 'products', 'orders', 'customers']) {
  if (!have.has(need)) {
    console.error(`الملف ليس قاعدة بيانات المتجر كاملة (الجدول «${need}» غير موجود).\nاستخدم النسخة المنزَّلة من لوحة المتجر القديم (الإعدادات ← تنزيل نسخة احتياطية)، ولا تنسخ ملف cement.db مباشرة من الخادم لأن جزءًا من بياناته قد يكون في ملف -wal الجانبي.`);
    process.exit(1);
  }
}
const tables = {};
for (const t of TABLES.filter((x) => x !== 'uploads')) {
  tables[t] = have.has(t) ? lite.prepare(`SELECT * FROM ${t} ORDER BY ${ORDER_BY[t] || 'id'}`).all().map((r) => ({ ...r })) : [];
}
lite.close();

// الصور
tables.uploads = [];
const names = new Set(tables.products.map((p) => p.image).filter(Boolean).map((p) => path.posix.basename(p)));
const upDir = opt('--uploads'), site = (opt('--site') || '').replace(/\/$/, '');
const missing = [];
for (const name of names) {
  if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(name)) { missing.push(name); continue; }
  let buf = null;
  try {
    if (upDir && fs.existsSync(path.join(upDir, name))) buf = fs.readFileSync(path.join(upDir, name));
    else if (site) { const r = await fetch(`${site}/uploads/${name}`); if (r.ok) buf = Buffer.from(await r.arrayBuffer()); }
  } catch (e) { console.warn('تعذّر تحميل', name, e.message); }
  if (buf) tables.uploads.push({ name, mime: MIME[name.split('.')[1]], data: buf.toString('base64') });
  else missing.push(name);
}
if (missing.length) console.warn(`تحذير: ${missing.length} صورة لم تُوجد (${missing.join(', ')}). ستبقى المنتجات لكن بلا صورة حتى ترفعها من اللوحة.`);
const found = new Set(tables.uploads.map((u) => u.name));
for (const p of tables.products) if (p.image && !found.has(path.posix.basename(p.image))) p.image = null;

const dump = { format: 'cement-backup', version: 1, exported_at: new Date().toISOString(), tables };
const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
const fingerprint = (t) => ({
  counts: Object.fromEntries(TABLES.map((n) => [n, t[n].length])),
  orders_total: sum(t.orders, 'total'), payments_total: sum(t.payments, 'amount'),
  stock_total: Math.round(sum(t.products, 'stock') * 1000) / 1000, reserved_total: Math.round(sum(t.products, 'reserved') * 1000) / 1000,
});
const before = fingerprint(tables);
if (!before.counts.products && !before.counts.orders && !before.counts.customers && !flag('--allow-empty')) {
  console.error('المصدر لا يحتوي أي منتج أو طلب أو عميل، فلن أنقل شيئًا. تأكد من الملف الصحيح (أو أضف --allow-empty إن كان فارغًا فعلًا).');
  process.exit(1);
}
console.log('المصدر (SQLite):', JSON.stringify(before));

if (flag('--dry-run')) {
  const out = src + '.migration-dump.json';
  fs.writeFileSync(out, JSON.stringify(dump));
  console.log('تجربة فقط، لم يُكتب شيء في PostgreSQL. الملف:', out);
  process.exit(0);
}

const db = await openDb();
const existing = (await db.get('SELECT (SELECT COUNT(*) FROM orders)+(SELECT COUNT(*) FROM products)+(SELECT COUNT(*) FROM customers) n')).n;
if (existing > 0 && !flag('--force')) {
  console.error(`القاعدة الهدف ليست فارغة (${existing} سجلًا). النقل يستبدل محتواها. أضف --force إن كنت متأكدًا.`);
  await db.close(); process.exit(1);
}
await importAll(db, dump);

// تحقق: قراءة ما كُتب ومقارنته بالمصدر
const readBack = {};
for (const t of TABLES) readBack[t] = await db.all(`SELECT * FROM ${t}`);
const after = fingerprint(readBack);
console.log('الهدف (PostgreSQL):', JSON.stringify(after));
await db.close();
if (JSON.stringify(before) !== JSON.stringify(after)) { console.error('فشل التحقق: الأرقام لا تتطابق! لا تعتمد النقل.'); process.exit(2); }
console.log('✔ تم النقل والتحقق: الأعداد والمجاميع (الطلبات والمدفوعات والمخزون) متطابقة تمامًا.');
console.log('ملاحظة: جلسات الدخول لا تُنقل، فسجّل الدخول من جديد.');
