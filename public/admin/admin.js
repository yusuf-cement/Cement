import { h, fmt, money, unitName, setUnits, UNITS, qtyText, dt, waLink, api, toast, field } from '/common.js';

const app = document.getElementById('app');
let me = null, labels = {}, pollTimer = null, lastNew = null;
const A = (m, u, b) => api(m, u, b, true);
const owner = () => me?.role === 'owner';

/* ---------- الدخول ---------- */
function viewLogin(msg) {
  const u = h('input', { autocomplete: 'username', required: true, dir: 'ltr' });
  const p = h('input', { type: 'password', autocomplete: 'current-password', required: true, dir: 'ltr' });
  const m = h('div', { class: msg ? 'notice bad' : '' }, msg || '');
  const f = h('form', { class: 'panel' }, h('h2', {}, 'دخول الإدارة'), field('اسم المستخدم', u), field('كلمة المرور', p), m, h('button', { class: 'btn', type: 'submit' }, 'دخول'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await A('POST', '/api/admin/login', { username: u.value.trim(), password: p.value }); await boot(); }
    catch (err) { m.className = 'notice bad'; m.textContent = err.message; }
  });
  clearInterval(pollTimer);
  app.replaceChildren(h('div', { class: 'login' }, f));
}

/* ---------- الهيكل ---------- */
const TABS = [['dash', 'المؤشرات'], ['orders', 'الطلبات'], ['products', 'المنتجات'], ['customers', 'العملاء'], ['delivery', 'التوصيل'], ['reports', 'التقارير', true], ['settings', 'الإعدادات', true]];
function shell(content, active) {
  return [
    h('header', { class: 'top' }, h('div', { class: 'wrap' }, h('a', { class: 'brand', href: '#/dash' }, h('span', {}, 'لوحة ' + (me.store?.store_name || 'عالم الأسمنت ومواد البناء'))), h('span', { style: 'flex:1' }),
      h('span', { style: 'font-size:14px' }, me.username), h('button', { class: 'iconbtn', onclick: async () => { await A('POST', '/api/admin/logout', {}); me = null; viewLogin(); } }, 'خروج'))),
    h('nav', { class: 'sub' }, h('div', { class: 'wrap' }, TABS.filter((t) => !t[2] || owner()).map(([k, t]) => h('a', { href: '#/' + k, class: active === k ? 'on' : '' }, t, k === 'orders' ? h('span', { class: 'iconbtn n', id: 'newbadge', style: 'border:0;padding:0 7px;margin-inline-start:4px;background:#d8a31a;color:#000;border-radius:99px', hidden: true }) : null)))),
    h('div', { class: 'wrap' }, content),
  ];
}
function mount(content, active) { app.replaceChildren(...shell(content, active)); window.scrollTo(0, 0); }
const loading = () => h('div', { class: 'empty' }, 'جارٍ التحميل…');
const pillCls = (s) => (['new', 'wholesale_pending'].includes(s) ? 'new' : s === 'cancelled' ? 'cancelled' : ['delivered', 'completed_paid'].includes(s) ? 'done' : ['out_for_delivery', 'ready_pickup'].includes(s) ? 'go' : '');
const guard = (box) => (e) => { if (e.status === 401) { me = null; viewLogin('انتهت الجلسة، سجّل الدخول مجددًا'); } else box.replaceChildren(h('div', { class: 'notice bad' }, e.message)); };

/* ---------- التنبيه بالطلبات الجديدة ---------- */
function beep() {
  try { const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(), g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.15; o.start(); o.stop(c.currentTime + 0.25); } catch { /* ignore */ }
}
async function poll() {
  if (!me) return;
  try {
    const s = await A('GET', '/api/admin/summary');
    const n = s.counts.new;
    const b = document.getElementById('newbadge'); if (b) { b.hidden = !n; b.textContent = n; }
    document.title = (n ? `(${n}) ` : '') + 'لوحة إدارة ' + (me?.store?.store_name || 'المتجر');
    if (lastNew !== null && n > lastNew) { beep(); toast(`وصل ${n - lastNew} طلب جديد`); if (location.hash.startsWith('#/orders') || location.hash.startsWith('#/dash')) route(); }
    lastNew = n;
  } catch (e) { if (e.status === 401) { me = null; viewLogin('انتهت الجلسة'); } }
}

