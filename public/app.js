import { h, fmt, money, unitName, unitInt, setUnits, qtyText, dt, waLink, api, toast, bagSvg, field, CUST_TYPES, custNote } from '/common.js';

const app = document.getElementById('app');
let cat = null;               // الكتالوج الحالي (من الخادم)
let q = '', facId = 0, catId = 0, offersOnly = false;
let installEvt = null;
let wsPreType = '';           // نوع العميل المختار مسبقًا عند الدخول من بطاقات الجملة
const privacyLine = () => h('p', { class: 'hint' }, 'بإرسال بياناتك فإنك توافق على ', h('a', { href: '#/privacy', target: '_blank', rel: 'noopener' }, 'سياسة الخصوصية'), '.');
let pollTimer = null;

/* ---------- التخزين المحلي (السلة تحمل المعرّف والكمية فقط، ولا تحمل الأسعار الموثوقة) ---------- */
const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const getCart = () => jget('cw_cart', []);
const setCart = (c) => { jset('cw_cart', c); };
const cartCount = () => getCart().length;
function addToCart(p, qty) {
  const c = getCart(), it = c.find((x) => x.id === p.id);
  if (it) { it.qty = Math.round((it.qty + qty) * 1000) / 1000; } else c.push({ id: p.id, qty, seen: p.price });
  setCart(c);
  toast('تمت الإضافة إلى السلة');
  updateCartBadge();
}
function updateCartBadge() { const b = document.getElementById('cartn'); if (b) b.textContent = cartCount(); }

/* ---------- الكتالوج ---------- */
async function loadCatalog(force) {
  if (cat && !force && Date.now() - cat._t < 60000) return cat;
  try { cat = await api('GET', '/api/catalog'); cat._t = Date.now(); }
  catch (e) { if (!cat) throw e; toast('تعذّر تحديث الأسعار، تُعرض آخر نسخة محفوظة', true); }
  setUnits(cat.units);
  if (cat.store?.store_name) document.title = cat.store.store_name + ' - ' + (cat.store.city || '');
  return cat;
}
const prod = (id) => cat?.products.find((p) => p.id === Number(id));
const AV = { available: ['متوفر', 'ok'], low: ['كمية محدودة', 'low'], out: ['نفدت الكمية', 'out'], paused: ['غير متاح مؤقتًا', 'out'] };
const canBuy = (p) => p.availability === 'available' || p.availability === 'low';

/* ---------- الهيكل العام ---------- */
function shell(content, active) {
  const s = cat?.store || {};
  const tabs = [['#/', 'المنتجات', 'home'], ['#/wholesale', 'طلب بالجملة', 'wholesale'], ['#/orders', 'طلباتي', 'orders'], ['#/contact', 'اتصل بنا', 'contact']];
  const search = h('input', { type: 'search', placeholder: 'ابحث عن أسمنت أو مصنع…', value: q, 'aria-label': 'بحث', onclick: null });
  search.addEventListener('input', () => { q = search.value; if (location.hash && location.hash !== '#/' && location.hash !== '#') location.hash = '#/'; else renderGrid(); });
  return [
    h('header', { class: 'top' }, h('div', { class: 'wrap' },
      h('a', { class: 'brand', href: '#/' }, h('img', { src: '/icons/icon-192.png', alt: '' }), h('span', {}, s.store_name || 'عالم الأسمنت ومواد البناء')),
      h('div', { class: 'search' }, search),
      h('a', { class: 'iconbtn', href: '#/cart', 'aria-label': 'السلة' }, 'السلة', h('span', { class: 'n', id: 'cartn' }, cartCount())))),
    h('nav', { class: 'sub' }, h('div', { class: 'wrap' }, tabs.map(([href, t, k]) => h('a', { href, class: active === k ? 'on' : '' }, t)))),
    content,
    h('footer', { class: 'foot' }, h('div', { class: 'wrap' },
      h('div', {}, `${s.store_name || 'عالم الأسمنت ومواد البناء'} — ${s.city || ''}`),
      h('div', {}, 'اتصال وواتساب: ', h('a', { href: 'tel:' + (s.phone || ''), dir: 'ltr' }, s.phone || '')),
      h('div', { class: 'foot-links' }, h('a', { href: '#/privacy' }, 'سياسة الخصوصية'), ' · ', h('a', { href: '#/contact' }, 'موقعنا وطرق التواصل')),
      installEvt ? h('p', {}, h('button', { class: 'btn small alt', style: 'color:#fff;border-color:#fff8', onclick: async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; route(); } }, 'تثبيت المتجر كتطبيق على هاتفك')) : h('p', {}, 'لتثبيته كتطبيق: من قائمة المتصفح اختر «إضافة إلى الشاشة الرئيسية».'))),
    s.whatsapp ? h('a', { class: 'btn wa fab', href: waLink(s.whatsapp, 'السلام عليكم، أريد الاستفسار عن الأسمنت'), target: '_blank', rel: 'noopener' }, 'واتساب') : null,
  ];
}
function mount(content, active) {
  clearInterval(pollTimer);
  app.replaceChildren(...shell(content, active).flat().filter(Boolean));
  window.scrollTo(0, 0);
}
const errorView = (e) => h('div', { class: 'wrap' }, h('div', { class: 'panel empty' }, h('p', {}, e.message || 'حدث خطأ'), h('button', { class: 'btn', onclick: () => route() }, 'إعادة المحاولة')));

/* ---------- عنصر الكمية ---------- */
function qtyControl(p, start) {
  const step = unitInt(p.unit) ? 1 : 0.5;
  const min = p.min_order || 1;
  const input = h('input', { type: 'number', inputmode: 'decimal', min, step, value: start ?? min, 'aria-label': 'الكمية' });
  const clamp = () => { let v = Number(input.value); if (!isFinite(v) || v < min) v = min; if (unitInt(p.unit)) v = Math.round(v); input.value = v; return v; };
  input.addEventListener('change', clamp);
  const el = h('div', { class: 'qty' },
    h('button', { type: 'button', 'aria-label': 'زيادة', onclick: () => { input.value = Number(input.value || 0) + step; clamp(); input.dispatchEvent(new Event('qty')); } }, '+'),
    input,
    h('button', { type: 'button', 'aria-label': 'إنقاص', onclick: () => { input.value = Number(input.value || 0) - step; clamp(); input.dispatchEvent(new Event('qty')); } }, '−'));
  return { el, input, get: clamp };
}

