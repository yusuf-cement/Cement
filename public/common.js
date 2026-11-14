// أدوات مشتركة للمتجر ولوحة الإدارة. كل النصوص القادمة من المستخدم تُعرض عبر textContent فقط (آمن من XSS).
// تجاهل القيم الفارغة (null/false) وتسطيح المصفوفات عند الإضافة، حتى لا يظهر النص "null" في الصفحة
if (typeof Element !== 'undefined') {
  for (const m of ['append', 'replaceChildren']) {
    const orig = Element.prototype[m];
    Element.prototype[m] = function (...a) { return orig.apply(this, a.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)); };
  }
}
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // للنصوص الثابتة الموثوقة فقط
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const add = (c) => {
    if (Array.isArray(c)) c.forEach(add);
    else if (c === false || c === null || c === undefined) return;
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}
export const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));
export const money = (n) => (n === null || n === undefined ? '—' : fmt(n) + ' ريال');
// وحدات البيع (تُحدَّث من الخادم عند تحميل الكتالوج)
export let UNITS = { bag: { name: 'كيس', int: true }, ton: { name: 'طن', int: false } };
export const setUnits = (u) => { if (u) UNITS = u; };
export const unitName = (u) => UNITS[u]?.name || u;
export const unitInt = (u) => !!UNITS[u]?.int;
export const qtyText = (q, u) => `${fmt(q)} ${unitName(u)}`;
export const dt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString('en-GB', { timeZone: 'Asia/Aden', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const waLink = (num, text) => `https://wa.me/${String(num).replace(/\D/g, '')}${text ? '?text=' + encodeURIComponent(text) : ''}`;
export const normPhone = (p) => {
  let d = String(p || '').replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 9 && d.startsWith('7')) d = '967' + d;
  return d;
};

export async function api(method, url, body, admin = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (admin) headers['X-Requested-With'] = 'cement';
  let res;
  try { res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); }
  catch { const e = new Error('تعذّر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.'); e.offline = true; throw e; }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) { const e = new Error((data && data.error) || 'حدث خطأ، حاول مرة أخرى'); e.status = res.status; e.data = data; throw e; }
  return data;
}

let toastTimer;
export function toast(msg, bad = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4200);
}

export const bagSvg = (cls = '') => h('div', {
  class: 'ph ' + cls, 'aria-hidden': 'true',
  html: '<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg"><path d="M26 30h68l-7-14H33z" fill="#fff"/><rect x="26" y="30" width="68" height="76" rx="9" fill="#efe6d2" stroke="#1d4a33" stroke-width="3"/><rect x="26" y="58" width="68" height="26" fill="#1d4a33"/><rect x="40" y="66" width="40" height="10" rx="2" fill="#efe6d2"/></svg>',
});

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}