/* ---------- المؤشرات ---------- */
async function viewDash() {
  const box = h('div', {}, loading()); mount(box, 'dash');
  try {
    const s = await A('GET', '/api/admin/summary'), c = s.counts;
    const st = (n, t, href, hot) => h('a', { class: 'stat' + (hot && n ? ' hot' : ''), href }, h('b', {}, fmt(n)), h('span', {}, t));
    box.replaceChildren(h('h2', { class: 'sec' }, 'المؤشرات'),
      h('div', { class: 'stats' }, st(c.new, 'طلبات جديدة / بانتظار تسعير', '#/orders?status=new', true), st(c.review, 'قيد المراجعة', '#/orders?status=under_review'), st(c.awaiting_approval, 'بانتظار موافقة العميل', '#/orders?status=quote_sent'),
        st(c.preparing, 'قيد التجهيز / جاهزة', '#/orders?group=active'), st(c.out_for_delivery, 'خرجت للتوصيل', '#/orders?status=out_for_delivery'), st(c.completed, 'مكتملة', '#/orders?status=completed_paid'), st(c.pending_transfers, 'تحويلات بانتظار التحقق', '#/orders?group=active', true)),
      h('div', { class: 'stats' }, [['مبيعات اليوم', s.sales_today], ['مبيعات الشهر', s.sales_month], ['المحصّل اليوم', s.collected_today], ['المحصّل هذا الشهر', s.collected_month], ['المتبقي على العملاء', s.outstanding]].map(([t, v]) => h('div', { class: 'stat' }, h('b', {}, fmt(v)), h('span', {}, t + ' (ريال)')))),
      h('h2', { class: 'sec' }, 'أصناف منخفضة المخزون'),
      s.low_stock.length ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tbody', {}, s.low_stock.map((p) => h('tr', {}, h('td', {}, `${p.factory_name} - ${p.name}`), h('td', {}, qtyText(p.available, p.unit)), h('td', {}, p.available <= 0 ? h('span', { class: 'pill cancelled' }, 'نفد') : h('span', { class: 'pill new' }, 'منخفض'))))))) : h('div', { class: 'panel empty' }, 'لا توجد أصناف منخفضة.'));
  } catch (e) { guard(box)(e); }
}

/* ---------- الطلبات ---------- */
async function viewOrders(params) {
  const f = { q: params.get('q') || '', status: params.get('status') || '', type: params.get('type') || '', group: params.get('group') || '' };
  const out = h('div', {}, loading());
  const qi = h('input', { placeholder: 'رقم الطلب / الاسم / الهاتف', value: f.q });
  const ss = h('select', {}, h('option', { value: '' }, 'كل الحالات'), Object.entries(labels).map(([k, v]) => h('option', { value: k }, v)));
  ss.value = f.status;
  const ts = h('select', {}, h('option', { value: '' }, 'جملة وتجزئة'), h('option', { value: 'retail' }, 'تجزئة'), h('option', { value: 'wholesale' }, 'جملة'));
  ts.value = f.type;
  const load = async () => {
    const qs = new URLSearchParams({ q: qi.value, status: ss.value, type: ts.value, ...(f.group && !ss.value ? { group: f.group } : {}) });
    try {
      const rows = await A('GET', '/api/admin/orders?' + qs);
      out.replaceChildren(rows.length ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['الطلب', 'العميل', 'النوع', 'الحالة', 'الإجمالي', 'المدفوع', 'التاريخ'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((o) => h('tr', { class: 'click', onclick: () => { location.hash = '#/order/' + o.id; } },
          h('td', {}, h('b', {}, o.number), h('div', {}, o.fulfillment === 'pickup' ? 'مستودع' : 'توصيل')), h('td', {}, o.name, h('div', { dir: 'ltr', style: 'text-align:right' }, o.phone)),
          h('td', {}, o.type === 'wholesale' ? 'جملة' : 'تجزئة'), h('td', {}, h('span', { class: 'pill ' + pillCls(o.status) }, o.status_label)),
          h('td', {}, o.total !== null && (o.fulfillment === 'pickup' || o.delivery_fee !== null) ? money(o.total) : 'غير معتمد'), h('td', {}, money(o.paid)), h('td', {}, dt(o.created_at))))))) : h('div', { class: 'panel empty' }, 'لا توجد طلبات مطابقة.'));
    } catch (e) { guard(out)(e); }
  };
  let tm; qi.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 300); }); ss.addEventListener('change', load); ts.addEventListener('change', load);
  mount(h('div', {}, h('h2', { class: 'sec' }, 'الطلبات'), h('div', { class: 'bar' }, field('بحث', qi), field('الحالة', ss), field('النوع', ts)), out), 'orders');
  load();
}

