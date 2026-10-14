const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// DATA_DIR lets you keep the database (and uploads) elsewhere, e.g. on a backed-up disk.
const dir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(path.join(dir, 'tickets.db'));
db.dataDir = dir;

db.exec(`
  PRAGMA journal_mode = WAL;        -- readers never block the writer
  PRAGMA synchronous = NORMAL;      -- safe with WAL, much faster commits
  PRAGMA busy_timeout = 5000;       -- wait for the write lock instead of failing (multi-process mode)
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    venue       TEXT NOT NULL DEFAULT '',
    starts_at   TEXT NOT NULL,
    price_paise INTEGER NOT NULL DEFAULT 0,
    capacity    INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
    image_url   TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id                  INTEGER PRIMARY KEY,
    event_id            INTEGER NOT NULL REFERENCES events(id),
    ticket_code         TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    phone               TEXT NOT NULL,
    email               TEXT NOT NULL,
    age                 INTEGER NOT NULL,
    gender              TEXT NOT NULL DEFAULT '',
    address             TEXT NOT NULL,
    amount_paise        INTEGER NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled')),
    razorpay_order_id   TEXT,
    razorpay_payment_id TEXT,
    created_at          TEXT NOT NULL,
    paid_at             TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_event ON bookings(event_id);

  CREATE TABLE IF NOT EXISTS attendees (
    id            INTEGER PRIMARY KEY,
    booking_id    INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    age           INTEGER NOT NULL,
    gender        TEXT NOT NULL DEFAULT '',
    phone         TEXT NOT NULL DEFAULT '',
    is_primary    INTEGER NOT NULL DEFAULT 0,
    checked_in_at TEXT,
    checked_in_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_attendees_booking ON attendees(booking_id);

  -- Ticket categories per event (VIP, Gold, General, ...). Each attendee holds one.
  CREATE TABLE IF NOT EXISTS ticket_types (
    id          INTEGER PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_paise INTEGER NOT NULL DEFAULT 0,
    capacity    INTEGER NOT NULL DEFAULT 0,   -- 0 = no category limit (event capacity still applies)
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1    -- 0 = removed by admin but kept because tickets were sold
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_types_event ON ticket_types(event_id);
`);

// ---------- migrations for databases created before ticket categories ----------

const attendeeCols = db.prepare('PRAGMA table_info(attendees)').all().map((c) => c.name);
if (!attendeeCols.includes('ticket_type_id')) {
  db.exec(`
    ALTER TABLE attendees ADD COLUMN ticket_type_id INTEGER REFERENCES ticket_types(id);
    ALTER TABLE attendees ADD COLUMN ticket_type_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE attendees ADD COLUMN price_paise INTEGER NOT NULL DEFAULT 0;
  `);
}

// Every event needs at least one category: give old events a "General" one at their old price.
for (const e of db.prepare('SELECT id, price_paise FROM events WHERE id NOT IN (SELECT event_id FROM ticket_types)').all()) {
  const { lastInsertRowid } = db.prepare(`INSERT INTO ticket_types (event_id, name, price_paise) VALUES (?, 'General', ?)`).run(e.id, e.price_paise);
  db.prepare(`UPDATE attendees SET ticket_type_id = ?, ticket_type_name = 'General', price_paise = ?
              WHERE ticket_type_id IS NULL AND booking_id IN (SELECT id FROM bookings WHERE event_id = ?)`)
    .run(lastInsertRowid, e.price_paise, e.id);
}

// ---------- indexes & tables added for scale / payments ----------
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_bookings_event_status ON bookings(event_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_bookings_order ON bookings(razorpay_order_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_pending ON bookings(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_attendees_type ON attendees(ticket_type_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

  -- Payment webhook event ids already processed (ignore replays/duplicates).
  CREATE TABLE IF NOT EXISTS webhook_events (
    id          TEXT PRIMARY KEY,
    received_at TEXT NOT NULL
  );

  -- Small key/value store for admin settings (e.g. the default payment gateway).
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ---------- multiple payment gateways (Razorpay + Cashfree) ----------
const eventCols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
if (!eventCols.includes('payment_gateway')) {
  // '' = use the default gateway from Admin → Payments
  db.exec(`ALTER TABLE events ADD COLUMN payment_gateway TEXT NOT NULL DEFAULT ''`);
}
const bookingCols = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
if (!bookingCols.includes('gateway')) {
  db.exec(`
    ALTER TABLE bookings ADD COLUMN gateway TEXT NOT NULL DEFAULT '';
    ALTER TABLE bookings ADD COLUMN gateway_order_id TEXT;
    ALTER TABLE bookings ADD COLUMN gateway_payment_id TEXT;
    UPDATE bookings SET gateway = 'razorpay', gateway_order_id = razorpay_order_id, gateway_payment_id = razorpay_payment_id
      WHERE razorpay_order_id IS NOT NULL;
    UPDATE bookings SET gateway = 'demo', gateway_payment_id = razorpay_payment_id
      WHERE razorpay_order_id IS NULL AND razorpay_payment_id LIKE 'demo_%';
  `);
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_gateway_order ON bookings(gateway, gateway_order_id)');

// ---------- customer accounts (mobile number + OTP login) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id            INTEGER PRIMARY KEY,
    phone         TEXT NOT NULL UNIQUE,     -- 10-digit Indian mobile, verified by OTP
    name          TEXT NOT NULL DEFAULT '',
    email         TEXT NOT NULL DEFAULT '',
    address       TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS customer_sessions (
    token       TEXT PRIMARY KEY,           -- sha256 of the cookie value
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_customer_sessions_expiry ON customer_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS otps (
    id         INTEGER PRIMARY KEY,
    phone      TEXT NOT NULL,
    code_hash  TEXT NOT NULL,               -- HMAC of the code; the code itself is never stored
    expires_at TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    used       INTEGER NOT NULL DEFAULT 0,
    ip         TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_otps_phone ON otps(phone, created_at);
`);
const bookingCols2 = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
if (!bookingCols2.includes('customer_id')) {
  db.exec('ALTER TABLE bookings ADD COLUMN customer_id INTEGER REFERENCES customers(id)');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id, created_at)');

// Reuse prepared statements: avoids re-parsing the same SQL on every request.
const rawPrepare = db.prepare.bind(db);
const statements = new Map();
db.prepare = (sql) => {
  let stmt = statements.get(sql);
  if (!stmt) { stmt = rawPrepare(sql); statements.set(sql, stmt); }
  return stmt;
};

// Run fn inside a write transaction; rolls back if it throws.
// BEGIN IMMEDIATE takes the write lock up front, so "check seats then insert" is atomic
// even when several server processes share the database. Nested calls join the outer transaction.
let depth = 0;
db.tx = (fn) => {
  if (depth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
};

module.exports = db;
