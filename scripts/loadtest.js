// Load test: thousands of people booking the same event at the same moment.
// Run it ONLY against a test server (it creates an event and many demo bookings):
//
//   DATA_DIR=./loadtest-data DISABLE_RATE_LIMIT=1 SEED_SAMPLE=0 ADMIN_PASSWORD=loadtest-pass PORT=3100 npm start
//   node scripts/loadtest.js http://localhost:3100 loadtest-pass [bookings=2500] [concurrency=250]
//
// It checks that no category and no event is ever oversold, and reports latency and throughput.

const [BASE = 'http://localhost:3100', PASSWORD = 'loadtest-pass', N = '2500', CONC = '250'] = process.argv.slice(2);
const TOTAL = Number(N);
const CONCURRENCY = Number(CONC);

const CAPACITY = 2000;
const CATEGORIES = [
  { name: 'VIP', price: 1500, capacity: 100 },
  { name: 'Gold', price: 900, capacity: 400 },
  { name: 'General', price: 500, capacity: 0 },   // limited only by the event's 2000 total
];

async function req(path, { method = 'GET', body, cookie } = {}) {
  const t = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, ms: performance.now() - t, headers: res.headers };
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const fmt = (n) => `${n.toFixed(0)}ms`;

(async () => {
  console.log(`Target ${BASE} — ${TOTAL} booking attempts, ${CONCURRENCY} at a time\n`);

  const login = await req('/api/login', { method: 'POST', body: { username: 'admin', password: PASSWORD } });
  if (login.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(login.data)}`);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const startsAt = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 16);
  const created = await req('/api/admin/events', { method: 'POST', cookie,
    body: { title: `Load test ${new Date().toISOString()}`, startsAt, venue: 'Test arena', capacity: CAPACITY, ticketTypes: CATEGORIES } });
  const eventId = created.data.id;
  const ev = (await req(`/api/events/${eventId}`)).data;
  const typeIds = Object.fromEntries(ev.ticketTypes.map((t) => [t.name, t.id]));
  console.log(`Created event #${eventId}: capacity ${CAPACITY} (VIP 100, Gold 400, General rest)\n`);

  const stats = { booked: 0, people: 0, soldOut: 0, other4xx: 0, errors5xx: 0, network: 0, bookMs: [], payMs: [], readMs: [] };
  const pick = () => { const r = Math.random(); return r < 0.3 ? 'VIP' : r < 0.6 ? 'Gold' : 'General'; };

  let next = 0;
  async function customer(i) {
    const size = 1 + Math.floor(Math.random() * 3);            // groups of 1–3 people
    const person = (k) => ({ ticketTypeId: typeIds[pick()], name: `Guest ${i}-${k}`, age: 20 + (k % 40) });
    const body = {
      eventId,
      primary: { ...person(0), phone: `9${String(100000000 + i).slice(-9)}`, email: `guest${i}@loadtest.example`, address: 'Load test street' },
      members: Array.from({ length: size - 1 }, (_, k) => person(k + 1)),
    };
    try {
      // a customer usually looks at the event page first
      const view = await req(`/api/events/${eventId}`);
      stats.readMs.push(view.ms);
      const b = await req('/api/bookings', { method: 'POST', body });
      stats.bookMs.push(b.ms);
      if (b.status === 200) {
        const p = await req(`/api/bookings/${encodeURIComponent(b.data.ref)}/demo-pay`, { method: 'POST' });
        stats.payMs.push(p.ms);
        if (p.status === 200) { stats.booked++; stats.people += size; } else if (p.status >= 500) stats.errors5xx++; else stats.other4xx++;
      } else if (b.status === 409) stats.soldOut++;
      else if (b.status >= 500) { stats.errors5xx++; if (stats.errors5xx < 4) console.log('  5xx:', b.status, b.data); }
      else { stats.other4xx++; if (stats.other4xx < 4) console.log('  4xx:', b.status, b.data); }
    } catch (err) {
      stats.network++;
      if (stats.network < 4) console.log('  network error:', err.cause?.code || err.message);
    }
  }
  async function worker() { while (next < TOTAL) await customer(next++); }

  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = (performance.now() - t0) / 1000;

  // Verify with the admin numbers (ground truth from the database).
  const admin = (await req('/api/admin/events', { cookie })).data.find((e) => e.id === eventId);
  const sold = Object.fromEntries(admin.categories.map((c) => [c.name, c.sold]));
  const checks = [
    ['Event total ≤ 2000', admin.people <= CAPACITY, `${admin.people}`],
    ['VIP ≤ 100', sold.VIP <= 100, `${sold.VIP}`],
    ['Gold ≤ 400', sold.Gold <= 400, `${sold.Gold}`],
    ['Paid people match client count', admin.people === stats.people, `${admin.people} vs ${stats.people}`],
    ['No server errors (5xx)', stats.errors5xx === 0, `${stats.errors5xx}`],
    ['No dropped connections', stats.network === 0, `${stats.network}`],
  ];

  console.log(`Finished in ${secs.toFixed(1)}s — ${((stats.bookMs.length + stats.payMs.length + stats.readMs.length) / secs).toFixed(0)} requests/s\n`);
  console.log(`Bookings paid:     ${stats.booked} (${stats.people} people)`);
  console.log(`Rejected sold-out: ${stats.soldOut}   other 4xx: ${stats.other4xx}   5xx: ${stats.errors5xx}   network: ${stats.network}`);
  console.log(`Sold:              VIP ${sold.VIP}/100, Gold ${sold.Gold}/400, General ${sold.General}, total ${admin.people}/${CAPACITY}\n`);
  console.log(`Latency  event page  p50 ${fmt(pct(stats.readMs, 50))}  p95 ${fmt(pct(stats.readMs, 95))}  p99 ${fmt(pct(stats.readMs, 99))}`);
  console.log(`         booking     p50 ${fmt(pct(stats.bookMs, 50))}  p95 ${fmt(pct(stats.bookMs, 95))}  p99 ${fmt(pct(stats.bookMs, 99))}`);
  console.log(`         payment     p50 ${fmt(pct(stats.payMs, 50))}  p95 ${fmt(pct(stats.payMs, 95))}  p99 ${fmt(pct(stats.payMs, 99))}\n`);
  for (const [name, ok, val] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${val})`);
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