/* ---------- بطاقة المنتج ---------- */
function priceBlock(p) {
  return h('div', { class: 'price' }, money(p.price), h('small', {}, ' / ' + unitName(p.unit)),
    p.discount_percent > 0 ? h('s', {}, fmt(p.retail_price)) : null);
}
const unitLine = (p) => (p.unit === 'bag' && p.bag_weight_kg ? `كيس ${p.bag_weight_kg} كجم` : p.unit === 'ton' ? 'سائب بالطن' : `البيع بال${unitName(p.unit)}`);
function productCard(p) {
  const [avTxt, avCls] = AV[p.availability];
  const qc = qtyControl(p);
  return h('article', { class: 'card' },
    h('a', { class: 'img', href: '#/p/' + p.id, 'aria-label': p.name }, p.image ? h('img', { src: p.image, alt: p.name, loading: 'lazy' }) : bagSvg(),
      p.discount_percent > 0 ? h('span', { class: 'badge offer' }, `خصم ${p.discount_percent}%`) : null),
    h('div', { class: 'body' },
      h('div', { class: 'fac' }, p.factory_name),
      h('h3', {}, h('a', { href: '#/p/' + p.id }, p.name)),
      h('div', { class: 'spec' }, [p.category_name, p.cement_type, unitLine(p)].filter(Boolean).join(' • ')),
      priceBlock(p),
      p.offer_note ? h('div', { class: 'spec' }, p.offer_note) : null,
      h('div', {}, h('span', { class: 'badge ' + avCls }, avTxt), canBuy(p) ? h('span', { class: 'spec' }, ` المتوفر: ${qtyText(p.available, p.unit)}`) : null),
      h('div', { class: 'buy' }, canBuy(p) ? [qc.el, h('button', { class: 'btn', onclick: () => addToCart(p, qc.get()) }, 'أضف إلى السلة')] : h('a', { class: 'btn alt', href: '#/wholesale/' + p.id }, 'اطلب بالجملة'))));
}

/* ---------- الصفحة الرئيسية ---------- */
let gridBox;
function renderGrid() {
  if (!gridBox || !cat) return;
  const t = q.trim().toLowerCase();
  const list = cat.products.filter((p) => (!facId || p.factory_id === facId) && (!catId || p.category_id === catId) && (!offersOnly || p.discount_percent > 0)
    && (!t || `${p.name} ${p.factory_name} ${p.category_name || ''} ${p.cement_type || ''} ${p.spec || ''}`.toLowerCase().includes(t)));
  gridBox.replaceChildren(...(list.length ? list.map(productCard) : [h('div', { class: 'empty', style: 'grid-column:1/-1' }, cat.products.length ? 'لا توجد منتجات مطابقة لبحثك.' : 'لم تتم إضافة منتجات بعد. تواصل معنا عبر واتساب للاستفسار.')]));
}
async function viewHome() {
  await loadCatalog();
  const chips = h('div', { class: 'chips' }), catChips = h('div', { class: 'chips' });
  const drawChips = () => {
    const usedCats = new Set(cat.products.map((p) => p.category_id));
    catChips.replaceChildren(cat.categories.filter((c) => usedCats.has(c.id)).length ? [
      h('button', { class: 'chip' + (!catId ? ' on' : ''), onclick: () => { catId = 0; drawChips(); renderGrid(); } }, 'كل التصنيفات'),
      ...cat.categories.filter((c) => usedCats.has(c.id)).map((c) => h('button', { class: 'chip' + (catId === c.id ? ' on' : ''), onclick: () => { catId = catId === c.id ? 0 : c.id; drawChips(); renderGrid(); } }, c.name))] : null);
    chips.replaceChildren(
      h('button', { class: 'chip' + (!facId && !offersOnly ? ' on' : ''), onclick: () => { facId = 0; offersOnly = false; drawChips(); renderGrid(); } }, 'كل المصانع والعلامات'),
      cat.products.some((p) => p.discount_percent > 0) ? h('button', { class: 'chip' + (offersOnly ? ' on' : ''), onclick: () => { offersOnly = !offersOnly; drawChips(); renderGrid(); } }, 'العروض') : null,
      ...cat.factories.map((f) => h('button', { class: 'chip' + (facId === f.id ? ' on' : ''), onclick: () => { facId = facId === f.id ? 0 : f.id; drawChips(); renderGrid(); } }, f.name)));
  };
  drawChips();
  gridBox = h('div', { class: 'grid' });
  const s = cat.store;
  const stack = h('div', { class: 'stack', 'aria-hidden': 'true', html: '<svg viewBox="0 0 260 190" xmlns="http://www.w3.org/2000/svg"><g stroke="#123221" stroke-width="3"><rect x="14" y="120" width="104" height="58" rx="8" fill="#efe6d2"/><rect x="126" y="120" width="104" height="58" rx="8" fill="#efe6d2"/><rect x="70" y="66" width="104" height="58" rx="8" fill="#efe6d2"/><rect x="14" y="140" width="104" height="16" fill="#2c6a49"/><rect x="126" y="140" width="104" height="16" fill="#2c6a49"/><rect x="70" y="86" width="104" height="16" fill="#2c6a49"/></g></svg>' });
  const bags = fmt(Number(s.wholesale_min_bags) || 200);
  const goProducts = (e) => { e.preventDefault(); document.getElementById('products').scrollIntoView({ behavior: 'smooth' }); };
  const tier = (cls, title, who, text, cta) => h('div', { class: 'tier ' + cls }, h('div', { class: 'tier-h' }, h('b', {}, title), h('span', { class: 'tier-who' }, who)), h('p', {}, text), cta);
  mount([
    h('section', { class: 'hero' }, h('div', { class: 'wrap' },
      h('div', {},
        s.agent_note ? h('div', { class: 'agent' }, '✔ ' + s.agent_note) : null,
        h('h1', {}, 'توريد الأسمنت للمقاولين وتجار الجملة'),
        h('p', {}, 'أسعار التجزئة معلنة أمامك مباشرة. وللمشاريع والتجار نرسل عرض سعر خاصًا بحسب الكمية: جملة للمقاولين، وجملة الجملة للحمولات الكاملة.'),
        h('div', { class: 'btns' },
          h('a', { class: 'btn', href: '#products', onclick: goProducts }, 'تصفح المنتجات'),
          h('a', { class: 'btn alt', href: '#/wholesale', onclick: () => { wsPreType = ''; } }, 'اطلب عرض سعر جملة'),
          s.whatsapp ? h('a', { class: 'btn alt', href: waLink(s.whatsapp), target: '_blank', rel: 'noopener' }, 'واتساب') : null)),
      stack)),
    h('div', { class: 'wrap' }, h('div', { class: 'tiers' },
      tier('r', 'تجزئة', 'للأفراد وأصحاب البيوت', 'الأسعار معلنة في المنتجات. اختر الكمية واطلب، ثم استلم من المستودع أو نوصّل إليك.', h('a', { class: 'btn small alt', href: '#products', onclick: goProducts }, 'تصفح المنتجات')),
      tier('w', 'جملة', 'للمقاولين والمشاريع', `من ${bags} كيس. أرسل الكميات التي يحتاجها مشروعك ونرسل لك عرض سعر خاصًا قبل اعتماد الطلب.`, h('a', { class: 'btn small', href: '#/wholesale', onclick: () => { wsPreType = 'contractor'; } }, 'اطلب عرض سعر')),
      tier('b', 'جملة الجملة', 'لتجار الأسمنت والموزّعين', 'للحمولات الكاملة وبالأطنان. عرض سعر مباشر حسب الكمية والمصنع، وتنسيق للاستلام أو النقل.', h('a', { class: 'btn small', href: '#/wholesale', onclick: () => { wsPreType = 'trader'; } }, 'اطلب عرض تاجر')))),
    h('div', { class: 'wrap', id: 'products' }, catChips, chips, gridBox),
    h('div', { class: 'wrap' }, h('div', { class: 'trust' },
      h('div', {}, 'استلام من المستودع أو توصيل إلى موقعك'),
      h('div', {}, 'الدفع نقدًا عند الاستلام أو بالتحويل'),
      h('div', {}, 'تابع طلبك برقم الطلب في أي وقت'))),
  ], 'home');
  renderGrid();
  if (!cat.products.length) return;
}

