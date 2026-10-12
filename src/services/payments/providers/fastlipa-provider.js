const crypto = require('node:crypto');

const baseUrl = () => (process.env.FASTLIPA_BASE_URL || 'https://api.fastlipa.com/v1').replace(/\/$/, '');
const token = () => {
  if (!process.env.FASTLIPA_API_TOKEN) throw new Error('FASTLIPA_API_TOKEN is required');
  return process.env.FASTLIPA_API_TOKEN;
};

const normalizePhone = (phone) => {
  const number = String(phone || '').replace(/\D/g, '');
  if (/^0[0-9]{9}$/.test(number)) return '255' + number.slice(1);
  if (/^255[0-9]{9}$/.test(number)) return number;
  throw new Error('Invalid Tanzanian mobile phone number');
};

const request = async (path, options = {}) => {
  const response = await fetch(baseUrl() + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token(),
      Accept: 'application/json',
      ...(options.body ? {'Content-Type': 'application/json'} : {}),
      ...options.headers
    },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.status !== true) {
    throw new Error('FastLipa request failed: ' + (body?.code || body?.message || 'HTTP ' + response.status));
  }
  return body.data;
};

const initiatePayment = async ({reference, phone, amountTzs}) => {
  const amount = Number(amountTzs);
  if (!Number.isInteger(amount) || amount < 100 || amount > 5000000) {
    throw new Error('FastLipa collection amount must be 100–5,000,000 TZS');
  }
  const number = normalizePhone(phone);
  const data = await request('/transaction/create', {
    method: 'POST',
    body: JSON.stringify({
      number,
      amount,
      reference,
      ...(process.env.FASTLIPA_WEBHOOK_URL ? {webhook_url: process.env.FASTLIPA_WEBHOOK_URL} : {})
    })
  });
  if (!data?.tranID) throw new Error('FastLipa response missing tranID');
  return {
    provider: 'fastlipa',
    providerReference: data.tranID,
    status: 'pending',
    message: 'Payment initiated; approve the mobile money prompt',
    reference,
    phone: number,
    amountTzs: amount
  };
};

const getPaymentStatus = async (providerReference) => {
  const data = await request('/transaction/status?tranid=' + encodeURIComponent(providerReference));
  const states = {PENDING: 'pending', COMPLETED: 'paid', CANCELLED: 'cancelled'};
  return {
    providerReference: data.tranid,
    status: states[String(data.payment_status).toUpperCase()] || 'pending',
    amountTzs: Number(data.amount),
    network: data.network
  };
};

const verifyWebhook = (rawBody, signature) => {
  const secret = process.env.FASTLIPA_WEBHOOK_SECRET;
  if (!secret || !Buffer.isBuffer(rawBody) || !/^sha256=[0-9a-f]{64}$/i.test(String(signature || ''))) {
    return false;
  }
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

const parseWebhook = (payload) => {
  if (!['payment.completed', 'payment.cancelled'].includes(payload?.event)) return null;
  const data = payload.data || {};
  return {
    reference: data.reference,
    providerReference: data.tranid,
    amountTzs: Number(data.amount),
    status: payload.event === 'payment.completed' && data.payment_status === 'COMPLETED' ? 'paid' :
      payload.event === 'payment.cancelled' && data.payment_status === 'CANCELLED' ? 'cancelled' : null
  };
};

module.exports = { initiatePayment, getPaymentStatus, verifyWebhook, parseWebhook, normalizePhone };
