// Cashfree Payment Gateway (PG API version 2023-08-01).
// Docs: https://www.cashfree.com/docs/api-reference/payments/latest/orders/create
// Same interface as lib/razorpay.js.
const crypto = require('node:crypto');
const { safeEqual } = require('./security');

const API_VERSION = '2023-08-01';

module.exports = function cashfree({ appId, secretKey, env, currency }) {
  const production = env === 'production';
  const API = production ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';

  async function call(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-client-id': appId,
          'x-client-secret': secretKey,
          'x-api-version': API_VERSION,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw Object.assign(new Error('Payment gateway is not responding. Please try again in a moment.'), { status: 503, cause: err });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[cashfree] ${method} ${path} failed`, res.status, data?.code, data?.message);
      throw Object.assign(new Error('Payment gateway error. Please try again in a moment.'), { status: 502 });
    }
    return data;
  }

  // Cashfree wants a 10-digit Indian mobile number.
  const phone10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

  return {
    id: 'cashfree',
    label: 'Cashfree',
    mode: production ? 'live' : 'test',
    webhookEnabled: true,   // Cashfree signs webhooks with the same secret key

    async createOrder({ bookingId, ref, amountPaise, customer, eventTitle, returnUrl, notifyUrl, timeoutSeconds }) {
      const orderId = `TKT_${bookingId}_${crypto.randomBytes(4).toString('hex')}`;
      // Cashfree requires the expiry to be at least 15 minutes away.
      const expiry = new Date(Date.now() + Math.max(timeoutSeconds, 16 * 60) * 1000).toISOString();
      const order = await call('/orders', { method: 'POST', body: {
        order_id: orderId,
        order_amount: amountPaise / 100,
        order_currency: currency,
        customer_details: {
          customer_id: `cust_${bookingId}`,
          customer_name: customer.name.slice(0, 100),
          customer_email: customer.email,
          customer_phone: phone10(customer.phone),
        },
        order_meta: {
          return_url: returnUrl,
          ...(notifyUrl ? { notify_url: notifyUrl } : {}),
        },
        order_expiry_time: expiry,
        order_note: eventTitle.slice(0, 200),
        order_tags: { booking_ref: ref },
      } });
      return { orderId, checkout: { mode: production ? 'production' : 'sandbox', paymentSessionId: order.payment_session_id } };
    },

    async fetchPayment(orderId, amountPaise) {
      const payments = await call(`/orders/${encodeURIComponent(orderId)}/payments`);
      const p = (Array.isArray(payments) ? payments : []).find((x) =>
        x.payment_status === 'SUCCESS' && Math.round(Number(x.payment_amount) * 100) === amountPaise && (x.payment_currency || currency) === currency);
      return p ? { paid: true, paymentId: String(p.cf_payment_id) } : { paid: false };
    },

    // Cashfree's browser callback isn't signed, so success is always confirmed with fetchPayment().
    verifyCheckout() { return null; },

    // Signature = base64(HMAC-SHA256(timestamp + rawBody, secret key)).
    parseWebhook(req) {
      const raw = req.body;
      const ts = req.get('x-webhook-timestamp') || '';
      if (!Buffer.isBuffer(raw) || !ts) return { valid: false };
      const expected = crypto.createHmac('sha256', secretKey).update(ts + raw.toString('utf8')).digest('base64');
      if (!safeEqual(expected, req.get('x-webhook-signature'))) return { valid: false };
      const evt = JSON.parse(raw.toString('utf8'));
      const order = evt.data?.order;
      const p = evt.data?.payment;
      const payments = evt.type === 'PAYMENT_SUCCESS_WEBHOOK' && p?.payment_status === 'SUCCESS' && order?.order_id
        ? [{ orderId: order.order_id, paymentId: String(p.cf_payment_id), amountPaise: Math.round(Number(p.payment_amount) * 100), currency: p.payment_currency || order.order_currency }]
        : [];
      return { valid: true, eventId: p?.cf_payment_id ? `cf:${p.cf_payment_id}:${evt.type}` : null, payments };
    },
  };
};
