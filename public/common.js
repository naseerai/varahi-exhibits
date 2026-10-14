// Change the brand name shown across the site here (the logo images are /logo.png and /logo-white.png).
const BRAND = 'Kara by Varahi';

// Business details shown in the footer and on the Privacy / Terms / Refund pages.
// Payment gateways (Razorpay, Cashfree) require a working contact email and phone on these pages.
// Leave a value empty to hide that line.
const SITE = {
  legalName: 'Kara by Varahi',       // registered business name
  email: '',                          // e.g. support@yourdomain.com
  phone: '',                          // e.g. +91 98765 43210
  address: '',                        // registered address
  city: '',                           // for "courts of <city>" in the Terms, e.g. Hyderabad
  credit: 'sanjuanimations',          // "Designed & developed by …" in the footer
};

async function api(url, { method, body } = {}) {
  const res = await fetch(url, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
const amount = (n, currency = 'INR') => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
const money = (n, currency = 'INR') => (n === 0 ? 'Free' : amount(n, currency));   // prices: 0 shows as "Free"
const fmtDate = (s) => (s ? new Date(s).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const fmtDay = (s) => (s ? new Date(s).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const fmtTime = (s) => (s ? new Date(s).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '');
const dateParts = (s) => { const d = new Date(s); return { day: d.getDate(), mon: d.toLocaleString('en-IN', { month: 'short' }) }; };
const qs = (k) => new URLSearchParams(location.search).get(k);
// Clean page URLs (the server maps them to the HTML files): /events/12/event-name, /tickets/CODE, /payment/REF.
const slugify = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const pageUrl = {
  event: (id, title) => `/events/${encodeURIComponent(id)}${slugify(title) ? `/${slugify(title)}` : ""}`,
  ticket: (code) => `/tickets/${encodeURIComponent(code)}`,
  payment: (ref) => `/payment/${encodeURIComponent(ref)}`,
};
// Segment of the current path, e.g. pathPart(1) is "12" on /events/12/event-name.
const pathPart = (i) => decodeURIComponent(location.pathname.split("/").filter(Boolean)[i] || "");
const $ = (sel, root = document) => root.querySelector(sel);
const cssUrl = (u) => `url("${String(u).replace(/["\\\n]/g, encodeURIComponent)}")`;

// Inline SVG icons (Lucide-style strokes).
const ICONS = {
  ticket: '<path d="M3 9a3 3 0 0 0 0 6v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a3 3 0 0 0 0-6V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  rupee: '<path d="M6 3h12M6 8h12M6 13l8.5 8M6 13h3a5 5 0 0 0 0-10"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  crown: '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zM5 20h14"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c7 0 10 8 10 8a13 13 0 0 1-1.7 2.7M6.6 6.6A13 13 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  minus: '<path d="M5 12h14"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
// Both logo colours are included; CSS shows the white one on dark backgrounds.
const brandHTML = () => `<img class="brand-logo on-light" src="/logo.png" alt="${esc(BRAND)}" width="720" height="520"><img class="brand-logo on-dark" src="/logo-white.png" alt="" aria-hidden="true" width="720" height="520">`;

// Fill every element marked data-icon="name" and data-brand.
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, el.dataset.iconClass || '')); el.removeAttribute('data-icon'); });
  root.querySelectorAll('[data-brand]').forEach((el) => { el.innerHTML = brandHTML(); el.removeAttribute('data-brand'); });
  root.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });
}
document.addEventListener('DOMContentLoaded', () => hydrateIcons());