/* ---------- صفحة المنتج ---------- */
async function viewProduct(id) {
  await loadCatalog();
  const p = prod(id);
  if (!p) return mount(h('div', { class: 'wrap' }, h('div', { class: 'panel empty' }, 'المنتج غير موجود أو لم يعد متاحًا.', h('p', {}, h('a', { class: 'btn', href: '#/' }, 'العودة للمنتجات')))), 'home');
  const [avTxt, avCls] = AV[p.availability], qc = qtyControl(p);
  mount(h('div', { class: 'wrap' }, h('div', { class: 'panel' },
    h('div', { class: 'card', style: 'border:0;background:none' }, h('div', { class: 'img', style: 'border-radius:10px;max-height:340px' }, p.image ? h('img', { src: p.image, alt: p.name }) : bagSvg())),
    h('div', { class: 'fac' }, p.factory_name), h('h2', { style: 'font-size:24px' }, p.name),
    priceBlock(p), p.offer_note ? h('div', { class: 'notice' }, p.offer_note) : null,
    h('div', { class: 'row' }, h('span', {}, 'النوع'), h('span', {}, p.cement_type || '—')),
    h('div', { class: 'row' }, h('span', {}, 'وحدة البيع'), h('span', {}, unitLine(p))),
    p.spec ? h('div', { class: 'row' }, h('span', {}, 'المواصفات'), h('span', {}, p.spec)) : null,
    h('div', { class: 'row' }, h('span', {}, 'الحد الأدنى للطلب'), h('span', {}, qtyText(p.min_order, p.unit))),
    h('div', { class: 'row' }, h('span', {}, 'التوفر'), h('span', {}, h('span', { class: 'badge ' + avCls }, avTxt), canBuy(p) ? ` ${qtyText(p.available, p.unit)}` : '')),
    h('div', { class: 'buy', style: 'margin-top:12px' }, canBuy(p) ? [qc.el, h('button', { class: 'btn', onclick: () => addToCart(p, qc.get()) }, 'أضف إلى السلة')] : null),
    h('p', {}, h('a', { class: 'btn alt', href: '#/wholesale/' + p.id }, 'اطلب بالجملة'), ' ', h('a', { class: 'btn alt', href: '#/' }, 'كل المنتجات')),
  )), 'home');
}

/* ---------- السلة ---------- */
async function viewCart() {
  await loadCatalog();
  let cart = getCart().filter((c) => prod(c.id));
  setCart(cart);
  const box = h('div', { class: 'wrap' });
  mount(box, 'cart');
  if (!cart.length) { box.append(h('div', { class: 'panel empty' }, h('p', {}, 'سلتك فارغة.'), h('a', { class: 'btn', href: '#/' }, 'تصفح المنتجات'))); return; }
  let r;
  try { r = await api('POST', '/api/quote', { items: cart.map((c) => ({ productId: c.id, qty: c.qty })) }); }
  catch (e) { box.append(errorView(e)); return; }
  const changed = r.lines.filter((l) => { const c = cart.find((x) => x.id === l.product_id); return c && c.seen !== undefined && c.seen !== l.unit_price; });
  const lines = r.lines.map((l) => {
    const p = prod(l.product_id), c = cart.find((x) => x.id === l.product_id), qc = qtyControl(p, c.qty);
    const upd = () => { const all = getCart(); all.find((x) => x.id === p.id).qty = qc.get(); setCart(all); viewCart(); };
    qc.input.addEventListener('change', upd); qc.input.addEventListener('qty', upd);
    return h('div', { class: 'line' }, h('div', {}, h('div', { class: 'nm' }, l.name), h('div', { class: 'spec' }, `${money(l.unit_price)} / ${unitName(l.unit)}`), qc.el),
      h('div', { style: 'text-align:end' }, h('div', { class: 'price' }, money(l.line_total)), h('button', { class: 'btn small alt', onclick: () => { setCart(getCart().filter((x) => x.id !== l.product_id)); viewCart(); } }, 'حذف')));
  });
  box.append(
    h('h2', { class: 'sec' }, 'سلة المشتريات'),
    changed.length ? h('div', { class: 'notice warn' }, 'تغيّر سعر: ' + changed.map((l) => l.name).join('، ') + '. الأسعار المعروضة هنا هي الأسعار الحالية.', ' ', h('button', { class: 'btn small', onclick: () => { setCart(getCart().map((c) => ({ ...c, seen: r.lines.find((l) => l.product_id === c.id)?.unit_price }))); viewCart(); } }, 'موافق')) : null,
    r.problems.length ? h('div', { class: 'notice bad' }, r.problems.map((x) => h('div', {}, x.message))) : null,
    h('div', { class: 'panel' }, lines,
      r.discount > 0 ? h('div', { class: 'row' }, h('span', {}, 'إجمالي الخصومات (محسوب في الأسعار)'), h('span', {}, money(r.discount))) : null,
      h('div', { class: 'row' }, h('span', {}, 'أجرة التوصيل'), h('span', {}, 'تحددها الإدارة عند اختيار التوصيل')),
      h('div', { class: 'row total' }, h('span', {}, 'الإجمالي التقديري'), h('span', {}, money(r.items_total)))),
    h('div', { class: 'btns' }, h('a', { class: 'btn' + (r.problems.length || changed.length ? ' disabled' : ''), href: r.problems.length || changed.length ? '#/cart' : '#/checkout', 'aria-disabled': r.problems.length ? 'true' : null }, 'متابعة إتمام الطلب'), h('a', { class: 'btn alt', href: '#/' }, 'متابعة التسوق')));
}

