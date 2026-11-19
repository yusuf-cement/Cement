import { openDb } from './db.js';
import { createApp, createUser } from './app.js';

const PORT = Number(process.env.PORT || 3000);

process.on('unhandledRejection', (e) => console.error('خطأ غير معالج:', e));

const db = await openDb();

// إنشاء حساب المدير الأول من متغيرات البيئة (مرة واحدة فقط)
if ((await db.get('SELECT COUNT(*) n FROM users')).n === 0) {
  const { ADMIN_USER, ADMIN_PASSWORD } = process.env;
  if (ADMIN_USER && ADMIN_PASSWORD) {
    await createUser(db, ADMIN_USER, ADMIN_PASSWORD, 'owner');
    console.log(`تم إنشاء حساب المدير: ${ADMIN_USER}`);
  } else {
    console.warn('تنبيه: لا يوجد أي مستخدم إداري. عيّن ADMIN_USER و ADMIN_PASSWORD ثم أعد التشغيل، أو شغّل: npm run create-admin');
  }
}

const server = createApp(db);
server.listen(PORT, () => console.log(`المتجر يعمل على المنفذ ${PORT} | قاعدة البيانات: PostgreSQL`));

const stop = () => { server.close(() => db.close().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 8000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
