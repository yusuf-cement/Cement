import crypto from 'node:crypto';
import { tx, getSettings } from './db.js';
import { unitWord, unitIsInt, defaultWholesaleMin } from './units.js';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export const STATUS_LABELS = {
  new: 'طلب جديد',
  under_review: 'قيد المراجعة',
  wholesale_pending: 'بانتظار عرض سعر الجملة',
  quote_sent: 'تم إرسال عرض السعر',
  awaiting_customer: 'بانتظار موافقة العميل',
  confirmed: 'تم تأكيد الطلب',
  preparing: 'قيد التجهيز',
  ready_pickup: 'جاهز للاستلام',
  out_for_delivery: 'خرج للتوصيل',
  delivered: 'تم التسليم',
  completed_paid: 'مكتمل الدفع',
  cancelled: 'ملغي',
};
const EDITABLE = ['new', 'under_review', 'wholesale_pending', 'quote_sent', 'awaiting_customer'];
const QUOTED = ['quote_sent', 'awaiting_customer'];

export const r3 = (x) => Math.round(x * 1000) / 1000;
const now = () => new Date().toISOString();
const clean = (s, max) => (typeof s === 'string' ? s.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '');

export function normalizePhone(p) {
  let d = String(p || '').replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 9 && d.startsWith('7')) d = '967' + d;
  if (d.length === 10 && d.startsWith('07')) d = '967' + d.slice(1);
  return d;
}

/* ---------- التسعير ---------- */
export function effectivePrice(p) {
  return Math.round(p.retail_price * (1 - (p.discount_percent || 0) / 100));
}

export function priceCart(db, rawItems, { wholesale = false } = {}) {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 50) throw new HttpError(400, 'السلة فارغة أو غير صحيحة');
  const merged = new Map();
  for (const it of rawItems) {
    const id = Number(it?.productId), q = Number(it?.qty);
    if (!Number.isInteger(id) || !Number.isFinite(q) || q <= 0 || q > 100000) throw new HttpError(400, 'بيانات منتج غير صحيحة');
    merged.set(id, r3((merged.get(id) || 0) + q));
  }
  const settings = getSettings(db);
  const lines = [], problems = [];
  for (const [id, qty] of merged) {
    const p = db.prepare(`SELECT p.*, f.name factory_name, f.active factory_active FROM products p
      JOIN factories f ON f.id=p.factory_id WHERE p.id=?`).get(id);
    if (!p || !p.active || !p.factory_active || p.paused) {
      problems.push({ productId: id, message: 'هذا المنتج غير متاح للبيع حاليًا' });
      continue;
    }
    const label = `${p.factory_name} - ${p.name}`;
    const uw = unitWord(p.unit);
    const available = r3(p.stock - p.reserved);
    if (unitIsInt(p.unit) && !Number.isInteger(qty)) problems.push({ productId: id, message: `كمية «${label}» يجب أن تكون عددًا صحيحًا (${uw})` });
    if (wholesale) {
      const min = p.wholesale_min ?? defaultWholesaleMin(settings, p.unit);
      if (qty < min) problems.push({ productId: id, message: `الحد الأدنى لطلب الجملة من «${label}» هو ${min} ${uw}` });
    } else {
      if (qty < p.min_order) problems.push({ productId: id, message: `الحد الأدنى للطلب من «${label}» هو ${p.min_order} ${uw}` });
      if (qty > available) problems.push({ productId: id, message: `المتاح من «${label}» هو ${available} ${uw} فقط` });
    }
    const unit_price = effectivePrice(p);
    lines.push({
      product_id: id, name: label, unit: p.unit, qty, list_price: p.retail_price, unit_price,
      line_total: Math.round(qty * unit_price), available, min_order: p.min_order, image: p.image,
    });
  }
  const items_total = lines.reduce((s, l) => s + l.line_total, 0);
  const discount = lines.reduce((s, l) => s + Math.round(l.qty * (l.list_price - l.unit_price)), 0);
  return { lines, problems, items_total, discount };
}

