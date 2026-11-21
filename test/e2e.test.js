import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cement-'));
process.env.DATA_DIR = tmp;
process.env.ORDER_RATE_MAX = '1000';
const { openDb } = await import('../server/db.js');
const { createApp, createUser } = await import('../server/app.js');

let server, base, db;
before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL || 'postgres://cement:cement@localhost:5432/cement_test?sslmode=disable', { schema: 't_e2e_' + process.pid });
  await createUser(db, 'owner1', 'owner-pass-123', 'owner');
  await createUser(db, 'staff1', 'staff-pass-123', 'staff');
  server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await db.dropSchema(); await db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function call(method, url, body, cookie, extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (cookie) { headers.Cookie = cookie; headers['X-Requested-With'] = 'cement'; }
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
async function login(username, password) {
  const r = await call('POST', '/api/admin/login', { username, password }, null, { 'X-Requested-With': 'cement' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.headers.get('set-cookie').split(';')[0];
}
let seq = 0;
const key = () => `test-key-${Date.now()}-${++seq}-abcdef`;
const customer = (over = {}) => ({ name: 'عميل تجريبي', phone: '771234567', region: 'مأرب', address: 'حي الجامعة - بجوار المسجد', fulfillment: 'delivery', paymentMethod: 'cash', idempotencyKey: key(), ...over });

let owner, staff, factoryId;
async function newProduct(over = {}) {
  const r = await call('POST', '/api/admin/products', {
    factory_id: factoryId, name: 'أسمنت بورتلاندي ' + (++seq), cement_type: 'عادي', unit: 'bag', bag_weight_kg: 50,
    retail_price: 7000, stock: 1000, min_order: 1, low_stock_at: 20, wholesale_hint: 6500, ...over,
  }, owner);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}
const productStock = async (id) => (await db.get('SELECT stock,reserved FROM products WHERE id=?', id));

test('الإعداد: دخول المدير وإضافة مصنع', async () => {
  owner = await login('owner1', 'owner-pass-123');
  staff = await login('staff1', 'staff-pass-123');
  const r = await call('POST', '/api/admin/factories', { name: 'مصنع تجريبي' }, owner);
  assert.equal(r.status, 201);
  factoryId = r.json.id;
});

test('السيناريو الكامل: من إضافة المنتج حتى التسليم والتحصيل والتقارير', async () => {
  // 1-2: إضافة منتج وتحديد سعر التجزئة والمخزون
  const pid = await newProduct({ retail_price: 7000, stock: 500 });
  // 3-4: عميل يرى السعر ويختار 100 كيس
  const cat = await call('GET', '/api/catalog');
  const prod = cat.json.products.find((p) => p.id === pid);
  assert.equal(prod.price, 7000);
  assert.equal(prod.available, 500);
  assert.equal(prod.wholesale_hint, undefined, 'لا يجوز كشف السعر المرجعي للجملة');
  const q = await call('POST', '/api/quote', { items: [{ productId: pid, qty: 100 }] });
  assert.equal(q.json.items_total, 700000);
  // 5-6: التوصيل وإرسال الطلب (مع محاولة تلاعب بالسعر من المتصفح)
  const sub = await call('POST', '/api/orders', { ...customer(), items: [{ productId: pid, qty: 100, price: 1, unit_price: 1 }], total: 5, expectedTotal: 700000 });
  assert.equal(sub.status, 201);
  assert.match(sub.json.number, /^AS-\d{6}$/);
  const token = sub.json.token;
  // 7: يظهر في لوحة الإدارة
  const list = await call('GET', '/api/admin/orders?q=' + sub.json.number, undefined, owner);
  assert.equal(list.json.length, 1);
  const id = list.json[0].id;
  assert.equal(list.json[0].items_total, 700000, 'السعر يُحسب على الخادم');
  assert.equal(list.json[0].status, 'new');
  // المخزون لم يُحجز بعد
  assert.deepEqual({ ...(await productStock(pid)) }, { stock: 500, reserved: 0 });
  // العميل لا يرى إجماليًا نهائيًا قبل تحديد أجرة النقل
  let t = await call('GET', '/api/track/' + token);
  assert.equal(t.json.total, null);
  assert.equal(t.json.fee_pending, true);
  // لا يمكن التأكيد المباشر ولا إرسال عرض بدون أجرة
  assert.equal((await call('POST', `/api/admin/orders/${id}/confirm`, {}, owner)).status, 400);
  assert.equal((await call('POST', `/api/admin/orders/${id}/send_quote`, {}, owner)).status, 400);
  // 8-9: مراجعة وتحديد الأجرة وإرسال عرض السعر
  await call('POST', `/api/admin/orders/${id}/review`, {}, owner);
  await call('POST', `/api/admin/orders/${id}/note`, { text: 'ملاحظة داخلية سرية' }, owner);
  await call('POST', `/api/admin/orders/${id}/set_fee`, { fee: 50000 }, owner);
  const sq = await call('POST', `/api/admin/orders/${id}/send_quote`, { note: 'التوصيل خلال يومين' }, owner);
  assert.equal(sq.json.status, 'quote_sent');
  assert.equal(sq.json.total, 750000);
  t = await call('GET', '/api/track/' + token);
  assert.equal(t.json.total, 750000);
  assert.equal(t.json.can_respond, true);
  assert.ok(!JSON.stringify(t.json).includes('سرية'), 'الملاحظات الداخلية لا تظهر للعميل');
  assert.equal(t.json.status_label, 'تم إرسال عرض السعر');
  // لا دفع ولا تسليم قبل التأكيد
  assert.equal((await call('POST', `/api/admin/orders/${id}/payment`, { amount: 1000 }, owner)).status, 409);
  assert.equal((await call('POST', `/api/admin/orders/${id}/deliver`, {}, owner)).status, 409);
  // 10-11: موافقة العميل → حجز الكمية
  const ap = await call('POST', `/api/track/${token}/approve`, {});
  assert.equal(ap.json.status, 'confirmed');
  assert.deepEqual({ ...(await productStock(pid)) }, { stock: 500, reserved: 100 });
  // 12: تجهيز وخروج للتوصيل
  await call('POST', `/api/admin/orders/${id}/prepare`, {}, staff);
  await call('POST', `/api/admin/orders/${id}/dispatch`, { driver_name: 'سائق', driver_phone: '770000000' }, staff);
  t = await call('GET', '/api/track/' + token);
  assert.equal(t.json.status, 'out_for_delivery');
  assert.equal(t.json.driver.name, 'سائق');
  // خروج التوصيل لا يعني اكتمال الطلب
  assert.notEqual(t.json.status, 'completed_paid');
  // 13: التسليم والتحصيل
  const dl = await call('POST', `/api/admin/orders/${id}/deliver`, {}, owner);
  assert.equal(dl.json.status, 'delivered');
  assert.match(dl.json.invoice_no, /^INV-\d{6}$/);
  assert.deepEqual({ ...(await productStock(pid)) }, { stock: 400, reserved: 0 });
  assert.equal(dl.json.payment_status, 'unpaid', 'التسليم لا يعني الدفع');
  assert.equal((await call('POST', `/api/admin/orders/${id}/payment`, { amount: 800000 }, owner)).status, 400, 'أكبر من المتبقي');
  let pay = await call('POST', `/api/admin/orders/${id}/payment`, { amount: 250000 }, owner);
  assert.equal(pay.json.payment_status, 'partial');
  assert.equal(pay.json.status, 'delivered');
  pay = await call('POST', `/api/admin/orders/${id}/payment`, { amount: 500000 }, owner);
  assert.equal(pay.json.status, 'completed_paid');
  assert.equal(pay.json.payment_status, 'paid');
  assert.equal(pay.json.doc_kind, 'فاتورة بيع مكتملة (مدفوعة)');
  // 14: التقارير ولوحة المؤشرات
  const rep = await call('GET', '/api/admin/reports', undefined, owner);
  assert.ok(rep.json.sales.total >= 750000);
  assert.ok(rep.json.top_products.some((p) => p.qty >= 100));
  const sum = await call('GET', '/api/admin/summary', undefined, owner);
  assert.ok(sum.json.sales_today >= 750000);
  assert.ok(sum.json.collected_today >= 750000);
  const csv = await fetch(base + '/api/admin/reports?csv=sales', { headers: { Cookie: owner } });
  assert.equal(csv.status, 200);
  assert.ok((await csv.text()).includes('INV-'));
  // سجل التغييرات باسم المستخدم
  const full = await call('GET', `/api/admin/orders/${id}`, undefined, owner);
  assert.ok(full.json.events.some((e) => e.actor === 'staff1' && e.status === 'preparing'));
  assert.ok(full.json.events.some((e) => e.actor === 'العميل' || e.actor === 'owner1'));
  const movements = (await db.all('SELECT kind FROM stock_movements WHERE order_id=?', id)).map((m) => m.kind);
  assert.deepEqual(movements, ['reserve', 'issue']);
});

test('الجملة: طلب تسعير، سعر خاص، رفض العرض وقبوله', async () => {
  const pid = await newProduct({ stock: 2000, retail_price: 7000, wholesale_min: 300 });
  // أقل من الحد الأدنى للجملة
  const low = await call('POST', '/api/wholesale-requests', { ...customer(), items: [{ productId: pid, qty: 100 }] });
  assert.equal(low.status, 409);
  const w = await call('POST', '/api/wholesale-requests', { ...customer({ fulfillment: 'pickup' }), items: [{ productId: pid, qty: 400 }] });
  assert.equal(w.status, 201);
  const list = await call('GET', '/api/admin/orders?q=' + w.json.number, undefined, owner);
  const id = list.json[0].id;
  assert.equal(list.json[0].status, 'wholesale_pending');
  let t = await call('GET', '/api/track/' + w.json.token);
  assert.equal(t.json.total, null);
  assert.equal(t.json.items[0].unit_price, null, 'لا تُعرض أسعار جملة قبل اعتمادها');
  // لا تأكيد ولا حجز قبل التسعير
  assert.equal((await call('POST', `/api/admin/orders/${id}/send_quote`, {}, owner)).status, 400);
  assert.equal((await call('POST', `/api/track/${w.json.token}/approve`, {})).status, 409);
  assert.deepEqual({ ...(await productStock(pid)) }, { stock: 2000, reserved: 0 });
  // تسعير خاص دون المساس بسعر التجزئة العام
  const det = await call('GET', `/api/admin/orders/${id}`, undefined, owner);
  const itemId = det.json.items[0].id;
  await call('POST', `/api/admin/orders/${id}/set_prices`, { items: [{ id: itemId, unit_price: 6400 }] }, owner);
  const sq = await call('POST', `/api/admin/orders/${id}/send_quote`, {}, owner);
  assert.equal(sq.json.total, 2560000);
  assert.equal((await call('GET', '/api/catalog')).json.products.find((p) => p.id === pid).price, 7000);
  // العميل يرفض → إلغاء بلا أي أثر على المخزون
  const rj = await call('POST', `/api/track/${w.json.token}/reject`, { reason: 'السعر مرتفع' });
  assert.equal(rj.json.status, 'cancelled');
  assert.deepEqual({ ...(await productStock(pid)) }, { stock: 2000, reserved: 0 });
  // طلب ثانٍ: تعديل السعر بعد إرسال العرض يعيد الطلب للمراجعة مع إيضاح للعميل
  const w2 = await call('POST', '/api/wholesale-requests', { ...customer({ fulfillment: 'pickup' }), items: [{ productId: pid, qty: 500 }] });
  const id2 = (await call('GET', '/api/admin/orders?q=' + w2.json.number, undefined, owner)).json[0].id;
  const item2 = (await call('GET', `/api/admin/orders/${id2}`, undefined, owner)).json.items[0].id;
  await call('POST', `/api/admin/orders/${id2}/set_prices`, { items: [{ id: item2, unit_price: 6500 }] }, owner);
  await call('POST', `/api/admin/orders/${id2}/send_quote`, {}, owner);
  const ed = await call('POST', `/api/admin/orders/${id2}/set_prices`, { items: [{ id: item2, unit_price: 6300 }] }, owner);
  assert.equal(ed.json.status, 'under_review');
  assert.ok(JSON.stringify((await call('GET', '/api/track/' + w2.json.token)).json.events).includes('6500'));
  await call('POST', `/api/admin/orders/${id2}/send_quote`, {}, owner);
  const ok = await call('POST', `/api/track/${w2.json.token}/approve`, {});
  assert.equal(ok.json.status, 'confirmed');
  assert.deepEqual({ ...(await productStock(pid)) }, { stock: 2000, reserved: 500 });
  // استلام من المستودع بلا أجرة نقل
  assert.equal(ok.json.delivery_fee, null);
  assert.equal(ok.json.total, 3150000);
  assert.equal((await call('POST', `/api/admin/orders/${id2}/set_fee`, { fee: 1000 }, owner)).status, 409);
});

test('الإلغاء يعيد الكمية المحجوزة، واسترجاع المبالغ المحصّلة', async () => {
  const pid = await newProduct({ stock: 100 });
  const s = await call('POST', '/api/orders', { ...customer({ fulfillment: 'pickup' }), items: [{ productId: pid, qty: 60 }] });
  const id = (await call('GET', '/api/admin/orders?q=' + s.json.number, undefined, owner)).json[0].id;
  const c = await call('POST', `/api/admin/orders/${id}/confirm`, {}, owner);
  assert.equal(c.json.status, 'confirmed');
  assert.equal((await productStock(pid)).reserved, 60);
  await call('POST', `/api/admin/orders/${id}/payment`, { amount: 100000, method: 'cash' }, owner);
  assert.equal((await call('POST', `/api/admin/orders/${id}/cancel`, { reason: 'x' }, owner)).status, 409, 'يلزم تأكيد الاسترجاع');
  const cx = await call('POST', `/api/admin/orders/${id}/cancel`, { reason: 'طلب العميل', refund: true }, owner);
  assert.equal(cx.json.status, 'cancelled');
  assert.deepEqual({ ...(await productStock(pid)) }, { stock: 100, reserved: 0 });
  assert.equal(cx.json.paid, 0);
  assert.equal((await call('POST', `/api/admin/orders/${id}/prepare`, {}, owner)).status, 409);
});

test('نفاد المخزون ومنع تجاوز الكمية المتاحة', async () => {
  const pid = await newProduct({ stock: 50 });
  const over = await call('POST', '/api/orders', { ...customer(), items: [{ productId: pid, qty: 51 }] });
  assert.equal(over.status, 409);
  assert.match(over.json.error, /المتاح/);
  const a = await call('POST', '/api/orders', { ...customer({ fulfillment: 'pickup' }), items: [{ productId: pid, qty: 40 }] });
  const b = await call('POST', '/api/orders', { ...customer({ fulfillment: 'pickup' }), items: [{ productId: pid, qty: 40 }] });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const ids = [];
  for (const o of [a, b]) ids.push((await call('GET', '/api/admin/orders?q=' + o.json.number, undefined, owner)).json[0].id);
  assert.equal((await call('POST', `/api/admin/orders/${ids[0]}/confirm`, {}, owner)).status, 200);
  const second = await call('POST', `/api/admin/orders/${ids[1]}/confirm`, {}, owner);
  assert.equal(second.status, 409);
  assert.deepEqual({ ...(await productStock(pid)) }, { stock: 50, reserved: 40 });
  // إيقاف البيع المؤقت وإخفاء المنتج
  await call('PUT', `/api/admin/products/${pid}`, { factory_id: factoryId, name: 'م', unit: 'bag', bag_weight_kg: 50, retail_price: 7000, paused: true }, owner);
  const p = (await call('GET', '/api/catalog')).json.products.find((x) => x.id === pid);
  assert.equal(p.availability, 'paused');
  assert.equal((await call('POST', '/api/orders', { ...customer(), items: [{ productId: pid, qty: 1 }] })).status, 409);
});

test('تغيّر السعر بعد الإضافة للسلة يُرفض مع إظهار السعر الجديد', async () => {
  const pid = await newProduct({ retail_price: 7000 });
  await call('PUT', `/api/admin/products/${pid}`, { factory_id: factoryId, name: 'م', unit: 'bag', bag_weight_kg: 50, retail_price: 7200 }, owner);
  const r = await call('POST', '/api/orders', { ...customer(), items: [{ productId: pid, qty: 10 }], expectedTotal: 70000 });
  assert.equal(r.status, 409);
  assert.equal(r.json.priceChanged, true);
  assert.equal(r.json.items_total, 72000);
  const ok = await call('POST', '/api/orders', { ...customer(), items: [{ productId: pid, qty: 10 }], expectedTotal: 72000 });
  assert.equal(ok.status, 201);
});

test('منع تكرار الطلب عند الضغط المتكرر', async () => {
  const pid = await newProduct();
  const body = { ...customer(), items: [{ productId: pid, qty: 5 }] };
  const results = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/api/orders', body)));
  assert.equal(new Set(results.map((r) => r.json.number)).size, 1);
  assert.equal((await db.get('SELECT COUNT(*) n FROM orders WHERE idem_key=?', body.idempotencyKey)).n, 1);
});

test('طلبان متزامنان لنفس الكمية: ينجح أحدهما فقط', async () => {
  const pid = await newProduct({ stock: 100 });
  const mk = () => call('POST', '/api/orders', { ...customer({ fulfillment: 'pickup' }), items: [{ productId: pid, qty: 80 }] });
  const [a, b] = await Promise.all([mk(), mk()]);
  const ids = [];
  for (const o of [a, b]) ids.push((await call('GET', '/api/admin/orders?q=' + o.json.number, undefined, owner)).json[0].id);
  const res = await Promise.all(ids.map((id) => call('POST', `/api/admin/orders/${id}/confirm`, {}, owner)));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await productStock(pid)).reserved, 80);
});

test('تحويل بنكي: يبقى بانتظار التحقق حتى يعتمده المدير', async () => {
  const pid = await newProduct();
  const s = await call('POST', '/api/orders', { ...customer({ fulfillment: 'pickup', paymentMethod: 'transfer' }), items: [{ productId: pid, qty: 10 }] });
  const id = (await call('GET', '/api/admin/orders?q=' + s.json.number, undefined, owner)).json[0].id;
  await call('POST', `/api/admin/orders/${id}/confirm`, {}, owner);
  const tr = await call('POST', `/api/track/${s.json.token}/transfer`, { ref: 'REF-12345' });
  assert.equal(tr.json.payment_status, 'pending_verification');
  assert.notEqual(tr.json.status, 'completed_paid');
  const pay = await call('POST', `/api/admin/orders/${id}/payment`, { amount: 70000, method: 'transfer' }, owner);
  assert.equal(pay.json.payment_status, 'paid');
  assert.equal(pay.json.transfer_verified, true);
});

test('المخزون: استلام وجرد وعدم النزول تحت المحجوز', async () => {
  const pid = await newProduct({ stock: 100 });
  const s = await call('POST', '/api/orders', { ...customer({ fulfillment: 'pickup' }), items: [{ productId: pid, qty: 30 }] });
  const id = (await call('GET', '/api/admin/orders?q=' + s.json.number, undefined, owner)).json[0].id;
  await call('POST', `/api/admin/orders/${id}/confirm`, {}, owner);
  assert.equal((await call('POST', `/api/admin/products/${pid}/stock`, { op: 'receive', qty: 50 }, staff)).json.stock, 150);
  assert.equal((await call('POST', `/api/admin/products/${pid}/stock`, { op: 'count', qty: 20, note: 'جرد' }, owner)).status, 409);
  assert.equal((await call('POST', `/api/admin/products/${pid}/stock`, { op: 'count', qty: 140, note: 'جرد' }, owner)).json.stock, 140);
  const mv = await call('GET', `/api/admin/stock-movements?product_id=${pid}`, undefined, owner);
  assert.deepEqual(mv.json.map((m) => m.kind).reverse(), ['in', 'reserve', 'in', 'adjust']);
  const sum = await call('GET', '/api/admin/summary', undefined, owner);
  assert.ok(Array.isArray(sum.json.low_stock));
});

test('الأمان: الصلاحيات والوصول لبيانات الآخرين', async () => {
  // العملاء لا يدخلون الإدارة
  for (const u of ['/api/admin/orders', '/api/admin/products', '/api/admin/customers', '/api/admin/summary', '/api/admin/backup', '/api/admin/users']) {
    assert.equal((await call('GET', u)).status, 401, u);
  }
  assert.equal((await call('POST', '/api/admin/orders/1/confirm', {}, 'sid=forged')).status, 401);
  // دخول خاطئ
  assert.equal((await call('POST', '/api/admin/login', { username: 'owner1', password: 'wrong' }, null, { 'X-Requested-With': 'cement' })).status, 401);
  // حماية CSRF: لا بد من الترويسة المخصصة
  assert.equal((await call('POST', '/api/admin/factories', { name: 'x' }, null, { Cookie: owner })).status, 403);
  // الموظف لا يدير المنتجات ولا المستخدمين ولا الأسعار
  assert.equal((await call('POST', '/api/admin/products', { factory_id: factoryId, name: 'x', unit: 'ton', retail_price: 1 }, staff)).status, 403);
  assert.equal((await call('GET', '/api/admin/users', undefined, staff)).status, 403);
  assert.equal((await call('GET', '/api/admin/reports', undefined, staff)).status, 403);
  assert.equal((await call('GET', '/api/admin/backup', undefined, staff)).status, 403);
  // روابط المتابعة غير قابلة للتخمين
  assert.equal((await call('GET', '/api/track/AS-000001')).status, 404);
  assert.equal((await call('GET', '/api/track/' + 'A'.repeat(32))).status, 404);
  assert.equal((await call('GET', '/api/track/1')).status, 404);
  const pid = await newProduct();
  const s = await call('POST', '/api/orders', { ...customer(), items: [{ productId: pid, qty: 5 }] });
  assert.ok(s.json.token.length >= 30);
  // ما يراه العميل لا يتضمن حقولًا داخلية
  const t = (await call('GET', '/api/track/' + s.json.token)).json;
  for (const k of ['token', 'customer', 'internal_notes', 'id', 'payments']) assert.equal(t[k], undefined, k);
  // مسارات غير مسموحة للملفات
  assert.notEqual((await fetch(base + '/..%2Fserver%2Fdb.js')).status, 200);
  assert.equal((await fetch(base + '/uploads/..%2Fcement.db')).status, 404);
  // رفع ملف غير صورة
  const bad = await call('POST', '/api/admin/upload', { data: Buffer.from('<script>alert(1)</script>'.repeat(10)).toString('base64') }, owner);
  assert.equal(bad.status, 400);
  // إدخال خاطئ
  assert.equal((await call('POST', '/api/orders', { ...customer(), items: [{ productId: pid, qty: -5 }] })).status, 400);
  assert.equal((await call('POST', '/api/orders', { ...customer(), items: [{ productId: pid, qty: 2.5 }] })).status, 409);
  assert.equal((await call('POST', '/api/orders', { ...customer({ phone: '12' }), items: [{ productId: pid, qty: 5 }] })).status, 400);
});

test('الأرشيف والنسخ الاحتياطي', async () => {
  const r = await fetch(base + '/api/admin/backup', { headers: { Cookie: owner } });
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  const dump = JSON.parse(buf.toString('utf8'));
  assert.equal(dump.format, 'cement-backup');
  assert.ok(dump.tables.orders.length > 0 && dump.tables.products.length > 0 && dump.tables.users.length === 2);
  assert.ok(!('sessions' in dump.tables), 'الجلسات لا تُنسخ');
  const audit = await call('GET', '/api/admin/audit', undefined, owner);
  assert.ok(audit.json.some((a) => a.action === 'product_create'));
  assert.ok(audit.json.some((a) => a.action === 'login_failed'));
});

test('الصور تُخزَّن في PostgreSQL وتُخدَّم منها، وتصدير/استيراد النسخة يحفظ كل شيء', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);
  const up = await call('POST', '/api/admin/upload', { data: 'data:image/png;base64,' + png.toString('base64') }, owner);
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.match(up.json.path, /^\/uploads\/[a-f0-9]{32}\.png$/);
  const img = await fetch(base + up.json.path);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(png));
  assert.equal((await fetch(base + up.json.path, { headers: { 'If-None-Match': img.headers.get('etag') } })).status, 304);
  assert.equal((await fetch(base + '/uploads/' + 'a'.repeat(32) + '.png')).status, 404);
  assert.equal((await fetch(base + '/uploads/..%2f..%2fetc%2fpasswd')).status, 404);
  // غير مالك لا يرفع
  assert.equal((await call('POST', '/api/admin/upload', { data: png.toString('base64') }, staff)).status, 403);

  const { exportAll, importAll } = await import('../server/backup.js');
  const before = await exportAll(db);
  const counts = await importAll(db, JSON.parse(JSON.stringify(before)));
  assert.equal(counts.uploads, before.tables.uploads.length);
  const after = await exportAll(db);
  assert.deepEqual(after.tables, before.tables);
  assert.equal((await fetch(base + up.json.path)).status, 200);
  // التسلسل يكمل بعد الاستيراد: إضافة منتج جديد لا تتعارض مع المعرّفات الموجودة
  owner = await login('owner1', 'owner-pass-123');
  const pid = await newProduct();
  assert.ok(pid > Math.max(...before.tables.products.map((p) => p.id)));
  await assert.rejects(importAll(db, { format: 'x', tables: {} }), /ليس نسخة احتياطية/);
});

