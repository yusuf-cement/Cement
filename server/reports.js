import { HttpError } from './orders.js';
import { unitWord } from './units.js';

const DONE = "('delivered','completed_paid')";
const OPEN = "('confirmed','preparing','ready_pickup','out_for_delivery','delivered')";
const TZ = "'+3 hours'"; // توقيت اليمن UTC+3

export function dashboard(db) {
  const c = (sql) => db.prepare(sql).get().n;
  const today = "date('now'," + TZ + ')';
  const month = "strftime('%Y-%m','now'," + TZ + ')';
  return {
    counts: {
      new: c("SELECT COUNT(*) n FROM orders WHERE status IN ('new','wholesale_pending')"),
      review: c("SELECT COUNT(*) n FROM orders WHERE status='under_review'"),
      awaiting_approval: c("SELECT COUNT(*) n FROM orders WHERE status IN ('quote_sent','awaiting_customer')"),
      preparing: c("SELECT COUNT(*) n FROM orders WHERE status IN ('confirmed','preparing','ready_pickup')"),
      out_for_delivery: c("SELECT COUNT(*) n FROM orders WHERE status='out_for_delivery'"),
      completed: c(`SELECT COUNT(*) n FROM orders WHERE status IN ${DONE}`),
      pending_transfers: c("SELECT COUNT(*) n FROM orders WHERE payment_method='transfer' AND transfer_ref IS NOT NULL AND transfer_verified=0 AND status!='cancelled'"),
    },
    sales_today: c(`SELECT COALESCE(SUM(total),0) n FROM orders WHERE status IN ${DONE} AND date(delivered_at,${TZ})=${today}`),
    sales_month: c(`SELECT COALESCE(SUM(total),0) n FROM orders WHERE status IN ${DONE} AND strftime('%Y-%m',delivered_at,${TZ})=${month}`),
    collected_today: c(`SELECT COALESCE(SUM(amount),0) n FROM payments WHERE date(at,${TZ})=${today}`),
    collected_month: c(`SELECT COALESCE(SUM(amount),0) n FROM payments WHERE strftime('%Y-%m',at,${TZ})=${month}`),
    outstanding: c(`SELECT COALESCE(SUM(o.total-(SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.order_id=o.id)),0) n
      FROM orders o WHERE o.status IN ${OPEN} AND o.total IS NOT NULL`),
    low_stock: db.prepare(`SELECT p.id,p.name,f.name factory_name,p.unit,ROUND(p.stock-p.reserved,3) available,p.low_stock_at
      FROM products p JOIN factories f ON f.id=p.factory_id
      WHERE p.active=1 AND (p.stock-p.reserved)<=p.low_stock_at ORDER BY available`).all(),
  };
}

const D = /^\d{4}-\d{2}-\d{2}$/;
export function range(q) {
  const to = D.test(q.to || '') ? q.to : new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const from = D.test(q.from || '') ? q.from : new Date(Date.now() + 3 * 3600e3 - 29 * 864e5).toISOString().slice(0, 10);
  if (from > to) throw new HttpError(400, 'تاريخ البداية بعد تاريخ النهاية');
  return { from, to };
}

export function report(db, q) {
  const { from, to } = range(q);
  const inDeliv = `date(o.delivered_at,${TZ}) BETWEEN ? AND ?`;
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  return {
    from, to,
    sales: one(`SELECT COUNT(*) orders, COALESCE(SUM(total),0) total FROM orders o WHERE o.status IN ${DONE} AND ${inDeliv}`, from, to),
    collected: one(`SELECT COALESCE(SUM(amount),0) total FROM payments WHERE date(at,${TZ}) BETWEEN ? AND ?`, from, to).total,
    orders_by_status: all(`SELECT status, COUNT(*) n FROM orders WHERE date(created_at,${TZ}) BETWEEN ? AND ? GROUP BY status`, from, to),
    by_type: all(`SELECT type, COUNT(*) orders, COALESCE(SUM(total),0) total FROM orders o WHERE o.status IN ${DONE} AND ${inDeliv} GROUP BY type`, from, to),
    daily: all(`SELECT date(o.delivered_at,${TZ}) day, COUNT(*) orders, SUM(total) total FROM orders o WHERE o.status IN ${DONE} AND ${inDeliv} GROUP BY day ORDER BY day`, from, to),
    top_products: all(`SELECT i.name, i.unit, SUM(i.qty) qty, SUM(i.line_total) total FROM order_items i JOIN orders o ON o.id=i.order_id
      WHERE o.status IN ${DONE} AND ${inDeliv} GROUP BY i.product_id ORDER BY qty DESC LIMIT 10`, from, to),
    top_customers: all(`SELECT o.name, o.phone, COUNT(*) orders, SUM(o.total) total FROM orders o
      WHERE o.status IN ${DONE} AND ${inDeliv} GROUP BY o.customer_id ORDER BY total DESC LIMIT 10`, from, to),
  };
}