const EDITABLE = ['new', 'under_review', 'wholesale_pending', 'quote_sent', 'awaiting_customer'];
async function viewOrder(id) {
  const box = h('div', {}, loading()); mount(box, 'orders');
  let o;
  const run = async (action, body, okMsg) => { try { o = await A('POST', `/api/admin/orders/${id}/${action}`, body || {}); draw(); toast(okMsg || 'تم التنفيذ'); } catch (e) { toast(e.message, true); } };
  const draw = () => {
    const edit = EDITABLE.includes(o.status), S = o.status;
    const priceInputs = o.items.map((i) => ({ i, input: h('input', { type: 'number', min: 0, inputmode: 'numeric', value: i.unit_price ?? i.special_price ?? '', dir: 'ltr', style: 'text-align:right' }) }));
    const fee = h('input', { type: 'number', min: 0, inputmode: 'numeric', value: o.delivery_fee ?? '', dir: 'ltr', style: 'text-align:right' });
    const note = h('input', { placeholder: 'ملاحظة داخلية (لا تظهر للعميل)' });
    const payAmt = h('input', { type: 'number', min: 1, inputmode: 'numeric', value: o.remaining || '', dir: 'ltr', style: 'text-align:right' });
    const payM = h('select', {}, h('option', { value: 'cash' }, 'نقدًا'), h('option', { value: 'transfer' }, 'تحويل'), h('option', { value: 'other' }, 'أخرى'));
    if (o.payment_method === 'transfer') payM.value = 'transfer';
    const when = h('input', { type: 'datetime-local', value: o.scheduled_at || '' });
    const dn = h('input', { value: o.driver_name || '', placeholder: 'اسم السائق / الناقل' }), dp = h('input', { value: o.driver_phone || '', placeholder: 'هاتف السائق', dir: 'ltr' });
    const quoteNote = h('input', { placeholder: 'ملاحظة تظهر للعميل مع عرض السعر (اختياري)' });
    const link = location.origin + '/#/track/' + o.token;
    const waText = `السلام عليكم ${o.name}، بخصوص طلبكم رقم ${o.number} (${o.status_label})${o.total !== null ? '، الإجمالي ' + fmt(o.total) + ' ريال' : ''}.\nرابط المتابعة: ${link}`;
    const btn = (t, fn, cls = '') => h('button', { class: 'btn small ' + cls, onclick: fn }, t);
    const canDirect = o.type === 'retail' && o.fulfillment === 'pickup' && o.total !== null;
    const actions = [];
    if (S === 'new') actions.push(btn('بدء المراجعة', () => run('review')));
    if (['new', 'under_review'].includes(S) && canDirect) actions.push(btn('قبول وتأكيد وحجز الكمية', () => run('confirm')));
    if (['new', 'under_review', 'wholesale_pending', 'quote_sent', 'awaiting_customer'].includes(S) && !['awaiting_customer'].includes(S)) actions.push(btn(S === 'quote_sent' ? 'إعادة إرسال العرض' : 'إرسال عرض السعر للعميل', () => run('send_quote', { note: quoteNote.value })));
    if (S === 'quote_sent') actions.push(btn('بانتظار رد العميل', () => run('mark_awaiting'), 'alt'));
    if (['quote_sent', 'awaiting_customer'].includes(S)) actions.push(btn('تسجيل موافقة العميل (هاتفيًا)', () => { if (confirm('تسجيل موافقة العميل وحجز الكمية؟')) run('record_approval'); }));
    if (S === 'confirmed') actions.push(btn('بدء التجهيز', () => run('prepare')));
    if (['confirmed', 'preparing'].includes(S)) actions.push(o.fulfillment === 'pickup' ? btn('جاهز للاستلام', () => run('ready')) : btn('خرج للتوصيل', () => run('dispatch', { driver_name: dn.value, driver_phone: dp.value })));
    if (['ready_pickup', 'out_for_delivery'].includes(S)) actions.push(btn('تسجيل التسليم (صرف المخزون)', () => { if (confirm('تأكيد التسليم؟ سيُخصم المخزون نهائيًا.')) run('deliver'); }));
    if (!['delivered', 'completed_paid', 'cancelled'].includes(S)) actions.push(btn('إلغاء الطلب', () => {
      const r = prompt('سبب الإلغاء'); if (r === null) return;
      const refund = o.paid > 0 ? confirm(`تم تحصيل ${fmt(o.paid)} ريال. هل تؤكد تسجيل استرجاعه؟`) : false;
      if (o.paid > 0 && !refund) return;
      run('cancel', { reason: r, refund });
    }, 'bad'));
    box.replaceChildren(
      h('p', {}, h('a', { href: '#/orders' }, '← كل الطلبات')),
      h('div', { class: 'panel' }, h('h2', {}, `${o.number} — ${o.doc_kind}`), h('span', { class: 'pill ' + pillCls(S) }, o.status_label), ' ', h('span', { class: 'pill' }, o.type === 'wholesale' ? 'جملة' : 'تجزئة'),
        o.invoice_no ? h('span', { class: 'pill done', style: 'margin-inline-start:6px' }, o.invoice_no) : null,
        h('div', { class: 'grid2' },
          h('div', {}, h('div', { class: 'row' }, h('span', {}, 'العميل'), h('b', {}, o.name)), h('div', { class: 'row' }, h('span', {}, 'الهاتف'), h('span', { dir: 'ltr' }, o.phone)),
            h('div', { class: 'row' }, h('span', {}, 'الاستلام'), h('span', {}, o.fulfillment === 'pickup' ? 'من المستودع' : 'توصيل')), h('div', { class: 'row' }, h('span', {}, 'المنطقة'), h('span', {}, o.region)),
            o.address ? h('div', { class: 'row' }, h('span', {}, 'العنوان'), h('span', {}, o.address)) : null, o.pickup_request ? h('div', { class: 'row' }, h('span', {}, 'موعد مقترح'), h('span', {}, o.pickup_request)) : null,
            o.notes ? h('div', { class: 'row' }, h('span', {}, 'ملاحظات العميل'), h('span', {}, o.notes)) : null,
            o.customer?.wholesale_approved ? h('div', { class: 'notice' }, 'عميل جملة معتمد') : null),
          h('div', {}, h('div', { class: 'row' }, h('span', {}, 'قيمة المواد'), h('span', {}, money(o.items_total))), o.discount > 0 ? h('div', { class: 'row' }, h('span', {}, 'خصم (مُضمَّن)'), h('span', {}, money(o.discount))) : null,
            o.fulfillment === 'delivery' ? h('div', { class: 'row' }, h('span', {}, 'أجرة النقل'), h('span', {}, o.delivery_fee === null ? 'لم تُحدَّد' : money(o.delivery_fee))) : null,
            h('div', { class: 'row total' }, h('span', {}, 'الإجمالي'), h('span', {}, o.total === null ? 'غير معتمد' : money(o.total))),
            h('div', { class: 'row' }, h('span', {}, 'المدفوع'), h('span', {}, money(o.paid))), h('div', { class: 'row' }, h('span', {}, 'المتبقي'), h('span', {}, o.remaining === null ? '—' : money(o.remaining))),
            h('div', { class: 'row' }, h('span', {}, 'الدفع'), h('span', {}, ({ unpaid: 'غير مسدّد', pending_verification: 'بانتظار التحقق', partial: 'جزئي', paid: 'مدفوع' })[o.payment_status] + (o.payment_method === 'transfer' ? ' - تحويل' : ' - نقدًا'))),
            o.transfer_ref ? h('div', { class: 'notice warn' }, 'بيانات التحويل من العميل: ', h('b', {}, o.transfer_ref), o.transfer_verified ? ' (تم التحقق)' : ' — بانتظار التحقق، سجّل الدفعة بعد المطابقة') : null))),
      h('div', { class: 'panel' }, h('h2', {}, 'الأصناف والأسعار'),
        h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['الصنف', 'الكمية', 'متاح', 'سعر التجزئة', edit ? 'سعر الطلب' : 'سعر الوحدة', 'الإجمالي'].map((t) => h('th', {}, t)))),
          h('tbody', {}, priceInputs.map(({ i, input }) => h('tr', {}, h('td', {}, i.name, i.wholesale_hint ? h('div', { class: 'hint' }, `مرجع الجملة: ${fmt(i.wholesale_hint)}`) : null, i.special_price ? h('div', { class: 'hint' }, `سعر خاص للعميل: ${fmt(i.special_price)}`) : null),
            h('td', {}, qtyText(i.qty, i.unit)), h('td', {}, h('span', { class: 'pill' + (i.available < i.qty && o.reserved === 0 ? ' cancelled' : '') }, fmt(i.available))), h('td', {}, fmt(i.list_price)), h('td', {}, edit ? input : i.unit_price === null ? '—' : fmt(i.unit_price)), h('td', {}, i.line_total === null ? '—' : fmt(i.line_total))))))),
        edit ? h('div', { class: 'bar' }, btn('حفظ الأسعار', () => run('set_prices', { items: priceInputs.map(({ i, input }) => ({ id: i.id, unit_price: input.value })) }, 'تم حفظ الأسعار'))) : null,
        edit && o.fulfillment === 'delivery' ? h('div', { class: 'bar' }, field('أجرة النقل (ريال)', fee), btn('حفظ الأجرة', () => run('set_fee', { fee: fee.value }, 'تم حفظ الأجرة'))) : null,
        edit ? h('div', { class: 'bar' }, field('رسالة مع عرض السعر', quoteNote)) : null,
        h('div', { class: 'btns' }, actions)),
      !['cancelled'].includes(S) && o.total !== null && (o.fulfillment === 'pickup' || o.delivery_fee !== null) ? h('div', { class: 'panel' }, h('h2', {}, 'الموعد والتوصيل والتحصيل'),
        !['delivered', 'completed_paid'].includes(S) ? h('div', { class: 'bar' }, field('موعد التسليم/الاستلام', when), btn('حفظ الموعد', () => when.value ? run('schedule', { scheduled_at: when.value }) : toast('حدّد الموعد', true), 'alt')) : null,
        o.fulfillment === 'delivery' && !['delivered', 'completed_paid'].includes(S) ? h('div', { class: 'bar' }, field('السائق/الناقل', dn), field('هاتفه', dp), btn('حفظ', () => run('set_driver', { driver_name: dn.value, driver_phone: dp.value }), 'alt')) : null,
        ['confirmed', 'preparing', 'ready_pickup', 'out_for_delivery', 'delivered'].includes(S) && o.remaining > 0 ? h('div', { class: 'bar' }, field('مبلغ محصّل', payAmt), field('الطريقة', payM), btn('تسجيل التحصيل', () => run('payment', { amount: payAmt.value, method: payM.value }, 'تم تسجيل التحصيل'))) : null,
        o.payments.length ? h('table', { class: 'tbl' }, h('tbody', {}, o.payments.map((p) => h('tr', {}, h('td', {}, dt(p.at)), h('td', {}, money(p.amount)), h('td', {}, ({ cash: 'نقدًا', transfer: 'تحويل', other: 'أخرى' })[p.method]), h('td', {}, p.actor), h('td', {}, p.note || ''))))) : null) : null,
      h('div', { class: 'panel' }, h('h2', {}, 'التواصل والطباعة'), h('div', { class: 'btns' },
        h('a', { class: 'btn wa small', target: '_blank', rel: 'noopener', href: waLink(o.phone, waText) }, 'واتساب العميل (ملخص + رابط المتابعة)'),
        h('a', { class: 'btn alt small', target: '_blank', href: '/invoice?id=' + id }, 'طباعة المستند'), h('a', { class: 'btn alt small', target: '_blank', href: '/invoice?id=' + id + '&mode=prep' }, 'أمر تجهيز'),
        h('button', { class: 'btn alt small', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('تم نسخ الرابط'); } catch { prompt('الرابط', link); } } }, 'نسخ رابط المتابعة'))),
      h('div', { class: 'panel' }, h('h2', {}, 'السجل الزمني'), h('div', { class: 'bar' }, field('ملاحظة داخلية', note), btn('إضافة', () => note.value.trim() ? run('note', { text: note.value }, 'تمت الإضافة') : toast('اكتب الملاحظة', true), 'alt')),
        h('ul', { class: 'steps' }, [...o.events].reverse().map((e) => h('li', {}, h('b', {}, e.status_label || ''), ' ', h('small', {}, `${dt(e.at)} — ${e.actor || ''}`), e.note ? h('div', { class: e.visible ? '' : 'internal' }, e.visible ? '' : 'داخلي: ', e.note) : null)))));
  };
  try { o = await A('GET', '/api/admin/orders/' + id); draw(); } catch (e) { guard(box)(e); }
}