/* ---------- أدوات داخلية ---------- */
function addEvent(db, orderId, status, note, actor, visible = 1) {
  db.prepare('INSERT INTO order_events(order_id,at,status,note,actor,visible) VALUES(?,?,?,?,?,?)')
    .run(orderId, now(), status, note || null, actor || null, visible ? 1 : 0);
}
function setStatus(db, o, status, note, actor, visible = 1) {
  db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run(status, now(), o.id);
  addEvent(db, o.id, status, note, actor, visible);
  o.status = status;
}
function moveStock(db, productId, orderId, kind, qty, note, actor) {
  const p = db.prepare('SELECT stock FROM products WHERE id=?').get(productId);
  db.prepare('INSERT INTO stock_movements(at,product_id,order_id,kind,qty,stock_after,note,actor) VALUES(?,?,?,?,?,?,?,?)')
    .run(now(), productId, orderId, kind, qty, p.stock, note || null, actor || null);
}
export function recalc(db, orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
  const priced = items.every((i) => i.unit_price !== null);
  const items_total = priced ? items.reduce((s, i) => s + i.line_total, 0) : null;
  let discount = 0;
  if (priced && o.type === 'retail') discount = Math.max(0, items.reduce((s, i) => s + Math.round(i.qty * (i.list_price - i.unit_price)), 0));
  const total = items_total === null ? null : items_total + (o.delivery_fee || 0);
  db.prepare('UPDATE orders SET items_total=?, discount=?, total=?, updated_at=? WHERE id=?')
    .run(items_total, discount, total, now(), orderId);
}
const loadOrder = (db, id) => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
const paidOf = (db, id) => db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=?').get(id).s;
export const isFinal = (o) => o.items_total !== null && (o.fulfillment === 'pickup' || o.delivery_fee !== null);

function payState(db, o) {
  const paid = paidOf(db, o.id);
  if (o.total !== null && o.total > 0 && paid >= o.total) return 'paid';
  if (paid > 0) return 'partial';
  if (o.transfer_ref && !o.transfer_verified) return 'pending_verification';
  return 'unpaid';
}

