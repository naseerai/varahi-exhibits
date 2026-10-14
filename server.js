try { process.loadEnvFile(); } catch { /* .env is optional */ }

const cluster = require('node:cluster');
const os = require('node:os');

const PORT = Number(process.env.PORT) || 3000;
// WEB_CONCURRENCY=auto uses every CPU core; a number sets the worker count; default is one process.
const WORKERS = process.env.WEB_CONCURRENCY === 'auto'
  ? os.availableParallelism()
  : Math.max(1, Number(process.env.WEB_CONCURRENCY) || 1);

const { createApp, firstRunSetup, expireHolds, GATEWAYS, defaultGateway, IS_PROD } = require('./app');

function startHttp() {
  // HOST=127.0.0.1 in production: only the HTTPS proxy (Caddy) on the same machine can reach the app.
  const server = createApp().listen(PORT, process.env.HOST || undefined);
  server.keepAliveTimeout = 65_000;   // longer than typical proxy/load-balancer idle timeouts
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

function startSweeper() {
  const run = () => {
    try {
      const n = expireHolds();
      if (n) console.log(`[holds] released ${n} unpaid booking(s)`);
    } catch (err) { console.error('[holds]', err.message); }
  };
  run();
  setInterval(run, 60_000).unref();
}

function banner() {
  console.log(`Ticketing running at http://localhost:${PORT}  (${WORKERS} process${WORKERS > 1 ? 'es' : ''}, ${IS_PROD ? 'production' : 'development'})`);
  console.log(`  Customer site: http://localhost:${PORT}/`);
  console.log(`  Admin / staff: http://localhost:${PORT}/login`);
  const list = Object.values(GATEWAYS).map((g) => `${g.label} (${g.mode}${g.id === 'razorpay' && !g.webhookEnabled ? ', no webhook secret' : ''})`);
  const def = defaultGateway();
  console.log(`  Payments:      ${list.length ? `${list.join(', ')} — default: ${GATEWAYS[def]?.label}` :
    def === 'demo' ? 'DEMO MODE (add Razorpay and/or Cashfree keys in .env for real payments)' :
      'DISABLED — production without gateway keys; only free events can be booked'}`);
}

(async () => {
  if (cluster.isPrimary) {
    await firstRunSetup();
    startSweeper();
    if (WORKERS > 1) {
      let stopping = false;
      for (let i = 0; i < WORKERS; i++) cluster.fork();
      cluster.on('exit', (w, code) => {
        if (stopping) return;
        console.error(`[cluster] worker ${w.process.pid} exited (${code}); starting a new one`);
        cluster.fork();
      });
      const stop = () => { stopping = true; for (const w of Object.values(cluster.workers)) w.kill('SIGTERM'); setTimeout(() => process.exit(0), 10_000).unref(); };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
      banner();
    } else {
      startHttp().on('listening', banner);
    }
  } else {
    startHttp();
  }
})();