function showAlert(el, msg, type = 'error') {
  el.className = `alert ${type}`;
  el.innerHTML = `${icon(type === 'ok' ? 'check' : 'alert')}<span>${esc(msg)}</span>`;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function requireLogin(roles) {
  try {
    const me = await api('/api/me');
    if (roles && !roles.includes(me.role)) { location.href = me.role === 'staff' ? '/scan' : '/admin'; return null; }
    return me;
  } catch {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    return null;
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
}

// ----- customer account (mobile OTP login) -----
let customerPromise;
const getCustomer = () => (customerPromise ||= api('/api/customer/me').then((r) => r.customer).catch(() => null));
const signinUrl = (next = location.pathname + location.search) => `/signin?next=${encodeURIComponent(next)}`;
async function customerLogout() {
  await api('/api/customer/logout', { method: 'POST' }).catch(() => {});
  location.href = '/';
}
// ----- public site header -----
// Built here so every public page gets the same header:
// - desktop: "All events" / "My tickets" links, plus a "Sign in" button or an account chip with a drop-down
// - phones:  a menu button that opens a panel with the same links
document.addEventListener('DOMContentLoaded', async () => {
  const header = $('.site-header');
  const bar = header && $('.container', header);
  const nav = bar && $('nav', bar);
  if (!nav) return;

  const c = await getCustomer();
  const here = location.pathname;
  const firstName = c?.name ? c.name.trim().split(/\s+/)[0] : '';
  const abbr = (c?.name || '').trim().split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  // Desktop links
  const link = (href, label) => `<a class="nav-link ${here === href ? 'active' : ''}" href="${href}">${label}</a>`;
  nav.innerHTML = link('/', 'All events')
    + (c ? link('/account', 'My tickets')
      : here === '/signin' ? '' : `<a class="btn primary sm nav-signin" href="${esc(signinUrl())}">Sign in</a>`);

  // Menu button: a hamburger on phones; on desktop an account chip (signed in only).
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `menu-btn ${c ? 'signed-in' : 'guest'}`;
  btn.setAttribute('aria-label', 'Menu');
  btn.setAttribute('aria-expanded', 'false');
  // Every icon stays in the button and CSS shows the right one, so a tap never lands on an element that gets replaced.
  btn.innerHTML = `<span class="mb-burger">${icon('menu', 'when-closed')}${icon('x', 'when-open')}</span>`
    + (c ? `<span class="mb-chip"><span class="avatar">${firstName ? esc(abbr) : icon('user')}</span><span class="mb-name">${esc(firstName || 'Account')}</span><span class="chev" aria-hidden="true"></span></span>` : '');
  bar.appendChild(btn);

  const item = (href, ic, label, cls = '') => `<a class="menu-item ${cls} ${here === href ? 'active' : ''}" href="${href}">${icon(ic)}<span>${label}</span></a>`;
  const panel = document.createElement('div');
  panel.className = 'menu-panel';
  panel.hidden = true;
  panel.innerHTML = `
    ${c ? `<div class="menu-user"><span class="avatar">${firstName ? esc(abbr) : icon('user')}</span><div><b>${esc(c.name || 'Signed in')}</b><span>+91 ${esc(c.phone)}</span></div></div>` : ''}
    ${item('/', 'grid', 'All events', 'phone-only')}
    ${c ? `${item('/account', 'ticket', 'My tickets & account')}
           <a class="menu-item" href="#" data-action="customer-logout">${icon('logout')}<span>Sign out</span></a>`
        : here === '/signin' ? '' : `<a class="btn primary block menu-signin" href="${esc(signinUrl())}">Sign in with mobile OTP</a>`}`;
  bar.appendChild(panel);

  const setOpen = (open) => {
    panel.hidden = !open;
    header.classList.toggle('menu-open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => setOpen(panel.hidden));
  // Any tap outside the panel and button (including the dimmed page) closes the menu.
  document.addEventListener('click', (e) => {
    const path = e.composedPath();
    if (!panel.hidden && !path.includes(panel) && !path.includes(btn)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  panel.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
});

// ----- public site footer + business details -----
// Every <footer class="site-footer"> gets the policy links, copyright and credit.
// Elements marked data-site="email|phone|address|legalName|city" are filled from SITE;
// an element marked data-needs="email" (etc.) is hidden when that value is empty.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('footer.site-footer').forEach((f) => {
    f.innerHTML = `<div class="container footer-inner">
      <div class="footer-top">
        <span class="footer-logo" data-brand></span>
        <nav class="footer-links" aria-label="Policies">
          <a href="/">Events</a>
          <a href="/privacy-policy">Privacy Policy</a>
          <a href="/terms-and-conditions">Terms &amp; Conditions</a>
          <a href="/refund-policy">Refund Policy</a>
        </nav>
      </div>
      <div class="footer-bottom">
        <span>© ${new Date().getFullYear()} ${esc(SITE.legalName)}. All rights reserved.</span>
        ${SITE.email ? `<a href="mailto:${esc(SITE.email)}">${esc(SITE.email)}</a>` : ''}
        ${SITE.credit ? `<span class="footer-credit">Designed &amp; developed by <b>${esc(SITE.credit)}</b></span>` : ''}
      </div>
    </div>`;
    hydrateIcons(f);
  });
  document.querySelectorAll('[data-site]').forEach((el) => {
    const v = SITE[el.dataset.site] || '';
    if (el.tagName === 'A' && el.dataset.site === 'email') el.href = `mailto:${v}`;
    if (el.tagName === 'A' && el.dataset.site === 'phone') el.href = `tel:${v.replace(/[^\d+]/g, '')}`;
    el.textContent = v;
  });
  document.querySelectorAll('[data-needs]').forEach((el) => { el.hidden = !SITE[el.dataset.needs]; });
  document.querySelectorAll('[data-needs-fallback]').forEach((el) => { el.hidden = !!SITE[el.dataset.needsFallback]; });
});

// Shared buttons use data-action instead of inline onclick (inline handlers are blocked by our CSP).
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'logout') { e.preventDefault(); logout(); }
  else if (el.dataset.action === 'customer-logout') { e.preventDefault(); customerLogout(); }
  else if (el.dataset.action === 'close-dialog') el.closest('dialog')?.close();
  else if (el.dataset.action === 'print') window.print();
});