/* ---------- المنتجات والمخزون ---------- */
async function resizeImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * scale); cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.82);
}
async function viewProducts() {
  const box = h('div', {}, loading()); mount(box, 'products');
  const load = async () => {
    try {
      const [prods, facs, cats] = await Promise.all([A('GET', '/api/admin/products'), A('GET', '/api/admin/factories'), A('GET', '/api/admin/categories')]);
      box.replaceChildren(h('h2', { class: 'sec' }, 'المنتجات والمخزون'),
        owner() ? h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => productForm(null, facs, cats, load) }, '+ منتج جديد'), h('button', { class: 'btn alt', onclick: () => listForm('المصانع والعلامات التجارية', facs, '/api/admin/factories', 'مصنع / علامة جديدة', load) }, 'إدارة المصانع'), h('button', { class: 'btn alt', onclick: () => listForm('التصنيفات', cats, '/api/admin/categories', 'تصنيف جديد', load) }, 'إدارة التصنيفات')) : null,
        h('div', { class: 'scroll', style: 'margin-top:10px' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['المنتج', 'السعر', 'المخزون', 'محجوز', 'متاح', 'الحالة', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, prods.map((p) => h('tr', {}, h('td', {}, h('b', {}, p.factory_name), h('div', {}, p.name), p.category_name ? h('div', { class: 'hint' }, p.category_name) : null), h('td', {}, money(p.retail_price), p.discount_percent > 0 ? h('div', { class: 'hint' }, `خصم ${p.discount_percent}%`) : null, h('div', { class: 'hint' }, 'لكل ' + unitName(p.unit))),
            h('td', {}, qtyText(p.stock, p.unit)), h('td', {}, fmt(p.reserved)), h('td', {}, h('span', { class: 'pill' + (p.available <= p.low_stock_at ? ' new' : '') }, fmt(p.available))),
            h('td', {}, p.active ? (p.paused ? h('span', { class: 'pill new' }, 'متوقف مؤقتًا') : h('span', { class: 'pill done' }, 'معروض')) : h('span', { class: 'pill cancelled' }, 'مخفي')),
            h('td', {}, h('div', { class: 'btns' }, h('button', { class: 'btn small alt', onclick: () => stockForm(p, load) }, 'المخزون'), owner() ? h('button', { class: 'btn small alt', onclick: () => productForm(p, facs, cats, load) }, 'تعديل') : null))))))),
        !prods.length ? h('div', { class: 'panel empty' }, owner() ? 'أضف مصنعًا (أو علامة تجارية) وتصنيفًا ثم منتجًا لتبدأ.' : 'لا توجد منتجات.') : null);
    } catch (e) { guard(box)(e); }
  };
  load();
}
function modal(title, body) {
  const m = h('div', { style: 'position:fixed;inset:0;background:#0007;z-index:60;overflow:auto;padding:10px' },
    h('div', { class: 'panel', style: 'max-width:640px;margin:20px auto' }, h('h2', {}, title), body, h('p', {}, h('button', { class: 'btn alt small', onclick: () => m.remove() }, 'إغلاق'))));
  document.body.append(m); return m;
}
function listForm(title, items, endpoint, newLabel, done) {
  const name = h('input', { placeholder: newLabel });
  const m = modal(title, h('div', {},
    h('table', { class: 'tbl' }, h('tbody', {}, items.map((f) => h('tr', {}, h('td', {}, f.name), h('td', {}, f.active ? 'ظاهر' : 'مخفي'), h('td', {}, h('button', { class: 'btn small alt', onclick: async () => { try { await A('PUT', `${endpoint}/${f.id}`, { name: f.name, active: !f.active, sort: f.sort }); m.remove(); done(); } catch (e) { toast(e.message, true); } } }, f.active ? 'إخفاء' : 'إظهار')))))),
    h('div', { class: 'bar' }, field(newLabel, name), h('button', { class: 'btn small', onclick: async () => { try { await A('POST', endpoint, { name: name.value }); toast('تمت الإضافة'); m.remove(); done(); } catch (e) { toast(e.message, true); } } }, 'إضافة'))));
}
function productForm(p, facs, cats, done) {
  if (!facs.length) return toast('أضف مصنعًا أولًا من «إدارة المصانع»', true);
  const v = p || { unit: 'bag', bag_weight_kg: 50, min_order: 1, discount_percent: 0, low_stock_at: 20, active: 1, paused: 0, stock: 0 };
  const I = (name, type = 'text', extra = {}) => h('input', { name, type, value: v[name] ?? '', ...extra });
  const fac = h('select', {}, facs.filter((f) => f.active || f.id === v.factory_id).map((f) => h('option', { value: f.id }, f.name))); fac.value = v.factory_id || facs[0].id;
  const unit = h('select', {}, Object.entries(UNITS).map(([k, u]) => h('option', { value: k }, u.name + (k === 'bag' ? ' (أسمنت معبأ)' : k === 'ton' ? ' (سائب / حديد)' : '')))); unit.value = v.unit;
  const cat = h('select', {}, h('option', { value: '' }, 'بدون تصنيف'), cats.filter((c) => c.active || c.id === v.category_id).map((c) => h('option', { value: c.id }, c.name))); cat.value = v.category_id || '';
  const f = { name: I('name'), cement_type: I('cement_type'), spec: h('textarea', {}, v.spec || ''), bag_weight_kg: I('bag_weight_kg', 'number', { step: 'any' }), retail_price: I('retail_price', 'number'), discount_percent: I('discount_percent', 'number', { step: 'any' }), offer_note: I('offer_note'), min_order: I('min_order', 'number', { step: 'any' }), wholesale_min: I('wholesale_min', 'number', { step: 'any' }), wholesale_hint: I('wholesale_hint', 'number'), low_stock_at: I('low_stock_at', 'number', { step: 'any' }), stock: I('stock', 'number', { step: 'any' }) };
  const active = h('input', { type: 'checkbox', checked: !!v.active }), paused = h('input', { type: 'checkbox', checked: !!v.paused });
  let image = v.image || null;
  const prev = h('div', {}, image ? h('img', { class: 'imgprev', src: image, alt: '' }) : null);
  const file = h('input', { type: 'file', accept: 'image/*' });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try { const r = await A('POST', '/api/admin/upload', { data: await resizeImage(file.files[0]) }); image = r.path; prev.replaceChildren(h('img', { class: 'imgprev', src: image, alt: '' })); toast('تم رفع الصورة'); }
    catch (e) { toast(e.message || 'تعذّر رفع الصورة', true); }
  });
  const m = modal(p ? 'تعديل منتج' : 'منتج جديد', h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const body = { factory_id: Number(fac.value), category_id: cat.value ? Number(cat.value) : null, unit: unit.value, image, active: active.checked, paused: paused.checked };
    for (const [k, el] of Object.entries(f)) if (!(k === 'stock' && p)) body[k] = el.value;
    try { await A(p ? 'PUT' : 'POST', '/api/admin/products' + (p ? '/' + p.id : ''), body); toast('تم الحفظ'); m.remove(); done(); } catch (er) { toast(er.message, true); }
  } }, field('المصنع / العلامة التجارية', fac), field('التصنيف', cat), field('اسم المنتج', f.name), h('div', { class: 'two' }, field('النوع / الدرجة', f.cement_type), field('وحدة البيع', unit)),
    field('وزن الكيس (كجم)', f.bag_weight_kg, 'اختياري، لوحدة «كيس» فقط'), field('المواصفات', f.spec),
    h('div', { class: 'two' }, field('سعر التجزئة (ريال لكل وحدة)', f.retail_price), field('خصم %', f.discount_percent)), field('نص العرض (يظهر للعميل)', f.offer_note),
    h('div', { class: 'two' }, field('الحد الأدنى للطلب', f.min_order), field('حد الجملة الأدنى (اختياري)', f.wholesale_min)),
    field('سعر الجملة المرجعي (داخلي، لا يظهر للعملاء)', f.wholesale_hint), h('div', { class: 'two' }, field('تنبيه انخفاض المخزون عند', f.low_stock_at), p ? null : field('المخزون الافتتاحي', f.stock)),
    field('صورة المنتج', file), prev,
    h('label', { class: 'chk' }, active, 'معروض في المتجر'), h('label', { class: 'chk' }, paused, 'إيقاف البيع مؤقتًا (يبقى ظاهرًا كغير متاح)'),
    h('button', { class: 'btn', type: 'submit' }, 'حفظ')));
}
function stockForm(p, done) {
  const qty = h('input', { type: 'number', step: 'any', inputmode: 'decimal', dir: 'ltr' }), nt = h('input', { placeholder: 'سبب/ملاحظة' });
  const body = h('div', {}, h('div', { class: 'notice' }, `${p.factory_name} - ${p.name}: المخزون ${qtyText(p.stock, p.unit)} | محجوز ${fmt(p.reserved)} | متاح ${fmt(p.available)}`), field('الكمية', qty), field('ملاحظة', nt));
  const op = (name, label, cls = '') => h('button', { class: 'btn small ' + cls, onclick: async () => { try { await A('POST', `/api/admin/products/${p.id}/stock`, { op: name, qty: qty.value, note: nt.value }); toast('تم تحديث المخزون'); m.remove(); done(); } catch (e) { toast(e.message, true); } } }, label);
  const hist = h('div', {}, loading());
  body.append(h('div', { class: 'btns' }, op('receive', 'إضافة بضاعة واردة'), op('adjust', 'تعديل (+/−)', 'alt'), op('count', 'جرد: ضبط الرصيد على هذه الكمية', 'alt')), h('h2', { style: 'margin-top:14px' }, 'آخر الحركات'), hist);
  const m = modal('مخزون المنتج', body);
  const K = { in: 'وارد', reserve: 'حجز', release: 'فك حجز', issue: 'صرف', adjust: 'تسوية/جرد' };
  A('GET', '/api/admin/stock-movements?product_id=' + p.id).then((r) => hist.replaceChildren(h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tbody', {}, r.slice(0, 40).map((x) => h('tr', {}, h('td', {}, dt(x.at)), h('td', {}, K[x.kind] || x.kind), h('td', {}, fmt(x.qty)), h('td', {}, x.actor || ''), h('td', {}, x.note || '')))))))).catch(() => {});
}

/* ---------- العملاء ---------- */
async function viewCustomers() {
  const box = h('div', {}, loading()); mount(box, 'customers');
  const qi = h('input', { placeholder: 'بحث بالاسم أو الهاتف' }); const out = h('div');
  const load = async () => {
    try {
      const rows = await A('GET', '/api/admin/customers?q=' + encodeURIComponent(qi.value));
      out.replaceChildren(h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['العميل', 'الطلبات', 'إجمالي المشتريات', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.map((c) => h('tr', { class: 'click', onclick: () => customerDetail(c.id) }, h('td', {}, h('b', {}, c.name), h('div', { dir: 'ltr', style: 'text-align:right' }, c.phone)), h('td', {}, fmt(c.orders), c.repeat ? h('span', { class: 'pill done', style: 'margin-inline-start:6px' }, 'متكرر') : null), h('td', {}, money(c.total)), h('td', {}, c.wholesale_approved ? h('span', { class: 'pill go' }, 'جملة معتمد') : '')))))));
      if (!rows.length) out.replaceChildren(h('div', { class: 'panel empty' }, 'لا يوجد عملاء بعد.'));
    } catch (e) { guard(out)(e); }
  };
  let tm; qi.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 300); });
  box.replaceChildren(h('h2', { class: 'sec' }, 'العملاء'), h('div', { class: 'bar' }, field('بحث', qi), h('a', { class: 'btn alt small', href: '/api/admin/reports?csv=customers' }, 'تصدير CSV')), out);
  load();
}
async function customerDetail(id) {
  const c = await A('GET', '/api/admin/customers/' + id);
  const notes = h('textarea', {}, c.notes || ''), appr = h('input', { type: 'checkbox', checked: !!c.wholesale_approved, disabled: !owner() });
  const products = owner() ? await A('GET', '/api/admin/products') : [];
  const ps = h('select', {}, products.map((p) => h('option', { value: p.id }, `${p.factory_name} - ${p.name}`))), pr = h('input', { type: 'number', min: 0, dir: 'ltr', placeholder: 'السعر الخاص' });
  const m = modal(c.name, h('div', {}, h('div', { class: 'row' }, h('span', {}, 'الهاتف'), h('span', { dir: 'ltr' }, c.phone)),
    h('label', { class: 'chk' }, appr, 'عميل جملة معتمد'), field('ملاحظات داخلية', notes),
    h('button', { class: 'btn small', onclick: async () => { try { await A('PUT', '/api/admin/customers/' + id, { notes: notes.value, ...(owner() ? { wholesale_approved: appr.checked } : {}) }); toast('تم الحفظ'); m.remove(); viewCustomers(); } catch (e) { toast(e.message, true); } } }, 'حفظ'),
    h('h2', { style: 'margin-top:14px' }, 'أسعار خاصة'), c.prices.length ? h('table', { class: 'tbl' }, h('tbody', {}, c.prices.map((x) => h('tr', {}, h('td', {}, x.name), h('td', {}, money(x.price)), owner() ? h('td', {}, h('button', { class: 'btn small alt', onclick: async () => { await A('PUT', `/api/admin/customers/${id}/prices`, { product_id: x.product_id, price: null }); m.remove(); customerDetail(id); } }, 'حذف')) : null)))) : h('p', { class: 'spec' }, 'لا توجد أسعار خاصة.'),
    owner() && products.length ? h('div', { class: 'bar' }, field('المنتج', ps), field('السعر', pr), h('button', { class: 'btn small alt', onclick: async () => { try { await A('PUT', `/api/admin/customers/${id}/prices`, { product_id: Number(ps.value), price: pr.value }); m.remove(); customerDetail(id); } catch (e) { toast(e.message, true); } } }, 'حفظ السعر')) : null,
    h('h2', { style: 'margin-top:14px' }, 'عناوين التوصيل'), c.addresses.length ? h('ul', {}, c.addresses.map((a) => h('li', {}, `${a.region} - ${a.address}`))) : h('p', { class: 'spec' }, 'لا توجد عناوين.'),
    h('h2', { style: 'margin-top:14px' }, 'سجل الطلبات'), h('table', { class: 'tbl' }, h('tbody', {}, c.orders.map((o) => h('tr', { class: 'click', onclick: () => { m.remove(); location.hash = '#/order/' + o.id; } }, h('td', {}, o.number), h('td', {}, o.status_label), h('td', {}, money(o.total))))))));
}

