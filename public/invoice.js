import { h, money, qtyText, dt, api } from '/common.js';

const doc = document.getElementById('doc');
document.getElementById('print').addEventListener('click', () => window.print());
const p = new URLSearchParams(location.search);
const prep = p.get('mode') === 'prep';

async function main() {
  try {
    let o, store;
    if (p.get('t')) { o = await api('GET', '/api/track/' + encodeURIComponent(p.get('t'))); store = o.store; }
    else if (p.get('id')) { o = await api('GET', '/api/admin/orders/' + encodeURIComponent(p.get('id')), undefined, true); store = (await api('GET', '/api/admin/me', undefined, true)).store; }
    else throw new Error('رابط غير صحيح');
    const title = prep ? 'أمر تجهيز' : o.doc_kind;
    document.title = `${title} ${o.number}`;
    const unconfirmed = ['طلب غير مؤكد', 'عرض سعر'].includes(o.doc_kind);
    doc.replaceChildren(
      h('div', { class: 'hd' }, h('div', {}, h('h1', {}, store.name || store.store_name || 'عالم الأسمنت ومواد البناء'), h('div', {}, store.city), h('div', { dir: 'ltr', style: 'text-align:right' }, store.phone)), h('div', { class: 'kind' }, title)),
      h('table', {}, h('tbody', {},
        h('tr', {}, h('th', {}, 'رقم الطلب'), h('td', {}, o.number), h('th', {}, 'تاريخ الطلب'), h('td', {}, dt(o.created_at))),
        o.invoice_no ? h('tr', {}, h('th', {}, 'رقم الفاتورة'), h('td', {}, o.invoice_no), h('th', {}, 'تاريخ التسليم'), h('td', {}, dt(o.delivered_at))) : null,
        h('tr', {}, h('th', {}, 'العميل'), h('td', {}, o.name), h('th', {}, 'الهاتف'), h('td', { dir: 'ltr', style: 'text-align:right' }, o.phone)),
        h('tr', {}, h('th', {}, 'الاستلام'), h('td', {}, o.fulfillment === 'pickup' ? 'من المستودع' : 'توصيل'), h('th', {}, 'العنوان'), h('td', {}, o.fulfillment === 'delivery' ? `${o.region} - ${o.address || ''}` : o.region)),
        o.scheduled_at ? h('tr', {}, h('th', {}, 'الموعد'), h('td', { colspan: 3 }, o.scheduled_at.replace('T', ' '))) : null)),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'الصنف'), h('th', {}, 'الكمية'), prep ? null : h('th', {}, 'سعر الوحدة'), prep ? null : h('th', {}, 'الإجمالي'))),
        h('tbody', {}, o.items.map((i) => h('tr', {}, h('td', {}, i.name), h('td', {}, qtyText(i.qty, i.unit)), prep ? null : h('td', {}, i.unit_price === null ? 'بانتظار التسعير' : money(i.unit_price)), prep ? null : h('td', {}, i.unit_price === null ? '—' : money(i.line_total)))))),
      prep ? (o.notes ? h('p', {}, 'ملاحظات العميل: ', o.notes) : null) : h('table', {}, h('tbody', {},
        o.discount > 0 ? h('tr', {}, h('th', {}, 'الخصومات (محسوبة في الأسعار)'), h('td', {}, money(o.discount))) : null,
        o.fulfillment === 'delivery' ? h('tr', {}, h('th', {}, 'أجرة النقل'), h('td', {}, o.delivery_fee === null ? 'تحدد لاحقًا' : money(o.delivery_fee))) : null,
        h('tr', {}, h('th', {}, 'الإجمالي النهائي'), h('td', {}, h('b', {}, o.total === null ? 'غير معتمد بعد' : money(o.total)))),
        h('tr', {}, h('th', {}, 'المدفوع'), h('td', {}, money(o.paid))),
        h('tr', {}, h('th', {}, 'المتبقي'), h('td', {}, o.remaining === null ? '—' : money(o.remaining))))),
      unconfirmed ? h('p', { class: 'notice warn' }, 'هذا المستند ليس فاتورة بيع، والأسعار غير نهائية حتى موافقة الطرفين وتأكيد الطلب.') : null);
  } catch (e) { doc.textContent = e.message; }
}
main();
