// SMS sending through the smsgw.in HTTP(S) API:
//   https://web.smsgw.in/smsapi/httpapi.jsp?username=..&password=..&from=SENDER&to=9XXXXXXXXX&text=..&coding=0&pe_id=..&template_id=..
// In India every SMS must match a DLT-registered template exactly, so each message text comes from
// .env (SMS_OTP_TEMPLATE, SMS_BOOKING_TEMPLATE) and must be identical to the approved template,
// sent with that template's DLT Content Template ID.

const API_URL = process.env.SMSGW_URL || 'https://web.smsgw.in/smsapi/httpapi.jsp';
const cfg = {
  username: process.env.SMSGW_USERNAME,
  password: process.env.SMSGW_PASSWORD,
  from: process.env.SMSGW_SENDER,
  peId: process.env.SMSGW_PE_ID,
  otpTemplateId: process.env.SMSGW_TEMPLATE_ID,
  otpTemplate: process.env.SMS_OTP_TEMPLATE || 'Your OTP for ticket booking is {otp}. It is valid for 5 minutes. Do not share it with anyone.',
  bookingTemplateId: process.env.SMSGW_BOOKING_TEMPLATE_ID,
  bookingTemplate: process.env.SMS_BOOKING_TEMPLATE
    || 'Dear {name}, your booking for {event} on {time} is confirmed. Ticket ID: {code}. View your ticket: {link}',
  countryCode: process.env.SMSGW_COUNTRY_CODE || '',   // e.g. "91" if your account wants 91XXXXXXXXXX
};

const configured = !!(cfg.username && cfg.password && cfg.from);

// Fill {placeholders} in a template.
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));

async function sendSms(phone10, text, templateId, label = 'sms') {
  const params = new URLSearchParams({
    username: cfg.username, password: cfg.password, from: cfg.from,
    to: cfg.countryCode + phone10, text, coding: '0',
    ...(cfg.peId ? { pe_id: cfg.peId } : {}),
    ...(templateId ? { template_id: templateId } : {}),
  });
  try {
    const res = await fetch(`${API_URL}?${params}`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.text()).trim().slice(0, 300);
    // The gateway answers in plain text; treat HTTP errors or error words as a failure.
    if (!res.ok || /error|invalid|fail|denied|insufficient/i.test(body)) {
      console.error(`[sms] ${label} to ${phone10} failed: HTTP ${res.status} ${body}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[sms] ${label} to ${phone10} failed: ${err.message}`);
    return { ok: false };
  }
}

async function sendOtp(phone10, otp) {
  if (!configured) {
    console.log(`[sms] (not configured) OTP for ${phone10}: ${otp}`);
    return { ok: true, simulated: true };
  }
  return sendSms(phone10, fill(cfg.otpTemplate, { otp }), cfg.otpTemplateId, 'OTP');
}

// Booking confirmation. values: { name, event, time, code, link }
async function sendBookingSms(phone10, values) {
  const text = fill(cfg.bookingTemplate, values);
  if (!configured) {
    console.log(`[sms] (not configured) booking SMS for ${phone10}: ${text}`);
    return { ok: true, simulated: true };
  }
  if (!cfg.bookingTemplateId) {
    console.warn('[sms] booking SMS skipped: set SMSGW_BOOKING_TEMPLATE_ID (and SMS_BOOKING_TEMPLATE) in .env');
    return { ok: false, skipped: true };
  }
  return sendSms(phone10, text, cfg.bookingTemplateId, 'booking SMS');
}

module.exports = { sendOtp, sendBookingSms, smsConfigured: configured };
