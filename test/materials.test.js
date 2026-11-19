import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cement-mat-'));
process.env.DATA_DIR = tmp;
const { openDb, getSettings } = await import('../server/db.js');
const { createApp, createUser } = await import('../server/app.js');
let server, base, db, owner, staff;
before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL || 'postgres://cement:cement@localhost:5432/cement_test?sslmode=disable', { schema: 't_mat_' + process.pid });
  await createUser(db, 'owner1', 'owner-pass-123', 'owner'); await createUser(db, 'staff1', 'staff-pass-123', 'staff');
  server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.dropSchema(); await db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const call = async (m, u, b, c) => {
  const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...(c ? { Cookie: c, 'X-Requested-With': 'cement' } : {}) }, body: b && JSON.stringify(b) });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};
const login = async (u, p) => (await call('POST', '/api/admin/login', { username: u, password: p }, 'x=1')).headers.get('set-cookie').split(';')[0];

test('الاسم الافتراضي والتصنيفات والوحدات', async () => {
  assert.equal((await getSettings(db)).store_name, 'عالم الأسمنت ومواد البناء');
  owner = await login('owner1', 'owner-pass-123'); staff = await login('staff1', 'staff-pass-123');
  const f = (await call('POST', '/api/admin/factories', { name: 'علامة' }, owner)).json.id;
  assert.equal((await call('POST', '/api/admin/categories', { name: 'بلك وطوب' }, staff)).status, 403);
  const c = await call('POST', '/api/admin/categories', { name: 'بلك وطوب' }, owner);
  assert.equal(c.status, 201);
  assert.equal((await call('POST', '/api/admin/categories', { name: 'بلك وطوب' }, owner)).status, 409);
  const mk = (over) => call('POST', '/api/admin/products', { factory_id: f, category_id: c.json.id, retail_price: 350, stock: 1000, ...over }, owner);
  const blk = await mk({ name: 'بلك 20', unit: 'piece' });
  const cab = await mk({ name: 'سلك', unit: 'meter', stock: 100.5 });
  assert.equal(blk.status, 201); assert.equal(cab.status, 201);
  assert.equal((await mk({ name: 'x', unit: 'piece', stock: 10.5 })).status, 400, 'القطع بأعداد صحيحة');
  assert.equal((await mk({ name: 'y', unit: 'bogus' })).status, 400);
  assert.equal((await call('POST', '/api/admin/products', { factory_id: f, category_id: 999, name: 'z', unit: 'piece', retail_price: 1 }, owner)).status, 400);
  const cat = (await call('GET', '/api/catalog')).json;
  assert.equal(cat.categories[0].name, 'بلك وطوب');
  assert.equal(cat.units.piece.name, 'قطعة');
  assert.equal(cat.products.find((p) => p.name === 'بلك 20').category_name, 'بلك وطوب');
  const cust = { name: 'عميل', phone: '771234567', region: 'مأرب', fulfillment: 'pickup' };
  const frac = await call('POST', '/api/orders', { ...cust, idempotencyKey: 'mat-key-00001', items: [{ productId: blk.json.id, qty: 2.5 }] });
  assert.equal(frac.status, 409);
  const ok = await call('POST', '/api/orders', { ...cust, idempotencyKey: 'mat-key-00002', items: [{ productId: blk.json.id, qty: 200 }, { productId: cab.json.id, qty: 2.5 }] });
  assert.equal(ok.status, 201);
  const w = await call('POST', '/api/wholesale-requests', { ...cust, idempotencyKey: 'mat-key-00003', items: [{ productId: blk.json.id, qty: 1 }] });
  assert.equal(w.status, 201, 'حد الجملة الافتراضي لغير الكيس والطن = 1');
  const stk = await call('POST', `/api/admin/products/${blk.json.id}/stock`, { op: 'receive', qty: 1.5 }, owner);
  assert.equal(stk.status, 400);
  const csv = await fetch(base + '/api/admin/reports?csv=products', { headers: { Cookie: owner } });
  assert.match(await csv.text(), /بلك وطوب/);
});
