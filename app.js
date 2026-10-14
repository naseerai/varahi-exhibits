const express = require('express');
const compression = require('compression');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { promisify } = require('node:util');
const QRCode = require('qrcode');
const db = require('./db');
const { securityHeaders, rateLimit, sameOrigin, microCache, sha256, safeEqual } = require('./lib/security');
const { sendOtp, sendBookingSms, smsConfigured } = require('./lib/sms');
const { sendBookingWhatsApp } = require('./lib/whatsapp');
const razorpay = require('./lib/razorpay');
const cashfree = require('./lib/cashfree');

// ---------- configuration ----------

const IS_PROD = process.env.NODE_ENV === 'production';
const CURRENCY = process.env.CURRENCY || 'INR';

// Payment gateways: each one is switched on by putting its keys in .env.
const GATEWAYS = {};
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  GATEWAYS.razorpay = razorpay({ keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET, currency: CURRENCY });
}
if (process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY) {
  GATEWAYS.cashfree = cashfree({ appId: process.env.CASHFREE_APP_ID, secretKey: process.env.CASHFREE_SECRET_KEY,
    env: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox', currency: CURRENCY });
}
const GATEWAY_LABELS = { razorpay: 'Razorpay', cashfree: 'Cashfree' };
// Demo payments are for testing only and are switched off in production unless explicitly allowed.
const DEMO_ALLOWED = !IS_PROD || process.env.ALLOW_DEMO_PAYMENTS === '1';

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
const setSetting = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// Which gateway takes payment for an event: the event's own choice, else the admin default,
// else whichever gateway is connected. Falls back to demo (dev only) or 'none'.
function defaultGateway() {
  const d = getSetting('default_gateway');
  return GATEWAYS[d] ? d : Object.keys(GATEWAYS)[0] || (DEMO_ALLOWED ? 'demo' : 'none');
}
function gatewayFor(event) {
  return GATEWAYS[event.payment_gateway] ? event.payment_gateway : defaultGateway();
}

// Public base URL for gateway redirects/webhooks (set PUBLIC_URL in production).
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

const SEAT_HOLD_MINUTES = 15;         // an unpaid booking holds its seats this long
const CHECKOUT_TIMEOUT_SECONDS = 600; // Razorpay checkout closes before the hold expires
const MAX_MEMBERS = 20;               // extra members per booking
const MAX_PENDING_PER_CONTACT = 3;    // unpaid bookings one email/phone may hold per event
const SESSION_DAYS = 7;
const MAX_UPLOAD_MB = 8;
const MAX_TICKET_TYPES = 20;

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(db.dataDir, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);

const nowIso = () => new Date().toISOString();
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const holdCutoff = () => new Date(Date.now() - SEAT_HOLD_MINUTES * 60_000).toISOString();
const newCode = () => crypto.randomBytes(12).toString('base64url');   // 96 random bits: unguessable

// Passwords: scrypt on the libuv thread pool so a login never blocks bookings.
const scrypt = promisify(crypto.scrypt);
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(pw, salt, 64)).toString('hex')}`;
}
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;
async function verifyPassword(pw, stored) {
  const [salt, hash] = (stored || DUMMY_HASH).split(':');
  const candidate = await scrypt(String(pw), salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex')) && !!stored;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
    }
  }
  return out;
}

// Session tokens are stored hashed, so a leaked database can't be used to log in.
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token || token.length > 128) return null;
  return db.prepare(`
    SELECT u.id, u.username, u.name, u.role FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(sha256(token), nowIso()) || null;
}

// ---------- customer login (mobile number + OTP) ----------

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 30;
const OTP_MAX_PER_HOUR = 5;
const CUSTOMER_SESSION_DAYS = 30;
// Without SMS credentials (local development) the code is shown on screen so you can test.
const SHOW_DEV_OTP = !smsConfigured && !IS_PROD;

// Secret used to hash OTPs; generated once and kept in the database.
function otpSecret() {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('otp_secret', crypto.randomBytes(32).toString('hex'));
  return getSetting('otp_secret');
}
const otpHash = (phone, code) => crypto.createHmac('sha256', otpSecret()).update(`${phone}:${code}`).digest('hex');

// Accepts 9876543210, +91 98765 43210, 09876543210 … returns the 10-digit number or null.
function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

function currentCustomer(req) {
  const token = parseCookies(req).csid;
  if (!token || token.length > 128) return null;
  return db.prepare(`
    SELECT c.* FROM customer_sessions s JOIN customers c ON c.id = s.customer_id
    WHERE s.token = ? AND s.expires_at > ?`).get(sha256(token), nowIso()) || null;
}

const requireCustomer = (req, res, next) => {
  const c = currentCustomer(req);
  if (!c) return res.status(401).json({ error: 'Please sign in with your mobile number to continue.', code: 'LOGIN_REQUIRED' });
  req.customer = c;
  next();
};

const publicCustomer = (c) => ({ phone: c.phone, name: c.name, email: c.email, address: c.address });

// Bookings made before accounts existed belong to whoever proves they own that mobile number.
function linkOldBookings(customer) {
  const rows = db.prepare('SELECT id, phone FROM bookings WHERE customer_id IS NULL').all();
  const link = db.prepare('UPDATE bookings SET customer_id = ? WHERE id = ? AND customer_id IS NULL');
  db.tx(() => {
    for (const r of rows) if (normPhone(r.phone) === customer.phone) link.run(customer.id, r.id);
    // New account with earlier bookings: take name/email/address from the latest one.
    if (!customer.name) {
      const last = db.prepare('SELECT name, email, address FROM bookings WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(customer.id);
      if (last) db.prepare('UPDATE customers SET name = ?, email = ?, address = ? WHERE id = ?').run(last.name, last.email, last.address, customer.id);
    }
  });
}

const requireRole = (...roles) => (req, res, next) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in' });
  if (!roles.includes(user.role)) return res.status(403).json({ error: 'You do not have access to this' });
  req.user = user;
  next();
};

function seatsTaken(eventId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM bookings b JOIN attendees a ON a.booking_id = b.id
    WHERE b.event_id = ? AND (b.status = 'paid' OR (b.status = 'pending' AND b.created_at > ?))`)
    .get(eventId, holdCutoff()).n;
}

function typeSeatsTaken(typeId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM attendees a JOIN bookings b ON b.id = a.booking_id
    WHERE a.ticket_type_id = ? AND (b.status = 'paid' OR (b.status = 'pending' AND b.created_at > ?))`)
    .get(typeId, holdCutoff()).n;
}

function ticketTypesOf(eventId, { includeRemoved = false } = {}) {
  return db.prepare(`SELECT * FROM ticket_types WHERE event_id = ? ${includeRemoved ? '' : 'AND is_active = 1'}
                     ORDER BY sort_order, id`).all(eventId);
}

