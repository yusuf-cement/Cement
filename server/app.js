import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, tx, getSettings } from './db.js';
import {
  HttpError, STATUS_LABELS, priceCart, createOrder, orderAction, publicOrder, adminOrder, stockOp, r3,
} from './orders.js';
import { dashboard, report, csvExport } from './reports.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- كلمات المرور ---------- */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
const DUMMY = hashPassword('dummy-password-for-timing');
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function createUser(db, username, password, role) {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username || '')) throw new HttpError(400, 'اسم المستخدم: 3-32 حرفًا إنجليزيًا أو أرقامًا');
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'كلمة المرور يجب ألا تقل عن 8 أحرف');
  if (!['owner', 'staff'].includes(role)) throw new HttpError(400, 'صلاحية غير صحيحة');
  try {
    return Number(db.prepare('INSERT INTO users(username,pass_hash,role) VALUES(?,?,?)').run(username, hashPassword(password), role).lastInsertRowid);
  } catch { throw new HttpError(409, 'اسم المستخدم مستخدم مسبقًا'); }
}

/* ---------- تحديد المعدل ---------- */
const buckets = new Map();
function hit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
  return b.n <= max;
}

export function createApp(db) {
  const audit = (actor, action, detail) =>
    db.prepare('INSERT INTO audit_log(actor,action,detail) VALUES(?,?,?)').run(actor, action, detail ? String(detail).slice(0, 500) : null);

  // معرّف إصدار لتحديث الـPWA تلقائيًا عند تغيّر الملفات
  const buildId = (() => {
    const h = crypto.createHash('md5');
    const walk = (d) => { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f), s = fs.statSync(p); if (s.isDirectory()) walk(p); else h.update(f + s.size + s.mtimeMs); } };
    walk(PUBLIC_DIR);
    return h.digest('hex').slice(0, 10);
  })();

  /* ---------- جلسات الإدارة ---------- */
  function currentUser(req) {
    const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    if (!m) return null;
    const row = db.prepare(`SELECT u.id,u.username,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND u.active=1`).get(sha(m[1]));
    if (!row || row.expires_at < Date.now()) return null;
    return row;
  }
  const requireUser = (ctx) => { if (!ctx.user) throw new HttpError(401, 'يلزم تسجيل الدخول'); };
  const requireOwner = (ctx) => { requireUser(ctx); if (ctx.user.role !== 'owner') throw new HttpError(403, 'هذه الصلاحية لمدير المتجر فقط'); };

  /* ---------- مساعدات التحقق ---------- */
  const str = (v, max, req = false, label = 'الحقل') => {
    const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
    if (req && !s) throw new HttpError(400, `${label} مطلوب`);
    return s || null;
  };
  const num = (v, { min = 0, max = 1e9, label = 'القيمة', int = false, nullable = false } = {}) => {
    if ((v === null || v === undefined || v === '') && nullable) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new HttpError(400, `${label} غير صحيحة`);
    return n;
  };
  function cleanProduct(b) {
    const factory_id = num(b.factory_id, { int: true, label: 'المصنع' });
    if (!db.prepare('SELECT 1 FROM factories WHERE id=?').get(factory_id)) throw new HttpError(400, 'المصنع غير موجود');
    const unit = b.unit === 'ton' ? 'ton' : b.unit === 'bag' ? 'bag' : null;
    if (!unit) throw new HttpError(400, 'اختر وحدة البيع');
    const image = b.image ? String(b.image) : null;
    if (image && !/^\/uploads\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(image)) throw new HttpError(400, 'مسار الصورة غير صحيح');
    return {
      factory_id, unit, image,
      name: str(b.name, 120, true, 'اسم المنتج'), cement_type: str(b.cement_type, 60), spec: str(b.spec, 500),
      bag_weight_kg: unit === 'bag' ? num(b.bag_weight_kg, { min: 1, max: 100, label: 'وزن الكيس' }) : null,
      retail_price: num(b.retail_price, { int: true, label: 'سعر التجزئة' }),
      discount_percent: num(b.discount_percent ?? 0, { max: 100, label: 'نسبة الخصم' }),
      offer_note: str(b.offer_note, 200),
      min_order: num(b.min_order ?? 1, { min: 0.001, label: 'الحد الأدنى للطلب' }),
      wholesale_min: num(b.wholesale_min, { nullable: true, label: 'حد الجملة' }),
      wholesale_hint: num(b.wholesale_hint, { nullable: true, int: true, label: 'سعر الجملة المرجعي' }),
      low_stock_at: num(b.low_stock_at ?? 20, { label: 'حد التنبيه' }),
      active: b.active === false || b.active === 0 ? 0 : 1, paused: b.paused ? 1 : 0,
    };
  }

  /* ---------- جدول المسارات ---------- */
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });
  const publicFields = (settings) => ({
    store_name: settings.store_name, phone: settings.phone, whatsapp: settings.whatsapp, city: settings.city,
    warehouse_name: settings.warehouse_name, warehouse_address: settings.warehouse_address, warehouse_hours: settings.warehouse_hours,
    bank_note: settings.bank_note,
  });

  /* ===== واجهة العملاء ===== */
  route('GET', '/api/catalog', () => {
    const settings = getSettings(db);
    const products = db.prepare(`SELECT p.id,p.factory_id,f.name factory_name,p.name,p.cement_type,p.spec,p.unit,p.bag_weight_kg,p.image,
      p.retail_price,p.discount_percent,p.offer_note,p.min_order,p.wholesale_min,p.low_stock_at,p.paused,ROUND(p.stock-p.reserved,3) available
      FROM products p JOIN factories f ON f.id=p.factory_id WHERE p.active=1 AND f.active=1 ORDER BY f.sort,f.name,p.name`).all()
      .map((p) => ({
        ...p, price: Math.round(p.retail_price * (1 - p.discount_percent / 100)),
        wholesale_min: p.wholesale_min ?? Number(p.unit === 'bag' ? settings.wholesale_min_bags : settings.wholesale_min_tons),
        availability: p.paused ? 'paused' : p.available <= 0 ? 'out' : p.available <= p.low_stock_at ? 'low' : 'available',
        low_stock_at: undefined,
      }));
    return {
      store: publicFields(settings), statusLabels: STATUS_LABELS,
      factories: db.prepare('SELECT id,name FROM factories WHERE active=1 ORDER BY sort,name').all(),
      products, zones: db.prepare('SELECT id,name,indicative_fee FROM zones WHERE active=1 ORDER BY name').all(),
    };
  });
  route('POST', '/api/quote', (ctx) => {
    const r = priceCart(db, ctx.body.items, { wholesale: !!ctx.body.wholesale });
    return { lines: r.lines, problems: r.problems, items_total: r.items_total, discount: r.discount };
  });
  const submit = (type) => (ctx) => {
    if (!hit('order:' + ctx.ip, Number(process.env.ORDER_RATE_MAX || 20), 10 * 60e3)) throw new HttpError(429, 'محاولات كثيرة، حاول لاحقًا');
    const r = createOrder(db, ctx.body, type);
    return { status: r.duplicate ? 200 : 201, body: { number: r.number, token: r.token, duplicate: !!r.duplicate } };
  };
  route('POST', '/api/orders', submit('retail'));
  route('POST', '/api/wholesale-requests', submit('wholesale'));
  const byToken = (token) => {
    const o = /^[A-Za-z0-9_-]{20,64}$/.test(token) && db.prepare('SELECT * FROM orders WHERE token=?').get(token);
    if (!o) throw new HttpError(404, 'رابط المتابعة غير صحيح');
    return o;
  };
  route('GET', '/api/track/:token', (ctx) => publicOrder(db, byToken(ctx.params.token)));
  route('POST', '/api/track/:token/:action', (ctx) => {
    if (!hit('track:' + ctx.ip, 60, 10 * 60e3)) throw new HttpError(429, 'محاولات كثيرة، حاول لاحقًا');
    const o = byToken(ctx.params.token);
    if (!['approve', 'reject', 'transfer'].includes(ctx.params.action)) throw new HttpError(404, 'غير موجود');
    orderAction(db, o.id, ctx.params.action, ctx.body, 'العميل', { customer: true });
    return publicOrder(db, byToken(ctx.params.token));
  });

  /* ===== دخول الإدارة ===== */
  route('POST', '/api/admin/login', (ctx) => {
    const username = String(ctx.body.username || '').slice(0, 40), password = String(ctx.body.password || '').slice(0, 200);
    const key = `login:${ctx.ip}:${username.toLowerCase()}`;
    if (!hit('loginip:' + ctx.ip, 30, 15 * 60e3) || (buckets.get(key)?.n ?? 0) >= 5) throw new HttpError(429, 'محاولات دخول كثيرة. انتظر 15 دقيقة.');
    const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
    const ok = verifyPassword(password, u ? u.pass_hash : DUMMY) && !!u;
    if (!ok) { hit(key, 5, 15 * 60e3); audit(username, 'login_failed', ctx.ip); throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة'); }
    buckets.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), u.id, Date.now() + 7 * 864e5);
    audit(u.username, 'login', ctx.ip);
    const secure = ctx.req.headers['x-forwarded-proto'] === 'https' || process.env.FORCE_SECURE_COOKIE === '1';
    return { headers: { 'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}${secure ? '; Secure' : ''}` }, body: { username: u.username, role: u.role } };
  });
  route('POST', '/api/admin/logout', (ctx) => {
    const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(ctx.req.headers.cookie || '');
    if (m) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(m[1]));
    return { headers: { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }, body: { ok: true } };
  });
  route('GET', '/api/admin/me', (ctx) => { requireUser(ctx); return { username: ctx.user.username, role: ctx.user.role, statusLabels: STATUS_LABELS, store: publicFields(getSettings(db)) }; });
  route('GET', '/api/admin/summary', (ctx) => { requireUser(ctx); return dashboard(db); });

  /* ===== المصانع ===== */
  route('GET', '/api/admin/factories', (ctx) => { requireUser(ctx); return db.prepare('SELECT * FROM factories ORDER BY sort,name').all(); });
  route('POST', '/api/admin/factories', (ctx) => {
    requireOwner(ctx);
    try {
      const id = Number(db.prepare('INSERT INTO factories(name,sort) VALUES(?,?)').run(str(ctx.body.name, 80, true, 'اسم المصنع'), num(ctx.body.sort ?? 0, { int: true })).lastInsertRowid);
      audit(ctx.user.username, 'factory_create', ctx.body.name);
      return { status: 201, body: { id } };
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(409, 'المصنع موجود مسبقًا'); }
  });
  route('PUT', '/api/admin/factories/:id', (ctx) => {
    requireOwner(ctx);
    try {
      db.prepare('UPDATE factories SET name=?, active=?, sort=? WHERE id=?')
        .run(str(ctx.body.name, 80, true, 'اسم المصنع'), ctx.body.active === false || ctx.body.active === 0 ? 0 : 1, num(ctx.body.sort ?? 0, { int: true }), Number(ctx.params.id));
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(409, 'الاسم مستخدم'); }
    audit(ctx.user.username, 'factory_update', ctx.params.id);
    return { ok: true };
  });

  /* ===== المنتجات والمخزون ===== */
  route('GET', '/api/admin/products', (ctx) => {
    requireUser(ctx);
    return db.prepare(`SELECT p.*, f.name factory_name, ROUND(p.stock-p.reserved,3) available FROM products p
      JOIN factories f ON f.id=p.factory_id ORDER BY f.name,p.name`).all();
  });
  route('POST', '/api/admin/products', (ctx) => {
    requireOwner(ctx);
    const c = cleanProduct(ctx.body);
    const stock = num(ctx.body.stock ?? 0, { label: 'المخزون الافتتاحي' });
    if (c.unit === 'bag' && !Number.isInteger(stock)) throw new HttpError(400, 'أكياس الأسمنت يجب أن تكون أعدادًا صحيحة');
    const id = tx(db, () => {
      const r = db.prepare(`INSERT INTO products(factory_id,name,cement_type,spec,unit,bag_weight_kg,image,retail_price,discount_percent,offer_note,
        stock,min_order,wholesale_min,wholesale_hint,low_stock_at,active,paused) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(c.factory_id, c.name, c.cement_type, c.spec, c.unit, c.bag_weight_kg, c.image, c.retail_price, c.discount_percent, c.offer_note,
          stock, c.min_order, c.wholesale_min, c.wholesale_hint, c.low_stock_at, c.active, c.paused);
      const pid = Number(r.lastInsertRowid);
      if (stock > 0) db.prepare('INSERT INTO stock_movements(at,product_id,kind,qty,stock_after,note,actor) VALUES(?,?,?,?,?,?,?)').run(now(), pid, 'in', stock, stock, 'رصيد افتتاحي', ctx.user.username);
      return pid;
    });
    audit(ctx.user.username, 'product_create', `${id} ${c.name}`);
    return { status: 201, body: { id } };
  });
  route('PUT', '/api/admin/products/:id', (ctx) => {
    requireOwner(ctx);
    const id = Number(ctx.params.id), old = db.prepare('SELECT * FROM products WHERE id=?').get(id);
    if (!old) throw new HttpError(404, 'المنتج غير موجود');
    const c = cleanProduct(ctx.body);
    db.prepare(`UPDATE products SET factory_id=?,name=?,cement_type=?,spec=?,unit=?,bag_weight_kg=?,image=?,retail_price=?,discount_percent=?,offer_note=?,
      min_order=?,wholesale_min=?,wholesale_hint=?,low_stock_at=?,active=?,paused=?,updated_at=? WHERE id=?`)
      .run(c.factory_id, c.name, c.cement_type, c.spec, c.unit, c.bag_weight_kg, c.image, c.retail_price, c.discount_percent, c.offer_note,
        c.min_order, c.wholesale_min, c.wholesale_hint, c.low_stock_at, c.active, c.paused, now(), id);
    audit(ctx.user.username, 'product_update', `${id} ${c.name}${old.retail_price !== c.retail_price ? ` السعر ${old.retail_price}←${c.retail_price}` : ''}`);
    return { ok: true };
  });
  route('POST', '/api/admin/products/:id/stock', (ctx) => {
    requireUser(ctx);
    const r = stockOp(db, Number(ctx.params.id), ctx.body.op, ctx.body, ctx.user.username);
    audit(ctx.user.username, 'stock_' + ctx.body.op, `${ctx.params.id} ${ctx.body.qty}`);
    return r;
  });
  route('GET', '/api/admin/stock-movements', (ctx) => {
    requireUser(ctx);
    const pid = Number(ctx.url.searchParams.get('product_id')) || null;
    return db.prepare(`SELECT m.*, p.name product_name FROM stock_movements m JOIN products p ON p.id=m.product_id
      ${pid ? 'WHERE m.product_id=?' : ''} ORDER BY m.id DESC LIMIT 200`).all(...(pid ? [pid] : []));
  });
  route('POST', '/api/admin/upload', (ctx) => {
    requireOwner(ctx);
    const b64 = String(ctx.body.data || '').replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 100 || buf.length > 3 * 1024 * 1024) throw new HttpError(400, 'حجم الصورة غير مناسب (الحد 3 ميغابايت)');
    let ext = null;
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') ext = 'png';
    else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
    else if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') ext = 'webp';
    if (!ext) throw new HttpError(400, 'صيغة الصورة غير مدعومة (PNG أو JPG أو WEBP)');
    const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(DATA_DIR, 'uploads', name), buf);
    return { path: '/uploads/' + name };
  });

  /* ===== الطلبات ===== */
  route('GET', '/api/admin/orders', (ctx) => {
    requireUser(ctx);
    const q = ctx.url.searchParams, where = [], args = [];
    const s = (q.get('q') || '').trim().slice(0, 60);
    if (s) { const like = '%' + s.replace(/[%_\\]/g, '\\$&') + '%'; where.push("(number LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\')"); args.push(like, like, like); }
    if (q.get('status') && STATUS_LABELS[q.get('status')]) { where.push('status=?'); args.push(q.get('status')); }
    if (q.get('group') === 'active') where.push("status NOT IN ('delivered','completed_paid','cancelled')");
    if (['retail', 'wholesale'].includes(q.get('type'))) { where.push('type=?'); args.push(q.get('type')); }
    const rows = db.prepare(`SELECT id,number,type,status,name,phone,region,fulfillment,total,items_total,delivery_fee,payment_method,created_at,
      (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.order_id=o.id) paid FROM orders o
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`).all(...args);
    return rows.map((r) => ({ ...r, status_label: STATUS_LABELS[r.status] }));
  });
  const adminOrderById = (id) => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(Number(id));
    if (!o) throw new HttpError(404, 'الطلب غير موجود');
    return o;
  };
  route('GET', '/api/admin/orders/:id', (ctx) => { requireUser(ctx); return adminOrder(db, adminOrderById(ctx.params.id)); });
  route('POST', '/api/admin/orders/:id/:action', (ctx) => {
    requireUser(ctx);
    const o = adminOrderById(ctx.params.id);
    orderAction(db, o.id, ctx.params.action, ctx.body, ctx.user.username);
    audit(ctx.user.username, 'order_' + ctx.params.action, o.number);
    return adminOrder(db, adminOrderById(ctx.params.id));
  });

  /* ===== العملاء ===== */
  route('GET', '/api/admin/customers', (ctx) => {
    requireUser(ctx);
    const s = (ctx.url.searchParams.get('q') || '').trim().slice(0, 60), like = '%' + s.replace(/[%_\\]/g, '\\$&') + '%';
    return db.prepare(`SELECT c.*, COUNT(o.id) orders, COALESCE(SUM(CASE WHEN o.status IN ('delivered','completed_paid') THEN o.total END),0) total
      FROM customers c LEFT JOIN orders o ON o.customer_id=c.id
      ${s ? "WHERE c.name LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\'" : ''} GROUP BY c.id ORDER BY total DESC, c.id DESC LIMIT 300`)
      .all(...(s ? [like, like] : [])).map((c) => ({ ...c, repeat: c.orders >= 2 }));
  });
  route('GET', '/api/admin/customers/:id', (ctx) => {
    requireUser(ctx);
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(ctx.params.id));
    if (!c) throw new HttpError(404, 'العميل غير موجود');
    return {
      ...c,
      orders: db.prepare('SELECT id,number,type,status,total,created_at FROM orders WHERE customer_id=? ORDER BY id DESC').all(c.id).map((o) => ({ ...o, status_label: STATUS_LABELS[o.status] })),
      addresses: db.prepare("SELECT DISTINCT region,address FROM orders WHERE customer_id=? AND fulfillment='delivery'").all(c.id),
      prices: db.prepare('SELECT cp.product_id,cp.price,p.name FROM customer_prices cp JOIN products p ON p.id=cp.product_id WHERE cp.customer_id=?').all(c.id),
    };
  });
  route('PUT', '/api/admin/customers/:id', (ctx) => {
    requireUser(ctx);
    if (ctx.body.wholesale_approved !== undefined) requireOwner(ctx);
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(ctx.params.id));
    if (!c) throw new HttpError(404, 'العميل غير موجود');
    db.prepare('UPDATE customers SET wholesale_approved=?, notes=? WHERE id=?')
      .run(ctx.body.wholesale_approved === undefined ? c.wholesale_approved : ctx.body.wholesale_approved ? 1 : 0, ctx.body.notes === undefined ? c.notes : str(ctx.body.notes, 500), c.id);
    audit(ctx.user.username, 'customer_update', c.id);
    return { ok: true };
  });
  route('PUT', '/api/admin/customers/:id/prices', (ctx) => {
    requireOwner(ctx);
    const cid = Number(ctx.params.id), pid = num(ctx.body.product_id, { int: true, label: 'المنتج' });
    if (ctx.body.price === null) db.prepare('DELETE FROM customer_prices WHERE customer_id=? AND product_id=?').run(cid, pid);
    else db.prepare('INSERT OR REPLACE INTO customer_prices(customer_id,product_id,price) VALUES(?,?,?)').run(cid, pid, num(ctx.body.price, { int: true, label: 'السعر' }));
    audit(ctx.user.username, 'customer_price', `${cid}/${pid}`);
    return { ok: true };
  });

  /* ===== مناطق التوصيل ===== */
  route('GET', '/api/admin/zones', (ctx) => { requireUser(ctx); return db.prepare('SELECT * FROM zones ORDER BY name').all(); });
  route('POST', '/api/admin/zones', (ctx) => {
    requireOwner(ctx);
    try {
      const id = Number(db.prepare('INSERT INTO zones(name,indicative_fee) VALUES(?,?)').run(str(ctx.body.name, 80, true, 'اسم المنطقة'), num(ctx.body.indicative_fee, { nullable: true, int: true, label: 'الأجرة' })).lastInsertRowid);
      return { status: 201, body: { id } };
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(409, 'المنطقة موجودة'); }
  });
  route('PUT', '/api/admin/zones/:id', (ctx) => {
    requireOwner(ctx);
    db.prepare('UPDATE zones SET name=?, indicative_fee=?, active=? WHERE id=?')
      .run(str(ctx.body.name, 80, true, 'اسم المنطقة'), num(ctx.body.indicative_fee, { nullable: true, int: true, label: 'الأجرة' }), ctx.body.active === false || ctx.body.active === 0 ? 0 : 1, Number(ctx.params.id));
    return { ok: true };
  });
  route('GET', '/api/admin/deliveries', (ctx) => {
    requireUser(ctx);
    return db.prepare(`SELECT id,number,name,phone,region,address,status,scheduled_at,driver_name,driver_phone,delivery_fee
      FROM orders WHERE fulfillment='delivery' AND status IN ('confirmed','preparing','out_for_delivery') ORDER BY scheduled_at IS NULL, scheduled_at, id`).all()
      .map((r) => ({ ...r, status_label: STATUS_LABELS[r.status] }));
  });

  /* ===== التقارير ===== */
  route('GET', '/api/admin/reports', (ctx) => {
    requireOwner(ctx);
    const kind = ctx.url.searchParams.get('csv');
    const q = Object.fromEntries(ctx.url.searchParams);
    if (kind) return { raw: csvExport(db, kind, q), type: 'text/csv; charset=utf-8', filename: `${kind}-${q.from || 'all'}.csv` };
    return report(db, q);
  });

  /* ===== المستخدمون والإعدادات والنسخ الاحتياطي ===== */
  route('GET', '/api/admin/users', (ctx) => { requireOwner(ctx); return db.prepare('SELECT id,username,role,active,created_at FROM users ORDER BY id').all(); });
  route('POST', '/api/admin/users', (ctx) => {
    requireOwner(ctx);
    const id = createUser(db, ctx.body.username, ctx.body.password, ctx.body.role);
    audit(ctx.user.username, 'user_create', ctx.body.username);
    return { status: 201, body: { id } };
  });
  route('PUT', '/api/admin/users/:id', (ctx) => {
    requireOwner(ctx);
    const id = Number(ctx.params.id), u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u) throw new HttpError(404, 'المستخدم غير موجود');
    const role = ctx.body.role === undefined ? u.role : ctx.body.role, active = ctx.body.active === undefined ? u.active : ctx.body.active ? 1 : 0;
    if (!['owner', 'staff'].includes(role)) throw new HttpError(400, 'صلاحية غير صحيحة');
    if (u.role === 'owner' && (role !== 'owner' || !active) && db.prepare("SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1 AND id!=?").get(id).n === 0)
      throw new HttpError(409, 'لا يمكن إزالة آخر مدير للمتجر');
    if (ctx.body.password !== undefined) {
      if (String(ctx.body.password).length < 8) throw new HttpError(400, 'كلمة المرور يجب ألا تقل عن 8 أحرف');
      db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(String(ctx.body.password)), id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    }
    db.prepare('UPDATE users SET role=?, active=? WHERE id=?').run(role, active, id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    audit(ctx.user.username, 'user_update', u.username);
    return { ok: true };
  });
  const SETTING_KEYS = ['store_name', 'phone', 'whatsapp', 'city', 'warehouse_name', 'warehouse_address', 'warehouse_hours', 'bank_note', 'wholesale_min_bags', 'wholesale_min_tons'];
  route('GET', '/api/admin/settings', (ctx) => { requireOwner(ctx); const s = getSettings(db); return Object.fromEntries(SETTING_KEYS.map((k) => [k, s[k]])); });
  route('PUT', '/api/admin/settings', (ctx) => {
    requireOwner(ctx);
    for (const k of SETTING_KEYS) if (ctx.body[k] !== undefined) {
      let v = String(ctx.body[k]).trim().slice(0, 500);
      if (k === 'whatsapp') v = v.replace(/\D/g, '');
      if (k.startsWith('wholesale_min')) v = String(num(v, { min: 1, label: 'الحد الأدنى' }));
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k, v);
    }
    audit(ctx.user.username, 'settings_update', Object.keys(ctx.body).join(','));
    return { ok: true };
  });
  route('GET', '/api/admin/audit', (ctx) => { requireOwner(ctx); return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all(); });
  route('GET', '/api/admin/backup', (ctx) => {
    requireOwner(ctx);
    const tmp = path.join(DATA_DIR, `backup-${crypto.randomBytes(6).toString('hex')}.db`);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const raw = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    audit(ctx.user.username, 'backup_download', null);
    return { raw, type: 'application/octet-stream', filename: `cement-backup-${new Date().toISOString().slice(0, 10)}.db` };
  });

  /* ---------- الملفات الثابتة ---------- */
  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname === '/admin' || pathname === '/admin/' ? '/admin/index.html' : pathname === '/invoice' ? '/invoice.html' : pathname;
    if (rel === '/sw.js') {
      const js = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8').replace(/__BUILD__/g, buildId);
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
      return res.end(js);
    }
    let base = PUBLIC_DIR;
    if (rel.startsWith('/uploads/')) { base = path.join(DATA_DIR, 'uploads'); rel = rel.slice('/uploads'.length); }
    let file;
    try { file = path.join(base, decodeURIComponent(rel)); } catch { res.writeHead(400); return res.end(); }
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('الصفحة غير موجودة'); }
    const st = fs.statSync(file), etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ETag: etag, 'Cache-Control': base !== PUBLIC_DIR ? 'public, max-age=31536000, immutable' : 'no-cache' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }

  /* ---------- المعالج الرئيسي ---------- */
  const SEC = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  };
  const send = (res, status, body, extra = {}) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...extra });
    res.end(data);
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const ip = (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
    try {
      if (!url.pathname.startsWith('/api/')) {
        for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
        return serveStatic(req, res, url.pathname);
      }
      let matched = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) { matched = { r, params: { ...m.groups } }; break; }
      }
      if (!matched) throw new HttpError(404, 'مسار غير موجود');
      const isAdmin = url.pathname.startsWith('/api/admin/');
      if (isAdmin && req.method !== 'GET' && req.headers['x-requested-with'] !== 'cement') throw new HttpError(403, 'طلب غير مسموح');
      let body = {};
      if (req.method !== 'GET') {
        const limit = url.pathname === '/api/admin/upload' ? 5e6 : 1e5;
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'حجم الطلب كبير'); chunks.push(c); }
        const text = Buffer.concat(chunks).toString('utf8');
        if (text) { try { body = JSON.parse(text); } catch { throw new HttpError(400, 'صيغة البيانات غير صحيحة'); } }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'صيغة البيانات غير صحيحة');
      }
      const ctx = { req, res, url, ip, params: matched.params, body, user: isAdmin ? currentUser(req) : null };
      const out = await matched.r.handler(ctx);
      if (out && out.raw !== undefined) {
        res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store', ...SEC });
        return res.end(out.raw);
      }
      if (out && out.body !== undefined) return send(res, out.status || 200, out.body, out.headers);
      return send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
      const constraint = /constraint/i.test(String(e?.message));
      if (constraint) return send(res, 409, { error: 'تعذّر تنفيذ العملية بسبب تعارض في البيانات (مثل تجاوز المخزون).' });
      console.error(e);
      return send(res, 500, { error: 'حدث خطأ غير متوقع' });
    }
  });
}
