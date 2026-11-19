// إضافة منتجات المصنع الجاهزة (صور ومواصفات) إلى القاعدة. آمن عند التكرار:
//  - ما أُضيف مسبقًا بنفس الاسم والمصنع يُتخطّى ولا يُعدَّل (تعديلاتك في اللوحة محفوظة).
//  - المنتجات تُضاف مخفية وبسعر 0 ومخزون 0: اكتب السعر والكمية من اللوحة ثم فعّل المنتج.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed');

export async function seedProducts(db, file = path.join(dir, 'products.json')) {
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.dirname(file);
  return db.tx(async (t) => {
    let factory = await t.get('SELECT id FROM factories WHERE name=?', spec.factory);
    if (!factory) factory = { id: await t.insert('INSERT INTO factories(name) VALUES(?)', spec.factory) };
    let category = await t.get('SELECT id FROM categories WHERE name=?', spec.category);
    if (!category) category = { id: await t.insert('INSERT INTO categories(name) VALUES(?)', spec.category) };
    const result = { added: [], skipped: [] };
    for (const p of spec.products) {
      if (await t.get('SELECT 1 FROM products WHERE factory_id=? AND name=?', factory.id, p.name)) { result.skipped.push(p.name); continue; }
      let image = null;
      if (p.image) {
        const data = fs.readFileSync(path.join(base, 'images', p.image));
        const name = crypto.createHash('sha256').update(data).digest('hex').slice(0, 32) + '.webp';
        await t.run('INSERT INTO uploads(name,mime,data) VALUES(?,?,?) ON CONFLICT (name) DO NOTHING', name, 'image/webp', data);
        image = '/uploads/' + name;
      }
      await t.insert(`INSERT INTO products(factory_id,category_id,name,cement_type,spec,unit,bag_weight_kg,image,retail_price,stock,min_order,active)
        VALUES(?,?,?,?,?,'bag',50,?,0,0,1,0)`, factory.id, category.id, p.name, p.cement_type, p.spec, image);
      result.added.push(p.name);
    }
    return result;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await openDb();
  const r = await seedProducts(db);
  await db.close();
  console.log(`أُضيف ${r.added.length} منتج، وتُخطّي ${r.skipped.length} (موجود مسبقًا).`);
  r.added.forEach((n) => console.log('  +', n));
  r.skipped.forEach((n) => console.log('  =', n));
  console.log('المنتجات مخفية بسعر 0: من اللوحة اكتب السعر والكمية ثم فعّل كل منتج.');
}