const esc = (v) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // منع حقن المعادلات في Excel
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCsv = (rows) => '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');

export function csvExport(db, kind, q) {
  const { from, to } = range(q);
  if (kind === 'orders') {
    const rows = db.prepare(`SELECT number,type,status,name,phone,region,fulfillment,items_total,delivery_fee,total,
      (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.order_id=o.id) paid, created_at, delivered_at
      FROM orders o WHERE date(created_at,${TZ}) BETWEEN ? AND ? ORDER BY id`).all(from, to);
    return toCsv([['رقم الطلب', 'النوع', 'الحالة', 'العميل', 'الهاتف', 'المنطقة', 'الاستلام', 'قيمة المواد', 'أجرة النقل', 'الإجمالي', 'المدفوع', 'تاريخ الطلب', 'تاريخ التسليم'],
      ...rows.map((r) => [r.number, r.type === 'wholesale' ? 'جملة' : 'تجزئة', r.status, r.name, r.phone, r.region, r.fulfillment === 'pickup' ? 'مستودع' : 'توصيل', r.items_total, r.delivery_fee, r.total, r.paid, r.created_at, r.delivered_at])]);
  }
  if (kind === 'sales') {
    const rows = db.prepare(`SELECT invoice_no,number,delivered_at,name,phone,total,
      (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.order_id=o.id) paid FROM orders o
      WHERE status IN ${DONE} AND date(delivered_at,${TZ}) BETWEEN ? AND ? ORDER BY delivered_at`).all(from, to);
    return toCsv([['رقم الفاتورة', 'رقم الطلب', 'تاريخ التسليم', 'العميل', 'الهاتف', 'الإجمالي', 'المدفوع', 'المتبقي'],
      ...rows.map((r) => [r.invoice_no, r.number, r.delivered_at, r.name, r.phone, r.total, r.paid, r.total - r.paid])]);
  }
  if (kind === 'products') {
    const rows = db.prepare(`SELECT f.name factory, c.name category, p.name, p.unit, p.retail_price, p.stock, p.reserved FROM products p JOIN factories f ON f.id=p.factory_id LEFT JOIN categories c ON c.id=p.category_id ORDER BY f.name,p.name`).all();
    return toCsv([['المصنع', 'التصنيف', 'المنتج', 'الوحدة', 'سعر التجزئة', 'المخزون', 'المحجوز', 'المتاح'],
      ...rows.map((r) => [r.factory, r.category, r.name, unitWord(r.unit), r.retail_price, r.stock, r.reserved, Math.round((r.stock - r.reserved) * 1000) / 1000])]);
  }
  if (kind === 'customers') {
    const rows = db.prepare(`SELECT c.name,c.phone,c.wholesale_approved,COUNT(o.id) orders,COALESCE(SUM(CASE WHEN o.status IN ${DONE} THEN o.total END),0) total
      FROM customers c LEFT JOIN orders o ON o.customer_id=c.id GROUP BY c.id ORDER BY total DESC`).all();
    return toCsv([['الاسم', 'الهاتف', 'جملة معتمد', 'عدد الطلبات', 'إجمالي المشتريات'], ...rows.map((r) => [r.name, r.phone, r.wholesale_approved ? 'نعم' : 'لا', r.orders, r.total])]);
  }
  throw new HttpError(400, 'نوع التصدير غير معروف');
}