/* ---------- إنشاء الطلب ---------- */
export function createOrder(db, body, type) {
  const name = clean(body.name, 80), region = clean(body.region, 80);
  const phone = normalizePhone(body.phone);
  const address = clean(body.address, 300), notes = clean(body.notes, 500);
  const fulfillment = body.fulfillment;
  const idem = clean(String(body.idempotencyKey || ''), 80);
  if (name.length < 2) throw new HttpError(400, 'أدخل الاسم');
  if (phone.length < 9 || phone.length > 15) throw new HttpError(400, 'رقم الهاتف غير صحيح');
  if (!['pickup', 'delivery'].includes(fulfillment)) throw new HttpError(400, 'اختر طريقة الاستلام');
  if (!region) throw new HttpError(400, 'اختر المحافظة أو المنطقة');
  if (fulfillment === 'delivery' && address.length < 5) throw new HttpError(400, 'أدخل العنوان التفصيلي للتوصيل');
  if (idem.length < 8) throw new HttpError(400, 'معرّف الطلب مفقود');
  const payment_method = body.paymentMethod === 'transfer' ? 'transfer' : 'cash';
  const transfer_ref = payment_method === 'transfer' ? clean(body.transferRef, 100) || null : null;

  const dup = db.prepare('SELECT number, token, status FROM orders WHERE idem_key=?').get(idem);
  if (dup) return { ...dup, duplicate: true };

  return tx(db, () => {
    const priced = priceCart(db, body.items, { wholesale: type === 'wholesale' });
    if (priced.problems.length) throw new HttpError(409, priced.problems[0].message, { problems: priced.problems, lines: priced.lines });
    if (type === 'retail' && body.expectedTotal !== undefined && Number(body.expectedTotal) !== priced.items_total) {
      throw new HttpError(409, 'تغيّر سعر أحد المنتجات منذ إضافته للسلة. راجع الأسعار الجديدة ثم أرسل الطلب مرة أخرى.', { priceChanged: true, lines: priced.lines, items_total: priced.items_total });
    }
    const t = now();
    let cust = db.prepare('SELECT * FROM customers WHERE phone=?').get(phone);
    if (cust) db.prepare('UPDATE customers SET name=? WHERE id=?').run(name, cust.id);
    else {
      const r = db.prepare('INSERT INTO customers(name,phone) VALUES(?,?)').run(name, phone);
      cust = { id: Number(r.lastInsertRowid) };
    }
    const token = crypto.randomBytes(24).toString('base64url');
    const status = type === 'wholesale' ? 'wholesale_pending' : 'new';
    const r = db.prepare(`INSERT INTO orders(token,idem_key,customer_id,name,phone,region,address,fulfillment,pickup_request,notes,type,status,
      payment_method,transfer_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(token, idem, cust.id, name, phone, region, fulfillment === 'delivery' ? address : null, fulfillment,
        clean(body.pickupRequest, 100) || null, notes || null, type, status, payment_method, transfer_ref, t, t);
    const id = Number(r.lastInsertRowid);
    const number = 'AS-' + String(id).padStart(6, '0');
    db.prepare('UPDATE orders SET number=? WHERE id=?').run(number, id);
    const ins = db.prepare('INSERT INTO order_items(order_id,product_id,name,unit,qty,list_price,unit_price,line_total) VALUES(?,?,?,?,?,?,?,?)');
    for (const l of priced.lines) {
      if (type === 'wholesale') ins.run(id, l.product_id, l.name, l.unit, l.qty, l.list_price, null, null);
      else ins.run(id, l.product_id, l.name, l.unit, l.qty, l.list_price, l.unit_price, l.line_total);
    }
    recalc(db, id);
    addEvent(db, id, status, type === 'wholesale' ? 'تم استلام طلب التسعير بالجملة، وسنرسل لك عرض السعر.' : 'تم استلام طلبك وسيراجعه فريق المتجر.', 'العميل');
    return { number, token, status };
  });
}

/* ---------- عرض الطلب ---------- */
function docKind(o) {
  if (o.status === 'cancelled') return 'طلب ملغي';
  if (['new', 'under_review', 'wholesale_pending'].includes(o.status)) return 'طلب غير مؤكد';
  if (QUOTED.includes(o.status)) return 'عرض سعر';
  if (o.status === 'delivered') return 'فاتورة بيع';
  if (o.status === 'completed_paid') return 'فاتورة بيع مكتملة (مدفوعة)';
  return 'أمر بيع مؤكد';
}

function baseView(db, o) {
  const items = db.prepare('SELECT id,product_id,name,unit,qty,list_price,unit_price,line_total FROM order_items WHERE order_id=?').all(o.id);
  const paid = paidOf(db, o.id);
  const final = isFinal(o);
  return {
    number: o.number, type: o.type, status: o.status, status_label: STATUS_LABELS[o.status], doc_kind: docKind(o),
    name: o.name, phone: o.phone, region: o.region, address: o.address, fulfillment: o.fulfillment,
    pickup_request: o.pickup_request, notes: o.notes,
    items, items_total: o.items_total, discount: o.discount, delivery_fee: o.delivery_fee,
    fee_pending: o.fulfillment === 'delivery' && o.delivery_fee === null,
    total: final ? o.total : null, total_before_fee: o.items_total,
    paid, remaining: final ? Math.max(0, o.total - paid) : null,
    payment_method: o.payment_method, payment_status: payState(db, o), transfer_ref: o.transfer_ref,
    scheduled_at: o.scheduled_at, quote_note: o.quote_note, cancel_reason: o.cancel_reason,
    invoice_no: o.invoice_no, delivered_at: o.delivered_at, created_at: o.created_at, updated_at: o.updated_at,
  };
}

export function publicOrder(db, o) {
  const v = baseView(db, o);
  const s = getSettings(db);
  const showDriver = ['out_for_delivery', 'delivered', 'completed_paid'].includes(o.status);
  return {
    ...v,
    driver: showDriver && o.driver_name ? { name: o.driver_name, phone: o.driver_phone } : null,
    events: db.prepare('SELECT at,status,note FROM order_events WHERE order_id=? AND visible=1 ORDER BY id').all(o.id)
      .map((e) => ({ ...e, status_label: STATUS_LABELS[e.status] })),
    can_respond: QUOTED.includes(o.status) && isFinal(o),
    can_submit_transfer: o.payment_method === 'transfer' && o.status !== 'cancelled' && !o.transfer_verified,
    warehouse: o.fulfillment === 'pickup' ? { name: s.warehouse_name, address: s.warehouse_address, hours: s.warehouse_hours } : null,
    bank_note: o.payment_method === 'transfer' ? s.bank_note : null,
    store: { name: s.store_name, phone: s.phone, whatsapp: s.whatsapp, city: s.city },
  };
}

export function adminOrder(db, o) {
  const v = baseView(db, o);
  const cust = db.prepare('SELECT id,name,phone,wholesale_approved,notes FROM customers WHERE id=?').get(o.customer_id);
  const specials = Object.fromEntries(db.prepare('SELECT product_id,price FROM customer_prices WHERE customer_id=?').all(o.customer_id).map((r) => [r.product_id, r.price]));
  v.items = v.items.map((i) => {
    const p = db.prepare('SELECT stock,reserved,wholesale_hint FROM products WHERE id=?').get(i.product_id);
    return { ...i, available: r3(p.stock - p.reserved), wholesale_hint: p.wholesale_hint, special_price: specials[i.product_id] ?? null };
  });
  return {
    ...v, id: o.id, token: o.token, customer: cust, total_raw: o.total, reserved: o.reserved,
    transfer_verified: !!o.transfer_verified, driver_name: o.driver_name, driver_phone: o.driver_phone,
    events: db.prepare('SELECT at,status,note,actor,visible FROM order_events WHERE order_id=? ORDER BY id').all(o.id)
      .map((e) => ({ ...e, status_label: STATUS_LABELS[e.status] })),
    payments: db.prepare('SELECT at,amount,method,note,actor FROM payments WHERE order_id=? ORDER BY id').all(o.id),
  };
}

/* ---------- حجز وصرف المخزون ---------- */
function reserveStock(db, o, actor) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
  for (const it of items) {
    const p = db.prepare('SELECT stock,reserved,active FROM products WHERE id=?').get(it.product_id);
    const avail = r3(p.stock - p.reserved);
    if (it.qty > avail + 1e-9) throw new HttpError(409, `الكمية المطلوبة من «${it.name}» غير متاحة حاليًا (المتاح ${avail}).`);
    db.prepare('UPDATE products SET reserved=ROUND(reserved+?,3), updated_at=? WHERE id=?').run(it.qty, now(), it.product_id);
    moveStock(db, it.product_id, o.id, 'reserve', it.qty, 'حجز بعد اعتماد الطلب', actor);
  }
  db.prepare('UPDATE orders SET reserved=1 WHERE id=?').run(o.id);
}
function releaseStock(db, o, actor, note) {
  if (o.reserved !== 1) return;
  for (const it of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id)) {
    db.prepare('UPDATE products SET reserved=MAX(0,ROUND(reserved-?,3)), updated_at=? WHERE id=?').run(it.qty, now(), it.product_id);
    moveStock(db, it.product_id, o.id, 'release', it.qty, note, actor);
  }
  db.prepare('UPDATE orders SET reserved=0 WHERE id=?').run(o.id);
}
function issueStock(db, o, actor) {
  if (o.reserved !== 1) throw new HttpError(409, 'لا توجد كمية محجوزة لهذا الطلب');
  for (const it of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id)) {
    db.prepare('UPDATE products SET stock=ROUND(stock-?,3), reserved=ROUND(reserved-?,3), updated_at=? WHERE id=?').run(it.qty, it.qty, now(), it.product_id);
    moveStock(db, it.product_id, o.id, 'issue', -it.qty, 'صرف عند التسليم', actor);
  }
  db.prepare('UPDATE orders SET reserved=2 WHERE id=?').run(o.id);
}

function confirmOrder(db, o, actor, note) {
  if (!isFinal(o)) throw new HttpError(400, 'لا يمكن التأكيد قبل اعتماد الأسعار وأجرة النقل');
  reserveStock(db, o, actor);
  setStatus(db, o, 'confirmed', note || 'تم تأكيد طلبك وحجز الكمية.', actor);
}

function afterPaymentChange(db, o, actor) {
  const o2 = loadOrder(db, o.id);
  if (o2.status === 'delivered' && o2.total !== null && paidOf(db, o.id) >= o2.total) {
    setStatus(db, o2, 'completed_paid', 'تم استلام كامل المبلغ. شكرًا لتعاملكم معنا.', actor);
  }
}

/* ---------- إجراءات الطلب (الإدارة والعميل) ---------- */
export function orderAction(db, id, action, b = {}, actor = 'النظام', { customer = false } = {}) {
  return tx(db, () => {
    const o = loadOrder(db, id);
    if (!o) throw new HttpError(404, 'الطلب غير موجود');
    const need = (...sts) => { if (!sts.includes(o.status)) throw new HttpError(409, `هذا الإجراء غير متاح والطلب «${STATUS_LABELS[o.status]}»`); };
    const int = (v, msg) => { const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 1e12) throw new HttpError(400, msg); return n; };

    if (customer) {
      switch (action) {
        case 'approve':
          need(...QUOTED);
          confirmOrder(db, o, actor, 'وافق العميل على عرض السعر وتم حجز الكمية.');
          return;
        case 'reject':
          need(...QUOTED);
          db.prepare('UPDATE orders SET cancel_reason=? WHERE id=?').run(clean(b.reason, 300) || 'رفض العميل عرض السعر', id);
          setStatus(db, o, 'cancelled', 'رفض العميل عرض السعر. ' + (clean(b.reason, 300) || ''), actor);
          return;
        case 'transfer': {
          if (o.status === 'cancelled') throw new HttpError(409, 'الطلب ملغي');
          if (o.payment_method !== 'transfer') throw new HttpError(400, 'طريقة الدفع المختارة ليست تحويلًا');
          const ref = clean(b.ref, 100);
          if (ref.length < 3) throw new HttpError(400, 'أدخل رقم العملية أو بيانات الحوالة');
          db.prepare('UPDATE orders SET transfer_ref=?, transfer_verified=0, updated_at=? WHERE id=?').run(ref, now(), id);
          addEvent(db, id, o.status, 'أرسل العميل بيانات التحويل وهي بانتظار التحقق.', actor);
          return;
        }
        default: throw new HttpError(400, 'إجراء غير معروف');
      }
    }

    switch (action) {
      case 'review':
        need('new');
        setStatus(db, o, 'under_review', 'بدأت الإدارة مراجعة طلبك.', actor);
        break;
      case 'set_prices': {
        need(...EDITABLE);
        if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, 'لا توجد أسعار');
        const changes = [];
        for (const x of b.items) {
          const it = db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(Number(x.id), id);
          if (!it) throw new HttpError(400, 'بند غير موجود');
          const price = int(x.unit_price, 'سعر غير صحيح');
          if (it.unit_price !== price) changes.push(`${it.name}: ${it.unit_price ?? 'غير مسعّر'} ← ${price}`);
          db.prepare('UPDATE order_items SET unit_price=?, line_total=? WHERE id=?').run(price, Math.round(it.qty * price), it.id);
        }
        recalc(db, id);
        if (QUOTED.includes(o.status)) setStatus(db, o, 'under_review', 'تم تعديل الأسعار وسيصلك عرض سعر محدَّث. التعديلات: ' + changes.join('، '), actor);
        else if (changes.length) addEvent(db, id, o.status, 'تسعير: ' + changes.join('، '), actor, 0);
        break;
      }
      case 'set_fee': {
        need(...EDITABLE);
        if (o.fulfillment !== 'delivery') throw new HttpError(400, 'الطلب للاستلام من المستودع ولا يحتاج أجرة نقل');
        const fee = int(b.fee, 'أجرة النقل غير صحيحة');
        const was = o.delivery_fee;
        db.prepare('UPDATE orders SET delivery_fee=? WHERE id=?').run(fee, id);
        recalc(db, id);
        if (QUOTED.includes(o.status) && was !== fee) setStatus(db, o, 'under_review', `تم تعديل أجرة النقل من ${was ?? 'غير محددة'} إلى ${fee} وسيصلك عرض سعر محدَّث.`, actor);
        else addEvent(db, id, o.status, `حُدِّدت أجرة النقل: ${fee}`, actor, 0);
        break;
      }
      case 'send_quote': {
        need('new', 'under_review', 'wholesale_pending', ...QUOTED);
        const o2 = loadOrder(db, id);
        if (!isFinal(o2)) throw new HttpError(400, 'حدّد جميع الأسعار وأجرة النقل (للتوصيل) قبل إرسال عرض السعر');
        const note = clean(b.note, 500);
        db.prepare('UPDATE orders SET quote_note=? WHERE id=?').run(note || null, id);
        setStatus(db, o, 'quote_sent', `عرض السعر: الإجمالي ${o2.total} ريال${note ? ' - ' + note : ''}. بانتظار موافقتك.`, actor);
        break;
      }
      case 'mark_awaiting':
        need('quote_sent');
        setStatus(db, o, 'awaiting_customer', 'بانتظار رد العميل على عرض السعر.', actor);
        break;
      case 'confirm': {
        need('new', 'under_review');
        if (!(o.type === 'retail' && o.fulfillment === 'pickup' && isFinal(o)))
          throw new HttpError(400, 'هذا الطلب يحتاج موافقة العميل على عرض السعر قبل التأكيد');
        confirmOrder(db, o, actor);
        break;
      }
      case 'record_approval':
        need(...QUOTED);
        confirmOrder(db, o, actor, 'تم تسجيل موافقة العميل على عرض السعر وحجز الكمية.' + (b.note ? ' ' + clean(b.note, 200) : ''));
        break;
      case 'prepare':
        need('confirmed');
        setStatus(db, o, 'preparing', 'جاري تجهيز طلبك.', actor);
        break;
      case 'ready':
        need('confirmed', 'preparing');
        if (o.fulfillment !== 'pickup') throw new HttpError(400, 'الطلب للتوصيل');
        setStatus(db, o, 'ready_pickup', 'طلبك جاهز للاستلام من المستودع.', actor);
        break;
      case 'dispatch': {
        need('confirmed', 'preparing');
        if (o.fulfillment !== 'delivery') throw new HttpError(400, 'الطلب للاستلام من المستودع');
        db.prepare('UPDATE orders SET driver_name=?, driver_phone=? WHERE id=?').run(clean(b.driver_name, 80) || null, clean(b.driver_phone, 30) || null, id);
        setStatus(db, o, 'out_for_delivery', 'خرج طلبك للتوصيل.', actor);
        break;
      }
      case 'set_driver':
        if (['delivered', 'completed_paid', 'cancelled'].includes(o.status)) throw new HttpError(409, 'لا يمكن التعديل الآن');
        db.prepare('UPDATE orders SET driver_name=?, driver_phone=? WHERE id=?').run(clean(b.driver_name, 80) || null, clean(b.driver_phone, 30) || null, id);
        addEvent(db, id, o.status, 'تحديث بيانات السائق/الناقل', actor, 0);
        break;
      case 'schedule': {
        if (['delivered', 'completed_paid', 'cancelled'].includes(o.status)) throw new HttpError(409, 'لا يمكن التعديل الآن');
        const when = clean(b.scheduled_at, 40);
        if (!when) throw new HttpError(400, 'حدّد الموعد');
        db.prepare('UPDATE orders SET scheduled_at=? WHERE id=?').run(when, id);
        addEvent(db, id, o.status, `تم تحديد موعد ${o.fulfillment === 'pickup' ? 'الاستلام' : 'التسليم'}: ${when.replace('T', ' ')}`, actor);
        break;
      }
      case 'deliver': {
        need('ready_pickup', 'out_for_delivery');
        issueStock(db, o, actor);
        const seq = Number(db.prepare("SELECT value FROM settings WHERE key='invoice_seq'").get()?.value || 0) + 1;
        db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('invoice_seq',?)").run(String(seq));
        db.prepare('UPDATE orders SET invoice_no=?, delivered_at=? WHERE id=?').run('INV-' + String(seq).padStart(6, '0'), now(), id);
        setStatus(db, o, 'delivered', o.fulfillment === 'pickup' ? 'تم استلام الطلب من المستودع.' : 'تم تسليم الطلب.', actor);
        afterPaymentChange(db, o, actor);
        break;
      }
      case 'payment': {
        if (['cancelled'].includes(o.status)) throw new HttpError(409, 'الطلب ملغي');
        if (!['confirmed', 'preparing', 'ready_pickup', 'out_for_delivery', 'delivered', 'completed_paid'].includes(o.status))
          throw new HttpError(409, 'يمكن تسجيل التحصيل بعد تأكيد الطلب فقط');
        const amount = Number(b.amount);
        if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'المبلغ غير صحيح');
        const remaining = o.total - paidOf(db, id);
        if (amount > remaining) throw new HttpError(400, `المبلغ أكبر من المتبقي (${remaining})`);
        const method = ['cash', 'transfer', 'other'].includes(b.method) ? b.method : 'cash';
        db.prepare('INSERT INTO payments(order_id,at,amount,method,note,actor) VALUES(?,?,?,?,?,?)').run(id, now(), amount, method, clean(b.note, 200) || null, actor);
        if (method === 'transfer') db.prepare('UPDATE orders SET transfer_verified=1 WHERE id=?').run(id);
        addEvent(db, id, o.status, `تم تسجيل دفعة بقيمة ${amount} ريال`, actor);
        afterPaymentChange(db, o, actor);
        break;
      }
      case 'note':
        if (!clean(b.text, 500)) throw new HttpError(400, 'اكتب الملاحظة');
        addEvent(db, id, o.status, clean(b.text, 500), actor, 0);
        break;
      case 'cancel': {
        if (['delivered', 'completed_paid', 'cancelled'].includes(o.status)) throw new HttpError(409, 'لا يمكن إلغاء الطلب بعد التسليم أو إلغائه مسبقًا');
        const paid = paidOf(db, id);
        if (paid > 0) {
          if (!b.refund) throw new HttpError(409, `تم تحصيل ${paid} ريال؛ أكّد استرجاع المبلغ لإتمام الإلغاء`);
          db.prepare('INSERT INTO payments(order_id,at,amount,method,note,actor) VALUES(?,?,?,?,?,?)').run(id, now(), -paid, 'other', 'استرجاع عند الإلغاء', actor);
        }
        releaseStock(db, o, actor, 'إلغاء الطلب وإرجاع الكمية المحجوزة');
        const reason = clean(b.reason, 300) || 'إلغاء من الإدارة';
        db.prepare('UPDATE orders SET cancel_reason=? WHERE id=?').run(reason, id);
        setStatus(db, o, 'cancelled', 'تم إلغاء الطلب: ' + reason, actor);
        break;
      }
      default: throw new HttpError(400, 'إجراء غير معروف');
    }
  });
}

/* ---------- المخزون ---------- */
export function stockOp(db, productId, op, b, actor) {
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
    if (!p) throw new HttpError(404, 'المنتج غير موجود');
    const q = Number(b.qty);
    if (!Number.isFinite(q)) throw new HttpError(400, 'الكمية غير صحيحة');
    let newStock, kind, delta;
    if (op === 'receive') { if (q <= 0) throw new HttpError(400, 'الكمية يجب أن تكون موجبة'); newStock = r3(p.stock + q); kind = 'in'; }
    else if (op === 'adjust') { newStock = r3(p.stock + q); kind = 'adjust'; }
    else if (op === 'count') { if (q < 0) throw new HttpError(400, 'الكمية غير صحيحة'); newStock = r3(q); kind = 'adjust'; }
    else throw new HttpError(400, 'عملية غير معروفة');
    if (unitIsInt(p.unit) && !Number.isInteger(newStock)) throw new HttpError(400, `الكمية بوحدة «${unitWord(p.unit)}» يجب أن تكون عددًا صحيحًا`);
    if (newStock < p.reserved - 1e-9) throw new HttpError(409, `لا يمكن أن يقل المخزون عن الكمية المحجوزة (${p.reserved})`);
    delta = r3(newStock - p.stock);
    db.prepare('UPDATE products SET stock=?, updated_at=? WHERE id=?').run(newStock, now(), productId);
    moveStock(db, productId, null, kind, delta, clean(b.note, 200) || (op === 'count' ? 'جرد وتصحيح' : null), actor);
    return { stock: newStock };
  });
}
