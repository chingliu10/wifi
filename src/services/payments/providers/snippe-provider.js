const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://api.snippe.sh';

const requiredEnv = (name) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

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

const makeIdempotencyKey = (reference) => {
  return crypto
    .createHash('sha256')
    .update(String(reference))
    .digest('hex')
    .slice(0, 30);
};

const initiatePayment = async ({
  reference,
  phone,
  amountTzs,
  packageData,
  clientMac
}) => {
  const apiKey = requiredEnv('SNIPPE_API_KEY');
  const firstName = requiredEnv('SNIPPE_CUSTOMER_FIRSTNAME');
  const lastName = requiredEnv('SNIPPE_CUSTOMER_LASTNAME');
  const email = requiredEnv('SNIPPE_CUSTOMER_EMAIL');

  const baseUrl = (process.env.SNIPPE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const webhookUrl =
    process.env.SNIPPE_WEBHOOK_URL ||
    'https://portal.soliduslogic.co.tz/api/payments/snippe/webhook';

  const payload = {
    payment_type: 'mobile',
    details: {
      amount: Number(amountTzs),
      currency: 'TZS'
    },
    phone_number: normalizePhone(phone),
    customer: {
      firstname: firstName,
      lastname: lastName,
      email
    },
    webhook_url: webhookUrl,
    metadata: {
      merchant_reference: reference,
      client_mac: clientMac,
      package_id: String(packageData.id),
      package_name: packageData.name
    }
  };

  const response = await fetch(`${baseUrl}/v1/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Idempotency-Key': makeIdempotencyKey(reference)
    },
    body: JSON.stringify(payload)
  });

  let body;

  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Snippe returned invalid JSON (HTTP ${response.status})`);
  }

  if (!response.ok || body.status === 'error') {
    const message = body.message || body.error || `HTTP ${response.status}`;
    throw new Error(`Snippe payment initiation failed: ${message}`);
  }

  const data = body.data || {};
  const providerReference = data.reference;

  if (!providerReference) {
    throw new Error('Snippe response did not include a payment reference');
  }

  return {
    provider: 'snippe',
    providerReference,
    status: data.status || 'pending',
    message: 'Payment request sent. Please authorize it on your phone.',
    reference,
    phone: payload.phone_number,
    amountTzs: Number(amountTzs)
  };
};

module.exports = {
  initiatePayment,
  normalizePhone,
  makeIdempotencyKey
};
