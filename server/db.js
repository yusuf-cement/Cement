import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('owner','staff')), active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT, action TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS factories(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY, factory_id INTEGER NOT NULL REFERENCES factories(id),
  name TEXT NOT NULL, cement_type TEXT, spec TEXT,
  unit TEXT NOT NULL CHECK(unit IN('bag','ton')), bag_weight_kg REAL, image TEXT,
  retail_price INTEGER NOT NULL CHECK(retail_price>=0),
  discount_percent REAL NOT NULL DEFAULT 0 CHECK(discount_percent>=0 AND discount_percent<=100),
  offer_note TEXT,
  stock REAL NOT NULL DEFAULT 0 CHECK(stock>=0),
  reserved REAL NOT NULL DEFAULT 0 CHECK(reserved>=0),
  min_order REAL NOT NULL DEFAULT 1 CHECK(min_order>0),
  wholesale_min REAL, wholesale_hint INTEGER, low_stock_at REAL NOT NULL DEFAULT 20,
  active INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(reserved<=stock+0.0001));
CREATE TABLE IF NOT EXISTS customers(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL,
  wholesale_approved INTEGER NOT NULL DEFAULT 0, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS customer_prices(
  customer_id INTEGER NOT NULL REFERENCES customers(id), product_id INTEGER NOT NULL REFERENCES products(id),
  price INTEGER NOT NULL CHECK(price>=0), PRIMARY KEY(customer_id, product_id));
CREATE TABLE IF NOT EXISTS zones(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, indicative_fee INTEGER, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY, number TEXT UNIQUE, token TEXT UNIQUE NOT NULL, idem_key TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL, phone TEXT NOT NULL, region TEXT NOT NULL, address TEXT,
  fulfillment TEXT NOT NULL CHECK(fulfillment IN('pickup','delivery')),
  pickup_request TEXT, notes TEXT,
  type TEXT NOT NULL CHECK(type IN('retail','wholesale')),
  status TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash', transfer_ref TEXT, transfer_verified INTEGER NOT NULL DEFAULT 0,
  items_total INTEGER, discount INTEGER NOT NULL DEFAULT 0, delivery_fee INTEGER, total INTEGER,
  reserved INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT, driver_name TEXT, driver_phone TEXT,
  invoice_no TEXT, delivered_at TEXT, cancel_reason TEXT, quote_note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL, unit TEXT NOT NULL, qty REAL NOT NULL CHECK(qty>0),
  list_price INTEGER NOT NULL, unit_price INTEGER, line_total INTEGER);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE TABLE IF NOT EXISTS order_events(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), at TEXT NOT NULL,
  status TEXT, note TEXT, actor TEXT, visible INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), at TEXT NOT NULL,
  amount INTEGER NOT NULL, method TEXT NOT NULL, note TEXT, actor TEXT);
CREATE TABLE IF NOT EXISTS stock_movements(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, product_id INTEGER NOT NULL REFERENCES products(id),
  order_id INTEGER, kind TEXT NOT NULL, qty REAL NOT NULL, stock_after REAL, note TEXT, actor TEXT);
`;

const DEFAULT_SETTINGS = {
  store_name: 'عالم الأسمنت',
  phone: '775477377',
  whatsapp: '967775477377',
  city: 'مأرب، اليمن',
  warehouse_name: 'مستودع عالم الأسمنت - مأرب',
  warehouse_address: 'مأرب (يُحدَّد العنوان التفصيلي من لوحة الإدارة)',
  warehouse_hours: 'يوميًا من 8 صباحًا إلى 5 مساءً',
  bank_note: 'للتحويل: يتم تزويدك بتفاصيل الحساب من الإدارة بعد مراجعة الطلب.',
  wholesale_min_bags: '200',
  wholesale_min_tons: '10',
};

export function openDb(file = process.env.DB_FILE || path.join(DATA_DIR, 'cement.db')) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

/** تنفيذ عملية ذرّية: إمّا أن تنجح كلها أو تُلغى كلها */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function getSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
}
