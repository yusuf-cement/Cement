import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cement-seed-'));
process.env.DATA_DIR = tmp;
const { openDb } = await import('../server/db.js');
const { createApp, createUser } = await import('../server/app.js');
const { seedProducts } = await import('../scripts/seed-products.js');
let server, base, db, owner;
before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL || 'postgres://cement:cement@localhost:5432/cement_test?sslmode=disable', { schema: 't_seed_' + process.pid });
  await createUser(db, 'owner1', 'owner-pass-123', 'owner');
  server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.dropSchema(); await db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const call = async (m, u, b, c) => {
  const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...(c ? { Cookie: c, 'X-Requested-With': 'cement' } : {}) }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
const count = async (t) => (await db.get(`SELECT COUNT(*) n FROM ${t}`)).n;

test('إضافة المنتجات الجاهزة: 5 منتجات مخفية بلا سعر ولا كمية، وتتخطى المكرر', async () => {
  const r1 = await seedProducts(db);
  assert.equal(r1.added.length, 5);
  assert.equal(await count('products'), 5);
  assert.equal(await count('factories'), 1);
  assert.equal(await count('categories'), 1);
  assert.equal(await count('uploads'), 5);
  const rows = await db.all('SELECT * FROM products');
  for (const p of rows) {
    assert.equal(p.active, 0, 'مخفي'); assert.equal(p.retail_price, 0); assert.equal(p.stock, 0);
    assert.equal(p.unit, 'bag'); assert.equal(p.bag_weight_kg, 50); assert.ok(p.image && p.spec && p.cement_type);
  }
  // لا تظهر للزبائن
  assert.equal((await call('GET', '/api/catalog')).json.products.length, 0);
  // التكرار لا يضيف شيئًا
  const r2 = await seedProducts(db);
  assert.equal(r2.added.length, 0); assert.equal(r2.skipped.length, 5);
  assert.equal(await count('products'), 5); assert.equal(await count('uploads'), 5);
});

test('تعديلات المالك (سعر وكمية وتفعيل) تظهر في المتجر مع الصورة، ولا يعيد الإضافة كتابتها', async () => {
  const c = (await call('POST', '/api/admin/login', { username: 'owner1', password: 'owner-pass-123' }, 'x=1')).headers.get('set-cookie').split(';')[0];
  const p = (await call('GET', '/api/admin/products', undefined, c)).json.find((x) => x.name.includes('(OPC)') && x.name.includes('42.5N'));
  assert.ok(p, 'المنتج موجود في لوحة الإدارة');
  const put = await call('PUT', '/api/admin/products/' + p.id, { ...p, retail_price: 5200, active: true }, c);
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal((await call('POST', `/api/admin/products/${p.id}/stock`, { op: 'receive', qty: 300 }, c)).status, 200);
  const cat = (await call('GET', '/api/catalog')).json;
  assert.equal(cat.products.length, 1);
  const shown = cat.products[0];
  assert.equal(shown.price, 5200); assert.equal(shown.available, 300); assert.equal(shown.availability, 'available');
  assert.equal(shown.bag_weight_kg, 50); assert.equal(shown.category_name, 'أسمنت');
  assert.match(shown.factory_name, /الشركة العربية اليمنية للأسمنت/);
  const img = await fetch(base + shown.image);
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/webp');
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.equal(bytes.toString('latin1', 0, 4), 'RIFF'); assert.equal(bytes.toString('latin1', 8, 12), 'WEBP');
  // إعادة الإضافة لا تمسّ السعر ولا التفعيل
  await seedProducts(db);
  const after = (await call('GET', '/api/catalog')).json.products;
  assert.equal(after.length, 1); assert.equal(after[0].price, 5200);
  // ويمكن طلب المنتج فعليًا
  const o = await call('POST', '/api/orders', { name: 'تجربة', phone: '771234567', region: 'مأرب', fulfillment: 'pickup', paymentMethod: 'cash', idempotencyKey: 'seed-order-1', items: [{ productId: p.id, qty: 10 }] });
  assert.equal(o.status, 201, JSON.stringify(o.json));
});