/* ---------- إتمام الطلب ---------- */
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)) + '-key';
function customerFields(saved, zones, state) {
  const name = h('input', { name: 'name', required: true, autocomplete: 'name', value: saved.name || '', maxlength: 80 });
  const phone = h('input', { name: 'phone', required: true, type: 'tel', inputmode: 'tel', autocomplete: 'tel', value: saved.phone || '', placeholder: '7XXXXXXXX', dir: 'ltr', style: 'text-align:right' });
  const zoneSel = h('select', { name: 'zone' }, h('option', { value: '' }, 'اختر المحافظة / المنطقة'), zones.map((z) => h('option', { value: z.name }, z.name)), h('option', { value: '__other' }, 'منطقة أخرى'));
  const zoneOther = h('input', { name: 'zoneOther', placeholder: 'اكتب اسم المنطقة', hidden: true, maxlength: 80 });
  const address = h('textarea', { name: 'address', placeholder: 'المديرية، الحي، أقرب معلم، رقم تواصل للسائق', maxlength: 300 });
  const pickupReq = h('input', { name: 'pickupRequest', placeholder: 'مثال: غدًا بعد العصر (اختياري)', maxlength: 100 });
  const delivery = h('div', {}, field('المحافظة أو المنطقة', zoneSel), zoneOther, field('العنوان التفصيلي', address));
  const pickup = h('div', { hidden: true }, h('div', { class: 'notice' }, h('b', {}, cat.store.warehouse_name), h('div', {}, cat.store.warehouse_address), h('div', {}, cat.store.warehouse_hours), h('div', {}, 'لا تُحسب أجرة توصيل. تؤكد الإدارة موعد الاستلام بعد مراجعة الطلب.')), field('موعد الاستلام المقترح', pickupReq));
  const radios = h('div', { class: 'choice' },
    h('label', {}, h('input', { type: 'radio', name: 'fulfillment', value: 'delivery', checked: true }), 'التوصيل إلى عنواني'),
    h('label', {}, h('input', { type: 'radio', name: 'fulfillment', value: 'pickup' }), 'الاستلام من المستودع'));
  const sync = () => { const d = radios.querySelector('input:checked').value === 'delivery'; delivery.hidden = !d; pickup.hidden = d; state.fulfillment = d ? 'delivery' : 'pickup'; };
  radios.addEventListener('change', sync);
  zoneSel.addEventListener('change', () => { zoneOther.hidden = zoneSel.value !== '__other'; state.zone = zoneSel.value; state.onZone?.(); });
  const get = () => {
    const fulfillment = radios.querySelector('input:checked').value;
    const region = fulfillment === 'pickup' ? 'استلام من المستودع - مأرب' : zoneSel.value === '__other' ? zoneOther.value.trim() : zoneSel.value;
    return { name: name.value.trim(), phone: phone.value.trim(), fulfillment, region, address: fulfillment === 'delivery' ? address.value.trim() : '', pickupRequest: pickupReq.value.trim() };
  };
  return { el: h('div', {}, field('الاسم', name), field('رقم الهاتف', phone), h('div', { class: 'lbl', style: 'font-weight:700' }, 'طريقة الاستلام'), radios, delivery, pickup), get };
}