async function orderId(number) { return (await call('GET', '/api/admin/orders?q=' + number, undefined, owner)).json[0].id; }

test('إجهاد: 12 تأكيدًا متزامنًا على مخزون يكفي 5 فقط، بلا بيع زائد ولا أخطاء خادم', async () => {
  const pid = await newProduct({ stock: 50 });
  const made = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/api/orders', { ...customer({ fulfillment: 'pickup' }), items: [{ productId: pid, qty: 10 }] })));
  assert.ok(made.every((m) => m.status === 201), JSON.stringify(made.map((m) => m.status)));
  const ids = await Promise.all(made.map((m) => orderId(m.json.number)));
  const res = await Promise.all(ids.map((id) => call('POST', `/api/admin/orders/${id}/confirm`, {}, owner)));
  const codes = res.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 200).length, 5, codes.join());
  assert.equal(codes.filter((c) => c === 409).length, 7, codes.join());
  const st = await productStock(pid);
  assert.deepEqual({ ...st }, { stock: 50, reserved: 50 });
});

test('النقر المزدوج: نفس الإجراء على الطلب نفسه ينفَّذ مرة واحدة فقط', async () => {
  const pid = await newProduct({ stock: 100 });
  const o = await call('POST', '/api/orders', { ...customer({ fulfillment: 'pickup' }), items: [{ productId: pid, qty: 30 }] });
  const id = await orderId(o.json.number);
  const res = await Promise.all(Array.from({ length: 6 }, () => call('POST', `/api/admin/orders/${id}/confirm`, {}, owner)));
  const codes = res.map((r) => r.status).sort();
  assert.equal(codes.filter((c) => c === 200).length, 1, codes.join());
  assert.ok(codes.every((c) => c === 200 || c === 409), codes.join());
  assert.equal((await productStock(pid)).reserved, 30);
  const mv = (await db.all("SELECT kind FROM stock_movements WHERE order_id=? AND kind='reserve'", id));
  assert.equal(mv.length, 1);
  // تسليم متزامن مرتين: صرف واحد ورقم فاتورة واحد
  assert.equal((await call('POST', `/api/admin/orders/${id}/ready`, {}, owner)).status, 200);
  const del = await Promise.all([1, 2, 3].map(() => call('POST', `/api/admin/orders/${id}/deliver`, {}, owner)));
  assert.equal(del.filter((r) => r.status === 200).length, 1, del.map((r) => r.status).join());
  assert.deepEqual({ ...(await productStock(pid)) }, { stock: 70, reserved: 0 });
});

