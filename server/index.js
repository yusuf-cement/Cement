import { openDb, DATA_DIR } from './db.js';
import { createApp, createUser } from './app.js';

const db = openDb();
const PORT = Number(process.env.PORT || 3000);

// إنشاء حساب المدير الأول من متغيرات البيئة (مرة واحدة فقط)
if (db.prepare('SELECT COUNT(*) n FROM users').get().n === 0) {
  const { ADMIN_USER, ADMIN_PASSWORD } = process.env;
  if (ADMIN_USER && ADMIN_PASSWORD) {
    createUser(db, ADMIN_USER, ADMIN_PASSWORD, 'owner');
    console.log(`تم إنشاء حساب المدير: ${ADMIN_USER}`);
  } else {
    console.warn('تنبيه: لا يوجد أي مستخدم إداري. عيّن ADMIN_USER و ADMIN_PASSWORD ثم أعد التشغيل، أو شغّل: npm run create-admin');
  }
}

createApp(db).listen(PORT, () => console.log(`المتجر يعمل على المنفذ ${PORT} | البيانات: ${DATA_DIR}`));
