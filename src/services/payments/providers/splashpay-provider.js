const SPLASHPAY_DEFAULT_BASE_URL = 'https://api.splashpay.co.tz/api/v1';

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
    return `+${digits}`;
  }

  if (digits.startsWith('0') && digits.length === 10) {
    return `+255${digits.slice(1)}`;
  }

  if (digits.length === 9) {
    return `+255${digits}`;
  }

  throw new Error('Phone number must be a valid Tanzanian mobile number');
};

const initiatePayment = async ({
  reference,
  phone,
  amountTzs,
  packageData,
  clientMac
}) => {
  const apiKey = requiredEnv('SPLASHPAY_API_KEY');
  const apiSecret = requiredEnv('SPLASHPAY_API_SECRET');
  const customerName = requiredEnv('SPLASHPAY_CUSTOMER_NAME');
  const customerEmail = requiredEnv('SPLASHPAY_CUSTOMER_EMAIL');

  const baseUrl = (process.env.SPLASHPAY_BASE_URL || SPLASHPAY_DEFAULT_BASE_URL)
    .replace(/\/$/, '');

  const payload = {
    amount: Number(amountTzs),
    currency: 'TZS',
    reference,
    phone: normalizePhone(phone),
    customer_name: customerName,
    customer_email: customerEmail,
    metadata: {
      clientMac,
      packageId: packageData.id,
      packageName: packageData.name
    }
  };

  const response = await fetch(`${baseUrl}/payments/mobile-money`, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'X-API-SECRET': apiSecret,
      'Idempotency-Key': reference,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  let body;

  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`SplashPay returned invalid JSON (HTTP ${response.status})`);
  }

  if (!response.ok || body.status === 'error') {
    const message = body.message || body.error || `HTTP ${response.status}`;
    throw new Error(`SplashPay payment initiation failed: ${message}`);
  }

  const data = body.data || {};
  const providerReference =
    data.provider_reference ||
    data.providerReference ||
    data.payment_reference ||
    data.paymentReference;

  if (!providerReference) {
    throw new Error('SplashPay response did not include a provider reference');
  }

  return {
    provider: 'splashpay',
    providerReference,
    status: data.status || 'pending',
    message: body.message || 'SplashPay payment request sent',
    reference,
    phone: payload.phone,
    amountTzs: Number(amountTzs)
  };
};

module.exports = {
  initiatePayment,
  normalizePhone
};
