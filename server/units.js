// وحدات البيع المدعومة. أضف وحدة جديدة هنا فقط (الاسم العربي + هل تُباع بأعداد صحيحة).
export const UNITS = {
  bag: { name: 'كيس', int: true },
  ton: { name: 'طن', int: false },
  piece: { name: 'قطعة', int: true },
  bundle: { name: 'حزمة', int: true },
  carton: { name: 'كرتون', int: true },
  roll: { name: 'لفة', int: true },
  meter: { name: 'متر', int: false },
  m3: { name: 'متر مكعب', int: false },
  kg: { name: 'كيلوجرام', int: false },
  liter: { name: 'لتر', int: false },
};
export const isUnit = (u) => Object.prototype.hasOwnProperty.call(UNITS, u);
export const unitWord = (u) => UNITS[u]?.name || u;
export const unitIsInt = (u) => !!UNITS[u]?.int;
export const defaultWholesaleMin = (settings, unit) =>
  unit === 'bag' ? Number(settings.wholesale_min_bags) : unit === 'ton' ? Number(settings.wholesale_min_tons) : 1;