async function viewCheckout() {
  await loadCatalog();
  const cart = getCart().filter((c) => prod(c.id));
  if (!cart.length) { location.hash = '#/cart'; return; }
  const box = h('div', { class: 'wrap' });
  mount(box, 'cart');
  let r;
  try { r = await api('POST', '/api/quote', { items: cart.map((c) => ({ productId: c.id, qty: c.qty })) }); } catch (e) { box.append(errorView(e)); return; }
  if (r.problems.length) { box.append(h('div', { class: 'notice bad' }, r.problems.map((x) => h('div', {}, x.message))), h('a', { class: 'btn', href: '#/cart' }, 'العودة للسلة')); return; }
  const saved = jget('cw_cust', {}), st = { fulfillment: 'delivery' };
  const cf = customerFields(saved, cat.zones, st);
  const notes = h('textarea', { placeholder: 'أي تعليمات للتسليم أو ملاحظات (اختياري)', maxlength: 500 });
  const pay = h('div', { class: 'choice' },
    h('label', {}, h('input', { type: 'radio', name: 'pay', value: 'cash', checked: true }), 'الدفع نقدًا عند الاستلام'),
    h('label', {}, h('input', { type: 'radio', name: 'pay', value: 'transfer' }), 'تحويل (ترسل رقم العملية بعد التأكيد)'));
  const feeNote = h('div', { class: 'row' }); const summary = h('div', { class: 'panel' }); const msg = h('div');
  const draw = () => {
    const del = st.fulfillment === 'delivery', z = cat.zones.find((x) => x.name === st.zone);
    feeNote.replaceChildren(h('span', {}, 'أجرة التوصيل'), h('span', {}, del ? (z?.indicative_fee ? `تقديرية ${money(z.indicative_fee)} — تؤكدها الإدارة` : 'تحددها الإدارة قبل التأكيد النهائي') : 'لا توجد (استلام من المستودع)'));
    summary.replaceChildren(h('h2', {}, 'ملخص الطلب'),
      ...r.lines.map((l) => h('div', { class: 'row' }, h('span', {}, `${l.name} × ${qtyText(l.qty, l.unit)}`), h('span', {}, money(l.line_total)))),
      r.discount > 0 ? h('div', { class: 'row' }, h('span', {}, 'الخصم (محسوب في الأسعار)'), h('span', {}, money(r.discount))) : null, feeNote,
      h('div', { class: 'row total' }, h('span', {}, del ? 'الإجمالي قبل أجرة النقل' : 'الإجمالي'), h('span', {}, money(r.items_total))),
      del ? h('small', { class: 'hint' }, 'لن يُعتمد الطلب قبل أن ترسل لك الإدارة السعر النهائي شاملًا النقل وتوافق عليه.') : null);
  };
  st.onZone = draw; cf.el.addEventListener('change', draw); draw();
  const btn = h('button', { class: 'btn', type: 'submit' }, 'إرسال الطلب');
  const form = h('form', { novalidate: true }, h('div', { class: 'panel' }, h('h2', {}, 'بيانات الطلب'), cf.el,
    h('div', { class: 'lbl', style: 'font-weight:700;margin-top:8px' }, 'طريقة الدفع'), pay, field('ملاحظات', notes)), summary, msg, privacyLine(), btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!navigator.onLine) { msg.replaceChildren(h('div', { class: 'notice bad' }, 'لا يوجد اتصال بالإنترنت. لا يمكن إرسال الطلب الآن.')); return; }
    const c = cf.get();
    if (c.name.length < 2) return fail('أدخل الاسم');
    if (c.phone.replace(/\D/g, '').length < 9) return fail('أدخل رقم هاتف صحيحًا');
    if (c.fulfillment === 'delivery' && (!c.region || c.address.length < 5)) return fail('اختر المنطقة وأدخل العنوان التفصيلي');
    function fail(t) { msg.replaceChildren(h('div', { class: 'notice bad' }, t)); }
    btn.disabled = true; btn.textContent = 'جارٍ إرسال الطلب…'; msg.replaceChildren();
    let key = sessionStorage.getItem('cw_idem'); if (!key) { key = newKey(); sessionStorage.setItem('cw_idem', key); }
    try {
      const res = await api('POST', '/api/orders', { ...c, notes: notes.value, paymentMethod: pay.querySelector('input:checked').value, items: cart.map((x) => ({ productId: x.id, qty: x.qty })), expectedTotal: r.items_total, idempotencyKey: key });
      jset('cw_cust', { name: c.name, phone: c.phone });
      const mine = jget('cw_orders', []); mine.unshift({ number: res.number, token: res.token, at: new Date().toISOString() }); jset('cw_orders', mine.slice(0, 30));
      setCart([]); sessionStorage.removeItem('cw_idem');
      location.hash = '#/track/' + res.token + '?new=1';
    } catch (err) {
      btn.disabled = false; btn.textContent = 'إرسال الطلب';
      if (err.data?.priceChanged) { r = { ...r, lines: err.data.lines, items_total: err.data.items_total }; draw(); }
      msg.replaceChildren(h('div', { class: 'notice bad' }, err.message));
    }
  });
  box.append(h('h2', { class: 'sec' }, 'إتمام الطلب'), form);
}

/* ---------- طلب تسعير بالجملة ---------- */
async function viewWholesale(preId) {
  await loadCatalog();
  const box = h('div', { class: 'wrap' }); mount(box, 'wholesale');
  const list = cat.products;
  if (!list.length) { box.append(h('div', { class: 'panel empty' }, 'لا توجد منتجات متاحة حاليًا. تواصل معنا عبر واتساب.')); return; }
  const rows = []; const rowsBox = h('div');
  const addRow = (pid) => {
    const sel = h('select', {}, list.map((p) => h('option', { value: p.id }, `${p.factory_name} - ${p.name} (${unitName(p.unit)})`)));
    if (pid) sel.value = pid;
    const qty = h('input', { type: 'number', min: '1', step: 'any', inputmode: 'decimal', placeholder: 'الكمية' });
    const hint = h('small', { class: 'hint' });
    const upd = () => { const p = prod(sel.value || list[0].id); hint.textContent = `الحد الأدنى للجملة: ${qtyText(p.wholesale_min, p.unit)}`; };
    sel.addEventListener('change', upd); upd();
    const row = { sel, qty, el: h('div', { class: 'panel' }, field('المنتج', sel), field('الكمية المطلوبة', qty, null), hint, h('button', { type: 'button', class: 'btn small alt', onclick: () => { if (rows.length > 1) { rows.splice(rows.indexOf(row), 1); row.el.remove(); } } }, 'حذف الصنف')) };
    rows.push(row); rowsBox.append(row.el);
  };
  addRow(preId);
  const saved = jget('cw_cust', {}), st = { fulfillment: 'delivery' }, cf = customerFields(saved, cat.zones, st);
  const notes = h('textarea', { maxlength: 450, placeholder: 'ملاحظات أو موعد مطلوب (اختياري)' });
  const typeSel = h('select', { name: 'custType' }, CUST_TYPES.map(([v, t]) => h('option', { value: v }, t)));
  typeSel.value = wsPreType || 'contractor';
  const msg = h('div'), btn = h('button', { class: 'btn', type: 'submit' }, 'إرسال طلب التسعير');
  const form = h('form', { novalidate: true }, rowsBox, h('button', { type: 'button', class: 'btn alt', onclick: () => addRow() }, '+ إضافة صنف آخر'),
    h('div', { class: 'panel' }, h('h2', {}, 'بياناتك'), field('نوع الطلب', typeSel), cf.el, field('ملاحظات', notes)), msg, privacyLine(), btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = cf.get();
    const items = rows.map((r) => ({ productId: Number(r.sel.value), qty: Number(r.qty.value) }));
    const fail = (t) => msg.replaceChildren(h('div', { class: 'notice bad' }, t));
    if (items.some((i) => !(i.qty > 0))) return fail('أدخل الكمية لكل صنف');
    if (c.name.length < 2) return fail('أدخل الاسم');
    if (c.phone.replace(/\D/g, '').length < 9) return fail('أدخل رقم هاتف صحيحًا');
    if (c.fulfillment === 'delivery' && (!c.region || c.address.length < 5)) return fail('اختر المنطقة وأدخل العنوان التفصيلي');
    if (!navigator.onLine) return fail('لا يوجد اتصال بالإنترنت.');
    btn.disabled = true; btn.textContent = 'جارٍ الإرسال…'; msg.replaceChildren();
    let key = sessionStorage.getItem('cw_idem_w'); if (!key) { key = newKey(); sessionStorage.setItem('cw_idem_w', key); }
    try {
      const res = await api('POST', '/api/wholesale-requests', { ...c, notes: custNote(typeSel.value, notes.value), items, idempotencyKey: key });
      jset('cw_cust', { name: c.name, phone: c.phone });
      const mine = jget('cw_orders', []); mine.unshift({ number: res.number, token: res.token, at: new Date().toISOString() }); jset('cw_orders', mine.slice(0, 30));
      sessionStorage.removeItem('cw_idem_w');
      location.hash = '#/track/' + res.token + '?new=1';
    } catch (err) { btn.disabled = false; btn.textContent = 'إرسال طلب التسعير'; msg.replaceChildren(h('div', { class: 'notice bad' }, err.message)); }
  });
  box.append(h('h2', { class: 'sec' }, 'طلب كمية بالجملة'), h('div', { class: 'notice' }, h('b', {}, 'للمقاولين وتجار الأسمنت (جملة وجملة الجملة). '), 'أسعار الجملة لا تُعرض عامة. أرسل المصنع والنوع والكمية، وسنرسل لك عرض سعر خاصًا للموافقة عليه قبل اعتماد الطلب.'), form);
}