/* ---------- التوصيل ---------- */
async function viewDelivery() {
  const box = h('div', {}, loading()); mount(box, 'delivery');
  const load = async () => {
    try {
      const [zones, dl] = await Promise.all([A('GET', '/api/admin/zones'), A('GET', '/api/admin/deliveries')]);
      const zn = h('input', { placeholder: 'اسم المنطقة / المحافظة' }), zf = h('input', { type: 'number', min: 0, placeholder: 'أجرة تقديرية (اختياري)', dir: 'ltr' });
      box.replaceChildren(h('h2', { class: 'sec' }, 'شحنات التوصيل الحالية'),
        dl.length ? h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tbody', {}, dl.map((d) => h('tr', { class: 'click', onclick: () => { location.hash = '#/order/' + d.id; } }, h('td', {}, h('b', {}, d.number), h('div', {}, d.name)), h('td', {}, d.region, h('div', { class: 'hint' }, d.address || '')), h('td', {}, d.status_label), h('td', {}, d.scheduled_at ? d.scheduled_at.replace('T', ' ') : 'بلا موعد'), h('td', {}, d.driver_name || 'بلا سائق'), h('td', {}, money(d.delivery_fee))))))) : h('div', { class: 'panel empty' }, 'لا توجد شحنات قيد التنفيذ.'),
        owner() ? h('div', {}, h('h2', { class: 'sec' }, 'مناطق التوصيل'), h('div', { class: 'notice' }, 'تظهر هذه المناطق للعميل عند اختيار التوصيل. الأجرة التقديرية للعرض فقط، وتحدد الإدارة الأجرة النهائية لكل طلب.'),
          h('table', { class: 'tbl' }, h('tbody', {}, zones.map((z) => h('tr', {}, h('td', {}, z.name), h('td', {}, z.indicative_fee ? money(z.indicative_fee) : '—'), h('td', {}, z.active ? 'ظاهرة' : 'مخفية'), h('td', {}, h('button', { class: 'btn small alt', onclick: async () => { await A('PUT', '/api/admin/zones/' + z.id, { name: z.name, indicative_fee: z.indicative_fee, active: !z.active }); load(); } }, z.active ? 'إخفاء' : 'إظهار')))))),
          h('div', { class: 'bar' }, field('منطقة جديدة', zn), field('الأجرة التقديرية', zf), h('button', { class: 'btn small', onclick: async () => { try { await A('POST', '/api/admin/zones', { name: zn.value, indicative_fee: zf.value }); load(); } catch (e) { toast(e.message, true); } } }, 'إضافة'))) : null);
    } catch (e) { guard(box)(e); }
  };
  load();
}

