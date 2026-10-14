// WhatsApp template messages through the WhatsApp Cloud API (here via the wapost.click proxy):
//   POST {WHATSAPP_API_URL}/{WHATSAPP_PHONE_NUMBER_ID}/messages   with   Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
// Business-initiated messages must use a template approved in WhatsApp Manager; the template name,
// language and the number/order of its parameters must match the approved template exactly.

const cfg = {
  apiUrl: (process.env.WHATSAPP_API_URL || 'https://api.wapost.click/api/meta/v19.0').replace(/\/+$/, ''),
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  token: process.env.WHATSAPP_ACCESS_TOKEN,
  bookingTemplate: process.env.WHATSAPP_BOOKING_TEMPLATE || 'ticket_booked',
  language: process.env.WHATSAPP_TEMPLATE_LANG || 'en',
  countryCode: process.env.WHATSAPP_COUNTRY_CODE || '91',
};

const configured = !!(cfg.phoneNumberId && cfg.token);

// WhatsApp rejects template text parameters with new lines, tabs or more than 4 spaces in a row.
const param = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1000) || '-';

async function sendTemplate(phone10, name, components, label) {
  const body = {
    messaging_product: 'whatsapp',
    to: cfg.countryCode + phone10,
    recipient_type: 'individual',
    type: 'template',
    template: { name, language: { policy: 'deterministic', code: cfg.language }, components },
  };
  try {
    const res = await fetch(`${cfg.apiUrl}/${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || data?.error) {
      const why = data?.error?.message || data?.error || text.slice(0, 300);
      console.error(`[whatsapp] ${label} to ${phone10} failed: HTTP ${res.status} ${typeof why === 'string' ? why : JSON.stringify(why)}`);
      return { ok: false };
    }
    return { ok: true, id: data?.messages?.[0]?.id };
  } catch (err) {
    console.error(`[whatsapp] ${label} to ${phone10} failed: ${err.message}`);
    return { ok: false };
  }
}

// "ticket_booked" template: header image = ticket picture; body {{1}} event, {{2}} timings, {{3}} ticket ID.
async function sendBookingWhatsApp(phone10, { imageUrl, event, time, code }) {
  if (!configured) {
    console.log(`[whatsapp] (not configured) booking message for ${phone10}: ${event} | ${time} | ${code} | ${imageUrl}`);
    return { ok: true, simulated: true };
  }
  return sendTemplate(phone10, cfg.bookingTemplate, [
    { type: 'header', parameters: [{ type: 'image', image: { link: imageUrl } }] },
    { type: 'body', parameters: [event, time, code].map((t) => ({ type: 'text', text: param(t) })) },
  ], 'booking message');
}

module.exports = { sendBookingWhatsApp, whatsappConfigured: configured };