/* ---------- متابعة الطلب ---------- */
const FLOW_RETAIL = ['new', 'under_review', 'quote_sent', 'confirmed', 'preparing'];
async function viewTrack(token, isNew) {
  const box = h('div', { class: 'wrap' }); mount(box, 'orders');
  let o;
  const load = async () => { o = await api('GET', '/api/track/' + token); };
  try { await load(); } catch (e) { box.append(errorView(e)); return; }
  const mine = jget('cw_orders', []);
  if (!mine.some((x) => x.token === token)) { mine.unshift({ number: o.number, token, at: o.created_at }); jset('cw_orders', mine.slice(0, 30)); }
  const link = location.origin + '/#/track/' + token;
  const act = async (action, body) => { try { o = await api('POST', `/api/track/${token}/${action}`, body || {}); draw(); toast('تم تحديث الطلب'); } catch (e) { toast(e.message, true); } };
  const draw = () => {
    const ws = o.store;
    const refInput = h('input', { placeholder: 'رقم العملية أو اسم المرسل', maxlength: 100 });
    box.replaceChildren(
      isNew ? h('div', { class: 'notice' }, h('b', {}, 'تم استلام طلبك!'), h('div', {}, 'رقم الطلب: ', h('b', {}, o.number)), h('div', {}, 'احفظ هذه الصفحة أو الرابط لمتابعة الطلب في أي وقت. لا يطّلع عليه غيرك.')) : null,
      h('div', { class: 'panel' }, h('h2', {}, `${o.doc_kind} ${o.number}`), h('span', { class: 'status' + (o.status === 'cancelled' ? ' cancelled' : '') }, o.status_label),
        o.type === 'wholesale' ? h('span', { class: 'badge', style: 'margin-inline-start:6px' }, 'طلب جملة') : null,
        o.cancel_reason ? h('p', {}, 'السبب: ', o.cancel_reason) : null,
        o.scheduled_at ? h('div', { class: 'notice' }, `موعد ${o.fulfillment === 'pickup' ? 'الاستلام' : 'التسليم'}: `, h('b', {}, o.scheduled_at.replace('T', ' '))) : null,
        o.warehouse ? h('div', { class: 'notice' }, h('b', {}, o.warehouse.name), h('div', {}, o.warehouse.address), h('div', {}, o.warehouse.hours)) : null,
        o.driver ? h('div', { class: 'notice' }, 'الناقل/السائق: ', h('b', {}, o.driver.name || ''), o.driver.phone ? h('span', { dir: 'ltr' }, ' ' + o.driver.phone) : null) : null,
        o.fulfillment === 'delivery' && o.fee_pending && o.status !== 'cancelled' ? h('div', { class: 'notice warn' }, 'أجرة النقل لم تُحدَّد بعد. ستحددها الإدارة حسب الموقع والكمية وتصلك مع عرض السعر.') : null,
        o.type === 'wholesale' && o.total === null && o.status !== 'cancelled' ? h('div', { class: 'notice warn' }, 'طلبك قيد التسعير. سنرسل لك عرض سعر الجملة هنا وعلى هاتفك.') : null,
        o.quote_note ? h('div', { class: 'notice' }, 'ملاحظة الإدارة: ', o.quote_note) : null),
      h('div', { class: 'panel' }, h('h2', {}, 'المنتجات'),
        ...o.items.map((i) => h('div', { class: 'row' }, h('span', {}, `${i.name} × ${qtyText(i.qty, i.unit)}`), h('span', {}, i.unit_price === null ? 'بانتظار التسعير' : money(i.line_total)))),
        o.discount > 0 ? h('div', { class: 'row' }, h('span', {}, 'خصم (محسوب في الأسعار)'), h('span', {}, money(o.discount))) : null,
        o.fulfillment === 'delivery' ? h('div', { class: 'row' }, h('span', {}, 'أجرة النقل'), h('span', {}, o.delivery_fee === null ? 'تحددها الإدارة' : money(o.delivery_fee))) : null,
        h('div', { class: 'row total' }, h('span', {}, 'الإجمالي'), h('span', {}, o.total === null ? (o.total_before_fee !== null ? `${money(o.total_before_fee)} + النقل` : 'يُحدَّد بعد التسعير') : money(o.total))),
        o.paid > 0 ? h('div', { class: 'row' }, h('span', {}, 'المدفوع'), h('span', {}, money(o.paid))) : null,
        o.remaining !== null && o.paid > 0 ? h('div', { class: 'row' }, h('span', {}, 'المتبقي'), h('span', {}, money(o.remaining))) : null,
        h('div', { class: 'row' }, h('span', {}, 'الدفع'), h('span', {}, ({ unpaid: 'لم يُسدَّد', pending_verification: 'بانتظار التحقق', partial: 'مدفوع جزئيًا', paid: 'مدفوع بالكامل' })[o.payment_status] + (o.payment_method === 'transfer' ? ' (تحويل)' : ' (نقدًا)')))),
      o.can_respond ? h('div', { class: 'panel' }, h('h2', {}, 'عرض السعر بانتظار موافقتك'), h('p', {}, `الإجمالي النهائي ${money(o.total)}. عند الموافقة تُحجز لك الكمية.`),
        h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { if (confirm('تأكيد الموافقة على عرض السعر؟')) act('approve'); } }, 'أوافق على العرض'),
          h('button', { class: 'btn alt', onclick: () => { const r = prompt('سبب الرفض (اختياري)'); if (r !== null) act('reject', { reason: r }); } }, 'أرفض العرض'))) : null,
      o.can_submit_transfer && !o.can_respond && o.status !== 'cancelled' ? h('div', { class: 'panel' }, h('h2', {}, 'إثبات التحويل'), h('div', { class: 'notice' }, o.bank_note || ''),
        o.transfer_ref ? h('p', {}, 'تم إرسال: ', h('b', {}, o.transfer_ref), ' — بانتظار تحقق الإدارة.') : null,
        field('رقم العملية', refInput), h('button', { class: 'btn', onclick: () => refInput.value.trim().length >= 3 ? act('transfer', { ref: refInput.value }) : toast('أدخل رقم العملية', true) }, 'إرسال')) : null,
      h('div', { class: 'panel' }, h('h2', {}, 'سجل الطلب'), h('ul', { class: 'steps' }, o.events.map((e) => h('li', {}, h('b', {}, e.status_label || ''), e.note ? h('div', {}, e.note) : null, h('small', {}, dt(e.at)))))),
      h('div', { class: 'btns' },
        h('a', { class: 'btn alt', href: '/invoice?t=' + token, target: '_blank', rel: 'noopener' }, 'عرض / طباعة المستند'),
        h('button', { class: 'btn alt', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('تم نسخ رابط المتابعة'); } catch { prompt('انسخ الرابط', link); } } }, 'نسخ رابط المتابعة'),
        ws.whatsapp ? h('a', { class: 'btn wa', href: waLink(ws.whatsapp, `السلام عليكم، بخصوص الطلب رقم ${o.number}`), target: '_blank', rel: 'noopener' }, 'تواصل واتساب') : null));
  };
  draw();
  pollTimer = setInterval(async () => { if (document.hidden) return; try { const before = o.status + o.updated_at; await load(); if (o.status + o.updated_at !== before) draw(); } catch { /* ignore */ } }, 30000);
}