test('منتجان بترتيب معكوس في طلبات متزامنة: لا توقف متبادل', async () => {
  const a = await newProduct({ stock: 1000 }), b = await newProduct({ stock: 1000 });
  const made = await Promise.all(Array.from({ length: 16 }, (_, i) => call('POST', '/api/orders', {
    ...customer({ fulfillment: 'pickup' }),
    items: i % 2 ? [{ productId: a, qty: 5 }, { productId: b, qty: 5 }] : [{ productId: b, qty: 5 }, { productId: a, qty: 5 }],
  })));
  assert.ok(made.every((m) => m.status === 201));
  const ids = await Promise.all(made.map((m) => orderId(m.json.number)));
  const res = await Promise.all(ids.map((id) => call('POST', `/api/admin/orders/${id}/confirm`, {}, owner)));
  assert.ok(res.every((r) => r.status === 200), res.map((r) => r.status).join());
  assert.deepEqual({ ...(await productStock(a)) }, { stock: 1000, reserved: 80 });
  assert.deepEqual({ ...(await productStock(b)) }, { stock: 1000, reserved: 80 });
});

test('التقارير بتوقيت اليمن: تسليم 22:30 بتوقيت UTC يُحسب لليوم التالي', async () => {
  const pid = await newProduct({ stock: 100 });
  const o = await call('POST', '/api/orders', { ...customer({ fulfillment: 'pickup' }), items: [{ productId: pid, qty: 1 }] });
  const id = await orderId(o.json.number);
  await call('POST', `/api/admin/orders/${id}/confirm`, {}, owner);
  await call('POST', `/api/admin/orders/${id}/ready`, {}, owner);
  assert.equal((await call('POST', `/api/admin/orders/${id}/deliver`, {}, owner)).status, 200);
  await db.run("UPDATE orders SET delivered_at='2031-03-09T22:30:00.000Z' WHERE id=?", id);
  const rep = await call('GET', '/api/admin/reports?from=2031-03-10&to=2031-03-10', undefined, owner);
  assert.equal(rep.status, 200, JSON.stringify(rep.json));
  assert.equal(rep.json.sales.orders, 1);
  assert.deepEqual(rep.json.daily.map((d) => d.day), ['2031-03-10']);
  const prev = await call('GET', '/api/admin/reports?from=2031-03-09&to=2031-03-09', undefined, owner);
  assert.equal(prev.json.sales.orders, 0);
});