// Seats left for a category = the smaller of its own limit and the event's overall limit (null = unlimited).
const minLeft = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));

function publicEvent(e) {
  const eventLeft = e.capacity > 0 ? Math.max(0, e.capacity - seatsTaken(e.id)) : null;
  const ticketTypes = ticketTypesOf(e.id).map((t) => ({
    id: t.id, name: t.name, description: t.description, price: t.price_paise / 100, capacity: t.capacity,
    seatsLeft: minLeft(t.capacity > 0 ? Math.max(0, t.capacity - typeSeatsTaken(t.id)) : null, eventLeft),
  }));
  const prices = ticketTypes.map((t) => t.price);
  const allCapped = ticketTypes.length > 0 && ticketTypes.every((t) => t.seatsLeft !== null);
  return {
    id: e.id, title: e.title, description: e.description, venue: e.venue,
    startsAt: e.starts_at, currency: CURRENCY, capacity: e.capacity, imageUrl: e.image_url, isActive: !!e.is_active,
    price: prices.length ? Math.min(...prices) : 0, maxPrice: prices.length ? Math.max(...prices) : 0,
    payment: gatewayFor(e),   // razorpay | cashfree | demo | none
    ticketTypes,
    seatsLeft: minLeft(allCapped ? ticketTypes.reduce((s, t) => s + t.seatsLeft, 0) : null, eventLeft),
  };
}

const GENDERS = ['', 'male', 'female', 'other'];
function validatePerson(p, label, isPrimary) {
  if (!p || typeof p !== 'object') throw bad(`${label}: details missing`);
  const name = clean(p.name, 100);
  if (!name) throw bad(`${label}: name is required`);
  const age = Number(p.age);
  if (!Number.isInteger(age) || age < 1 || age > 120) throw bad(`${label}: enter a valid age`);
  const gender = clean(p.gender, 10).toLowerCase();
  if (!GENDERS.includes(gender)) throw bad(`${label}: invalid gender`);
  const phone = clean(p.phone, 20);
  if ((isPrimary || phone) && !/^\+?[0-9][0-9\s-]{6,16}$/.test(phone)) throw bad(`${label}: enter a valid phone number`);
  const person = { name, age, gender, phone };
  if (isPrimary) {
    person.email = clean(p.email, 120).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email)) throw bad(`${label}: enter a valid email`);
    person.address = clean(p.address, 300);
    if (!person.address) throw bad(`${label}: address is required`);
  }
  return person;
}

function attendeesOf(bookingId) {
  return db.prepare(`SELECT id, name, age, gender, phone, is_primary, checked_in_at, checked_in_by, ticket_type_id, ticket_type_name, price_paise
                     FROM attendees WHERE booking_id = ? ORDER BY is_primary DESC, id`).all(bookingId)
    .map((a) => ({ id: a.id, name: a.name, age: a.age, gender: a.gender, phone: a.phone,
      ticketTypeId: a.ticket_type_id, ticketType: a.ticket_type_name, price: a.price_paise / 100,
      isPrimary: !!a.is_primary, checkedInAt: a.checked_in_at, checkedInBy: a.checked_in_by }));
}

// Mark a booking paid exactly once. A confirmed payment always wins — even for a booking whose
// seat hold already expired — because the customer's money has been taken.
function markPaid(bookingId, paymentId, source) {
  const before = db.tx(() => {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
    if (!b || b.status === 'paid') return b;
    db.prepare(`UPDATE bookings SET status = 'paid', paid_at = ?, gateway_payment_id = ? WHERE id = ?`)
      .run(nowIso(), paymentId, bookingId);
    if (b.status === 'cancelled') {
      const ev = db.prepare('SELECT capacity FROM events WHERE id = ?').get(b.event_id);
      const over = ev.capacity > 0 && seatsTaken(b.event_id) > ev.capacity;
      console.warn(`[payments] late payment accepted for booking ${b.id} via ${source}${over ? ' — EVENT IS NOW OVER CAPACITY, review it' : ''}`);
    }
    return b;
  });
  // Only the call that actually flipped it to paid sends the ticket (webhook + browser can both arrive).
  if (before && before.status !== 'paid') notifyBookingPaid(bookingId);
  return before;
}