/* ---------- طلباتي / اتصل بنا ---------- */
async function viewOrders() {
  await loadCatalog().catch(() => {});
  const mine = jget('cw_orders', []);
  mount(h('div', { class: 'wrap' }, h('h2', { class: 'sec' }, 'طلباتي'),
    mine.length ? h('div', { class: 'panel' }, mine.map((x) => h('div', { class: 'row' }, h('a', { href: '#/track/' + x.token }, x.number), h('small', {}, dt(x.at)))))
      : h('div', { class: 'panel empty' }, 'لا توجد طلبات محفوظة على هذا الجهاز. إن كان لديك رابط متابعة، افتحه مباشرة.'),
    h('div', { class: 'notice' }, 'تُحفظ هذه القائمة على جهازك فقط.')), 'orders');
}
function mapPanel(s) {
  const lat = Number(s.map_lat), lng = Number(s.map_lng);
  if (!s.map_lat || !s.map_lng || !isFinite(lat) || !isFinite(lng)) return null;
  const exact = !(s.map_lat === '15.4606' && s.map_lng === '45.3261');   // القيم الافتراضية = مركز مدينة مأرب (تقريبي)
  const d = exact ? 0.006 : 0.05;
  const embed = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d * 1.6},${lat - d},${lng + d * 1.6},${lat + d}&layer=mapnik&marker=${lat},${lng}`;
  const holder = h('div', { class: 'mapbox' });
  holder.append(h('div', { class: 'mapph' },
    h('p', {}, h('b', {}, exact ? (s.warehouse_name || 'موقع المتجر') : 'موقعنا: مدينة مأرب')),
    h('button', { class: 'btn', type: 'button', onclick: () => holder.replaceChildren(h('iframe', { src: embed, title: 'خريطة موقع المتجر', loading: 'lazy', referrerpolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin' })) }, 'اعرض الخريطة'),
    h('small', { class: 'hint' }, 'لتوفير باقة الإنترنت لا تُحمَّل الخريطة إلا عند الضغط.')));
  return h('div', { class: 'panel' }, h('h2', {}, 'الموقع على الخريطة'), holder,
    exact ? null : h('div', { class: 'notice warn' }, 'الموقع الموضّح تقريبي لمدينة مأرب. للوصول إلى المستودع تواصل معنا.'),
    h('div', { class: 'btns' },
      h('a', { class: 'btn alt', href: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, target: '_blank', rel: 'noopener' }, 'افتح في خرائط Google'),
      h('a', { class: 'btn alt', href: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`, target: '_blank', rel: 'noopener' }, 'الاتجاهات')));
}
async function viewContact() {
  await loadCatalog();
  const s = cat.store;
  mount(h('div', { class: 'wrap' }, h('h2', { class: 'sec' }, 'عن المتجر وطرق التواصل'),
    h('div', { class: 'panel' }, h('h2', {}, s.store_name),
      s.agent_note ? h('p', {}, h('b', {}, s.agent_note)) : null,
      h('p', {}, 'نورّد الأسمنت ومواد البناء للأفراد (تجزئة)، وللمقاولين والمشاريع (جملة)، ولتجار الأسمنت والموزّعين (جملة الجملة)، مع الاستلام من المستودع أو التوصيل.'),
      h('div', { class: 'row' }, h('span', {}, 'الموقع'), h('span', {}, s.city)),
      h('div', { class: 'row' }, h('span', {}, 'المستودع'), h('span', {}, s.warehouse_address)),
      h('div', { class: 'row' }, h('span', {}, 'ساعات العمل'), h('span', {}, s.warehouse_hours)),
      h('div', { class: 'row' }, h('span', {}, 'الهاتف'), h('a', { href: 'tel:' + s.phone, dir: 'ltr' }, s.phone)),
      h('p', {}, h('a', { class: 'btn wa', href: waLink(s.whatsapp), target: '_blank', rel: 'noopener' }, 'تواصل عبر واتساب'))),
    mapPanel(s),
    h('p', {}, h('a', { href: '#/privacy' }, 'سياسة الخصوصية'))), 'contact');
}