test('إعدادات الوكالة والخريطة: تظهر للعامة، وتُرفض إحداثيات خارج اليمن، وسياسة الأمان تسمح بخرائط OSM فقط', async () => {
  staff = await login('staff1', 'staff-pass-123'); // الاستعادة السابقة تمسح كل الجلسات
  const pub = (await call('GET', '/api/catalog')).json.store;
  assert.match(pub.agent_note, /أسمنت حضرموت/);
  assert.equal(pub.map_lat, '15.4606'); assert.equal(pub.map_lng, '45.3261');
  assert.equal(pub.wholesale_min_bags, '200');
  assert.equal((await call('PUT', '/api/admin/settings', { map_lat: '48.85' }, owner)).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { map_lng: '2.35' }, owner)).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { map_lat: 'abc' }, owner)).status, 400);
  assert.equal((await call('PUT', '/api/admin/settings', { map_lat: '15.5' }, staff)).status, 403);
  assert.equal((await call('PUT', '/api/admin/settings', { map_lat: '١٥.٥٢', map_lng: '45.4', agent_note: '' }, owner)).status, 200);
  const after = (await call('GET', '/api/catalog')).json.store;
  assert.equal(after.map_lat, '15.52'); assert.equal(after.map_lng, '45.4'); assert.equal(after.agent_note, '');
  await call('PUT', '/api/admin/settings', { map_lat: '15.4606', map_lng: '45.3261', agent_note: 'وكيل معتمد لأسمنت حضرموت (الشركة العربية اليمنية للأسمنت)' }, owner);
  const csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(csp, /frame-src https:\/\/www\.openstreetmap\.org;/);
  assert.match(csp, /default-src 'self'/); assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /frame-src[^;]*\*/);
});
