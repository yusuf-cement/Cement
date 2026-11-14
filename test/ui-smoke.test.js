// اختبار دخان للواجهات: يشغّل كود المتصفح داخل DOM مبسّط ويتأكد من عدم وجود أخطاء برمجية في مسارات العرض الأساسية.
// (لا يغني عن تجربة المتصفح الحقيقي على الهاتف.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cement-ui-'));
process.env.DATA_DIR = tmp;
const { openDb } = await import('../server/db.js');
const { createApp, createUser } = await import('../server/app.js');

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const work = path.join(tmp, 'pub');
fs.cpSync(pub, work, { recursive: true });
for (const f of ['app.js', 'invoice.js', 'admin/admin.js']) {
  const p = path.join(work, f);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace("from '/common.js'", f.includes('/') ? "from '../common.js'" : "from './common.js'"));
}

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = {}; this.hidden = false; this.value = ''; this.className = ''; }
  setAttribute() {}
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = c; }
  remove() {}
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatchEvent() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  set innerHTML(v) { this.html = v; }
  set textContent(v) { this.children = [String(v)]; }
  get textContent() { return this.text(); }
  text() { return this.children.map((c) => (typeof c === 'string' ? c : c.text())).join(' '); }
}
globalThis.Node = El;
globalThis.Element = El;
const elements = {};
globalThis.document = {
  createElement: (t) => new El(t), createTextNode: (s) => String(s), body: new El('body'), title: '', hidden: false,
  getElementById: (id) => (elements[id] ||= new El('div')), querySelectorAll: () => [],
};
const mem = {};
globalThis.localStorage = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); } };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { hash: '', origin: 'http://x', search: '' };
const win = new El('win'); win.scrollTo = () => {}; win.print = () => {};
globalThis.window = win;
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.confirm = () => true; globalThis.prompt = () => 'x';
globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};

let server, base, cookie = '', db;
before(async () => {
  db = openDb(path.join(tmp, 'ui.db'));
  createUser(db, 'boss', 'boss-pass-123', 'owner');
  server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const headers = { ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) };
    const res = await realFetch(base + url, { ...opts, headers });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return res;
  };
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const tick = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const J = (m, u, b) => fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cement' }, body: b && JSON.stringify(b) }).then((r) => r.json());
const bad = /ReferenceError|TypeError|undefined|NaN|\[object/;

test('الإدارة: شاشة الدخول وكل الشاشات تُعرض بلا أخطاء', async () => {
  await J('POST', '/api/admin/login', { username: 'boss', password: 'boss-pass-123' });
  const f = await J('POST', '/api/admin/factories', { name: 'مصنع اختبار' });
  const cg = await J('POST', '/api/admin/categories', { name: 'تصنيف اختبار' });
  const p = await J('POST', '/api/admin/products', { factory_id: f.id, category_id: cg.id, name: 'أسمنت اختبار', unit: 'bag', bag_weight_kg: 50, retail_price: 7000, stock: 300, wholesale_min: 100 });
  await J('POST', '/api/orders', { name: 'عميل', phone: '771111111', region: 'مأرب', address: 'حي الجامعة', fulfillment: 'delivery', idempotencyKey: 'smoke-key-0001', items: [{ productId: p.id, qty: 10 }] });
  await import(pathToFileURL(path.join(work, 'admin/admin.js')).href);
  await tick(400);
  for (const hash of ['#/dash', '#/orders', '#/order/1', '#/products', '#/customers', '#/delivery', '#/reports', '#/settings']) {
    location.hash = hash; window.listeners.hashchange.forEach((fn) => fn()); await tick();
    const t = elements.app.text();
    assert.ok(t.length > 30, hash + ' فارغة');
    assert.doesNotMatch(t, bad, hash + ': ' + t.slice(0, 300));
  }
  assert.match(elements.app.text(), /سجل عمليات الإدارة/);
});

test('المتجر: الرئيسية والمنتج والسلة والدفع والجملة والتتبع', async () => {
  cookie = '';
  delete elements.app;
  const track = (await J('POST', '/api/wholesale-requests', { name: 'تاجر', phone: '772222222', region: 'مأرب', fulfillment: 'pickup', idempotencyKey: 'smoke-key-0002', items: [{ productId: 1, qty: 150 }] })).token;
  location.hash = '';
  window.listeners.hashchange = [];
  await import(pathToFileURL(path.join(work, 'app.js')).href);
  await tick(300);
  const check = async (hash, re) => {
    location.hash = hash; window.listeners.hashchange.forEach((fn) => fn()); await tick(300);
    const t = elements.app.text();
    assert.doesNotMatch(t, bad, hash + ': ' + t.slice(0, 300));
    assert.match(t, re, hash + ': ' + t.slice(0, 200));
  };
  await check('#/', /أسمنت اختبار/);
  assert.match(elements.app.text(), /تصنيف اختبار/);
  await check('#/p/1', /7,000/);
  mem.cw_cart = JSON.stringify([{ id: 1, qty: 20, seen: 7000 }]);
  await check('#/cart', /140,000/);
  await check('#/checkout', /ملخص الطلب/);
  await check('#/wholesale', /بالجملة/);
  await check('#/wholesale/1', /الحد الأدنى للجملة/);
  await check('#/track/' + track, /بانتظار عرض سعر الجملة/);
  await check('#/orders', /طلباتي/);
  await check('#/contact', /775477377/);
});