/* ---------- سياسة الخصوصية ---------- */
async function viewPrivacy() {
  await loadCatalog().catch(() => {});
  const s = cat?.store || {};
  const name = s.store_name || 'المتجر';
  const p = (...k) => h('p', {}, ...k);
  const ul = (...items) => h('ul', {}, items.map((x) => h('li', {}, x)));
  const sec = (t, ...kids) => [h('h2', {}, t), ...kids];
  mount(h('div', { class: 'wrap' }, h('div', { class: 'panel prose' },
    h('h1', { style: 'font-size:24px;margin:0 0 2px' }, 'سياسة الخصوصية'),
    h('small', { class: 'hint' }, 'آخر تحديث: نوفمبر 2026'),
    p(`نحترم خصوصيتك. توضح هذه الصفحة ما تجمعه ${name} من بيانات عند استخدامك المتجر، ولماذا، وكيف نحميها.`),
    sec('البيانات التي نجمعها', ul(
      'بيانات تكتبها بنفسك عند الطلب: الاسم ورقم الهاتف والمنطقة والعنوان التفصيلي (للتوصيل) وملاحظات الطلب وموعد الاستلام.',
      'تفاصيل طلبك: المنتجات والكميات والأسعار وطريقة الدفع ورقم عملية التحويل إن أرسلته.',
      'نوع العميل (مقاول أو تاجر أو غير ذلك) في طلبات الجملة.',
      'لا نطلب كلمات مرور من العملاء ولا بيانات بطاقات بنكية، ولا نجمع موقعك الجغرافي تلقائيًا.')),
    sec('كيف نستخدم بياناتك', ul(
      'استلام طلبك وتسعيره وتجهيزه وتوصيله أو تسليمه من المستودع.',
      'التواصل معك بالهاتف أو واتساب بخصوص السعر والتوصيل والدفع.',
      'إصدار مستند الطلب والفاتورة وتسجيل المدفوعات وإدارة المخزون.',
      'معالجة الاستفسارات والشكاوى وحفظ حقوق الطرفين.')),
    sec('ما يُحفظ على جهازك', p('يحفظ المتجر داخل متصفحك سلة المشتريات، واسمك ورقم هاتفك لتسهيل طلبك القادم، وروابط طلباتك السابقة لعرضها في «طلباتي». لا نستخدم ملفات تتبع إعلانية ولا أدوات تحليل خارجية. يمكنك مسح هذه البيانات في أي وقت من إعدادات المتصفح.')),
    sec('مشاركة البيانات', ul(
      'لا نبيع بياناتك ولا نشاركها لأغراض إعلانية.',
      'نُطلع السائق أو الناقل فقط على ما يلزم للتسليم (الاسم والهاتف والعنوان).',
      'نستخدم خدمات استضافة وقواعد بيانات سحابية لتشغيل المتجر وحفظ الطلبات، وهي تعالج البيانات لحسابنا.',
      'قد نُفصح عن بيانات إذا ألزمتنا بذلك جهة مختصة وفق القانون.')),
    sec('خدمات خارجية عند استخدامك لها', p('عند الضغط على أزرار واتساب أو الخريطة أو الاتجاهات تنتقل إلى خدمة طرف ثالث (واتساب، خرائط Google، OpenStreetMap) تخضع لسياستها هي. ولا تُحمَّل الخريطة داخل المتجر إلا عند ضغطك على «اعرض الخريطة».')),
    sec('مدة الاحتفاظ', p('نحتفظ بسجلات الطلبات والفواتير والمدفوعات للمدة اللازمة للمحاسبة وحل أي خلاف، وبعد ذلك نحذفها أو نزيل ارتباطها بك متى أمكن.')),
    sec('حماية بياناتك وحقوقك', ul(
      'تنتقل بياناتك بين جهازك والمتجر عبر اتصال مشفّر (HTTPS)، ويقتصر الدخول إلى بيانات العملاء على المصرّح لهم بحسابات محمية بكلمات مرور.',
      'لا يوجد نظام آمن بنسبة مئة بالمئة، لكننا نبذل جهدنا لحماية بياناتك.',
      'يمكنك طلب الاطلاع على بياناتك أو تصحيحها أو حذفها بالتواصل معنا، وقد نطلب رقم الطلب ورقم هاتفك للتحقق منك. وقد نحتفظ بما يلزم قانونًا أو محاسبيًا.')),
    sec('الأطفال', p('المتجر موجّه للبالغين وأصحاب الأعمال، ولا نجمع بيانات الأطفال عن قصد.')),
    sec('التغييرات والتواصل', p('قد نحدّث هذه السياسة، ويظهر تاريخ آخر تحديث في أعلاها. لأي استفسار عن خصوصيتك اتصل بنا على ', h('a', { href: 'tel:' + (s.phone || ''), dir: 'ltr' }, s.phone || ''), s.whatsapp ? ' أو عبر ' : null, s.whatsapp ? h('a', { href: waLink(s.whatsapp), target: '_blank', rel: 'noopener' }, 'واتساب') : null, '.')),
    h('p', {}, h('a', { class: 'btn alt', href: '#/' }, 'العودة للمتجر')))), 'home');
}

/* ---------- الموجّه ---------- */
async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [pathPart, qs] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  try {
    if (!parts.length) await viewHome();
    else if (parts[0] === 'p') await viewProduct(parts[1]);
    else if (parts[0] === 'cart') await viewCart();
    else if (parts[0] === 'checkout') await viewCheckout();
    else if (parts[0] === 'wholesale') await viewWholesale(parts[1]);
    else if (parts[0] === 'track') await viewTrack(parts[1], /new=1/.test(qs || ''));
    else if (parts[0] === 'orders') await viewOrders();
    else if (parts[0] === 'contact') await viewContact();
    else if (parts[0] === 'privacy') await viewPrivacy();
    else await viewHome();
  } catch (e) { app.replaceChildren(h('div', { class: 'wrap' }, errorView(e))); }
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
const offline = document.getElementById('offline');
const net = () => { offline.hidden = navigator.onLine; };
window.addEventListener('online', net); window.addEventListener('offline', net); net();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
route();