// "Fri, 13 Nov 2026, 6:00 pm" — event times are stored as local wall-clock time ("2026-11-13T18:00"),
// so format them as-is instead of converting from the server's time zone.
function fmtEventTime(s) {
  const d = new Date(`${s}Z`);
  if (Number.isNaN(d.getTime())) return String(s);
  return d.toLocaleString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

// Send the ticket to the main contact on WhatsApp and SMS once a booking is paid.
// Runs in the background and never affects the booking: a failed message is only logged.
function notifyBookingPaid(bookingId) {
  setImmediate(async () => {
    try {
      const b = db.prepare(`
        SELECT b.ticket_code, b.name, b.phone, e.title, e.starts_at FROM bookings b JOIN events e ON e.id = b.event_id
        WHERE b.id = ? AND b.status = 'paid'`).get(bookingId);
      if (!b) return;
      const phone10 = String(b.phone || '').replace(/\D/g, '').slice(-10);
      if (!/^[6-9]\d{9}$/.test(phone10)) return console.warn(`[notify] booking ${bookingId}: no valid mobile number, nothing sent`);
      const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
      const code = b.ticket_code;
      const time = fmtEventTime(b.starts_at);
      const [wa, sms] = await Promise.all([
        sendBookingWhatsApp(phone10, { imageUrl: `${base}/api/tickets/${encodeURIComponent(code)}/qr.png`, event: b.title, time, code }),
        sendBookingSms(phone10, { name: b.name, event: b.title, time, code, link: `${base}/tickets/${encodeURIComponent(code)}` }),
      ]);
      const state = (r) => (r.simulated ? 'logged (not configured)' : r.ok ? 'sent' : r.skipped ? 'skipped' : 'FAILED');
      console.log(`[notify] booking ${bookingId} (${code}): whatsapp ${state(wa)}, sms ${state(sms)}`);
    } catch (err) {
      console.error(`[notify] booking ${bookingId}: ${err.message}`);
    }
  });
}

// Ask the booking's gateway whether it has actually been paid (used when the browser callback
// was missed or can't be trusted on its own). Returns the fresh booking row.
async function confirmWithGateway(b) {
  const gw = GATEWAYS[b.gateway];
  if (b.status === 'paid' || !gw || !b.gateway_order_id) return b;
  const r = await gw.fetchPayment(b.gateway_order_id, b.amount_paise);
  if (r.paid) markPaid(b.id, r.paymentId, `${b.gateway} status check`);
  return db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
}

// Release seats of unpaid bookings whose hold expired. Runs every minute.
function expireHolds() {
  // Housekeeping: old OTPs and expired customer sessions.
  db.prepare('DELETE FROM otps WHERE created_at < ?').run(new Date(Date.now() - 86400_000).toISOString());
  db.prepare('DELETE FROM customer_sessions WHERE expires_at < ?').run(nowIso());
  return db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE status = 'pending' AND created_at < ?`).run(holdCutoff()).changes;
}

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
function looksLikeImage(buf, ext) {
  const hex = buf.subarray(0, 4).toString('hex');
  if (ext === 'jpg') return hex.startsWith('ffd8ff');
  if (ext === 'png') return hex === '89504e47';
  if (ext === 'gif') return hex === '47494638';
  if (ext === 'webp') return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  return false;
}

function eventInput(body) {
  const title = clean(body.title, 150);
  if (!title) throw bad('Title is required');
  const startsAt = clean(body.startsAt, 30);
  if (!startsAt || Number.isNaN(new Date(startsAt).getTime())) throw bad('Enter a valid date and time');
  const capacity = Number(body.capacity || 0);
  if (!Number.isInteger(capacity) || capacity < 0) throw bad('Total capacity must be a whole number (0 = unlimited)');
  const imageUrl = clean(body.imageUrl, 500);
  if (imageUrl && !/^(\/uploads\/[a-f0-9]+\.(jpg|png|webp|gif)|https:\/\/[^\s"'<>]+)$/i.test(imageUrl)) throw bad('Invalid image');

  const typesIn = Array.isArray(body.ticketTypes) ? body.ticketTypes : [];
  if (!typesIn.length) throw bad('Add at least one ticket category');
  if (typesIn.length > MAX_TICKET_TYPES) throw bad(`At most ${MAX_TICKET_TYPES} ticket categories per event`);
  const seen = new Set();
  const ticketTypes = typesIn.map((t, i) => {
    const name = clean(t?.name, 60);
    if (!name) throw bad(`Category ${i + 1}: name is required`);
    if (seen.has(name.toLowerCase())) throw bad(`Category "${name}" is listed twice`);
    seen.add(name.toLowerCase());
    const price = Number(t.price);
    if (!Number.isFinite(price) || price < 0 || price > 10_000_000) throw bad(`${name}: enter a valid price`);
    const cap = Number(t.capacity || 0);
    if (!Number.isInteger(cap) || cap < 0) throw bad(`${name}: seats must be a whole number (0 = no limit)`);
    return { id: Number(t.id) || null, name, description: clean(t.description, 300), pricePaise: toPaise(price), capacity: cap };
  });

  const paymentGateway = clean(body.paymentGateway, 20);
  if (paymentGateway && !GATEWAY_LABELS[paymentGateway]) throw bad('Unknown payment gateway');
  if (paymentGateway && !GATEWAYS[paymentGateway]) throw bad(`${GATEWAY_LABELS[paymentGateway]} is not set up yet — add its keys to .env first`);

  return {
    title, startsAt, capacity, ticketTypes, imageUrl, paymentGateway,
    pricePaise: Math.min(...ticketTypes.map((t) => t.pricePaise)),   // lowest price, kept for listings
    description: clean(body.description, 5000), venue: clean(body.venue, 300),
    isActive: body.isActive === false ? 0 : 1,
  };
}

// Update/insert the submitted categories. Categories left out are deleted, or hidden if tickets were already sold.
function saveTicketTypes(eventId, types) {
  const existing = new Set(ticketTypesOf(eventId, { includeRemoved: true }).map((t) => t.id));
  const kept = new Set();
  types.forEach((t, i) => {
    if (t.id && existing.has(t.id)) {
      db.prepare(`UPDATE ticket_types SET name = ?, description = ?, price_paise = ?, capacity = ?, sort_order = ?, is_active = 1 WHERE id = ?`)
        .run(t.name, t.description, t.pricePaise, t.capacity, i, t.id);
      kept.add(t.id);
    } else {
      db.prepare(`INSERT INTO ticket_types (event_id, name, description, price_paise, capacity, sort_order) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(eventId, t.name, t.description, t.pricePaise, t.capacity, i);
    }
  });
  for (const id of existing) {
    if (kept.has(id)) continue;
    const used = db.prepare('SELECT 1 FROM attendees WHERE ticket_type_id = ? LIMIT 1').get(id);
    if (used) db.prepare('UPDATE ticket_types SET is_active = 0 WHERE id = ?').run(id);
    else db.prepare('DELETE FROM ticket_types WHERE id = ?').run(id);
  }
}

function eventBookings(eventId, status) {
  const rows = db.prepare(`SELECT * FROM bookings WHERE event_id = ? ${status ? 'AND status = ?' : ''} ORDER BY id DESC`)
    .all(...(status ? [eventId, status] : [eventId]));
  return rows.map((b) => ({
    id: b.id, code: b.ticket_code, status: b.status, name: b.name, phone: b.phone, email: b.email, age: b.age,
    gender: b.gender, address: b.address, amount: b.amount_paise / 100, createdAt: b.created_at, paidAt: b.paid_at,
    gateway: b.gateway, paymentId: b.gateway_payment_id, orderId: b.gateway_order_id, attendees: attendeesOf(b.id),
  }));
}

function lookupTicket(code) {
  const b = db.prepare(`
    SELECT b.*, e.title, e.venue, e.starts_at FROM bookings b JOIN events e ON e.id = b.event_id
    WHERE b.ticket_code = ?`).get(clean(code, 100));
  if (!b) throw notFound('Invalid ticket — no booking found for this QR code');
  const attendees = attendeesOf(b.id);
  return {
    code: b.ticket_code, bookingId: b.id, status: b.status, name: b.name, phone: b.phone, email: b.email,
    event: { id: b.event_id, title: b.title, venue: b.venue, startsAt: b.starts_at },
    total: attendees.length, entered: attendees.filter((a) => a.checkedInAt).length, attendees,
  };
}

