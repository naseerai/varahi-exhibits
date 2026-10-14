const crypto = require('node:crypto');

// Security headers for every response. A fresh nonce per request lets our own inline
// <script> blocks run while any injected script (XSS) is blocked by the browser.
function securityHeaders() {
  return (req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.nonce = nonce;
    const csp = [
      "default-src 'self'",
      // Payment gateways' checkout scripts: Razorpay and Cashfree.
      `script-src 'self' 'nonce-${nonce}' https://checkout.razorpay.com https://sdk.cashfree.com`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com https://*.cashfree.com",
      'frame-src https://api.razorpay.com https://checkout.razorpay.com https://*.cashfree.com',
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      ...(req.secure ? ['upgrade-insecure-requests'] : []),
    ].join('; ');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');   // Razorpay may open bank/UPI popups
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com" "https://sdk.cashfree.com")');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

// Simple fixed-window rate limiter kept in memory (per server process).
const limitersDisabled = process.env.DISABLE_RATE_LIMIT === '1';
function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests. Please slow down and try again shortly.' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60_000)).unref();

  return (req, res, next) => {
    if (limitersDisabled) return next();
    const k = key(req);
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(k, h); }
    h.count++;
    if (h.count > max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// CSRF defence in depth (cookies are already SameSite=Lax): browsers always send Origin on
// cross-site POSTs, so reject state-changing API calls whose Origin is not this site.
function sameOrigin({ allowed = [] } = {}) {
  const extra = new Set(allowed.filter(Boolean).map((u) => new URL(u).host));
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next();
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host && (host === req.get('host') || extra.has(host))) return next();
    res.status(403).json({ error: 'Request blocked (cross-site).' });
  };
}

// Tiny time-based cache for hot public reads (event list / event page).
function microCache(ttlMs) {
  const store = new Map();
  const get = (key, compute) => {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.exp > now) return hit.val;
    const val = compute();
    if (store.size > 1000) store.clear();
    store.set(key, { val, exp: now + ttlMs });
    return val;
  };
  get.clear = () => store.clear();
  return get;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { securityHeaders, rateLimit, sameOrigin, microCache, sha256, safeEqual };
