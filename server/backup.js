// تصدير واستيراد كامل لقاعدة البيانات بصيغة JSON (يشمل صور المنتجات)
// الصيغة نفسها يستخدمها سكربت نقل البيانات من SQLite القديمة.
export const TABLES = [
  'settings', 'users', 'categories', 'factories', 'products', 'customers', 'customer_prices', 'zones',
  'orders', 'order_items', 'order_events', 'payments', 'stock_movements', 'audit_log', 'uploads',
];
const ORDER_BY = { settings: 'key', customer_prices: 'customer_id,product_id', uploads: 'name' };
const FORMAT = 'cement-backup';

export async function exportAll(db) {
  const tables = {};
  for (const t of TABLES) {
    const rows = await db.all(`SELECT * FROM ${t} ORDER BY ${ORDER_BY[t] || 'id'}`);
    tables[t] = t === 'uploads' ? rows.map((r) => ({ ...r, data: Buffer.from(r.data).toString('base64') })) : rows;
  }
  return { format: FORMAT, version: 1, exported_at: new Date().toISOString(), tables };
}

/** يستبدل محتوى القاعدة كاملًا بمحتوى النسخة (داخل عملية ذرّية: إمّا تنجح كلها أو لا يتغير شيء) */
export async function importAll(db, dump) {
  if (!dump || dump.format !== FORMAT || typeof dump.tables !== 'object') throw new Error('الملف ليس نسخة احتياطية صحيحة لهذا المتجر');
  return db.tx(async (t) => {
    await t.exec(`TRUNCATE sessions, ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    const counts = {};
    for (const table of TABLES) {
      const rows = dump.tables[table] || [];
      const cols = new Set((await t.all('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?', table)).map((c) => c.column_name));
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => cols.has(k));
        const vals = keys.map((k) => (table === 'uploads' && k === 'data' ? Buffer.from(row[k], 'base64') : row[k]));
        await t.run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...vals);
      }
      counts[table] = rows.length;
      if (table !== 'settings' && table !== 'customer_prices' && table !== 'uploads')
        await t.exec(`SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}),1), (SELECT MAX(id) FROM ${table}) IS NOT NULL)`);
    }
    return counts;
  });
}
