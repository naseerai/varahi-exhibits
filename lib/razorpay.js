// Razorpay gateway. Docs: https://razorpay.com/docs/payments/server-integration/nodejs/
//
// Every gateway module exposes the same shape (see lib/cashfree.js):
//   createOrder(...)            -> { orderId, checkout }   (checkout = data the browser needs)
//   fetchPayment(order, amount) -> { paid, paymentId }     (asks the gateway directly)
//   verifyCheckout(order, body) -> paymentId | null        (browser's success callback, if any)
//   parseWebhook(req)           -> { valid, eventId, payments: [{ orderId, paymentId, amountPaise, currency }] }
const crypto = require('node:crypto');
const { safeEqual } = require('./security');

const API = 'https://api.razorpay.com/v1';

module.exports = function razorpay({ keyId, keySecret, webhookSecret, currency }) {
  const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

  async function call(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw Object.assign(new Error('Payment gateway is not responding. Please try again in a moment.'), { status: 503, cause: err });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[razorpay] ${method} ${path} failed`, res.status, data?.error);
      throw Object.assign(new Error('Payment gateway error. Please try again in a moment.'), { status: 502 });
    }
    return data;
  }

  return {
    id: 'razorpay',
    label: 'Razorpay',
    mode: keyId.startsWith('rzp_live_') ? 'live' : 'test',
    webhookEnabled: !!webhookSecret,

    async createOrder({ bookingId, amountPaise, customer, eventTitle, timeoutSeconds }) {
      const order = await call('/orders', { method: 'POST', body: {
        amount: amountPaise, currency, receipt: `booking_${bookingId}`,
        notes: { booking_id: String(bookingId), event: eventTitle.slice(0, 200) },
      } });
      return {
        orderId: order.id,
        checkout: { keyId, orderId: order.id, amountPaise, currency, timeout: timeoutSeconds, eventTitle,
          prefill: { name: customer.name, email: customer.email, contact: customer.phone } },
      };
    },

    async fetchPayment(orderId, amountPaise) {
      const { items = [] } = await call(`/orders/${encodeURIComponent(orderId)}/payments`);
      const p = items.find((x) => x.status === 'captured' && x.amount === amountPaise && x.currency === currency);
      return p ? { paid: true, paymentId: p.id } : { paid: false };
    },

    // Signature Razorpay Checkout returns to the browser after a successful payment.
    verifyCheckout(orderId, body) {
      const { razorpay_order_id: o, razorpay_payment_id: p, razorpay_signature: s } = body || {};
      return o === orderId && p && safeEqual(hmac(keySecret, `${o}|${p}`), s) ? String(p).slice(0, 64) : null;
    },

    parseWebhook(req) {
      const raw = req.body;
      if (!webhookSecret || !Buffer.isBuffer(raw) || !safeEqual(hmac(webhookSecret, raw), req.get('x-razorpay-signature'))) return { valid: false };
      const evt = JSON.parse(raw.toString('utf8'));
      const p = evt.payload?.payment?.entity;
      const payments = (evt.event === 'payment.captured' || evt.event === 'order.paid') && p?.order_id
        ? [{ orderId: p.order_id, paymentId: p.id, amountPaise: p.amount, currency: p.currency }] : [];
      return { valid: true, eventId: req.get('x-razorpay-event-id') && `rzp:${req.get('x-razorpay-event-id')}`, payments };
    },
  };
};