// ---------- app ----------

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Only trust X-Forwarded-* when running behind a reverse proxy (otherwise clients could fake their IP).
  if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);

  app.use(securityHeaders());
  app.use(compression());

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Payment webhooks (/api/webhooks/razorpay, /api/webhooks/cashfree). They need the raw body
  // for signature checking, so they are registered before the JSON parser.
  app.post('/api/webhooks/:gateway', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const gw = GATEWAYS[req.params.gateway];
    if (!gw?.webhookEnabled) return res.status(404).json({ error: 'Not found' });
    let hook;
    try { hook = gw.parseWebhook(req); } catch { return res.status(400).json({ error: 'Bad payload' }); }
    if (!hook.valid) return res.status(400).json({ error: 'Invalid signature' });
    if (hook.eventId && !db.prepare('INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES (?, ?)').run(clean(hook.eventId, 120), nowIso()).changes) {
      return res.json({ ok: true, duplicate: true });
    }
    for (const p of hook.payments) {
      const b = db.prepare('SELECT * FROM bookings WHERE gateway = ? AND gateway_order_id = ?').get(gw.id, p.orderId);
      if (!b) console.warn(`[webhook:${gw.id}] no booking for order ${p.orderId}`);
      else if (p.amountPaise !== b.amount_paise || p.currency !== CURRENCY) console.error(`[webhook:${gw.id}] amount mismatch for booking ${b.id}: got ${p.amountPaise} ${p.currency}`);
      else markPaid(b.id, p.paymentId, `${gw.id} webhook`);
    }
    res.json({ ok: true });
  });

  app.use('/api', sameOrigin({ allowed: [process.env.PUBLIC_URL] }));
  app.use('/api', rateLimit({ windowMs: 60_000, max: 600 }));
  app.use(express.json({ limit: '100kb' }));

  // Old *.html addresses (bookmarks, links in SMS already sent, payment return URLs in flight)
  // permanently redirect to the clean URLs below.
  app.get(/^\/([a-z0-9-]+)\.html$/i, (req, res, next) => {
    const q = new URLSearchParams(req.query);
    const take = (k) => { const v = q.get(k); q.delete(k); return v; };
    const page = req.params[0].toLowerCase();
    let to;
    if (page === 'index') to = '/';
    else if (page === 'event') { const id = take('id'); to = /^\d+$/.test(id || '') ? `/events/${id}` : '/'; }
    else if (page === 'ticket') { const code = take('code'); to = code ? `/tickets/${encodeURIComponent(code)}` : '/'; }
    else if (page === 'payment') { const ref = take('ref'); to = ref ? `/payment/${encodeURIComponent(ref)}` : '/'; }
    else if (['signin', 'account', 'login', 'admin', 'scan'].includes(page)) to = `/${page}`;
    else if (page === 'privacy') to = '/privacy-policy';
    else if (page === 'terms') to = '/terms-and-conditions';
    else if (page === 'refund') to = '/refund-policy';
    else return next();
    const rest = q.toString();
    res.redirect(301, rest ? `${to}?${rest}` : to);
  });

  // Clean page URLs -> HTML files. Pages read the id/code from the path.
  const PAGE_ROUTES = [
    [/^\/$/, 'index.html'],
    [/^\/events\/\d+(?:\/[a-z0-9-]*)?\/?$/i, 'event.html'],   // /events/12 or /events/12/event-name
    [/^\/tickets\/[A-Za-z0-9_-]{4,64}\/?$/, 'ticket.html'],
    [/^\/payment\/[A-Za-z0-9_-]{4,64}\/?$/, 'payment.html'],
    [/^\/signin\/?$/, 'signin.html'],
    [/^\/account\/?$/, 'account.html'],
    [/^\/login\/?$/, 'login.html'],
    [/^\/admin\/?$/, 'admin.html'],
    [/^\/scan\/?$/, 'scan.html'],
    [/^\/privacy-policy\/?$/, 'privacy.html'],
    [/^\/terms-and-conditions\/?$/, 'terms.html'],
    [/^\/refund-policy\/?$/, 'refund.html'],
  ];

  // HTML pages: inject the per-request nonce into <script> tags so the strict CSP allows them.
  const htmlCache = new Map();
  app.get(/^\/(?!api\/|uploads\/|vendor\/)[^.]*$/, (req, res, next) => {
    const name = PAGE_ROUTES.find(([re]) => re.test(req.path))?.[1];
    if (!name) return next();
    const file = path.join(PUBLIC_DIR, name);
    let html = IS_PROD ? htmlCache.get(name) : undefined;
    if (html === undefined) {
      if (!fs.existsSync(file)) return next();
      html = fs.readFileSync(file, 'utf8');
      if (IS_PROD) htmlCache.set(name, html);
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html.replace(/<script(?=[\s>])/g, `<script nonce="${res.locals.nonce}"`));
  });
  app.get('/vendor/html5-qrcode.min.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'node_modules', 'html5-qrcode', 'html5-qrcode.min.js'), { maxAge: '7d' });
  });
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: IS_PROD ? '1h' : 0 }));
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

  // ----- public API -----

  const eventCache = microCache(2000);   // 2s: absorbs refresh storms; bookings always re-check live seats

  app.get('/api/config', (req, res) => res.json({ currency: CURRENCY, maxMembers: MAX_MEMBERS }));

  app.get('/api/events', (req, res) => {
    res.json(eventCache('list', () => {
      // starts_at is local time without a zone, so compare as Dates rather than strings.
      const rows = db.prepare('SELECT * FROM events WHERE is_active = 1 ORDER BY starts_at').all();
      return rows.filter((e) => new Date(e.starts_at) > new Date()).map(publicEvent);
    }));
  });

  app.get('/api/events/:id', (req, res) => {
    const id = Number(req.params.id);
    const ev = eventCache(`e${id}`, () => {
      const e = db.prepare('SELECT * FROM events WHERE id = ? AND is_active = 1').get(id);
      return e ? publicEvent(e) : null;
    });
    if (!ev) throw notFound('Event not found');
    res.json(ev);
  });

  // ----- customer login: OTP to mobile -----

  const otpSendLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, message: 'Too many OTP requests from your network. Please try again later.' });
  const otpVerifyLimiter = rateLimit({ windowMs: 15 * 60_000, max: 40, message: 'Too many attempts. Please try again later.' });

  app.post('/api/auth/otp/send', otpSendLimiter, async (req, res) => {
    const phone = normPhone(req.body?.phone);
    if (!phone) throw bad('Enter a valid 10-digit Indian mobile number');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    db.tx(() => {
      const now = Date.now();
      const last = db.prepare('SELECT created_at FROM otps WHERE phone = ? ORDER BY id DESC LIMIT 1').get(phone);
      const wait = last ? OTP_RESEND_SECONDS - Math.floor((now - Date.parse(last.created_at)) / 1000) : 0;
      if (wait > 0) throw new HttpError(429, `Please wait ${wait}s before requesting another OTP`);
      const recent = db.prepare('SELECT COUNT(*) AS n FROM otps WHERE phone = ? AND created_at > ?').get(phone, new Date(now - 3600_000).toISOString()).n;
      if (recent >= OTP_MAX_PER_HOUR) throw new HttpError(429, 'Too many OTPs for this number. Please try again in an hour.');
      db.prepare('UPDATE otps SET used = 1 WHERE phone = ? AND used = 0').run(phone);   // only the newest code works
      db.prepare('INSERT INTO otps (phone, code_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(phone, otpHash(phone, code), new Date(now + OTP_TTL_MINUTES * 60_000).toISOString(), String(req.ip || ''), nowIso());
    });
    const sent = await sendOtp(phone, code);
    if (!sent.ok) throw new HttpError(502, 'Could not send the OTP right now. Please try again in a minute.');
    res.json({ ok: true, resendIn: OTP_RESEND_SECONDS, expiresIn: OTP_TTL_MINUTES * 60, ...(SHOW_DEV_OTP ? { devOtp: code } : {}) });
  });

  app.post('/api/auth/otp/verify', otpVerifyLimiter, (req, res) => {
    const phone = normPhone(req.body?.phone);
    const code = String(req.body?.otp || '').replace(/\D/g, '');
    if (!phone || code.length !== 6) throw bad('Enter the 6-digit OTP');
    // Errors are returned (not thrown) so the failed-attempt counter is committed.
    const result = db.tx(() => {
      const o = db.prepare('SELECT * FROM otps WHERE phone = ? AND used = 0 ORDER BY id DESC LIMIT 1').get(phone);
      if (!o || o.expires_at < nowIso()) return { error: 'This OTP has expired. Please request a new one.' };
      if (o.attempts >= OTP_MAX_ATTEMPTS) return { error: 'Too many wrong attempts. Please request a new OTP.' };
      if (!safeEqual(otpHash(phone, code), o.code_hash)) {
        db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').run(o.id);
        const left = OTP_MAX_ATTEMPTS - o.attempts - 1;
        return { error: left > 0 ? `Wrong OTP. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Please request a new OTP.' };
      }
      db.prepare('UPDATE otps SET used = 1 WHERE id = ?').run(o.id);
      db.prepare('INSERT OR IGNORE INTO customers (phone, created_at) VALUES (?, ?)').run(phone, nowIso());
      db.prepare('UPDATE customers SET last_login_at = ? WHERE phone = ?').run(nowIso(), phone);
      return { customer: db.prepare('SELECT * FROM customers WHERE phone = ?').get(phone) };
    });
    if (result.error) throw bad(result.error);
    linkOldBookings(result.customer);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(result.customer.id);   // may have been filled in by linking

    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + CUSTOMER_SESSION_DAYS * 86400_000);
    db.prepare('INSERT INTO customer_sessions (token, customer_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), customer.id, expires.toISOString());
    res.setHeader('Set-Cookie', `csid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${CUSTOMER_SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
    res.json({ customer: publicCustomer(customer) });
  });

  app.get('/api/customer/me', (req, res) => {
    const c = currentCustomer(req);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ customer: c ? publicCustomer(c) : null });
  });

  app.post('/api/customer/logout', (req, res) => {
    const token = parseCookies(req).csid;
    if (token) db.prepare('DELETE FROM customer_sessions WHERE token = ?').run(sha256(token));
    res.setHeader('Set-Cookie', `csid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  });

  // Booking history for "My account": paid bookings plus ones still waiting for payment.
  app.get('/api/customer/bookings', requireCustomer, (req, res) => {
    const rows = db.prepare(`
      SELECT b.*, e.title, e.venue, e.starts_at, e.image_url FROM bookings b JOIN events e ON e.id = b.event_id
      WHERE b.customer_id = ? AND (b.status = 'paid' OR (b.status = 'pending' AND b.created_at > ?))
      ORDER BY e.starts_at DESC, b.id DESC`).all(req.customer.id, holdCutoff());
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(rows.map((b) => ({
      ref: b.ticket_code, status: b.status, ticketCode: b.status === 'paid' ? b.ticket_code : undefined,
      amount: b.amount_paise / 100, currency: CURRENCY, createdAt: b.created_at, paidAt: b.paid_at,
      event: { id: b.event_id, title: b.title, venue: b.venue, startsAt: b.starts_at, imageUrl: b.image_url },
      attendees: attendeesOf(b.id).map((a) => ({ name: a.name, ticketType: a.ticketType, checkedInAt: a.checkedInAt })),
    })));
  });

  const bookingLimiter = rateLimit({ windowMs: 10 * 60_000, max: 30, message: 'Too many booking attempts from your network. Please wait a few minutes.' });
  const customerBookingLimiter = rateLimit({ windowMs: 10 * 60_000, max: 15, key: (req) => `c:${req.customer.id}`,
    message: 'Too many booking attempts. Please wait a few minutes.' });

  app.post('/api/bookings', bookingLimiter, requireCustomer, customerBookingLimiter, async (req, res) => {
    const body = req.body || {};
    const event = db.prepare('SELECT * FROM events WHERE id = ? AND is_active = 1').get(Number(body.eventId));
    if (!event) throw notFound('Event not found');
    if (new Date(event.starts_at) < new Date()) throw bad('Bookings for this event are closed');

    // The main contact's mobile is always the number verified by OTP.
    const primary = validatePerson({ ...(body.primary || {}), phone: req.customer.phone }, 'Main attendee', true);
    const membersIn = Array.isArray(body.members) ? body.members : [];
    if (membersIn.length > MAX_MEMBERS) throw bad(`You can add at most ${MAX_MEMBERS} members per booking`);
    const members = membersIn.map((m, i) => validatePerson(m, `Member ${i + 1}`, false));

    const types = new Map(ticketTypesOf(event.id).map((t) => [t.id, t]));
    const pickType = (p, label) => {
      const t = types.size === 1 && !p?.ticketTypeId ? [...types.values()][0] : types.get(Number(p?.ticketTypeId));
      if (!t) throw bad(`${label}: choose a ticket category`);
      return t;
    };
    primary.type = pickType(body.primary, 'Main attendee');
    members.forEach((m, i) => { m.type = pickType(membersIn[i], `Member ${i + 1}`); });
    const everyone = [primary, ...members];
    const amount = everyone.reduce((sum, p) => sum + p.type.price_paise, 0);
    const isFree = amount === 0;
    const gatewayId = isFree ? 'free' : gatewayFor(event);
    if (gatewayId === 'none') throw new HttpError(503, 'Online payments are not set up yet. Please try again later.');

    const ticketCode = newCode();
    // Seat check + insert in ONE write transaction: parallel requests are serialised here,
    // so two people can never both get the last seat.
    const bookingId = db.tx(() => {
      const cutoff = holdCutoff();
      const holds = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE event_id = ? AND status = 'pending' AND created_at > ? AND customer_id = ?`)
        .get(event.id, cutoff, req.customer.id).n;
      if (holds >= MAX_PENDING_PER_CONTACT) {
        throw new HttpError(429, `You already have ${holds} unpaid bookings for this event. Complete one of them or try again in ${SEAT_HOLD_MINUTES} minutes.`);
      }
      if (event.capacity > 0) {
        const left = event.capacity - seatsTaken(event.id);
        if (everyone.length > left) throw new HttpError(409, left > 0 ? `Only ${left} seat(s) left` : 'Sorry, this event is sold out');
      }
      const perType = new Map();
      for (const p of everyone) perType.set(p.type, (perType.get(p.type) || 0) + 1);
      for (const [t, n] of perType) {
        if (t.capacity <= 0) continue;
        const left = t.capacity - typeSeatsTaken(t.id);
        if (n > left) throw new HttpError(409, left > 0 ? `${t.name}: only ${left} ticket(s) left` : `${t.name} tickets are sold out`);
      }

      const { lastInsertRowid } = db.prepare(`
        INSERT INTO bookings (event_id, ticket_code, name, phone, email, age, gender, address, amount_paise, status, created_at, paid_at, gateway, customer_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.id, ticketCode, primary.name, primary.phone, primary.email, primary.age, primary.gender,
          primary.address, amount, isFree ? 'paid' : 'pending', nowIso(), isFree ? nowIso() : null, gatewayId, req.customer.id);
      // Remember the contact details so the next booking is pre-filled.
      db.prepare('UPDATE customers SET name = ?, email = ?, address = ? WHERE id = ?').run(primary.name, primary.email, primary.address, req.customer.id);
      const insert = db.prepare(`INSERT INTO attendees (booking_id, name, age, gender, phone, is_primary, ticket_type_id, ticket_type_name, price_paise)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const p of everyone) {
        insert.run(lastInsertRowid, p.name, p.age, p.gender, p.phone, p === primary ? 1 : 0, p.type.id, p.type.name, p.type.price_paise);
      }
      return Number(lastInsertRowid);
    });

    // `ref` identifies the booking to this browser only (random, not a guessable number).
    if (isFree) {
      notifyBookingPaid(bookingId);
      return res.json({ ref: ticketCode, status: 'paid', ticketCode });
    }
    const response = { ref: ticketCode, status: 'pending', mode: gatewayId, amount: amount / 100, currency: CURRENCY };
    const gw = GATEWAYS[gatewayId];
    if (gw) {
      try {
        const base = baseUrl(req);
        const { orderId, checkout } = await gw.createOrder({
          bookingId, ref: ticketCode, amountPaise: amount, eventTitle: event.title, timeoutSeconds: CHECKOUT_TIMEOUT_SECONDS,
          customer: { name: primary.name, email: primary.email, phone: primary.phone },
          returnUrl: `${base}/payment/${encodeURIComponent(ticketCode)}`,
          // Gateways only accept https webhook URLs; locally, the status check covers it instead.
          notifyUrl: base.startsWith('https://') ? `${base}/api/webhooks/${gatewayId}` : undefined,
        });
        db.prepare('UPDATE bookings SET gateway_order_id = ? WHERE id = ?').run(orderId, bookingId);
        response.checkout = checkout;
      } catch (err) {
        db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(bookingId);
        throw err;
      }
    }
    res.json(response);
  });

  const byRef = (ref) => db.prepare('SELECT * FROM bookings WHERE ticket_code = ?').get(clean(ref, 64));
  const paymentLimiter = rateLimit({ windowMs: 10 * 60_000, max: 60 });

  // Browser says "payment done": trust it only after checking the signature (Razorpay)
  // or asking the gateway's server directly (Cashfree, or Razorpay without a signature).
  app.post('/api/bookings/:ref/verify', paymentLimiter, async (req, res) => {
    let b = byRef(req.params.ref);
    if (!b) throw notFound('Booking not found');
    const gw = GATEWAYS[b.gateway];
    if (!gw) throw bad('This booking does not use online payment');
    const paymentId = gw.verifyCheckout(b.gateway_order_id, req.body);
    if (paymentId) markPaid(b.id, paymentId, `${gw.id} checkout`);
    else b = await confirmWithGateway(b);
    b = byRef(req.params.ref);
    if (b.status !== 'paid') {
      throw bad('We could not confirm your payment yet. If money was deducted, your ticket will be issued automatically within a few minutes — or contact the organiser.');
    }
    res.json({ status: 'paid', ticketCode: b.ticket_code });
  });

  // Customer closed the payment window: release the held seats right away.
  app.post('/api/bookings/:ref/cancel', paymentLimiter, (req, res) => {
    db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE ticket_code = ? AND status = 'pending'`).run(clean(req.params.ref, 64));
    res.json({ ok: true });
  });

  // Lets the page find out whether a payment completed (missed callback, bank redirect, late UPI…).
  // Asks the gateway at most once every 3 seconds per booking.
  const lastGatewayCheck = new Map();
  app.get('/api/bookings/:ref/status', paymentLimiter, async (req, res) => {
    let b = byRef(req.params.ref);
    if (!b) throw notFound('Booking not found');
    const now = Date.now();
    if (b.status !== 'paid' && GATEWAYS[b.gateway] && (lastGatewayCheck.get(b.id) || 0) < now - 3000) {
      lastGatewayCheck.set(b.id, now);
      if (lastGatewayCheck.size > 5000) lastGatewayCheck.clear();
      b = await confirmWithGateway(b).catch(() => b);
    }
    res.json({ status: b.status, ticketCode: b.status === 'paid' ? b.ticket_code : undefined, eventId: b.event_id });
  });

  // Demo mode only: simulates a successful payment so the flow can be tested without a gateway.
  app.post('/api/bookings/:ref/demo-pay', paymentLimiter, (req, res) => {
    const b = byRef(req.params.ref);
    if (b?.gateway !== 'demo' || !DEMO_ALLOWED) throw bad('Demo payments are disabled');
    if (!['pending', 'paid'].includes(b.status)) throw notFound('Booking not found or expired');
    markPaid(b.id, `demo_${Date.now()}`, 'demo');
    res.json({ status: 'paid', ticketCode: b.ticket_code });
  });

  const ticketLimiter = rateLimit({ windowMs: 60_000, max: 60 });
  app.get('/api/tickets/:code', ticketLimiter, async (req, res) => {
    const b = db.prepare(`
      SELECT b.*, e.title, e.venue, e.starts_at FROM bookings b JOIN events e ON e.id = b.event_id
      WHERE b.ticket_code = ? AND b.status = 'paid'`).get(clean(req.params.code, 64));
    if (!b) throw notFound('Ticket not found');
    const qr = await QRCode.toDataURL(b.ticket_code, { width: 360, margin: 2, errorCorrectionLevel: 'M' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      code: b.ticket_code, qr, name: b.name, email: b.email, phone: b.phone,
      amount: b.amount_paise / 100, currency: CURRENCY, paidAt: b.paid_at,
      event: { title: b.title, venue: b.venue, startsAt: b.starts_at },
      attendees: attendeesOf(b.id),
    });
  });

  // Ticket QR code as a PNG image, used as the picture in the WhatsApp message.
  // WhatsApp's servers download it, so it must be reachable from the internet (PUBLIC_URL).
  app.get('/api/tickets/:code/qr.png', ticketLimiter, async (req, res) => {
    const b = db.prepare(`SELECT ticket_code FROM bookings WHERE ticket_code = ? AND status = 'paid'`).get(clean(req.params.code, 64));
    if (!b) throw notFound('Ticket not found');
    const png = await QRCode.toBuffer(b.ticket_code, { type: 'png', width: 720, margin: 4, errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(png);
  });

  // ----- auth -----

  const loginIpLimiter = rateLimit({ windowMs: 15 * 60_000, max: 30, message: 'Too many login attempts. Try again in 15 minutes.' });
  const loginUserLimiter = rateLimit({ windowMs: 15 * 60_000, max: 8, key: (req) => `u:${clean(req.body?.username, 60).toLowerCase()}`,
    message: 'Too many failed attempts for this account. Try again in 15 minutes.' });

  app.post('/api/login', loginIpLimiter, loginUserLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(clean(username, 60));
    // Always run the hash check so response time doesn't reveal whether a username exists.
    const ok = await verifyPassword(String(password || '').slice(0, 200), user?.password_hash);
    if (!user || !ok) throw new HttpError(401, 'Wrong username or password');
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, expires.toISOString());
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
    res.json({ username: user.username, name: user.name, role: user.role });
  });

  app.post('/api/logout', (req, res) => {
    const token = parseCookies(req).sid;
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(sha256(token));
    res.setHeader('Set-Cookie', `sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  });

  app.get('/api/me', requireRole('admin', 'staff'), (req, res) => res.json(req.user));

  app.post('/api/me/password', requireRole('admin', 'staff'), loginIpLimiter, async (req, res) => {
    const { current, next } = req.body || {};
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!(await verifyPassword(String(current || ''), row.password_hash))) throw bad('Current password is wrong');
    if (String(next || '').length < 8) throw bad('New password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(String(next)), req.user.id);
    // Sign out every other device that was using the old password.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, sha256(parseCookies(req).sid));
    res.json({ ok: true });
  });

  // ----- staff: scanning & check-in -----

  app.get('/api/staff/events', requireRole('admin', 'staff'), (req, res) => {
    res.json(db.prepare('SELECT id, title, starts_at AS startsAt FROM events WHERE is_active = 1 ORDER BY starts_at').all());
  });

  app.post('/api/staff/lookup', requireRole('admin', 'staff'), (req, res) => {
    res.json(lookupTicket(req.body?.code));
  });

  app.post('/api/staff/checkin', requireRole('admin', 'staff'), (req, res) => {
    const ticket = lookupTicket(req.body?.code);
    if (ticket.status !== 'paid') throw bad('This booking is not paid — do not allow entry');
    const ids = Array.isArray(req.body?.attendeeIds) && req.body.attendeeIds.length
      ? req.body.attendeeIds.map(Number)
      : ticket.attendees.map((a) => a.id);
    const valid = new Set(ticket.attendees.map((a) => a.id));
    const stmt = db.prepare('UPDATE attendees SET checked_in_at = ?, checked_in_by = ? WHERE id = ? AND booking_id = ? AND checked_in_at IS NULL');
    const ts = nowIso();
    db.tx(() => { for (const id of ids) if (valid.has(id)) stmt.run(ts, req.user.name, id, ticket.bookingId); });
    res.json(lookupTicket(ticket.code));
  });

  // ----- admin -----

  const uploadLimiter = rateLimit({ windowMs: 10 * 60_000, max: 60 });
  app.post('/api/admin/upload', requireRole('admin'), uploadLimiter,
    express.raw({ type: Object.keys(IMAGE_TYPES), limit: `${MAX_UPLOAD_MB}mb` }),
    (req, res) => {
      const ext = IMAGE_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()];
      if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) throw bad('Please upload a JPG, PNG, WebP or GIF image');
      if (!looksLikeImage(req.body, ext)) throw bad('That file is not a valid image');
      const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
      res.json({ url: `/uploads/${name}` });
    });

  app.get('/api/admin/events', requireRole('admin'), (req, res) => {
    const rows = db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM bookings b WHERE b.event_id = e.id AND b.status = 'paid') AS bookings,
        (SELECT COUNT(*) FROM attendees a JOIN bookings b ON b.id = a.booking_id WHERE b.event_id = e.id AND b.status = 'paid') AS people,
        (SELECT COUNT(*) FROM attendees a JOIN bookings b ON b.id = a.booking_id WHERE b.event_id = e.id AND b.status = 'paid' AND a.checked_in_at IS NOT NULL) AS entered,
        (SELECT COALESCE(SUM(amount_paise), 0) FROM bookings b WHERE b.event_id = e.id AND b.status = 'paid') AS revenue_paise
      FROM events e ORDER BY e.starts_at DESC`).all();
    const typeStats = db.prepare(`
      SELECT COUNT(*) AS sold, COUNT(a.checked_in_at) AS entered, COALESCE(SUM(a.price_paise), 0) AS revenue_paise
      FROM attendees a JOIN bookings b ON b.id = a.booking_id WHERE a.ticket_type_id = ? AND b.status = 'paid'`);
    res.json(rows.map((e) => ({
      ...publicEvent(e), paymentGateway: e.payment_gateway,
      bookings: e.bookings, people: e.people, entered: e.entered, revenue: e.revenue_paise / 100,
      categories: ticketTypesOf(e.id, { includeRemoved: true }).map((t) => {
        const s = typeStats.get(t.id);
        return { id: t.id, name: t.name, description: t.description, price: t.price_paise / 100, capacity: t.capacity,
          isActive: !!t.is_active, sold: s.sold, entered: s.entered, revenue: s.revenue_paise / 100 };
      }),
    })));
  });

  app.post('/api/admin/events', requireRole('admin'), (req, res) => {
    const e = eventInput(req.body || {});
    const id = db.tx(() => {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO events (title, description, venue, starts_at, price_paise, capacity, image_url, is_active, payment_gateway, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.title, e.description, e.venue, e.startsAt, e.pricePaise, e.capacity, e.imageUrl, e.isActive, e.paymentGateway, nowIso());
      saveTicketTypes(Number(lastInsertRowid), e.ticketTypes.map((t) => ({ ...t, id: null })));
      return Number(lastInsertRowid);
    });
    eventCache.clear();
    res.json({ id });
  });

  app.put('/api/admin/events/:id', requireRole('admin'), (req, res) => {
    const e = eventInput(req.body || {});
    const id = Number(req.params.id);
    db.tx(() => {
      const { changes } = db.prepare(`
        UPDATE events SET title = ?, description = ?, venue = ?, starts_at = ?, price_paise = ?, capacity = ?, image_url = ?, is_active = ?, payment_gateway = ?
        WHERE id = ?`)
        .run(e.title, e.description, e.venue, e.startsAt, e.pricePaise, e.capacity, e.imageUrl, e.isActive, e.paymentGateway, id);
      if (!changes) throw notFound('Event not found');
      saveTicketTypes(id, e.ticketTypes);
    });
    eventCache.clear();
    res.json({ ok: true });
  });

  app.delete('/api/admin/events/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    db.tx(() => {
      const paid = db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE event_id = ? AND status = 'paid'`).get(id).n;
      if (paid) throw bad('This event has paid bookings, so it cannot be deleted. Hide it instead (untick "Visible").');
      db.prepare('DELETE FROM bookings WHERE event_id = ?').run(id);
      db.prepare('DELETE FROM events WHERE id = ?').run(id);
    });
    eventCache.clear();
    res.json({ ok: true });
  });

  app.get('/api/admin/events/:id/bookings', requireRole('admin'), (req, res) => {
    const status = ['paid', 'pending', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    res.json(eventBookings(Number(req.params.id), status));
  });

  app.get('/api/admin/events/:id/export.csv', requireRole('admin'), (req, res) => {
    // Prefix cells that start with = + - @ so spreadsheet apps don't run them as formulas.
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
    const lines = [['Booking ID', 'Ticket code', 'Booked by', 'Phone', 'Email', 'Address', 'Attendee', 'Age', 'Gender', 'Attendee phone', 'Ticket category', 'Ticket price', 'Booking total', 'Paid at', 'Paid via', 'Payment ID', 'Entered at', 'Entered by'].map(cell).join(',')];
    for (const b of eventBookings(Number(req.params.id), 'paid')) {
      for (const a of b.attendees) {
        lines.push([b.id, b.code, b.name, b.phone, b.email, b.address, a.name, a.age, a.gender, a.phone, a.ticketType, a.price,
          a.isPrimary ? b.amount : '', b.paidAt, a.isPrimary ? GATEWAY_LABELS[b.gateway] || b.gateway : '', a.isPrimary ? b.paymentId || '' : '',
          a.checkedInAt || '', a.checkedInBy || ''].map(cell).join(','));
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="event-${Number(req.params.id)}-attendees.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  });

  // ----- payment gateway settings -----

  function paymentSettings(req) {
    const base = baseUrl(req);
    return {
      default: defaultGateway(),
      demoAllowed: DEMO_ALLOWED,
      gateways: Object.keys(GATEWAY_LABELS).map((id) => {
        const gw = GATEWAYS[id];
        const events = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE payment_gateway = ?`).get(id).n;
        return {
          id, label: GATEWAY_LABELS[id], configured: !!gw, mode: gw?.mode || null,
          webhookUrl: `${base}/api/webhooks/${id}`, webhookEnabled: !!gw?.webhookEnabled, eventsUsing: events,
        };
      }),
    };
  }

  app.get('/api/admin/payments', requireRole('admin'), (req, res) => res.json(paymentSettings(req)));

  app.put('/api/admin/payments', requireRole('admin'), (req, res) => {
    const id = clean(req.body?.default, 20);
    if (!GATEWAYS[id]) throw bad('That gateway is not set up — add its keys to .env first');
    setSetting('default_gateway', id);
    eventCache.clear();
    res.json(paymentSettings(req));
  });

  app.get('/api/admin/users', requireRole('admin'), (req, res) => {
    res.json(db.prepare('SELECT id, username, name, role, created_at AS createdAt FROM users ORDER BY role, name').all());
  });

  app.post('/api/admin/users', requireRole('admin'), async (req, res) => {
    const username = clean(req.body?.username, 60).toLowerCase();
    const name = clean(req.body?.name, 100);
    const password = String(req.body?.password || '');
    const role = req.body?.role === 'admin' ? 'admin' : 'staff';
    if (!/^[a-z0-9._-]{3,60}$/.test(username)) throw bad('Username: 3+ characters, letters/numbers/._- only');
    if (!name) throw bad('Name is required');
    if (password.length < 8 || password.length > 200) throw bad('Password must be at least 8 characters');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw bad('That username is taken');
    db.prepare('INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, name, await hashPassword(password), role, nowIso());
    res.json({ ok: true });
  });

  app.delete('/api/admin/users/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) throw bad('You cannot delete your own account');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ----- errors -----

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: `File is too large (max ${MAX_UPLOAD_MB} MB)` });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    if (err.code === 'ERR_SQLITE_ERROR' && /database is locked|busy/i.test(err.message)) {
      return res.status(503).json({ error: 'We are very busy right now. Please try again in a few seconds.' });
    }
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Please try again.' });
  });

  return app;
}

// ---------- first-run setup ----------

async function firstRunSetup() {
  if (!db.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
    const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
    const generated = !process.env.ADMIN_PASSWORD;
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO users (username, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, 'Administrator', await hashPassword(password), 'admin', nowIso());
    console.log('\n=== Admin account created ===');
    console.log(`  username: ${username}`);
    console.log(generated ? `  password: ${password}   (save this — it is shown only once)` : '  password: (from ADMIN_PASSWORD in .env)');
    console.log('=============================\n');
  }

  if (!db.prepare('SELECT COUNT(*) AS n FROM events').get().n && process.env.SEED_SAMPLE !== '0') {
    const d = new Date(Date.now() + 30 * 86400_000);
    d.setHours(18, 0, 0, 0);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    db.tx(() => {
      const { lastInsertRowid } = db.prepare(`INSERT INTO events (title, description, venue, starts_at, price_paise, capacity, image_url, is_active, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, '', 1, ?)`)
        .run('Sample Music Night', 'A sample event so you can try the booking flow. Edit or delete it from the admin panel.',
          'City Convention Hall', local, 49900, 200, nowIso());
      saveTicketTypes(Number(lastInsertRowid), [
        { name: 'VIP', description: 'Front rows, welcome drink', pricePaise: 149900, capacity: 30 },
        { name: 'Gold', description: 'Reserved seating', pricePaise: 89900, capacity: 70 },
        { name: 'General', description: 'Open seating', pricePaise: 49900, capacity: 0 },
      ]);
    });
  }
}

module.exports = { createApp, firstRunSetup, expireHolds, GATEWAYS, defaultGateway, IS_PROD };