/* ---------- التقارير ---------- */
async function viewReports(params) {
  const box = h('div', {}, loading()); mount(box, 'reports');
  const from = h('input', { type: 'date', value: params.get('from') || '' }), to = h('input', { type: 'date', value: params.get('to') || '' });
  const out = h('div');
  const qs = () => new URLSearchParams({ ...(from.value ? { from: from.value } : {}), ...(to.value ? { to: to.value } : {}) }).toString();
  const load = async () => {
    try {
      const r = await A('GET', '/api/admin/reports?' + qs());
      if (!from.value) { from.value = r.from; to.value = r.to; }
      const T = (head, rows) => h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))), h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: head.length }, 'لا توجد بيانات')))));
      out.replaceChildren(
        h('div', { class: 'stats' }, [['عدد الفواتير المسلّمة', r.sales.orders], ['إجمالي المبيعات (ريال)', r.sales.total], ['المحصّل (ريال)', r.collected]].map(([t, v]) => h('div', { class: 'stat' }, h('b', {}, fmt(v)), h('span', {}, t)))),
        h('h2', { class: 'sec' }, 'الأكثر طلبًا'), T(['المنتج', 'الكمية', 'القيمة'], r.top_products.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, qtyText(p.qty, p.unit)), h('td', {}, money(p.total))))),
        h('h2', { class: 'sec' }, 'أفضل العملاء'), T(['العميل', 'الطلبات', 'الإجمالي'], r.top_customers.map((c) => h('tr', {}, h('td', {}, c.name), h('td', {}, fmt(c.orders)), h('td', {}, money(c.total))))),
        h('h2', { class: 'sec' }, 'المبيعات اليومية'), T(['اليوم', 'الطلبات', 'المبيعات'], r.daily.map((d) => h('tr', {}, h('td', {}, d.day), h('td', {}, fmt(d.orders)), h('td', {}, money(d.total))))),
        h('h2', { class: 'sec' }, 'جملة / تجزئة'), T(['النوع', 'الطلبات', 'المبيعات'], r.by_type.map((d) => h('tr', {}, h('td', {}, d.type === 'wholesale' ? 'جملة' : 'تجزئة'), h('td', {}, fmt(d.orders)), h('td', {}, money(d.total))))),
        h('h2', { class: 'sec' }, 'حالات الطلبات المنشأة في الفترة'), T(['الحالة', 'العدد'], r.orders_by_status.map((d) => h('tr', {}, h('td', {}, labels[d.status] || d.status), h('td', {}, fmt(d.n))))),
        h('h2', { class: 'sec' }, 'تصدير البيانات (Excel / CSV)'),
        h('div', { class: 'btns' }, [['orders', 'الطلبات'], ['sales', 'المبيعات'], ['products', 'المنتجات والمخزون'], ['customers', 'العملاء']].map(([k, t]) => h('a', { class: 'btn alt small', href: `/api/admin/reports?csv=${k}&${qs()}` }, t))));
    } catch (e) { guard(out)(e); }
  };
  box.replaceChildren(h('h2', { class: 'sec' }, 'التقارير'), h('div', { class: 'bar' }, field('من', from), field('إلى', to), h('button', { class: 'btn small', onclick: load }, 'عرض'), h('button', { class: 'btn small alt', onclick: () => window.print() }, 'طباعة')), out);
  load();
}

