const SPLASHPAY_DEFAULT_BASE_URL = 'https://api.splashpay.co.tz/api/v1';

const requiredEnv = (name) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const getConfig = () => ({
  baseUrl: String(
    process.env.SPLASHPAY_BASE_URL || SPLASHPAY_DEFAULT_BASE_URL
  ).replace(/\/$/, ''),
  apiKey: requiredEnv('SPLASHPAY_API_KEY'),
  apiSecret: requiredEnv('SPLASHPAY_API_SECRET')
});

const normalizePhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');

  if (digits.startsWith('255') && digits.length === 12) {
    return digits;
  }

  if (digits.startsWith('0') && digits.length === 10) {
    return `255${digits.slice(1)}`;
  }

  if (digits.length === 9) {
    return `255${digits}`;
  }

  throw new Error('Phone number must be a valid Tanzanian mobile number');
};

const normalizeNetwork = (network) => {
  const aliases = {
    MPESA: 'MPESA',
    VODACOM: 'MPESA',
    M_PESA: 'MPESA',
    MIXX_BY_YAS: 'MIXX_BY_YAS',
    MIXX: 'MIXX_BY_YAS',
    YAS: 'MIXX_BY_YAS',
    TIGO: 'MIXX_BY_YAS',
    AIRTEL_MONEY: 'AIRTEL_MONEY',
    AIRTEL: 'AIRTEL_MONEY',
    HALOPESA: 'HALOPESA',
    HALOTEL: 'HALOPESA',
    EZYPESA: 'EZYPESA',
    TTCLPESA: 'TTCLPESA',
    TTCL_PESA: 'TTCLPESA',
    TTCL: 'TTCLPESA'
  };

  const key = String(network || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');

  const normalized = aliases[key];

  if (!normalized) {
    throw new Error(
      'Unsupported network. Use MPESA, MIXX_BY_YAS, AIRTEL_MONEY, HALOPESA, EZYPESA or TTCLPESA'
    );
  }

  return normalized;
};

const getMobileMoneyDisbursementFee = (amountTzs) => {
  const amount = Number(amountTzs);

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Disbursement amount must be greater than zero');
  }

  if (amount <= 50000) {
    return 2000;
  }

  if (amount <= 150000) {
    return 4500;
  }

  return 7500;
};

const requestJson = async ({
  method,
  path,
  body,
  idempotencyKey
}) => {
  const { baseUrl, apiKey, apiSecret } = getConfig();

  const headers = {
    'X-API-KEY': apiKey,
    'X-API-SECRET': apiSecret,
    Accept: 'application/json'
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  const response = await fetch(baseUrl + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

  let payload;

  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `SplashPay returned invalid JSON (HTTP ${response.status})`
    );
  }

  if (!response.ok || payload.status === 'error') {
    const providerCode =
      payload.code ||
      payload.error_code ||
      payload.errorCode ||
      null;
    const providerMessage =
      payload.message ||
      payload.error ||
      `HTTP ${response.status}`;

    const error = new Error(
      'SplashPay disbursement request failed: ' + providerMessage
    );

    error.statusCode = response.status;
    error.providerCode = providerCode;
    error.providerResponse = payload;

    throw error;
  }

  return payload;
};

const lookupMobileMoneyRecipient = async ({ phone }) => {
  const normalizedPhone = normalizePhone(phone);

  const payload = await requestJson({
    method: 'POST',
    path: '/disbursements/name-lookup',
    body: {
      channel: 'MOBILE_MONEY',
      account_number: normalizedPhone
    }
  });

  return {
    phone: normalizedPhone,
    data: payload.data || null,
    status: payload.status || null,
    code: payload.code || null,
    message: payload.message || null,
    raw: payload
  };
};

const initiateMobileMoneyDisbursement = async ({
  reference,
  phone,
  recipientName,
  amountTzs,
  network,
  remarks = 'Solidus WiFi wallet withdrawal',
  metadata = {}
}) => {
  const normalizedReference = String(reference || '').trim();
  const normalizedRecipientName = String(recipientName || '').trim();
  const normalizedPhone = normalizePhone(phone);
  const normalizedNetwork = normalizeNetwork(network);
  const amount = Number(amountTzs);

  if (!normalizedReference) {
    throw new Error('Disbursement reference is required');
  }

  if (!normalizedRecipientName) {
    throw new Error('Recipient name is required');
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Disbursement amount must be greater than zero');
  }

  const payload = await requestJson({
    method: 'POST',
    path: '/disbursements/mobile-money',
    idempotencyKey: normalizedReference,
    body: {
      reference: normalizedReference,
      recipient_phone: normalizedPhone,
      recipient_name: normalizedRecipientName,
      amount,
      currency: 'TZS',
      network: normalizedNetwork,
      remarks,
      metadata
    }
  });

  const data = payload.data || {};

  return {
    reference: data.reference || normalizedReference,
    providerReference:
      data.provider_reference ||
      data.providerReference ||
      null,
    amountTzs:
      data.amount !== undefined ? Number(data.amount) : amount,
    feeTzs:
      data.fee !== undefined && data.fee !== null
        ? Number(data.fee)
        : null,
    totalAmountTzs:
      data.total_amount !== undefined && data.total_amount !== null
        ? Number(data.total_amount)
        : null,
    currency: data.currency || 'TZS',
    recipientPhone:
      data.recipient_phone ||
      data.recipientPhone ||
      normalizedPhone,
    recipientName:
      data.recipient_name ||
      data.recipientName ||
      normalizedRecipientName,
    network: data.network || normalizedNetwork,
    status: data.status || null,
    message: payload.message || null,
    raw: payload
  };
};

const checkDisbursementStatus = async ({ reference }) => {
  const normalizedReference = String(reference || '').trim();

  if (!normalizedReference) {
    throw new Error('Disbursement reference is required');
  }

  const payload = await requestJson({
    method: 'GET',
    path:
      '/disbursements/' +
      encodeURIComponent(normalizedReference)
  });

  const data = payload.data || {};

  return {
    reference: data.reference || normalizedReference,
    providerReference:
      data.provider_reference ||
      data.providerReference ||
      null,
    amountTzs:
      data.amount !== undefined && data.amount !== null
        ? Number(data.amount)
        : null,
    feeTzs:
      data.fee !== undefined && data.fee !== null
        ? Number(data.fee)
        : null,
    totalAmountTzs:
      data.total_amount !== undefined && data.total_amount !== null
        ? Number(data.total_amount)
        : null,
    currency: data.currency || null,
    recipientPhone:
      data.recipient_phone ||
      data.recipientPhone ||
      null,
    recipientName:
      data.recipient_name ||
      data.recipientName ||
      null,
    network: data.network || null,
    status: data.status || null,
    remarks: data.remarks || null,
    completedAt:
      data.completed_at ||
      data.completedAt ||
      null,
    processedAt:
      data.processing_at ||
      data.processed_at ||
      data.processedAt ||
      null,
    raw: payload
  };
};

module.exports = {
  normalizePhone,
  normalizeNetwork,
  getMobileMoneyDisbursementFee,
  lookupMobileMoneyRecipient,
  initiateMobileMoneyDisbursement,
  checkDisbursementStatus
};