/* ---------- الإعدادات والمستخدمون والنسخ الاحتياطي ---------- */
async function viewSettings() {
  const box = h('div', {}, loading()); mount(box, 'settings');
  const load = async () => {
    try {
      const [s, users, audit] = await Promise.all([A('GET', '/api/admin/settings'), A('GET', '/api/admin/users'), A('GET', '/api/admin/audit')]);
      const L = { store_name: 'اسم المتجر', phone: 'رقم الهاتف', whatsapp: 'رقم واتساب الدولي (مثال 967775477377)', city: 'الموقع', warehouse_name: 'اسم المستودع', warehouse_address: 'عنوان المستودع التفصيلي', warehouse_hours: 'ساعات الاستلام', bank_note: 'تعليمات التحويل (تظهر للعميل)', wholesale_min_bags: 'حد الجملة الافتراضي (أكياس)', wholesale_min_tons: 'حد الجملة الافتراضي (طن)' };
      const inputs = Object.fromEntries(Object.keys(L).map((k) => [k, k === 'bank_note' || k === 'warehouse_address' ? h('textarea', {}, s[k] || '') : h('input', { value: s[k] || '' })]));
      const un = h('input', { dir: 'ltr', autocomplete: 'off' }), up = h('input', { type: 'password', autocomplete: 'new-password', dir: 'ltr', placeholder: '8 أحرف على الأقل' }), ur = h('select', {}, h('option', { value: 'staff' }, 'موظف'), h('option', { value: 'owner' }, 'مدير'));
      box.replaceChildren(h('h2', { class: 'sec' }, 'إعدادات المتجر'),
        h('div', { class: 'panel' }, Object.entries(L).map(([k, t]) => field(t, inputs[k])), h('button', { class: 'btn', onclick: async () => { try { await A('PUT', '/api/admin/settings', Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]))); toast('تم الحفظ'); } catch (e) { toast(e.message, true); } } }, 'حفظ الإعدادات')),
        h('h2', { class: 'sec' }, 'المستخدمون والصلاحيات'),
        h('div', { class: 'notice' }, 'المدير: كل الصلاحيات. الموظف: إدارة الطلبات والعملاء والتوصيل وحركة المخزون فقط، دون تعديل المنتجات والأسعار أو التقارير أو الإعدادات.'),
        h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tbody', {}, users.map((u) => h('tr', {}, h('td', {}, u.username), h('td', {}, u.role === 'owner' ? 'مدير' : 'موظف'), h('td', {}, u.active ? 'فعّال' : 'موقوف'),
          h('td', {}, h('div', { class: 'btns' }, h('button', { class: 'btn small alt', onclick: async () => { try { await A('PUT', '/api/admin/users/' + u.id, { active: !u.active }); load(); } catch (e) { toast(e.message, true); } } }, u.active ? 'إيقاف' : 'تفعيل'),
            h('button', { class: 'btn small alt', onclick: async () => { const p = prompt('كلمة مرور جديدة (8 أحرف على الأقل)'); if (p) { try { await A('PUT', '/api/admin/users/' + u.id, { password: p }); toast('تم التغيير'); } catch (e) { toast(e.message, true); } } } }, 'تغيير كلمة المرور')))))))),
        h('div', { class: 'bar' }, field('مستخدم جديد', un), field('كلمة المرور', up), field('الصلاحية', ur), h('button', { class: 'btn small', onclick: async () => { try { await A('POST', '/api/admin/users', { username: un.value, password: up.value, role: ur.value }); load(); } catch (e) { toast(e.message, true); } } }, 'إضافة')),
        h('h2', { class: 'sec' }, 'النسخ الاحتياطي'), h('div', { class: 'panel' }, h('p', {}, 'حمّل نسخة كاملة (الطلبات والمنتجات والعملاء وصور المنتجات) في ملف واحد، واحفظها في مكان آمن بانتظام.'), h('a', { class: 'btn', href: '/api/admin/backup' }, 'تنزيل نسخة احتياطية')),
        h('h2', { class: 'sec' }, 'سجل عمليات الإدارة'), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tbody', {}, audit.slice(0, 80).map((a) => h('tr', {}, h('td', {}, a.at), h('td', {}, a.actor || ''), h('td', {}, a.action), h('td', {}, a.detail || '')))))));
    } catch (e) { guard(box)(e); }
  };
  load();
}

/* ---------- الموجّه ---------- */
function route() {
  if (!me) return;
  const [path, qs] = (location.hash.replace(/^#/, '') || '/dash').split('?'), params = new URLSearchParams(qs || ''), parts = path.split('/').filter(Boolean);
  const k = parts[0] || 'dash';
  if (k === 'order') return viewOrder(parts[1]);
  if (k === 'orders') return viewOrders(params);
  if (k === 'products') return viewProducts();
  if (k === 'customers') return viewCustomers();
  if (k === 'delivery') return viewDelivery();
  if (k === 'reports' && owner()) return viewReports(params);
  if (k === 'settings' && owner()) return viewSettings();
  return viewDash();
}
async function boot() {
  try { me = await A('GET', '/api/admin/me'); labels = me.statusLabels; setUnits(me.units); }
  catch (e) { me = null; return viewLogin(e.status === 401 ? '' : e.message); }
  lastNew = null; route(); poll(); clearInterval(pollTimer); pollTimer = setInterval(poll, 20000);
}
window.addEventListener('hashchange', route);
boot();
